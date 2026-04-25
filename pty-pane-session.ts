import { stripVTControlCharacters } from "node:util";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { sliceLogOutput, trimRawOutput } from "./pty-log.js";
import {
	DefaultTmuxRunner,
	TmuxError,
	buildCapturePaneArgs,
	buildDisplayMessageArgs,
	buildKillPaneArgs,
	buildResizePaneArgs,
	buildSelectPaneArgs,
	buildSendKeysLiteralArgs,
	buildSendKeysNamedArgs,
	buildSplitWindowArgs,
	isInsideTmux,
	type TmuxRunner,
} from "./tmux-cli.js";

/**
 * PtyPaneSession — pull / capture-pane polling implementation.
 *
 * Strategy: spawn a sibling tmux pane via `split-window`, then on a timer
 * call `tmux capture-pane -p -e -J -S - -E -` to snapshot the pane content
 * (with ANSI escapes, full history). Each snapshot's text is compared to
 * the previous: appended bytes are treated as "new pane output" and fed
 * into `@xterm/headless` exactly like `pty-session.ts` feeds raw PTY data.
 *
 * Why keep xterm-headless: see docs/pane-mode-bakeoff.md ADR. The buffer
 * abstraction is the seam every consumer (monitor, dispatch, session-query)
 * already understands, so re-feeding diffed bytes preserves it 1:1.
 *
 * What is NOT mirrored:
 *  - DSR (cursor-position) protocol: tmux owns the pane's PTY and answers
 *    DSR queries itself. We never see them.
 *  - Scroll math: the user scrolls the real tmux pane natively. Our local
 *    scroll getters/setters are still implemented because the contract
 *    requires them, but they only affect our shadow buffer.
 *  - PTY-level resize: `resize` adjusts our xterm dimensions; tmux already
 *    sized the pane via `split-window` and a resize-pane request is sent
 *    only as a best-effort cosmetic call.
 */

const Terminal = xterm.Terminal;

const OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const APC_REGEX = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ESC_SINGLE_REGEX = /\x1b[@-_]/g;
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;

function sanitizeLine(line: string): string {
	let out = line;
	if (out.includes("")) {
		out = out.replace(OSC_REGEX, "");
		out = out.replace(APC_REGEX, "");
		out = out.replace(DCS_REGEX, "");
		out = out.replace(CSI_REGEX, (match) => (match.endsWith("m") ? match : ""));
		out = out.replace(ESC_SINGLE_REGEX, "");
	}
	if (out.includes("\t")) {
		out = out.replace(/\t/g, "   ");
	}
	if (out.includes("\r")) {
		out = out.replace(/\r/g, "");
	}
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
	return `[${parts.join(";")}m`;
}

function normalizePaletteColor(mode: "default" | "palette" | "rgb", value: number): { mode: "default" | "palette" | "rgb"; value: number } {
	if (mode !== "palette") return { mode, value };
	if (value < 0 || value > 255) {
		return { mode: "default", value: 0 };
	}
	return { mode: "palette", value };
}

export interface PaneOptions {
	layout: "right" | "left" | "below" | "above";
	sizePercent: number;
	title?: string;
	select?: boolean;
}

export interface PtyPaneSessionOptions {
	command: string;
	shell?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	cols?: number;
	rows?: number;
	scrollback?: number;
	ansiReemit?: boolean;
	pane: PaneOptions;
	pollIntervalMs?: number;
	tmuxRunner?: TmuxRunner;
	envSnapshot?: Record<string, string | undefined>;
}

export interface PtySessionEvents {
	onData?: (data: string) => void;
	onExit?: (exitCode: number, signal?: number) => void;
}

export class PtyPaneSession {
	private runner: TmuxRunner;
	private xterm: XtermTerminal;
	private serializer: SerializeAddon | null = null;
	private _exited = false;
	private _exitCode: number | null = null;
	private _signal: number | undefined;
	private _paneId = "";
	private _pid = 0;
	private scrollOffset = 0;
	private followBottom = true;

	private rawOutput = "";
	private lastStreamPosition = 0;

	private dataHandler: ((data: string) => void) | undefined;
	private exitHandler: ((exitCode: number, signal?: number) => void) | undefined;
	private additionalDataListeners: Array<(data: string) => void> = [];
	private additionalExitListeners: Array<(exitCode: number, signal?: number) => void> = [];

	private prevCapture = "";
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private pollIntervalMs: number;
	private pollInFlight = false;
	private disposed = false;

	constructor(options: PtyPaneSessionOptions, events: PtySessionEvents = {}) {
		const env = options.envSnapshot ?? processEnv();
		if (!isInsideTmux(env)) {
			throw new Error(
				"render: \"pane\" requires running pi inside a tmux session. Either start tmux or use render: \"overlay\".",
			);
		}

		this.runner = options.tmuxRunner ?? new DefaultTmuxRunner();
		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;
		this.pollIntervalMs = clampPollInterval(options.pollIntervalMs);

		const cols = options.cols ?? 80;
		const rows = options.rows ?? 24;
		const scrollback = options.scrollback ?? 5000;
		const ansiReemit = options.ansiReemit ?? true;

		this.xterm = new Terminal({ cols, rows, scrollback, allowProposedApi: true, convertEol: true });
		if (ansiReemit) {
			this.serializer = new SerializeAddon();
			this.xterm.loadAddon(this.serializer);
		}

		const shell =
			options.shell ??
			(processPlatform() === "win32"
				? env.COMSPEC || "cmd.exe"
				: env.SHELL || "/bin/sh");

		const splitEnv: Record<string, string> = {};
		const baseEnv = options.env ?? {};
		for (const [k, v] of Object.entries(baseEnv)) {
			if (typeof v === "string") splitEnv[k] = v;
		}
		if (!splitEnv.TERM) splitEnv.TERM = "xterm-256color";

		const splitArgs = buildSplitWindowArgs({
			layout: options.pane.layout,
			sizePercent: options.pane.sizePercent,
			cwd: options.cwd,
			env: splitEnv,
			shell,
			command: options.command,
		});

		const splitResult = this.runner.runTmux(splitArgs);
		this._paneId = splitResult.stdout.trim();
		if (!this._paneId) {
			throw new Error("tmux split-window did not return a pane id");
		}

		this.enableRemainOnExit();
		this.applyPaneMetadata(options.pane);
		this.captureInitialPid();
		this.startPolling();
	}

	/**
	 * `remain-on-exit on` keeps the pane alive after its process exits,
	 * so our final poll tick can still capture the full buffer and read
	 * the real exit status via `#{pane_dead_status}`. Without it, the
	 * fast-finishing fixtures finish and tmux reaps the pane between
	 * polls — we would only ever observe partial output. The pane is
	 * explicitly destroyed by `dispose()` / `kill()`.
	 */
	private enableRemainOnExit(): void {
		try {
			this.runner.runTmux(
				["set-option", "-p", "-t", this._paneId, "remain-on-exit", "on"],
				{ allowNonZeroExit: true },
			);
		} catch {
			// Older tmux may not support pane-scoped set-option; we still
			// poll correctly, just with the race window the bake-off doc
			// records as a known limitation.
		}
	}

	private applyPaneMetadata(pane: PaneOptions): void {
		try {
			const args = buildSelectPaneArgs(this._paneId, { title: pane.title });
			if (pane.title !== undefined) {
				this.runner.runTmux(args, { allowNonZeroExit: true });
			}
			if (pane.select) {
				this.runner.runTmux(["select-pane", "-t", this._paneId], { allowNonZeroExit: true });
			}
		} catch {
			// Metadata is cosmetic; never fail construction over a title.
		}
	}

	private captureInitialPid(): void {
		try {
			const result = this.runner.runTmux(
				buildDisplayMessageArgs(this._paneId, "#{pane_pid}"),
				{ allowNonZeroExit: true },
			);
			const pid = Number.parseInt(result.stdout.trim(), 10);
			if (Number.isFinite(pid) && pid > 0) {
				this._pid = pid;
			}
		} catch {
			// Pid is informational; pane already has process running.
		}
	}

	private startPolling(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			this.tick();
		}, this.pollIntervalMs);
		// Fire one immediate tick so listeners do not have to wait for the
		// first interval before any output appears.
		queueMicrotask(() => this.tick());
	}

	private stopPolling(): void {
		if (!this.pollTimer) return;
		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	private tick(): void {
		if (this.disposed || this._exited) return;
		if (this.pollInFlight) return;
		this.pollInFlight = true;
		try {
			const result = this.runner.runTmux(
				buildCapturePaneArgs(this._paneId),
				{ allowNonZeroExit: true },
			);
			if (result.exitCode !== 0) {
				// Pane no longer exists at all — externally killed or the
				// remain-on-exit option was not honoured.
				this.handlePaneGone(0, undefined);
				return;
			}
			const captured = stripTrailingNewlines(result.stdout);
			this.diffAndEmit(captured);

			// Then ask tmux whether the pane's process has exited. With
			// remain-on-exit on, the pane is still capturable but flagged
			// dead; this is where we read the real exit status.
			const status = this.queryDeadStatus();
			if (status.dead) {
				this.handlePaneGone(status.exitCode, status.signal);
			}
		} catch (err) {
			if (err instanceof TmuxError) {
				this.handlePaneGone(0, undefined);
				return;
			}
			console.error("PtyPaneSession: poll tick error:", err);
		} finally {
			this.pollInFlight = false;
		}
	}

	private queryDeadStatus(): { dead: boolean; exitCode: number | null; signal: number | undefined } {
		try {
			const result = this.runner.runTmux(
				buildDisplayMessageArgs(this._paneId, "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"),
				{ allowNonZeroExit: true },
			);
			if (result.exitCode !== 0) return { dead: true, exitCode: 0, signal: undefined };
			const [deadStr, statusStr, signalStr] = result.stdout.trim().split("|");
			if (deadStr !== "1") return { dead: false, exitCode: null, signal: undefined };
			const exitCode = Number.parseInt(statusStr ?? "", 10);
			const signal = Number.parseInt(signalStr ?? "", 10);
			return {
				dead: true,
				exitCode: Number.isFinite(exitCode) ? exitCode : 0,
				signal: Number.isFinite(signal) && signal > 0 ? signal : undefined,
			};
		} catch {
			return { dead: false, exitCode: null, signal: undefined };
		}
	}

	/**
	 * Snapshot subtraction: when the new capture extends the old one (same
	 * prefix), the suffix is "new bytes". When the prefix diverges (the
	 * pane scrolled past its own history limit, or content shifted), we
	 * fall back to treating the entire new capture as a fresh write —
	 * losing some incremental fidelity but never double-counting.
	 *
	 * The capture-pane output is line-oriented and always re-emits the
	 * full visible history because we pass `-S - -E -`. In practice, the
	 * "extends" case dominates outside pathological scrollback wraparound.
	 */
	private diffAndEmit(current: string): void {
		if (current === this.prevCapture) return;
		let chunk: string;
		if (current.startsWith(this.prevCapture)) {
			chunk = current.slice(this.prevCapture.length);
		} else {
			// Prefix changed — the pane's recorded history rolled. Replay the
			// full snapshot. Note: this is rare in normal use (scrollback is
			// typically large) and is the safe choice over best-effort prefix
			// detection that could double-count.
			chunk = current;
		}
		this.prevCapture = current;

		if (!chunk) return;

		// Insert a newline between snapshots so consumers see line-oriented
		// chunks: capture-pane joins wrapped lines but does not append a
		// trailing newline, and successive snapshots therefore concatenate
		// the last line of N with the first line of N+1.
		const normalized = ensureLeadingSeparator(this.rawOutput, chunk);

		this.rawOutput += normalized;
		const trimmed = trimRawOutput(this.rawOutput, this.lastStreamPosition);
		this.rawOutput = trimmed.rawOutput;
		this.lastStreamPosition = trimmed.lastStreamPosition;

		this.xterm.write(normalized);
		this.notifyDataListeners(normalized);
	}

	private handlePaneGone(exitCode: number | null, signal: number | undefined): void {
		if (this._exited || this.disposed) return;
		this._exited = true;
		this._exitCode = exitCode;
		this._signal = signal;
		this.stopPolling();
		const exitMsg = `\n[Process exited with code ${exitCode ?? 0}${signal ? ` (signal: ${signal})` : ""}]\n`;
		this.rawOutput += exitMsg;
		try {
			this.xterm.write(exitMsg);
		} catch {
			// Buffer may be disposed if dispose() raced; ignore.
		}
		this.notifyExitListeners(exitCode ?? 0, signal);
	}

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

	get exited(): boolean { return this._exited; }
	get exitCode(): number | null { return this._exitCode; }
	get signal(): number | undefined { return this._signal; }
	get pid(): number { return this._pid; }
	get cols(): number { return this.xterm.cols; }
	get rows(): number { return this.xterm.rows; }
	get paneId(): string { return this._paneId; }

	/**
	 * Send input to the pane.
	 *
	 * Pane mode receives input through `tmux send-keys`, not a raw fd. The
	 * agent already passed the bytes through `key-encoding.ts.translateInput`
	 * upstream, so by the time we get here `data` is the literal byte
	 * sequence the user wants to land in the pane's stdin. We therefore
	 * always send via `-l --` (literal mode) — bracketed-paste markers,
	 * arrow-key escape sequences, and plain text are all opaque bytes from
	 * tmux's perspective and propagate correctly.
	 */
	write(data: string): void {
		if (this._exited || this.disposed) return;
		if (data.length === 0) return;
		try {
			this.runner.runTmux(buildSendKeysLiteralArgs(this._paneId, data), { allowNonZeroExit: true });
		} catch (err) {
			if (err instanceof TmuxError) {
				this.handlePaneGone(0, undefined);
				return;
			}
			throw err;
		}
	}

	/**
	 * Optional escape hatch for sending tmux key names (e.g. "C-c", "Enter")
	 * directly without the literal flag. Not part of the PtyTerminalSession
	 * contract — provided for callers that have not been routed through
	 * key-encoding.ts.
	 */
	writeKeys(keys: string[]): void {
		if (this._exited || this.disposed) return;
		if (keys.length === 0) return;
		try {
			this.runner.runTmux(buildSendKeysNamedArgs(this._paneId, keys), { allowNonZeroExit: true });
		} catch (err) {
			if (err instanceof TmuxError) {
				this.handlePaneGone(0, undefined);
				return;
			}
			throw err;
		}
	}

	resize(cols: number, rows: number): void {
		if (cols === this.xterm.cols && rows === this.xterm.rows) return;
		if (cols < 1 || rows < 1) return;
		this.xterm.resize(cols, rows);
		if (this._exited || this.disposed) return;
		try {
			this.runner.runTmux(buildResizePaneArgs(this._paneId, cols, rows), { allowNonZeroExit: true });
		} catch {
			// Best-effort. tmux may refuse a resize for layout reasons; the
			// shadow buffer dimensions still reflect what callers requested.
		}
	}

	private renderLineFromCells(lineIndex: number, cols: number): string {
		const buffer = this.xterm.buffer.active;
		const line = buffer.getLine(lineIndex);

		let currentStyle: CellStyle = {
			bold: false, dim: false, italic: false, underline: false,
			inverse: false, invisible: false, strikethrough: false,
			fgMode: "default", fg: 0, bgMode: "default", bg: 0,
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
				fgMode: fg.mode, fg: fg.value, bgMode: bg.mode, bg: bg.value,
			};
			const nextKey = styleKey(nextStyle);
			if (nextKey !== currentKey) {
				currentStyle = nextStyle;
				currentKey = nextKey;
				out += sgrForStyle(currentStyle);
			}
			out += cellChars;
		}
		return out + "[0m";
	}

	getViewportLines(options: { ansi?: boolean } = {}): string[] {
		const buffer = this.xterm.buffer.active;
		const lines: string[] = [];

		const totalLines = buffer.length;
		if (this.followBottom) {
			this.scrollOffset = 0;
		}
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
					lines.push(sanitizeLine(plain) + "[0m");
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

		if (requested === 0) {
			return { lines: [], totalLinesInBuffer, truncatedByChars: false };
		}

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
					const line = sanitizeLine(raw) + "[0m";
					if (remainingChars !== undefined) {
						if (remainingChars <= 0) {
							truncatedByChars = true;
							break;
						}
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
				if (remainingChars <= 0) {
					truncatedByChars = true;
					break;
				}
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
		if (this.scrollOffset === 0) {
			this.followBottom = true;
		}
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
		this.followBottom = true;
	}

	isScrolledUp(): boolean {
		return this.scrollOffset > 0;
	}

	/**
	 * Kill the pane. `signal` is accepted for parity with PtyTerminalSession
	 * but tmux's kill-pane reaps the pane process unconditionally — we have
	 * no PTY fd over which to direct an arbitrary signal.
	 */
	kill(_signal: string = "SIGTERM"): void {
		void _signal;
		if (this._exited) return;
		try {
			this.runner.runTmux(buildKillPaneArgs(this._paneId), { allowNonZeroExit: true });
		} catch {
			// Pane may already be gone; the next poll tick will detect that.
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopPolling();
		this.kill();
		try {
			this.xterm.dispose();
		} catch {
			// Ignore disposal errors during teardown.
		}
	}
}

function clampPollInterval(ms: number | undefined): number {
	if (ms === undefined || !Number.isFinite(ms)) return 100;
	return Math.max(20, Math.min(2000, Math.trunc(ms)));
}

function stripTrailingNewlines(text: string): string {
	let end = text.length;
	while (end > 0 && (text.charCodeAt(end - 1) === 10 || text.charCodeAt(end - 1) === 13)) {
		end--;
	}
	return text.slice(0, end);
}

function ensureLeadingSeparator(existing: string, chunk: string): string {
	if (chunk.length === 0) return chunk;
	if (existing.length === 0) return chunk;
	if (chunk.startsWith("\n") || chunk.startsWith("\r")) return chunk;
	const lastChar = existing.charCodeAt(existing.length - 1);
	if (lastChar === 10 || lastChar === 13) return chunk;
	return `\n${chunk}`;
}

function processEnv(): NodeJS.ProcessEnv {
	return process.env;
}

function processPlatform(): NodeJS.Platform {
	return process.platform;
}
