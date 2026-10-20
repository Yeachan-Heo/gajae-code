### Added

- `gjc migrate` now reports the source settings it cannot import instead of leaving them silent: Claude Code hook events (with their shell-command counts), `model`, `permissions` allow/deny/ask counts, and `env` variable names, plus Codex `config.toml` `model`, `approval_policy`, `sandbox_mode`, and `shell_environment_policy` names. They appear under `Manual actions:` and in `manualActions` with `--json`; environment values are never read.
