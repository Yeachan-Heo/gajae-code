### Added

- Added Rapid-MLX local provider support with OpenAI-compatible model discovery, `RAPID_MLX_BASE_URL`, and optional `RAPID_MLX_API_KEY` authentication. By default, a loopback discovery request — keyless or credentialed — uses a direct socket, so neither the bearer nor the catalog request reaches an environment proxy. The same default direct transport carries completions and responses, so a proxy never sees the bearer or the request body either; a non-loopback endpoint and an explicit caller `fetch` override keep the ambient transport.
