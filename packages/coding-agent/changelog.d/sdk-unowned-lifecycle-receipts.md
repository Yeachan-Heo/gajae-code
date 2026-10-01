### Fixed
- Keep session-initiated lifecycle boundaries separate from queued SDK turns so a delayed predecessor completion cannot publish the successor's receipt with the wrong final answer. Preserve attached invocations and existing deadline, abort, and retired-owner isolation.
- Preserve a single public lifecycle boundary across accepted retries that suppress their predecessor's end, including tokenless interactive retries, so reopening the session retains terminal delivery and idle checkpoints.
