### Fixed

- A verified same-owner managed-transcript relocation no longer makes the title persistence fence treat the session as stale. Ownership is judged by the committed identity generation and session id instead of the physical session file, so a legitimate rename still persists, while a real owner change is still refused.
- A title publication abandoned mid-close is now surfaced by `close()`/`closeStrict()` instead of being swallowed, without latching the successor session.

### Added

- First-accepted-input automatic title generation with manual-name precedence and lifecycle cancellation, decoupled from prompt delivery.
