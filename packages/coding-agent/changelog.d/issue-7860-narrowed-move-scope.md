### Fixed

- `SessionManager.moveTo` rewrites the header cwd and recreates the transcript at the new location again; #7858 had dropped that rewrite (#7860).

### Changed

- Move Session in a shared root TUI session is refused again, as before #7858, until a design exists that cannot drop entries other processes have saved (#7856).
