# Install, update channels, and platform setup

## Standard install

Prebuilt standalone binaries are the supported end-user install. Bun is not required.

```sh
# Tagged installer (recommended): pin the ref, then run locally.
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh
sh gjc-install.sh
gjc --version
gjc --smoke-test
```

Piping the `main` branch script executes mutable content:

```sh
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh
```

Windows (PowerShell), tagged:

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.ps1 -OutFile gjc-install.ps1
powershell -File gjc-install.ps1
```

The installer downloads the current platform's GitHub release asset, verifies HTTP success, non-empty bytes, and published SHA-256 checksums, then runs `--version` and `--smoke-test`. A failed download or verification never replaces a working existing `gjc`. Version discovery uses GitHub only (`https://api.github.com` and `https://github.com/<repo>/releases/download`); firewalled or mirrored registries are not used. Offline/source workflows use `--source` with an existing Bun.

Unix default location: `~/.local/bin/gjc` (`GJC_INSTALL_DIR` overrides).
Windows default location: `%LOCALAPPDATA%\gjc\gjc.exe`.

### PDF extraction in standalone builds

Standalone builds embed MuPDF's WebAssembly asset; PDF text extraction does not depend on a global npm/Bun package or the current working directory. A one-page document with short text is valid output. If extraction fails or produces no text, reader mode reports a failed inspection with conversion diagnostics rather than displaying PDF bytes as successfully inspected text. `:raw` remains an explicit request for the original response.

The official 0.16.6 standalone can report a misleading “install mupdf” error because MuPDF was excluded from compilation. Installing a global dependency is not a supported repair for that executable. Use a corrected standalone release containing the packaging fix; this source change does not repair an already installed 0.16.6 binary. Diagnostics identify the module/WASM mapping and retain available initialization causes; include them with the binary version in a bug report.

MuPDF is separately licensed under AGPL-3.0-or-later, not the repository's MIT license. See [third-party notices](../NOTICE.md); distributing a combined standalone requires the applicable license notices and corresponding-source obligations to be satisfied.

## Korean launcher alias

`가재씨` is installed alongside `gjc` as a launcher alias on package-manager installs. Standalone binaries expose `gjc`. On Windows, use `gjc` (or run from Windows Terminal / PowerShell with UTF-8 `chcp 65001` if a Hangul alias is needed).

## Supported platforms

Prebuilt standalone release binaries are published for:

- **Linux** — x64 and arm64, **glibc only** (musl/Alpine is not supported; use `--source` with existing Bun)
- **Windows** — x64
- **macOS** — Apple Silicon (arm64) and Intel (x64)

## Nightly channel

A verified nightly prerelease is published from `main` at 04:23 UTC and can also be started manually with the **nightly-release** CI dispatch. Nightly runs execute the complete main verification graph, build every supported native addon and standalone binary, and create a matching GitHub prerelease. They do not rewrite `main` or consume the `[Unreleased]` changelog sections.

```sh
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh -s -- --channel nightly
gjc --version
gjc --smoke-test
```

Windows: pass `-Channel nightly` to `install.ps1`.

Already on GJC? Switch channels without reinstalling: `gjc update --channel nightly` moves to the latest nightly, and `gjc update --channel stable` switches a nightly install back to the latest stable (the command detects the channel switch and installs even though stable is semver-lower than the nightly). To make a channel the default for both `gjc update` and the startup update check, set **Settings → Interaction → Update Channel** (the `startup.updateChannel` setting). In the brief window where a nightly shares the stable core version, add `--force` to move onto it.

Pin an exact release tag (binary assets required):

```sh
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh -s -- --ref v0.15.0
```

## Development / source install

Bun is required only to build GJC from source. The installer never downloads Bun.

```sh
# Requires an existing Bun 1.3.14+ on PATH
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh -s -- --source
```

From a checkout: `bun run install:dev`, then `bun run dev` / `bun run dev:link`. The setup command installs dependencies, rebuilds the native addon, links the source CLI, and installs bundled defaults. See the repository `AGENTS.md` for the development workflow.

## Windows notes

GJC's shell tool requires a bash-compatible shell on Windows. After a binary install, the PowerShell installer records Git Bash if it finds it. Options:

1. Install Git for Windows: https://git-scm.com/download/win
2. Use WSL, Cygwin, or MSYS2

Native Windows `gjc --tmux` needs a tmux-compatible executable on `PATH`. For GJC-managed session guarantees, use WSL with real tmux. See [`environment-variables.md`](./environment-variables.md#interactive---tmux-startup-and-scrollmouse-profile).

## Shell completion

GJC can generate a Fig/withfig-compatible spec for [Microsoft inshellisense](https://github.com/microsoft/inshellisense):

```sh
gjc completion inshellisense --install
```

The installer writes `gjc.js` plus a minimal `index.js` into inshellisense's default local spec directory (`~/.fig/autocomplete/build`). If that directory already has an unrelated `index.js`, GJC refuses to clobber it unless `--force` is explicit; use `--dir <path>` for a separate GJC-only spec directory.

## Launch-time updates

Interactive startup checks GitHub releases for a newer GJC version in the background by default. This check is notify-only and non-mutating: GJC never installs or replaces itself during launch.

- Standalone binary or former Bun/npm install on a supported platform → `gjc update` installs the matching GitHub release binary. Existing standalone binaries are atomically replaced. Package-manager installs migrate to a separate user binary path, even at the same version; shims are neither overwritten nor uninstalled. A target that already passes release-checksum, version, and smoke-test verification is reused without downloading the binary again (unless `--force` is set).
- Source checkout or `dev:link` executable → update, pull, build, and link through that checkout's original workflow. `gjc update` refuses to self-overwrite it.
- Unsupported platform or unknown target → rerun the documented platform installer.

Run `gjc config set startup.checkUpdate false` to disable the launch-time check. Network failures are ignored so they do not block startup.

`gjc update` resolves `stable` from GitHub `/releases/latest` and `nightly` from the newest published GitHub prerelease. Optional `GITHUB_TOKEN` / `GH_TOKEN` raises API rate limits. `--check`, `--force`, and channel switch-back semantics are unchanged.

### After a package-manager migration

“Installed and verified” confirms the standalone binary, not which executable your current shell will run. A same-version migration changes the installation type, not the version. Use the explicit verified binary path printed by the updater to launch it directly; for the default POSIX location:

```sh
"$HOME/.local/bin/gjc" --version
"$HOME/.local/bin/gjc"
```

Check command resolution in the same shell where you ran the update:

```sh
type -a gjc
command -v gjc
hash -r                  # Bash: clear cached command locations
# rehash                 # zsh equivalent
command -v gjc
gjc --version
```

A stale Bash command hash can retain the Bun shim even when `type -a gjc` lists the standalone binary first. Clearing that hash can activate the standalone binary without any PATH edit. Only if resolution still selects another install should you check aliases/functions and ensure the standalone directory precedes the shim directory on PATH. On PowerShell, inspect `Get-Command gjc -All` and `where.exe gjc`, and invoke the printed binary path with `& 'path/to/gjc.exe'`. No shim removal is required.

## Retry configuration

Provider retry budgets live in `~/.gjc/config.yml`:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` applies before a stream is established. `streamMaxRetries` applies only to replay-safe transient stream failures. Invalid auth, unsupported models/providers, malformed requests, context overflow, user aborts, and permanent quota failures remain fail-fast.
