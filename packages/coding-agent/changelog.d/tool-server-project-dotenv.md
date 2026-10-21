### Fixed

- Stdio MCP servers, LSP servers, the Biome and SwiftLint linters, and DAP adapters no longer inherit hook variables a project `.env` declares (e.g. `NODE_OPTIONS=--require ./x.js`, `LD_PRELOAD`, `GIT_CONFIG_*`). They now start from the same filtered environment as the bash tool, so opening a repository and writing a file can no longer run repository code through a server GJC starts on its own. Values the launching shell exported are still honored.
