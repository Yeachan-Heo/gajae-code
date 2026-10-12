### Fixed

- The MCP OAuth client_id probe does not GET a non-public authorization URL: the request is pinned to the validated address and the flow abort signal reaches that DNS lookup. The shared address check rejects 192.88.99.0/24, including the non-global 6a44 relay 192.88.99.2.
