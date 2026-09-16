### Fixed

- Preserve registered SDK endpoint file identity through host shutdown, conditional unregistration, and verified retirement so Coordinator MCP can verify completed session closure without a false `endpoint_stale` response. Stale successor identities remain rejected; historical incomplete records are not rewritten.
