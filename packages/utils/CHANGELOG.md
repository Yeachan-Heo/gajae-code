# Changelog

## [Unreleased]

## [0.16.4] - 2026-09-05

## [0.16.3] - 2026-09-04

## [0.16.2] - 2026-09-04

## [0.16.1] - 2026-09-03

## [0.16.0] - 2026-09-02

## [0.15.6] - 2026-08-30

## [0.15.5] - 2026-08-29

## [0.15.4] - 2026-08-29
- A fatal error whose message spans multiple lines no longer prints its body twice. `formatFatalError` and `writeCrashRecord` both dropped a single line from `stack` to skip V8's `Name: message` header, but that header spans as many lines as the message does, so lines 2..N survived as pretend stack frames while the message had already been rendered in full — visible on stderr and in `gjc-crash.log` for any multi-line guard. The header is now stripped by exact `name: message` prefix, falling back to the single-line drop when the captured message no longer matches the stack (a serialized payload can replace it). Real frames are preserved.

## [0.15.4] - 2026-08-29

## [0.15.3] - 2026-08-27

## [0.15.2] - 2026-08-25

## [0.15.1] - 2026-08-25

## [0.15.0] - 2026-08-22
- Project dotenv declarations are now excluded from credential and agent-directory provenance even when Bun expands their values before startup, preventing repository-controlled redirects of trusted state and egress (#4715).
- The independent-evidence rule for the trusted account home (#4766) is now pinned by discriminating regression proof for the shape its macOS repro cannot reach: a Linux identity whose uid has no local `/etc/passwd` entry (NSS/LDAP/SSSD-backed accounts, minimal or distroless containers), reported as #4773. New subprocess tests run the resolver under an unprivileged user namespace whose mapped uid is verified absent from the local passwd database (chosen from common subordinate-style candidates or the invoking user's `/etc/subuid` range), so the runtime `userInfo().homedir` echo of a checkout-declared home variable cannot silently regress back into the trusted set; they fail on the pre-rule behavior, hosts without the capability skip with a loud warning naming the lost coverage, and the compat shapes (passwd-backed uid, absent platform home variable, unambiguous operator home, dynamic declaration) are asserted unchanged on every platform, using the platform-authoritative key (`USERPROFILE` on Windows). `agent-dir-trust.test.ts`'s account-home expectation now reads the passwd database directly instead of a parent-side `os.userInfo().homedir`, which follows an isolated `HOME` and made the assertion fail under a pristine `HOME` (#4773).

### Fixed
- Explicit plugin homes now short-circuit safely when authoritative-home resolution is unavailable, while equal-home calls retain the default XDG-aware path.
- NSS account-home cache entries are now scoped by effective uid and account identity, so setuid or container identity transitions cannot reuse another user's trusted home or state; failed lookups remain fail-closed and call-time HOME/XDG refresh is unchanged.
- The authoritative home for user-scope state is resolved at call time again, instead of being snapshotted when `dirs.ts` loads. The provenance hardening had anchored `getTrustedHomeDir()` (and everything derived from it: config root, default agent dir, plugins dir) to an import-time value, so any home established or changed after module load silently lost every user-scope location -- user-scope skills under `~/.gjc/agent/skills` and user-scope MCP servers under `~/.gjc/agent/mcp.json` stopped being discovered. The provenance rule is unchanged: a home the project dotenv could have planted is still rejected in favor of the OS account database, and a bare filesystem root is still refused (#4761).
- An ambiguous home is no longer refused when the account database corroborates it. Independence was tested by string inequality (`accountHome !== runtimeHome`), so an operator whose `HOME` legitimately matches their account entry was locked out of their own user state as soon as any checkout declared `HOME` dynamically -- the account lookup was treated as an echo precisely when it agreed. Independence is now a property of the *source*: an NSS answer is environment-independent evidence whichever path it names, while an `os.userInfo()` fallback (which Bun derives from `$HOME`) is never evidence. A planted home is still rejected whenever the account database contradicts it, and still fails closed when no environment-independent lookup is available (#4761).
- The runtime home is validated before it can be trusted. `resolveTrustedHome()` accepted whatever `os.homedir()` returned, so a relative home (Bun returns `HOME` verbatim) anchored the config root, agent dir and plugins dir beneath the current working directory. It is now held to the same absolute, non-root standard as the account home, and an unusable value falls through to the account lookup instead of being honored (#4761).
- The Linux account home is read through NSS (`getent passwd <uid>`) instead of parsing `/etc/passwd` directly. LDAP- and SSSD-backed accounts have no local passwd entry, so the file read missed them entirely and fell through to `os.userInfo().homedir`, which Bun derives from `$HOME` -- exactly the untrusted value the account lookup exists to avoid. `getent` is the NSS front end, so local and directory-backed accounts both resolve; the probe runs with a fixed `PATH`/`LC_ALL` and no inherited environment. macOS and Windows keep the portable `os.userInfo()` path (#4761).
- A project-declared `HOME` could again select the trusted home on macOS, so credentials were read from a checkout-controlled home directory. When the project dotenv declares the platform-authoritative home variable, the resolver falls back to `accountHomeFromSystem()`; that helper reads `os.userInfo().homedir`, which Bun resolves from `$HOME` on macOS (unlike Node, which reads the passwd database). The rejected value therefore came back as its own justification and `~/.env` under the hostile home was parsed for credentials. The account home is now accepted as independent evidence only when it comes from an environment-independent source -- true for the Linux NSS account lookup, false for the `os.userInfo()` fallback that Bun derives from `$HOME` -- and an ambiguous home with no independent evidence resolves to the filesystem root sentinel, which marks user state unavailable and keeps credential resolution fail-closed.
- Windows environment names are case-insensitive, but every project-dotenv provenance lookup was keyed on the exact case parsed from the file. A `.env` line `userprofile=...`, `gjc_coding_agent_dir=...`, or a lowercase provider key was therefore invisible to the trusted-home, agent-directory and credential guards while `process.env`/`Bun.env` still resolved it -- the declaration was live but unguarded. Project snapshot keys and their lookups are now folded through `canonicalEnvKey()`, which upper-cases on Windows only; POSIX names stay case-sensitive, pinned by a test that fails if the fold is applied unconditionally. The `win32` branch itself is proven by `packages/utils/test/env-provenance.windows.test.ts`, which runs on the required windows-latest lane: a lowercase `userprofile`, a mixed-case `Gjc_Coding_Agent_Dir`, and a lowercase provider key declared by the project are all rejected, while a genuinely inherited uppercase credential still resolves.
- `postmortem.test.ts` no longer writes its crash fixtures into the developer's real crash store. Every scenario there deliberately crashes a subprocess, and the fatal handler resolved `getCrashLogPath()` with no override, so each run injected a dozen `fixture: ...` signatures into `~/.gjc/agent/gjc-crash.log` -- visible in `gjc crash list`, offered up by `gjc crash report`, eligible for the opt-in upstream relay, and competing for the log's fixed byte cap against a genuine crash the developer might need to file. The spawned fixtures now run under a temp `GJC_CODING_AGENT_DIR`, and the tests assert the fixture store received the records and the real store was untouched.
- The process-level fatal handler (`uncaughtException` / `unhandledRejection`) again journals an `occurrence` event for every recorded crash. The `writeCrashRecord` refactor had moved journaling exclusively into `recordFatalCrash`, so process-handler crashes wrote the log without the journal event that crash indexing, listing, nudging, and the upstream relay consume; the handler now routes through `recordFatalCrash`, which also restores the printed `crash recorded at <path>` line (it previously interpolated the record object as `[object Object]`).
- The handled-error fingerprint dedupe set now evicts the coldest entry at its 256-entry cap (LRU) instead of permanently rejecting new fingerprints, so a long-lived process keeps recording newly seen failure classes; a still-hot class remains deduped.

### Added
- `getMCPConfigPath("user", cwd, agentDir?)` accepts the agent directory that holds the user scope, resolved through the same `agentSubdir` path as the other agent-directory files, so a caller working on behalf of a session whose agent directory differs from the process-wide one names that session's `mcp.json` (#4767).
- `recordHandledError` captures non-fatal errors that were caught and handled, into a store parallel to the fatal one (`gjc-error.log`, `gjc-error-events.jsonl`, `gjc-error-index.json`) reachable via the new `getHandledErrorLogPath` / `getHandledErrorEventsPath` / `getHandledErrorIndexPath` resolvers. Separate files rather than a shared cap, because handled errors are high-volume and would otherwise evict the rare fatal records. Only an `Error` with a non-empty stack is recorded -- without a stack the v1 fingerprint degrades to `<no-app-frame>` and unrelated failures would collapse into one group. A fingerprint is recorded at most once while it stays hot; the dedupe set is bounded at 256 entries with LRU eviction, so a tool failing in a loop cannot flood the store and a long-lived process never goes blind to new failure classes. `writeCrashRecord` now returns the written record instead of appending the journal event itself, so the fatal path keeps its one-write latch while the handled path stays unlatched; record format, `redactCrashSecrets` scrubbing, and marker emission are unchanged and shared.
- The crash event journal carries five event kinds; the new `relayed` kind records that a signature was accepted by a configured crash upstream (`fingerprint`, `at`, the represented record id, and a locally generated 32-hex `eventId` sent upstream — it is generated here, not returned by the upstream). It serializes through the same bounded single-line path as every other event and parses under the same strictness — a malformed fingerprint, record id, non-lowercase-hex event id, or out-of-range timestamp yields `undefined` rather than a partially populated event.
- `getTrustedAgentFile()` joins a filename under the provenance-checked agent directory and never follows `XDG_STATE_HOME`, so automatic crash relay cannot read a checkout-controlled XDG state root.
- New `sanitizeHeaderComponent()` helper strips everything outside printable ASCII from a value destined for an HTTP header, so runtime-derived components (Android kernel release names embed non-ASCII like `Minimal™`) can never make `Headers`/`fetch` throw.

## [0.14.2] - 2026-08-20

### Added
- Crash journal and postmortem support for the opt-in upstream relay: relayed-upstream transitions are journaled and indexed, with bounded queues and LRU-bounded handled-error dedupe.

### Fixed
- Postmortem tests no longer write into the real crash store; they isolate into a fresh store per run.
- Rotating agent environment credentials reload correctly and rotation writes are hardened against partial reads.

## [0.14.1] - 2026-08-18

## [0.14.0] - 2026-08-17

### Added
- Fatal crash records now end with a machine-readable identity line (`gjc-crash-record.v1 fp:<32hex> fpv:1 id:<random>`) whose 128-bit fingerprint is computed from the already-captured diagnostic text with typed normalization (paths/home/uuid/hex/long-digit placeholders, `404` and `500` kept distinct, no line/column numbers in frames). The fatal path also appends one bounded (≤512 B) `O_APPEND` line to a new crash event journal beside the crash log; failures are swallowed and a latch makes a crash-during-crash skip journal work. New `getCrashEventsPath()` / `getCrashIndexPath()` resolvers, and `redactCrashSecrets` is now exported.

### Fixed
- Project `.env` trust guards now recognize the full assignment syntax Bun's dotenv loader accepts: `export NAME=value`, whitespace around `=`, and unquoted trailing `#` comments (`NAME=value # note`), so exported or spaced directory overrides cannot redirect trusted configuration sources.

## [0.13.3] - 2026-08-15

### Fixed
- Governed process exits now drain both stdout and stderr before terminating, preserving timing output and diagnostics when either stream is backpressured.

## [0.13.2] - 2026-08-13

## [0.13.1] - 2026-08-11

## [0.12.21] - 2026-08-09

## [0.12.20] - 2026-08-09

## [0.12.19] - 2026-08-08

## [0.12.18] - 2026-08-08

## [0.12.17] - 2026-08-08

## [0.12.16] - 2026-08-08

### Changed

- Process-tree and native process helpers now defer native binding access until the operation is invoked.
- `readJsonl` now accepts an optional raw-line observer for byte-derived diagnostics while isolating observer failures from stream consumption.

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
