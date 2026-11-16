### Changed

- JavaScript eval cells now run only in a QuickJS (wasm) sandbox. The Bun/Node execution path is gone, so there is one permission boundary: a cell reaches files, network, and processes only through `tool.<name>(args)`, which goes through the session's normal permission and approval checks. `read(path, { offset, limit })` and `write(path, content)` are wrappers over `tool.read` and `tool.write`. `sort`, `uniq`, `counter`, `output`, `display`, `console`, `sleep`, and `setTimeout`/`clearTimeout` keep working. The cell timeout and a 256 MiB memory limit stop runaway cells without losing the JS context.

### Removed

- JavaScript eval cells no longer have `import`/`require` (node builtins or npm packages), `fetch`, `process`, `Bun`, `Buffer`, `fs`, or `env()`, and `append`, `tree`, and `diff` now throw an error that names the `tool.*` call to use instead. Run scripts that need these through `tool.bash`.
