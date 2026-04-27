import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractiveShellConfig } from "../config.js";

const config: InteractiveShellConfig = {
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	focusShortcut: "ctrl+]",
	spawn: {
		defaultAgent: "pi",
		shortcut: "alt+shift+p",
		commands: { pi: "pi", codex: "codex", claude: "claude", cursor: "agent" },
		defaultArgs: { pi: [], codex: [], claude: [], cursor: [] },
		worktree: false,
		worktreeBaseDir: undefined,
	},
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
	transferLines: 200,
	transferMaxChars: 20000,
	completionNotifyLines: 50,
	completionNotifyMaxChars: 5000,
	handsFreeUpdateMode: "on-quiet",
	handsFreeUpdateInterval: 60000,
	handsFreeQuietThreshold: 8000,
	autoExitGracePeriod: 15000,
	handsFreeUpdateMaxChars: 1500,
	handsFreeMaxTotalChars: 100000,
	minQueryIntervalSeconds: 60,
};

const FOCUS_KEY = "FOCUS_DATA";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function createExistingSession(opts: { exited?: boolean } = {}) {
	let handlers: { onData?: (data: string) => void; onExit?: () => void } = {};
	return {
		pid: 4242,
		rows: 20,
		exited: opts.exited ?? false,
		exitCode: 0,
		signal: undefined,
		setEventHandlers(next: typeof handlers) {
			handlers = next;
		},
		resize: vi.fn(),
		scrollToBottom: vi.fn(),
		getViewportLines: vi.fn(() => ["echo hello"]),
		isScrolledUp: vi.fn(() => false),
		write: vi.fn(),
		scrollUp: vi.fn(),
		scrollDown: vi.fn(),
		getRawStream: vi.fn(() => ""),
		kill: vi.fn(),
		dispose: vi.fn(),
		getTailLines: vi.fn(() => ({ lines: [], totalLinesInBuffer: 0, truncatedByChars: false })),
	};
}

async function loadOverlay() {
	vi.resetModules();
	vi.doMock("@mariozechner/pi-tui", () => ({
		// matchesKey returns true only when the data is FOCUS_KEY and the
		// requested key is the configured focus shortcut. Lets us drive the
		// shortcut path deterministically without simulating real keystrokes.
		matchesKey: (data: string, key: string) => data === FOCUS_KEY && key === config.focusShortcut,
		truncateToWidth: (value: string, width: number) => value.length > width ? value.slice(0, width) : value,
		visibleWidth: (value: string) => stripAnsi(value).length,
	}));
	vi.doMock("../pty-session.js", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {},
	}));
	vi.doMock("../session-manager.js", () => ({
		sessionManager: {
			registerActive: vi.fn(),
			unregisterActive: vi.fn(),
			add: vi.fn(() => "bg-1"),
		},
		generateSessionId: vi.fn(() => "session-1"),
	}));
	vi.doMock("../handoff-utils.js", () => ({
		captureCompletionOutput: vi.fn(() => undefined),
		captureTransferOutput: vi.fn(() => undefined),
		maybeBuildHandoffPreview: vi.fn(() => undefined),
		maybeWriteHandoffSnapshot: vi.fn(() => undefined),
	}));
	vi.doMock("../session-query.js", () => ({
		createSessionQueryState: vi.fn(() => ({})),
		getSessionOutput: vi.fn(() => ({ output: "", truncated: false, totalBytes: 0 })),
	}));
	return import("../overlay-component.js");
}

afterEach(() => {
	vi.doUnmock("@mariozechner/pi-tui");
	vi.doUnmock("../pty-session.js");
	vi.doUnmock("../session-manager.js");
	vi.doUnmock("../handoff-utils.js");
	vi.doUnmock("../session-query.js");
});

describe("focusShortcut handler", () => {
	it("calls onUnfocus by default (existing focus/unfocus behavior preserved)", async () => {
		const { InteractiveShellOverlay } = await loadOverlay();
		const session = createExistingSession();
		const onUnfocus = vi.fn();
		const done = vi.fn();
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{ fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
			{ command: "pi", existingSession: session as any, onUnfocus },
			config,
			done,
		);

		overlay.handleInput(FOCUS_KEY);

		expect(onUnfocus).toHaveBeenCalledTimes(1);
		expect(done).not.toHaveBeenCalled();
		// Session should not be killed/disposed by an unfocus.
		expect(session.kill).not.toHaveBeenCalled();
	});

	it("closes the overlay (running) when focusShortcutCloses is true", async () => {
		const { InteractiveShellOverlay } = await loadOverlay();
		const session = createExistingSession({ exited: false });
		const onUnfocus = vi.fn();
		const done = vi.fn();
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{ fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
			{ command: "pi", existingSession: session as any, onUnfocus, focusShortcutCloses: true },
			config,
			done,
		);

		overlay.handleInput(FOCUS_KEY);

		// Did not unfocus.
		expect(onUnfocus).not.toHaveBeenCalled();
		// finishWithBackground -> done(result) with backgrounded result.
		expect(done).toHaveBeenCalledTimes(1);
		const result = done.mock.calls[0][0];
		expect(result.backgrounded).toBe(true);
	});

	it("closes the overlay (exited) when focusShortcutCloses is true", async () => {
		const { InteractiveShellOverlay } = await loadOverlay();
		const session = createExistingSession({ exited: true });
		const onUnfocus = vi.fn();
		const done = vi.fn();
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{ fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
			{ command: "pi", existingSession: session as any, onUnfocus, focusShortcutCloses: true },
			config,
			done,
		);

		overlay.handleInput(FOCUS_KEY);

		expect(onUnfocus).not.toHaveBeenCalled();
		expect(done).toHaveBeenCalledTimes(1);
		const result = done.mock.calls[0][0];
		// Exited path returns a normal completion (not backgrounded).
		expect(result.backgrounded).toBeFalsy();
	});

	it("footer says 'close' instead of 'unfocus' when focusShortcutCloses is true", async () => {
		const { InteractiveShellOverlay } = await loadOverlay();
		const session = createExistingSession({ exited: false });
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{ fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
			{ command: "pi", existingSession: session as any, focusShortcutCloses: true },
			config,
			() => {},
		);

		overlay.focused = true;
		const rendered = overlay.render(120).join("\n");
		expect(stripAnsi(rendered)).toMatch(/close/);
		expect(stripAnsi(rendered)).not.toMatch(/unfocus/);
	});

	it("exited footer (with disableExitAutoClose) lists Ctrl+T transfer + dismiss hint", async () => {
		const { InteractiveShellOverlay } = await loadOverlay();
		const session = createExistingSession({ exited: true });
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{ fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
			{
				command: "pi",
				existingSession: session as any,
				disableExitAutoClose: true,
				focusShortcutCloses: true,
			},
			config,
			() => {},
		);

		// Trigger the queueMicrotask path that transitions an existing
		// already-exited session into the overlay's "exited" state.
		await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
		overlay.focused = true;
		const rendered = stripAnsi(overlay.render(120).join("\n"));
		expect(rendered).toMatch(/Ctrl\+T transfer/);
		expect(rendered).toMatch(/any other key dismisses/);
		// No 10s countdown should be present.
		expect(rendered).not.toMatch(/Closing in/);
	});
});
