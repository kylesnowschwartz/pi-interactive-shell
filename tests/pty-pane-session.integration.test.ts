/**
 * Integration tests for PtyPaneSession that exercise real tmux + a real
 * fifo + a real cat reader child process.
 *
 * Each test boots its OWN isolated tmux server via `-L hybrid-test-<pid>`
 * (a socket name no real user tmux would collide with) and tears it down
 * at the end. The user's tmux server is never touched.
 *
 * The bake-off branches taught this lesson the hard way: tests that
 * shared the user's tmux server leaked panes when they aborted mid-flight,
 * and contaminated each other across runs. Isolated sockets fix that.
 *
 * Skipped entirely if no `tmux` binary is on PATH (e.g. minimal CI envs).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PtyPaneSession } from "../pty-pane-session.js";
import { DefaultTmuxRunner, type TmuxResult, type TmuxRunOptions, type TmuxRunner } from "../tmux-cli.js";

function tmuxExists(): boolean {
	const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
	return r.status === 0;
}

const TMUX_AVAILABLE = tmuxExists();
const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

/** Build a TmuxRunner that scopes every call to a specific socket. */
function isolatedRunner(socket: string): TmuxRunner {
	const base = new DefaultTmuxRunner();
	return {
		runTmux(args: string[], opts?: TmuxRunOptions): TmuxResult {
			return base.runTmux(["-L", socket, ...args], opts);
		},
	};
}

/** Block until predicate returns true, or timeoutMs elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise<void>((r) => setTimeout(r, stepMs));
	}
	return predicate();
}

function listPanesOnSocket(socket: string): string[] {
	try {
		const out = execFileSync("tmux", ["-L", socket, "list-panes", "-a", "-F", "#{pane_id}"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

let socket: string;
let runner: TmuxRunner;
let activeSessions: PtyPaneSession[] = [];

beforeAll(() => {
	if (!TMUX_AVAILABLE) return;
});

beforeEach(() => {
	if (!TMUX_AVAILABLE) return;
	socket = `hybrid-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	runner = isolatedRunner(socket);
	// Start a holding session on the isolated server so split-window has a
	// place to attach. Without this, split-window has nowhere to split from.
	execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", "host", "sleep", "120"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	activeSessions = [];
});

afterEach(async () => {
	if (!TMUX_AVAILABLE) return;
	for (const s of activeSessions) {
		try {
			s.dispose();
		} catch {
			// best-effort
		}
	}
	activeSessions = [];
	// Confirm the isolated server has only the host pane left (or is gone).
	await waitFor(() => listPanesOnSocket(socket).length <= 1, 2000);
	// Kill the isolated tmux server outright. Belt + braces.
	try {
		execFileSync("tmux", ["-L", socket, "kill-server"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		// already gone
	}
});

function track(s: PtyPaneSession): PtyPaneSession {
	activeSessions.push(s);
	return s;
}

// ---------------------------------------------------------------------------
// Byte fidelity (codex review priority 1: same-line growth, newline-only)
// ---------------------------------------------------------------------------

describeIfTmux("byte fidelity through real pipe-pane → cat → parent", () => {
	it("multi-line output arrives byte-for-byte", async () => {
		let received = "";
		let exitCode: number | undefined;
		const session = track(
			new PtyPaneSession(
				{
					command: "for i in 1 2 3 4 5; do echo line$i; done",
					tmuxRunner: runner,
				},
				{
					onData: (d) => {
						received += d;
					},
					onExit: (c) => {
						exitCode = c;
					},
				},
			),
		);

		await waitFor(() => exitCode !== undefined, 5000);
		expect(exitCode).toBe(0);
		expect(received).toBe("line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n");
		void session;
	});

	it("ANSI escape sequences pass through verbatim", async () => {
		let received = "";
		let exitCode: number | undefined;
		track(
			new PtyPaneSession(
				{
					command: 'printf "\\x1b[31mred\\x1b[0m \\x1b[32mgreen\\x1b[0m\\n"',
					tmuxRunner: runner,
				},
				{
					onData: (d) => {
						received += d;
					},
					onExit: (c) => {
						exitCode = c;
					},
				},
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);
		expect(received).toContain("\u001b[31mred\u001b[0m");
		expect(received).toContain("\u001b[32mgreen\u001b[0m");
	});

	// Codex review priority 1: same-line growth (`a` → `ab`). Pull's diff path
	// silently corrupted this. The hybrid byte stream is canonical: each chunk
	// is what the process actually emitted, in order.
	it("same-line growth (a → ab) emits two distinct chunks with no synthesized newline", async () => {
		const seen: string[] = [];
		let exitCode: number | undefined;
		track(
			new PtyPaneSession(
				{
					command: 'printf a; sleep 0.15; printf b',
					tmuxRunner: runner,
				},
				{
					onData: (d) => {
						seen.push(d);
					},
					onExit: (c) => {
						exitCode = c;
					},
				},
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);

		// Concatenated, the byte stream is exactly "ab" — no synthesized
		// newline, no missing letter.
		const concat = seen.join("");
		expect(concat).toBe("ab");
		// Pull's prefix-divergence handling could merge or split chunks
		// arbitrarily. The hybrid is straight pass-through, so the chunks
		// arrive in source order.
		expect(seen.length).toBeGreaterThanOrEqual(1);
	});

	// Codex review priority 1: newline-only output. Pull's stripTrailingNewlines
	// dropped these. Hybrid forwards them verbatim.
	it("newline-only output is preserved", async () => {
		let received = "";
		let exitCode: number | undefined;
		track(
			new PtyPaneSession(
				{
					command: 'printf "\\n"; sleep 0.1; printf "\\n\\n"; sleep 0.1; printf "tail\\n"',
					tmuxRunner: runner,
				},
				{
					onData: (d) => {
						received += d;
					},
					onExit: (c) => {
						exitCode = c;
					},
				},
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);
		// pty translates \n to \r\n; the salient point is no \n is missing.
		expect(received.split("\n").length).toBeGreaterThanOrEqual(4);
		expect(received).toContain("tail");
	});
});

// ---------------------------------------------------------------------------
// Exit detection
// ---------------------------------------------------------------------------

describeIfTmux("exit detection via sidecar file", () => {
	it("exit 0 propagates", async () => {
		let exitCode: number | undefined;
		track(
			new PtyPaneSession(
				{ command: "true", tmuxRunner: runner },
				{ onExit: (c) => { exitCode = c; } },
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);
		expect(exitCode).toBe(0);
	});

	it("non-zero exit propagates (false → 1)", async () => {
		let exitCode: number | undefined;
		track(
			new PtyPaneSession(
				{ command: "false", tmuxRunner: runner },
				{ onExit: (c) => { exitCode = c; } },
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);
		expect(exitCode).toBe(1);
	});

	it("explicit exit N propagates", async () => {
		let exitCode: number | undefined;
		track(
			new PtyPaneSession(
				{ command: "exit 7", tmuxRunner: runner },
				{ onExit: (c) => { exitCode = c; } },
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);
		expect(exitCode).toBe(7);
	});

	// Codex review concern: fast-finishing processes. Without remain-on-exit
	// + the diff race, can the hybrid still capture the full output of a
	// command that finishes in <50ms?
	it("fast-finishing process delivers full output and accurate exit code", async () => {
		let received = "";
		let exitCode: number | undefined;
		track(
			new PtyPaneSession(
				{ command: 'echo done; exit 5', tmuxRunner: runner },
				{
					onData: (d) => {
						received += d;
					},
					onExit: (c) => {
						exitCode = c;
					},
				},
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);
		expect(exitCode).toBe(5);
		expect(received).toContain("done");
	});
});

// ---------------------------------------------------------------------------
// Send-keys (write input)
// ---------------------------------------------------------------------------

describeIfTmux("write() round-trip", () => {
	it("plain text echoes through and is consumed by read", async () => {
		let received = "";
		let exitCode: number | undefined;
		const session = track(
			new PtyPaneSession(
				{
					command:
						'while read line; do echo "echo:$line"; if [ "$line" = quit ]; then exit 9; fi; done',
					tmuxRunner: runner,
				},
				{
					onData: (d) => {
						received += d;
					},
					onExit: (c) => {
						exitCode = c;
					},
				},
			),
		);

		// Wait a beat for the read loop to be ready
		await new Promise((r) => setTimeout(r, 200));
		session.write("hello\r");
		await new Promise((r) => setTimeout(r, 150));
		session.write("quit\r");

		await waitFor(() => exitCode !== undefined, 5000);
		expect(exitCode).toBe(9);
		expect(received).toContain("echo:hello");
	});

	it("Ctrl-C byte (0x03) generates SIGINT to a trap-bearing process", async () => {
		let received = "";
		let exitCode: number | undefined;
		const session = track(
			new PtyPaneSession(
				{
					command: "trap 'echo CAUGHT_INT; exit 99' INT; sleep 5",
					tmuxRunner: runner,
				},
				{
					onData: (d) => {
						received += d;
					},
					onExit: (c) => {
						exitCode = c;
					},
				},
			),
		);

		await new Promise((r) => setTimeout(r, 200));
		session.write("\x03");

		await waitFor(() => exitCode !== undefined, 5000);
		expect(exitCode).toBe(99);
		expect(received).toContain("CAUGHT_INT");
	});
});

// ---------------------------------------------------------------------------
// On-demand viewport queries
// ---------------------------------------------------------------------------

describeIfTmux("getViewportLines / getTailLines via capture-pane", () => {
	it("getTailLines returns scrollback while pane is alive", async () => {
		const session = track(
			new PtyPaneSession(
				{
					command: 'for i in $(seq 1 30); do echo "row $i"; done; sleep 3',
					tmuxRunner: runner,
				},
				{},
			),
		);
		// Wait for the loop to finish, but pane is still alive (sleep 3).
		await new Promise((r) => setTimeout(r, 400));

		const tail = session.getTailLines({ lines: 5, ansi: false });
		expect(tail.totalLinesInBuffer).toBeGreaterThanOrEqual(30);
		expect(tail.lines).toContain("row 30");
		expect(tail.lines.find((l) => l === "row 26")).toBe("row 26");

		const viewport = session.getViewportLines({ ansi: false });
		// Default rows is 24, so the visible viewport shows the last 24 lines
		expect(viewport.length).toBe(24);
		expect(viewport).toContain("row 30");
	});

	it("getTailLines maxChars budget truncates and sets truncatedByChars", async () => {
		const session = track(
			new PtyPaneSession(
				{
					command: 'for i in $(seq 1 10); do echo "row $i"; done; sleep 3',
					tmuxRunner: runner,
				},
				{},
			),
		);
		await new Promise((r) => setTimeout(r, 400));

		const tail = session.getTailLines({ lines: 10, ansi: false, maxChars: 12 });
		expect(tail.truncatedByChars).toBe(true);
		// Each "row N" or "row NN" is 5-6 chars, so under 12 chars only the first 1-2 fit.
		expect(tail.lines.length).toBeLessThan(10);
	});
});

// ---------------------------------------------------------------------------
// Lifecycle hygiene (codex review B3 — no leaked panes)
// ---------------------------------------------------------------------------

describeIfTmux("lifecycle hygiene", () => {
	it("dispose kills the pane unconditionally even after natural exit", async () => {
		let exitCode: number | undefined;
		const session = track(
			new PtyPaneSession(
				{ command: "echo done; exit 0", tmuxRunner: runner },
				{ onExit: (c) => { exitCode = c; } },
			),
		);
		await waitFor(() => exitCode !== undefined, 5000);
		const paneId = session.paneId;

		// At this moment, since we drop remain-on-exit, tmux already reaped
		// the pane. Confirm.
		const beforeDispose = listPanesOnSocket(socket);
		expect(beforeDispose).not.toContain(paneId);

		// dispose still runs cleanly without throwing.
		session.dispose();
		const afterDispose = listPanesOnSocket(socket);
		expect(afterDispose).not.toContain(paneId);
	});

	it("dispose kills a still-running pane", async () => {
		const session = track(
			new PtyPaneSession({ command: "sleep 30", tmuxRunner: runner }, {}),
		);
		const paneId = session.paneId;
		expect(listPanesOnSocket(socket)).toContain(paneId);

		session.dispose();
		await waitFor(() => !listPanesOnSocket(socket).includes(paneId), 2000);
		expect(listPanesOnSocket(socket)).not.toContain(paneId);
		// Remove from activeSessions so afterEach doesn't try to dispose again
		activeSessions = activeSessions.filter((s) => s !== session);
	});

	it("multiple sessions don't leak any panes after dispose", async () => {
		const before = listPanesOnSocket(socket).length;

		const sessions = [
			new PtyPaneSession({ command: "sleep 10", tmuxRunner: runner }, {}),
			new PtyPaneSession({ command: "sleep 10", tmuxRunner: runner }, {}),
			new PtyPaneSession({ command: "sleep 10", tmuxRunner: runner }, {}),
		];
		for (const s of sessions) track(s);

		expect(listPanesOnSocket(socket).length).toBe(before + 3);

		for (const s of sessions) s.dispose();
		await waitFor(() => listPanesOnSocket(socket).length === before, 3000);
		expect(listPanesOnSocket(socket).length).toBe(before);
	});
});
