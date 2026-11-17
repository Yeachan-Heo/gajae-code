### Added

- Added implicit, keyless Rapid-MLX discovery at `http://localhost:8000/v1`, explicit `discovery.type: rapid-mlx` configuration, and served context-window metadata. Loopback discovery aborts after 500 ms and refuses redirects, so an unresponsive or redirecting server cannot stall startup or forward `RAPID_MLX_API_KEY`.
