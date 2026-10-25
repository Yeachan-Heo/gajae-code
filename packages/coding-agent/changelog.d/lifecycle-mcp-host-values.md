### Fixed

- Lifecycle MCP server env and headers no longer run `!` shell commands or copy sensitive host values, including a sensitive header placeholder, when the lifecycle host loads that tools-only file. A caller-selected exact config stays trusted.
