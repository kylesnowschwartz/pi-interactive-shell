/**
 * Pinned-widget render mode for `pi-interactive-shell`.
 *
 * Renders a running session's recent output as a persistent widget above the
 * pi editor (via `ctx.ui.setWidget`). Pi chat stays fully interactive while
 * the agent runs; the widget is view-only.
 *
 * Pop-out interaction with the agent uses the existing `focusShortcut`
 * (default `Alt+Shift+F`), which opens the standard `InteractiveShellOverlay`
 * exactly as it does for `render: "overlay"` sessions. While the overlay is
 * focused, the widget hides itself; on overlay close, the widget re-renders.
 *
 * Sizing: auto-sized to the actual content height, capped at 50% of the
 * terminal rows. A hard floor of MIN_HEIGHT lines keeps the widget visible
 * even when the agent has emitted very little so far.
 */
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { PtyTerminalSession } from "./pty-session.js";
import { formatDuration } from "./types.js";

interface SetWidgetCapableUI {
	setWidget: (
		name: string,
		content:
			| string[]
			| ((tui: any, theme: any) => { render: (width: number) => string[]; invalidate: () => void })
			| undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	) => void;
}

export interface PinnedWidgetOptions {
	/** Session record providing PtyTerminalSession + identity + lifecycle */
	sessionId: string;
	command: string;
	startedAt: Date;
	session: PtyTerminalSession;
	/** Pi UI surface */
	ctx: { ui: SetWidgetCapableUI; hasUI?: boolean };
	/** Override the cap (fraction of terminal rows). Default 0.5. */
	heightCap?: number;
	/** Minimum widget height in rows. Default 5. */
	minHeight?: number;
	/** Maximum widget height in rows (absolute floor on the cap). Default no limit. */
	maxHeight?: number;
}

export interface PinnedWidgetHandle {
	/** Hide the widget without disposing it (e.g. while the overlay is open). */
	setHidden(hidden: boolean): void;
	/** Mark the session as exited; widget stays visible but updates its header. */
	markExited(exitCode: number | null): void;
	/** Permanently remove the widget. */
	dispose(): void;
}

const DEFAULT_HEIGHT_CAP = 0.5;
const DEFAULT_MIN_HEIGHT = 5;
/**
 * Re-render debounce: agents emit dozens of bytes per data event, so coalescing
 * to one render per N ms keeps the TUI responsive without dropping content
 * (the next render reads the buffer's current state, which already includes
 * whatever bytes arrived during the debounce window).
 */
const RENDER_DEBOUNCE_MS = 60;

export function setupPinnedWidget(options: PinnedWidgetOptions): PinnedWidgetHandle | null {
	if (!options.ctx.hasUI) return null;

	const widgetName = `pinned-shell:${options.sessionId}`;
	const heightCap = options.heightCap ?? DEFAULT_HEIGHT_CAP;
	const minHeight = options.minHeight ?? DEFAULT_MIN_HEIGHT;
	const maxHeight = options.maxHeight;

	let hidden = false;
	let disposed = false;
	let exitedAt: Date | undefined;
	let exitCode: number | null = null;

	let tuiRef: { requestRender: () => void; terminal?: { rows?: number; columns?: number } } | null = null;
	let renderTimer: ReturnType<typeof setTimeout> | null = null;
	let durationTimer: ReturnType<typeof setInterval> | null = null;

	const requestRender = () => {
		if (disposed || hidden) return;
		if (renderTimer) return;
		renderTimer = setTimeout(() => {
			renderTimer = null;
			tuiRef?.requestRender();
		}, RENDER_DEBOUNCE_MS);
	};

	// Listen to session output → trigger debounced re-render.
	const removeDataListener = options.session.addDataListener(() => requestRender());

	// Refresh the duration in the header every 10s while the session is
	// running (mirrors background-widget.ts's pattern).
	durationTimer = setInterval(() => {
		if (disposed || hidden || exitedAt) return;
		tuiRef?.requestRender();
	}, 10_000);

	options.ctx.ui.setWidget(
		widgetName,
		(tui: any, theme: any) => {
			tuiRef = tui;
			return {
				render: (width: number): string[] => {
					if (hidden || disposed) return [];

					const rows = tuiRef?.terminal?.rows ?? 24;
					const capByRows = Math.max(minHeight, Math.floor(rows * heightCap));
					const cap = maxHeight !== undefined ? Math.min(capByRows, maxHeight) : capByRows;

					// Reserve 2 rows: header line + separator. Tail has the rest.
					const tailLines = Math.max(1, cap - 2);

					const tail = options.session.getTailLines({ lines: tailLines, ansi: true });
					const tailContent = tail.lines;

					return [renderHeader(width, theme), renderSeparator(width, theme), ...tailContent.map((line) => clipLine(line, width))];
				},
				invalidate: () => {},
			};
		},
		{ placement: "aboveEditor" },
	);

	function renderHeader(width: number, theme: any): string {
		const status = exitedAt
			? exitCode === 0
				? theme.fg("success", "● exited 0")
				: theme.fg("warning", `● exited ${exitCode ?? "?"}`)
			: theme.fg("accent", "▶ running");
		const elapsed = exitedAt
			? Date.now() - options.startedAt.getTime()
			: Date.now() - options.startedAt.getTime();
		const duration = theme.fg("dim", formatDuration(elapsed));
		const cmd = theme.fg("dim", oneLineCommand(options.command));
		const id = theme.fg("dim", options.sessionId);
		const hint = theme.fg("dim", "(focusShortcut to interact)");
		const left = ` ${status} ${id} ${duration} `;
		const right = ` ${hint} `;
		const middle = cmd;
		const leftW = visibleWidth(left);
		const rightW = visibleWidth(right);
		const middleAvailable = Math.max(0, width - leftW - rightW);
		const truncatedMiddle = truncateToWidth(middle, middleAvailable, "…");
		const padBetween = Math.max(0, middleAvailable - visibleWidth(truncatedMiddle));
		return left + truncatedMiddle + " ".repeat(padBetween) + right;
	}

	function renderSeparator(width: number, theme: any): string {
		return theme.fg("dim", "⎯".repeat(Math.max(0, width)));
	}

	function oneLineCommand(cmd: string): string {
		return cmd.replace(/\s+/g, " ").trim();
	}

	function clipLine(line: string, width: number): string {
		// `getTailLines({ ansi: true })` returns each line ending with a reset
		// already; truncating with truncateToWidth respects ANSI sequences.
		return truncateToWidth(line, width);
	}

	const handle: PinnedWidgetHandle = {
		setHidden(value: boolean) {
			if (disposed) return;
			if (hidden === value) return;
			hidden = value;
			if (hidden) {
				if (renderTimer) {
					clearTimeout(renderTimer);
					renderTimer = null;
				}
				// Force a render so the widget hides immediately rather than
				// waiting for the next data event.
				tuiRef?.requestRender();
			} else {
				tuiRef?.requestRender();
			}
		},
		markExited(code: number | null) {
			if (disposed) return;
			// First-call-wins. Subsequent calls (e.g. from a redundant exit
			// listener) are no-ops so the recorded exit code remains stable.
			if (exitedAt) return;
			exitedAt = new Date();
			exitCode = code;
			if (durationTimer) {
				clearInterval(durationTimer);
				durationTimer = null;
			}
			tuiRef?.requestRender();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (renderTimer) {
				clearTimeout(renderTimer);
				renderTimer = null;
			}
			if (durationTimer) {
				clearInterval(durationTimer);
				durationTimer = null;
			}
			removeDataListener();
			options.ctx.ui.setWidget(widgetName, undefined);
			tuiRef = null;
		},
	};

	return handle;
}
