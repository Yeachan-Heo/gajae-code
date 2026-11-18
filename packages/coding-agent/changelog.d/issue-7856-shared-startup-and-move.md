### Fixed

- Shared root TUI sessions now allow `setTemporaryModel` with `--model`/`--mpreset` startup overrides by routing them through shared admission (#7856)
- Move Session tool (`move_session`) now works in shared sessions by allowing mutations during exclusive cwd transitions (#7856)
