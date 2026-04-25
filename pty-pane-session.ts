/**
 * `PtyPaneSession` is the tmux-pane render-target counterpart to
 * `PtyTerminalSession`. It mirrors the same public surface (state getters,
 * lifecycle methods, listeners, buffer queries) so the dispatcher,
 * monitor, and overlay consumers can be wired to either implementation
 * without further branching.
 *
 * Implementation strategy: PUSH (a.k.a. fifo-tap)
 *
 *   1. `tmux split-window -d -P -F '#{pane_id}' ...` creates the sibling
 *      pane and yields its `%N` id.
 *   2. `tmux pipe-pane -o -t <pane> 'cat >> "<fifo>"'` redirects the pane's
 *      stdout into a named pipe under `${TMPDIR:-/tmp}/pi-interactive-shell/`.
 *   3. We open that fifo with `O_RDWR` so the read end stays valid even
 *      when the writer transiently closes (e.g. when tmux replaces the
 *      pipe). Bytes from the fifo flow into a local `@xterm/headless`
 *      instance configured exactly as `pty-session.ts` does — preserving
 *      the SerializeAddon, the raw-output buffer, the WriteQueue ordering
 *      and the DSR split path.
 *   4. Pane death is detected by polling `tmux display-message -p` on the
 *      pane id at 500ms (short enough for monitor triggers, cheap enough
 *      to be invisible). When the pane is gone or `pane_dead == 1` we
 *      synthesise an exit and notify listeners.
 *
 * Things that are deliberately stubs in v1:
 *
 *   - `resize()` does NOT call `tmux resize-pane`. The user owns the pane
 *     window; reshaping it from underneath them is hostile. We do, however,
 *     resize the local xterm to match the actual pane dimensions on every
 *     poll tick so rendering stays in sync if the user resizes the pane.
 *   - The scroll family (`scrollUp` / `scrollDown` / `scrollToBottom` /
 *     `isScrolledUp`) maintains the same state machine as `PtyTerminalSession`,
 *     because consumers (`overlay-component.ts`) call into it. tmux owns the
 *     real scrollback in the pane; our buffer scroll only affects the
 *     overlay copy.
 */

import { stripVTControlCharacters } from "node:util";
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync, unlinkSync, createReadStream, constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadStream } from "node:fs";
import type { Terminal as XtermTerminal, IBufferCell } from "@xterm/headless";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { sliceLogOutput, trimRawOutput } from "./pty-log.js";
import { splitAroundDsr } from "./pty-protocol.js";
import {
	type PaneLayout,
	type PaneStatus,
	type TmuxRunner,
	buildSplitWindowArgs,
	getPanePid,
	getPaneSize,
	getPaneStatus,
	inTmuxSession,
	killPane,
	pipePaneToFifo,
	resizePane,
	selectPane,
	sendKeysLiteral,
	setPaneTitle,
	setRemainOnExit,
	splitWindow,
	unpipePane,
} from "./tmux-cli.js";
import type { PtySessionOptions, PtySessionEvents } from "./pty-session.js";

const Terminal = xterm.Terminal;

// Same regexes as `pty-session.ts` so plain-text rendering is identical.
const OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const APC_REGEX = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ESC_SINGLE_REGEX = /\x1b[@-_]/g;
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;

function sanitizeLine(line: string): string {
	let out = line;
	if (out.includes("\u001b")) {
		out = out.replace(OSC_REGEX, "");
		out = out.replace(APC_REGEX, "");
		out = out.replace(DCS_REGEX, "");
		out = out.replace(CSI_REGEX, (match) => (match.endsWith("m") ? match : ""));
		out = out.replace(ESC_SINGLE_REGEX, "");
	}
	if (out.includes("\t")) out = out.replace(/\t/g, "   ");
	if (out.includes("\r")) out = out.replace(/\r/g, "");
	out = out.replace(CONTROL_REGEX, "");
	return out;
}

type CellStyle = {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	invisible: boolean;
	strikethrough: boolean;
	fgMode: "default" | "palette" | "rgb";
	fg: number;
	bgMode: "default" | "palette" | "rgb";
	bg: number;
};

function styleKey(style: CellStyle): string {
	return [
		style.bold ? "b" : "-",
		style.dim ? "d" : "-",
		style.italic ? "i" : "-",
		style.underline ? "u" : "-",
		style.inverse ? "v" : "-",
		style.invisible ? "x" : "-",
		style.strikethrough ? "s" : "-",
		`fg:${style.fgMode}:${style.fg}`,
		`bg:${style.bgMode}:${style.bg}`,
	].join("");
}

function rgbToSgr(isFg: boolean, hex: number): string {
	const r = (hex >> 16) & 0xff;
	const g = (hex >> 8) & 0xff;
	const b = hex & 0xff;
	return isFg ? `38;2;${r};${g};${b}` : `48;2;${r};${g};${b}`;
}

function paletteToSgr(isFg: boolean, idx: number): string {
	return isFg ? `38;5;${idx}` : `48;5;${idx}`;
}

function sgrForStyle(style: CellStyle): string {
	const parts: string[] = ["0"];
	if (style.bold) parts.push("1");
	if (style.dim) parts.push("2");
	if (style.italic) parts.push("3");
	if (style.underline) parts.push("4");
	if (style.inverse) parts.push("7");
	if (style.invisible) parts.push("8");
	if (style.strikethrough) parts.push("9");
	if (style.fgMode === "rgb") parts.push(rgbToSgr(true, style.fg));
	else if (style.fgMode === "palette") parts.push(paletteToSgr(true, style.fg));
	if (style.bgMode === "rgb") parts.push(rgbToSgr(false, style.bg));
	else if (style.bgMode === "palette") parts.push(paletteToSgr(false, style.bg));
	return `\u001b[${parts.join(";")}m`;
}

function normalizePaletteColor(mode: "default" | "palette" | "rgb", value: number): { mode: "default" | "palette" | "rgb"; value: number } {
	if (mode !== "palette") return { mode, value };
	if (value < 0 || value > 255) return { mode: "default", value: 0 };
	return { mode: "palette", value };
}

class WriteQueue {
	private queue = Promise.resolve();

	enqueue(fn: () => Promise<void> | void): void {
		this.queue = this.queue.then(() => fn()).catch((err) => {
			console.error("WriteQueue error:", err);
		});
	}

	async drain(): Promise<void> {
		await this.queue;
	}
}

export interface PaneOptions {
	layout: PaneLayout;
	sizePercent: number;
	title?: string;
	select?: boolean;
}

export interface PtyPaneSessionOptions extends PtySessionOptions {
	pane: PaneOptions;
	/** Optional override for tmux invocations (used by tests). */
	tmuxRunner?: TmuxRunner;
	/** Override the directory used for fifo files. Defaults to `${TMPDIR}/pi-interactive-shell/`. */
	fifoDir?: string;
	/** Polling interval for pane life-cycle checks. Defaults to 500ms. */
	pollIntervalMs?: number;
	/** Skip the optional `mkfifo` shell-out (used by tests that supply a pre-built fifo). */
	skipFifoCreate?: boolean;
	/** Override the fifo path entirely (used by tests so they can pre-create the pipe). */
	fifoPathOverride?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Drop-in replacement for `PtyTerminalSession` that runs the target command
 * inside a sibling tmux pane and tunnels its output through a fifo. See the
 * file header comment for the full rationale.
 */
export class PtyPaneSession {
	private xterm: XtermTerminal;
	private serializer: SerializeAddon | null = null;
	private writeQueue = new WriteQueue();

	private rawOutput = "";
	private lastStreamPosition = 0;

	private _exited = false;
	private _exitCode: number | null = null;
	private _signal: number | undefined;

	private scrollOffset = 0;
	private followBottom = true;

	private dataHandler: ((data: string) => void) | undefined;
	private exitHandler: ((exitCode: number, signal?: number) => void) | undefined;
	private additionalDataListeners: Array<(data: string) => void> = [];
	private additionalExitListeners: Array<(exitCode: number, signal?: number) => void> = [];

	private readonly _paneId: string;
	private readonly fifoPath: string;
	private fifoFd: number | null = null;
	private fifoStream: ReadStream | null = null;
	private readonly tmuxRunner: TmuxRunner;
	private readonly pollIntervalMs: number;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private _pid = 0;

	constructor(options: PtyPaneSessionOptions, events: PtySessionEvents = {}) {
		if (!inTmuxSession()) {
			throw new Error(
				'render: "pane" requires running pi inside a tmux session. ' +
				'Either start tmux or use render: "overlay".',
			);
		}

		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;
		this.tmuxRunner = options.tmuxRunner ?? { execFileSync };
		this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

		const cols = options.cols ?? 80;
		const rows = options.rows ?? 24;
		const scrollback = options.scrollback ?? 5000;
		const ansiReemit = options.ansiReemit !== false;

		this.xterm = new Terminal({ cols, rows, scrollback, allowProposedApi: true, convertEol: true });
		if (ansiReemit) {
			this.serializer = new SerializeAddon();
			this.xterm.loadAddon(this.serializer);
		}

		// Decide on the shell exactly like pty-session.ts does so users who
		// configure $SHELL get the same behaviour in both render modes.
		const shell =
			options.shell ??
			(process.platform === "win32"
				? process.env.COMSPEC || "cmd.exe"
				: process.env.SHELL || "/bin/sh");
		const shellArgs = process.platform === "win32" ? ["/c", options.command] : ["-c", options.command];

		const fifoDir = options.fifoDir ?? join(tmpdir(), "pi-interactive-shell");
		this.fifoPath = options.fifoPathOverride ?? join(fifoDir, `pane-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.fifo`);

		this.ensureFifoDir(fifoDir);
		this.sweepStaleFifos(fifoDir);

		if (!options.skipFifoCreate) {
			this.makeFifo(this.fifoPath);
		}

		// Open the fifo BEFORE wiring pipe-pane so the writer never blocks.
		// O_RDWR keeps the read end alive across writer reconnects (per the
		// architecture brief). On macOS this works in practice; on platforms
		// where O_RDWR is rejected on a fifo we fall back to non-blocking
		// read-only.
		this.fifoFd = this.openFifoForReading(this.fifoPath);

		// Translate the pane env (excluding the inheriting bits) into -e flags.
		const paneEnv = this.collectPaneEnv(options.env);

		try {
			this._paneId = splitWindow({
				layout: options.pane.layout,
				sizePercent: options.pane.sizePercent,
				cwd: options.cwd ?? process.cwd(),
				env: paneEnv,
				shell,
				shellArgs,
			}, this.tmuxRunner);
		} catch (error) {
			// Roll back fifo state so we don't leak resources on construction failure.
			this.cleanupFifo();
			throw error;
		}

		// remain-on-exit lets us read pane_dead_status / pane_dead_signal
		// after the command finishes, so we can deliver an accurate exit
		// code to listeners. Without this, the pane disappears at exit and
		// we have no way to retrieve the code.
		setRemainOnExit(this._paneId, this.tmuxRunner);

		// Set the pane title for cosmetic identification (only visible if the
		// user has `pane-border-status` enabled; harmless otherwise).
		const title = options.pane.title ?? options.command.split(/\s+/, 1)[0] ?? "command";
		setPaneTitle(this._paneId, title, this.tmuxRunner);

		const pid = getPanePid(this._paneId, this.tmuxRunner);
		if (pid !== null) this._pid = pid;

		const size = getPaneSize(this._paneId, this.tmuxRunner);
		if (size && (size.cols !== this.xterm.cols || size.rows !== this.xterm.rows)) {
			this.xterm.resize(size.cols, size.rows);
		}

		try {
			pipePaneToFifo(this._paneId, this.fifoPath, this.tmuxRunner);
		} catch (error) {
			killPane(this._paneId, this.tmuxRunner);
			this.cleanupFifo();
			throw error;
		}

		this.attachFifoReader();

		if (options.pane.select) {
			selectPane(this._paneId, this.tmuxRunner);
		}

		this.startPaneStatusPolling();
	}

	// ---------------------------------------------------------------------
	// Public surface (mirrors PtyTerminalSession)
	// ---------------------------------------------------------------------

	get exited(): boolean { return this._exited; }
	get exitCode(): number | null { return this._exitCode; }
	get signal(): number | undefined { return this._signal; }
	get pid(): number { return this._pid; }
	get cols(): number { return this.xterm.cols; }
	get rows(): number { return this.xterm.rows; }
	get paneId(): string { return this._paneId; }

	setEventHandlers(events: PtySessionEvents): void {
		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;
	}

	addDataListener(cb: (data: string) => void): () => void {
		this.additionalDataListeners.push(cb);
		return () => {
			const idx = this.additionalDataListeners.indexOf(cb);
			if (idx >= 0) this.additionalDataListeners.splice(idx, 1);
		};
	}

	addExitListener(cb: (exitCode: number, signal?: number) => void): () => void {
		this.additionalExitListeners.push(cb);
		return () => {
			const idx = this.additionalExitListeners.indexOf(cb);
			if (idx >= 0) this.additionalExitListeners.splice(idx, 1);
		};
	}

	write(data: string): void {
		if (this._exited || !data) return;
		try {
			sendKeysLiteral(this._paneId, data, this.tmuxRunner);
		} catch (error) {
			// If send-keys fails (e.g. pane vanished), drop the input and
			// rely on the polling loop to surface the exit. We avoid throwing
			// because callers (overlay key handler, monitor) treat write()
			// as fire-and-forget.
			console.error("PtyPaneSession write error:", (error as Error)?.message ?? error);
		}
	}

	resize(cols: number, rows: number): void {
		if (cols < 1 || rows < 1) return;
		// Track requested dimensions on the local xterm so consumers (like
		// the overlay) get consistent dimensions back. We do NOT resize the
		// actual tmux pane: the user owns that window, and reshaping it
		// from under them is rude. The polling loop independently keeps
		// xterm in sync with the pane's true size if the user resizes it.
		if (cols === this.xterm.cols && rows === this.xterm.rows) return;
		this.xterm.resize(cols, rows);
	}

	kill(signal: string = "SIGTERM"): void {
		if (this._exited) return;
		// Try to signal the pane process directly if we know its pid; that
		// gives the running command a chance to handle SIGTERM/SIGINT
		// gracefully (mirrors PtyTerminalSession.kill semantics). The pane
		// itself is then torn down via kill-pane regardless.
		if (process.platform !== "win32" && this._pid > 0) {
			try {
				process.kill(this._pid, signal as NodeJS.Signals);
			} catch {
				// Process may already be dead; ignore.
			}
		}
		killPane(this._paneId, this.tmuxRunner);
	}

	dispose(): void {
		this.stopPaneStatusPolling();
		try {
			unpipePane(this._paneId, this.tmuxRunner);
		} catch {
			// pane may already be gone
		}
		killPane(this._paneId, this.tmuxRunner);
		this.cleanupFifo();
		try {
			this.xterm.dispose();
		} catch {
			// safe to ignore during teardown
		}
	}

	// ---------------------------------------------------------------------
	// Buffer queries (identical logic to PtyTerminalSession; copied to keep
	// the two implementations independent and avoid awkward inheritance).
	// ---------------------------------------------------------------------

	private renderLineFromCells(lineIndex: number, cols: number): string {
		const buffer = this.xterm.buffer.active;
		const line = buffer.getLine(lineIndex);

		let currentStyle: CellStyle = {
			bold: false,
			dim: false,
			italic: false,
			underline: false,
			inverse: false,
			invisible: false,
			strikethrough: false,
			fgMode: "default",
			fg: 0,
			bgMode: "default",
			bg: 0,
		};
		let currentKey = styleKey(currentStyle);
		let out = sgrForStyle(currentStyle);

		for (let x = 0; x < cols; x++) {
			const cell: IBufferCell | undefined = line?.getCell(x);
			const width = cell?.getWidth() ?? 1;
			if (width === 0) continue;

			const chars = cell?.getChars() ?? " ";
			const cellChars = chars.length === 0 ? " " : chars;

			const rawFgMode: CellStyle["fgMode"] = cell?.isFgDefault()
				? "default"
				: cell?.isFgRGB()
					? "rgb"
					: cell?.isFgPalette()
						? "palette"
						: "default";
			const rawBgMode: CellStyle["bgMode"] = cell?.isBgDefault()
				? "default"
				: cell?.isBgRGB()
					? "rgb"
					: cell?.isBgPalette()
						? "palette"
						: "default";

			const fg = normalizePaletteColor(rawFgMode, cell?.getFgColor() ?? 0);
			const bg = normalizePaletteColor(rawBgMode, cell?.getBgColor() ?? 0);

			const nextStyle: CellStyle = {
				bold: !!cell?.isBold(),
				dim: !!cell?.isDim(),
				italic: !!cell?.isItalic(),
				underline: !!cell?.isUnderline(),
				inverse: !!cell?.isInverse(),
				invisible: !!cell?.isInvisible(),
				strikethrough: !!cell?.isStrikethrough(),
				fgMode: fg.mode,
				fg: fg.value,
				bgMode: bg.mode,
				bg: bg.value,
			};
			const nextKey = styleKey(nextStyle);
			if (nextKey !== currentKey) {
				currentStyle = nextStyle;
				currentKey = nextKey;
				out += sgrForStyle(currentStyle);
			}
			out += cellChars;
		}
		return out + "\u001b[0m";
	}

	getViewportLines(options: { ansi?: boolean } = {}): string[] {
		const buffer = this.xterm.buffer.active;
		const lines: string[] = [];
		const totalLines = buffer.length;
		if (this.followBottom) this.scrollOffset = 0;
		const viewportStart = Math.max(0, totalLines - this.xterm.rows - this.scrollOffset);

		const useAnsi = !!options.ansi;
		if (useAnsi) {
			for (let i = 0; i < this.xterm.rows; i++) {
				const lineIndex = viewportStart + i;
				const rendered = this.renderLineFromCells(lineIndex, this.xterm.cols);
				const plain = buffer.getLine(lineIndex)?.translateToString(true) ?? "";
				const renderedPlain = rendered
					.replace(/\x1b\[[0-9;]*m/g, "")
					.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
				if (plain.trim().length > 0 && renderedPlain.trim().length === 0) {
					lines.push(sanitizeLine(plain) + "\u001b[0m");
				} else {
					lines.push(rendered);
				}
			}
			return lines;
		}

		for (let i = 0; i < this.xterm.rows; i++) {
			const lineIndex = viewportStart + i;
			if (lineIndex < totalLines) {
				const line = buffer.getLine(lineIndex);
				lines.push(sanitizeLine(line?.translateToString(true) ?? ""));
			} else {
				lines.push("");
			}
		}
		return lines;
	}

	getTailLines(options: { lines: number; ansi?: boolean; maxChars?: number }): {
		lines: string[];
		totalLinesInBuffer: number;
		truncatedByChars: boolean;
	} {
		const requested = Math.max(0, Math.trunc(options.lines));
		const maxChars = options.maxChars !== undefined ? Math.max(0, Math.trunc(options.maxChars)) : undefined;
		const buffer = this.xterm.buffer.active;
		const totalLinesInBuffer = buffer.length;
		if (requested === 0) return { lines: [], totalLinesInBuffer, truncatedByChars: false };

		const start = Math.max(0, totalLinesInBuffer - requested);
		const out: string[] = [];
		let remainingChars = maxChars;
		let truncatedByChars = false;

		const useAnsi = options.ansi && this.serializer;
		if (useAnsi) {
			const serialized = this.serializer!.serialize();
			const serializedLines = serialized.split(/\r?\n/);
			if (serializedLines.length >= totalLinesInBuffer) {
				for (let i = start; i < totalLinesInBuffer; i++) {
					const raw = serializedLines[i] ?? "";
					const line = sanitizeLine(raw) + "\u001b[0m";
					if (remainingChars !== undefined) {
						if (remainingChars <= 0) { truncatedByChars = true; break; }
						remainingChars -= line.length;
					}
					out.push(line);
				}
				return { lines: out, totalLinesInBuffer, truncatedByChars };
			}
		}

		for (let i = start; i < totalLinesInBuffer; i++) {
			const lineObj = buffer.getLine(i);
			const line = sanitizeLine(lineObj?.translateToString(true) ?? "");
			if (remainingChars !== undefined) {
				if (remainingChars <= 0) { truncatedByChars = true; break; }
				remainingChars -= line.length;
			}
			out.push(line);
		}

		return { lines: out, totalLinesInBuffer, truncatedByChars };
	}

	getRawStream(options: { sinceLast?: boolean; stripAnsi?: boolean } = {}): string {
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

	getLogSlice(options: { offset?: number; limit?: number; stripAnsi?: boolean } = {}): {
		slice: string;
		totalLines: number;
		totalChars: number;
		sliceLineCount: number;
	} {
		return sliceLogOutput(this.rawOutput, options);
	}

	scrollUp(lines: number): void {
		const buffer = this.xterm.buffer.active;
		const maxScroll = Math.max(0, buffer.length - this.xterm.rows);
		this.scrollOffset = Math.min(this.scrollOffset + lines, maxScroll);
		this.followBottom = false;
	}

	scrollDown(lines: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		if (this.scrollOffset === 0) this.followBottom = true;
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
		this.followBottom = true;
	}

	isScrolledUp(): boolean {
		return this.scrollOffset > 0;
	}

	// ---------------------------------------------------------------------
	// Private plumbing
	// ---------------------------------------------------------------------

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

	private trimRawOutputIfNeeded(): void {
		const trimmed = trimRawOutput(this.rawOutput, this.lastStreamPosition);
		this.rawOutput = trimmed.rawOutput;
		this.lastStreamPosition = trimmed.lastStreamPosition;
	}

	private ingestChunk(chunk: string): void {
		// Mirrors `PtyTerminalSession.onData`: split around DSR queries so
		// we preserve the cursor-report path. tmux already handles its
		// pane's pty's DSR replies internally, so we only need to keep the
		// path intact (no real responses to send).
		const { segments, hasDsr } = splitAroundDsr(chunk);
		if (!hasDsr) {
			this.writeQueue.enqueue(async () => {
				this.rawOutput += chunk;
				this.trimRawOutputIfNeeded();
				await new Promise<void>((resolve) => {
					this.xterm.write(chunk, () => resolve());
				});
				this.notifyDataListeners(chunk);
			});
			return;
		}
		for (const segment of segments) {
			this.writeQueue.enqueue(async () => {
				if (segment.text) {
					this.rawOutput += segment.text;
					this.trimRawOutputIfNeeded();
					await new Promise<void>((resolve) => {
						this.xterm.write(segment.text, () => resolve());
					});
					this.notifyDataListeners(segment.text);
				}
				// We deliberately do NOT respond to DSR here: the target
				// process is talking to tmux's pty, not to us. Logging is
				// also unnecessary; the segment is preserved in rawOutput
				// for fidelity.
			});
		}
	}

	private attachFifoReader(): void {
		if (this.fifoFd === null) return;
		const stream = createReadStream("", {
			fd: this.fifoFd,
			autoClose: false,
			highWaterMark: 64 * 1024,
		});
		this.fifoStream = stream;
		stream.on("data", (chunk) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (text.length === 0) return;
			this.ingestChunk(text);
		});
		stream.on("error", (error) => {
			// EBADF is the expected race when dispose() closes the fd while a
			// libuv read is in flight; treat it as "already closed, fine" per
			// the bake-off teardown choice (option-a) and stay quiet.
			if ((error as NodeJS.ErrnoException).code === "EBADF") return;
			console.error("PtyPaneSession fifo read error:", error.message);
		});
	}

	private startPaneStatusPolling(): void {
		this.pollTimer = setInterval(() => {
			this.tickPaneStatus();
		}, this.pollIntervalMs);
	}

	private stopPaneStatusPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private tickPaneStatus(): void {
		if (this._exited) return;
		const status: PaneStatus | null = getPaneStatus(this._paneId, this.tmuxRunner);
		if (status === null) {
			// Pane is gone entirely (most likely killed externally). We do
			// not have an exit code; surface null to mirror "killed by user".
			this.handlePaneDeath(null, undefined);
			return;
		}

		if (status.dead) {
			this.handlePaneDeath(status.exitStatus, status.exitSignal ?? undefined);
			return;
		}

		// Pane still alive: opportunistically resync xterm dimensions if
		// the user resized the pane.
		const size = getPaneSize(this._paneId, this.tmuxRunner);
		if (size && (size.cols !== this.xterm.cols || size.rows !== this.xterm.rows)) {
			this.xterm.resize(size.cols, size.rows);
		}
	}

	private handlePaneDeath(exitCode: number | null, signal: number | undefined): void {
		if (this._exited) return;
		this._exited = true;
		this._exitCode = exitCode;
		this._signal = signal;

		// Append the same synthetic "[Process exited ...]" trailer as
		// PtyTerminalSession so consumers that parse it keep working.
		const exitMsg = `\n[Process exited with code ${exitCode}${signal ? ` (signal: ${signal})` : ""}]\n`;

		this.writeQueue.enqueue(async () => {
			this.rawOutput += exitMsg;
			await new Promise<void>((resolve) => {
				this.xterm.write(exitMsg, () => resolve());
			});
		});

		// Wait for the queue to drain so any final bytes from the fifo are
		// flushed before listeners observe the exit.
		this.writeQueue.drain().then(() => {
			this.notifyExitListeners(exitCode ?? 0, signal);
		}).catch(() => {
			this.notifyExitListeners(exitCode ?? 0, signal);
		});

		// Tear down auxiliary resources. We keep the xterm instance alive
		// because consumers may still call buffer queries against it.
		this.stopPaneStatusPolling();
		this.closeFifoStream();
		// Reap the pane (no-op if already gone) and unwire pipe-pane.
		try {
			unpipePane(this._paneId, this.tmuxRunner);
		} catch {
			// ignore
		}
		killPane(this._paneId, this.tmuxRunner);
		this.cleanupFifoFile();
	}

	private closeFifoStream(): void {
		if (this.fifoStream) {
			try { this.fifoStream.destroy(); } catch { /* ignore */ }
			this.fifoStream = null;
		}
		if (this.fifoFd !== null) {
			try { closeSync(this.fifoFd); } catch { /* ignore */ }
			this.fifoFd = null;
		}
	}

	private cleanupFifoFile(): void {
		try {
			if (existsSync(this.fifoPath)) unlinkSync(this.fifoPath);
		} catch {
			// ignore
		}
	}

	private cleanupFifo(): void {
		this.closeFifoStream();
		this.cleanupFifoFile();
	}

	private ensureFifoDir(dir: string): void {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	private sweepStaleFifos(dir: string): void {
		// Best-effort cleanup of fifo files left behind by crashed sessions.
		// We treat anything older than 6 hours as stale; this is conservative
		// enough to avoid clobbering a long-running peer session.
		const maxAgeMs = 6 * 60 * 60 * 1000;
		const now = Date.now();
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (!name.startsWith("pane-") || !name.endsWith(".fifo")) continue;
			const full = join(dir, name);
			try {
				const stats = statSync(full);
				if (now - stats.mtimeMs > maxAgeMs) {
					unlinkSync(full);
				}
			} catch {
				// File vanished or permission denied; skip.
			}
		}
	}

	private makeFifo(path: string): void {
		// Node has no built-in mkfifo, so shell out. Path is constructed
		// internally and contains only [a-zA-Z0-9-./] characters.
		execSync(`mkfifo -m 0600 ${shellQuote(path)}`);
	}

	private openFifoForReading(path: string): number {
		// O_RDWR keeps the read end alive across writer reconnects (per the
		// architecture brief). We deliberately do NOT set O_NONBLOCK here:
		// fs.createReadStream's internal read loop blocks happily on a
		// blocking fifo (the read sits in the libuv thread pool until data
		// arrives or the fd is closed at teardown), but it can mis-handle
		// EAGAIN from a non-blocking fd and tear down the stream after the
		// first chunk. Keeping it blocking is the simplest way to get
		// reliable streaming. Fall back to O_RDONLY if O_RDWR is rejected.
		try {
			return openSync(path, fsConstants.O_RDWR);
		} catch {
			return openSync(path, fsConstants.O_RDONLY);
		}
	}

	private collectPaneEnv(env?: Record<string, string | undefined>): Record<string, string> {
		const out: Record<string, string> = {};
		if (!env) return out;
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined) out[key] = value;
		}
		// Always set TERM if not already provided so the pane process sees a
		// reasonable default (matches PtyTerminalSession behaviour).
		if (out.TERM === undefined) out.TERM = "xterm-256color";
		return out;
	}
}

function shellQuote(value: string): string {
	// Single-quote and escape any embedded single quotes. Used only for
	// building the `mkfifo` shell command above where path is internal.
	return `'${value.replace(/'/g, "'\\''")}'`;
}
