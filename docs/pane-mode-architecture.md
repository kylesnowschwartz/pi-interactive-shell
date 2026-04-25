# `render: "pane"` — architecture brief

> **Audience:** the two background agents implementing the push and pull bake-off candidates. Read this before writing code. Treat it as a contract: anything the dispatcher consumes from `PtyTerminalSession` today, your `PtyPaneSession` MUST also expose with identical semantics. Anything else is implementation detail.

## 1. Goal

Add an opt-in alternative render target to `pi-interactive-shell`. Instead of spawning the target process inside an `@xterm/headless` buffer that pi renders as an overlay, spawn it inside a sibling tmux pane and mirror its output back into a buffer the existing dispatcher already knows how to query.

The buffer abstraction is the seam. Everything downstream of the buffer (monitor triggers, dispatch polling, hands-free supervision, session-query replies) is unchanged.

## 2. Schema (already decided)

A new top-level optional param `render: "overlay" | "pane"` (default `"overlay"`), orthogonal to `mode`. Pane-specific options live under `pane: {…}`:

```ts
interactive_shell({
  command: "claude",
  render: "pane",          // NEW. "overlay" | "pane". default "overlay".
  mode: "dispatch",        // unchanged. "interactive" | "hands-free" | "dispatch" | "monitor"
  pane: {                  // NEW. only consulted when render === "pane".
    layout: "right",       // "right" | "left" | "below" | "above". default "right".
    sizePercent: 50,       // 1..99. default 50.
    title: "claude",       // pane title. default = first token of command.
    select: false,         // focus pane on creation. default false.
  },
  reason: "Run claude side-by-side",
})
```

Every existing `mode` value MUST work on top of `render: "pane"`. Outside a tmux session, `render: "pane"` returns a hard error pointing the user at `render: "overlay"`. Do not silently degrade.

## 3. Public surface to satisfy

`PtyPaneSession` must expose every method the rest of the codebase calls on `PtyTerminalSession`. The set was extracted by grepping consumers (`session-query.ts`, `headless-monitor.ts`, `session-manager.ts`, `overlay-component.ts`, `reattach-overlay.ts`, `index.ts`):

### Construction
```ts
new PtyPaneSession(options: PtyPaneSessionOptions, events?: PtySessionEvents)
```

`PtyPaneSessionOptions` extends `PtySessionOptions` with the resolved `pane` block:
```ts
interface PtyPaneSessionOptions extends PtySessionOptions {
  pane: {
    layout: "right" | "left" | "below" | "above";
    sizePercent: number;     // 1..99
    title?: string;
    select?: boolean;
  };
}
```

### State (read-only getters)
- `exited: boolean`
- `exitCode: number | null`
- `signal: number | undefined`
- `pid: number` — pane's process pid (from `tmux display -p -t <pane> '#{pane_pid}'`)
- `cols: number`
- `rows: number`

### Lifecycle
- `kill(signal?: string): void` — send signal to the pane's process AND `tmux kill-pane -t <pane>`.
- `dispose(): void` — kill, close pipe, remove fifo (if any), unregister listeners.

### Listeners
- `setEventHandlers(events: PtySessionEvents): void`
- `addDataListener(cb: (data: string) => void): () => void`
- `addExitListener(cb: (exitCode: number, signal?: number) => void): () => void`

### I/O
- `write(data: string): void` — input to the pane via `tmux send-keys`. See §6 for semantics.
- `resize(cols: number, rows: number): void` — best effort. v1 may be a no-op or a `tmux resize-pane`. Document whichever you pick.

### Buffer queries (these are what monitor/dispatch actually use)
- `getViewportLines(opts?: { ansi?: boolean }): string[]`
- `getTailLines(opts: { lines: number; ansi?: boolean; maxChars?: number }): { lines: string[]; totalLinesInBuffer: number; truncatedByChars: boolean }`
- `getRawStream(opts?: { sinceLast?: boolean; stripAnsi?: boolean }): string`
- `getLogSlice(opts?: { offset?: number; limit?: number; stripAnsi?: boolean }): { slice: string; totalLines: number; totalChars: number; sliceLineCount: number }`

### Scrolling (overlay/reattach use these — for pane mode they MAY be no-ops)
- `scrollUp(n: number): void`
- `scrollDown(n: number): void`
- `scrollToBottom(): void`
- `isScrolledUp(): boolean`

User scrolling already happens in the real tmux pane natively; mirroring scroll into our buffer is not required for v1. Document the choice clearly.

### Field on session result
- `paneId: string` — the `%N` id returned by `tmux split-window -P -F '#{pane_id}'`. Surface it in the dispatcher's return for diagnostics.

## 4. The two implementations

You are one of two agents. The other is implementing the *opposite* approach. Do not coordinate — divergence is the point. Both implementations live in their own git worktree on their own branch, and a winner is picked empirically.

### Approach A — push (`feat/tmux-pane-mode-push`)
- `tmux split-window -d -P -F '#{pane_id}' <-h|-v> [-b] -l <pct>% -- <shell> -c <command>` to create the pane.
- `tmux pipe-pane -o -t <pane> 'cat > <fifo>'` to push pane output into a fifo.
- Read the fifo via `fs.createReadStream` (or `open` with O_RDWR to keep open across writers); feed bytes into a local `@xterm/headless` instance EXACTLY like `pty-session.ts` does today. Reuse the existing terminal/serializer/raw-buffer plumbing — the only thing that changes is the source of bytes.
- Detect pane death via either `tmux wait-for` on a pane hook, or polling `tmux list-panes -F '#{pane_id}'` at low rate. Document your choice.

### Approach B — pull (`feat/tmux-pane-mode-pull`)
- Same `split-window` invocation.
- No fifo. Instead, on a ~10Hz timer:
  - `tmux capture-pane -p -e -J -t <pane> -S - -E -` to snapshot full pane content (with ANSI escape sequences) to stdout.
  - Diff against the previous snapshot. Treat appended lines as new output. Synthesize a `chunk` and feed your buffer + dataListeners.
- You may keep `@xterm/headless` (re-feeding the diff) OR skip it entirely and serve buffer queries directly from snapshots. **Document and justify whichever you pick.**
- Pane death: `capture-pane` returns non-zero when the pane is gone; treat that as the exit signal.

## 5. Dispatch seam in `index.ts`

`PtyTerminalSession` is constructed in three places:
1. `index.ts:818` — monitor mode session.
2. `index.ts:844` — `mode: "dispatch" && background` session.
3. `overlay-component.ts:134` — interactive overlay session.

For Phase 0 you do NOT need to wire any of these to your new class. **Do not touch `index.ts`.** Build `pty-pane-session.ts` (or whatever you name it) as a standalone module. The bake-off harness is allowed to construct it directly. Phase 1 wires the winner to the dispatcher behind `render === "pane"`.

The existing schema accepts `mode` only; adding `render` to the schema is also a Phase 1 task, not Phase 0.

## 6. tmux command reference (relevant flags only)

These are the tmux 3.6a flags you'll actually use. Sourced from `.cloned-sources/tmux/tmux.1`. Read the full sections there if you hit edge cases.

### `split-window`
- `-h` horizontal split (left/right). `-v` vertical (top/bottom). Default `-v`.
- `-b` create new pane *before* (left/above) target. Without `-b`, new pane is right/below.
- `-d` create pane WITHOUT focusing it. **This is our default — matches `select: false`.**
- `-P` print info about new pane to stdout.
- `-F '#{pane_id}'` format used with `-P`. Returns something like `%5`. **This is your handle.**
- `-l 50%` size as a percentage of available space. Use the resolved `pane.sizePercent`.
- `-c <dir>` cwd for the new pane.
- `-e KEY=VAL` env var for the new pane (repeatable).
- `-t <target>` target pane to split (defaults to current — i.e., the pi pane).
- Trailing `<shell> -c <command>` runs your command. Don't use `bash -c "..."` blindly; respect the user's `$SHELL` like `pty-session.ts` does at line 186-191.

### Layout mapping
- `pane.layout: "right"` → `tmux split-window -h ...` (no `-b`)
- `pane.layout: "left"`  → `tmux split-window -h -b ...`
- `pane.layout: "below"` → `tmux split-window -v ...` (no `-b`)
- `pane.layout: "above"` → `tmux split-window -v -b ...`

### `pipe-pane` (push only)
- `-O` (default if neither `-I` nor `-O`) — pipe pane stdout TO `shell-command`'s stdin. **This is what we want.**
- `-I` — pipe `shell-command`'s stdout INTO pane (acts like typed input). NOT what we want.
- `-o` — only open if no previous pipe exists. Useful if you want idempotency.
- A pane has at most one pipe. Re-invoking with a new `shell-command` replaces the previous pipe.
- Empty `shell-command` closes the existing pipe.
- The `shell-command` accepts tmux format strings (status-left style); be careful with `#` and `[`.

### `capture-pane` (pull only)
- `-p` — print to stdout (instead of buffer).
- `-e` — include ANSI escape sequences for text and background attributes. **Important for monitor-trigger fidelity.**
- `-J` — preserve trailing spaces and join wrapped lines. Implies `-T`.
- `-N` — preserve trailing spaces per line.
- `-S <line>` — start line. `0` = top of visible. Negative = into history. `-` = start of full history.
- `-E <line>` — end line. `-` = end of visible.
- Default with no `-S`/`-E`: visible pane only.
- For full content: `tmux capture-pane -p -e -J -S - -E -`.

### `send-keys`
- Default: arg interpreted as a key name (`C-a`, `NPage`, `Enter`, `Escape`, etc.). Unrecognized strings fall through as literal characters.
- `-l` — disable key-name lookup; send as **literal UTF-8 characters**. **Use this for typing arbitrary text.**
- `-H` — hex bytes for ASCII chars (e.g. `0x1b` for ESC). Useful for raw escape sequences.
- `-R` — reset terminal state before sending.
- Multiple keys are sent in order in one invocation.

**Recommended `write()` strategy:**
- If the agent passes a string of literal text (no key-name semantics): `tmux send-keys -t <pane> -l -- '<text>'`.
- For keys + text mixing, you'll likely receive translated input from the existing `key-encoding.ts` layer. Reuse that translation table where possible. Bracketed paste (`\x1b[200~ ... \x1b[201~`) sent literally with `-l` works fine.
- See the existing `pty-session.ts` `write()` for the upstream contract.

### `kill-pane`
- `tmux kill-pane -t <pane>` — destroy the pane and reap its process. Sufficient for `dispose()`.

### `display-message` (for pane metadata)
- `tmux display-message -p -t <pane> '#{pane_pid}'` → process pid.
- `tmux display-message -p -t <pane> '#{pane_width}x#{pane_height}'` → cols x rows. Use this to seed the xterm-headless dimensions in approach A.

### `set-option` (for pane title)
- `tmux select-pane -t <pane> -T '<title>'` sets the pane title. Only visible if user has `set -g pane-border-status top`. Set it unconditionally; it's metadata.

## 7. Risks specific to your approach

### Push (A)
- **Fifo lifecycle.** Open the fifo for reading BEFORE invoking `pipe-pane` (otherwise the writer blocks). Use `fs.openSync(fifoPath, fs.constants.O_RDWR)` to keep it open across teardowns. Sweep `${TMPDIR:-/tmp}/pi-interactive-shell/` for stale fifos on construction.
- **Pipe-pane format-string surprises.** If the user's command path or pane id contains `#`, tmux may interpret it. Quote your `shell-command` carefully. Prefer `cat >> "<absolute fifo path>"` with the path containing only safe characters.
- **Double emulation.** tmux already emulates the terminal, but you're re-feeding the bytes into `@xterm/headless`. This is the same model as the existing PTY path, so most edge cases are already handled — but watch for color/cursor drift on a noisy fixture.

### Pull (B)
- **Sampling lag.** 10Hz means ~100ms worst case between pane stdout write and agent visibility. Document this. Confirm it doesn't break dispatch's `autoExitOnQuiet` heuristics.
- **Diffing semantics.** `capture-pane` returns the whole visible pane (or the requested range). When the pane scrolls past the visible region, lines move up. Your diff strategy must handle that without double-counting or losing history. One option: use `-S - -E -` to always capture full history, treat the captured text as the canonical buffer, and synthesize "new bytes" as the suffix beyond the previous capture's length.
- **No raw escape stream.** You won't see DSR queries, OSC sequences, etc. Some monitor triggers depend on this. Verify against the §8 fixture.
- **No pty.** `write()` via `send-keys` is your input path; there is no fd you can `write()` to. That's fine, but document it — agents who think they have a pty will be surprised.

### Both
- **Pane killed by user.** The user can `prefix+x` the pane out from under you. Detect quickly (within one polling tick or via a tmux hook) and emit an exit event. Do not leak the listening process.
- **Concurrent sessions.** Each pane gets a unique `%N` from tmux. Namespace fifos / state by session id so two simultaneous panes don't collide.
- **`$TMUX` absent.** Throw a clear error on construction. Suggested message: `"render: \"pane\" requires running pi inside a tmux session. Either start tmux or use render: \"overlay\"."`

## 8. Bake-off fixtures (Phase 0 exit criterion)

Both implementations must run the same fixture suite. Results recorded in `docs/pane-mode-bakeoff.md` (one section per implementation). Comparison decides the winner.

### Fixture 1 — fidelity
Spawn `bash -c 'for i in 1 2 3 4 5; do printf "\x1b[31mline %d\x1b[0m\n" $i; sleep 0.1; done'` in the pane. After it exits, call `getTailLines({ lines: 10, ansi: true })`. Expected: 5 colored lines, ANSI intact.

### Fixture 2 — monitor-trigger fidelity
Spawn a noisier program (e.g., `vim -e -c 'echo "x"' -c quit` or `bash -c 'for i in $(seq 1 50); do echo line-$i; done'`). Configure a monitor with a literal trigger on `line-25` and a regex trigger on `/line-(\d+)/`. Both implementations must fire the same number of events with the same payload.

### Fixture 3 — input round-trip
For each of: literal multiline text (`hello\nworld`), named keys (`Enter`, `C-c`), modifier combo (`C-w v` if running vim — otherwise `C-l`), bracketed paste (`\x1b[200~paste\x1b[201~`), call `write()` and verify the rendered pane buffer reflects what was sent.

### Fixture 4 — token cost
Run a 60-second `seq 1 600 | while read i; do echo $i; sleep 0.1; done` workload in dispatch+autoExit mode. Sum the bytes returned by `getTailLines({ lines: 20 })` calls if invoked once a second. Lower is better, all else equal.

### Fixture 5 — crash recovery
Three scenarios. Each must leave zero leaked processes/fifos (verified by `tmux list-panes`, `pgrep`, `ls /tmp/pi-interactive-shell/`):
1. Agent calls `dispose()` cleanly.
2. User runs `tmux kill-pane -t <pane>` externally.
3. The harness sends SIGTERM to the agent process mid-session.

### Fixture 6 — latency
`bash -c 'echo START; sleep 1; echo END'`. Measure wall-clock from `spawn` → first dataListener invocation containing `END`. Lower is better.

## 9. Deliverables per agent

In your worktree:
1. `pty-pane-session.ts` — the implementation.
2. `tests/pty-pane-session.test.ts` — unit tests for command construction (mock `child_process.spawn` / `child_process.execFile`), input encoding, and buffer queries.
3. `tests/pty-pane-session.integration.test.ts` — gated on `process.env.TMUX`; runs at least Fixture 1 and Fixture 3 end-to-end.
4. `docs/pane-mode-bakeoff.md` — your section: implementation summary, fixture results table, known limitations, total LOC.
5. The existing test suite still passes. Run `npm test` before declaring done.

DO NOT modify `index.ts`, `tool-schema.ts`, or `overlay-component.ts`. Phase 1 wiring is out of scope.

## 10. Reference reading order

1. This document.
2. `pty-session.ts` — the contract you're shadowing.
3. `headless-monitor.ts` — the most demanding consumer; understand what your buffer must support.
4. `key-encoding.ts` — the input translation table you should reuse where possible.
5. `.cloned-sources/tmux/tmux.1` — for any tmux flag question.
