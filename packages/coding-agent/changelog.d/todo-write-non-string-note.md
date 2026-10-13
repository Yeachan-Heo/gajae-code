### Fixed

- `todo_write` returns a tool result instead of a raw `TypeError` when a task holds a non-string note (for example from a persisted session or a bridged caller), and a note body that is not a string is rejected with a message naming the `text` field instead of crashing the call.
