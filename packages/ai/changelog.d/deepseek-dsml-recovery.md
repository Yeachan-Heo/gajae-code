### Fixed

- **DeepSeek DSML recovery:** Enforced request's effective tool-choice restrictions for recovered calls. Calls recovered from `delta.content` markup are now rejected when the request specifies `toolChoice: "none"` or names a different tool.
- **DSML argument validation:** Invalid JSON-typed DSML parameters that fail parsing are now marked incomplete instead of falling back to strings, preventing execution of malformed tool calls.
- **DSML structural errors:** Parameter nesting errors (parameter opening before the previous closes) are now detected and marked incomplete, discarding all arguments to prevent malformed execution.
- **Mixed delta handling:** Recovered DSML calls from deltas that also contain structured tool calls are now matched individually at reconciliation instead of bulk-suppressed by co-occurrence.
- **One-to-one call matching:** Final reconciliation now uses one-to-one multiset matching so each structured call suppresses at most one recovered call, preventing loss of distinct recovered invocations.
- **Kimi immediate emission:** Kimi recovered calls are now emitted immediately during streaming (pre-PR behavior) instead of buffered until end-of-stream, preserving call order for agent dispatch.
- **Kimi mixed delta handling:** Kimi calls in deltas with structured tool calls are still suppressed to avoid double-dispatch.
