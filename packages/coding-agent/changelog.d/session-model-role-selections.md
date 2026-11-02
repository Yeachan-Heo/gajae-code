### Added

- Live-session-only executor/planner/critic/architect model choices without mutating shared Settings; actual dispatch, detached snapshots, eager prompts and slash status all use the same effective map. Clearing reveals the current inheritance, and a committed identity/profile replacement retires the choices.

### Fixed

- A profile switch superseded mid-activation no longer records its transient DEFAULT model in the usage order, so the model the user picked while the switch was in flight stays the MRU head.
