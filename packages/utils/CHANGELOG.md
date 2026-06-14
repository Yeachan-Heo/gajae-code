# Changelog

## [Unreleased]

### Fixed

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
