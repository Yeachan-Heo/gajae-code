### Fixed
- Let SDK steering reach the active worker despite an earlier ordinary ordered control, while waiting behind abort-and-prompt replacements and fencing to the exact runtime command/turn identity so stale feedback is rejected instead of delivered to a successor.

- Return an empty observation for missing assistant text instead of a resource-loss error, including compatibility with older running SDK hosts.

### Added

- Explicit correlated active-turn steering through coordinator send_prompt, with operator guidance separating requested evidence, queued tasks, and verified consumption. Retargeting feedback to a new active turn requires a new idempotency key; admission still does not prove consumption.
