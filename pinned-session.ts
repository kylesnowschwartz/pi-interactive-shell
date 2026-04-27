/**
 * Lifecycle owner for `render: "pinned"` interactive_shell sessions.
 *
 * Pinned mode runs an agent in a regular `PtyTerminalSession` (same as overlay
 * and dispatch flows) but renders its recent output as a persistent widget
 * above the pi chat editor instead of opening a modal overlay. The agent
 * gets control back immediately after spawn; the user can pop out into the
 * standard `InteractiveShellOverlay` via the configured focus shortcut.
 *
 * This module consolidates everything that used to live in three places:
 *   1. an inline "register active session" helper in index.ts
 *   2. the spawn block inside `startNewSession` (creating PtyTerminalSession,
 *      calling sessionManager.add, wiring the widget)
 *   3. an exit-listener that markExited'd the widget and scheduled cleanup
 *
 * Centralizing the lifecycle here means there's exactly ONE place that
 * decides:
 *   - what `ActiveSession.kill` does (just kill the process; cleanup runs in
 *     the exit listener),
 *   - when widgets transition to the exited state,
 *   - when the session record is scheduled for removal from
 *     `sessionManager`.
 *
 * Cleanup model:
 *   - Both kill and natural exit fire the same exit listener. Exit listener
 *     calls `widget.markExited(code)`, unregisters from the active pool, and
 *     schedules a `PINNED_RETENTION_MS` cleanup via `sessionManager.scheduleCleanup`.
 *   - When the cleanup timer fires (or `dismissBackground` runs sooner), the
 *     session is removed from the manager, `notifyChange()` fires, and the
 *     extension-level onChange handler in index.ts disposes the widget map
 *     entry. Result: the widget shows the final "exited" state for ~5 min
 *     and then auto-dismisses.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { InteractiveShellConfig } from "./config.js";
import { setupPinnedWidget, type PinnedWidgetHandle } from "./pinned-widget.js";
import { PtyTerminalSession } from "./pty-session.js";
import { generateSessionId, sessionManager } from "./session-manager.js";
import { createSessionQueryState, getSessionOutput } from "./session-query.js";

/**
 * How long a pinned session and its widget remain visible after exit/kill
 * before auto-dismissal. Matches the retention window the headless dispatch
 * flow uses for completed sessions, so users see consistent timing.
 */
export const PINNED_RETENTION_MS = 5 * 60 * 1000;

/** PTY dimensions used for pinned sessions. Matches overlay/dispatch defaults. */
const PINNED_PTY_COLS = 120;
const PINNED_PTY_ROWS = 40;

export interface SpawnPinnedSessionOptions {
	command: string;
	cwd: string;
	name?: string;
	reason?: string;
	config: InteractiveShellConfig;
	/** Pi UI surface. `hasUI` toggles whether the widget actually renders. */
	ctx: { ui: ExtensionContext["ui"]; hasUI?: boolean };
}

export interface PinnedSessionHandle {
	id: string;
	session: PtyTerminalSession;
	/** null if `ctx.hasUI === false`. Caller still gets back a usable handle. */
	widget: PinnedWidgetHandle | null;
}

/**
 * Spawn a pinned session: PtyTerminalSession + sessionManager registration +
 * pinned widget + exit/kill lifecycle. Returns the handle so the caller can
 * track the widget or surface the id.
 *
 * The caller is responsible for tracking the widget handle (e.g. in a
 * `Map<id, PinnedWidgetHandle>`) so that `popoutMostRecentPinnedSession`
 * and the session-removed onChange hook can find and hide/dispose it.
 */
export function spawnPinnedSession(opts: SpawnPinnedSessionOptions): PinnedSessionHandle {
	const id = generateSessionId(opts.name);
	const session = new PtyTerminalSession({
		command: opts.command,
		cwd: opts.cwd,
		cols: PINNED_PTY_COLS,
		rows: PINNED_PTY_ROWS,
		scrollback: opts.config.scrollbackLines,
	});
	const startTime = Date.now();

	// `noAutoCleanup: true` keeps the session in the manager after natural
	// exit so the widget can show its final state. We schedule cleanup
	// explicitly from the exit listener below.
	sessionManager.add(opts.command, session, opts.name, opts.reason, {
		id,
		noAutoCleanup: true,
		startedAt: new Date(startTime),
	});

	registerPinnedActiveSession(id, opts.command, opts.reason, session, startTime, opts.config);

	const widget = setupPinnedWidget({
		sessionId: id,
		command: opts.command,
		startedAt: new Date(startTime),
		session,
		ctx: { ui: opts.ctx.ui as any, hasUI: opts.ctx.hasUI },
	});

	// Exit listener handles BOTH natural exit and tool-driven kill (kill →
	// SIGTERM → process exits → this listener fires). Single source of
	// truth for "what happens when the session ends".
	//
	// `addExitListener` is ADDITIVE (returns an unsubscriber) and survives
	// the overlay's `setEventHandlers({})` calls during popout. So our
	// cleanup keeps working even if the user pops out and back during the
	// session's life.
	session.addExitListener((code) => {
		widget?.markExited(code ?? null);
		sessionManager.unregisterActive(id, true);
		sessionManager.scheduleCleanup(id, PINNED_RETENTION_MS);
	});

	return { id, session, widget };
}

/**
 * Register the session in `sessionManager`'s active pool so the agent's
 * tool surface (`interactive_shell({ sessionId, kill, ... })`) can resolve
 * it. Without this, query/kill from the agent returns "Session not found".
 *
 * Pinned sessions don't have a HeadlessDispatchMonitor (they run as a
 * widget, not a dispatched headless run), so the kill callback just kills
 * the process. The exit listener registered in `spawnPinnedSession` does
 * the rest of the cleanup. Crucially, this kill callback does NOT call
 * `sessionManager.remove(id)` — doing so would dispose the
 * PtyTerminalSession synchronously and cause the widget to vanish on kill
 * (asymmetric with natural exit, where the session lingers).
 */
function registerPinnedActiveSession(
	id: string,
	command: string,
	reason: string | undefined,
	session: PtyTerminalSession,
	startTime: number,
	config: InteractiveShellConfig,
): void {
	const queryState = createSessionQueryState();
	sessionManager.registerActive({
		id,
		command,
		reason,
		write: (data) => session.write(data),
		kill: () => {
			// Just kill the process. The exit listener registered in
			// spawnPinnedSession will mark the widget exited, unregister
			// from the active pool, and schedule cleanup.
			session.kill();
		},
		background: () => {},
		getOutput: (opts) => getSessionOutput(session, config, queryState, opts, undefined),
		getStatus: () => (session.exited ? "exited" : "running"),
		getRuntime: () => Date.now() - startTime,
		getResult: () => undefined,
		onComplete: (cb) => {
			// No monitor; signal completion when the session exits. Pi reads
			// `getResult()` afterward — we return undefined since pinned
			// sessions don't track structured results.
			session.addExitListener(() => cb());
		},
	});
}
