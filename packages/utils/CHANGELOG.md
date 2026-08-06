# Changelog

## [Unreleased]

### Changed

- Process-tree and native process helpers now defer native binding access until the operation is invoked.

## [0.12.15] - 2026-08-06

## [0.12.14] - 2026-08-06

## [0.12.13] - 2026-08-06

### Fixed

- `fetchWithRetry` now clamps every scheduled retry delay to the platform timer ceiling so large backoffs and server hints cannot overflow into immediate retries.

## [0.12.12] - 2026-08-05
## [0.12.11] - 2026-08-03

## [0.12.10] - 2026-08-03

## [0.12.8] - 2026-08-02

### Fixed

- macOS executable discovery now honors explicit `PATH` and `cwd` lookup overrides instead of silently searching the process environment.
- Postmortem callbacks registered after a completed plain cleanup now run through the handled `Promise.try(...).catch(log)` path instead of a bare synchronous call that dropped the returned promise, so rejecting async late registrations are logged instead of surfacing as unhandled rejections that fail unrelated in-flight work.
## [0.12.7] - 2026-07-31

## [0.12.6] - 2026-07-31
### Fixed

- Positive-integer environment helpers now reject malformed, fractional, exponent-form, non-positive, and unsafe values instead of silently accepting their numeric prefixes (#3593).

### Fixed

- Glob scans now reject already-aborted and zero-result cancellations instead of returning a misleading successful empty result.
- Retryable responses discarded before another fetch attempt now begin body cancellation without blocking retry progress on transport cleanup, releasing buffered response data without consuming responses returned to callers.

## [0.12.5] - 2026-07-30

## [0.12.5] - 2026-07-30

## [0.12.4] - 2026-07-30

## [0.12.3] - 2026-07-30

## [0.12.2] - 2026-07-30

## [0.12.1] - 2026-07-29

### Fixed

- The crash-log credential scrubber recognizes GitHub fine-grained PATs (`github_pat_`) and complete AWS STS credentials. It already had rules for both vendors, but matched only the classic `gh[opsur]_` and long-term `AKIA` shapes. It now also covers the temporary `ASIA` key id and, critically, the `SecretAccessKey` / `SessionToken` values that ship alongside it — the id alone is not the credential, and neither canonical field name matched the existing labeled-value rule. All of these previously survived into a file the module keeps indefinitely.
- `$inheritedEnv` (and therefore `$credentialEnv` / `$pickCredentialEnv`) honours the removal of an inherited variable. The inherited snapshot is taken once, at module load, and was consulted first and unconditionally, so a provider credential exported by the launching shell could never be suppressed afterwards: deleting it from the live environment left every credential lookup still returning the snapshot value. Tests that clear provider env vars before exercising credential resolution therefore ran against the developer's real credential — and printed it when the assertion failed. Deletion is now honoured while the snapshot value stays pinned, so a later in-process write still cannot swap the credential a request authenticates with.

## [0.11.11] - 2026-07-26

### Fixed

- `getAgentDir()` honors the legacy `PI_CODING_AGENT_DIR` alias, mirroring `getConfigDirName()`. Parts of the product already resolved the alias (`gc-runtime.ts:370`, `deep-interview-runtime.ts:384`) while `dirs.ts` read only the `GJC_` spelling, so setting it moved `gjc gc` to the aliased directory while everything reaching `getAgentDir()` stayed on the default. The alias goes through the same project-`.env` trust guard.
- A `GJC_CODING_AGENT_DIR` or `GJC_CONFIG_DIR` / `PI_CONFIG_DIR` planted by the caller's project `.env` no longer selects the agent or config directory. Bun loads `cwd/.env` into `process.env` before any module runs, so a repository could point the agent directory at one it ships and have that directory's `.env` treated as a trusted credential source — recovering every endpoint and credential redirect the trust boundary rejects. Both directories supply `.env` files that `$credentialEnv` treats as trusted, so either name was enough to make a repository's own `.env` trusted. An override is now ignored when it matches what the project `.env` sets; an operator setting either from their shell is unaffected. The `.env` parsing primitives moved to a leaf `env-file` module so `dirs` can use them without a cycle; their public surface is unchanged.
- A configured config-directory name (`GJC_CONFIG_DIR` / `PI_CONFIG_DIR`) can no longer escape the home-relative root it is documented to stay under. The name is joined with `<home>` to locate user-level `mcp.json`, `SYSTEM.md`, skills, agents and installed plugins; `path.join` neutralizes a leading separator but not `..` segments, so an escaping value pointed that discovery outside the config root entirely. Escaping values now fall back to the default name.
- Strict CLI commands now reject unexpected positional arguments with usage guidance instead of silently ignoring typos or unsupported trailing input; non-strict passthrough commands and variadic arguments retain their existing behavior (#3173).
- Integer CLI flags now reject trailing characters, decimals, exponent notation, surrounding whitespace, and values outside JavaScript's safe-integer range instead of silently truncating or rounding them (#3172).
- The documented `GJC_BASH_NO_CI` and `GJC_BASH_NO_LOGIN` environment variables now take effect for the spawn shell configuration, resolved GJC-first ahead of the legacy `PI_*` / `CLAUDE_*` aliases (previously only the legacy names were read, so the documented names were silent no-ops). Both now follow the canonical boolean-flag contract (`1`/`Y`/`TRUE`/`YES`/`ON`, case-insensitive) instead of any-non-empty-string, so `GJC_BASH_NO_CI=0` no longer suppresses `CI=true`. Adds `resetShellConfigCache()` for deterministic shell-config testing, and corrects `docs/environment-variables.md`, which advertised non-functional `ANTHROPIC_MODEL_*` aliases.
- The shell command prefix (`PI_SHELL_PREFIX` / `CLAUDE_CODE_SHELL_PREFIX`) is now resolved from trusted sources only. `$env` merges the caller's `cwd/.env`, so a repository could previously plant a `.env` that set the prefix, which the bash executor interpolates ahead of every command (`${prefix} ${command}`) and runs through the shell — arbitrary command execution from repository content. Resolution now goes through the non-project resolver (launching shell plus GJC/user-owned `.env` files), matching how provider credentials are resolved; user-level configuration is unchanged.

## [0.11.9] - 2026-07-24

### Fixed

- Fatal crashes (`uncaughtException` / `unhandledRejection`) are now also persisted to a dedicated, append-only crash log (`~/.gjc/agent/gjc-crash.log`) before any stderr output, and the fatal handler prints the crash-log path. The daily logger file is gzip-archived independently by every gjc process at date rollover; that shared-archive race can truncate a day's log to an empty `.gz` and destroy the `logger.error` crash record, leaving crashes undiagnosable. The rotation-immune crash log is capped at 512 KB, bounds every individual record (UTF-8-safe truncation with a marker), scrubs credential material (bearer/auth headers, key=value credential fields, and well-known vendor token shapes) before persisting, and enforces owner-only file permissions.

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
