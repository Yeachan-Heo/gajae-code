# Codex Responses: Fix event loop starvation with long streaming responses

### Fixed

- Codex provider event flushing is now cooperative, yielding periodically to allow timers, abort, and other concurrent work to make progress during long streaming responses (#8127)
- All events (including deltas) are properly buffered during replay-eligible attempts to maintain the lossless-retry contract
- JSON argument completion is checked on every delta to ensure accurate argument parsing
- Event loop starvation caused by processing thousands of delta events in one non-yielding microtask chain has been resolved
