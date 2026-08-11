<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">Gajae-Code</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  A coding agent that runs on the plan you already pay for — and answers to your phone.
</p>

<p align="center">
  <a href="https://gajae-code.com"><img alt="Website" src="https://img.shields.io/badge/website-gajae--code.com-ff4d4f?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/gajae-code"><img alt="npm package" src="https://img.shields.io/npm/v/gajae-code?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <a href="https://discord.gg/8vPXmxSt9"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  English | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>

> Gajae-Code is an experimental, beta-stage project. Expect rough edges and verify outputs before relying on it for important work.

Gajae-Code (`gjc`) is an external coding-agent harness: run it in any repository or worktree, plan before mutating, execute with evidence, and stay in control from your terminal, your phone, or your own bot.

## Bring your coding plan

<p align="center">
  <img src="assets/coding-plans-banner.png" alt="Coding plans and providers GJC runs on: Claude, ChatGPT/Codex, Gemini, GitHub Copilot, GitLab Duo, Cursor, Grok, GLM/Z.AI, Kimi, MiniMax, Qwen, Xiaomi, Perplexity, OpenCode, Fireworks" width="100%" />
</p>

Log in once and run GJC on the subscription you already have. No separate API billing required — run `/login` inside a session and pick a provider:

| Plan / subscription | OAuth login |
| --- | --- |
| Claude Pro / Max | `anthropic` |
| ChatGPT Plus / Pro (Codex) | `openai-codex` (browser) · `openai-codex-device` (headless) |
| Google Gemini CLI (Cloud Code Assist) | `google-gemini-cli` |
| GitHub Copilot | `github-copilot` |
| GitLab Duo | `gitlab-duo` |
| Cursor | `cursor` |
| xAI (Grok) | `xai` |
| Z.AI GLM Coding Plan | `zai` |
| Kimi Code / Coding Plan / Moonshot | `kimi-code` · `moonshot` |
| Fire Pass (Fireworks Kimi K2.6 Turbo subscription) | `firepass` |
| OpenCode Zen / OpenCode Go | `opencode-zen` · `opencode-go` |
| MiniMax Coding Plan (Intl / CN) | `minimax-code` · `minimax-code-cn` |
| Alibaba Token Plan / Qwen Portal | `alibaba-token-plan` · `qwen-portal` |
| Xiaomi Token Plan (SGP / EU / CN) | `xiaomi-token-plan-*` |
| Perplexity Pro / Max | `perplexity` |
| Command Code GOAT coding plan | `gjc setup` preset `commandcode-goat` (`CMD_API_KEY`) |

Beyond OAuth plans, 50+ providers work through API keys, local runtimes (Ollama, LM Studio, vLLM), and gateways (Cloudflare AI Gateway, Vercel AI Gateway, LiteLLM, and more). Register your own endpoints in `models.yml`, pool multiple accounts per provider with usage-aware routing, mix vendors per agent role with model presets and profiles, or centralize team credentials with the auth broker/gateway.

- [Models, providers, and auth resolution](docs/models.md)
- [Custom providers & multi-account routing](docs/custom-providers-and-multi-account.md)
- [Multi-vendor role profiles](docs/multi-vendor-profiles.md)
- [Auth broker & gateway (shared team credentials)](docs/auth-broker-gateway.md)

## Answer from your phone

<p align="center">
  <img src="assets/telegram-mobile-hero.png" alt="Gajae Code mobile answers for coding agents hero illustration" width="100%" />
</p>

When the agent needs a decision, it pings you on Telegram — and you answer from anywhere:

- **Per-session forum topics** with live/finalized output, context updates, image attachments, inline buttons, free-text replies, and typing indicators.
- **Configure once** from `/settings` → Notifications in a running session, or headless via `gjc notify setup|status|health|test|recovery`. Tokens are masked on entry and never displayed again.
- **`gjc daemon`** keeps one safe long-poll owner per bot token, so new sessions attach cleanly without Telegram 409 conflicts.
- Discord and Slack delivery ship alongside; the generic `action_needed`/`reply` protocol lets any bot or mobile app route answers back without terminal scraping.

- [Telegram onboarding](docs/telegram-onboarding.md) · [Discord](docs/discord-onboarding.md) · [Slack](docs/slack-onboarding.md)

## Spend fewer tokens

GJC optimizes both sides of the token bill:

- **Cache hits** — per-provider `cacheRetention` control; Anthropic defaults to long (1h) cache retention because short caches are fragile for long agent runs; provider ranking prefers cheap `cacheRead` paths; opt-in session-affinity headers let OpenAI-compatible relays reuse server-side prompt caches.
- **Context savings** — file reads return structural summaries instead of whole files; oversized shell output is minimized and spilled to retrievable `artifact://` references instead of flooding the context; compaction and branch summaries keep long sessions inside the window without losing prior work.

- [Cache retention & provider compat](docs/models.md) · [Compaction & branch summaries](docs/compaction.md)

## Plan before mutation

A deliberately small workflow surface — four skills, four role agents, nothing else:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

| Surface | What it does |
| --- | --- |
| `deep-interview` | Turns vague requests into concrete requirements. |
| `ralplan` | Builds and critiques the implementation plan before code changes. |
| `ultragoal` | Tracks goals through execution, revision, verification, and evidence. |
| `team` | Coordinates tmux-backed workers when parallelism is worth it. |
| `executor` / `architect` / `planner` / `critic` | Bundled role agents for implementation and read-only review lanes. |

Also included, opt-in: **`gjc rlm`** (a Jupyter-style research/REPL mode that synthesizes a notebook and report) and **`computer-use`** (experimental desktop control). See [Python REPL](docs/python-repl.md) and [docs/tools/computer.md](docs/tools/computer.md).

## Install

```sh
bun install -g gajae-code
gjc
```

Prebuilt binaries cover Linux (x64/arm64), macOS (arm64/x64), and Windows (x64); the npm/Bun path works everywhere. Nightly channel: `bun install -g gajae-code@nightly`.

Full install matrix, Windows setup, update channels, and shell completion: [docs/install.md](docs/install.md).

## Quick start

```sh
gjc                                # run in the current checkout
gjc --tmux                         # tmux-backed leader session
gjc --tmux --worktree my-task      # isolated worktree for risky work
gjc @screenshot.png "What should I change?"   # image input
```

Inside a session:

```text
/login                       pick a provider / coding plan
/skill:deep-interview        clarify ambiguous requirements
/skill:ralplan               build and critique the plan
gjc ultragoal create-goals --brief-file <approved-plan>
```

The default dark TUI identity is the GJC red-claw theme, while light-appearance terminals default to the bundled blue-crab theme. Pick more from Settings or `/theme`.

## Let OpenClaw / Hermes drive GJC

GJC ships a native Coordinator MCP bridge, so an external controller like OpenClaw or Hermes orchestrates real GJC sessions through durable turns — never terminal scraping.

Don't read a guide — paste this prompt into your OpenClaw/Hermes controller and let it wire itself up:

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

For a controller that drives one live session directly, every session also exposes a loopback **SDK WebSocket** endpoint, the `gjc sdk session` CLI (`list|inspect|send|status|tail`), and the bundled `sdk-skills/` (`gjc-sdk-discover` · `gjc-sdk-operate` · `gjc-sdk-author`) — reviewed, approval-gated procedures any controller-hosted agent can follow.

- [External controller integration guide](docs/bot-integration.md) · [Coordinator MCP bridge](docs/hermes-mcp-bridge.md)
- [External controller / bot](docs/bot-integration.md) — provider-independent smokes; [`docs/aside-integration.md`](docs/aside-integration.md) covers the opt-in search/context sidecar
- [SDK & wire protocol](docs/sdk.md) · [SDK session CLI](docs/sdk-session-cli.md) · [External-control readiness](docs/external-control-readiness.md)

## Documentation

Start at **[gajae-code.com](https://gajae-code.com)** or `docs/`:

- [Install & updates](docs/install.md) · [Environment variables](docs/environment-variables.md) · [Keybindings](docs/keybindings.md) · [Themes](docs/theme.md)
- [Models & providers](docs/models.md) · [Custom providers & multi-account routing](docs/custom-providers-and-multi-account.md) · [Multi-vendor profiles](docs/multi-vendor-profiles.md) · [Auth broker](docs/auth-broker-gateway.md)
- [Telegram](docs/telegram-onboarding.md) · [Bot integration](docs/bot-integration.md) · [SDK](docs/sdk.md) · [SDK session CLI](docs/sdk-session-cli.md)
- [Sessions](docs/session.md) · [Compaction](docs/compaction.md) · [Memory](docs/memory.md) · [Secrets](docs/secrets.md)
- [Codebase overview](docs/codebase-overview.md) · [Contributing / dev setup](CONTRIBUTING.md)
- [macOS Option/Alt key setup (iTerm2)](docs/macos-option-key.md) · [GEO visibility benchmark](docs/geobench.md)

## SDK extensions

- [gjc-remote](https://github.com/kogangdon/gjc-remote) — control allowlisted GJC sessions on remote hosts from Discord.
- [oh-my-gajae-code](https://github.com/devswha/oh-my-gajae-code) — community plugin marketplace for extra skills and slash commands.
- [GJC multivendor setup guide](https://github.com/project820/gjc-multivendor-setup-guide) — role-based provider profiles for multivendor setups.

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
