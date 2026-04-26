/**
 * Unit tests for PtyPaneSession with a mocked tmux runner.
 *
 * Real fifo + reader child process behavior lives in
 * `tests/pty-pane-session.integration.test.ts` and is gated on TMUX
 * being available. These tests run everywhere and cover:
 *   - construction wiring (which tmux commands fire, in which order)
 *   - listener teardown semantics
 *   - dispose hygiene (kill-pane unconditional; codex review B3)
 *   - PtySession interface conformance (compile-time)
 *   - splitWriteForSendKeys behavior
 *   - exit detection without spawning a real cat reader
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PtyPaneSession,
	type PtyPaneSessionOptions,
	splitWriteForSendKeys,
} from "../pty-pane-session.js";
import type { PtySession } from "../pty-session-interface.js";
import type { TmuxResult, TmuxRunOptions, TmuxRunner } from "../tmux-cli.js";

class StubRunner implements TmuxRunner {
	calls: Array<{ args: string[]; opts?: TmuxRunOptions }> = [];
	queue: Array<(args: string[], opts?: TmuxRunOptions) => TmuxResult> = [];
	defaultResponse: (args: string[]) => TmuxResult;

	constructor() {
		this.defaultResponse = (args) => ({
			stdout: args[0] === "split-window" ? "%42\n" : args[0] === "display-message" ? "1234\n" : "",
			stderr: "",
			exitCode: 0,
		});
	}

	push(handler: (args: string[], opts?: TmuxRunOptions) => TmuxResult): void {
		this.queue.push(handler);
	}

	runTmux(args: string[], opts?: TmuxRunOptions): TmuxResult {
		this.calls.push({ args, opts });
		const next = this.queue.shift();
		if (next) return next(args, opts);
		return this.defaultResponse(args);
	}

	findCalls(verb: string): Array<{ args: string[]; opts?: TmuxRunOptions }> {
		return this.calls.filter((c) => c.args[0] === verb);
	}
}

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `pi-hybrid-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

function makeSession(overrides: Partial<PtyPaneSessionOptions> = {}): {
	session: PtyPaneSession;
	runner: StubRunner;
} {
	const runner = overrides.tmuxRunner instanceof StubRunner ? overrides.tmuxRunner : new StubRunner();
	const opts: PtyPaneSessionOptions = {
		command: "echo hi",
		tmuxRunner: runner,
		fifoDir: testDir,
		skipMkfifo: true,
		skipReader: true,
		...overrides,
	};
	const session = new PtyPaneSession(opts);
	return { session, runner: runner as StubRunner };
}

// ---------------------------------------------------------------------------
// Construction wiring
// ---------------------------------------------------------------------------

describe("PtyPaneSession construction", () => {
	it("issues split-window then pipe-pane in that order", () => {
		const { runner } = makeSession();
		const verbs = runner.calls.map((c) => c.args[0]);
		const splitIdx = verbs.indexOf("split-window");
		const pipeIdx = verbs.indexOf("pipe-pane");
		expect(splitIdx).toBeGreaterThanOrEqual(0);
		expect(pipeIdx).toBeGreaterThan(splitIdx);
	});

	it("does NOT call set-option remain-on-exit (hybrid drops it)", () => {
		const { runner } = makeSession();
		const setOptions = runner.calls.filter((c) => c.args[0] === "set-option");
		expect(setOptions).toHaveLength(0);
	});

	it("captures pane pid via display-message #{pane_pid}", () => {
		const { session, runner } = makeSession();
		const pidQueries = runner.calls.filter(
			(c) => c.args[0] === "display-message" && c.args.includes("#{pane_pid}"),
		);
		expect(pidQueries).toHaveLength(1);
		expect(session.pid).toBe(1234);
	});

	it("wraps user command with subshell + EXIT trap + signal-ignore", () => {
		const { runner } = makeSession({ command: "ls -la" });
		const split = runner.calls.find((c) => c.args[0] === "split-window");
		expect(split).toBeDefined();
		const cmdArg = split!.args[split!.args.length - 1];
		expect(cmdArg).toContain("trap '' INT TERM HUP");
		expect(cmdArg).toContain("trap 'printf");
		expect(cmdArg).toContain("' EXIT");
		expect(cmdArg).toContain("( ls -la )");
	});

	it("filters TMUX env vars from pane env to avoid server leak", () => {
		const { runner } = makeSession({ env: { FOO: "bar" } });
		const split = runner.calls.find((c) => c.args[0] === "split-window");
		expect(split).toBeDefined();
		const envArgs: string[] = [];
		for (let i = 0; i < split!.args.length - 1; i++) {
			if (split!.args[i] === "-e") envArgs.push(split!.args[i + 1]!);
		}
		const fooFound = envArgs.some((e) => e.startsWith("FOO="));
		const tmuxFound = envArgs.some((e) => e.startsWith("TMUX="));
		expect(fooFound).toBe(true);
		expect(tmuxFound).toBe(false);
	});

	it("applies pane title via select-pane -T when provided", () => {
		const { runner } = makeSession({ pane: { title: "Build Watcher" } });
		const titleCall = runner.calls.find(
			(c) => c.args[0] === "select-pane" && c.args.includes("-T") && c.args.includes("Build Watcher"),
		);
		expect(titleCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// PtySession interface conformance (compile-time)
// ---------------------------------------------------------------------------

describe("PtySession interface conformance", () => {
	it("PtyPaneSession satisfies PtySession", () => {
		const { session } = makeSession();
		const asInterface: PtySession = session;
		// Touch every required method/getter to keep TS engaged with the assignment
		expect(typeof asInterface.exited).toBe("boolean");
		expect(typeof asInterface.exitCode === "number" || asInterface.exitCode === null).toBe(true);
		expect(typeof asInterface.pid).toBe("number");
		expect(typeof asInterface.cols).toBe("number");
		expect(typeof asInterface.rows).toBe("number");
		expect(typeof asInterface.write).toBe("function");
		expect(typeof asInterface.resize).toBe("function");
		expect(typeof asInterface.getViewportLines).toBe("function");
		expect(typeof asInterface.getTailLines).toBe("function");
		expect(typeof asInterface.getRawStream).toBe("function");
		expect(typeof asInterface.getLogSlice).toBe("function");
		expect(typeof asInterface.kill).toBe("function");
		expect(typeof asInterface.dispose).toBe("function");
		asInterface.dispose();
	});
});

// ---------------------------------------------------------------------------
// Output streaming + listener teardown
// ---------------------------------------------------------------------------

describe("byte stream + listeners (via _feedReaderBytes)", () => {
	it("addDataListener receives bytes, unsubscribe stops them", () => {
		const { session } = makeSession();
		const seen: string[] = [];
		const unsub = session.addDataListener((d) => seen.push(d));
		session._feedReaderBytes("alpha");
		session._feedReaderBytes("beta");
		expect(seen).toEqual(["alpha", "beta"]);
		unsub();
		session._feedReaderBytes("gamma");
		expect(seen).toEqual(["alpha", "beta"]);
		session.dispose();
	});

	it("getRawStream returns bytes verbatim, optionally stripping ANSI", () => {
		const { session } = makeSession();
		session._feedReaderBytes("hello \u001b[31mred\u001b[0m world\n");
		expect(session.getRawStream()).toBe("hello red world\n");
		expect(session.getRawStream({ stripAnsi: false })).toBe("hello \u001b[31mred\u001b[0m world\n");
		session.dispose();
	});

	it("getRawStream sinceLast advances the cursor", () => {
		const { session } = makeSession();
		session._feedReaderBytes("first\n");
		expect(session.getRawStream({ sinceLast: true })).toBe("first\n");
		session._feedReaderBytes("second\n");
		expect(session.getRawStream({ sinceLast: true })).toBe("second\n");
		expect(session.getRawStream({ sinceLast: true })).toBe("");
		session.dispose();
	});

	it("getLogSlice tails the buffer", () => {
		const { session } = makeSession();
		for (let i = 1; i <= 5; i++) session._feedReaderBytes(`row ${i}\n`);
		const slice = session.getLogSlice({ limit: 2 });
		expect(slice.totalLines).toBe(5);
		expect(slice.sliceLineCount).toBe(2);
		expect(slice.slice).toBe("row 4\nrow 5");
		session.dispose();
	});

	// Codex review gap: same-line growth case. Pull's diff-based approach
	// silently corrupted this. The hybrid has no diff path — bytes flow
	// through verbatim — so "a" then "b" appear separately as bytes the
	// caller already chose to emit.
	it("same-line growth: 'a' then 'b' arrives as two distinct chunks", () => {
		const { session } = makeSession();
		const seen: string[] = [];
		session.addDataListener((d) => seen.push(d));
		session._feedReaderBytes("a");
		session._feedReaderBytes("b");
		expect(seen).toEqual(["a", "b"]);
		expect(session.getRawStream({ stripAnsi: false })).toBe("ab");
		session.dispose();
	});

	// Codex review gap: newline-only output. Pull's stripTrailingNewlines
	// dropped these. Hybrid forwards them as-is.
	it("newline-only output is preserved as data", () => {
		const { session } = makeSession();
		const seen: string[] = [];
		session.addDataListener((d) => seen.push(d));
		session._feedReaderBytes("\n");
		session._feedReaderBytes("\n\n");
		expect(seen).toEqual(["\n", "\n\n"]);
		expect(session.getRawStream({ stripAnsi: false })).toBe("\n\n\n");
		session.dispose();
	});

	it("addDataListener after dispose returns a no-op unsubscribe", () => {
		const { session } = makeSession();
		session.dispose();
		const unsub = session.addDataListener(() => {
			throw new Error("should not fire");
		});
		expect(typeof unsub).toBe("function");
		// Calling it should be safe (no-op); no bytes flow because session is disposed.
		unsub();
	});
});

// ---------------------------------------------------------------------------
// Exit detection
// ---------------------------------------------------------------------------

describe("exit detection via sidecar file", () => {
	it("reader-exit reads the exit-file sidecar and emits exit event", () => {
		const { session } = makeSession();
		// Pre-populate the exit file the SUT would have written
		const exitPath = (session as unknown as { exitFilePath: string }).exitFilePath;
		writeFileSync(exitPath, "42");

		let observed: { code: number; signal?: number } | undefined;
		session.addExitListener((code, signal) => {
			observed = { code, signal };
		});

		session._simulateReaderExit();
		expect(observed).toEqual({ code: 42, signal: undefined });
		expect(session.exited).toBe(true);
		expect(session.exitCode).toBe(42);
		session.dispose();
	});

	it("reader-exit with missing exit file synthesizes 130 (SIGINT-equivalent)", () => {
		const { session } = makeSession();
		let observed: number | undefined;
		session.addExitListener((code) => {
			observed = code;
		});
		session._simulateReaderExit();
		expect(observed).toBe(130);
		expect(session.exited).toBe(true);
		session.dispose();
	});

	it("repeated reader-exit calls do not double-fire", () => {
		const { session } = makeSession();
		const calls: number[] = [];
		session.addExitListener((code) => calls.push(code));
		session._simulateReaderExit();
		session._simulateReaderExit();
		session._simulateReaderExit();
		expect(calls).toHaveLength(1);
		session.dispose();
	});
});

// ---------------------------------------------------------------------------
// Dispose hygiene
// ---------------------------------------------------------------------------

describe("dispose hygiene (codex review B3)", () => {
	it("kill-panes unconditionally even after exit was observed", () => {
		const { session, runner } = makeSession();
		session._simulateReaderExit();
		expect(session.exited).toBe(true);

		// Clear runner.calls so we can assert kill-pane is from dispose, not earlier
		runner.calls = [];
		session.dispose();

		const killCalls = runner.findCalls("kill-pane");
		expect(killCalls).toHaveLength(1);
		expect(killCalls[0]!.args).toContain("%42");
	});

	it("kill-panes when target never exited", () => {
		const { session, runner } = makeSession();
		expect(session.exited).toBe(false);

		runner.calls = [];
		session.dispose();

		const killCalls = runner.findCalls("kill-pane");
		expect(killCalls).toHaveLength(1);
	});

	it("repeated dispose is idempotent", () => {
		const { session, runner } = makeSession();
		session.dispose();
		runner.calls = [];
		session.dispose();
		expect(runner.findCalls("kill-pane")).toHaveLength(0);
	});

	it("dispose clears registered listeners", () => {
		const { session } = makeSession();
		const seen: string[] = [];
		session.addDataListener((d) => seen.push(d));
		session.dispose();
		// After dispose, internal feed should not notify listeners
		// (handleBytes returns early when disposed).
		session._feedReaderBytes("after-dispose");
		expect(seen).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Write splitting
// ---------------------------------------------------------------------------

describe("splitWriteForSendKeys", () => {
	it("plain text becomes a single literal run", () => {
		expect(splitWriteForSendKeys("hello\r")).toEqual([{ kind: "literal", value: "hello\r" }]);
	});

	it("control byte alone becomes a single named run", () => {
		expect(splitWriteForSendKeys("\x03")).toEqual([{ kind: "named", value: "C-c" }]);
		expect(splitWriteForSendKeys("\x04")).toEqual([{ kind: "named", value: "C-d" }]);
		expect(splitWriteForSendKeys("\x1a")).toEqual([{ kind: "named", value: "C-z" }]);
	});

	it("mixed text + control bytes are split into runs", () => {
		expect(splitWriteForSendKeys("ls\r\x03y\r")).toEqual([
			{ kind: "literal", value: "ls\r" },
			{ kind: "named", value: "C-c" },
			{ kind: "literal", value: "y\r" },
		]);
	});

	it("ESC sequences are treated as literal runs (passed through)", () => {
		expect(splitWriteForSendKeys("\x1b[A")).toEqual([{ kind: "literal", value: "\x1b[A" }]);
	});

	it("empty input produces no runs", () => {
		expect(splitWriteForSendKeys("")).toEqual([]);
	});
});

describe("write() routing", () => {
	it("plain text routes through send-keys -l", () => {
		const { session, runner } = makeSession();
		runner.calls = [];
		session.write("hi\r");
		const sk = runner.findCalls("send-keys");
		expect(sk).toHaveLength(1);
		expect(sk[0]!.args).toContain("-l");
		expect(sk[0]!.args).toContain("hi\r");
		session.dispose();
	});

	it("control byte routes through named-key send-keys", () => {
		const { session, runner } = makeSession();
		runner.calls = [];
		session.write("\x03");
		const sk = runner.findCalls("send-keys");
		expect(sk).toHaveLength(1);
		expect(sk[0]!.args).not.toContain("-l");
		expect(sk[0]!.args).toContain("C-c");
		session.dispose();
	});

	it("mixed input emits multiple send-keys invocations in order", () => {
		const { session, runner } = makeSession();
		runner.calls = [];
		session.write("ls\r\x03y\r");
		const sk = runner.findCalls("send-keys");
		expect(sk).toHaveLength(3);
		expect(sk[0]!.args).toContain("-l");
		expect(sk[0]!.args).toContain("ls\r");
		expect(sk[1]!.args).toContain("C-c");
		expect(sk[2]!.args).toContain("-l");
		expect(sk[2]!.args).toContain("y\r");
		session.dispose();
	});

	it("write after exit is silently dropped", () => {
		const { session, runner } = makeSession();
		session._simulateReaderExit();
		runner.calls = [];
		session.write("anything");
		expect(runner.findCalls("send-keys")).toHaveLength(0);
	});

	it("write after dispose is silently dropped", () => {
		const { session, runner } = makeSession();
		session.dispose();
		runner.calls = [];
		session.write("anything");
		expect(runner.findCalls("send-keys")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

describe("resize", () => {
	it("forwards to tmux resize-pane and updates internal cols/rows", () => {
		const { session, runner } = makeSession();
		runner.calls = [];
		session.resize(120, 40);
		const rp = runner.findCalls("resize-pane");
		expect(rp).toHaveLength(1);
		expect(rp[0]!.args).toContain("-x");
		expect(rp[0]!.args).toContain("120");
		expect(rp[0]!.args).toContain("-y");
		expect(rp[0]!.args).toContain("40");
		expect(session.cols).toBe(120);
		expect(session.rows).toBe(40);
		session.dispose();
	});

	it("ignores zero/negative dimensions", () => {
		const { session, runner } = makeSession();
		runner.calls = [];
		session.resize(0, 24);
		session.resize(80, 0);
		session.resize(-1, -1);
		expect(runner.findCalls("resize-pane")).toHaveLength(0);
		session.dispose();
	});
});
