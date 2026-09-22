### Fixed

- `read` now resolves the `embedded:gjc/...` identifiers that the skill tool and skill discovery report for bundled workflow skills, so reading a bundled `SKILL.md` no longer fails with "Path not found". Line selectors work on those identifiers too.
- Register the `skill://` protocol handler that was implemented but never wired into the internal URL router, so `skill://<name>` resolves as documented.
