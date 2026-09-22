### Fixed
- Let SDK steering reach the active worker while an earlier ordered control is still pending.

- Return an empty observation for missing assistant text instead of a resource-loss error, including compatibility with older running SDK hosts.

### Added

- Explicit correlated active-turn steering through coordinator send_prompt, with operator guidance separating requested evidence, queued tasks, and verified consumption.
