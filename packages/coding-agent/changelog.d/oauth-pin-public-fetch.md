### Fixed

- MCP OAuth token exchange, dynamic client registration, and authorization-server metadata requests are pinned to the validated public address and no longer follow redirects. Those fetches are refused when a proxy environment variable is set.
