/**
 * `PtyPaneSession` — runs the target process inside a sibling tmux pane
 * (visible to the user) and mirrors its byte stream back to the parent
 * process for monitor triggers, queries, and reattach.
 *
 * Architecture (hybrid of pull and push bake-off branches):
 *
 *   1. **Byte stream from `tmux pipe-pane`**: when the pane is created we
 *      enable a pipe that writes every byte the pane's pty emits into a
 *      named fifo. A child `cat $fifo` process reads the fifo and writes
 *      to its own stdout, which the parent reads via `child_process`.
 *      This is the canonical byte stream — no diff, no shadow buffer —
 *      and is what `addDataListener`, `getRawStream`, and `getLogSlice`
 *      serve from. Putting the blocking fifo read in a child process
 *      sidesteps the libuv-thread-strand bug that killed the push
 *      bake-off's testability story.
 *
 *   2. **Viewport queries via `tmux capture-pane`**: `getViewportLines`,
 *      `getTailLines` shell out to `capture-pane` synchronously on
 *      demand. No polling, no diffing. tmux already rendered the pane,
 *      so capture-pane is the canonical viewport.
 *
 *   3. **Exit detection via fifo EOF + `#{pane_dead_status}`**: when the
 *      target process exits, tmux closes the pipe-pane writer; our cat
 *      reader sees EOF and exits; we then query `#{pane_dead_status}`
 *      for the exit code (this requires `remain-on-exit on`, which we
 *      set during construction). No long-running poll just for liveness.
 *
 *   4. **Lifecycle**: `dispose()` unconditionally kills the cat reader,
 *      kill-panes the tmux pane (codex review B3 fix — never short-
 *      circuit on `_exited`), and unlinks the fifo. Listeners installed
 *      after dispose are silently no-op.
 *
 * Race-window note: there is a small (~30-100ms) window between
 * `split-window` returning and `pipe-pane` being enabled where bytes
 * the target process emits are NOT captured (they enter tmux's internal
 * buffer but pipe-pane only forwards future bytes). For long-running
 * tools this is invisible; for instant-output one-liners like
 * `echo hi` the first chunk may be missed. Documented as a known
 * limitation.
 */

import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { sliceLogOutput, trimRawOutput } from "./pty-log.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildCapturePaneArgs,
	buildKillPaneArgs,
	buildDisplayMessageArgs,
	buildPipePaneArgs,
	buildResizePaneArgs,
	buildSelectPaneArgs,
	buildSendKeysLiteralArgs,
	buildSendKeysNamedArgs,
	buildSplitWindowArgs,
	DefaultTmuxRunner,
	type TmuxRunner,
} from "./tmux-cli.js";

import type {
	LogSliceOptions,
	LogSliceResult,
	PtySession,
	PtySessionEventsShape,
	RawStreamOptions,
	TailLinesOptions,
	TailLinesResult,
	ViewportLinesOptions,
} from "./pty-session-interface.js";

export interface PaneOptions {
	/** Layout direction relative to the parent pane. */
	layout?: "right" | "left" | "below" | "above";
	/** New pane size as percent of the split axis (1-99). */
	sizePercent?: number;
	/** Pane title (cosmetic, shown in tmux status bar). */
	title?: string;
	/** Whether to focus the new pane. */
	select?: boolean;
}

export interface PtyPaneSessionOptions {
	/** Shell command to run inside the pane (interpreted by `shell -c`). */
	command: string;
	/** Override the shell. Defaults to `$SHELL` or `/bin/sh`. */
	shell?: string;
	/** Working directory for the pane process. */
	cwd?: string;
	/** Extra environment variables (merged on top of `process.env`). */
	env?: Record<string, string | undefined>;
	/** Pane appearance + layout. */
	pane?: PaneOptions;
	/** Inject a custom tmux runner (for tests). */
	tmuxRunner?: TmuxRunner;
	/** Override the directory used for fifos (default `${TMPDIR}/pi-interactive-shell`). */
	fifoDir?: string;
	/** Skip the actual `mkfifo` shell-out (for tests that pre-create the fifo). */
	skipMkfifo?: boolean;
	/** Override the fifo path entirely (for tests). */
	fifoPathOverride?: string;
	/** Override the reader command (for tests). Defaults to `cat`. */
	readerCommand?: string;
	/**
	 * Skip spawning the reader child entirely (for unit tests that mock
	 * tmux and don't want a live fifo handle). With this set, the SUT
	 * will never see real bytes; tests can drive byte flow via the
	 * @internal `_feedReaderBytes` accessor.
	 */
	skipReader?: boolean;
}

export interface PtyPaneSessionEvents extends PtySessionEventsShape {}

const DEFAULT_FIFO_DIR_NAME = "pi-interactive-shell";
const DEFAULT_LAYOUT: PaneOptions["layout"] = "right";
const DEFAULT_SIZE_PERCENT = 40;

export class PtyPaneSession implements PtySession {
	private readonly tmuxRunner: TmuxRunner;
	private readonly fifoPath: string;
	private readonly exitFilePath: string;
	private readonly readerCommand: string;
	private readerChild: ChildProcess | null = null;

	private _paneId = "";
	private _pid = 0;
	private _cols = 80;
	private _rows = 24;

	private _exited = false;
	private _exitCode: number | null = null;
	private _signal: number | undefined;

	private rawOutput = "";
	private lastStreamPosition = 0;

	private dataHandler: ((data: string) => void) | undefined;
	private exitHandler: ((exitCode: number, signal?: number) => void) | undefined;
	private additionalDataListeners: Array<(data: string) => void> = [];
	private additionalExitListeners: Array<(exitCode: number, signal?: number) => void> = [];

	private disposed = false;

	constructor(options: PtyPaneSessionOptions, events: PtyPaneSessionEvents = {}) {
		this.tmuxRunner = options.tmuxRunner ?? new DefaultTmuxRunner();
		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;
		this.readerCommand = options.readerCommand ?? "cat";

		const fifoDir = options.fifoDir ?? join(tmpdir(), DEFAULT_FIFO_DIR_NAME);
		const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		this.fifoPath = options.fifoPathOverride ?? join(fifoDir, `pane-${suffix}.fifo`);
		this.exitFilePath = join(fifoDir, `pane-${suffix}.exit`);

		if (!options.skipMkfifo) {
			this.ensureFifoDir(fifoDir);
			this.makeFifo(this.fifoPath);
		}

		// Lifecycle order is what makes the hybrid actually work. Three
		// design decisions are baked in here — see the architecture comment
		// at the top of this file for the full rationale, but in short:
		//
		//  - Reader child is spawned BEFORE pipe-pane so tmux never blocks
		//    on its fifo write.
		//
		//  - The user command is wrapped to write its exit code to a
		//    sidecar file. We DROPPED `remain-on-exit on` because it keeps
		//    pipe-pane's writer alive after the target process exits, which
		//    starves our cat reader of the EOF that triggers exit detection.
		//    The sidecar approach gives us a reliable exit-code source
		//    without keeping the pane alive after exit.
		//
		//  - Race window between split-window returning and pipe-pane
		//    being enabled is documented as a known limitation (~30-100ms).
		try {
			if (!options.skipReader) this.spawnReader();
			this._paneId = this.createPane(options);
			this.captureInitialPid();
			this.applyPaneMetadata(options.pane ?? {});
			this.enablePipePane();
		} catch (err) {
			this.rollbackConstruction();
			throw err;
		}
	}

	// --- construction steps ----------------------------------------------

	private spawnReader(): void {
		// Run the reader as a child process so its blocking fifo open is
		// confined to the child. The parent reads from the child's stdout,
		// which is a standard libuv pipe — no thread strand on shutdown.
		const child = spawnChild(this.readerCommand, [this.fifoPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.readerChild = child;

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.handleBytes(chunk));

		// stderr from `cat` would only appear on real error (e.g. fifo gone).
		// Surface but don't fail — dispose() will be triggered by exit anyway.
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (msg: string) => {
			if (msg.trim()) console.error(`[pty-pane-session] reader stderr: ${msg.trim()}`);
		});

		child.on("exit", () => this.handleReaderExit());
		child.on("error", (err) => {
			console.error(`[pty-pane-session] reader spawn error: ${err.message}`);
		});
	}

	private createPane(options: PtyPaneSessionOptions): string {
		const pane = options.pane ?? {};
		const envSnapshot = this.buildPaneEnv(options.env);
		// Wrap the user command so the shell writes its exit code to a sidecar
		// file before terminating. Three design points:
		//   - `( ... )` subshell isolates the user's `exit N` so it doesn't
		//     short-circuit the wrapping shell.
		//   - The wrapping shell ignores INT/TERM/HUP. Signals we deliver via
		//     `kill -INT $-pgid` propagate to the subshell, where any user
		//     trap fires normally; the wrapping shell continues executing past
		//     the subshell and reliably writes the exit code.
		//   - `trap ... EXIT` is a belt-and-braces fallback: if a future code
		//     path adds a way for the wrapping shell to bail out before the
		//     trailing printf, the EXIT trap still captures the last `$?`.
		const exitFile = this.shellQuotePath(this.exitFilePath);
		const wrappedCommand = [
			`trap '' INT TERM HUP`,
			`trap 'printf "%d" "$?" > ${exitFile}' EXIT`,
			`( ${options.command} )`,
		].join("; ");
		const splitArgs = buildSplitWindowArgs({
			layout: pane.layout ?? DEFAULT_LAYOUT,
			sizePercent: pane.sizePercent ?? DEFAULT_SIZE_PERCENT,
			cwd: options.cwd,
			env: envSnapshot,
			shell: options.shell ?? this.defaultShell(),
			command: wrappedCommand,
		});
		const result = this.tmuxRunner.runTmux(splitArgs);
		const paneId = result.stdout.trim();
		if (!paneId) {
			throw new Error("tmux split-window returned no pane id");
		}
		return paneId;
	}

	private captureInitialPid(): void {
		try {
			const result = this.tmuxRunner.runTmux(
				buildDisplayMessageArgs(this._paneId, "#{pane_pid}"),
				{ allowNonZeroExit: true },
			);
			const pid = Number.parseInt(result.stdout.trim(), 10);
			if (Number.isFinite(pid) && pid > 0) {
				this._pid = pid;
			}
		} catch {
			// Pid is informational; the pane is already running.
		}
	}

	private applyPaneMetadata(pane: PaneOptions): void {
		try {
			if (pane.title !== undefined) {
				const args = buildSelectPaneArgs(this._paneId, { title: pane.title });
				this.tmuxRunner.runTmux(args, { allowNonZeroExit: true });
			}
			if (pane.select) {
				this.tmuxRunner.runTmux(["select-pane", "-t", this._paneId], {
					allowNonZeroExit: true,
				});
			}
		} catch {
			// Cosmetic; never fail construction over a title.
		}
	}

	// (remain-on-exit removed: it kept pipe-pane's writer alive past target
	// process exit, starving our cat reader of the EOF that triggers our
	// exit detection. The wrapped-command exit file replaces the role
	// remain-on-exit + #{pane_dead_status} would have played for exit code.)

	private enablePipePane(): void {
		// pipe-pane runs the shell command via /bin/sh -c, so shell
		// redirection works. We control the fifo path so it has no shell
		// metacharacters to worry about.
		const shellCommand = `cat > ${this.shellQuotePath(this.fifoPath)}`;
		this.tmuxRunner.runTmux(buildPipePaneArgs(this._paneId, shellCommand));
	}

	private rollbackConstruction(): void {
		// Best-effort cleanup of partial construction. dispose() handles the
		// fully-constructed teardown path; this is for failures during init.
		if (this.readerChild) {
			try {
				this.readerChild.kill("SIGKILL");
			} catch {
				// Ignore.
			}
			this.readerChild = null;
		}
		if (this._paneId) {
			try {
				this.tmuxRunner.runTmux(buildKillPaneArgs(this._paneId), {
					allowNonZeroExit: true,
				});
			} catch {
				// Ignore.
			}
		}
		try {
			unlinkSync(this.fifoPath);
		} catch {
			// Ignore.
		}
		try {
			unlinkSync(this.exitFilePath);
		} catch {
			// Ignore.
		}
	}

	private buildPaneEnv(callerEnv: Record<string, string | undefined> | undefined): Record<string, string> {
		// Match PtyTerminalSession's env semantics (codex review C2):
		// inherit process.env then layer caller-supplied overrides.
		// Filter out tmux-leakage vars so the pane process doesn't see
		// our parent server's TMUX context.
		const merged: Record<string, string> = {};
		const raw = callerEnv ? { ...process.env, ...callerEnv } : { ...process.env };
		if (!raw.TERM) raw.TERM = "xterm-256color";
		for (const [key, value] of Object.entries(raw)) {
			if (value === undefined) continue;
			if (key === "TMUX" || key === "TMUX_PANE") continue;
			merged[key] = value;
		}
		return merged;
	}

	private defaultShell(): string {
		if (process.platform === "win32") {
			return process.env.COMSPEC || "cmd.exe";
		}
		return process.env.SHELL || "/bin/sh";
	}

	private shellQuotePath(path: string): string {
		// Single-quote and escape any embedded single quotes for sh -c safety.
		// Belt + braces — fifoPath is generated by us, but shell-quoting it
		// is the right discipline regardless.
		return `'${path.replace(/'/g, "'\\''")}'`;
	}

	// --- byte-flow + exit handling --------------------------------------

	private handleBytes(chunk: string): void {
		if (this.disposed) return;
		this.rawOutput += chunk;
		this.trimRawOutputIfNeeded();
		this.notifyDataListeners(chunk);
	}

	private trimRawOutputIfNeeded(): void {
		const trimmed = trimRawOutput(this.rawOutput, this.lastStreamPosition);
		this.rawOutput = trimmed.rawOutput;
		this.lastStreamPosition = trimmed.lastStreamPosition;
	}

	private handleReaderExit(): void {
		// The cat reader exited. Either:
		//   (a) the target process exited → wrapping shell wrote the exit
		//       file → wrapping shell exited → tmux pty closed → pipe-pane
		//       drained → cat saw EOF → we are here.
		//   (b) dispose() SIGKILL'd cat for orderly teardown.
		//   (c) cat itself crashed (rare; e.g. fifo unlinked under it).
		//
		// In case (a) the exit file exists with the real exit code. In (b)
		// the file may not exist yet because dispose ran before the wrapping
		// shell wrote it; we synthesize 130 (SIGINT-equivalent) so callers
		// can distinguish. In (c) we also fall through to synthetic.
		if (this.disposed) return;
		if (this._exited) return;

		let exitCode = 130; // synthetic default for case (b)/(c)
		try {
			const raw = readFileSync(this.exitFilePath, "utf8").trim();
			const parsed = Number.parseInt(raw, 10);
			if (Number.isFinite(parsed)) {
				exitCode = parsed;
			}
		} catch {
			// File missing or unreadable — keep synthetic default.
		}

		this._exited = true;
		this._exitCode = exitCode;
		this._signal = undefined;
		this.notifyExitListeners(exitCode, undefined);
	}


	// --- private helpers -------------------------------------------------

	private ensureFifoDir(dir: string): void {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch {
			// If mkdir fails, mkfifo will surface the real error.
		}
	}

	private makeFifo(path: string): void {
		// Use mkfifo(1) rather than libc mkfifo so we don't pull in extra deps.
		// Mode 0o600 — owner read/write only, no risk of cross-user fifo eavesdrop.
		execFileSync("mkfifo", ["-m", "600", path]);
	}

	private notifyDataListeners(data: string): void {
		this.dataHandler?.(data);
		for (const listener of [...this.additionalDataListeners]) {
			listener(data);
		}
	}

	private notifyExitListeners(exitCode: number, signal?: number): void {
		this.exitHandler?.(exitCode, signal);
		for (const listener of [...this.additionalExitListeners]) {
			listener(exitCode, signal);
		}
	}

	// --- PtySession lifecycle state --------------------------------------

	get exited(): boolean {
		return this._exited;
	}
	get exitCode(): number | null {
		return this._exitCode;
	}
	get signal(): number | undefined {
		return this._signal;
	}
	get pid(): number {
		return this._pid;
	}
	get cols(): number {
		return this._cols;
	}
	get rows(): number {
		return this._rows;
	}

	// --- PtySession event wiring -----------------------------------------

	setEventHandlers(events: PtySessionEventsShape): void {
		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;
	}

	addDataListener(cb: (data: string) => void): () => void {
		if (this.disposed) return () => {};
		this.additionalDataListeners.push(cb);
		return () => {
			const idx = this.additionalDataListeners.indexOf(cb);
			if (idx >= 0) this.additionalDataListeners.splice(idx, 1);
		};
	}

	addExitListener(cb: (exitCode: number, signal?: number) => void): () => void {
		if (this.disposed) return () => {};
		this.additionalExitListeners.push(cb);
		return () => {
			const idx = this.additionalExitListeners.indexOf(cb);
			if (idx >= 0) this.additionalExitListeners.splice(idx, 1);
		};
	}

	// --- PtySession input + sizing ---------------------------------------

	write(data: string): void {
		// PtySession.write's contract: callers pass already-encoded text or
		// escape sequences (key-encoding.ts handles named-key → bytes upstream).
		//
		// We forward those bytes to the pane via tmux send-keys. Most bytes
		// can use `-l` (literal): plain text echoes, ESC sequences pass through
		// to the receiving application, even \r is translated to \n by the
		// pty line discipline. BUT certain TTY signal bytes (INTR, EOF, SUSP,
		// QUIT) are NOT generated by send-keys -l for reasons internal to tmux's
		// input path. For those we fall back to send-keys WITH named-key
		// notation (`C-c`, `C-d`, etc.), which tmux translates into the proper
		// signal-generating byte at the pty boundary.
		//
		// We split the input into runs: literal text runs go through -l, and
		// special control bytes are emitted one at a time via named keys.
		if (this._exited || this.disposed || !this._paneId) return;
		if (data.length === 0) return;
		const runs = splitWriteForSendKeys(data);
		for (const run of runs) {
			try {
				const args =
					run.kind === "named"
						? buildSendKeysNamedArgs(this._paneId, [run.value])
						: buildSendKeysLiteralArgs(this._paneId, run.value);
				this.tmuxRunner.runTmux(args, { allowNonZeroExit: true });
			} catch {
				// Best-effort — pane might be gone, matches PtyTerminalSession.write's
				// silent behavior when the underlying pty is closed.
			}
		}
	}

	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		if (cols < 1 || rows < 1) return;
		if (this._paneId) {
			try {
				this.tmuxRunner.runTmux(buildResizePaneArgs(this._paneId, cols, rows), {
					allowNonZeroExit: true,
				});
			} catch {
				// Pane might be dead; resize is best-effort.
			}
		}
		this._cols = cols;
		this._rows = rows;
	}

	// --- PtySession output queries ---------------------------------------

	getViewportLines(options: ViewportLinesOptions = {}): string[] {
		// Capture the visible pane viewport — no scrollback. tmux already
		// rendered everything (cursor moves, line clears, ANSI styling), so
		// the snapshot IS the viewport. No diff, no shadow buffer.
		if (this.disposed || !this._paneId) return [];
		try {
			const result = this.tmuxRunner.runTmux(
				buildCapturePaneArgs(this._paneId, { ansi: options.ansi !== false }),
				{ allowNonZeroExit: true },
			);
			return this.normalizeCaptureOutput(result.stdout, this._rows);
		} catch {
			return [];
		}
	}

	getTailLines(options: TailLinesOptions): TailLinesResult {
		// Capture-pane with scrollback. Slice to the requested line count
		// (mirrors PtyTerminalSession.getTailLines's contract).
		const requested = Math.max(0, Math.trunc(options.lines));
		const maxChars =
			options.maxChars !== undefined ? Math.max(0, Math.trunc(options.maxChars)) : undefined;

		if (this.disposed || !this._paneId) {
			return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false };
		}
		if (requested === 0) {
			return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false };
		}

		let allLines: string[] = [];
		try {
			const result = this.tmuxRunner.runTmux(
				buildCapturePaneArgs(this._paneId, {
					ansi: options.ansi !== false,
					includeHistory: true,
				}),
				{ allowNonZeroExit: true },
			);
			allLines = this.normalizeCaptureOutput(result.stdout, undefined);
			// Trim trailing empty rows. tmux capture-pane returns the entire
			// pane buffer including unfilled rows below the cursor (default
			// pane is 24 rows wide). For getTailLines the contract is
			// 'last N content lines', so drop the trailing padding. We keep
			// internal empty lines — only TRAILING ones are padding.
			while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
				allLines.pop();
			}
		} catch {
			return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false };
		}

		const totalLinesInBuffer = allLines.length;
		const start = Math.max(0, totalLinesInBuffer - requested);
		const tail = allLines.slice(start);

		// maxChars truncation: walk forward, drop lines once the budget is exhausted.
		let truncatedByChars = false;
		let remaining = maxChars;
		const out: string[] = [];
		for (const line of tail) {
			if (remaining !== undefined) {
				if (remaining <= 0) {
					truncatedByChars = true;
					break;
				}
				remaining -= line.length;
			}
			out.push(line);
		}
		return { lines: out, totalLinesInBuffer, truncatedByChars };
	}

	private normalizeCaptureOutput(raw: string, padToRows: number | undefined): string[] {
		// tmux's capture-pane output ends with a trailing newline. Split,
		// drop the empty trailing element, optionally pad to `padToRows`
		// for getViewportLines's fixed-row contract.
		const stripped = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
		const lines = stripped.length === 0 ? [] : stripped.split("\n");
		if (padToRows !== undefined && lines.length < padToRows) {
			while (lines.length < padToRows) lines.push("");
		}
		return lines;
	}

	getRawStream(options: RawStreamOptions = {}): string {
		let output: string;
		if (options.sinceLast) {
			output = this.rawOutput.substring(this.lastStreamPosition);
			this.lastStreamPosition = this.rawOutput.length;
		} else {
			output = this.rawOutput;
		}
		if (options.stripAnsi !== false && output) {
			output = stripVTControlCharacters(output);
		}
		return output;
	}

	getLogSlice(options: LogSliceOptions = {}): LogSliceResult {
		return sliceLogOutput(this.rawOutput, options);
	}

	// --- PtySession overlay scroll (no-op for pane sessions) -------------

	scrollUp(_lines: number): void {}
	scrollDown(_lines: number): void {}
	scrollToBottom(): void {}
	isScrolledUp(): boolean {
		return false;
	}

	// --- PtySession termination ------------------------------------------

	kill(signal: string = "SIGTERM"): void {
		// Send a real signal to the pane's foreground process group.
		// We use the captured _pid (the shell tmux spawned for the pane);
		// the pane process group head will be that pid.
		if (this._exited || this.disposed) return;
		if (process.platform !== "win32" && this._pid) {
			try {
				process.kill(-this._pid, signal as NodeJS.Signals);
				return;
			} catch {
				// Fall through — the process group might be gone, or we're
				// running on a platform without negative-pid signaling.
			}
		}
		// Fallback: ask tmux to send the signal via send-keys C-c (interrupt)
		// when SIGINT is requested. For other signals there is no clean tmux
		// equivalent — dispose() will kill-pane outright.
		if (signal === "SIGINT" && this._paneId) {
			try {
				this.tmuxRunner.runTmux(buildSendKeysNamedArgs(this._paneId, ["C-c"]), {
					allowNonZeroExit: true,
				});
			} catch {
				// Best-effort.
			}
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		// SIGKILL the cat reader before tearing down the pane so the parent's
		// stream pipe closes cleanly and vitest workers can finalize.
		if (this.readerChild) {
			try {
				this.readerChild.kill("SIGKILL");
			} catch {
				// Already dead.
			}
			this.readerChild = null;
		}

		// Unconditional kill-pane (codex review B3 fix). Even if `_exited`
		// has been set by the fifo-EOF handler, the tmux pane is still alive
		// because we set `remain-on-exit on` during construction. Without
		// this kill, dead panes accumulate in the user's tmux server.
		if (this._paneId) {
			try {
				this.tmuxRunner.runTmux(buildKillPaneArgs(this._paneId), {
					allowNonZeroExit: true,
				});
			} catch {
				// Pane might already be gone; teardown is best-effort.
			}
		}

		// Drop listeners so late event delivery is suppressed.
		this.additionalDataListeners = [];
		this.additionalExitListeners = [];
		this.dataHandler = undefined;
		this.exitHandler = undefined;

		// Clean up the fifo and exit-code sidecar files. Failure is fine —
		// /tmp gets reaped anyway.
		try {
			unlinkSync(this.fifoPath);
		} catch {
			// Already gone, never created, or no permission.
		}
		try {
			unlinkSync(this.exitFilePath);
		} catch {
			// Already gone or never written.
		}
	}

	// --- internal accessors used by tests --------------------------------

	/** @internal Used by integration tests to verify pane construction. */
	get paneId(): string {
		return this._paneId;
	}

	/** @internal Used by integration tests to verify fifo path. */
	get fifoPathForTesting(): string {
		return this.fifoPath;
	}

	/**
	 * @internal Drive byte flow into the SUT without an actual fifo.
	 * Only valid in tests that set `skipReader: true`. Mirrors what
	 * the cat reader's stdout 'data' handler would have called.
	 */
	_feedReaderBytes(chunk: string): void {
		this.handleBytes(chunk);
	}

	/**
	 * @internal Synthesize the reader-exit event for tests that set
	 * `skipReader: true`. Reads the exit-file sidecar if present.
	 */
	_simulateReaderExit(): void {
		this.handleReaderExit();
	}
}

// --- helpers ----------------------------------------------------------------

type WriteRun = { kind: "literal"; value: string } | { kind: "named"; value: string };

/**
 * Map of TTY signal bytes that need to be emitted via tmux's named-key
 * notation rather than `-l` literal mode. tmux send-keys -l writes bytes
 * through a path that doesn't trigger the pty line discipline's signal
 * generation, so 0x03 etc. don't become SIGINT. Named keys go through a
 * different code path that does generate the signal.
 *
 * Other control bytes (0x09 Tab, 0x0d Enter, 0x1b Esc) work fine via -l
 * because they don't generate signals — they're just regular input.
 */
const TMUX_SIGNAL_BYTE_TO_KEY: Record<string, string> = {
	"\x03": "C-c",
	"\x04": "C-d",
	"\x1a": "C-z",
	"\x1c": "C-\\",
};

/**
 * Split a write payload into runs of literal text and individual special
 * control bytes. Exported for unit testing.
 */
export function splitWriteForSendKeys(data: string): WriteRun[] {
	const out: WriteRun[] = [];
	let buf = "";
	for (const ch of data) {
		const keyName = TMUX_SIGNAL_BYTE_TO_KEY[ch];
		if (keyName !== undefined) {
			if (buf) {
				out.push({ kind: "literal", value: buf });
				buf = "";
			}
			out.push({ kind: "named", value: keyName });
		} else {
			buf += ch;
		}
	}
	if (buf) out.push({ kind: "literal", value: buf });
	return out;
}
