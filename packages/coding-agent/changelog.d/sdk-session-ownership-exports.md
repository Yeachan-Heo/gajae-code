### Added

- The SDK exports `SessionHeldError` (with `code: "session_held"`, `sessionId` and `holder`, the holder's surface and pid), which the session factories and `createAgentSession` throw under `session.ownership.mode: enforce`, and `probeSessionOwners`, which reports for each session id whether another live process holds it, without taking anything. `createAgentSession` takes an `owner: { surface }` option, the name other processes see while it holds the session it creates (default `sdk`).
