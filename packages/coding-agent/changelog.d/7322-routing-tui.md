### Added

- Expose canonical smart-routing preview/apply/refresh/clear/enable intents shared with the TUI, with instance-bound preview ownership, stale-source refusal and explicit durability/activation outcomes.

### Fixed

- Bind hand-edit confirmation to guarded state and refresh proof; preserve newer writers through single-file CAS restoration and invalidate stale open panels after conflicts or failed refreshes.
- Preserve navigable editable routing drafts after preview failure and distinguish global refresh results from effective project/runtime overlays.
- Apply sampling changes to live sessions before ordinary settings observers run, preserving in-flight snapshots and updating later runs. Unregister sampling observation on session disposal while bounded child-process cleanup preserves live session updates.
- Bind settings selectors, previews and writes to the active session's Settings, keeping scope-local UI independent of the process-global singleton.
