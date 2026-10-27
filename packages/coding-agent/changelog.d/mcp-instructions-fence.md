### Fixed

- MCP server initialize instructions are framed as untrusted content after the per-server length cut, so a server-supplied closer cannot end that frame early.
