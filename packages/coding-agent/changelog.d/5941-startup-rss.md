### Fixed
- Cut memory at every `gjc` startup: CLI flag parsing no longer loads the whole provider barrel, which pulled in about 550 modules (OpenAI and Anthropic SDKs, zod locales, mermaid) before argv was parsed. `--help` and `--version` now load 43 modules instead of 588 when run from source, and the compiled binary's `--help` peak RSS drops from about 162 MiB to 152 MiB.
- Stop keeping every `node` interpreter found on PATH in memory for the life of the session. The plugin MCP launcher now hashes those binaries in fixed 1 MiB chunks instead of reading each one whole. In the S5 bash scenario this lowers the main process's peak RSS from about 757 MiB to 581 MiB.

### Added
- Record an RSS checkpoint for every stable and nightly release. The release workflow measures the released linux-x64 binary and the previous stable release on the same runner, then runs an advisory compare that reports regressions without failing the release. `scripts/verify-rss-checkpoints.ts` gains `--binary`, `--commit`, `--output-dir`, and `--advisory` for this. The time report now goes to a file, fixing an intermittent EAGAIN failure when `/usr/bin/time` wrote to the harness's non-blocking stderr pipe.
