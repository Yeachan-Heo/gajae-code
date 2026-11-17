### Fixed

- MCP OAuth token refresh requires HTTPS unless the token endpoint host is loopback, including IPv4-mapped loopback literals.
- A stored non-loopback HTTP MCP binding no longer fails the whole auth-broker snapshot; it fails transport admission at use instead, and new bindings cannot be uploaded over cleartext.
