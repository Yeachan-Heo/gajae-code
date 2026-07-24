# Changelog

## [Unreleased]

## [0.11.8] - 2026-07-23

## [0.11.7] - 2026-07-22
### Added
- SSE readers now accept optional per-event and cumulative UTF-8 byte budgets without changing existing defaults.

## [0.11.2] - 2026-07-19

### Fixed

- Consecutive termination signals now join the same in-flight postmortem cleanup instead of logging a spurious recursion error, and every exit-bound cleanup wait (signals, fatals, quiet broken-pipe exit, `quit()`) is bounded by an explicit finite deadline (default 5000 ms, `GJC_CLEANUP_DEADLINE_MS` override). On expiry the owner's exit code is preserved, a single diagnostic is emitted (suppressed during quiet shutdown), and late callback settlement becomes a no-op — a never-settling cleanup callback can no longer hang shutdown permanently (#2556).

## [0.10.1] - 2026-07-13

### Fixed

- Broken stdout pipes no longer crash early CLI output with a fatal internal-error dump. The process-level fallback exits quietly with numeric status 141 only for `EPIPE` observed directly from `process.stdout.write` or carrying `syscall: "write"` with an open descriptor matching stdout or the same unchanged pipe identity; unrelated socket/child-pipe errors, unattributed `EPIPE`, and process-level `ERR_STREAM_DESTROYED` keep the existing fatal diagnostics and status 1. Local output owners use separate sink-aware classification so expected peer closure does not become a universal process policy.

## [0.9.6] - 2026-07-10
### Fixed

- Prompt rendering now loads handlebars through a statically-traceable lazy `require("handlebars")` instead of a hardcoded `/$bunfs/root/node_modules/...` extra-entrypoint path, so compiled binaries cannot crash at startup when the extra entrypoint is missing from the bundle (#1939).

## [0.8.2] - 2026-07-06

### Fixed

- Deduplicated `globPaths` results so a path is returned at most once even when overlapping glob patterns (e.g. `["**/*.ts", "src/*.ts"]`) both match the same file.
- Anchored slash-containing `.gitignore` patterns (e.g. `sub/skip.ts`) to their `.gitignore`'s directory per git semantics instead of matching them at any depth, so `globPaths` with `gitignore: true` no longer drops same-named paths (e.g. `other/sub/skip.ts`) that git actually tracks.

### Fixed

- Made `$flag` case-insensitive so documented boolean-like env values work regardless of case. Previously only `1` and uppercase `TRUE`/`YES`/`ON`/`Y` were truthy, so the common lowercase spellings (`true`/`yes`/`on`) documented for flags such as `AWS_BEDROCK_SKIP_AUTH`, `PI_HARDWARE_CURSOR`, and `PI_CODEX_DEBUG` silently read as `false`.

## [0.5.2] - 2026-06-15

### Fixed

- Prevented closed stderr descriptors from crashing shutdown diagnostics while preserving unexpected stderr write failures.
- Dropped disabled macOS malloc stack logging variables from forwarded spawn environments so child processes do not repeat runtime warnings inherited from debugger-attached shells.
- Tolerate trailing commas on simple frontmatter scalar lines, avoiding noisy rule-discovery warnings for Cursor-style `.mdc` metadata while preserving strict fallback behavior for genuinely malformed YAML.

## [0.5.1] - 2026-06-14

- Version aligned with the 0.5.1 monorepo release; no functional changes in this package.

## [0.5.0] - 2026-06-13

### Changed

- Improved Bun runtime version diagnostics with detected runtime path plus platform-specific upgrade and PATH remediation guidance.

### Fixed

- Resolved credential environment values set after module import without trusting caller-project `.env` overlays, preserving live shell/GJC-owned credential overrides.

## [0.4.5] - 2026-06-12

### Fixed

- Kept provider credential resolution from trusting the caller project's `.env` values while preserving merged project environment access through `$env`.

## [0.4.4] - 2026-06-10

- Version aligned with the 0.4.4 monorepo release; no functional changes in this package.
