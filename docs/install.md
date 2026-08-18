# Install, update channels, and platform setup

## Standard install

```sh
bun install -g gajae-code
gjc --version
gjc --smoke-test
```

The scoped package is also available as `@gajae-code/coding-agent`.

## Korean launcher alias

`가재씨` is installed alongside `gjc` as a launcher alias, so typing `가재씨` runs Gajae-Code exactly like `gjc`:

```sh
가재씨 --version
```

The alias is a package-owned bin entry created by npm/Bun during install — no shell alias or dotfile edit is required. It is supported on Linux and macOS (UTF-8 locales). On Windows the shim is created by the package manager, but invoking `가재씨` from `cmd.exe` depends on the console's active code page; use `gjc` or run from Windows Terminal / PowerShell with a UTF-8 code page (`chcp 65001`) if the Hangul alias is needed.

## Supported platforms

Prebuilt standalone release binaries are published for:

- **Linux** — x64 and arm64
- **Windows** — x64
- **macOS** — Apple Silicon (arm64) and Intel (x64)

The npm/Bun package path and build-from-source remain available on every platform:

```sh
bun install -g gajae-code
# or
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh -s -- --source
```

## Nightly channel

A verified nightly prerelease is published from `main` at 04:23 UTC and can also be started manually with the **nightly-release** CI dispatch. Nightly runs execute the complete main verification graph, build every supported native addon and standalone binary, publish the exact package set under the npm `nightly` dist-tag, and create a matching GitHub prerelease with package evidence. They do not move npm `latest`, rewrite `main`, or consume the `[Unreleased]` changelog sections.

```sh
bun install -g gajae-code@nightly
gjc --version
gjc --smoke-test
```

Already on GJC? Switch channels without reinstalling: `gjc update --channel nightly` moves to the latest nightly, and `gjc update --channel stable` switches a nightly install back to the latest stable (the command detects the channel switch and installs even though stable is semver-lower than the nightly). To make a channel the default for both `gjc update` and the startup update check, set **Settings → Interaction → Update Channel** (the `startup.updateChannel` setting). In the brief window where a nightly shares the stable core version, add `--force` to move onto it.

## Windows (native install)

On a clean Windows 11 machine, install Bun first, then install `gjc` with Bun's global installer:

```powershell
# 1. Install Bun
powershell -c "irm bun.sh/install.ps1|iex"

# 2. Restart the terminal so PATH and the Bun runtime refresh, then confirm Bun
bun --version

# 3. Install and verify gjc
bun install -g gajae-code
gjc --version
gjc --smoke-test
```

`bun install -g` places the `gjc` launcher in `%USERPROFILE%\.bun\bin`. That directory must be on `PATH` for `gjc` to resolve as a command. Bun's installer adds it automatically, but the change only applies to terminals started after installation — restart PowerShell (or sign out/in) if `gjc` is "not recognized".

Troubleshooting:

- **`gjc` reports an old Bun runtime.** Re-run the Bun installer above, restart the terminal, and confirm `bun --version` matches what `gjc --version` expects. If an older Bun still wins, make sure `%USERPROFILE%\.bun\bin` is first on `PATH` and remove any stale Bun installs shadowing it.
- **`gjc.exe` exists but `gjc` is "not recognized".** The launcher is installed but not on `PATH`. Confirm `%USERPROFILE%\.bun\bin` is listed in `echo $env:Path`, then restart the terminal.
- **`gjc --tmux` starts without a tmux-backed session.** Native Windows needs a tmux-compatible executable on `PATH`. For GJC-managed session guarantees, use WSL with real tmux, or another provider that round-trips tmux user options such as `@gjc-profile`. Native psmux can provide `tmux`/`pmux`/`psmux` commands, but that path is not fully supported for GJC ownership tags and session guarantees yet; see [`environment-variables.md`](./environment-variables.md#interactive---tmux-startup-and-scrollmouse-profile).

## Shell completion

GJC can generate a Fig/withfig-compatible spec for [Microsoft inshellisense](https://github.com/microsoft/inshellisense):

```sh
gjc completion inshellisense --install
```

The installer writes `gjc.js` plus a minimal `index.js` into inshellisense's default local spec directory (`~/.fig/autocomplete/build`). If that directory already has an unrelated `index.js`, GJC refuses to clobber it unless `--force` is explicit; use `--dir <path>` for a separate GJC-only spec directory.

## Launch-time updates

Interactive startup checks the npm registry for a newer GJC version in the background by default. This check is notify-only and non-mutating: GJC never installs or replaces itself during launch.

- Recognized Bun global install → `gjc update` or `bun install -g @gajae-code/coding-agent@latest`.
- Recognized Windows npm install → `gjc update` or the original npm package workflow.
- Supported standalone binary installed by the bundled installer → `gjc update` or rerun the documented platform installer.
- Source checkout or `dev:link` executable → update, pull, build, and link through that checkout's original workflow.
- Unrecognized npm/pnpm/other package-manager installs or unknown PATH targets → use the original package manager or install method.

Run `gjc config set startup.checkUpdate false` to disable the launch-time check. Registry or network failures are ignored so they do not block startup.

Both the launch-time check and `gjc update` resolve the registry the way npm does — `BUN_CONFIG_REGISTRY` or `npm_config_registry` from the environment, a scoped `@gajae-code:registry` key, then your user and machine-wide `.npmrc`, including the credentials registered for that registry. A mirrored or firewalled network is therefore checked at the same place the update would install from. A `.npmrc` in the current working directory is deliberately ignored, so a repository you have cloned cannot redirect the check or choose the credential it carries. `bunfig.toml` is not read, so a mirror declared only there is still checked against the public registry.

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
