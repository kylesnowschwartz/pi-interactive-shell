# Pane-mode bake-off

## Push (`tmux pipe-pane` + fifo)

### Design summary

`PtyPaneSession` (push) creates a sibling tmux pane via `tmux split-window -d -P -F '#{pane_id}'`, then redirects the pane's stdout into a named pipe via `tmux pipe-pane -o -t <pane> 'cat >> "<fifo>"'`. The fifo is opened from Node with `O_RDWR` so the read end stays valid across writer reconnects, then `fs.createReadStream({ fd, autoClose: false })` feeds bytes into a local `@xterm/headless` instance — preserving the SerializeAddon, raw-output buffer, WriteQueue ordering, and DSR splitting from `pty-session.ts`. Pane death is detected by polling `tmux display-message -p '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}'` at 500ms (a `remain-on-exit on` is set to keep the pane capturable until we observe its exit). Input goes via `tmux send-keys -l --` for literal text, named-key form for keys.

### Design choices

- **Blocking O_RDWR fifo** — the implementing agent chose blocking I/O over `O_NONBLOCK`+EAGAIN handling, rationale documented in the SUT file header: blocking gives reliable streaming; non-blocking with `createReadStream` mishandles EAGAIN and tears down the stream after the first chunk. **This choice is the source of the bake-off-blocking issue** — see "Test infrastructure incompatibility" below.
- **`remain-on-exit on` per pane** — same fix the pull approach uses; lets the polling loop observe the real exit code via `#{pane_dead_status}` instead of racing against tmux reaping.
- **EBADF guard on the fifo read stream** — a teardown race where `dispose()` closes the fd while a libuv read is in flight produces EBADF; the guard treats it as "already closed, fine" and stays quiet.
- **500ms pane-death poll** — the fifo is the primary data pathway; polling is only for life-cycle. 500ms is conservative.
- **Stale-fifo sweep on construction** — `${TMPDIR}/pi-interactive-shell/` is swept for `*.fifo` files older than the boot time before creating a new one.
- **No `resize()` propagation** — same rationale as pull: the user owns the pane.
- **Scroll family stubbed** — same as pull.

### Test infrastructure incompatibility (the big finding)

The push approach is conceptually viable but **operationally incompatible with this project's vitest configuration**. Every test that constructs a real `PtyPaneSession` strands a libuv read thread on the fifo fd. Calling `stream.destroy()` followed by `closeSync(fd)` in `dispose()` does not release that thread. As a result, vitest's worker process cannot finalise — the test file appears to "complete" but the runner hangs forever waiting on stranded handles.

This was reproduced under all three vitest pool configurations:
- Default (`--pool=threads`): hangs after the suite runs.
- `--pool=forks`: hangs at file startup before any test executes.
- `--pool=threads --no-isolate`: same.

Confirmed with both:
- A 5-test slice of unit tests that construct real sessions (skipped in `tests/pty-pane-session.test.ts`).
- The full integration suite (force-skipped in `tests/pty-pane-session.integration.test.ts` unless `RUN_PUSH_INTEGRATION=1` is set; runs hang at the end and must be SIGKILL'd).

The pull approach (capture-pane polling, no fifo, no blocking reads) has none of these issues — its 6-fixture integration suite runs cleanly in 12 seconds.

**Possible future fixes** (not attempted in this bake-off):
- Switch the fifo to non-blocking and handle EAGAIN robustly.
- Replace `createReadStream` with a manual `fs.read` loop that calls `unref()` on its handle.
- Use `worker_threads` for the fifo reader so its handles are isolated from the test runner's main thread.
- Move ingestion to a child process that we can SIGKILL on dispose.

Each of these is a non-trivial rework. For the bake-off, the empirical result is that pull is cleaner.

### Fixture results

| # | Fixture | Result | Notes |
|---|---------|--------|-------|
| 1 | ANSI fidelity | NOT RUN | Integration test exists but cannot be exercised in CI; skipped. Confirmed correct in dev hand-tests by the implementing agent before commit; not measured here. |
| 2 | Monitor-trigger fidelity | NOT RUN | Same. Implementation is identical to the pull approach's path (raw-output buffer regex), so no reason to expect divergence. |
| 3 | Input round-trip | NOT RUN (literal) / SKIPPED (C-d EOF) | C-d EOF is a known limitation shared with pull (tmux send-keys cannot synthesise the line-discipline EOF signal). |
| 4 | Token cost | not measured | deferred to Phase 1 dispatcher integration |
| 5 | Crash recovery | NOT RUN | Tests written, hang on execution. |
| 6 | Latency | NOT RUN | Push's pipe-pane is push-based, so latency is theoretically *lower* than pull (no 100ms poll floor). Not measured in this bake-off. |

### Known limitations

- **Test infrastructure hang** (see above) — the dominant finding.
- **C-d EOF cannot be delivered through `tmux send-keys`** — same as pull approach. Inherent to the choice of `tmux send-keys` for input.
- **Fifo lifecycle is fiddly** — the SUT correctly handles construction failure (rolls back fifo state), stale-fifo sweep, EBADF on dispose, but the fundamental "libuv read thread cannot be released" property remains.
- **Larger code surface than pull** — the fifo plumbing, sweep logic, and DSR-split forwarding add ~300 LOC compared to the pull approach.

### LOC

```
     877 pty-pane-session.ts
     243 tmux-cli.ts
     244 tests/pty-pane-session.integration.test.ts
     413 tests/pty-pane-session.test.ts
    1777 total
```

For comparison, pull-side total is 1558 LOC. Push is ~14% larger.

### Test results

- Unit tests: 12 passed, 5 skipped (real-session tests skipped due to libuv hang)
- Integration tests: 0 run, 8 force-skipped (entire file behind `RUN_PUSH_INTEGRATION=1` env flag)
- Full suite: `Test Files 18 passed | 1 skipped (19); Tests 86 passed | 13 skipped (99)`. Exits cleanly in <1s.

## Verdict

**Pull (`capture-pane` polling) is the bake-off winner.**

The push approach's blocking-fifo choice is theoretically appealing for low-latency event delivery, but it produces a fatal teardown property: any consumer that creates and disposes a `PtyPaneSession` in the same process as the test runner will hang on exit. This is not a flaky test issue — it reproduces deterministically on every run.

Pull's `capture-pane` polling has none of this. It pays a 100ms latency floor (between pane stdout write and dataListener invocation) and emits slightly larger snapshot diffs in worst-case (history-roll) scenarios, but its lifecycle is clean. Its integration suite runs in 12 seconds with zero stranded handles. Its code surface is 14% smaller. Its design choices (`remain-on-exit on`, snapshot-subtraction, dead-status query) compose cleanly.

If push's libuv issue is ever fixed (most likely path: a dedicated child-process or worker_thread for the fifo reader), it would be worth re-evaluating. For this bake-off, pull wins.
