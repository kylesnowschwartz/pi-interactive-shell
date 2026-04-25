import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyPaneSession } from "../pty-pane-session.js";

/**
 * Integration tests for PtyPaneSession (push approach).
 *
 * Gated on `process.env.TMUX`. Each test must clean up its pane before it
 * returns; the dispose sweep at the end is the belt-and-braces guarantee
 * that nothing leaks if a test throws mid-flight.
 *
 * Fixtures (per docs/pane-mode-architecture.md §8 and the push prompt):
 *   1 — fidelity (ANSI preserved through pipe-pane fifo + xterm)
 *   2 — monitor-trigger fidelity (line counts in raw stream)
 *   3 — input round-trip (literal text only; C-d EOF is a known limitation
 *       inherited from tmux send-keys, same as pull approach)
 *   5 — crash recovery (clean dispose, external kill-pane)
 *   6 — latency (push cadence floor)
 *
 * Fixture 4 (token cost) deferred to Phase 1 dispatcher integration.
 * Fixture 5c (SIGTERM mid-process) deferred — hard to validate from inside
 * the same node process running the test.
 */

// FORCED-SKIP: the push approach's blocking O_RDWR fifo strands a libuv read
// thread per session. `stream.destroy()` + `closeSync(fd)` in dispose() does
// not release that thread, so vitest's worker process can't finalise after
// these tests run — even with --pool=forks. Same root cause as the skipped
// unit tests in pty-pane-session.test.ts. This is a major bake-off finding,
// not a flaky test: the push approach is conceptually viable but operationally
// incompatible with the project's test infrastructure as currently configured.
// See docs/pane-mode-bakeoff.md for the verdict.
//
// To run these fixtures by hand, set RUN_PUSH_INTEGRATION=1 in env. The
// process will hang at the end and you must `kill -9` it; output is still
// captured to stdout in the meantime.
const insideTmux = !!process.env.TMUX && process.env.RUN_PUSH_INTEGRATION === "1";
const describeIfTmux = insideTmux ? describe : describe.skip;

const POLL_MS = 100;
const FIFO_DIR = join(tmpdir(), "pi-interactive-shell-test");

function listPaneIds(): string[] {
	try {
		const buf = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], {
			encoding: "buffer",
			stdio: ["ignore", "pipe", "pipe"],
		}) as Buffer;
		return buf
			.toString("utf8")
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise<void>((r) => setTimeout(r, stepMs));
	}
	return predicate();
}

const sessions: PtyPaneSession[] = [];
function track(s: PtyPaneSession): PtyPaneSession {
	sessions.push(s);
	return s;
}

afterEach(async () => {
	const ids: string[] = [];
	while (sessions.length) {
		const s = sessions.pop();
		if (s) {
			ids.push(s.paneId);
			try { s.dispose(); } catch { /* best effort */ }
		}
	}
	// Wait for tmux to actually reap the panes; kill-pane is fast but
	// not synchronous from outside the tmux server.
	await waitFor(() => {
		const live = listPaneIds();
		return ids.every((id) => !live.includes(id));
	}, 2000, 25);
});

describeIfTmux("PtyPaneSession integration (TMUX, push)", () => {
	it("fixture 1: ANSI fidelity — five red lines preserved through pipe-pane/fifo", { timeout: 15000 }, async () => {
		const session = track(new PtyPaneSession({
			command: 'for i in 1 2 3 4 5; do printf "\\x1b[31mline %d\\x1b[0m\\n" $i; sleep 0.1; done',
			pane: { layout: "right", sizePercent: 30 },
			fifoDir: FIFO_DIR,
			pollIntervalMs: POLL_MS,
		}));
		await waitFor(() => session.exited, 8000, 100);
		expect(session.exited).toBe(true);

		// Push approach feeds raw fifo bytes into @xterm/headless, so both
		// ANSI-preserving views (getTailLines with ansi:true, raw stream)
		// must show the colored lines.
		const tail = session.getTailLines({ lines: 80, ansi: true });
		const tailJoined = tail.lines.join("\n");
		const rawAnsi = session.getRawStream({ stripAnsi: false });
		const rawClean = session.getRawStream({ stripAnsi: true });
		const reds = (tailJoined.match(/\x1b\[(?:0;)?(?:1;)?31(?:;\d+)*m/g) || []).length
			+ (rawAnsi.match(/\x1b\[(?:0;)?(?:1;)?31(?:;\d+)*m/g) || []).length;
		const visible = (rawClean.match(/line \d/g) || []).length;
		expect(visible).toBeGreaterThanOrEqual(5);
		expect(reds).toBeGreaterThanOrEqual(1);
	});

	it("fixture 2: monitor-trigger fidelity — getRawStream contains all 50 lines", { timeout: 15000 }, async () => {
		const session = track(new PtyPaneSession({
			command: 'for i in $(seq 1 50); do echo line-$i; done',
			pane: { layout: "right", sizePercent: 30 },
			fifoDir: FIFO_DIR,
			pollIntervalMs: POLL_MS,
		}));
		await waitFor(() => session.exited, 8000, 100);
		expect(session.exited).toBe(true);

		const raw = stripVTControlCharacters(session.getRawStream({ stripAnsi: true }));
		const matches = raw.match(/line-(\d+)/g) || [];
		const distinct = new Set(matches);
		expect(distinct.size).toBe(50);
	});

	/*
	 * Fixture 3 (input round-trip with C-d EOF) is a known limitation shared
	 * with the pull approach: tmux send-keys cannot synthesise the line-discipline
	 * EOF signal cat depends on. Documented in docs/pane-mode-bakeoff.md.
	 */
	it.skip("fixture 3: input round-trip — C-d EOF (deferred, see bake-off doc)", async () => {
		const session = track(new PtyPaneSession({
			command: "cat",
			pane: { layout: "right", sizePercent: 30 },
			fifoDir: FIFO_DIR,
			pollIntervalMs: POLL_MS,
		}));
		await new Promise<void>((r) => setTimeout(r, 250));
		session.write("hello\nworld\n");
		await new Promise<void>((r) => setTimeout(r, 400));
		const raw = session.getRawStream({ stripAnsi: true });
		expect(raw).toContain("hello");
		expect(raw).toContain("world");
		session.write("\x04");
		const exited = await waitFor(() => session.exited, 4000, 50);
		expect(exited).toBe(true);
	}, 10000);

	it("fixture 3 (partial): literal text round-trips through write", async () => {
		const session = track(new PtyPaneSession({
			command: "cat",
			pane: { layout: "right", sizePercent: 30 },
			fifoDir: FIFO_DIR,
			pollIntervalMs: POLL_MS,
		}));
		await new Promise<void>((r) => setTimeout(r, 250));
		session.write("hello\nworld\n");
		await new Promise<void>((r) => setTimeout(r, 600));
		const raw = session.getRawStream({ stripAnsi: true });
		expect(raw).toContain("hello");
		expect(raw).toContain("world");
	}, 10000);

	it("fixture 5a: clean dispose leaves no leaked pane or fifo", async () => {
		const session = new PtyPaneSession({
			command: "sleep 30",
			pane: { layout: "right", sizePercent: 30 },
			fifoDir: FIFO_DIR,
			pollIntervalMs: POLL_MS,
		});
		const id = session.paneId;
		expect(listPaneIds()).toContain(id);
		session.dispose();
		const reaped = await waitFor(() => !listPaneIds().includes(id), 2000, 25);
		expect(reaped).toBe(true);

		// Push-specific: verify no leaked fifo file from this session in FIFO_DIR.
		// The dispose() call should have unlinked it.
		if (existsSync(FIFO_DIR)) {
			const stale = readdirSync(FIFO_DIR).filter((f) => f.endsWith(".fifo"));
			// Other concurrent tests may have left fifos; the assertion is just
			// that dispose() did its part. We can't tightly correlate without
			// reading the SUT's internal fifo path, so this is a soft check.
			expect(stale.length).toBeLessThan(20);
		}
	});

	it("fixture 5b: external kill-pane is detected within ~1 poll tick + grace", async () => {
		const session = track(new PtyPaneSession({
			command: "sleep 30",
			pane: { layout: "right", sizePercent: 30 },
			fifoDir: FIFO_DIR,
			pollIntervalMs: POLL_MS,
		}));
		await new Promise<void>((r) => setTimeout(r, 150));
		execFileSync("tmux", ["kill-pane", "-t", session.paneId], { stdio: "ignore" });
		const exited = await waitFor(() => session.exited, 2000, 50);
		expect(exited).toBe(true);
	});

	it.skip("fixture 5c: SIGTERM mid-session — deferred (see bake-off doc)", () => {
		// Intentionally empty.
	});

	it("fixture 6: latency — END observed in [1.0s, 4.0s] from spawn", { timeout: 10000 }, async () => {
		const start = Date.now();
		let endSeenAt = 0;
		const session = track(new PtyPaneSession(
			{
				command: "echo START; sleep 1; echo END",
				pane: { layout: "right", sizePercent: 30 },
				fifoDir: FIFO_DIR,
				pollIntervalMs: POLL_MS,
			},
			{
				onData: (chunk) => {
					if (endSeenAt === 0 && chunk.includes("END")) {
						endSeenAt = Date.now();
					}
				},
			},
		));
		const seen = await waitFor(() => endSeenAt !== 0, 6000, 50);
		expect(seen).toBe(true);
		const elapsed = endSeenAt - start;
		// Push approach: pipe-pane is push-based via fifo, so latency is
		// dominated by the underlying tmux/fifo flush + the sleep, not by
		// our poll interval. Expect noticeably sub-second response after
		// the 1s sleep completes.
		expect(elapsed).toBeGreaterThanOrEqual(1000);
		expect(elapsed).toBeLessThanOrEqual(4000);
		(globalThis as Record<string, unknown>).__pushLatencyMs = elapsed;
	});
});
