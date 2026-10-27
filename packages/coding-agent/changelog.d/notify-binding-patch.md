### Fixed

- `config.patch` rejects notification binding paths before any settings write, so a generic patch cannot replace a Slack actor, a Slack or Discord destination, or a Telegram chat id.
