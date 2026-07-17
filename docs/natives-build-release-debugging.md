# Natives Build, Release, and Debugging Runbook

This runbook describes how `@gajae-code/natives` produces `.node` addons, generated declarations, and compiled-binary embedded payloads, and how to debug loader/build failures.

It follows the architecture terms from `docs/natives-architecture.md`:

- **build-time artifact production** (`scripts/build-native.ts`)
- **embedded addon manifest generation** (`scripts/embed-native.ts`)
- **runtime addon loading** (`native/index.js`, `native/loader-state.js`)

## Implementation files

- `packages/natives/scripts/build-native.ts`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/scripts/gen-enums.ts`
- `packages/natives/package.json`
- `packages/natives/native/index.js`
- `packages/natives/native/loader-state.js`
- `crates/pi-natives/Cargo.toml`

## Build pipeline overview

### 1) Build entrypoints

`packages/natives/package.json` scripts:

- `bun scripts/build-native.ts` (`build`) → N-API build, addon install, generated declarations install, enum export patch.
- `bun scripts/embed-native.ts` (`embed:native`) → generate `native/embedded-addon.js` from built files.

Root scripts include `build:native` as `bun --cwd=packages/natives run build`.

### 2) N-API/Rust artifact build

`build-native.ts` invokes the `@napi-rs/cli` binary directly from `node_modules/.bin` with:

- `napi build`
- `--manifest-path crates/pi-natives/Cargo.toml`
- `--package-json-path packages/natives/package.json`
- `--platform`
- `--no-js`
- `--dts index.d.ts`
- `--profile local` for non-CI local native builds, otherwise `--profile ci`
- optional `--target <CROSS_TARGET>`

`crates/pi-natives/Cargo.toml` declares `crate-type = ["cdylib"]`; napi-rs emits `.node` artifacts plus generated `index.d.ts` in an isolated temporary output directory under `packages/natives/native/.build/`.

### 3) Artifact install

After napi-rs succeeds, `build-native.ts`:

1. resolves the built addon in the isolated output directory;
2. normalizes its name to `pi_natives.<platform>-<arch>(-variant).node` when needed;
3. installs the addon into `packages/natives/native/` with temp-file + rename semantics;
4. copies generated `index.js` and `index.d.ts` into `packages/natives/native/` when present;
5. runs `generateEnumExports()` to append enum runtime objects to `native/index.js`.

Windows locked-DLL replacement failures are reported with an explicit close-running-processes hint.

## Target/variant model and naming conventions

## Platform tag

Both build and runtime use platform tag:

`<platform>-<arch>` (example: `darwin-arm64`, `linux-x64`).

## Variant model (x64 only)

x64 supports CPU variants:

- `modern` (AVX2-capable path)
- `baseline` (fallback)

Non-x64 uses a single default artifact with no variant suffix.

### Output filenames

- x64: `pi_natives.<platform>-<arch>-modern.node` or `...-baseline.node`
- non-x64: `pi_natives.<platform>-<arch>.node`

Runtime x64 candidate order also includes the unsuffixed default filename after the selected variant candidates.

## Environment flags and build options

## Runtime flags

- `GJC_NATIVE_VARIANT`: x64 runtime override; valid values are `modern` and `baseline`.
- `GJC_COMPILED`: legacy compiled-mode signal. A populated embedded-addon manifest is also a compiled-mode signal and is the authoritative signal for Bun standalone builds that do not preserve `process.env.GJC_COMPILED`.

## Build-time flags/options

- `CROSS_TARGET`: passed to napi-rs as `--target <CROSS_TARGET>`.
- `TARGET_PLATFORM`: override output platform tag naming.
- `TARGET_ARCH`: override output arch naming.
- `TARGET_VARIANT` (x64 only): force `modern` or `baseline` for output filename and RUSTFLAGS policy.
- `CARGO_TARGET_DIR`: respected if set; otherwise the default `target/` dir is used so `Swatinem/rust-cache` can cache cleanly.
- `RUSTFLAGS`:
  - if unset and not cross-compiling, script sets:
    - modern: `-C target-cpu=x86-64-v3`
    - baseline: `-C target-cpu=x86-64-v2`
    - non-x64 / no variant: `-C target-cpu=native`
  - if already set, script does not override.

## Build state/lifecycle transitions

### Build lifecycle (`build-native.ts`)

1. **Init**: parse env, resolve target tuple, cross/local mode, profile label.
2. **Variant resolve**:
   - non-x64 → no variant;
   - x64 + `TARGET_VARIANT` → explicit variant;
   - x64 cross-build without `TARGET_VARIANT` → hard error;
   - x64 local build without override → detect host AVX2.
3. **CPU policy**: set `RUSTFLAGS` for the resolved variant unless the caller already provided one.
4. **Compile**: run napi-rs against `crates/pi-natives` into an isolated output directory.
5. **Locate artifact**: accept the canonical filename or a single napi-rs-generated `pi_natives.<platform>-<arch>*.node` candidate.
6. **Install**: copy/rename addon into `packages/natives/native`.
7. **Install generated bindings**: copy `index.js`/`index.d.ts` if needed.
8. **Patch enums**: append generated enum runtime exports.
9. **Cleanup**: remove the temporary build output directory.

Failure exits have explicit error text for invalid variants, failed napi build, missing/multiple output artifacts, generated binding install failure, and install/rename failure.

### Embed lifecycle (`embed-native.ts`)

1. **Init**: compute platform tag from `TARGET_PLATFORM`/`TARGET_ARCH` or host values.
2. **Candidate set**:
   - x64 looks for `modern` and `baseline` files;
   - non-x64 looks for one default file.
3. **Validate availability**: at least one expected file must exist in `packages/natives/native`.
4. **Generate manifest** (`native/embedded-addon.js`) with Bun `file` imports and package version.
5. **Runtime extraction ready** for compiled mode.

`--reset` writes the null manifest stub (`embeddedAddon = null`) without validating addon availability.

## Dev workflow vs shipped/compiled behavior

## Local development workflow

Typical local loop:

1. Build addon: `bun --cwd=packages/natives run build`.
2. Loader resolves package-local `native/` candidates, then executable-dir fallback candidates.
3. Generated declarations in `native/index.d.ts` describe the public TS API.

## Shipped/compiled binary workflow

In compiled mode (`GJC_COMPILED`, Bun embedded URL markers, or populated embedded manifest):

1. Loader computes versioned cache dir: `<getNativesDir()>/<packageVersion>`.
2. If embedded manifest matches current platform+version, loader may extract the selected embedded file into that versioned dir.
3. Runtime candidate order includes:
   - versioned cache dir,
   - legacy compiled-binary dir (`%LOCALAPPDATA%/gjc` on Windows, `~/.local/bin` elsewhere),
   - package/executable directories.
4. First successfully loaded addon is returned.

This is why packaging + runtime loader expectations must align: filenames, platform tags, CPU variants, and embedded manifest version must match what `native/index.js` probes.

## JS API ↔ Rust export mapping (build sanity subset)

Generated declarations currently include exports from these Rust modules:

| Area                   | Representative JS exports                                                                         | Rust source                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Search                 | `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `invalidateFsScanCache`                        | `grep.rs`, `fd.rs`, `glob.rs`, `fs_cache.rs`                                            |
| AST                    | `astGrep`, `astEdit`                                                                              | `ast.rs`                                                                                |
| Text/highlight/tokens  | `visibleWidth`, `truncateToWidth`, `highlightCode`, `countTokens`                                 | `text.rs`, `highlight.rs`, `tokens.rs`                                                  |
| Shell/PTY/process/keys | `executeShell`, `Shell`, `PtySession`, `killTree`, `parseKey`                                     | `shell.rs`, `pty.rs`, `ps.rs`, `keys.rs`                                                |
| Media/system           | `PhotonImage`, `encodeSixel`, clipboard, macOS appearance/power, `getWorkProfile`, ProjFS helpers | `image.rs`, `clipboard.rs`, `appearance.rs`, `power.rs`, `prof.rs`, `projfs_overlay.rs` |

## Failure behavior and diagnostics

## Build-time failures

- Invalid variant configuration:
  - `TARGET_VARIANT` set on non-x64 → immediate error.
  - unsupported `TARGET_VARIANT` value → immediate error.
  - x64 cross-build without explicit `TARGET_VARIANT` → immediate error.
- napi-rs build failure: script surfaces non-zero exit and stderr.
- Artifact not found or ambiguous: script prints expected/candidate filenames and output directory contents.
- Install failure: explicit message; Windows includes locked-file hint.
- Generated binding install failure: explicit source/destination message.

## Runtime loader failures (`native/index.js`)

- Unsupported platform tag: throws with supported platform list after probing fails.
- No candidate could load: throws with full candidate error list and mode-specific remediation hints.
- Embedded extraction problems: extraction mkdir/write errors are recorded and included in final diagnostics if load fails.

## Troubleshooting matrix

| Symptom                                                                | Likely cause                                                                                | Verify                                                            | Fix                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Cannot find module` or dynamic library load error for every candidate | Missing release artifact, wrong platform tag, or stale compiled cache                       | Inspect loader error list and `packages/natives/native` filenames | Build correct target/variant; delete stale cache for the package version                      |
| Export is missing at runtime but present in TypeScript                 | Stale `.node` loaded, generated declarations newer than binary, or Rust export not compiled | Require the actual candidate and inspect `Object.keys(mod)`       | Rebuild native package and remove stale candidate/cache paths                                 |
| x64 machine loads baseline when modern expected                        | `GJC_NATIVE_VARIANT=baseline`, no AVX2 detected, or modern file unavailable                  | Check env and filenames in `native/`                              | Build modern variant (`TARGET_VARIANT=modern ... build`) and ship it                          |
| Cross-build produces wrong-labeled binary                              | Mismatch between `CROSS_TARGET` and `TARGET_PLATFORM`/`TARGET_ARCH`, or missing x64 variant | Confirm env tuple and output filename                             | Re-run with consistent env values and explicit x64 `TARGET_VARIANT`                           |
| Compiled binary fails after upgrade                                    | Stale extracted cache or embedded manifest version mismatch                                 | Inspect `<getNativesDir()>/<version>` and loader error list       | Delete versioned cache for the package version; regenerate embedded manifest during packaging |
| `embed:native` fails with `No native addons found`                     | Required platform artifact was not built before embedding                                   | Check expected list in error text                                 | Build at least one expected artifact for the target, then rerun `embed:native`                |

## Operational commands

```bash
# Release artifact for current host
bun --cwd=packages/natives run build

# Build explicit x64 variants
TARGET_VARIANT=modern bun --cwd=packages/natives run build
TARGET_VARIANT=baseline bun --cwd=packages/natives run build

# Generate embedded addon manifest from built native files
bun --cwd=packages/natives run embed:native

# Reset embedded manifest to null stub
bun --cwd=packages/natives run embed:native -- --reset
```
