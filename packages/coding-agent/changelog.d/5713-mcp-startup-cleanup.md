### Fixed

- Disconnect expired MCP startup connections without losing cached tools, the config and source metadata needed to reconnect them, or their manager catalog during asynchronous cleanup; keep remote error response text out of persisted startup failure logs, including failures reported after startup returns.
