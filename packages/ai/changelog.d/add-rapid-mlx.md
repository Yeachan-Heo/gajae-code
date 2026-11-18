### Added

- Added Rapid-MLX local provider support with OpenAI-compatible model discovery, `RAPID_MLX_BASE_URL`, and optional `RAPID_MLX_API_KEY` authentication. A credentialed loopback discovery request uses a direct socket, so the bearer credential is never forwarded to an environment proxy. The same direct transport carries completions and responses, so a configured proxy never sees the bearer or the prompt/tool payload either.
