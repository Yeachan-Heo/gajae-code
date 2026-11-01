### Fixed

- Session startup with plugin MCP servers that declare a `timeout` now waits at most that declared timeout for MCP connections instead of the timeout plus the startup grace, so `createAgentSession` returns within the declared timeout plus the grace. Servers still connecting continue in the background and publish their tools when they connect.
