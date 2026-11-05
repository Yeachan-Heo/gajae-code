### Fixed

- Prompt images on SDK hosts are admitted by the factory-owned session, so an upload that arrives before the runtime finishes adopting its session is rejected or attributed correctly instead of landing on the previous session. Local slash commands now refuse image attachments instead of silently dropping them.
