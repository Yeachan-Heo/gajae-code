### Fixed

- Release live legacy HTTP and SSE MCP sessions during signal and fatal-exit cleanup, so terminated GJC processes no longer leave server-side `Mcp-Session-Id` state behind.
