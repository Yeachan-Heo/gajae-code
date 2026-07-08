# Changelog

## [Unreleased]

## [0.9.1] - 2026-07-08

### Changed

- Declared the glibc runtime requirement in Linux platform package metadata.

## [0.7.9] - 2026-07-01

### Changed

- Split published prebuilt `.node` artifacts into per-platform optional `@gajae-code/natives-*` packages while keeping `@gajae-code/natives` as the stable loader/types package with legacy local fallback resolution (#1280).

## [0.7.0] - 2026-06-22

### Added

- `gjc-notifications` native core: a per-session loopback WebSocket notification server with token-gated handshake, action lifecycle (ask/idle, resolve, reply rejection), endpoint discovery file, and the camelCase-field/snake_case-type wire protocol that underpins the notifications SDK (#874).

## [0.6.2] - 2026-06-19

### Removed

- Removed the embedded tiktoken/o200k tokenizer: deleted `crates/pi-natives/src/tokens.rs`, the `tiktoken-rs` dependency, and the `countTokens`/`Encoding` napi exports. This shrinks the native addon by ~3.8MB on disk and removes the ~50MB BPE table that previously materialized on first token count (#879).

## [0.6.0] - 2026-06-18

### Fixed

- Fixed computer-use supervisor liveness on macOS by refreshing the kill-switch heartbeat from the live event-tap run loop while idle and clearing liveness on tap/run-loop failure or teardown, preventing false `COMPUTER_SUPERVISOR_NOT_LIVE` rejections without weakening fail-closed input gating.

## [0.5.3] - 2026-06-16

### Fixed

- Hardened the native blocking-task boundary: work runs inside `catch_unwind` and panic payloads are converted to `napi::Error` so a panic can never unwind across the N-API/libuv boundary, cancellation is enforced before work starts, and `CancelToken` honors an already-aborted `AbortSignal`. The shipped `ci`/`local` build profiles now compile the addon with `panic = "unwind"` (instead of inheriting `release`'s `panic = "abort"`), so this guard actually engages in published binaries instead of aborting the process (U1).
- Fixed PTY session lifecycle and native backpressure: dropping a JS `PtySession` kills the child (no orphaned PTY), setup-error paths terminate/reap the child and close handles via an RAII guard with a bounded reap loop, foreground-child exit terminates the PTY process group before the final reader drain, Windows `openpty` is single-flight to cap a hung ConPTY thread, and PTY/shell callback bridges use bounded channels with explicit truncation/loss markers guaranteed at EOF (U2).
- Fixed pi-shell timeout/abort handling: the `timeout` builtin reaps its nested command's process group (captured PGID + TERM/KILL waves) before returning 124, top-level cancellation signals the captured process group so reparented same-group grandchildren are reaped, the `AbortToken` is published before any await to close the abort handoff window, streaming output is bounded with an `OutputBudget` and truncation is surfaced on the result, and `terminate_background_jobs` uses an awaited TERM→KILL escalation (U3).
- Capped oversized inputs at synchronous native entrypoints as defense-in-depth for freeze prevention: `count_tokens` returns the chars/4 heuristic above `PI_NATIVE_MAX_TOKENIZE_BYTES` (16 MiB) without initializing the BPE table, `highlight_code` returns the original code above `PI_NATIVE_MAX_HIGHLIGHT_BYTES` (16 MiB), and fuzzy edit matching reports no match above `PI_NATIVE_MAX_FUZZY_UNITS` (16 Mi UTF-16 units). Normal callers are unaffected because TypeScript call sites already enforce lower caps (#744).

## [0.5.1] - 2026-06-14

- Version aligned with the 0.5.1 monorepo release; no functional changes in this package.

## [0.5.0] - 2026-06-13

### Fixed

- Fixed pi-shell bash fixups on multibyte UTF-8 commands by converting parser source indexes to byte offsets before stripping `head`/`tail` pipelines.

## [0.4.5] - 2026-06-12

### Changed

- Added native build/embed guard plumbing and version-sentinel export checks for the 0.4.5 native package surface, keeping stale `.node` files from silently loading under a new wrapper.
- Refreshed native tokenizer/grammar loading paths for the reduced-memory compiled CLI surface.

## [0.4.4] - 2026-06-10

- Version aligned with the 0.4.4 monorepo release; no functional changes in this package.

## [0.4.0] - 2026-06-06

### Added

- Added a native `diffLines(oldStr, newStr)` export — a byte-identical Rust port of jsdiff's line diff (`crates/pi-natives/src/linediff.rs`) for the coding-agent edit tool, avoiding the pure-JS Myers blowup on large files.
- Added native fuzzy edit matching (`crates/pi-natives/src/edit_fuzzy.rs`) and a native `hashline` helper (`crates/pi-natives/src/hashline.rs`) for the coding-agent edit hot paths.
- Optimized CPU/memory hotspots with native ports (H06 + H02), byte-identical output at roughly 2x or better throughput on the affected paths (#356).

## [0.2.2] - 2026-05-31

### Changed

- Refreshed native package metadata and version sentinel for the GJC 0.2.2 release.

## [0.2.1] - 2026-05-30

### Changed

- Refreshed native package metadata and version sentinel for the GJC 0.2.1 release.

## [0.2.0] - 2026-05-28

### Changed

- Refreshed native package metadata and version sentinel for the GJC 0.2.0 release.

## [0.1.3] - 2026-05-28

### Changed

- Released the current dev branch fixes with refreshed 0.1.3 package metadata.

## [0.1.2] - 2026-05-28

### Changed

- Updated package metadata for the Gajae Code npm publication.

## [15.3.2] - 2026-05-25

### Fixed

- Fixed `matchesKey` claiming `ctrl+m`/`ctrl+j`/`ctrl+i`/`ctrl+h`/`ctrl+[` for the single bytes terminals emit for Enter/Tab/Backspace/Escape in legacy mode. Pressing Enter no longer triggers a `ctrl+m` binding; the named keys now own those bytes and the colliding `ctrl+<letter>` combinations only match when the terminal disambiguates via the Kitty keyboard protocol or `modifyOtherKeys`. The same gate now also applies to `ctrl+alt+<letter>` legacy `ESC + <ctrl-char>` sequences (e.g. `\x1b\r` is Alt+Enter, not Ctrl+Alt+M). ([#1354](https://github.com/can1357/gajae-code/issues/1354))

## [15.0.2] - 2026-05-15

### Added

- Added a per-release version sentinel napi export (`__piNativesV{major}_{minor}_{patch}`). The Rust `js_name` is bumped in lock-step with the package version by `scripts/release.ts`; the JS loader computes the expected name from `package.json#version` and throws an actionable error when the on-disk `.node` doesn't expose it. This converts the silent `<sym> is not a function` crash from a stale addon into a load-time failure pointing at the real fix.
- Added `applyBashFixups(command)` — a synchronous brush-parser-driven rewrite that strips trailing `| head|tail …`, redundant `2>&1`, and the `|&` shorthand from top-level pipelines, returning `{ command, stripped }`. Replaces the hand-rolled top-level mask scanner in `gajae-code`; tokenization, quoting, heredocs, command substitution, and nested compound commands are now handled by the real shell AST instead of regex/character-walking. Lives in `pi_shell::fixup` on the Rust side.

### Fixed

- Fixed `<sym> is not a function` crashes on Windows after `bun install -g @gajae-code/coding-agent` updates while a `gjc` process was running. Bun cannot overwrite a locked `node_modules/@gajae-code/natives/native/pi_natives.win32-x64.node` and silently keeps the old binary alongside the new ESM wrapper, so the next launch loads mismatched code. The loader now mirrors the addon into `~/.gjc/natives/<version>/` on Windows npm installs and prefers that copy at load time — each version gets its own filesystem path, so future updates land in `node_modules` unchallenged. The new version sentinel detects any remaining drift up front.

### Fixed

- Fixed `$env:NAME` PowerShell references being collapsed to `:NAME` when brush forwarded a command to a PowerShell (or any) subprocess. `pi-shell` now defines `env=$env` as a non-exported global on every brush session so the bash parameter expansion of `$env` yields the literal `$env`, leaving `$env:NAME` intact. User-driven assignments (`env=prod`) push their own command-scope binding and shadow the fallback, preserving the bash POSIX contract. ([#1079](https://github.com/can1357/gajae-code/issues/1079))

## [15.0.1] - 2026-05-14
### Breaking Changes

- Raised the minimum required Bun runtime version to >=1.3.14
- Removed `PhotonImage` class, `ImageFormat` enum, and `SamplingFilter` enum from native exports. General-purpose image decode/resize/encode now uses [`Bun.Image`](https://bun.com/docs/runtime/image), which ships in Bun 1.3.14+ with statically-linked libjpeg-turbo, libspng, and libwebp plus SIMD geometry kernels — same operations, zero native-addon footprint. `encodeSixel` stays (no Bun equivalent for the SIXEL terminal protocol).
- Removed `webp` Rust workspace dependency along with `PhotonImage`'s WebP encoder.

## [14.9.9] - 2026-05-12
### Breaking Changes

- Removed `projfsOverlayProbe`, `projfsOverlayStart`, and `projfsOverlayStop` overlays APIs and `ProjfsOverlayProbeResult` type from the public natives interface

### Added

- Added unified isolation APIs `isoBackend`, `isoProbe`, `isoResolve`, `isoStart`, `isoStop`, `isoDiff`, and `isoIsUnavailableError` for selecting, probing, resolving, starting, stopping, and diffing isolated filesystems
- Added `IsoBackendKind`, `IsoChangeKind`, `IsoDiff`, `IsoFileChange`, `IsoProbeResult`, and `IsoResolveResult` type exports to describe isolation backend capabilities and diff outcomes

### Changed

- Changed `native` exports to remove the platform-specific ProjFS-only overlay surface in favor of generic isolation controls

## [14.9.5] - 2026-05-12

### Fixed

- Fixed shell cancellation occasionally killing the harness. The `pi_shell` descendant tracker harvested every descendant's `pgid` into the kill set, so any subprocess that inherited the harness's pgid (any helper spawned via APIs that do not call `setpgid` — sibling LSP/MCP processes, etc.) dragged `harness.pgid` into the list and the follow-up `kill(-harness.pgid, SIGTERM)` terminated the harness alongside the targets. The classifier now only adopts a `pgid` when its leader is itself one of the new descendants, and `kill_process_group` refuses the harness's own process group as a last-line defense.
- Fixed macOS process-tree termination silently doing nothing. The descendant walk relied on `proc_listchildpids`, which on recent darwin kernels (25.4+) returns no entries when a process queries its own children, so `Process::descendants` came back empty and tree-kill cleanup never reached grandchildren. The walk now builds a one-shot `ppid → [pid]` map from `proc_listallpids` + `proc_pidinfo`, matching the approach already used by `find_by_path` and the Windows Toolhelp path.

### Changed

- Removed the 20 Hz background descendant tracker that scanned the harness's process tree for the entire lifetime of every shell command. Cancellation now does a small rescan-and-signal loop on demand (up to three waves — SIGTERM, then SIGKILL, then SIGKILL — with early exit as soon as no descendants remain). The previous tracker existed to pin process identities against PID reuse races, but `Process::from_pid` already pins identity by kernel start time / pidfd, so the constant scanning paid for nothing and added meaningful syscall load on macOS where each scan now does `proc_listallpids` + `proc_pidinfo` per pid.

## [14.9.3] - 2026-05-10
### Added

- Added `idle`, `system`, and `user` options to `MacOSPowerAssertion` so callers can request specific macOS sleep-prevention modes (`caffeinate -i`, `-s`, and `-u`) in addition to the existing `display` option
- Added support for combining multiple macOS power assertion flags in a single `MacOSPowerAssertion` handle

### Changed

- Changed `MacOSPowerAssertion.stop()` documentation to indicate it releases all held assertions and is safe to call repeatedly as a no-op

## [14.9.2] - 2026-05-10

### Added

- Added `listWorkspace`, a native single-pass workspace walker that returns bounded tree entries and AGENTS.md directory-context candidates together.

## [14.7.1] - 2026-05-06

### Added

- Added `size` property to `GlobMatch` for regular files to expose their byte size

### Changed

- Sped up native `grep` files-with-matches searches by stopping after the first match per file, reading small files without mmap overhead, and relying on grep-searcher binary detection instead of a separate full-file NUL scan.

### Fixed

- Fixed native `grep` `filesWithMatches` mode so `totalMatches` reports the number of matching files rather than line-match totals
- Fixed native `grep` count-mode limits applying to files instead of matches, and restored timeout/abort cancellation checks for small native filesystem scans.

## [14.7.0] - 2026-05-04
### Added

- Added `summarizeCode` function to expose native code summarization with `kind`, `startLine`, `endLine`, and optional `text` segments plus parse/elision metadata
- Added `minBodyLines` and `minCommentLines` options to `summarizeCode` to control when function/body and multiline comment elision is applied
- Added `SummaryOptions` and `SummaryResult` TypeScript definitions for typed `summarizeCode` input and output

## [14.6.1] - 2026-05-02
### Changed

- Changed the native package loader from CommonJS analyzer-visible assignments to a template-rendered ESM entry point with explicit named exports

## [14.5.13] - 2026-05-01
### Changed

- Stopped overriding `CARGO_TARGET_DIR` with an internal `target/napi-build/...` directory during native builds, so Cargo now uses the default or caller-provided target directory
- Simplified native build profile suffix formatting without changing `local` and `ci` values
- Changed the native build output behavior to avoid setting an isolated Cargo target directory automatically

### Removed

- Removed the host Zig CPU contract wrapper (`zig-safe-wrapper.ts`) and its `ZIG`/`PI_NATIVE_REAL_ZIG`/`PI_NATIVE_ZIG_TARGET`/`PI_NATIVE_ZIG_CPU` env handling, since the `zlob` Rust dependency that required Zig is gone
- Removed the `ci-release-verify-natives` script and its AVX-512 marker scan from the release pipeline

## [14.5.12] - 2026-04-30
### Breaking Changes

- Changed `waitForExit` to accept a single options object instead of a numeric timeout argument

### Added

- Added a `signal` option to `terminate` for cancelling termination while waiting for process shutdown
- Added abort `signal` support to `waitForExit` via `ProcessWaitOptions`
- Added a `ProcessWaitOptions` type and updated `waitForExit` to accept an options object

## [14.5.9] - 2026-04-30
### Fixed

- Fixed shell minimizer output so successful commands whose noise is fully stripped still return `OK` instead of an artifact-only result

## [14.5.6] - 2026-04-29

### Added

- Added shell minimizer support for CMake, CTest, Ninja, GoogleTest binaries, and Bun/Bunx wrappers that run those tools

## [14.5.2] - 2026-04-26
### Changed

- Changed local native build profile from `dev` to `local` for non-CI builds, updating the profile used by the build and local build output label

## [14.4.2] - 2026-04-26

### Removed

- Removed the `chunk` napi module (`ChunkState`, chunk schema, chunk rendering, chunk edit) and dropped `generate_chunk_schema()` from the build script

## [14.3.0] - 2026-04-25
### Added

- Added `text` to `MinimizerResult` so consumers can replace rewritten output with the minimized replacement text
- Added `settingsHash` to `MinimizerOptions` to verify the minimizer `settingsPath` contents against a xxHash64 digest before applying them
- Added `minimized` output telemetry via `MinimizerResult` on `ShellExecuteResult` and `ShellRunResult`, exposing the applied minimizer filter and original/minimized byte counts when output is rewritten
- Added a new `minimizer` option to `ShellExecuteOptions` and `ShellOptions` to configure per-command output minimization
- Added the `MinimizerOptions` API with controls for enabling minimization, overriding settings via `settingsPath`, allow/deny lists (`only`, `except`), and `maxCaptureBytes` capture limits

### Changed

- Changed the shell output minimizer to more aggressively compact successful test runs, git output, large listings, grep/find results, source reads, and dependency manifests
- Changed compound and piped shell commands to bypass output minimization entirely, keeping minimization limited to eligible whole-command output after the command exits

### Fixed

- Fixed chunk edit batches so later operations can reuse an initially validated checksum after an earlier operation changes that same chunk

### Removed

- Removed `PI_DEV` loader diagnostic env var and associated console logging in the native addon loader

### Security

- Added trust-gated loading for minimizer settings by requiring a matching `settingsHash` before accepting a settings file

## [14.2.0] - 2026-04-23

### Added

- Added Dart support to `astGrep` and `astEdit` through the native tree-sitter Dart grammar ([#748](https://github.com/can1357/gajae-code/pull/748) by [@0fflineuser](https://github.com/0fflineuser))

## [14.1.1] - 2026-04-14

### Added

- Added support for honoring the `ZIG` environment variable when resolving the Zig executable for native builds

### Removed

- Removed the `SearchDb` API from the natives type declarations
- Removed the optional `db` parameter from `fuzzyFind`, `glob`, and `grep`
- Removed the `fuzzyFind`, `glob`, and `grep` cache database argument previously used for search state

## [14.0.5] - 2026-04-11
### Breaking Changes

- Made `tabWidth` parameter required (no longer optional) for `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments`
- Removed `getIndentation`, `getDefaultTabWidth`, and `setDefaultTabWidth` (moved to `@gajae-code/utils`)
- `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments` now require an explicit `tabWidth` argument

## [14.0.4] - 2026-04-10

### Added

- Added `normalizeIndent` option to `EditParams` to control indentation normalization for response rendering and inserted content
- Added `hasConflicts()` method to detect unresolved merge conflicts in parsed files
- Added `conflictCount()` method to count unresolved merge conflicts in the chunk tree

## [14.0.2] - 2026-04-09

### Added

- Added `Decl` variant to `ChunkRegion` enum for accessing semantic declarations without leading trivia
- Added `check:types` script for explicit TypeScript type checking
- Added `lint` script for running Biome linter
- Added `fmt` script for code formatting with Biome
- Added package exports field with typed entry point configuration
- Added turbo.json configuration for build task caching and optimization

### Changed

- Renamed `build:native` script to `build` for simpler invocation
- Updated `check` script to separately call `check:types` for type checking
- Modified tsconfig.json to extend `tsconfig.workspace.json` instead of `tsconfig.base.json`

## [14.0.0] - 2026-04-08

### Breaking Changes

- Changed `ChunkRegion.Inner` enum value to `ChunkRegion.Body` to align with region semantics
- Changed `ChunkRegion` enum values from `Container`, `Prologue`, `Body`, `Epilogue` to `Head`, `Inner`, `Tail` with updated semantics for region targeting
- Replaced `ChunkEditOp` enum values — `AppendChild`, `PrependChild`, `AppendSibling`, `PrependSibling`, and `ReplaceBody` are now `Before`, `After`, `Prepend`, and `Append` with updated semantics for region-scoped operations
- Removed `ReplaceBody` operation — use `Replace` with `region: ChunkRegion.Body` to replace only chunk body content
- Moved package entry point from `src/index.ts` to `native/index.js` — consumers must update imports to use the new native module path
- Removed TypeScript source files from `src/` directory — all APIs now exported from auto-generated `native/index.js` with types in `native/index.d.ts`
- Changed enum exports to runtime objects — `const enum` values are now available at runtime via generated enum exports in `native/index.js`

### Added

- Added `ChunkRegion` enum with `Container`, `Prologue`, `Body`, and `Epilogue` values for targeting specific regions within chunks
- Added `region` parameter to `EditOperation` to specify which chunk region to target (defaults to `Container`)
- Added `UnsupportedRegion` status to `ChunkReadStatus` enum to indicate when a chunk does not support the requested region
- Added `normalizeIndent` parameter to `RenderParams` and `ReadRenderParams` to normalize displayed indentation to canonical tabs
- Added `ReplaceBody` chunk edit operation to replace only the inner body of a chunk while preserving signature and closing delimiter
- Added `ChunkFocusMode` enum with `Expanded`, `Collapsed`, and `Container` modes for controlling chunk participation in focus-scoped render passes
- Added `FocusedPath` interface to pair paths with focus modes for the N-API boundary
- Added `focusedPaths` parameter to `RenderParams` to restrict rendering to specified chunks with their focus modes
- Generated native module bindings in `native/index.js` and `native/index.d.ts` from napi-rs build output
- Added `gen-enums.ts` script to extract and export runtime enum values from TypeScript const enums
- Added `embedded-addon.js` for managing embedded native addon variants and metadata
- Added `MacOSPowerAssertion` for session-scoped macOS idle-sleep prevention without shelling out

### Changed

- Changed `ChunkInfo.name` field to optional `identifier` field — now provides bare chunk identifier without kind prefix instead of display name
- Updated `region` parameter documentation in `EditOperation` to clarify full chunk targeting when omitted instead of container-scoped default
- Updated `ChunkEditOp` documentation to reflect region-scoped semantics — operations now target specific regions rather than chunk structure positions
- Changed `ChunkEditOp.Replace` documentation to clarify substring replacement via `find` parameter instead of line-based replacement
- Changed `EditOperation` interface to use `find` parameter for scoped find/replace operations instead of `line` and `endLine` parameters
- Changed `EditParams` documentation to remove mention of scheduling reordering for line-scoped groups
- Simplified native build pipeline by removing `--dev` flag support; debug builds no longer available through npm scripts
- Updated native module loader to check `XDG_DATA_HOME` environment variable for native addon location before falling back to `~/.gjc/natives`
- Removed native binding validation function that checked for required exports at load time
- Refactored build pipeline to use napi-rs generated bindings instead of hand-written TypeScript wrappers
- Updated `build-native.ts` to generate runtime enum exports after native compilation
- Updated `embed-native.ts` to output JavaScript instead of TypeScript for embedded addon metadata

### Removed

- Removed `dev:native` npm script — use `build:native` for all build scenarios
- Removed inline pi-utils helpers and dependency on `@gajae-code/utils` from native module loader
- Removed `logger.time()` wrapper calls from native module loading
- Removed all TypeScript wrapper modules from `src/` directory (appearance, ast, chunk, clipboard, glob, grep, highlight, html, image, keys, projfs, ps, pty, shell, text, work)
- Removed `src/bindings.ts` and `src/index.ts` entry points
- Removed `src/search-db.ts` and `src/search-db-types.ts`

## [13.16.1] - 2026-03-27

### Added

- Exported `SearchDb` class from main package entry point for direct instantiation
- Added `SearchDb` class for stateful shared search database instances to improve performance across multiple search operations
- Added optional `db` parameter to `grep()`, `glob()`, and `fuzzyFind()` functions to enable database-backed searching

### Changed

- Updated `grep()`, `glob()`, and `fuzzyFind()` function signatures to accept optional `db` parameter for database-backed searching

## [13.12.0] - 2026-03-14
### Breaking Changes

- Changed `abort()` method signature: removed optional `reason` parameter and changed return type from `void` to `Promise<void>`

## [13.4.0] - 2026-03-01
### Breaking Changes

- Changed `AstFindOptions.pattern` to `patterns` (now accepts array of strings instead of single string)
- Replaced `AstReplaceOptions.pattern` and `rewrite` with single `rewrites` option (Record<string, string>)

### Added

- `astGrep` now accepts multiple patterns in a single call; results from all patterns are merged and sorted by file path then position before offset/limit are applied
- `astEdit` now accepts a `rewrites` map (`Record<string, string>`) and applies all patterns per file in a single pass, compiling them once upfront
- Result ordering in `astGrep` is now deterministic: sorted by path, line, column using `BTreeSet`/`BTreeMap`

## [13.3.8] - 2026-02-28
### Added

- Added `astGrep()` function for structural code search using AST patterns with support for language-specific matching, selectors, and meta-variable extraction
- Added `astEdit()` function for structural code rewriting with dry-run mode, replacement limits, and parse error handling
- Added `./ast` export path for accessing AST search and rewrite functionality

## [12.18.0] - 2026-02-21
### Changed

- Replaced custom `TextDecoder` usage with native `toString('utf-8')` for buffer decoding
- Replaced custom debug logging with structured `logger.time()` calls for startup performance tracking

## [12.17.1] - 2026-02-21

### Added

- Expanded package exports to support subpath imports for clipboard, glob, grep, highlight, html, image, keys, ps, pty, shell, text, and work modules
- Added wildcard export patterns (`./*`) for all submodules to enable flexible import paths

### Changed

- Updated package description to clarify native bindings for grep, clipboard, image processing, syntax highlighting, PTY, and shell operations
- Expanded package keywords to include clipboard, image, pty, shell, and syntax-highlighting for better discoverability
- Added README.md to package distribution files

## [12.10.0] - 2026-02-18
### Changed

- Updated addon filename resolution to include default filename fallback in both modern and baseline variant paths

## [12.8.2] - 2026-02-17
### Breaking Changes

- Removed `getSystemInfo()` and `SystemInfo` from package exports, breaking consumers that imported system info APIs from this package

## [12.8.0] - 2026-02-16
### Added

- Added support for x64 CPU variant selection with `TARGET_VARIANT` environment variable (modern/baseline) during build to optimize for specific ISA levels
- Added automatic AVX2 detection on Linux, macOS, and Windows to select optimal native addon variant at runtime
- Added `PI_NATIVE_VARIANT` environment variable to override CPU variant selection at runtime
- Added support for multiple native addon variants per platform (modern with AVX2, baseline without AVX2) for improved performance portability

### Changed

- Changed native addon filename scheme to include CPU variant suffix for x64 builds (e.g., `pi_natives.linux-x64-modern.node`)
- Changed embedded addon structure to support multiple variant files per platform instead of single file
- Changed native addon loader to automatically select appropriate variant based on CPU capabilities or explicit override
- Changed build output to include variant information in console messages

### Removed

- Removed fallback untagged `pi_natives.node` binary creation for native builds; platform-tagged variants are now required

### Fixed

- Fixed regex patterns containing literal braces (e.g. `${platform}`) failing with "repetition quantifier expects a valid decimal" by escaping `{`/`}` that don't form valid repetition quantifiers

## [12.5.0] - 2026-02-15
### Added

- Added `recursive` option to `GlobOptions` to control whether simple patterns match recursively (defaults to true)

### Changed

- Changed default glob pattern behavior to always use recursive matching for simple patterns instead of requiring explicit `**/` prefix
- Updated `fileType` filter documentation to clarify that symlinks match file/dir filters based on their target type

## [12.4.0] - 2026-02-14
### Added

- Exported `sanitizeText` function to strip ANSI codes, remove binary garbage, and normalize line endings in text output

## [12.1.0] - 2026-02-13
### Added

- Added `cache` option to `glob()`, `grep()`, and `fuzzyFind()` to enable shared filesystem scan caching
- Added `invalidateFsScanCache()` function to manually invalidate filesystem scan cache entries

## [11.14.0] - 2026-02-12
### Added

- Added `PtySession` class for PTY-backed interactive command execution with streaming output
- Added `PtyStartOptions` interface to configure pseudo-terminal sessions with command, working directory, environment variables, and terminal dimensions
- Added `PtyRunResult` interface to report command exit code, cancellation, and timeout status
- Added `write()` method to send raw input to PTY stdin
- Added `resize()` method to dynamically adjust PTY column and row dimensions
- Added `kill()` method to force-terminate active commands

## [11.3.0] - 2026-02-06

### Added

- OSC 52 fallback for clipboard operations over SSH/mosh connections
- Termux support with `termux-clipboard-set` integration
- Headless environment guards to prevent clipboard errors when no display server is available
- Async clipboard API with improved error handling and fallback strategies

### Changed

- OSC 52 clipboard emission now only occurs in real terminal environments (when stdout is a TTY), preventing unnecessary output in piped or headless contexts
- Improved error handling for OSC 52 writes to gracefully handle EPIPE errors when stdout is closed or piped to processes that exit early
- Clipboard functions now return promises for better async handling
- Native clipboard operations are now best-effort with graceful degradation

## [11.0.0] - 2026-02-05
### Removed

- Removed legacy type aliases `WasmMatch` and `WasmSearchResult`

## [10.6.0] - 2026-02-04

### Changed

- Added separate grep context before/after options in bindings

## [10.2.2] - 2026-02-02
### Added

- Exported `getWorkProfile` function and `WorkProfile` type for work profiling capabilities

## [10.2.0] - 2026-02-02
### Breaking Changes

- Replaced `find()` with `glob()` - update imports and function calls
- Changed file type filtering from string values to `FileType` enum
- Removed `abortShellExecution()` function - use `Shell.abort()` method instead
- Removed `RequestOptions` parameter from `htmlToMarkdown()` - pass options directly

### Added

- Added `glob()` function for file discovery with glob pattern matching and .gitignore support
- Added `Cancellable` interface for timeout and abort signal support across async operations
- Added `FileType` enum to filter glob results by file type (File, Dir, Symlink)
- Added `signal` parameter to shell operations for cancellation via AbortSignal

### Changed

- Renamed `find()` to `glob()` for file discovery operations
- Renamed `FindMatch` to `GlobMatch` and `FindOptions` to `GlobOptions`
- Moved timeout and abort signal handling into unified `Cancellable` interface across grep, glob, and shell modules
- Updated `Shell.abort()` to accept optional abort reason parameter
- Simplified `htmlToMarkdown()` signature by removing `RequestOptions` parameter

### Removed

- Removed `RequestOptions` type and `wrapRequestOptions()` utility function
- Removed `abortShellExecution()` function; use `Shell.abort()` instead
- Removed `executionId` parameter from `ShellExecuteOptions`

## [10.1.0] - 2026-02-01

### Breaking Changes

- Changed `executionId` parameter type from `string` to `number` in `abortShellExecution()` and `ShellExecuteOptions`
- Removed `sessionKey` field from `ShellExecuteOptions`

### Added

- Added `getWorkProfile()` function to retrieve work scheduling profiling data from a circular buffer of recent activity
- Added `WorkProfile` type with folded stack format, markdown summary, SVG flamegraph, and sample metrics for profiling results

## [9.8.0] - 2026-02-01
### Breaking Changes

- Removed `resize()` function; use `PhotonImage.resize()` method instead
- Removed `terminateImageWorker()` function
- Changed `PhotonImage.new_from_byteslice()` to `PhotonImage.parse()`
- Changed `PhotonImage.get_bytes()` to `encode(ImageFormat.PNG, 100)`
- Changed `PhotonImage.get_bytes_jpeg(quality)` to `encode(ImageFormat.JPEG, quality)`
- Removed `get_width()` and `get_height()` methods; use `width` and `height` properties instead
- Removed manual resource management via `free()` and `Symbol.dispose`

### Added

- Added automatic extraction of embedded native addon to `~/.gjc/natives/<version>` on first run for compiled binaries
- Added `embed:native` build script to embed platform-specific native addon payloads into compiled binaries
- Exported `Shell` class for creating persistent shell sessions with `run()` method and session options
- Exported `ShellOptions`, `ShellRunOptions`, and `ShellRunResult` types for shell session management
- Exported `find()` function for file discovery with glob patterns and .gitignore support
- Exported `FindOptions`, `FindMatch`, and `FindResult` types for file search operations
- Exported `ImageFormat` enum for specifying output formats (PNG, JPEG, WEBP, GIF) in image encoding
- Added `ImageFormat` enum for specifying output format (PNG, JPEG, WEBP, GIF) in `encode()` method
- Added `SamplingFilter` as exported enum instead of object
- Added `Shell` class with persistent session options (`sessionEnv`, `snapshotPath`) and a `run()` command API
- Exported `getSystemInfo()` function and `SystemInfo` type for retrieving system information including distro, kernel, CPU, and disk details
- Exported `copyToClipboard()` and `readImageFromClipboard()` functions for clipboard operations
- Exported `ClipboardImage` type for clipboard image data with MIME type information
- Added `wrapTextWithAnsi()` function to wrap text to a visible width while preserving ANSI escape codes across line breaks
- Added native clipboard helpers for copying text and reading images via arboard

### Changed

- Enhanced native addon loading to prioritize extracted embedded addon for compiled binaries before falling back to system paths
- Improved error messages to provide platform-specific guidance for addon loading failures, including manual download instructions for compiled binaries
- Reorganized native bindings into modular type files with declaration merging via `NativeBindings` interface
- Moved type definitions from implementation files to dedicated `types.ts` modules for better separation of concerns
- Enhanced `SystemInfo` type with additional fields: `os`, `arch`, `hostname`, `shell`, `terminal`, `de`, `wm`, and `gpu`
- Refactored module exports to use direct destructuring from native bindings instead of wrapper functions
- Changed `PhotonImage` API to use instance methods (`resize()`, `encode()`) instead of standalone functions
- Changed `PhotonImage` to use property accessors for `width` and `height` instead of getter methods
- Embedded native addon payload for compiled binaries and extract to `~/.gjc/natives/<version>` on first run

## [9.7.0] - 2026-02-01

### Added

- Exported `killTree` function to kill a process and all its descendants using platform-native APIs
- Exported `listDescendants` function to list all descendant PIDs of a process
- Added `dev:native` npm script to build debug native binaries with `--dev` flag
- Added `GJC_DEV` environment variable support for loading and debugging development native builds
- Exported keyboard parsing and matching functions: `parseKey`, `parseKittySequence`, `matchesLegacySequence`, and `matchesKey` for terminal input handling
- Exported `KeyEventType` enum and `ParsedKittyResult` type for Kitty keyboard protocol support
- Added `parseKey` function to parse terminal input and return normalized key identifiers (e.g., "ctrl+c", "shift+tab")
- Added `parseKittySequence` function to parse Kitty keyboard protocol sequences with codepoint, modifier, and event type information
- Added `matchesLegacySequence` function to match legacy escape sequences for specific keys
- Added `matchesKey` function to match input against key identifiers with support for modifiers and Kitty protocol

### Changed

- Modified native binary build process to support both debug and release builds via `--dev` flag
- Updated native binary search to prioritize platform-tagged builds and separate debug/release candidates
- Changed debug builds to output to `pi_natives.dev.node` instead of mixing with release artifacts
- Improved native binary installation to use atomic rename operations and better fallback handling for Windows DLLs
- Reordered native binary search candidates to prioritize platform-tagged builds and avoid loading stale cross-compiled binaries
- Enhanced cross-compilation detection to prevent installing wrong-platform fallback binaries during cross-compilation builds

### Fixed

- Fixed potential issue where cross-compiled binaries could overwrite platform-specific native builds with incorrect architecture binaries

## [9.6.4] - 2026-02-01
### Breaking Changes

- Changed callback signature for `find()` and `grep()` streaming callbacks to receive `(error, match)` instead of `(match)` for proper error handling

## [9.6.2] - 2026-02-01
### Breaking Changes

- Renamed `EllipsisKind` enum to `Ellipsis`
- Changed `TextInput` type parameter to `string` in `truncateToWidth()`, `visibleWidth()`, `sliceWithWidth()`, and `extractSegments()` functions—Uint8Array is no longer accepted
- Removed `TextInput` type export from public API

### Added

- Added `visibleWidth()` function to measure the visible width of text, excluding ANSI codes

### Changed

- Reordered native module search paths to prioritize repository build artifacts
- Improved JSDoc documentation for `truncateToWidth()` with clearer parameter descriptions and behavior details
- Added early return optimization in `truncateToWidth()` to skip native call when text fits within maxWidth and padding is not requested
- Added early return optimization in `sliceWithWidth()` to return empty result when length is zero or negative

### Removed

- Removed validation checks for `PhotonImage` and `SamplingFilter` native exports
- Removed early return optimization in `truncateToWidth()` when text fits within maxWidth

## [9.6.1] - 2026-02-01
### Added

- Added `matchesKittySequence` function to match Kitty protocol sequences for codepoint and modifier

### Removed

- Removed `visibleWidth` function from text utilities

## [9.6.0] - 2026-02-01
### Added

- Support for cross-compilation via `CARGO_BUILD_TARGET` environment variable
- Support for overriding platform and architecture detection via `TARGET_PLATFORM` and `TARGET_ARCH` environment variables

### Changed

- Native build script now searches for release artifacts in target-specific directories when cross-compiling

## [9.5.0] - 2026-02-01

### Added

- Added `sortByMtime` option to `FindOptions` to sort results by modification time (most recent first) before applying limit
- Added streaming callback support to `grep()` function via optional `onMatch` parameter for real-time match notifications
- Exported `RequestOptions` type for timeout and abort signal configuration across native APIs
- Exported `fuzzyFind` function for fuzzy file path search with gitignore support
- Exported `FuzzyFindOptions`, `FuzzyFindMatch`, and `FuzzyFindResult` types for fuzzy search API
- Added `fuzzyFind` export for fuzzy file path search with gitignore support

### Changed

- Changed `grep()` and `fuzzyFind()` to support timeout and abort signal handling via `RequestOptions`
- Updated `GrepOptions` and `FuzzyFindOptions` to extend `RequestOptions` for consistent timeout/cancellation support
- Refactored `htmlToMarkdown()` to support timeout and abort signal handling

### Removed

- Removed `grepDirect()` function (use `grep()` instead)
- Removed `grepPool()` function (use `grep()` instead)
- Removed `terminate()` export from grep module
- Removed `terminateHtmlWorker` export from html module

### Fixed

- Fixed potential crashes when updating native binaries by using safe copy strategy that avoids overwriting in-memory binaries