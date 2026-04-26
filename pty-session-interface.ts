/**
 * Shared contract that every PTY-backed session implementation satisfies.
 *
 * Two implementations exist today:
 *   - `PtyTerminalSession` (`pty-session.ts`): runs the target process via
 *     `node-pty` and renders into a local `@xterm/headless` buffer that the
 *     overlay or reattach UI can paint.
 *   - `PtyPaneSession` (`pty-pane-session.ts`): runs the target process inside
 *     a sibling tmux pane the user can see directly. The byte stream comes
 *     from `tmux pipe-pane` via a child-process fifo reader; viewport queries
 *     hit `tmux capture-pane` on demand.
 *
 * Both classes carry private fields, so they are not structurally assignable
 * to each other. Consumers that hold a session reference (session-manager,
 * headless-monitor, session-query, reattach-overlay, dispatch sites in
 * index.ts) must type the reference as `PtySession` — not as a concrete
 * class — so the dispatcher can hand back either implementation depending
 * on `render: "terminal" | "pane"`.
 *
 * Construction sites stay concrete: the overlay-component and the dispatch
 * paths in `index.ts` decide which constructor to call based on render mode,
 * and the resulting instance is then narrowed to `PtySession` for downstream
 * consumers.
 *
 * Methods that only make sense for the local-overlay rendering case
 * (`scrollUp`/`scrollDown`/`scrollToBottom`/`isScrolledUp`) are still part of
 * the interface — pane implementations no-op them, since the user scrolls in
 * the visible tmux pane via tmux's own copy-mode bindings rather than via
 * the overlay.
 */
export interface PtySessionEventsShape {
	onData?: (data: string) => void;
	onExit?: (exitCode: number, signal?: number) => void;
}

export interface ViewportLinesOptions {
	ansi?: boolean;
}

export interface TailLinesOptions {
	lines: number;
	ansi?: boolean;
	maxChars?: number;
}

export interface TailLinesResult {
	lines: string[];
	totalLinesInBuffer: number;
	truncatedByChars: boolean;
}

export interface RawStreamOptions {
	/** If true, only return output since the last call. */
	sinceLast?: boolean;
	/** If true, strip ANSI escape codes (default: true). */
	stripAnsi?: boolean;
}

export interface LogSliceOptions {
	offset?: number;
	limit?: number;
	stripAnsi?: boolean;
}

export interface LogSliceResult {
	slice: string;
	totalLines: number;
	totalChars: number;
	sliceLineCount: number;
}

export interface PtySession {
	/**
	 * Discriminator for runtime narrowing.
	 *
	 * `"terminal"` — PtyTerminalSession, runs inside a local @xterm/headless
	 *   buffer; safe for InteractiveShellOverlay/ReattachOverlay (which call
	 *   `resize()` on the underlying xterm and offer scroll controls against
	 *   the headless buffer).
	 *
	 * `"pane"` — PtyPaneSession, runs inside a sibling tmux pane; calling
	 *   `resize()` mutates the user's actual tmux layout, scroll methods are
	 *   no-ops, and post-exit viewport queries are unavailable. The overlay
	 *   and reattach paths refuse pane sessions until they grow pane-aware UI.
	 *   Codex review R3-B2.
	 */
	readonly kind: "terminal" | "pane";

	// Lifecycle state -------------------------------------------------------
	readonly exited: boolean;
	readonly exitCode: number | null;
	readonly signal: number | undefined;
	readonly pid: number;
	readonly cols: number;
	readonly rows: number;

	// Event wiring ----------------------------------------------------------
	setEventHandlers(events: PtySessionEventsShape): void;
	addDataListener(cb: (data: string) => void): () => void;
	addExitListener(cb: (exitCode: number, signal?: number) => void): () => void;

	// Input + sizing --------------------------------------------------------
	write(data: string): void;
	resize(cols: number, rows: number): void;

	// Output queries --------------------------------------------------------
	getViewportLines(options?: ViewportLinesOptions): string[];
	getTailLines(options: TailLinesOptions): TailLinesResult;
	getRawStream(options?: RawStreamOptions): string;
	getLogSlice(options?: LogSliceOptions): LogSliceResult;

	// Overlay scroll (no-op for pane sessions) ------------------------------
	scrollUp(lines: number): void;
	scrollDown(lines: number): void;
	scrollToBottom(): void;
	isScrolledUp(): boolean;

	// Termination -----------------------------------------------------------
	kill(signal?: string): void;
	dispose(): void;
}
