### Fixed

- Custom and MCP tools that declare `strict` or `concurrency` no longer crash MCP tool refresh with "Attempted to assign to readonly property". The adapter now sets those fields before proxying the rest of the tool.
