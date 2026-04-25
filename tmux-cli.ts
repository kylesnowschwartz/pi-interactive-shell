import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

/**
 * Argv-only wrapper around the tmux binary.
 *
 * Every public method funnels through `runTmux`, which calls `execFileSync`
 * with an array of arguments — never a shell string — so user-supplied
 * commands and pane ids can never be interpreted by a shell. Errors are
 * normalised to `TmuxError`, exposing exitCode and stderr separately so
 * pane-death detection (capture-pane returning non-zero, list-panes not
 * containing a pane id) can be done with a single try/catch.
 */

export interface TmuxRunner {
	runTmux(args: string[], opts?: TmuxRunOptions): TmuxResult;
}

export interface TmuxRunOptions {
	input?: string;
	maxBuffer?: number;
	timeoutMs?: number;
	allowNonZeroExit?: boolean;
}

export interface TmuxResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class TmuxError extends Error {
	exitCode: number;
	stderr: string;
	constructor(message: string, exitCode: number, stderr: string) {
		super(message);
		this.name = "TmuxError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export class DefaultTmuxRunner implements TmuxRunner {
	constructor(private readonly tmuxBinary: string = "tmux") {}

	runTmux(args: string[], opts: TmuxRunOptions = {}): TmuxResult {
		const execOptions: ExecFileSyncOptions = {
			maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
			timeout: opts.timeoutMs,
			encoding: "buffer",
			input: opts.input,
			stdio: ["pipe", "pipe", "pipe"],
		};
		try {
			const stdoutBuf = execFileSync(this.tmuxBinary, args, execOptions) as Buffer;
			return {
				stdout: stdoutBuf.toString("utf8"),
				stderr: "",
				exitCode: 0,
			};
		} catch (err) {
			const e = err as NodeJS.ErrnoException & { status?: number; stdout?: Buffer; stderr?: Buffer };
			const exitCode = typeof e.status === "number" ? e.status : 1;
			const stdout = e.stdout instanceof Buffer ? e.stdout.toString("utf8") : "";
			const stderr = e.stderr instanceof Buffer ? e.stderr.toString("utf8") : (e.message ?? "");
			if (opts.allowNonZeroExit) {
				return { stdout, stderr, exitCode };
			}
			throw new TmuxError(
				`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || e.message}`,
				exitCode,
				stderr,
			);
		}
	}
}

/**
 * Build the argv for `tmux split-window -d -P -F '#{pane_id}'`.
 *
 * The `-d` flag is unconditional — focus is granted later via `select-pane`
 * when the caller asks for it. `-P -F '#{pane_id}'` is what gives us a
 * stable handle (`%N`) to address the new pane.
 */
export interface SplitWindowArgs {
	layout: "right" | "left" | "below" | "above";
	sizePercent: number;
	cwd?: string;
	env?: Record<string, string>;
	shell: string;
	command: string;
	target?: string;
}

export function buildSplitWindowArgs(args: SplitWindowArgs): string[] {
	const out: string[] = ["split-window", "-d", "-P", "-F", "#{pane_id}"];

	const horizontal = args.layout === "right" || args.layout === "left";
	out.push(horizontal ? "-h" : "-v");
	if (args.layout === "left" || args.layout === "above") {
		out.push("-b");
	}

	const pct = clampPercent(args.sizePercent);
	out.push("-l", `${pct}%`);

	if (args.cwd) {
		out.push("-c", args.cwd);
	}

	if (args.env) {
		for (const [key, value] of Object.entries(args.env)) {
			if (value === undefined || value === null) continue;
			out.push("-e", `${key}=${value}`);
		}
	}

	if (args.target) {
		out.push("-t", args.target);
	}

	out.push("--", args.shell, "-c", args.command);
	return out;
}

function clampPercent(n: number): number {
	if (!Number.isFinite(n)) return 50;
	const clamped = Math.max(1, Math.min(99, Math.round(n)));
	return clamped;
}

export function buildCapturePaneArgs(paneId: string): string[] {
	return ["capture-pane", "-p", "-e", "-J", "-t", paneId, "-S", "-", "-E", "-"];
}

export function buildKillPaneArgs(paneId: string): string[] {
	return ["kill-pane", "-t", paneId];
}

export function buildListPanesArgs(): string[] {
	return ["list-panes", "-a", "-F", "#{pane_id}"];
}

export function buildDisplayMessageArgs(paneId: string, format: string): string[] {
	return ["display-message", "-p", "-t", paneId, format];
}

export function buildSelectPaneArgs(paneId: string, opts: { focus?: boolean; title?: string }): string[] {
	const out: string[] = ["select-pane", "-t", paneId];
	if (opts.title !== undefined) {
		out.push("-T", opts.title);
	}
	return out;
}

export function buildSendKeysLiteralArgs(paneId: string, text: string): string[] {
	return ["send-keys", "-t", paneId, "-l", "--", text];
}

export function buildSendKeysNamedArgs(paneId: string, keys: string[]): string[] {
	return ["send-keys", "-t", paneId, ...keys];
}

export function buildResizePaneArgs(paneId: string, cols: number, rows: number): string[] {
	return ["resize-pane", "-t", paneId, "-x", String(Math.max(1, Math.trunc(cols))), "-y", String(Math.max(1, Math.trunc(rows)))];
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
	return typeof env.TMUX === "string" && env.TMUX.length > 0;
}
