### Added

- Document optional local Sem MCP navigation and a separate Weave merge-preview workflow, including the global `mcp.enableProjectConfig` opt-in a project stdio server requires and resetting it after the example.

### Fixed

- Keep the exact-config `/mcp` exception in the public slash-command boundary: sessions started with `--mcp-config` still expose `/mcp status|list|suspend|resume|reconnect` even though ordinary TUI and ACP surfaces do not.
