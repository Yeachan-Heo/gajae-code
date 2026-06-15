<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">Gajae-Code</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  A focused coding-agent runner for interviews, reviewed plans, tmux-native execution, and durable verification.
</p>

<p align="center">
  <a href="https://gajae-code.com"><img alt="Website" src="https://img.shields.io/badge/website-gajae--code.com-ff4d4f?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/gajae-code"><img alt="npm package" src="https://img.shields.io/npm/v/gajae-code?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <a href="https://discord.gg/sj4exxQ9v"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <img src="assets/character.png" alt="Gajae-Code character mascot" width="320" />
</p>

> Gajae-Code is an experimental, beta-stage project. Expect rough edges and verify outputs before relying on it for important work.

## Website

Visit **[gajae-code.com](https://gajae-code.com)** for the Gajae Code landing page, quick-start guide, architecture overview, harness notes, bridge/RPC docs, skills, receipts, remote-control design, and troubleshooting.

## What is Gajae-Code?

Gajae-Code (`gjc`) is an external coding-agent harness. It runs from the repository or worktree you choose, then gives the agent a small, explicit workflow surface:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

It is intentionally not a hidden plugin for Codex CLI, Claude Code, OpenCode, or Claw Code. Start `gjc` beside those tools when you want structured planning, persistent evidence, tmux-backed workers, or an isolated worktree.

## Install

```sh
bun install -g gajae-code
```

The scoped package is also available as `@gajae-code/coding-agent`.

### Windows (native install)

On a clean Windows 11 machine, install Bun first, then install `gjc` with Bun's
global installer:

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

`bun install -g` places the `gjc` launcher in `%USERPROFILE%\.bun\bin`. That
directory must be on `PATH` for `gjc` to resolve as a command. Bun's installer
adds it automatically, but the change only applies to terminals started after
installation — restart PowerShell (or sign out/in) if `gjc` is "not recognized".

Troubleshooting:

- **`gjc` reports an old Bun runtime.** Re-run the Bun installer above, restart
  the terminal, and confirm `bun --version` matches what `gjc --version`
  expects. If an older Bun still wins, make sure `%USERPROFILE%\.bun\bin` is
  first on `PATH` and remove any stale Bun installs shadowing it.
- **`gjc.exe` exists but `gjc` is "not recognized".** The launcher is installed
  but not on `PATH`. Confirm `%USERPROFILE%\.bun\bin` is listed in
  `echo $env:Path`, then restart the terminal.

## Quick start

```sh
# Run directly in the current checkout
gjc

# Use a tmux-backed leader session
gjc --tmux

# Use an isolated worktree for risky or reviewable work
# --worktree takes an optional branch-like name, not a filesystem path.
gjc --tmux --worktree my-task-branch

# If you already created a worktree directory, launch from that directory instead.
cd ../my-task-worktree && gjc --tmux
```

Inside a GJC session, use the public workflow surface:

```text
/skill:deep-interview clarify ambiguous requirements
/skill:ralplan build and critique the implementation plan
gjc ultragoal create-goals --brief-file <approved-plan>
gjc ultragoal complete-goals
```

Add `gjc team ...` only when coordinated tmux workers materially help.

## Core capabilities

- **Interview before guessing**: `deep-interview` turns vague requests into concrete requirements.
- **Plan before mutation**: `ralplan` reviews the approach before code changes.
- **Execute with evidence**: `ultragoal` tracks goals, revisions, checks, and completion evidence.
- **Parallelize when useful**: `team` coordinates tmux-backed workers for larger tasks.
- **Stay external and reviewable**: run from a chosen repo or worktree without patching another agent runtime.

## Workflow surface

Gajae-Code ships four default workflow skills:

| Skill            | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `deep-interview` | Clarifies ambiguous requirements before planning or code changes.     |
| `ralplan`        | Builds and critiques an implementation plan before mutation.          |
| `ultragoal`      | Tracks goals through execution, revision, verification, and evidence. |
| `team`           | Coordinates tmux-backed workers when parallel execution is worth it.  |

And four bundled role agents:

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | Bounded implementation, fixes, and refactors.      |
| `architect` | Read-only architecture and code-review assessment. |
| `planner`   | Read-only sequencing and acceptance criteria.      |
| `critic`    | Read-only plan critique and actionability review.  |

No sprawling default skill zoo: GJC improves by making this small method better.

## Works beside your existing agent or bot

| Tool or bot | Recommended GJC command | Boundary |
| ----------- | ----------------------- | -------- |
| Codex CLI | `gjc --tmux --worktree <name>` or `gjc` | `--worktree` names a GJC-managed sibling worktree; for an existing path, `cd` there first. |
| Claude Code | `gjc --tmux` or `gjc --tmux --worktree <name>` | GJC does not become a Claude Code extension. |
| OpenCode | `gjc` or `gjc --tmux` | External-runner workflow only today. |
| Claw Code | `gjc --tmux --worktree <name>` | GJC does not install into or replace Claw Code. |
| External controller / bot | `gjc mcp-serve coordinator` plus `gjc setup hermes` for compatible config, or `gjc --mode rpc` for a subprocess worker | Any MCP/RPC-capable bot drives GJC through the generic coordinator/RPC contract, not scrollback scraping. |

For generic third-party bot setup and provider-independent smokes, see [`docs/bot-integration.md`](docs/bot-integration.md). For the readiness classification across MCP, RPC, ACP, and Bridge/HTTPS surfaces, see [`docs/external-control-readiness.md`](docs/external-control-readiness.md). For lower-level protocol details, see [`docs/hermes-mcp-bridge.md`](docs/hermes-mcp-bridge.md), [`docs/rpc.md`](docs/rpc.md), and [`docs/bridge.md`](docs/bridge.md). For the remote operator surfaces roadmap, see [`docs/gajae-remote.md`](docs/gajae-remote.md) (web steering wheel) and [`docs/telegram-remote.md`](docs/telegram-remote.md) (Telegram lifecycle button).

## Configuration

Provider retry budgets live in `~/.gjc/config.yml`:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` applies before a stream is established. `streamMaxRetries` applies only to replay-safe transient stream failures. Invalid auth, unsupported models/providers, malformed requests, context overflow, user aborts, and permanent quota failures remain fail-fast.

## TUI identity

The default dark TUI identity is the GJC red-claw theme, while light-appearance terminals default to the bundled blue-crab theme. Three additional bundled migration themes — `claude-code`, `codex`, and `opencode` — mirror the look of those tools for easy eye-migration and are selectable from Settings or `/theme`. Explicit user theme settings still win.

## Development

Install dependencies, build native bindings, and set up local defaults:

```sh
bun install
bun run build:native
bun run install:defaults
```

The `.node` binary for `@gajae-code/natives` is gitignored and required before any CLI invocation (`install:defaults`, `dev:link`, tests).

### Canonical: build and link the dev `gjc`

To make the global `gjc` command run **this checkout's TypeScript source** (hot to every edit, with skills/natives working), link it onto your `PATH`:

```sh
bun install
bun run dev:link
```

`dev:link` symlinks `gjc` → `packages/coding-agent/src/cli.ts` into `~/.local/bin` (override with `GJC_DEV_LINK_DIR`), replaces that managed target, warns and fails if another `gjc` still shadows it earlier on `PATH`, and runs `--smoke-test` to confirm `@gajae-code/natives` loads. Use `bun run install:dev` for the full bootstrap (install + link + `setup defaults`).

Check at any time whether your `gjc` has drifted (wrong source, or a compiled binary that can't load skills):

```sh
bun run dev:doctor
```

> Do **not** use the compiled binary for day-to-day development. `bun --cwd=packages/coding-agent run build` produces a standalone `dist/gjc`, but a `bun build --compile` binary cannot dynamically load `@gajae-code/natives`, so skills fail with `Cannot find module '@gajae-code/natives' from '/$bunfs/root/gjc'`. Running from source via `dev:link` avoids this. Build the binary only when validating a release.

Run the CLI from source directly without linking:

```sh
bun packages/coding-agent/src/cli.ts --help
```

Default workflow definitions live in source, not committed `.gjc` copies:

```text
packages/coding-agent/src/defaults/gjc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

For workflow-definition or rebrand-surface changes, run the project gates:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-gjc-definitions.test.ts
```

For a package-by-package map, see [`docs/codebase-overview.md`](docs/codebase-overview.md).

## Contributors

Thanks to the people and agents helping shape the early Gajae-Code releases, including [Yeachan-Heo](https://github.com/Yeachan-Heo), [IYENTeam](https://github.com/IYENTeam), and [HaD0Yun](https://github.com/HaD0Yun). Contributions, bug reports, and release validation are welcome through GitHub and the Discord community.

## Inspirations and lineage

Gajae-Code's default TUI identity is the crustacean pair: red-claw for dark appearance and blue-crab for light appearance. It also bundles `claude-code`, `codex`, and `opencode` migration themes whose palettes are inspired by those tools so users moving from them get a familiar look. It builds on lessons from a small family of agent harnesses while keeping the public GJC surface intentionally focused. Historical attribution is kept in [`NOTICE.md`](NOTICE.md).

## License

MIT. See [`LICENSE`](LICENSE).

## GEO visibility benchmark

Gajae-Code includes a [`geobench`](https://github.com/NomaDamas/geobench) product spec for measuring LLM hit rate, MRR, share of voice, and citations.

- Spec: [`geobench/gajae-code.yaml`](geobench/gajae-code.yaml)
- Runbook: [`docs/geobench.md`](docs/geobench.md)
