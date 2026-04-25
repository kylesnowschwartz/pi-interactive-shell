# Pane-mode bake-off

## Pull (capture-pane polling)

### Decision: xterm-headless usage

**Choice — keep `@xterm/headless` and re-feed the diffed suffix bytes into it.**

Rationale:
- The contract in `pty-session.ts` is not "give me the bytes" but "give me a buffer". `getTailLines({ ansi: true })` leans on `SerializeAddon`; `getViewportLines({ ansi: true })` leans on cell-level inspection via `renderLineFromCells`. Reconstructing those from a raw `tmux capture-pane -e` text blob would require re-parsing tmux's emitted ANSI back into a cell grid — which is exactly what `@xterm/headless` already does. The shorter path is to let the engine I already have do the work it was built for.
- The diff produced by snapshot subtraction is, semantically, a stream of bytes appended to the pane. Feeding those bytes into the same xterm instance the overlay path uses keeps `getRawStream`, `getLogSlice`, scroll math, and the trim heuristic identical — one buffer surface, one set of consumers, zero behavioural divergence to debug.
- The double-emulation cost (tmux renders the bytes, capture-pane re-emits them as ANSI, xterm re-renders into cells) is real but bounded; for the bake-off fixtures it is dwarfed by the 100ms poll interval. If it ever becomes load-bearing, the answer is to replace the polling source, not the buffer abstraction — so the buffer abstraction earns its keep.

This decision is locked. The implementation that follows does not switch midstream.
