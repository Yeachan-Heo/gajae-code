### Fixed

- Successor, terminal-error, and forced-abort handling now wait for an in-flight published `turn_end` checkpoint consumer before admitting later work or publishing `agent_end`, preventing canonical repeat-rule state from lagging behind terminal lifecycle changes. Tool calls cancelled after their pre-dispatch hook now invoke the cleanup hook exactly once with the authoritative cancellation result.
- External lifecycle emitters now pass a session-owned admission fence before mutating Agent state. Run-bound terminals retain their authoritative attempt scope, while Cursor-native lifecycle emitters resolve the current main-attempt scope on every emission so in-loop retries and later tool turns are not mistaken for retired producers.
- Provider iterators that close with a trailing assistant but no explicit `done`/`error` event now publish the canonical `message_end` before `turn_end` and `agent_end`, preventing session persistence from missing the authoritative final response.
- Provider stream cancellation keeps one signal listener, bounds per-read abort-race reactions, and observes synchronous aborts raised inside provider factories.
- Lossless degraded snapshots preserve only validated, size-bounded transport codes, retry headers, and HTTP/2 diagnostics while dropping unreadable, oversized, or non-cloneable values.
