### Added

- `eval.jsRuntime: quickjs` runs JavaScript eval cells in a QuickJS (wasm) sandbox. The sandbox has no `fetch`, `Bun`, `process`, `require`, filesystem, environment, or imports, so a cell reaches the outside world only through `tool.<name>(args)`. Those calls go through the session's normal permission and approval checks. The cell timeout and a 256 MiB memory limit stop runaway cells without losing the JS context. `bun` stays the default.
