### Fixed

- TUI no longer goes blank after stop/restart cycles: `#hardwareCursorRow` is now properly reset during `stop()` to prevent stale cursor position state from corrupting viewport calculations on the next `start()`.
