import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCapturePaneArgs,
	buildKillPaneArgs,
	buildSendKeysLiteralArgs,
	buildSplitWindowArgs,
	type TmuxResult,
	type TmuxRunOptions,
	type TmuxRunner,
} from "../tmux-cli.js";
import { PtyPaneSession, type PtyPaneSessionOptions } from "../pty-pane-session.js";

class StubRunner implements TmuxRunner {
	calls: Array<{ args: string[]; opts?: TmuxRunOptions }> = [];
	queue: Array<(args: string[], opts?: TmuxRunOptions) => TmuxResult> = [];
	defaultResponse: (args: string[]) => TmuxResult;

	constructor() {
		this.defaultResponse = (args) => ({
			stdout: args[0] === "split-window" ? "%42\n" : "",
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

	findCall(predicate: (args: string[]) => boolean): { args: string[]; opts?: TmuxRunOptions } | undefined {
		return this.calls.find((c) => predicate(c.args));
	}
}

const TMUX_ENV: Record<string, string | undefined> = {
	TMUX: "/private/tmp/tmux-501/default,1234,0",
	SHELL: "/bin/bash",
	TERM: "xterm-256color",
};

function makeSession(
	opts: Partial<PtyPaneSessionOptions> | undefined = undefined,
	runner?: StubRunner,
): { session: PtyPaneSession; runner: StubRunner } {
	const r = runner ?? new StubRunner();
	const merged: PtyPaneSessionOptions = {
		command: "echo hi",
		pane: { layout: "right", sizePercent: 50 },
		pollIntervalMs: 1000,
		tmuxRunner: r,
		envSnapshot: TMUX_ENV,
		...(opts ?? {}),
	};
	const session = new PtyPaneSession(merged);
	return { session, runner: r };
}

describe("buildSplitWindowArgs", () => {
	it("encodes layout/size/cwd/env/shell/command into argv", () => {
		const args = buildSplitWindowArgs({
			layout: "right",
			sizePercent: 50,
			cwd: "/tmp",
			env: { FOO: "bar" },
			shell: "/bin/zsh",
			command: "echo hi",
		});
		expect(args).toEqual([
			"split-window", "-d", "-P", "-F", "#{pane_id}",
			"-h",
			"-l", "50%",
			"-c", "/tmp",
			"-e", "FOO=bar",
			"--", "/bin/zsh", "-c", "echo hi",
		]);
	});

	it("uses -h -b for left and -v -b for above", () => {
		const left = buildSplitWindowArgs({ layout: "left", sizePercent: 30, shell: "/bin/sh", command: "x" });
		expect(left.slice(0, 8)).toEqual(["split-window", "-d", "-P", "-F", "#{pane_id}", "-h", "-b", "-l"]);
		const above = buildSplitWindowArgs({ layout: "above", sizePercent: 70, shell: "/bin/sh", command: "x" });
		expect(above.slice(0, 8)).toEqual(["split-window", "-d", "-P", "-F", "#{pane_id}", "-v", "-b", "-l"]);
	});

	it("clamps sizePercent into [1, 99]", () => {
		const tooBig = buildSplitWindowArgs({ layout: "right", sizePercent: 999, shell: "/bin/sh", command: "x" });
		expect(tooBig).toContain("99%");
		const tooSmall = buildSplitWindowArgs({ layout: "right", sizePercent: 0, shell: "/bin/sh", command: "x" });
		expect(tooSmall).toContain("1%");
	});

	it("never lets the command argv be parsed by a shell — passes a single argv slot", () => {
		const args = buildSplitWindowArgs({
			layout: "right",
			sizePercent: 50,
			shell: "/bin/sh",
			command: "echo $FOO; rm -rf /",
		});
		// The dangerous string lives as a single argv element. It is never
		// concatenated with surrounding flags. The shell `/bin/sh -c` inside
		// the new pane is what evaluates it — that is the correct boundary.
		expect(args[args.length - 1]).toBe("echo $FOO; rm -rf /");
		expect(args[args.length - 2]).toBe("-c");
		expect(args[args.length - 3]).toBe("/bin/sh");
	});
});

describe("buildCapturePaneArgs", () => {
	it("includes -p -e -J and full-history -S - -E -", () => {
		expect(buildCapturePaneArgs("%5")).toEqual(["capture-pane", "-p", "-e", "-J", "-t", "%5", "-S", "-", "-E", "-"]);
	});
});

describe("buildSendKeysLiteralArgs", () => {
	it("uses -l -- so arbitrary text never triggers tmux key parsing", () => {
		expect(buildSendKeysLiteralArgs("%7", "C-c is not a key here")).toEqual([
			"send-keys", "-t", "%7", "-l", "--", "C-c is not a key here",
		]);
	});

	it("passes bracketed-paste markers through unchanged", () => {
		const text = "\x1b[200~paste\x1b[201~";
		const args = buildSendKeysLiteralArgs("%7", text);
		expect(args[args.length - 1]).toBe(text);
	});
});

describe("PtyPaneSession construction", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("throws outside tmux", () => {
		expect(() => new PtyPaneSession({
			command: "x",
			pane: { layout: "right", sizePercent: 50 },
			tmuxRunner: new StubRunner(),
			envSnapshot: { TMUX: undefined },
		})).toThrow(/render: "pane" requires/);
	});

	it("invokes split-window with expected argv and stores returned pane id", () => {
		const runner = new StubRunner();
		runner.push((args) => {
			expect(args[0]).toBe("split-window");
			expect(args).toContain("-d");
			expect(args).toContain("-P");
			return { stdout: "%9\n", stderr: "", exitCode: 0 };
		});
		const { session } = makeSession({}, runner);
		expect(session.paneId).toBe("%9");
		session.dispose();
	});

	it("populates pid from display-message #{pane_pid}", () => {
		const runner = new StubRunner();
		runner.push(() => ({ stdout: "%9\n", stderr: "", exitCode: 0 })); // split-window
		runner.push(() => ({ stdout: "12345\n", stderr: "", exitCode: 0 })); // display-message
		const { session } = makeSession(undefined, runner);
		expect(session.pid).toBe(12345);
		session.dispose();
	});

	it("kills the pane on dispose", () => {
		const { session, runner } = makeSession();
		session.dispose();
		const killCall = runner.findCall((a) => a[0] === "kill-pane");
		expect(killCall).toBeDefined();
		expect(killCall!.args).toEqual(buildKillPaneArgs(session.paneId));
	});
});

describe("PtyPaneSession write encoding", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

	it("uses -l -- for arbitrary input bytes", () => {
		const { session, runner } = makeSession();
		session.write("hello\nworld");
		const sendCall = runner.findCall((a) => a[0] === "send-keys");
		expect(sendCall).toBeDefined();
		expect(sendCall!.args).toEqual(["send-keys", "-t", session.paneId, "-l", "--", "hello\nworld"]);
		session.dispose();
	});

	it("forwards bracketed-paste markers verbatim", () => {
		const { session, runner } = makeSession();
		const paste = "\x1b[200~hi\x1b[201~";
		session.write(paste);
		const sendCall = runner.findCall((a) => a[0] === "send-keys");
		expect(sendCall!.args[sendCall!.args.length - 1]).toBe(paste);
		session.dispose();
	});

	it("does not call send-keys for an empty string", () => {
		const { session, runner } = makeSession();
		session.write("");
		expect(runner.findCall((a) => a[0] === "send-keys")).toBeUndefined();
		session.dispose();
	});
});

describe("PtyPaneSession snapshot diff", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

	it("emits only the appended suffix when the new capture extends the old one", async () => {
		const runner = new StubRunner();
		// split-window
		runner.push(() => ({ stdout: "%1\n", stderr: "", exitCode: 0 }));
		// display-message pid (allow non-zero)
		runner.push(() => ({ stdout: "111\n", stderr: "", exitCode: 0 }));
		// First capture-pane (immediate microtask tick)
		runner.push(() => ({ stdout: "first line", stderr: "", exitCode: 0 }));
		// Second capture-pane (timer-driven tick)
		runner.push(() => ({ stdout: "first line\nsecond line", stderr: "", exitCode: 0 }));

		const chunks: string[] = [];
		const session = new PtyPaneSession(
			{
				command: "x",
				pane: { layout: "right", sizePercent: 50 },
				pollIntervalMs: 50,
				tmuxRunner: runner,
				envSnapshot: TMUX_ENV,
			},
			{ onData: (d) => chunks.push(d) },
		);

		// Drain the queueMicrotask immediate tick.
		await Promise.resolve();
		await Promise.resolve();
		// Drive the interval forward.
		vi.advanceTimersByTime(60);
		await Promise.resolve();

		expect(chunks.length).toBeGreaterThanOrEqual(2);
		// First chunk is the entire first capture (existing rawOutput is empty).
		expect(chunks[0]).toBe("first line");
		// Second chunk is the appended suffix only.
		expect(chunks[1].includes("second line")).toBe(true);
		expect(chunks[1].includes("first line")).toBe(false);

		session.dispose();
	});

	it("treats prefix divergence as a full replay rather than risk double-counting", async () => {
		const runner = new StubRunner();
		runner.push(() => ({ stdout: "%2\n", stderr: "", exitCode: 0 }));
		runner.push(() => ({ stdout: "111\n", stderr: "", exitCode: 0 }));
		runner.push(() => ({ stdout: "alpha", stderr: "", exitCode: 0 }));
		// Prefix changes: history rolled.
		runner.push(() => ({ stdout: "beta gamma", stderr: "", exitCode: 0 }));

		const chunks: string[] = [];
		const session = new PtyPaneSession(
			{
				command: "x",
				pane: { layout: "right", sizePercent: 50 },
				pollIntervalMs: 50,
				tmuxRunner: runner,
				envSnapshot: TMUX_ENV,
			},
			{ onData: (d) => chunks.push(d) },
		);

		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(60);
		await Promise.resolve();

		expect(chunks.length).toBe(2);
		expect(chunks[1].includes("beta gamma")).toBe(true);
		session.dispose();
	});

	it("emits exit when capture-pane returns non-zero (pane gone)", async () => {
		const runner = new StubRunner();
		runner.push(() => ({ stdout: "%3\n", stderr: "", exitCode: 0 }));
		runner.push(() => ({ stdout: "111\n", stderr: "", exitCode: 0 }));
		runner.push(() => ({ stdout: "still alive", stderr: "", exitCode: 0 }));
		// Pane vanished:
		runner.push(() => ({ stdout: "", stderr: "can't find pane", exitCode: 1 }));

		const exits: Array<{ code: number; signal?: number }> = [];
		const session = new PtyPaneSession(
			{
				command: "x",
				pane: { layout: "right", sizePercent: 50 },
				pollIntervalMs: 50,
				tmuxRunner: runner,
				envSnapshot: TMUX_ENV,
			},
			{ onExit: (code, signal) => exits.push({ code, signal }) },
		);

		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(60);
		await Promise.resolve();

		expect(session.exited).toBe(true);
		expect(session.exitCode).toBe(0);
		expect(exits.length).toBe(1);
		session.dispose();
	});
});

describe("PtyPaneSession buffer surface", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

	it("getRawStream returns buffered text and supports sinceLast incremental reads", async () => {
		const runner = new StubRunner();
		runner.push(() => ({ stdout: "%5\n", stderr: "", exitCode: 0 }));
		runner.push(() => ({ stdout: "111\n", stderr: "", exitCode: 0 }));
		runner.push(() => ({ stdout: "hello", stderr: "", exitCode: 0 }));
		runner.push(() => ({ stdout: "hello\nworld", stderr: "", exitCode: 0 }));

		const session = new PtyPaneSession(
			{
				command: "x",
				pane: { layout: "right", sizePercent: 50 },
				pollIntervalMs: 50,
				tmuxRunner: runner,
				envSnapshot: TMUX_ENV,
			},
		);

		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(60);
		await Promise.resolve();

		const all = session.getRawStream({ stripAnsi: false });
		expect(all.includes("hello")).toBe(true);
		expect(all.includes("world")).toBe(true);

		const since1 = session.getRawStream({ sinceLast: true, stripAnsi: false });
		expect(since1.length).toBeGreaterThan(0);
		const since2 = session.getRawStream({ sinceLast: true, stripAnsi: false });
		expect(since2).toBe("");

		session.dispose();
	});
});
