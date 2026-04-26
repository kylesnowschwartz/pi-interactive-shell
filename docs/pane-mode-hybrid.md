# Pane mode — hybrid architecture

This document describes the pane-mode implementation that ships in
`feat/tmux-pane-mode-hybrid`. It supersedes the bake-off implementations
on `feat/tmux-pane-mode-pull` and `feat/tmux-pane-mode-push`, both of
which are preserved on their branches for reference.

## TL;DR

`PtyPaneSession` runs the target process inside a sibling tmux pane.
The pane is constructed via `tmux split-window`. Output is captured
two ways, each used for the thing it's actually good at:

| Channel | Mechanism | Used for |
| --- | --- | --- |
| **Byte stream** | `tmux pipe-pane -O 'cat > $fifo'` → fifo → `cat $fifo` (child process) → parent stdout pipe | `addDataListener`, `getRawStream`, `getLogSlice`, monitor triggers |
| **Viewport snapshot** | `tmux capture-pane -p` synchronously on demand | `getViewportLines`, `getTailLines` |
| **Exit detection** | Wrapping shell writes exit code to a sidecar file before terminating; reader sees fifo EOF; we read the sidecar | `addExitListener`, `exited`, `exitCode` |

No diff. No shadow xterm buffer. No polling for output. No
`remain-on-exit`. No libuv-thread-strand testability bug.

## Why hybrid (not pull, not push)

Two earlier branches each tried a single approach end-to-end. Neither
worked.

### Pull (`feat/tmux-pane-mode-pull`) — capture-pane polling

Polled `tmux capture-pane` every 80 ms, diffed snapshots, fed the
diffs to a shadow `@xterm/headless` buffer, served queries from the
buffer.

Problem: **`capture-pane` returns the rendered viewport, not the
byte stream.** When a process emits ANSI cursor moves, line clears,
or in-place rewrites (any spinner, progress bar, status line, or TUI
redraw), the snapshots between two poll ticks lose all the
intermediate bytes — they were overwritten in tmux's pane buffer
before we could capture them. The diff path then has to *invent* a
plausible byte stream from before/after snapshots, and gets things
like same-line growth (`a` → `ab`) catastrophically wrong (it
synthesized `a\nb` instead of `ab`).

Codex's review of the pull branch documented five blockers and
three concerns, mostly in this synthesis logic. They were
**implementation bugs in code we shouldn't have written in the
first place** — the polling-and-diffing layer is the wrong
abstraction for byte fidelity.

### Push (`feat/tmux-pane-mode-push`) — pipe-pane fifo

Used `tmux pipe-pane` to forward the byte stream into a named fifo,
opened the fifo for read in the parent process. Direct, no diff.

Problem: **opening a fifo with `O_RDWR` in Node strands a libuv
thread for the lifetime of the process**, and `stream.destroy()` +
`closeSync(fd)` does not release it. Vitest's worker can't
finalize, so the test runner hangs — under `--pool=threads`,
`--pool=forks`, and `--no-isolate`. The byte-stream architecture
was right, but the chosen IPC primitive collided with the test
runtime in a way that wasn't fixable in-place.

### The hybrid

Push's design with one swap: **move the blocking fifo read into a
child process**.

```
   target process
        ↓ (pty)
       tmux
        ↓ (pipe-pane -O 'cat > $fifo')
     [fifo file]
        ↓ (child cat reads it)
   cat (subprocess)
        ↓ stdout (libuv pipe)
   our parent process
        ↓
  PtyPaneSession.handleBytes()
        ↓
   addDataListener / getRawStream / getLogSlice
```

The blocking read still happens — just in `cat`, where it's safe.
The parent reads from `cat`'s stdout, which is a standard
`child_process` pipe. To tear down, the parent SIGKILLs `cat`; the
OS reaps the thread; the parent's pipe handle closes cleanly;
vitest's worker finalizes.

Pull's `tmux-cli.ts` argv-style builders (which codex called
"mostly fine") and pull's `capture-pane` code are kept and used —
but only for on-demand viewport queries, never for diffing the
byte stream. Best-of-both, with each tmux primitive doing the
thing it's actually good at.

## Lifecycle

### Construction

1. `mkfifo` (mode `0o600`) under `${TMPDIR}/pi-interactive-shell/`.
2. Spawn child reader: `cat $fifo`. Stays blocked on the fifo
   until tmux writes to it.
3. Build the wrapped command:

   ```sh
   trap '' INT TERM HUP                                   # 1
   trap 'printf "%d" "$?" > <exit-file>' EXIT             # 2
   ( <user command> )                                     # 3
   ```

   - **(1)** lets the wrapping shell ignore signals delivered to
     the pane process group, so it can keep running long enough
     to fire its `EXIT` trap.
   - **(2)** captures the exit code of whatever ran most recently
     (in normal flow, the subshell on line 3) and writes it to a
     sidecar file before the wrapping shell terminates.
   - **(3)** runs the user's command in a subshell so `exit N`
     doesn't short-circuit the wrapping shell (which would skip
     trap 2's write).

4. `tmux split-window -d -P -F '#{pane_id}' -- $shell -c
   $wrappedCommand`. Captures the pane id.
5. Capture pid via `display-message #{pane_pid}` (informational —
   used for `kill()`'s process-group signal target).
6. Apply pane title (cosmetic) and select if requested.
7. `tmux pipe-pane -O 'cat > $fifo'`. tmux opens the fifo for
   write; our cat reader unblocks; bytes start flowing.

There's a ~30-100 ms race window between steps 4 and 7 where any
output the target process emits lands in tmux's internal pane
buffer but is NOT captured by the fifo. This is documented as a
known limitation; it matters only for instant-output one-liners
(like `echo hi; exit`), which can lose the first chunk. For
long-running tools — the actual use case for pane mode — it's
invisible.

### Run

- Bytes flow target → pty → tmux → pipe-pane → fifo → cat → parent.
- Each chunk is forwarded verbatim to `dataHandler` and every
  registered `addDataListener` callback. Same chunk is appended to
  `rawOutput` for `getRawStream` / `getLogSlice`.
- `rawOutput` is bounded at 1 MB by `pty-log.ts`'s `trimRawOutput`
  (matches `PtyTerminalSession`'s memory ceiling).
- Viewport queries (`getViewportLines`, `getTailLines`) shell out
  to `capture-pane` synchronously when called. No background
  polling, no shadow buffer, no diff.

### Exit

- Target process exits.
- Subshell `( ... )` finishes, `$?` becomes the user's exit code.
- Wrapping shell's `EXIT` trap fires, writes `$?` to the sidecar
  file. Wrapping shell terminates.
- tmux closes the pty.
- `pipe-pane`'s child shell sees EOF on stdin, exits.
- Fifo writer count drops to zero.
- Our cat reader sees EOF, exits.
- `cat`'s stdout pipe closes in the parent; the `child.on('exit')`
  handler fires.
- We read the sidecar file, parse the exit code, emit
  `addExitListener` / `setEventHandlers.onExit`.
- If the sidecar file is missing (dispose-driven kill, or some
  signal path that bypassed the EXIT trap), we synthesize 130
  (SIGINT-equivalent) so callers can distinguish.

### Dispose

`dispose()` runs unconditionally regardless of whether the target
process has exited. This is codex review fix B3 — pull leaked
dead panes after natural exit because its `kill()` short-circuited
on `_exited`.

1. SIGKILL the cat reader child. Kernel reaps the process and its
   stranded blocking-read thread. The parent's stdout pipe to cat
   closes cleanly.
2. `tmux kill-pane` the pane. Even if the target process exited
   long ago, tmux may still have the pane alive (this used to be
   true under `remain-on-exit`; the hybrid drops `remain-on-exit`,
   but kill-pane is still cheap insurance and we want it for the
   hostile-cleanup path).
3. Clear listener arrays so any in-flight `notifyDataListeners`
   call is a no-op against an empty array.
4. `unlink` the fifo and exit-file sidecars. Best-effort.

`dispose()` is idempotent. Multiple calls are no-op.

## Public surface

`PtyPaneSession implements PtySession`. The interface
(`pty-session-interface.ts`) is the same one `PtyTerminalSession`
implements, so any consumer that holds a session reference can
hold either implementation:

```ts
interface PtySession {
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly signal: number | undefined;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;

  setEventHandlers(events): void;
  addDataListener(cb): () => void;
  addExitListener(cb): () => void;

  write(data: string): void;
  resize(cols: number, rows: number): void;

  getViewportLines(options?): string[];
  getTailLines(options): { lines, totalLinesInBuffer, truncatedByChars };
  getRawStream(options?): string;
  getLogSlice(options?): { slice, totalLines, totalChars, sliceLineCount };

  scrollUp(lines): void;
  scrollDown(lines): void;
  scrollToBottom(): void;
  isScrolledUp(): boolean;

  kill(signal?): void;
  dispose(): void;
}
```

The four scroll methods (`scrollUp` etc.) are no-ops on
`PtyPaneSession` — pane sessions are visible in tmux directly, so
the user scrolls via tmux's copy-mode bindings rather than via
the overlay. The methods are still part of the interface so
consumers don't need to type-narrow.

`write()` has one wrinkle: `tmux send-keys -l` (literal mode)
correctly forwards plain text and ESC sequences but does **not**
generate TTY signals from control bytes (0x03 INTR, 0x04 EOF,
0x1a SUSP, 0x1c QUIT). For those bytes, `write()` falls back to
`send-keys` with named-key notation (`C-c`, `C-d`, etc.) which
goes through tmux's signal-generating path. The
`splitWriteForSendKeys` helper does the partitioning and is
unit-tested independently.

## Test results

| Branch | Tests | Skipped | Failed | Runtime | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| pull | 97 | 3 | 0 | 12 s | 5 blockers, 3 concerns from codex round 1 |
| push | 86 | 13 | 0 | n/a | integration suite force-skipped (vitest hang) |
| **hybrid** | **134** | **0** | **0** | **41 s** | Round 1 + Round 2 codex findings resolved |

Codex review findings against the pull bake-off, status in the
hybrid:

- **B1** (`stripTrailingNewlines` discards real `\n`-only output):
  no longer applicable; bytes are forwarded verbatim. Tested.
- **B2** (`ensureLeadingSeparator` synthesizes fake newlines on
  same-line growth): no longer applicable; no diff path. Tested.
- **B3** (`dispose()` short-circuits on `_exited`, leaks dead
  panes): fixed; `dispose()` unconditionally kill-panes. Tested.
- **B4** (`PtyTerminalSession`/`PtyPaneSession` non-assignable):
  fixed via `PtySession` interface in
  `pty-session-interface.ts`. Tested.
- **C1** (prefix-divergence replays full snapshot, duplicate
  emissions): no longer applicable; no diff path.
- **C2** (env handling drops `process.env` inheritance): hybrid
  inherits `process.env` then layers caller overrides, mirroring
  `PtyTerminalSession`. Filters `TMUX`/`TMUX_PANE` to avoid
  server-context leak. Tested.
- **C3** (xterm geometry never resyncs): no xterm-headless shadow
  in hybrid, so the concern doesn't apply.
- **C4** (test coverage misses failure-prone cases): added
  same-line growth, newline-only, fast-finishing, type-surface
  tests as both unit and integration cases.

Codex round-2 review findings against the hybrid implementation,
all resolved in this branch:

- **NB1** (`getTailLines` empty after pane reap): fixed; falls back
  to slicing `rawOutput` when `_exited` is true. Critical because
  `headless-monitor.ts` and `handoff-utils.ts` both call
  `getTailLines` post-exit for completion notifications, transfer
  payloads, and handoff snapshots. Tested.
- **NC1** (signal-driven teardown lost real exit code): fixed;
  `kill(signal)` records the signal, `handleReaderExit` falls back
  to `128 + signum` instead of bare 130 when the wrapping shell
  can't write the sidecar (e.g. SIGKILL is untrappable). Tested.
- **NC2** (`getViewportLines` joined soft-wrapped rows): fixed;
  `buildCapturePaneArgs` now exposes `joinWrappedLines` (default
  true). Viewport opts out of `-J` to preserve row shape; tail keeps
  it for content-line semantics. Tested.

## Known limitations

1. **Construction race window.** Bytes the target process emits
   between `split-window` returning and `pipe-pane` being enabled
   (typically 30-100 ms) land in tmux's pane buffer but not the
   fifo. Acceptable for long-running tools; documented for the
   instant-output edge case.

2. **Viewport queries on a finished pane return empty.** Once the
   target process exits, tmux reaps the pane and `capture-pane`
   returns nothing. `getTailLines` falls back to the captured byte
   stream (codex review NB1 fix), so completion / transfer / handoff
   payloads still work post-exit. `getViewportLines` does NOT have a
   fallback because viewport queries fundamentally describe the
   visible pane, which no longer exists — callers should detect
   `session.exited` and switch to `getTailLines` if they need
   content from a finished session.

3. **C-d and other tmux-bypassed signals.** `send-keys -l` does
   not translate certain control bytes to TTY signals; we
   special-case 0x03/0x04/0x1a/0x1c via named keys. Other
   exotic line-discipline characters might behave differently
   from a "real" pty. Practical impact: minimal; the special
   cases cover the four control characters whose interpretation
   matters in practice.

4. **Reattach not yet wired for pane sessions.** `existingSession`
   in `InteractiveShellOptions` accepts `PtySession` post-Phase 1,
   but the overlay's reattach path still assumes terminal-rendered
   sessions. Phase 2 of the integration plan addresses this; for
   now `/attach` to a pane session is undefined behavior.

## Why this is the right architecture

The hybrid uses each tmux primitive for the thing it's actually
good at:

- `pipe-pane` is the byte stream. tmux already has the bytes; just
  forward them. No interpretation needed on our side.
- `capture-pane` is the viewport state. tmux already rendered the
  bytes; we just ask "what does the pane look like right now?"
  No background polling, no diffing.
- The fifo + child-process indirection is purely a Node libuv
  workaround. Conceptually it's a single pipe from tmux to us.

Both pull and push were trying to solve "byte stream + viewport"
with a single mechanism. Pull picked viewport-snapshots and tried
to reconstruct the byte stream from them (lossy by design). Push
picked the byte stream and tried to reconstruct the viewport from
it (would have worked, but the IPC plumbing got in the way of
testability). The hybrid uses both, in their natural roles.
