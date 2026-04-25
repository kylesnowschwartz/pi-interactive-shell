/**
 * Thin wrapper around the `tmux` command-line tool used by `PtyPaneSession`.
 *
 * All functions shell out via `child_process.execFileSync` (synchronous; we
 * pass argv directly to avoid shell quoting issues). Errors thrown by tmux
 * surface as standard `ExecFileSyncError` objects unless the helper returns
 * a Result-style payload.
 *
 * Keeping this surface area small and well-typed makes the session class
 * easier to unit-test: tests stub `child_process.execFileSync` with `vi.fn`
 * and assert on the argv that gets constructed here.
 */

import { execFileSync } from "node:child_process";

export type PaneLayout = "right" | "left" | "below" | "above";

export interface SplitWindowOptions {
	/** Layout direction relative to the target pane. */
	layout: PaneLayout;
	/** Percentage of available space (1..99). */
	sizePercent: number;
	/** Working directory of the new pane. Optional. */
	cwd?: string;
	/** Environment variables to inject into the new pane (repeatable). */
	env?: Record<string, string>;
	/** Shell to invoke (e.g. /bin/zsh). */
	shell: string;
	/** Args passed to the shell (typically ["-c", command]). */
	shellArgs: string[];
	/** Target pane to split (defaults to current). Optional. */
	target?: string;
}

export interface PaneStatus {
	/** Whether the pane process is dead (only set when remain-on-exit is on). */
	dead: boolean;
	/** Exit status of the dead pane process, or null if not exited. */
	exitStatus: number | null;
	/** Exit signal of the dead pane process, or null if not exited. */
	exitSignal: number | null;
}

export interface PaneSize {
	cols: number;
	rows: number;
}

/**
 * Runtime hooks that let tests substitute the `execFileSync` implementation
 * (and an optional `now()` for deterministic logging). Production code uses
 * the defaults.
 */
export interface TmuxRunner {
	execFileSync: typeof execFileSync;
}

const defaultRunner: TmuxRunner = { execFileSync };

function runTmux(runner: TmuxRunner, args: string[]): string {
	const buf = runner.execFileSync("tmux", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return typeof buf === "string" ? buf : buf.toString("utf8");
}

function tryRunTmux(runner: TmuxRunner, args: string[]): { ok: true; stdout: string } | { ok: false; error: Error } {
	try {
		return { ok: true, stdout: runTmux(runner, args) };
	} catch (error) {
		return { ok: false, error: error as Error };
	}
}

/** Return whether the current process is running inside a tmux session. */
export function inTmuxSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return typeof env.TMUX === "string" && env.TMUX.length > 0;
}

/**
 * Construct the argv for `tmux split-window` per the architecture brief.
 * Exposed so unit tests can assert the exact tmux invocation we build.
 */
export function buildSplitWindowArgs(options: SplitWindowOptions): string[] {
	const args: string[] = ["split-window", "-d", "-P", "-F", "#{pane_id}"];

	switch (options.layout) {
		case "right":
			args.push("-h");
			break;
		case "left":
			args.push("-h", "-b");
			break;
		case "below":
			args.push("-v");
			break;
		case "above":
			args.push("-v", "-b");
			break;
	}

	const pct = Math.max(1, Math.min(99, Math.round(options.sizePercent)));
	args.push("-l", `${pct}%`);

	if (options.cwd) {
		args.push("-c", options.cwd);
	}

	if (options.env) {
		for (const [key, value] of Object.entries(options.env)) {
			args.push("-e", `${key}=${value}`);
		}
	}

	if (options.target) {
		args.push("-t", options.target);
	}

	// `--` is not strictly required (tmux already terminates flag parsing at
	// the first non-flag arg), but it keeps argv parsing unambiguous if the
	// shell path begins with `-`.
	args.push("--", options.shell, ...options.shellArgs);
	return args;
}

/** Spawn a new pane and return its `%N` id. Throws on tmux failure. */
export function splitWindow(options: SplitWindowOptions, runner: TmuxRunner = defaultRunner): string {
	const stdout = runTmux(runner, buildSplitWindowArgs(options));
	const paneId = stdout.trim();
	if (!/^%\d+$/.test(paneId)) {
		throw new Error(`tmux split-window returned unexpected pane id: ${JSON.stringify(stdout)}`);
	}
	return paneId;
}

/** Attach a `pipe-pane` so the pane's stdout flows into our fifo. */
export function pipePaneToFifo(paneId: string, fifoPath: string, runner: TmuxRunner = defaultRunner): void {
	// The `cat >> "<fifo>"` redirect runs under a shell tmux spawns. Using
	// `>>` (rather than `>`) means a transient pipe-pane reset doesn't
	// truncate the fifo (it can't anyway for a fifo, but the semantics are
	// safer and match the brief). The path is double-quoted so spaces or
	// shell-special characters in TMPDIR don't break the redirect.
	const command = `cat >> "${fifoPath.replace(/"/g, '\\"')}"`;
	runTmux(runner, ["pipe-pane", "-o", "-t", paneId, command]);
}

/** Detach any existing pipe-pane on the pane. */
export function unpipePane(paneId: string, runner: TmuxRunner = defaultRunner): void {
	tryRunTmux(runner, ["pipe-pane", "-t", paneId]);
}

/** Send literal UTF-8 bytes to the pane (no key-name lookup). */
export function sendKeysLiteral(paneId: string, data: string, runner: TmuxRunner = defaultRunner): void {
	if (!data) return;
	// `-l` is the universal "raw bytes" path. Escape sequences such as
	// `\x1b[A` (arrow up) or bracketed-paste markers are forwarded as-is to
	// the pane's pty, which is exactly what the upstream key-encoding layer
	// wants from `write()`.
	runTmux(runner, ["send-keys", "-t", paneId, "-l", "--", data]);
}

/** Send one or more named keys (`Enter`, `C-c`, etc) to the pane. */
export function sendKeysNamed(paneId: string, keys: string[], runner: TmuxRunner = defaultRunner): void {
	if (keys.length === 0) return;
	runTmux(runner, ["send-keys", "-t", paneId, ...keys]);
}

/** Mark the pane as `remain-on-exit` so we can read its exit status. */
export function setRemainOnExit(paneId: string, runner: TmuxRunner = defaultRunner): void {
	tryRunTmux(runner, ["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
}

/** Set a human-readable title on the pane (visible if pane-border-status is on). */
export function setPaneTitle(paneId: string, title: string, runner: TmuxRunner = defaultRunner): void {
	tryRunTmux(runner, ["select-pane", "-t", paneId, "-T", title]);
}

/** Focus the pane (used when the user opted in via `pane.select`). */
export function selectPane(paneId: string, runner: TmuxRunner = defaultRunner): void {
	tryRunTmux(runner, ["select-pane", "-t", paneId]);
}

/** Resize the pane (best effort; tmux may clamp to available space). */
export function resizePane(paneId: string, cols: number, rows: number, runner: TmuxRunner = defaultRunner): void {
	tryRunTmux(runner, ["resize-pane", "-t", paneId, "-x", String(cols), "-y", String(rows)]);
}

/** Kill the pane and reap its process. Idempotent (errors are swallowed). */
export function killPane(paneId: string, runner: TmuxRunner = defaultRunner): void {
	tryRunTmux(runner, ["kill-pane", "-t", paneId]);
}

/**
 * Read a tmux format string for a pane. Returns null when the pane no longer
 * exists (tmux exits non-zero).
 */
export function getPaneFormat(paneId: string, format: string, runner: TmuxRunner = defaultRunner): string | null {
	const result = tryRunTmux(runner, ["display-message", "-p", "-t", paneId, format]);
	if (!result.ok) return null;
	return result.stdout.replace(/\n$/, "");
}

/** Return current pane size, or null if the pane is gone. */
export function getPaneSize(paneId: string, runner: TmuxRunner = defaultRunner): PaneSize | null {
	const text = getPaneFormat(paneId, "#{pane_width}x#{pane_height}", runner);
	if (!text) return null;
	const match = /^(\d+)x(\d+)$/.exec(text);
	if (!match) return null;
	const cols = Number.parseInt(match[1], 10);
	const rows = Number.parseInt(match[2], 10);
	if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
	return { cols, rows };
}

/** Read the pane's process pid, or null if the pane is gone. */
export function getPanePid(paneId: string, runner: TmuxRunner = defaultRunner): number | null {
	const text = getPaneFormat(paneId, "#{pane_pid}", runner);
	if (!text) return null;
	const pid = Number.parseInt(text, 10);
	return Number.isFinite(pid) ? pid : null;
}

/**
 * Read pane life-cycle status (alive / dead / exit code / signal).
 * Returns null when the pane no longer exists at all (e.g. user killed it).
 */
export function getPaneStatus(paneId: string, runner: TmuxRunner = defaultRunner): PaneStatus | null {
	const text = getPaneFormat(paneId, "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}", runner);
	if (text === null) return null;
	const [deadField = "", statusField = "", signalField = ""] = text.split("|");
	const dead = deadField.trim() === "1";
	const exitStatus = parseOptionalInt(statusField);
	const exitSignal = parseOptionalInt(signalField);
	return { dead, exitStatus, exitSignal };
}

function parseOptionalInt(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) ? n : null;
}
