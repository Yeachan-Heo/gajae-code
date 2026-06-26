# Environment Variables (Current Runtime Reference)

This reference is derived from current code paths in:

- `packages/coding-agent/src/**`
- `packages/ai/src/**` (provider/auth resolution used by coding-agent)
- `packages/utils/src/**` and `packages/tui/src/**` where those vars directly affect coding-agent runtime

It documents only active behavior.

## Resolution model and precedence

Most runtime lookups use `$env` from `@gajae-code/utils` (`packages/utils/src/env.ts`).

`$env` loading order:

1. Existing process environment (`Bun.env`)
2. Project `.env` (`$PWD/.env`) for keys not already set
3. Agent `.env` (`~/.gjc/agent/.env`, respecting `GJC_CONFIG_DIR` / `GJC_CODING_AGENT_DIR`) for keys not already set
4. Config-root `.env` (`~/.gjc/.env`, respecting `GJC_CONFIG_DIR`) for keys not already set
5. Home `.env` (`~/.env`) for keys not already set

Additional rule inside each `.env` file: `GJC_*` keys are mirrored to `GJC_*` keys in that parsed file.

---

## 1) Model/provider authentication

These are consumed via `getEnvApiKey()` (`packages/ai/src/stream.ts`) unless noted otherwise.

### Core provider credentials

| Variable                        | Used for                                         | Required when                                                  | Notes / precedence                                                                                  |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_TOKEN`         | Anthropic API auth                               | Using Anthropic with OAuth token auth                          | Takes precedence over `ANTHROPIC_API_KEY` for provider auth resolution                              |
| `ANTHROPIC_API_KEY`             | Anthropic API auth                               | Using Anthropic without OAuth token                            | Fallback after `ANTHROPIC_OAUTH_TOKEN`                                                              |
| `ANTHROPIC_FOUNDRY_API_KEY`     | Anthropic via Azure Foundry / enterprise gateway | `ANTHROPIC_MODEL_CODE_USE_FOUNDRY` enabled                              | Takes precedence over `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` when Foundry mode is enabled  |
| `OPENAI_API_KEY`                | OpenAI auth                                      | Using OpenAI-family providers without explicit apiKey argument | Used by OpenAI Completions/Responses providers                                                      |
| `GEMINI_API_KEY`                | Google Gemini auth                               | Using `google` provider models                                 | Primary key for Gemini provider mapping                                                             |
| `GOOGLE_API_KEY`                | Gemini image tool auth fallback                  | Using `gemini_image` tool without `GEMINI_API_KEY`             | Used by coding-agent image tool fallback path                                                       |
| `GROQ_API_KEY`                  | Groq auth                                        | Using Groq models                                              |                                                                                                     |
| `CEREBRAS_API_KEY`              | Cerebras auth                                    | Using Cerebras models                                          |                                                                                                     |
| `FIREWORKS_API_KEY`             | Fireworks auth                                   | Using Fireworks models                                         |                                                                                                     |
| `TOGETHER_API_KEY`              | Together auth                                    | Using `together` provider                                      |                                                                                                     |
| `HUGGINGFACE_HUB_TOKEN`         | Hugging Face auth                                | Using `huggingface` provider                                   | Primary Hugging Face token env var                                                                  |
| `HF_TOKEN`                      | Hugging Face auth                                | Using `huggingface` provider                                   | Fallback when `HUGGINGFACE_HUB_TOKEN` is unset                                                      |
| `SYNTHETIC_API_KEY`             | Synthetic auth                                   | Using Synthetic models                                         |                                                                                                     |
| `NVIDIA_API_KEY`                | NVIDIA auth                                      | Using `nvidia` provider                                        |                                                                                                     |
| `NANO_GPT_API_KEY`              | NanoGPT auth                                     | Using `nanogpt` provider                                       |                                                                                                     |
| `VENICE_API_KEY`                | Venice auth                                      | Using `venice` provider                                        |                                                                                                     |
| `LITELLM_API_KEY`               | LiteLLM auth                                     | Using `litellm` provider                                       | OpenAI-compatible LiteLLM proxy key                                                                 |
| `LM_STUDIO_API_KEY`             | LM Studio auth (optional)                        | Using `lm-studio` provider with authenticated hosts            | Local LM Studio usually runs without auth; any non-empty token works when a key is required         |
| `OLLAMA_API_KEY`                | Ollama auth (optional)                           | Using `ollama` provider with authenticated hosts               | Local Ollama usually runs without auth; any non-empty token works when a key is required            |
| `LLAMA_CPP_API_KEY`             | llama.cpp auth (optional)                        | Using `llama.cpp` provider with authenticated hosts            | Local llama.cpp usually runs without auth; any non-empty token works when a key is configured       |
| `XIAOMI_API_KEY`                | Xiaomi MiMo auth                                 | Using `xiaomi` provider                                        |                                                                                                     |
| `MOONSHOT_API_KEY`              | Moonshot auth                                    | Using `moonshot` provider                                      |                                                                                                     |
| `XAI_API_KEY`                   | xAI auth                                         | Using xAI models                                               |                                                                                                     |
| `OPENROUTER_API_KEY`            | OpenRouter auth                                  | Using OpenRouter models                                        | Also used by image tool when preferred/auto provider is OpenRouter                                  |
| `MISTRAL_API_KEY`               | Mistral auth                                     | Using Mistral models                                           |                                                                                                     |
| `ZAI_API_KEY`                   | z.ai auth                                        | Using z.ai models                                              | Also used by z.ai web search provider                                                               |
| `MINIMAX_API_KEY`               | MiniMax auth                                     | Using `minimax` provider                                       |                                                                                                     |
| `AZURE_OPENAI_API_KEY`          | Azure OpenAI auth                               | Using `azure-openai` / `azure-openai-responses` models         | Pair with `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`                                   |
| `MINIMAX_CODE_API_KEY`          | MiniMax Code auth                                | Using `minimax-code` provider                                  |                                                                                                     |
| `MINIMAX_CODE_CN_API_KEY`       | MiniMax Code CN auth                             | Using `minimax-code-cn` provider                               |                                                                                                     |
| `OPENCODE_API_KEY`              | OpenCode auth                                    | Using `opencode-go` / `opencode-zen` models                    |                                                                                                     |
| `QIANFAN_API_KEY`               | Qianfan auth                                     | Using `qianfan` provider                                       |                                                                                                     |
| `QWEN_OAUTH_TOKEN`              | Qwen Portal auth                                 | Using `qwen-portal` with OAuth token                           | Takes precedence over `QWEN_PORTAL_API_KEY`                                                         |
| `QWEN_PORTAL_API_KEY`           | Qwen Portal auth                                 | Using `qwen-portal` with API key                               | Fallback after `QWEN_OAUTH_TOKEN`                                                                   |
| `ZENMUX_API_KEY`                | ZenMux auth                                      | Using `zenmux` provider                                        | Used for ZenMux OpenAI and Anthropic-compatible routes                                              |
| `VLLM_API_KEY`                  | vLLM auth/discovery opt-in                       | Using `vllm` provider (local OpenAI-compatible servers)        | Any non-empty value works for no-auth local servers                                                 |
| `CURSOR_ACCESS_TOKEN`           | Cursor provider auth                             | Using Cursor provider                                          |                                                                                                     |
| `AI_GATEWAY_API_KEY`            | Vercel AI Gateway auth                           | Using `vercel-ai-gateway` provider                             |                                                                                                     |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway auth                       | Using `cloudflare-ai-gateway` provider                         | Base URL must be configured as `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` |
| `ALIBABA_CODING_PLAN_API_KEY`   | Alibaba Coding Plan auth                         | Using `alibaba-coding-plan` provider                           |                                                                                                     |
| `DEEPSEEK_API_KEY`              | DeepSeek auth                                    | Using DeepSeek models                                          |                                                                                                     |
| `KILO_API_KEY`                  | Kilo auth                                        | Using Kilo models                                              |                                                                                                     |
| `OLLAMA_CLOUD_API_KEY`          | Ollama Cloud auth                                | Using `ollama-cloud` provider                                  |                                                                                                     |
| `GITLAB_TOKEN`                  | GitLab Duo auth                                  | Using `gitlab-duo` provider                                    |                                                                                                     |

### GitHub/Copilot token chains

| Variable               | Used for                                         | Chain                                                |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot provider auth                     | `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` |
| `GH_TOKEN`             | Copilot fallback; GitHub API auth in web scraper | In web scraper: `GITHUB_TOKEN` → `GH_TOKEN`          |
| `GITHUB_TOKEN`         | Copilot fallback; GitHub API auth in web scraper | In web scraper: checked before `GH_TOKEN`            |

### Auth broker / auth gateway (remote credential vault)

When the broker is enabled, the local SQLite credential store is bypassed and all OAuth refresh / access tokens live on the broker host. See [`auth-broker-gateway.md`](./auth-broker-gateway.md) for the full protocol, CLI surface, and 5-min/15-s usage cache layering.

| Variable                | Used for                                                                                          | Required when                                                                                                          | Notes / precedence                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GJC_AUTH_BROKER_URL`   | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`); selects broker mode      | Resolving credentials through a broker; also required by `gjc auth-gateway serve` (the gateway is itself a broker client) | Wins over `auth.broker.url` in `config.yml`. When set with no resolvable token, `resolveAuthBrokerConfig()` hard-errors instead of falling back to local SQLite.                                    |
| `GJC_AUTH_BROKER_TOKEN` | Bearer token sent on every broker endpoint except `/v1/healthz`                                   | `GJC_AUTH_BROKER_URL` is set and no token is available from `auth.broker.token` or `<config-dir>/auth-broker.token`     | Resolution: this env → `auth.broker.token` (`$ENV_NAME` indirection supported) → `<config-dir>/auth-broker.token` (mode `0600`). `<config-dir>` is `~/.gjc/` (respecting `GJC_CONFIG_DIR`).         |

The gateway has no dedicated env vars — it inherits `GJC_AUTH_BROKER_*`. Its own inbound bearer token lives at `<config-dir>/auth-gateway.token` and is managed via `gjc auth-gateway token`.

### Multi-account credential ranking

When more than one OAuth credential is stored for the same provider (e.g. several Anthropic accounts), `AuthStorage` ranks them at session start to pick which one serves the session. This env var selects the ranking strategy; it is fully opt-in and does not change the default.

| Variable                      | Used for                                          | Required when  | Notes / precedence                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GJC_CREDENTIAL_RANKING_MODE` | Multi-account OAuth credential selection strategy | Never (opt-in) | `balanced` (default) prefers the least-drained account (spreads load, keeps burst headroom). `earliest-reset` prefers the soonest-to-reset non-blocked account (earliest-expiry-first) so perishable tumbling-window quota (e.g. Claude 5h/7d) is drained before reset. Unset/unknown → `balanced`. Only affects session-start ranking; blocked/exhausted accounts still sort last. |

---

## 2) Provider-specific runtime configuration

### Anthropic Foundry Gateway (Azure / enterprise proxy)

When `ANTHROPIC_MODEL_CODE_USE_FOUNDRY` is enabled, Anthropic requests switch to Foundry mode:

- Base URL resolves from `FOUNDRY_BASE_URL` (fallback remains model/default base URL if unset).
- API key resolution for provider `anthropic` becomes:
  `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`.
- `ANTHROPIC_CUSTOM_HEADERS` is parsed as comma/newline-separated `key: value` pairs and merged into request headers.
- TLS client/server material can be injected from env values:
  `NODE_EXTRA_CA_CERTS`, `ANTHROPIC_MODEL_CODE_CLIENT_CERT`, `ANTHROPIC_MODEL_CODE_CLIENT_KEY`.
  Each accepts either:
  - a filesystem path to PEM content, or
  - inline PEM (including escaped `\n` sequences).

| Variable                    | Value type                                     | Behavior                                                                      |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `ANTHROPIC_MODEL_CODE_USE_FOUNDRY`   | Boolean-like string (`1`, `true`, `yes`, `on`) | Enables Foundry mode for Anthropic provider                                   |
| `FOUNDRY_BASE_URL`          | URL string                                     | Anthropic endpoint base URL in Foundry mode                                   |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token string                                   | Used for `Authorization: Bearer <token>`                                      |
| `ANTHROPIC_CUSTOM_HEADERS`  | Header list string                             | Extra headers; format `header-a: value, header-b: value` or newline-separated |
| `NODE_EXTRA_CA_CERTS`       | PEM path or inline PEM                         | Extra CA chain for server certificate validation                              |
| `ANTHROPIC_MODEL_CODE_CLIENT_CERT`   | PEM path or inline PEM                         | mTLS client certificate                                                       |
| `ANTHROPIC_MODEL_CODE_CLIENT_KEY`    | PEM path or inline PEM                         | mTLS client private key (must be paired with cert)                            |

### Amazon Bedrock

| Variable                                                                        | Default / behavior                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `AWS_REGION`                                                                    | Primary region source                                                                         |
| `AWS_DEFAULT_REGION`                                                            | Fallback if `AWS_REGION` unset                                                                |
| `AWS_PROFILE`                                                                   | Enables named profile auth path                                                               |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`                                   | Enables IAM key auth path                                                                     |
| `AWS_BEARER_TOKEN_BEDROCK`                                                      | Enables bearer token auth path                                                                |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | Enables ECS task credential path                                                              |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`                                  | Enables web identity auth path                                                                |
| `AWS_BEDROCK_SKIP_AUTH`                                                         | If `1`, injects dummy credentials (proxy/non-auth scenarios)                                  |
| `AWS_BEDROCK_FORCE_HTTP1`                                                       | If `1`, forces Node HTTP/1 request handler                                                    |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`                                      | Routes Bedrock runtime and AWS SSO credential calls through the configured proxy using HTTP/1 |
| `NO_PROXY`                                                                      | Excludes matching hosts from proxy routing when a proxy variable is configured                |

Region fallback in provider code: `options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

Credential fallback order is static env (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` plus optional `AWS_SESSION_TOKEN`), named profile / SSO / `credential_process`, then EC2 IMDSv2. `models.yml` Bedrock entries use `api: bedrock-converse-stream` and do not require `apiKey` or `apiKeyEnv` because the provider signs requests from this AWS chain.

### Azure OpenAI Responses

| Variable                           | Default / behavior                                                          |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`             | Required unless API key passed as option                                    |
| `AZURE_OPENAI_API_VERSION`         | Default `v1`                                                                |
| `AZURE_OPENAI_BASE_URL`            | Direct base URL override                                                    |
| `AZURE_OPENAI_RESOURCE_NAME`       | Used to construct base URL: `https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Optional mapping string: `modelId=deploymentName,model2=deployment2`        |

Base URL resolution: option `azureBaseUrl` → env `AZURE_OPENAI_BASE_URL` → option/env resource name → `model.baseUrl`.

### Model provider base URL overrides

Built-in model provider base URLs resolve with this precedence:

1. `models.yml` / model config provider `baseUrl`
2. provider-specific base URL environment variable
3. bundled provider default

Supported aliases:

| Provider | Variables |
| --- | --- |
| OpenAI | `OPENAI_BASE_URL` |
| Anthropic | `ANTHROPIC_BASE_URL` |
| Google Gemini | `GOOGLE_BASE_URL`, `GEMINI_BASE_URL` |
| Google Antigravity | `GOOGLE_ANTIGRAVITY_BASE_URL`, then `GOOGLE_BASE_URL`, then `GEMINI_BASE_URL` |
| Google Gemini CLI | `GOOGLE_GEMINI_CLI_BASE_URL`, then `GOOGLE_BASE_URL`, then `GEMINI_BASE_URL` |
| Google Vertex | `GOOGLE_VERTEX_BASE_URL`, then `GOOGLE_BASE_URL`, then `GEMINI_BASE_URL` |
| Any provider id | derived `<PROVIDER_ID>_BASE_URL`, uppercased with non-alphanumerics converted to `_` (for example `my-proxy` → `MY_PROXY_BASE_URL`) |

OpenAI-compatible proxy note: the built-in `openai` provider keeps its bundled API transport (`openai-responses`). Setting `OPENAI_BASE_URL` changes the host but still calls `<baseUrl>/responses`. If your proxy only supports Chat Completions, configure a custom `models.yml` provider with `api: openai-completions` instead of using the built-in OpenAI provider override:

```yaml
providers:
  openai-compatible:
    baseUrl: https://proxy.example.com/v1
    apiKey: OPENAI_API_KEY
    api: openai-completions
    models:
      - id: gpt-4o
        name: GPT-4o via proxy
        api: openai-completions
```

For OpenRouter traffic, GJC explicitly sends `User-Agent: Gajae-Code/<package version>` plus OpenRouter attribution headers. For the built-in OpenAI Responses transport and generic OpenAI-compatible Chat Completions transport, GJC passes model/provider headers through the OpenAI JavaScript SDK and does not set a GJC user-agent unless the provider-specific code adds one.

### OpenAI-compatible proxy provider config

For OpenAI-compatible proxies that only implement Chat Completions, prefer a custom `models.yml` provider over `OPENAI_BASE_URL`:

```yaml
providers:
  openai-compatible:
    baseUrl: https://proxy.example.com/v1
    apiKeyEnv: OPENAI_API_KEY
    api: openai-completions
    auth: apiKey
    headers:
      User-Agent: curl/8.7.1
    models:
      - id: gpt-4o
        name: GPT-4o via proxy
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
```

`models.yml` is strict: unsupported provider/model keys fail validation before the provider request is dispatched.

### GJC workflow bridge commands

`gjc ralplan`, `gjc deep-interview`, and `gjc state` are private runtime bridge commands. They require `GJC_RUNTIME_BINARY` (or legacy `GJC_LEGACY_RUNTIME_BINARY`) to point at the private runtime executable; public bundled workflow use remains through `/skill:ralplan` and `/skill:deep-interview` inside a GJC session.

| Variable | Behavior |
| --- | --- |
| `GJC_RUNTIME_BINARY` | Private runtime bridge binary for `gjc ralplan`, `gjc deep-interview`, and `gjc state` |
| `GJC_LEGACY_RUNTIME_BINARY` | Legacy fallback bridge binary name |

### Interactive `--tmux` startup and scroll/mouse profile

`gjc --tmux` launches the interactive TUI inside a fresh GJC-managed tmux session. Plain `gjc --tmux` does not auto-attach a scoped managed session from the same project/branch; use an explicit resume path such as `gjc --tmux --continue`, `gjc --tmux --resume`, or `gjc session attach <session>` when you intend to continue existing tmux context. Older-version sessions are not auto-attached after upgrades. When GJC creates a session it applies a profile that is **scoped to the GJC session only** (it never runs `set -g` / global tmux options), including:

- `mouse on` — enables mouse-wheel scrolling into tmux copy-mode (history/scrollback).
- `set-clipboard on` and a readable copy-mode `mode-style`.
- GJC ownership/identity tags (`@gjc-profile`, version, branch/project markers).

This profile is applied on macOS, Linux, WSL (Linux), and native Windows when a compatible tmux provider is available. It is applied **only to sessions GJC itself creates**. If you start tmux yourself and then run `gjc` inside it, GJC leaves your tmux configuration untouched — add `set -g mouse on` to your own `~/.tmux.conf`, or relaunch with `gjc --tmux` to get the managed profile.

| Variable | Behavior |
| --- | --- |
| `GJC_LAUNCH_POLICY` | Launch policy for `--tmux` startup: `tmux` (default) or `direct` (skip the tmux session) |
| `GJC_TMUX_SESSION` | Explicit tmux session name override for `--tmux` startup. Use a unique value (for example `GJC_TMUX_SESSION=gjc-fresh-$(date +%s) gjc --tmux`) to force a fresh named session. |
| `GJC_TMUX_COMMAND` | tmux binary/name override for every GJC tmux flow (`GJC_TEAM_TMUX_COMMAND` is honored as a team-path alias). This is not a shell command line; include only the executable path/name, not flags. |
| `GJC_TMUX_PROFILE` | Set `0`/`false`/`off` to apply only the required ownership tags and skip the scroll/mouse/clipboard profile |
| `GJC_MOUSE` | Set `0`/`false`/`off` to skip `mouse on`, leaving wheel scrolling to the host terminal instead of tmux copy-mode |
| `GJC_PSMUX_COMMAND` | Force the resolved multiplexer to be treated as psmux (skips the version-banner probe). Useful when the binary is a thin wrapper that does not advertise `psmux` in `-V` output. |
| `GJC_PSMUX_DETECTION` | Set `0`/`false`/`off` to skip psmux detection entirely. GJC falls back to treating the resolved command as plain tmux. |
| `GJC_PSMUX_FORCE_DETECT` | Set `1`/`true`/`on` to re-probe the multiplexer on every call instead of caching the per-process verdict. |

#### Windows psmux support

On native Windows, [psmux](https://github.com/psmux/psmux) is the supported tmux-compatible multiplexer for `gjc --tmux`, `gjc session`, and `gjc team`. Psmux may be installed as `psmux.exe` or through its `tmux.exe` / `pmux.exe` aliases; the same guidance applies when `GJC_TMUX_COMMAND` is left at the default `tmux` but the executable on PATH is actually psmux.

Detection runs once per process: GJC walks `psmux`, then `pmux`, then `tmux` on Windows PATH, picks the first binary that resolves, and probes it with `<binary> -V`. The probe verdict is cached for the lifetime of the process. The cached verdict keys off the resolved binary path, so renaming or installing a different binary in the same PATH slot still gets re-probed on next launch.

The probe matches the `psmux` and `pmux` substrings in the version banner. If psmux is installed under a custom wrapper that hides the version banner, set `GJC_PSMUX_COMMAND` to that wrapper path so the multiplexer is treated as psmux without a probe. To turn detection off entirely (for example to debug a non-psmux Windows tmux port), set `GJC_PSMUX_DETECTION=off`.

Native Windows `gjc --tmux` builds a real PowerShell-encoded plan when psmux is on PATH: `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ...` invokes gjc inside a psmux-managed session, the same ownership-tag (`@gjc-profile`) and project/branch/session-identity markers round-trip via `set-option` / `show-options` / `list-sessions -F`, and `gjc team` spawns worker panes via `split-window` against the same psmux session. Worker commands are emitted with PowerShell-safe `$env:VAR = 'value';` assignments so psmux's ConPTY panes inherit `GJC_TEAM_*` correctly.

The `mouse`, `set-clipboard`, and `mode-style` UX profile options are filtered out of the emitted profile when the resolved multiplexer is psmux because psmux historically does not round-trip those keys; the `@gjc-profile` ownership tag and the branch / project / session identity markers are still emitted because those are the ones that gate `gjc session` and `gjc team`. If you want the full UX profile on Windows, set `GJC_TMUX_COMMAND=tmux` against a real tmux binary (via WSL or a separate install).

#### Windows psmux namespace boundary

psmux follows tmux-style server semantics: `new-session -c <path>`, `new-window -c <path>`, and GJC's `gjc --tmux` cwd only choose the start directory for the session/window/pane. They do **not** create a per-project server namespace. psmux server isolation uses the tmux-compatible global flag `-L <namespace>`.

GJC does not currently expose a supported `GJC_TMUX_NAMESPACE` runtime knob or parse flags from `GJC_TMUX_COMMAND`. Do not set `GJC_TMUX_COMMAND="psmux -L my-project"`; GJC treats the value as one executable path/name. Runtime `-L` support requires a structured tmux command resolver so launch, `gjc session`, and `gjc team` all target the same namespace. Until that exists, manage psmux namespaces explicitly outside GJC (for example by starting `psmux -L <namespace>` yourself before `gjc --tmux` and letting GJC attach) and treat them as unsupported for GJC ownership-tag/team guarantees.

#### WSL / Windows Terminal scrolling

On WSL with Windows Terminal, scrolling behaves differently depending on whether tmux owns the mouse:

- **With the GJC profile (default):** the mouse wheel enters tmux copy-mode and scrolls the pane's scrollback. Keyboard fallback: `Ctrl-b [` to enter copy-mode, then `PgUp`/arrows; `q` to exit.
- **Without tmux mouse capture (`GJC_MOUSE=off`, or running outside `gjc --tmux`):** Windows Terminal handles the wheel and scrolls its own native scrollback.

If the wheel does not scroll inside `gjc --tmux` on WSL, confirm the session is GJC-managed (`gjc session list`) so the `mouse on` profile is actually applied; sessions you launched yourself do not receive it. Set `GJC_MOUSE=off` if you prefer Windows Terminal's native scrollback over tmux copy-mode.

### Team tmux backend, dry-run, and state paths

`gjc team ...` starts tmux worker panes from the current tmux-backed leader session. Start that leader with `gjc --tmux` first; `gjc team` intentionally does not create or attach the leader session itself.

`gjc team ... --dry-run --json` creates the same machine-readable state tree as a team launch without starting tmux panes. By default that state is written under `<cwd>/.gjc/state/team/<team>/`; treat it as ephemeral smoke-test/review state. Do not commit generated `.gjc/state/team` contents. Remove the generated team directory after a dry-run when the harness no longer needs it.

| Variable | Behavior |
| --- | --- |
| `GJC_TEAM_STATE_ROOT` | Overrides the team state root (default `<cwd>/.gjc/state/team`) |
| `GJC_TEAM_TMUX_COMMAND` | tmux binary/command override for team launch |
| `GJC_TEAM_WORKER_COMMAND` | Worker GJC command override |
| `GJC_TEAM_WORKER_CLI` | Team worker CLI selector; accepted values are `auto` or `gjc` |
| `GJC_TEAM_WORKER_CLI_MAP` | Comma-separated worker CLI selector map; entries must be `auto` or `gjc` |

### Hermes MCP bridge

`gjc mcp-serve coordinator` exposes a GJC-native outward MCP bridge for Hermes-style coordinators. `gjc mcp-serve hermes` is a compatibility alias for the same bridge. The bridge is read-only by default and fails closed until roots and mutation classes are explicitly configured.

Coordinator MCP currently exposes durable polling/await tools, not push subscriptions. Consume `gjc_coordinator_read_coordination_status`, `gjc_coordinator_read_turn`, or bounded `gjc_coordinator_await_turn` for state changes.

| Variable | Behavior |
| --- | --- |
| `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` | Required allowlist for workdir and artifact paths. `gjc setup hermes` renders absolute normalized paths joined with the platform path delimiter (`:` on POSIX, `;` on Windows). The bridge parser also accepts commas, semicolons, and newlines for legacy manual configs. |
| `GJC_COORDINATOR_MCP_MUTATIONS` | Enables mutating tool classes as a comma-separated list (`sessions`, `questions`, `reports`) or `all`. `sessions` covers session startup, prompt delivery, durable turn journal updates, queue, and force operations. Per-call `allow_mutation: true` is still required. |
| `GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP` | Max bytes returned by artifact reads (default `65536`, capped at `1048576`). |
| `GJC_COORDINATOR_MCP_STATE_ROOT` | Bridge coordination state root (default `<cwd>/.gjc/state/coordinator-mcp`). |
| `GJC_COORDINATOR_MCP_PROFILE` | Optional profile namespace for session/question/report state. Missing scope never widens to global session enumeration. |
| `GJC_COORDINATOR_MCP_REPO` | Optional repo namespace for session/question/report state. Missing scope never widens to global session enumeration. |
| `GJC_COORDINATOR_MCP_SESSION_COMMAND` | GJC-compatible command used by mutating session startup to launch a detached tmux session. `gjc setup hermes` renders this to `gjc --worktree` by default so Hermes-installed configs start real GJC work in a GJC-managed worktree while preserving GJC project/session resume identity. Explicit values are preserved as user intent. When manually omitted, mutating session startup fails closed unless a service adapter is injected. |
| `GJC_COORDINATOR_MCP_SETUP_MANAGED_BY` | Marker written by `gjc setup hermes` for safe managed config updates. |
| `GJC_COORDINATOR_MCP_SETUP_SCHEMA_VERSION` | Managed setup schema version written by `gjc setup hermes`. |
| `GJC_COORDINATOR_MCP_SETUP_SIGNATURE` | Deterministic managed setup signature used to detect safe updates versus unmanaged conflicts. |

### Google Vertex AI

| Variable                         | Required?                      | Notes                                                                                                                     |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | Yes (unless passed in options) | Fallback: `GCLOUD_PROJECT`                                                                                                |
| `GCLOUD_PROJECT`                 | Fallback                       | Used as alternate project ID source                                                                                       |
| `GOOGLE_CLOUD_PROJECT_ID`        | OAuth login helper only        | Used by Gemini CLI OAuth project discovery                                                                                |
| `GOOGLE_CLOUD_LOCATION`          | Yes (unless passed in options) | No default in provider                                                                                                    |
| `GOOGLE_CLOUD_API_KEY`           | Conditional                    | Direct Vertex API-key auth; otherwise ADC fallback can authenticate when project and location are set                     |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional                    | If set, file must exist; otherwise ADC fallback path is checked (`~/.config/gcloud/application_default_credentials.json`) |

### Kimi

| Variable               | Default / behavior                                       |
| ---------------------- | -------------------------------------------------------- |
| `KIMI_CODE_OAUTH_HOST` | Primary OAuth host override                              |
| `KIMI_OAUTH_HOST`      | Fallback OAuth host override                             |
| `KIMI_CODE_BASE_URL`   | Overrides Kimi usage endpoint base URL (`usage/kimi.ts`) |

OAuth host chain: `KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`.

### Gemini CLI compatibility

| Variable                   | Default / behavior                                              |
| -------------------------- | --------------------------------------------------------------- |
| `GJC_AI_GEMINI_CLI_VERSION` | Overrides Gemini CLI user-agent version tag (`0.35.3` if unset) |

### OpenAI code provider responses (feature/debug controls)

| Variable                             | Behavior                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `GJC_OPENAI_CODE_DEBUG`                     | `1`/`true` enables OpenAI code provider debug logging      |
| `GJC_OPENAI_CODE_WEBSOCKET`                 | `1`/`true` enables websocket transport preference    |
| `GJC_OPENAI_CODE_WEBSOCKET_V2`              | `1`/`true` enables websocket v2 path                 |
| `GJC_OPENAI_CODE_WEBSOCKET_IDLE_TIMEOUT_MS` | Positive integer override (default 300000)           |
| `GJC_OPENAI_CODE_WEBSOCKET_RETRY_BUDGET`    | Non-negative integer override (default 5)            |
| `GJC_OPENAI_CODE_WEBSOCKET_RETRY_DELAY_MS`  | Positive integer base backoff override (default 500) |
| `GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS`   | Positive integer OpenAI stream idle timeout override |

### Cursor provider debug

| Variable           | Behavior                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `DEBUG_CURSOR`     | Enables provider debug logs; `2`/`verbose` for detailed payload snippets |
| `DEBUG_CURSOR_LOG` | Optional file path for JSONL debug log output                            |

### Prompt cache compatibility switch

| Variable             | Behavior                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GJC_CACHE_RETENTION` | If `long`, enables long retention where supported (`anthropic`, `openai-responses`, Bedrock retention resolution); any other value forces `short`. The Anthropic provider already defaults to `long` (1h) when unset, so this is mainly an opt-out (`short`) or a way to extend long retention to other providers. |

---

## 3) Web search subsystem

### Search provider credentials

| Variable                                            | Used by                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `EXA_API_KEY`                                       | Exa search provider                         |
| `BRAVE_API_KEY`                                     | Brave search provider                                         |
| `PERPLEXITY_API_KEY`                                | Perplexity search provider API-key mode                       |
| `PERPLEXITY_COOKIES`                                | Perplexity cookie-auth search mode                            |
| `TAVILY_API_KEY`                                    | Tavily search provider                                        |
| `ZAI_API_KEY`                                       | z.ai search provider (also checks stored OAuth in `agent.db`) |
| `OPENAI_API_KEY` / OpenAI code OAuth in DB                | OpenAI code search provider availability/auth                       |
| `GJC_OPENAI_CODE_WEB_SEARCH_MODEL`                         | OpenAI code search provider model override                          |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`   | Kimi/Moonshot search provider env auth                        |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot search endpoint override                        |
| `KAGI_API_KEY`                                      | Kagi search provider                                          |
| `JINA_API_KEY`                                      | Jina search provider                                          |
| `PARALLEL_API_KEY`                                  | Parallel search provider                                      |
| `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`                 | SearXNG endpoint and optional bearer token                    |
| `SEARXNG_BASIC_USERNAME`, `SEARXNG_BASIC_PASSWORD`  | SearXNG HTTP Basic Auth credentials                           |

SearXNG also reads the equivalent `searxng.endpoint`, `searxng.token`, `searxng.basicUsername`, and `searxng.basicPassword` settings from `~/.gjc/agent/config.yml`; environment variables are fallbacks.

### Anthropic web search auth chain

Anthropic web search uses `findAnthropicAuth()` from `packages/ai/src/utils/anthropic-auth.ts` in this order:

1. `ANTHROPIC_SEARCH_API_KEY` (+ optional `ANTHROPIC_SEARCH_BASE_URL`)
2. `ANTHROPIC_FOUNDRY_API_KEY` when `ANTHROPIC_MODEL_CODE_USE_FOUNDRY` is enabled
3. Anthropic OAuth credentials from `agent.db` (must not expire within 5-minute buffer)
4. Anthropic API-key credentials from `agent.db`
5. Generic Anthropic env fallback: provider key (`ANTHROPIC_FOUNDRY_API_KEY` in Foundry mode, otherwise `ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`) + optional `ANTHROPIC_BASE_URL` (`FOUNDRY_BASE_URL` when Foundry mode is enabled)

Related vars:

| Variable                    | Default / behavior                                   |
| --------------------------- | ---------------------------------------------------- |
| `ANTHROPIC_SEARCH_API_KEY`  | Highest-priority explicit search key                 |
| `ANTHROPIC_SEARCH_BASE_URL` | Defaults to `https://api.anthropic.com` when omitted |
| `ANTHROPIC_SEARCH_MODEL`    | Defaults to `anthropic-model-haiku-4-5`                       |
| `ANTHROPIC_BASE_URL`        | Generic fallback base URL for tier-4 auth path       |

### Perplexity OAuth flow behavior flag

| Variable            | Behavior                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| `GJC_AUTH_NO_BORROW` | If set, disables macOS native-app token borrowing path in Perplexity login flow |

---

## 4) Python tooling and kernel runtime

| Variable                  | Default / behavior                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GJC_PY`                   | Eval backend override: `0`/`bash`=JavaScript only, `1`/`py`=Python only, `mix`/`both`=both; invalid values ignored |
| `GJC_PYTHON_SKIP_CHECK`    | If `1`, skips Python interpreter availability checks (subprocess runner still starts on demand)                     |
| `GJC_PYTHON_INTEGRATION`   | If `1`, opts gated integration tests in (e.g. `python-runner.integration.test.ts`) into running against real Python |
| `GJC_PYTHON_IPC_TRACE`     | If `1`, logs NDJSON frames exchanged with the Python runner subprocess                                              |
| `VIRTUAL_ENV`             | Highest-priority venv path for Python runtime resolution                                                            |

Extra conditional behavior:

- If `BUN_ENV=test` or `NODE_ENV=test`, Python availability checks are treated as OK and warming is skipped.
- Python env filtering denies common API keys and allows safe base vars + `LC_`, `XDG_`, `GJC_` prefixes.

---

## 5) Agent/runtime behavior toggles

| Variable                     | Default / behavior                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `GJC_SMOL_MODEL`              | Ephemeral model-role override for `smol` (CLI `--smol` takes precedence)                           |
| `GJC_SLOW_MODEL`              | Ephemeral model-role override for `slow` (CLI `--slow` takes precedence)                           |
| `GJC_PLAN_MODEL`              | Ephemeral model-role override for `plan` (CLI `--plan` takes precedence)                           |
| `GJC_NO_TITLE`                | If set (any non-empty value), disables auto session title generation on first user message         |
| `NULL_PROMPT`                | If `true`, system prompt builder returns empty string                                              |
| `GJC_BLOCKED_AGENT`           | Blocks a specific subagent type in task tool                                                       |
| `GJC_SUBPROCESS_CMD`          | Overrides subagent spawn command (`gjc` / `gjc.cmd` resolution bypass)                             |
| `GJC_TASK_MAX_OUTPUT_BYTES`   | Max captured output bytes per subagent (default `500000`)                                          |
| `GJC_TASK_MAX_OUTPUT_LINES`   | Max captured output lines per subagent (default `5000`)                                            |
| `GJC_TIMING`                  | If set (any non-empty value), prints a hierarchical timing-span tree to **stderr** via `logger.printTimings()`. In interactive mode the tree prints once the agent is ready (before the TUI starts); in print mode it prints after the whole prompt batch completes. Print-mode prompts are wrapped in `print:prompt:initial` / `print:prompt:next` spans so each user message shows up as its own row. `GJC_TIMING=x` exits the process with code 0 right after printing in interactive mode (use to measure cold startup only). `GJC_TIMING=full` lists every module-load entry instead of just the top N. |
| `GJC_PACKAGE_DIR`             | Overrides package asset base dir resolution (docs/examples/changelog path lookup)                  |
| `GJC_DISABLE_LSPMUX`          | If `1`, disables lspmux detection/integration and forces direct LSP server spawning                |
| `GJC_RPC_EMIT_TITLE`          | Boolean-like flag enabling title events in RPC mode                                                |
| `SMITHERY_URL`               | Smithery web URL override (default `https://smithery.ai`)                                          |
| `SMITHERY_API_URL`           | Smithery API base URL override (default `https://api.smithery.ai`)                                 |
| `PUPPETEER_EXECUTABLE_PATH`  | Browser tool Chromium executable override                                                          |
| `LM_STUDIO_BASE_URL`         | Default implicit LM Studio discovery base URL override (`http://127.0.0.1:1234/v1` if unset)       |
| `OLLAMA_BASE_URL`            | Default implicit Ollama discovery base URL override (`http://127.0.0.1:11434` if unset)            |
| `LLAMA_CPP_BASE_URL`         | Default implicit Llama.cpp discovery base URL override (`http://127.0.0.1:8080` if unset)          |
| `GJC_EDIT_VARIANT`            | Forces edit tool variant when valid (`patch`, `replace`, `hashline`, `atom`, `vim`, `apply_patch`) |
| `GJC_FORCE_IMAGE_PROTOCOL`    | Forces supported image protocol (`kitty`, `iterm2`/`iterm`, `sixel`, `none`) where used            |
| `GJC_ALLOW_SIXEL_PASSTHROUGH` | Allows SIXEL passthrough when `GJC_FORCE_IMAGE_PROTOCOL=sixel`                                      |
| `GJC_NO_PTY`                  | If `1`, disables interactive PTY path for bash tool                                                |

`GJC_NO_PTY` is also set internally when CLI `--no-pty` is used.

---

## 6) Storage and config root paths

These are consumed via `@gajae-code/utils/dirs` and affect where coding-agent stores data.

| Variable              | Default / behavior                                                            |
| --------------------- | ----------------------------------------------------------------------------- |
| `GJC_CONFIG_DIR`       | Config root dirname under home (default `.gjc`)                               |
| `GJC_CODING_AGENT_DIR` | Full override for agent directory (default `~/<GJC_CONFIG_DIR or .gjc>/agent`) |
| `PWD`                 | Used when matching canonical current working directory in path helpers        |

---

## 7) Shell/tool execution environment

(From `packages/utils/src/procmgr.ts` and coding-agent bash tool integration.)

| Variable                   | Behavior                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| `GJC_BASH_NO_CI`            | Suppresses automatic `CI=true` injection into spawned shell env                |
| `ANTHROPIC_MODEL_BASH_NO_CI`        | Legacy alias fallback for `GJC_BASH_NO_CI`                                      |
| `GJC_BASH_NO_LOGIN`         | Disables login-shell mode; shell args become `['-c']` instead of `['-l','-c']` |
| `ANTHROPIC_MODEL_BASH_NO_LOGIN`     | Legacy alias fallback for `GJC_BASH_NO_LOGIN`                                   |
| `GJC_SHELL_PREFIX`          | Optional command prefix wrapper                                                |
| `ANTHROPIC_MODEL_CODE_SHELL_PREFIX` | Legacy alias fallback for `GJC_SHELL_PREFIX`                                    |
| `VISUAL`                   | Preferred external editor command                                              |
| `EDITOR`                   | Fallback external editor command                                               |

Current implementation: `GJC_BASH_NO_LOGIN`/`ANTHROPIC_MODEL_BASH_NO_LOGIN` are active; when either is set, `getShellArgs()` returns `['-c']`.

---

## 8) UI/theme/session detection (auto-detected env)

These are read as runtime signals; they are usually set by the terminal/OS rather than manually configured.

| Variable                                                                                                           | Used for                                                  |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `COLORTERM`, `TERM`, `WT_SESSION`                                                                                  | Color capability detection (theme color mode)             |
| `COLORFGBG`                                                                                                        | Terminal background light/dark auto-detection             |
| `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMINAL_EMULATOR`                                                        | Terminal identity in system prompt/context                |
| `KDE_FULL_SESSION`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `XDG_SESSION_DESKTOP`, `GDMSESSION`, `WINDOWMANAGER` | Desktop/window-manager detection in system prompt/context |
| `KITTY_WINDOW_ID`, `TMUX_PANE`, `TERM_SESSION_ID`, `WT_SESSION`                                                    | Stable per-terminal session breadcrumb IDs                |
| `SHELL`, `ComSpec`, `TERM_PROGRAM`, `TERM`                                                                         | System info diagnostics                                   |
| `APPDATA`, `XDG_CONFIG_HOME`                                                                                       | lspmux config path resolution                             |
| `HOME`                                                                                                             | Path shortening in command UI                         |

---

## 9) TUI runtime flags (shared package, affects coding-agent UX)

| Variable                  | Behavior                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `GJC_NOTIFICATIONS`        | `off` / `0` / `false` suppress desktop notifications                                  |
| `GJC_TUI_WRITE_LOG`        | If set, logs TUI writes to file                                                       |
| `GJC_HARDWARE_CURSOR`      | If `1`, enables hardware cursor mode                                                  |
| `GJC_CLEAR_ON_SHRINK`      | If `1`, clears empty rows when content shrinks                                        |
| `GJC_DEBUG_REDRAW`         | If `1`, enables redraw debug logging                                                  |
| `GJC_TUI_DEBUG`            | If `1`, enables deep TUI debug dump path                                              |
| `GJC_FORCE_IMAGE_PROTOCOL` | Forces terminal image protocol detection (`kitty`, `iterm2`/`iterm`, `sixel`, `none`) |
| `GJC_TUI_KEYBOARD_PROTOCOL` | Enhanced keyboard input (Kitty keyboard protocol + xterm modifyOtherKeys). Enabled by default; set `0` / `false` to leave the keyboard in its default mode. Use this when a terminal (e.g. Android Termius) breaks IME/Hangul composition while these enhanced modes are active. |

---

## 10) Commit generation controls

| Variable                  | Behavior                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| `GJC_COMMIT_TEST_FALLBACK` | If `true` (case-insensitive), force commit fallback generation path |
| `GJC_COMMIT_NO_FALLBACK`   | If `true`, disables fallback when agent returns no proposal         |
| `GJC_COMMIT_MAP_REDUCE`    | If `false`, disables map-reduce commit analysis path                |
| `DEBUG`                   | If set, commit agent error stack traces are printed                 |

---

## 11) Bridge mode (`--mode bridge`)

Consumed by `packages/coding-agent/src/modes/bridge/*`. The bridge is a
network-reachable control surface and is **secure-by-default**: it refuses to
start without TLS and a bearer token, and the 0.3.1 default endpoint matrix
fail-closes session events, commands, controller ownership, UI responses, host
tool results, and host URI results. See `docs/bridge.md` for protocol details.

| Variable | Required | Default | Behavior |
| --- | --- | --- | --- |
| `GJC_BRIDGE_TOKEN` | Yes | — | Bearer token required on authenticated endpoints. **Secret — never commit.** |
| `GJC_BRIDGE_TLS_CERT` | Yes | — | Path to the TLS certificate (PEM). Startup fails closed if cert/key are missing (TLS is mandatory, including loopback). |
| `GJC_BRIDGE_TLS_KEY` | Yes | — | Path to the TLS private key (PEM). **Secret — never commit; `chmod 600`.** |
| `GJC_BRIDGE_HOST` | No | `127.0.0.1` | Bind hostname. |
| `GJC_BRIDGE_PORT` | No | `4077` | Bind port (1–65535). |
| `GJC_BRIDGE_SCOPES` | No | `prompt` | Parsed for dormant command-surface compatibility. Valid scopes: `prompt`, `control`, `bash`, `export`, `session`, `model`, `message:read`, `host_tools`, `host_uri`, `admin`. The default endpoint matrix still advertises no accepted scopes and rejects commands before scope checks. |

Local development with a self-signed certificate must add the local CA to the
client trust store; there is no plaintext or certificate-verification-bypass mode.

---

## Security-sensitive variables

Treat these as secrets; do not log or commit them:

- Provider/API keys and OAuth/bearer credentials (all `*_API_KEY`, `*_TOKEN`, OAuth access/refresh tokens)
- Cloud credentials (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS` path may expose service-account material)
- Search/provider auth vars (`EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, Anthropic search keys)
- Foundry mTLS material (`ANTHROPIC_MODEL_CODE_CLIENT_CERT`, `ANTHROPIC_MODEL_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS` when it points to private CA bundles)
- Bridge auth/TLS material (`GJC_BRIDGE_TOKEN` and the `GJC_BRIDGE_TLS_KEY` private key; never commit cert/key/token material)

Python runtime also explicitly strips many common key vars before spawning kernel subprocesses (`packages/coding-agent/src/eval/py/runtime.ts`).
