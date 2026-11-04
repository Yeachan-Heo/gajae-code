### Added

- The SDK `btw.ask` control accepts optional `exchanges: [{ question, reply }]`, the earlier side exchanges of a stateless client, oldest first, so a follow-up side question sees them the same way the TUI `/btw` panel does. They are bounded like the panel's own history: the newest 12 exchanges that fit 64 KiB of UTF-8 in total are kept in order, each question is cut to 16 KiB and each reply to 32 KiB at a character boundary, and older exchanges are dropped. `runtime.capabilities.btwAskExchangesVersion` is `1` on hosts that support it.

### Changed

- **Breaking (SDK):** `btw.ask` now refuses unknown input fields and malformed `exchanges` as `invalid_input` instead of ignoring them, so a request that previously succeeded with an extra field (for example `replyText`) now fails. Older hosts ignore `exchanges`, so clients should check `btwAskExchangesVersion` before sending it.
