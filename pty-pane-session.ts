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
import { mkdirSync, unlinkSync } from "node:fs";
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
	buildSetPaneOptionArgs,
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
}

export interface PtyPaneSessionEvents extends PtySessionEventsShape {}

const DEFAULT_FIFO_DIR_NAME = "pi-interactive-shell";
const DEFAULT_LAYOUT: PaneOptions["layout"] = "right";
const DEFAULT_SIZE_PERCENT = 40;

export class PtyPaneSession implements PtySession {
	private readonly tmuxRunner: TmuxRunner;
	private readonly fifoPath: string;
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
		this.fifoPath =
			options.fifoPathOverride ??
			join(fifoDir, `pane-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.fifo`);

		if (!options.skipMkfifo) {
			this.ensureFifoDir(fifoDir);
			this.makeFifo(this.fifoPath);
		}

		// Phase 3 will fill in: spawn child reader, split-window, set remain-on-exit, pipe-pane.
		// For now this skeleton just establishes the constructor signature and field shape.
		void options.command; // silence TS unused-var warning until Phase 3 wires construction
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
		if (this._exited || this.disposed || !this._paneId) return;
		// Phase 6 will route through send-keys; for now no-op.
		void data;
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

	getViewportLines(_options: ViewportLinesOptions = {}): string[] {
		// Phase 5 will implement via capture-pane.
		return [];
	}

	getTailLines(options: TailLinesOptions): TailLinesResult {
		// Phase 5 will implement via capture-pane.
		void options;
		return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false };
	}

	getRawStream(options: RawStreamOptions = {}): string {
		let output: string;
		if (options.sinceLast) {
			output = this.rawOutput.substring(this.lastStreamPosition);
			this.lastStreamPosition = this.rawOutput.length;
		} else {
			output = this.rawOutput;
		}
		// stripAnsi default true is documented at the interface.
		// Actual stripping happens in Phase 4 once data flows in.
		return output;
	}

	getLogSlice(_options: LogSliceOptions = {}): LogSliceResult {
		// Phase 4 will route through pty-log.ts's sliceLogOutput.
		return { slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 };
	}

	// --- PtySession overlay scroll (no-op for pane sessions) -------------

	scrollUp(_lines: number): void {}
	scrollDown(_lines: number): void {}
	scrollToBottom(): void {}
	isScrolledUp(): boolean {
		return false;
	}

	// --- PtySession termination ------------------------------------------

	kill(_signal: string = "SIGTERM"): void {
		// Phase 3 will send the signal to the pane process via tmux.
		// For now no-op; dispose() handles teardown.
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

		// Clean up the fifo file. Failure is fine — /tmp gets reaped anyway.
		try {
			unlinkSync(this.fifoPath);
		} catch {
			// Already gone, never created, or no permission.
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
}

// Silence TS "imported but unused" warnings for builders that fill in over Phases 3-6.
void buildSplitWindowArgs;
void buildSetPaneOptionArgs;
void buildPipePaneArgs;
void buildSelectPaneArgs;
void buildSendKeysLiteralArgs;
void buildSendKeysNamedArgs;
void buildCapturePaneArgs;
void buildDisplayMessageArgs;
void spawnChild;
