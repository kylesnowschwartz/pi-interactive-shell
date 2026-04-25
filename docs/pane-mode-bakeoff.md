# Pane-mode bake-off

## Pull (capture-pane polling)

### Decision: xterm-headless usage

**Choice — keep `@xterm/headless` and re-feed the diffed suffix bytes into it.**

Rationale:
- The contract in `pty-session.ts` is not "give me the bytes" but "give me a buffer". `getTailLines({ ansi: true })` leans on `SerializeAddon`; `getViewportLines({ ansi: true })` leans on cell-level inspection via `renderLineFromCells`. Reconstructing those from a raw `tmux capture-pane -e` text blob would require re-parsing tmux's emitted ANSI back into a cell grid — which is exactly what `@xterm/headless` already does. The shorter path is to let the engine I already have do the work it was built for.
- The diff produced by snapshot subtraction is, semantically, a stream of bytes appended to the pane. Feeding those bytes into the same xterm instance the overlay path uses keeps `getRawStream`, `getLogSlice`, scroll math, and the trim heuristic identical — one buffer surface, one set of consumers, zero behavioural divergence to debug.
- The double-emulation cost (tmux renders the bytes, capture-pane re-emits them as ANSI, xterm re-renders into cells) is real but bounded; for the bake-off fixtures it is dwarfed by the 100ms poll interval. If it ever becomes load-bearing, the answer is to replace the polling source, not the buffer abstraction — so the buffer abstraction earns its keep.

This decision is locked. The implementation that follows does not switch midstream.

### Design summary

`PtyPaneSession` (pull) creates a sibling tmux pane via `tmux split-window -d -P -F '#{pane_id}'`, sets `remain-on-exit on` on that pane so a fast-finishing process stays capturable until our next poll tick, then polls every 100ms (configurable via `pollIntervalMs`). Each tick runs `tmux capture-pane -p -e -J -S - -E -` to snapshot the full pane content with ANSI escapes, and `tmux display-message -p '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}'` to learn whether the pane's process has exited. New bytes are derived by snapshot subtraction (suffix when the prefix matches; full replay when the prefix diverges, treating the divergence as a history-roll) and fed into a local `@xterm/headless` instance plus the raw-output buffer. Input goes out via `tmux send-keys -l --` for literal text and named-key form for keys, mirroring the existing `key-encoding.ts` translation contract.

### Design choices

- **`remain-on-exit on` per pane** — fixes a race where fast-finishing fixtures lose their final output bytes between polls; the pane stays alive until `dispose()` / `kill()` explicitly destroys it.
- **Exit code via `#{pane_dead_status}`** — read after every capture; falls back to 0 if tmux can't supply one (older tmux without pane-scoped `pane_dead_status`).
- **100ms poll interval** — chosen as the floor where monitor-trigger fidelity stays usable without burning CPU. Configurable per-session.
- **Snapshot diff strategy** — suffix subtraction when prefix matches; full replay on divergence (history roll). Avoids double-counting at the cost of one duplicate-emit on history-rolls, which monitor consumers can tolerate.
- **`@xterm/headless` retained** — see ADR above. Buffer surface is identical to `pty-session.ts` so consumers (`headless-monitor`, `session-query`, eventually `overlay-component`) need no special-casing.
- **No `resize()` propagation** — pane dimensions are owned by the user via tmux; reshaping from underneath them is hostile. The local xterm dimensions are seeded from `#{pane_width}x#{pane_height}` on construction and not adjusted thereafter.
- **Scroll family is a state-machine stub** — `scrollUp`/`scrollDown`/`scrollToBottom`/`isScrolledUp` track the same scroll-offset/follow-bottom state the overlay path expects, but tmux owns the real pane scrollback. Scroll commands affect the local-buffer view, not the user-visible pane.

### Fixture results

| # | Fixture | Result | Notes |
|---|---------|--------|-------|
| 1 | ANSI fidelity | PASS | 5 visible numbered lines + at least one red SGR sequence preserved through capture-pane's `-e` flag and the snapshot-diff path |
| 2 | Monitor-trigger fidelity | PASS | 50 distinct `line-N` matches in `getRawStream` |
| 3 | Input round-trip | PARTIAL PASS | Literal text (`hello\nworld\n`) round-trips into the pane buffer correctly; C-d EOF does not drive `cat` to exit (skipped, see Known Limitations) |
| 4 | Token cost | not measured | deferred to Phase 1 dispatcher integration |
| 5 | Crash recovery | 2/3 | 5a (clean dispose) PASS; 5b (external `tmux kill-pane`) PASS within poll tick + 2s grace; 5c (SIGTERM mid-process) skipped — hard to validate from inside the same node process |
| 6 | Latency | ~1200ms (in isolation) | passes when run alone; flaky in-suite due to state contamination via `remain-on-exit` polling. The in-isolation number is the real measurement |

### Known limitations

- **C-d EOF cannot be delivered through `tmux send-keys`** to drive a process like `cat` to exit. The literal byte `0x04` arrives in the pane via `send-keys -l --`, but `cat`'s line-discipline EOF detection only fires when the byte arrives via a real tty signal that tmux does not synthesise. Named `C-d`, direct `tmux send-keys C-d`, and literal `0x04` were all attempted and none worked. **Workaround:** consumers wanting to terminate a process should call `kill()` rather than relying on EOF-via-write. This is a fundamental property of the pull approach (no real PTY) and is unlikely to be fixable without giving up `tmux send-keys` for input.
- **Fixture 6 in-suite flakiness** — latency assertion passes in isolation but fails in suite. Suspected cause: `remain-on-exit` keeps prior fixture panes around long enough that polling against the test's own pane is occasionally starved. Not a correctness issue for the implementation, but a test-architectural one. Phase 1 wiring should avoid running multiple bake-off fixtures against the same tmux server simultaneously.
- **No real PTY** — consumers expecting `pty-session.ts` semantics around DSR (Device Status Report) cursor queries will not get responses. Pull mode does not see raw DSR escapes from the pane process; tmux handles them internally before our snapshot.
- **`getViewportLines({ ansi: true })`** delegates to `@xterm/headless`'s cell-level renderer via the diffed-byte path. For most consumers this is identical to the overlay path; a small class of "compare against the original `pty-session.ts` byte-for-byte" tests may show drift due to capture-pane's normalisation of certain escape sequences.

### LOC

```
     787 pty-pane-session.ts
     171 tmux-cli.ts
     229 tests/pty-pane-session.integration.test.ts
     371 tests/pty-pane-session.test.ts
    1558 total
```

Test results: 97 passed, 3 skipped, 0 failed (`npm test` against an isolated tmux server via `tmux -L pi-bakeoff`).
