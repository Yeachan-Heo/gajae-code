### Fixed

- OpenAI Responses and Codex Responses now explicitly send `strict: false` for non-strict function tools, preventing implicit server-side strict normalization from making optional MCP arguments required, including Linear comment parent selectors and `statusUpdateType` (#6183).
