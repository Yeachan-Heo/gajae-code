### Fixed

- Disconnect expired MCP startup connections without losing cached tools, the config and source metadata needed to reconnect them, their manager catalog during asynchronous cleanup, or the session-owned manager required to reconnect them; keep remote error response text out of persisted startup failure logs, including failures reported after startup returns; keep a mixed plugin/conventional manager unsealed while published cached conventional tools still require reconnection.
