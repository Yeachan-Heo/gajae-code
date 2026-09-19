### Added

- Interactive `/fork` opens the user-prompt selector and creates an independently persisted continuation with history before the selected prompt, restoring that prompt as an unsubmitted editor draft. The shared slash/keybinding picker requires persistence, closes active side chats on admission, and synchronizes session UI even when restoration fails after the child is committed. Original transcripts and CLI `--fork` behavior remain unchanged (#5515).
