# Natives Architecture

`@gajae-code/natives` is now a two-layer package around a loader:

1. **CommonJS loader/package entrypoint** resolves and loads the correct `.node` addon and patches generated enum objects onto the export object.
2. **Rust N-API module layer** implements the exported functions/classes and emits the generated TypeScript declarations.

This document is the foundation for deeper module-level docs. Performance-motivated native ports of leftover algorithmic hot paths are additionally gated by [`native-ffi-optimization-policy.md`](./native-ffi-optimization-policy.md).

## Implementation files

- `packages/natives/native/index.js`
- `packages/natives/native/index.d.ts`
- `packages/natives/native/loader-state.js`
- `packages/natives/native/embedded-addon.js`
- `packages/natives/scripts/build-native.ts`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/scripts/gen-enums.ts`
- `packages/natives/package.json`
- `crates/pi-natives/src/lib.rs`

## Package entrypoint and public surface

`packages/natives/package.json` points directly at generated native bindings:

- `main`: `./native/index.js`
- `types`: `./native/index.d.ts`
- `exports["."].types`: `./native/index.d.ts`
- `exports["."].import`: `./native/index.js`

There is no current `packages/natives/src` TypeScript wrapper layer. Consumers import functions/classes/enums directly from `@gajae-code/natives`; the type contract is the generated `native/index.d.ts` plus enum exports appended by `scripts/gen-enums.ts`.

Current capability groups in the generated API include:

- **Search/text/code primitives**: `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `astGrep`, `astEdit`, text width/slicing/wrapping/sanitization, syntax highlighting, token counting.
- **Execution/process/terminal primitives**: `executeShell`, `Shell`, `PtySession`, process-tree helpers, key parsing.
- **System/media/conversion primitives**: clipboard, image resize/encode/SIXEL, HTML-to-Markdown, macOS appearance/power helpers, work profiling, Windows ProjFS overlay helpers.

## Loader layer

`packages/natives/native/index.js` owns runtime addon selection and optional embedded extraction.

### Candidate resolution model

- Platform tag is `${process.platform}-${process.arch}`.
- Supported tags are currently:
  - `linux-x64`
  - `linux-arm64`
  - `darwin-x64`
  - `darwin-arm64`
  - `win32-x64`
- x64 can use CPU variants:
  - `modern` (AVX2-capable)
  - `baseline` (fallback)
- Non-x64 uses the default filename without a variant suffix.

Filename strategy:

- Default: `pi_natives.<platform>-<arch>.node`
- x64 variant: `pi_natives.<platform>-<arch>-modern.node` or `...-baseline.node`
- x64 runtime fallback includes the unsuffixed default filename after variant candidates.

### Platform-specific variant detection

For x64, variant selection uses:

- Linux: `/proc/cpuinfo`
- macOS: `sysctl -n machdep.cpu.leaf7_features`, then `machdep.cpu.features`
- Windows: PowerShell check for `System.Runtime.Intrinsics.X86.Avx2`

`GJC_NATIVE_VARIANT` can force `modern` or `baseline`; invalid values are ignored.

### Binary distribution and extraction model

`packages/natives/package.json` publishes `native/`, which contains the loader, generated declarations, generated enum patch, embedded-addon manifest stub, and prebuilt `.node` artifacts.

For compiled binaries, loader behavior is:

1. Check versioned user cache path: `<getNativesDir()>/<packageVersion>/...`.
2. Check legacy compiled-binary location:
   - Windows: `%LOCALAPPDATA%/gjc` (fallback `%USERPROFILE%/AppData/Local/gjc`)
   - non-Windows: `~/.local/bin`
3. Fall back to packaged `native/` and executable directory candidates.

`getNativesDir()` uses `$XDG_DATA_HOME/gjc/natives` when `$XDG_DATA_HOME/gjc` exists; otherwise it uses `~/.gjc/natives`.

If a populated embedded addon manifest is present, it is also treated as a compiled-binary signal. The loader can extract the matching embedded `.node` into the versioned cache directory before candidate probing.

### Failure modes

Loader failures are explicit:

- **Unsupported platform tag**: after failed probing, throws with supported platform list.
- **No loadable candidate**: throws with all attempted paths and remediation hints.
- **Embedded extraction errors**: directory/write failures are recorded and included in final load diagnostics if no candidate loads.

The current loader does not perform a separate post-`require` export validation pass.

## Rust N-API module layer

`crates/pi-natives/src/lib.rs` declares exported module ownership:

- `appearance`
- `ast`
- `clipboard`
- `fd`
- `fs_cache`
- `glob`
- `glob_util`
- `grep`
- `highlight`
- `html`
- `image`
- `keys`
- `language`
- `power`
- `prof`
- `projfs_overlay`
- `ps`
- `pty`
- `shell`
- `task`
- `text`
- `tokens`
- `utils` (crate-private helpers)

N-API exports are generated from Rust `#[napi]` functions/classes/objects/enums. Snake_case Rust names are exposed as camelCase JavaScript names unless explicitly configured by napi-rs.

## Ownership boundaries

- **Loader/package ownership (`packages/natives/native`, `packages/natives/scripts`)**
  - runtime binary selection
  - CPU variant selection and override handling
  - compiled-binary embedded extraction
  - generated TypeScript declarations and enum export patching
- **Rust ownership (`crates/pi-natives/src`)**
  - algorithmic and system-level implementation
  - platform-native behavior and performance-sensitive logic
  - N-API symbol implementation consumed directly by package callers
- **Consumer ownership (`packages/coding-agent`, `packages/tui`)**
  - user-facing policy and fallbacks that are not built into the native API
  - higher-level rendering, artifact, shell-session, and command behavior

## Runtime flow (high level)

1. Consumer imports from `@gajae-code/natives`.
2. `native/index.js` computes platform/arch/variant and candidate paths.
3. Optional embedded binary extraction occurs for compiled distributions.
4. The first `require(candidate)` that succeeds becomes the exported addon object.
5. Generated enum objects are appended to `module.exports`.
6. Caller invokes generated N-API functions/classes directly.

## Glossary

- **Native addon**: A `.node` binary loaded via Node-API (N-API).
- **Platform tag**: Runtime tuple `platform-arch` (for example `darwin-arm64`).
- **Variant**: x64 CPU-specific build flavor (`modern` AVX2, `baseline` fallback).
- **Generated binding declaration**: `native/index.d.ts` emitted by napi-rs during `build-native.ts`.
- **Compiled binary mode**: Runtime mode where the CLI is bundled and native addons are resolved from embedded/cache paths before package-local paths.
- **Embedded addon**: Build artifact metadata and file references generated into `native/embedded-addon.js` so compiled binaries can extract matching `.node` payloads.
