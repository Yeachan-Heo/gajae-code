### Features

- Allow user-level skill symlinks to resolve outside `~/.gjc/agent/skills` when `skills.trustUserSkills` is enabled. This aligns with how other editors (Claude Code, Codex, OpenCode, pi) handle symlinked skills, enabling users to maintain a shared skills repository and reference it via symlinks from their `.gjc/agent/skills` directory. When `skills.trustUserSkills` is false or unset, outside-root symlinks are still refused with an updated diagnostic suggesting `skills.customDirectories` or `skills.trustUserSkills` as solutions. (fixes #6355)
