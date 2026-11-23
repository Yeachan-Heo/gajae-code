### Fixed

- Anthropic Messages requests keep a query-bearing base URL intact (for example a signed proxy URL like `https://gateway.example.com/anthropic/v1?sig=...`): `/v1/messages` is now added to the path once and the original query is sent unchanged, instead of the route being appended inside the query.
