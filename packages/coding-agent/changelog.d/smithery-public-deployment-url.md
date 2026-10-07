### Fixed

- Smithery HTTP deployment URLs are accepted as direct MCP endpoints only when they pass the public-network check, and later requests for that saved endpoint use the same check on every connection and redirect.
