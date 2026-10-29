### Fixed

- The recipe tool's runner detection, which runs at session start whenever the bash tool is enabled (`cargo metadata`, `just --dump`, `task --list-all`), now starts those programs from the same filtered environment as the bash tool. Previously, on source and npm installs (Bun dotenv autoload), a repository `.env` declaring `LD_PRELOAD` or another hook variable reached them as soon as a session opened in a checkout with a `Cargo.toml`, justfile, or Taskfile, before any prompt. Recipe execution itself already ran through the bash tool and was unaffected.
