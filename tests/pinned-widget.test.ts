import { describe, expect, it, vi } from "vitest";

// pi-tui is a peerDependency provided by the host pi runtime; tests need to
// stub it. Static `import { ... } from "@mariozechner/pi-tui"` resolves
// against this mock thanks to vitest's module hoisting.
vi.mock("@mariozechner/pi-tui", () => ({
	truncateToWidth: (value: string, width: number, suffix?: string) => {
		if (value.length <= width) return value;
		const marker = suffix ?? "";
		return value.slice(0, Math.max(0, width - marker.length)) + marker;
	},
	visibleWidth: (value: string) => value.length,
}));

import { setupPinnedWidget } from "../pinned-widget.js";
import type { PtyTerminalSession } from "../pty-session.js";

/**
 * Stub PtySession surface — `setupPinnedWidget` only touches `addDataListener`
 * and `getTailLines`. Everything else is irrelevant to widget behavior.
 */
function makeStubSession(opts: {
	tailLines?: string[];
	totalLines?: number;
	truncatedByChars?: boolean;
} = {}) {
	const tail = opts.tailLines ?? ["row 1", "row 2", "row 3"];
	const totalLines = opts.totalLines ?? tail.length;
	const truncatedByChars = opts.truncatedByChars ?? false;
	const dataListeners = new Set<(data: string) => void>();
	const session = {
		addDataListener(cb: (data: string) => void) {
			dataListeners.add(cb);
			return () => dataListeners.delete(cb);
		},
		getTailLines(_options: { lines: number; ansi?: boolean; maxChars?: number }) {
			return { lines: tail, totalLinesInBuffer: totalLines, truncatedByChars };
		},
		emitData(data: string) {
			for (const cb of dataListeners) cb(data);
		},
		dataListenerCount() {
			return dataListeners.size;
		},
	};
	return session as unknown as PtyTerminalSession & { emitData: (d: string) => void; dataListenerCount: () => number };
}

function makeStubCtx() {
	const widgets = new Map<string, any>();
	const ctx = {
		hasUI: true,
		ui: {
			setWidget: vi.fn((name: string, content: any) => {
				if (content === undefined) widgets.delete(name);
				else widgets.set(name, content);
			}),
		},
	};
	return { ctx, widgets };
}

function makeStubTui(rows = 40, columns = 120) {
	const requestRender = vi.fn();
	return {
		requestRender,
		terminal: { rows, columns },
	};
}

const STUB_THEME = {
	fg: (_kind: string, text: string) => text,
};

describe("setupPinnedWidget", () => {
	it("returns null when ctx.hasUI is false (headless)", () => {
		const { ctx } = makeStubCtx();
		ctx.hasUI = false;
		const session = makeStubSession();
		const handle = setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		expect(handle).toBeNull();
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});

	it("registers the widget at placement aboveEditor with a stable name keyed by session id", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		const handle = setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		expect(handle).not.toBeNull();
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
		const [name, , options] = (ctx.ui.setWidget as any).mock.calls[0];
		expect(name).toBe("pinned-shell:calm-reef");
		expect(options.placement).toBe("aboveEditor");
		expect(widgets.has("pinned-shell:calm-reef")).toBe(true);
		handle!.dispose();
	});

	it("renders header + separator + tail content when running", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession({ tailLines: ["hello", "world"] });
		const handle = setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(Date.now() - 5000),
			session,
			ctx: ctx as any,
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const tui = makeStubTui();
		const widget = factory(tui, STUB_THEME);
		const lines = widget.render(80);
		expect(lines.length).toBeGreaterThanOrEqual(4); // header + sep + 2 content
		expect(lines[0]).toContain("▶ running");
		expect(lines[0]).toContain("calm-reef");
		expect(lines[0]).toContain("claude");
		expect(lines[1]).toMatch(/⎯+/); // separator
		expect(lines.slice(2)).toEqual(["hello", "world"]);
		handle!.dispose();
	});

	it("caps height to 50% of terminal rows by default (allowing for header + separator)", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession({
			tailLines: Array.from({ length: 50 }, (_, i) => `row ${i + 1}`),
			totalLines: 50,
		});
		setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const tui = makeStubTui(40); // 40 rows → cap = 20 → tailLines requested = 18
		const tailSpy = vi.spyOn(session, "getTailLines");
		factory(tui, STUB_THEME).render(80);
		const requested = tailSpy.mock.calls[0][0].lines;
		expect(requested).toBe(18); // 50% of 40 = 20, minus header + separator
	});

	it("respects a custom heightCap option", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
			heightCap: 0.25, // 25%
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const tui = makeStubTui(40); // 25% of 40 = 10 → tail = 8
		const tailSpy = vi.spyOn(session, "getTailLines");
		factory(tui, STUB_THEME).render(80);
		expect(tailSpy.mock.calls[0][0].lines).toBe(8);
	});

	it("respects the minHeight floor when terminal is small", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const tui = makeStubTui(8); // 50% of 8 = 4, but minHeight floor is 5
		const tailSpy = vi.spyOn(session, "getTailLines");
		factory(tui, STUB_THEME).render(80);
		expect(tailSpy.mock.calls[0][0].lines).toBe(3); // 5 cap - 2 (header + sep)
	});

	it("triggers a debounced re-render when session emits data", () => {
		vi.useFakeTimers();
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const tui = makeStubTui();
		factory(tui, STUB_THEME); // initialize tuiRef

		expect(tui.requestRender).not.toHaveBeenCalled();
		session.emitData("hello");
		// Debounce window not yet elapsed
		expect(tui.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		// Multiple chunks within the window coalesce to one re-render
		session.emitData("a");
		session.emitData("b");
		session.emitData("c");
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(100);
		expect(tui.requestRender).toHaveBeenCalledTimes(2);

		vi.useRealTimers();
	});

	it("renders empty when hidden", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		const handle = setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const tui = makeStubTui();
		const widget = factory(tui, STUB_THEME);
		expect(widget.render(80).length).toBeGreaterThan(0);
		handle!.setHidden(true);
		expect(widget.render(80)).toEqual([]);
		handle!.setHidden(false);
		expect(widget.render(80).length).toBeGreaterThan(0);
	});

	it("markExited switches the header from running to exited and stops the duration timer", () => {
		vi.useFakeTimers();
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		const handle = setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const tui = makeStubTui();
		const widget = factory(tui, STUB_THEME);

		// While running, header includes "▶ running"
		expect(widget.render(80)[0]).toContain("▶ running");

		handle!.markExited(0);
		expect(widget.render(80)[0]).toContain("● exited 0");

		// Duration timer should have stopped — advancing fake time shouldn't
		// trigger requestRender again (only the markExited render counts).
		const callsBefore = tui.requestRender.mock.calls.length;
		vi.advanceTimersByTime(60_000);
		expect(tui.requestRender.mock.calls.length).toBe(callsBefore);

		handle!.markExited(42); // double-call is a no-op once exited
		expect(widget.render(80)[0]).toContain("● exited 0"); // first call wins
		vi.useRealTimers();
	});

	it("dispose clears the widget and unsubscribes the data listener", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		const handle = setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		expect(widgets.has("pinned-shell:calm-reef")).toBe(true);
		expect(session.dataListenerCount()).toBe(1);

		handle!.dispose();
		expect(widgets.has("pinned-shell:calm-reef")).toBe(false);
		expect(session.dataListenerCount()).toBe(0);

		// dispose is idempotent
		handle!.dispose();
	});

	it("non-zero exit codes render in warning color (header text)", () => {
		const { ctx, widgets } = makeStubCtx();
		const session = makeStubSession();
		const handle = setupPinnedWidget({
			sessionId: "calm-reef",
			command: "claude",
			startedAt: new Date(),
			session,
			ctx: ctx as any,
		});
		const factory = widgets.get("pinned-shell:calm-reef");
		const widget = factory(makeStubTui(), STUB_THEME);

		handle!.markExited(42);
		expect(widget.render(80)[0]).toContain("● exited 42");
		handle!.dispose();
	});
});
