### Fixed

- An approved project MCP stdio server, including a `/mcp test` entry whose type is omitted or null, spawns with the minimal OS environment plus its own `env` entries, so the repository file cannot read host credentials.
