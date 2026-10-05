### Fixed
- Wait for the existing queued cancellation terminal publisher before acknowledging an ordinary SDK notification-bus abort; report unconfirmed persistence instead of deterministic cancellation success.
- Advance the Telegram daemon generation to replace existing owners that still serve the pre-fix cancellation acknowledgement path, without changing the serving epoch.
