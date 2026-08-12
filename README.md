<p align="right">
  <strong>English</strong> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">G A J A E - C O D E</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong>
  <br/>
  <sub>The coding agent that runs on the <strong>plan you already pay for</strong> — and answers to your phone.</sub>
</p>

<p align="center">
  <a href="https://gajae-code.com"><img alt="Website" src="https://img.shields.io/badge/website-gajae--code.com-ff4d4f?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/gajae-code"><img alt="npm package" src="https://img.shields.io/npm/v/gajae-code?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <a href="https://discord.gg/8vPXmxSt9"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#why-gajae-code">Why</a> ·
  <a href="#bring-your-coding-plan">Coding Plans</a> ·
  <a href="#answer-from-your-phone">Phone</a> ·
  <a href="#plan-before-mutation">Workflow</a> ·
  <a href="#spend-fewer-tokens">Token Diet</a> ·
  <a href="#let-openclaw--hermes-drive-gjc">Controllers</a> ·
  <a href="#documentation">Docs</a>
</p>

**Log in with the subscription you already have, plan before a single file mutates, execute with evidence — and answer the agent's questions from your terminal, your phone, or your own bot.**

Gajae-Code (`gjc`) is an external coding-agent harness: drop it into any repository or worktree. No separate API billing. No per-token anxiety. No terminal babysitting.

> Gajae-Code is an experimental, beta-stage project. Expect rough edges and verify outputs before relying on it for important work.

---

## Why Gajae-Code?

Most coding agents fail on three fronts: they bill you twice, they mutate before they understand, and they go silent the moment you step away from the keyboard.

| Problem | What Happens | Gajae-Code Fix |
| :--- | :--- | :--- |
| Separate API billing | You pay for a plan *and* per-token API costs | `/login` with the coding plan you already pay for — Claude, Codex, Cursor, Copilot, OpenCode Go, GOAT, ClinePass, and more |
| Code-first agents | The agent edits before it understands; you rework | Plan-gated workflow: interview → plan → critique → *then* mutate, with approval gates |
| Terminal-bound sessions | Agent asks a question at 2 AM; work stalls until morning | Questions route to Telegram/Discord/Slack; you answer from anywhere |
| Context bloat | Whole-file reads and log floods burn the window | Structural summaries, artifact spill, cache-aware routing, compaction |

---

## Quick Start

**Install** — prebuilt binaries for Linux (x64/arm64), macOS (arm64/x64), and Windows (x64); the npm/Bun path works everywhere:

```sh
bun install -g gajae-code
gjc
```

**First use** — pick your plan and go:

```text
/login                       pick a provider / coding plan
/skill:deep-interview        clarify ambiguous requirements
/skill:ralplan               build and critique the plan
gjc ultragoal create-goals --brief-file <approved-plan>
```

**Run modes:**

```sh
gjc                                # run in the current checkout
gjc --tmux                         # tmux-backed leader session
gjc --tmux --worktree my-task      # isolated worktree for risky work
gjc @screenshot.png "What should I change?"   # image input
```

Nightly channel: `bun install -g gajae-code@nightly`. Full install matrix, Windows setup, update channels, and shell completion: [docs/install.md](docs/install.md).

---

## Bring your coding plan

<p align="center">
  <img src="assets/coding-plans-banner.png" alt="Coding plans and providers GJC runs on: Claude, ChatGPT/Codex, Cursor, GitHub Copilot, OpenCode Go, Kimi, GLM/Z.AI, MiniMax, Grok, Qwen, Command Code GOAT, ClinePass" width="100%" />
</p>

Log in once and run GJC on the subscription you already pay for. Run `/login` inside a session and pick your plan:

| Plan / subscription | OAuth login |
| :--- | :--- |
| Claude Pro / Max | `anthropic` |
| ChatGPT Plus / Pro (Codex) | `openai-codex` (browser) · `openai-codex-device` (headless) |
| Cursor | `cursor` |
| GitHub Copilot | `github-copilot` |
| OpenCode Zen / OpenCode Go | `opencode-zen` · `opencode-go` |
| Kimi Code / Coding Plan / Moonshot | `kimi-code` · `moonshot` |
| Z.AI GLM Coding Plan | `zai` |
| MiniMax Coding Plan (Intl / CN) | `minimax-code` · `minimax-code-cn` |
| xAI (Grok) | `xai` |
| Alibaba Token Plan / Qwen Portal | `alibaba-token-plan` · `qwen-portal` |

More OAuth plans — Google Gemini CLI, GitLab Duo, Perplexity Pro/Max, Fire Pass, Xiaomi Token Plan — are covered in [docs/models.md](docs/models.md).

### New: coding-plan presets

Key-based coding plans onboard with one command — the preset writes the API type, base URL, env var, compatibility flags, and a **live model catalog** together, so new models show up without a GJC update:

```sh
gjc setup provider --preset commandcode-goat   # Command Code GOAT plan (CMD_API_KEY)
gjc setup provider --preset cline-pass         # ClinePass (CLINE_API_KEY)
```

- **Command Code GOAT** — pulls the provider's live `/models` catalog; `claude-*` models route through native Anthropic Messages, everything else through Chat Completions. Aliases: `commandcode`, `goat`.
- **ClinePass** — no hardcoded models; GJC fetches Cline's live catalog the same way Cline generates its own. Aliases: `clinepass`, `cline`.
- Also available as presets: `minimax`, `minimax-cn`, `glm`, `alibaba-token-plan` — or `/provider add --preset <name>` inside the TUI.

<details>
<summary><strong>Beyond coding plans: 50+ providers, gateways, local runtimes</strong></summary>

API-key providers, local runtimes (Ollama, LM Studio, vLLM), and gateways (Cloudflare AI Gateway, Vercel AI Gateway, LiteLLM, and more) all work. Register your own endpoints in `models.yml`, pool multiple accounts per provider with usage-aware routing, mix vendors per agent role with model presets and profiles, or centralize team credentials with the auth broker/gateway.

- [Models, providers, and auth resolution](docs/models.md)
- [Custom providers & multi-account routing](docs/custom-providers-and-multi-account.md)
- [Multi-vendor role profiles](docs/multi-vendor-profiles.md)
- [Auth broker & gateway (shared team credentials)](docs/auth-broker-gateway.md)

</details>

---

## Answer from your phone

<p align="center">
  <img src="assets/telegram-mobile-hero.png" alt="Gajae Code mobile answers for coding agents hero illustration" width="100%" />
</p>

When the agent needs a decision, it pings you on Telegram — and you answer from anywhere:

- **Coordinator/lifecycle session forum topics** with live/finalized output, context updates, image attachments, inline buttons, free-text replies, and typing indicators.
- **Configure once** from `/settings` → Notifications in a running session, or headless via `gjc notify setup|status|health|test|recovery`. Tokens are masked on entry and never displayed again.
- **`gjc daemon`** keeps one safe long-poll owner per bot token, so new sessions attach cleanly without Telegram 409 conflicts.
- Discord and Slack delivery ship alongside; the generic `action_needed`/`reply` protocol lets any bot or mobile app route answers back without terminal scraping.

[Telegram onboarding](docs/telegram-onboarding.md) · [Discord](docs/discord-onboarding.md) · [Slack](docs/slack-onboarding.md)

---

## Plan before mutation

A deliberately small workflow surface — four skills, four role agents, nothing else:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

| Surface | What it does |
| :--- | :--- |
| `deep-interview` | Turns vague requests into concrete requirements. |
| `ralplan` | Builds and critiques the implementation plan before code changes. |
| `ultragoal` | Tracks goals through execution, revision, verification, and evidence. |
| `team` | Coordinates tmux-backed workers when parallelism is worth it. |
| `executor` / `architect` / `planner` / `critic` | Bundled role agents for implementation and read-only review lanes. |

Also included, opt-in: **`gjc rlm`** (a Jupyter-style research/REPL mode that synthesizes a notebook and report) and **`computer-use`** (experimental desktop control). See [Python REPL](docs/python-repl.md) and [docs/tools/computer.md](docs/tools/computer.md).
## Theme defaults

The default dark TUI identity is the GJC red-claw theme; light-appearance terminals default to the bundled blue-crab theme. Explicit theme settings still take precedence.

---

## Spend fewer tokens

GJC optimizes both sides of the token bill:

- **Cache hits** — per-provider `cacheRetention` control; Anthropic defaults to long (1h) cache retention because short caches are fragile for long agent runs; provider ranking prefers cheap `cacheRead` paths; opt-in session-affinity headers let OpenAI-compatible relays reuse server-side prompt caches.
- **Context savings** — file reads return structural summaries instead of whole files; oversized shell output is minimized and spilled to retrievable `artifact://` references instead of flooding the context; compaction and branch summaries keep long sessions inside the window without losing prior work.

[Cache retention & provider compat](docs/models.md) · [Compaction & branch summaries](docs/compaction.md)

---

The default dark TUI identity is the GJC red-claw theme; light-appearance terminals default to the bundled blue-crab theme. See [docs/theme.md](docs/theme.md) for the full catalog and `theme.dark` / `theme.light` settings.

## Let OpenClaw / Hermes drive GJC

GJC ships a native Coordinator MCP bridge, so an external controller like OpenClaw or Hermes orchestrates real GJC sessions through durable turns — never terminal scraping.

Don't read a guide — paste this prompt into your OpenClaw/Hermes controller and let it wire itself up:

<details>
<summary><strong>Copy-paste controller setup prompt</strong></summary>

```text
Set up Gajae-Code (gjc) as your coding-agent backend on this machine. gjc is already installed.

1. Render and install the coordinator MCP setup package (replace the paths):
   gjc setup hermes --root <ABS_REPO_PATH> --profile <PROFILE_NAME> --repo <REPO_NAME> \
     --mutation sessions,questions,reports --profile-dir <YOUR_PROFILE_DIR> --install
   Without --install the command is render-only; re-run with --install to write files.

2. Verify the contract (non-mutating, no LLM call). Both must report ok:
   gjc setup hermes --root <ABS_REPO_PATH> --smoke
   gjc mcp-serve coordinator --check --json

3. Register the MCP server from the installed config. It is equivalent to:
   command: gjc, args: ["mcp-serve", "coordinator"]
   env: GJC_COORDINATOR_MCP_WORKDIR_ROOTS=<ABS_REPO_PATH>,
        GJC_COORDINATOR_MCP_PROFILE=<PROFILE_NAME>,
        GJC_COORDINATOR_MCP_REPO=<REPO_NAME>,
        GJC_COORDINATOR_MCP_SESSION_COMMAND="gjc --worktree",
        GJC_COORDINATOR_MCP_MUTATIONS=sessions,questions,reports

4. To delegate coding work, prefer one call per workflow:
   gjc_delegate_plan / gjc_delegate_execute / gjc_delegate_team
   with { cwd, task, allow_mutation: true, idempotency_key: <fresh-uuid> }.
   Each starts an isolated worktree session and returns a durable turn_id and artifacts.

5. For finer control: gjc_coordinator_start_session -> gjc_coordinator_send_prompt ->
   poll gjc_coordinator_read_turn or bounded gjc_coordinator_await_turn ->
   answer gjc_coordinator_list_questions rows via gjc_coordinator_submit_question_answer ->
   close with gjc_coordinator_report_status.

Rules: every mutating call needs allow_mutation: true plus a fresh idempotency_key.
Treat durable turn state as authoritative; never scrape terminal output.
The session command selector accepts only "gjc" or "gjc --worktree [name]".
```

</details>

For a controller that drives one live session directly, every session also exposes a loopback **SDK WebSocket** endpoint, the `gjc sdk session` CLI (`list|inspect|send|status|tail`), and the bundled `sdk-skills/` (`gjc-sdk-discover` · `gjc-sdk-operate` · `gjc-sdk-author`) — reviewed, approval-gated procedures any controller-hosted agent can follow.

- [External controller integration guide](docs/bot-integration.md) · [Coordinator MCP bridge](docs/hermes-mcp-bridge.md)
- [External controller / bot](docs/bot-integration.md) — provider-independent smokes; [`docs/aside-integration.md`](docs/aside-integration.md) covers the opt-in search/context sidecar
- [SDK & wire protocol](docs/sdk.md) · [SDK session CLI](docs/sdk-session-cli.md) · [External-control readiness](docs/external-control-readiness.md)

---

## Documentation

Start at **[gajae-code.com](https://gajae-code.com)** or `docs/`:

- [Install & updates](docs/install.md) · [Environment variables](docs/environment-variables.md) · [Keybindings](docs/keybindings.md) · [Themes](docs/theme.md)
- [Models & providers](docs/models.md) · [Custom providers & multi-account routing](docs/custom-providers-and-multi-account.md) · [Multi-vendor profiles](docs/multi-vendor-profiles.md) · [Auth broker](docs/auth-broker-gateway.md)
- [Telegram](docs/telegram-onboarding.md) · [Bot integration](docs/bot-integration.md) · [SDK](docs/sdk.md) · [SDK session CLI](docs/sdk-session-cli.md)
- [Sessions](docs/session.md) · [Compaction](docs/compaction.md) · [Memory](docs/memory.md) · [Secrets](docs/secrets.md)
- [Codebase overview](docs/codebase-overview.md) · [Contributing / dev setup](CONTRIBUTING.md)
- [macOS Option/Alt key setup (iTerm2)](docs/macos-option-key.md) · [GEO visibility benchmark](docs/geobench.md)

The default dark TUI identity is the GJC red-claw theme; light-appearance terminals default to the bundled blue-crab theme. See [Themes](docs/theme.md) to swap or build your own.

## SDK extensions

### Skill migration and bundled skill inspection

When moving a workflow into GJC, inspect the bundled defaults before installing or overwriting anything:

```sh
gjc skills list
gjc skills read ralplan
gjc setup defaults --check
```

`gjc setup defaults` installs the four bundled GJC workflow skills into your user `.gjc` directory and preserves existing local files by default. If `--check` reports missing or different files, compare the embedded copy with `gjc skills read <name>` first; use `gjc setup defaults --force` only when you intentionally want to replace local default workflow skill files.

## Works beside your existing agent or bot

| Tool or bot | Recommended GJC command | Boundary |
| ----------- | ----------------------- | -------- |
| Codex CLI | `gjc --tmux --worktree <name>` or `gjc` | `--worktree` names a GJC-managed sibling worktree; for an existing path, `cd` there first. |
| Claude Code | `gjc --tmux` or `gjc --tmux --worktree <name>` | GJC does not become a Claude Code extension. |
| OpenCode | `gjc` or `gjc --tmux` | External-runner workflow only today. |
| Claw Code | `gjc --tmux --worktree <name>` | GJC does not install into or replace Claw Code. |
| External controller / bot | Coordinator MCP, `gjc sdk session`, or a configured managed adapter | External controllers use broker-bound, credential-free surfaces rather than scrollback or direct endpoint transports. The host-neutral `gjc-sdk-*` skills compose `gjc sdk session` and install no coordinator integration. |

For evaluating Aside as an opt-in search/context retrieval sidecar, see [`docs/aside-integration.md`](docs/aside-integration.md). For generic third-party bot setup and provider-independent smokes, see [`docs/bot-integration.md`](docs/bot-integration.md). For external-control readiness, see [`docs/external-control-readiness.md`](docs/external-control-readiness.md). For the wire protocol and machine interfaces, see [`docs/sdk.md`](docs/sdk.md).

## SDK Extensions

- [gjc-remote](https://github.com/kogangdon/gjc-remote) — a real-world SDK extension for controlling allowlisted GJC sessions on remote hosts from Discord.
- [oh-my-gajae-code](https://github.com/devswha/oh-my-gajae-code) — a community plugin marketplace for installing additional workflow skills and slash commands.
- [GJC multivendor setup guide](https://github.com/project820/gjc-multivendor-setup-guide) — role-based provider profiles and installable model bundles for multivendor GJC setups.

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

### Launch-time updates

Interactive startup checks the npm registry for a newer GJC version in the background by default. This check is notify-only and non-mutating: GJC never installs or replaces itself during launch. For a recognized Bun global install, use `gjc update` or `bun install -g @gajae-code/coding-agent@latest`. For a recognized Windows npm install, use `gjc update` or the original npm package workflow. For a supported standalone binary installed by the bundled installer, use `gjc update` or rerun the documented platform installer. For a source checkout or `dev:link` executable, update, pull, build, and link through that checkout's original workflow. For unrecognized npm, pnpm, other package-manager installs, or unknown PATH targets, use the original package manager or install method.

Run `gjc config set startup.checkUpdate false` to disable the launch-time check. Registry or network failures are ignored so they do not block startup.

Both the launch-time check and `gjc update` resolve the registry the way npm does — `BUN_CONFIG_REGISTRY` or `npm_config_registry` from the environment, a scoped `@gajae-code:registry` key, then your user and machine-wide `.npmrc`, including the credentials registered for that registry. A mirrored or firewalled network is therefore checked at the same place the update would install from. A `.npmrc` in the current working directory is deliberately ignored, so a repository you have cloned cannot redirect the check or choose the credential it carries. `bunfig.toml` is not read, so a mirror declared only there is still checked against the public registry.

### Good to read together

- [GJC multivendor setup guide](https://github.com/project820/gjc-multivendor-setup-guide) — a community guide for role-based provider/profile selection across Anthropic, OpenAI/Codex, Google/Gemini, xAI/Grok, and opencode-go. Treat its presets as user-level configuration guidance rather than bundled defaults; verify model availability and provider auth in your own environment before adopting them.

## TUI identity

The default dark TUI identity is the GJC red-claw theme, while light-appearance terminals default to the bundled blue-crab theme. Three additional bundled migration themes — `claude-code`, `codex`, and `opencode` — mirror the look of those tools for easy eye-migration and are selectable from Settings or `/theme`. Explicit user theme settings still win.

### Bundled theme grid

Pick from Settings (`Appearance -> Dark theme` / `Light theme`) or `/theme`.

| Theme | Visual feel | Best fit |
| --- | --- | --- |
| `red-claw` | Dark GJC default with warm red-claw accents and strong status contrast. | Native GJC identity for dark terminals. |
| `blue-crab` | Bright-terminal blue palette tuned for readable light slots. | Light terminal or OS appearance. |
| `claude-code` | Claude Code-inspired dark palette with terracotta and pink highlights. | Claude Code muscle memory without leaving GJC. |
| `codex` | Crisp dark blue-gray palette with sharper coding-session contrast. | A Codex-like dark workspace. |
| `opencode` | OpenCode-inspired dark palette with punchier terminal accents. | OpenCode muscle memory in the bundled picker. |

## Development

```sh
bun install
bun run build:native
bun run dev:link       # global `gjc` runs this checkout's source
bun run dev:doctor     # verify the link
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/codebase-overview.md](docs/codebase-overview.md) for the package map and gates.

## Contributors & lineage

Thanks to [Yeachan-Heo](https://github.com/Yeachan-Heo), [IYENTeam](https://github.com/IYENTeam), [HaD0Yun](https://github.com/HaD0Yun), and [probepark](https://github.com/probepark). GJC builds on lessons from a small family of agent harnesses; historical attribution lives in [NOTICE.md](NOTICE.md).

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <em>"Encode intention. Decode software."</em>
  <br/><br/>
  <strong>The plan comes first. The mutation earns its place.</strong>
</p>
