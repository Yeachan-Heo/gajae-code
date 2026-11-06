### Added

- SDK clients can now discover and answer pending interactive TUI asks through the public `ask.list` query and `ask.answer` operation. Interactive asks are exposed with a stable ID and current state (question, options, selected state), allowing external UI to provide answers that race with the local terminal selector. First answer wins between local and remote sides, and the loser is properly cleaned up. This resolves the limitation where interactive asks were only answerable through headless workflow gates.

### Fixed

- The `ask.answer` operation is no longer marked unavailable for interactive sessions. SDK-connected clients can now answer ordinary interactive asks through the same race mechanism as the local TUI selector, eliminating the asymmetry where asks were visible but unanswerable to external UI.
