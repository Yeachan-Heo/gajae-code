### Fixed

- Codex provider event flushing is now cooperative, yielding periodically to allow timers, abort, and other concurrent work to make progress during long streaming responses (#8127)
