# Changelog

## [Unreleased]

### Fixed

- Deduplicated `globPaths` results so a path is returned at most once even when overlapping glob patterns (e.g. `["**/*.ts", "src/*.ts"]`) both match the same file.

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
