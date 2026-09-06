# Model and Provider Configuration (`models.yml`)

This document describes how the coding-agent currently loads models, applies overrides, resolves credentials, and chooses models at runtime.

## What controls model behavior

Primary implementation files:

- `src/config/model-registry.ts` — loads embedded + signed-registry + custom models, provider overrides, runtime discovery, auth integration
- `src/config/model-resolver.ts` — parses model patterns and selects models for the default and agent roles
- `src/config/settings-schema.ts` — model-related settings (`modelRoles`, provider transport preferences)
- `src/session/auth-storage.ts` — API key + OAuth resolution order
- `packages/ai/src/models.ts` and `packages/ai/src/types.ts` — built-in providers/models and `Model`/`compat` types

## Config file location and legacy behavior

Default config path:

- `~/.gjc/agent/models.yml`

Legacy behavior still present:

- If `models.yml` is missing and `models.json` exists at the same location, it is migrated to `models.yml`.
- Explicit `.json` / `.jsonc` config paths are still supported when passed programmatically to `ModelRegistry`.

## `models.yml` shape

```yaml
providers:
  <provider-id>:
    # provider-level config
equivalence:
  overrides:
    <provider-id>/<model-id>: <canonical-model-id>
  exclude:
    - <provider-id>/<model-id>
```

`provider-id` is the canonical provider key used across selection and auth lookup.

`equivalence` is optional and configures canonical model grouping on top of concrete provider models:

- `overrides` maps an exact concrete selector (`provider/modelId`) to an official upstream canonical id
- `exclude` opts a concrete selector out of canonical grouping

## Provider-level fields

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false  # set true for Anthropic-compatible endpoints that reject the strict field
    cacheRetention: short  # none | short | long; model entries and modelOverrides can override this
    discovery:
      type: ollama
    modelOverrides:
      some-model-id:
        name: Renamed model
        cacheRetention: long
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        cacheRetention: none
        thinking:
          minLevel: low
          maxLevel: xhigh
          mode: effort
          defaultLevel: high
          levels: [low, medium, high, xhigh]
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
modelBindings:
  modelRoles:
    default: my-provider/some-model-id:high
  agentModelOverrides:
    executor: my-provider/some-model-id
```

### Allowed provider/model `api` values

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `bedrock-converse-stream`
- `anthropic-messages`
- `google-generative-ai`
- `google-vertex`
- `google-gemini-cli`
- `ollama-chat`
- `cursor-agent`


### First-class DeepInfra, Azure OpenAI, and Amazon Bedrock examples

Azure OpenAI uses canonical OpenAI model IDs in GJC and resolves those IDs to Azure deployment names at request time. Set `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` to avoid assuming model id equals deployment name:

```yaml
providers:
  azure-openai:
    baseUrl: https://my-resource.openai.azure.com/openai/v1
    apiKeyEnv: AZURE_OPENAI_API_KEY
    api: azure-openai-responses
    models:
      - id: gpt-4.1
      - id: o3
```

```sh
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP='gpt-4.1=gpt-41-prod,o3=o3-reasoning-prod'
```

DeepInfra is available as the first-class `deepinfra` provider. It uses DeepInfra's OpenAI-compatible Chat Completions endpoint and reads `DEEPINFRA_API_KEY` when no explicit config key is provided. Set `serviceTier: priority` in GJC config or use the runtime service-tier controls to send DeepInfra's `service_tier: "priority"` request field for supported models:

```yaml
providers:
  deepinfra:
    baseUrl: https://api.deepinfra.com/v1/openai
    apiKeyEnv: DEEPINFRA_API_KEY
    api: openai-completions
    models:
      - id: deepseek-ai/DeepSeek-V3.2
```

#### `/fast` provider support

`/fast on` only shows `⚡` when GJC will put a fast/priority field on the selected provider's wire request:

| Provider ID | Wire request | Notes |
|---|---|---|
| `openai` | `service_tier: "priority"` | OpenAI renamed Priority processing to [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode); `priority` remains an accepted alias. For API-key requests, the response `service_tier` reports the tier actually used and may be `default` after a ramp-rate downgrade. |
| `openai-codex` | `service_tier: "priority"` | ChatGPT-authenticated Codex handles Fast through server-side routing. A final response value of `service_tier: "default"` does not show that Fast was ignored or downgraded. |
| `anthropic` | `speed: "fast"` plus `fast-mode-2026-02-01` beta | Direct Claude API only. Anthropic's [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) is model- and account-gated; unsupported or unavailable requests can fall back after a provider rejection. Bedrock, Vertex, and Microsoft Foundry do not support it. |
| `deepinfra` | `service_tier: "priority"` | Sent only for the first-class `deepinfra` provider ID and only with the `priority` tier. |
| `opencodex` | `service_tier: "priority"` | First-class OpenCodex discovery opts in automatically; OpenCodex Fast Mode must remain `Auto` for client passthrough. When OpenCodex uses ChatGPT authentication, a final `service_tier: "default"` is not downgrade evidence. |

Custom OpenAI-compatible providers remain fail-closed unless their provider or model configuration explicitly sets `compat.supportsServiceTier: true`. Use that opt-in only when the proxy preserves or intentionally realizes OpenAI's `service_tier` contract:

```yaml
providers:
  my-openai-proxy:
    baseUrl: http://proxy.example/v1
    api: openai-responses
    compat:
      supportsServiceTier: true
```

Without that capability, `/fast status` shows `off` even when the session retains an unscoped `priority` intent. The `⚡` indicator means that GJC sends the provider's fast request field. API-key providers may report a downgrade in their response; ChatGPT-authenticated Codex and OpenCodex route Fast server-side and cannot be verified from the final `service_tier` value.

Amazon Bedrock uses the native `bedrock-converse-stream` transport and AWS credential chain auth. Do not put AWS access keys in `models.yml`; configure `AWS_REGION` / `AWS_PROFILE` or standard static AWS credential environment variables instead:

```yaml
providers:
  amazon-bedrock:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com
    api: bedrock-converse-stream
    models:
      - id: us.anthropic.claude-opus-4-6-v1
      - id: anthropic.claude-3-5-sonnet-20241022-v2:0
```

### Coding-plan provider presets

For supported coding-plan providers, prefer presets so the API type, base URL, environment variable, model catalog, discovery behavior, and compatibility flags are written together:

```sh
gjc setup provider --preset minimax
gjc setup provider --preset minimax-cn
gjc setup provider --preset glm
gjc setup provider --preset alibaba-token-plan
gjc setup provider --preset cline-pass
gjc setup provider --preset commandcode-goat
```

The same presets are available inside the TUI:

```text
/provider add --preset minimax
/provider add --preset glm
/provider add zai
/provider add --preset alibaba-token-plan
/provider add --preset cline-pass
/provider add --preset commandcode-goat
```

Presets only write `models.yml` entries that reference documented environment variable names (`MINIMAX_CODE_API_KEY`, `MINIMAX_CODE_CN_API_KEY`, `ZAI_API_KEY`, `ALIBABA_TOKEN_PLAN_API_KEY`, `CLINE_API_KEY`, or `CMD_API_KEY`); they do not store or validate real credentials. The GLM preset aliases (`glm`, `zai`, `z-ai`) write an OpenAI-compatible custom provider named `glm-proxy` and do not replace the first-class `zai` provider. The Alibaba Token Plan preset (aliases: `alibaba`, `token-plan`) writes an OpenAI-compatible custom provider named `alibaba-token-plan` with per-model API routing. The ClinePass preset (aliases: `clinepass`, `cline`) does not hardcode models: Cline's inference API has no working `/models` route, so GJC follows Cline's own catalog-generation source and fetches the live `cline-pass` provider catalog from `https://models.dev/api.json`. The Command Code GOAT preset (aliases: `commandcode`, `command-code`, `goat`) fetches its live `/provider/v1/models` catalog, keeps every current or future model—including Claude-named IDs—on the provider's documented OpenAI-compatible `/chat/completions` transport, and requires a fixed harmless inference entitlement probe before login persistence. Create the corresponding API key in the provider dashboard before inference; plan entitlement is enforced by the provider.

## Signed remote preset registry

GJC ships its embedded model metadata and profiles as an immutable bootstrap fallback, then overlays a separately published signed registry before applying local configuration:

1. embedded model presets and profiles
2. the last accepted `Yeachan-Heo/gajae-code-presets` registry snapshot
3. user `~/.gjc/agent/models.yml` entries and overrides

Local user configuration always wins. Registry refresh never writes `models.yml`, and a failed, partial, oversized, incompatible, downgraded, equivocated, digest-mismatched, or untrusted update never replaces the active snapshot. Startup reads only the verified local cache and does not wait for network I/O; a delayed best-effort refresh runs at a bounded cadence. Offline cold starts use embedded data, while offline warm starts use the last-known-good accepted snapshot.

The registry manifest is canonical JSON signed with a compiled Ed25519 trust root. Signatures are 64-byte Ed25519 values encoded as canonical RFC 4648 Base64; unused padding bits must be zero, so two encodings of the same signature cannot produce distinct anti-equivocation digests. The signed payload binds the monotonic revision, consumer-contract compatibility, immutable revision paths, exact byte counts, SHA-256 digests, source commit provenance, snapshot, profile data, and credential-free model metadata. GJC sends no cookies, authorization headers, API keys, or provider credentials when fetching it. Registry schemas do not permit endpoints, request headers, credentials, environment references, commands, scripts, or arbitrary executable content. Selectors, preset identifiers, display text, and context-promotion targets reject Unicode format controls. Registry provider IDs are slash-free (`[a-z0-9][a-z0-9._-]*`), matching profile `requiredProviders` and the first-slash selector boundary used at runtime.

Administrative commands:

```sh
gjc models presets status [--json]
gjc models presets refresh [--json]
gjc models presets rollback <accepted-revision> [--json]
gjc models presets pin <accepted-revision> [--json]
gjc models presets unpin [--json]
gjc models presets disable [--json]
gjc models presets enable [--json]
```

`status` reports deterministic, credential-free provenance: active and highest-seen revisions, manifest/snapshot/profile/preset digests, signature key id, source GJC commit, accepted/published/check timestamps, retained removed entries, cache health, history, and pin/disable state. Rollback and pin can select only previously verified retained revisions; neither lowers the highest-seen anti-rollback floor, and selected generations are protected from bounded-history eviction. A rollback remains selected across background refreshes until another rollback/pin is chosen or `unpin` returns selection to the highest accepted revision. When a registry revision removes a profile, GJC retains that profile plus only the removed model metadata and dynamic-provider declarations it references so an existing default/current selection remains usable without unboundedly copying the whole prior catalog.

The cache and control files live under `~/.gjc/agent/model-presets/` (respecting `GJC_CODING_AGENT_DIR`). Writes use an interprocess lock, file fsync, and atomic rename. POSIX filesystems also receive a parent-directory durability barrier; Windows does not expose an equivalent directory fsync through Bun/Node, so it retains the file-fsync + atomic-rename guarantee with weaker crash durability for the renamed directory entry. `GJC_MODEL_PRESET_REGISTRY_URL` may override the manifest URL only with credential-free HTTPS; the trust root cannot be replaced at runtime. `GJC_MODEL_PRESET_REGISTRY_DISABLED=1` provides a non-destructive environment disable.

## Model profiles (`--mpreset`)

Model profiles are optional top-level `profiles:` entries in `~/.gjc/agent/models.yml`. A profile can require provider credentials before activation and can map one or more model roles; omitted roles inherit from the active defaults.

> See also: [Cross-vendor role-based profiles](./multi-vendor-profiles.md) — a curated multi-vendor `profiles:` recipe and verified selector notes that build on the mechanism described here.

```yaml
profiles:
  team-standard:
    required_providers: [openai, anthropic]
    model_mapping:
      default: openai/gpt-5.2
      executor: anthropic/claude-sonnet-5:medium
      architect: openai/o3:high
      planner: openai/o3:high
      critic: openai/o3:high
```

`model_mapping` keys are role names (`default`, `executor`, `architect`, `planner`, `critic`). Every role accepts either one selector or a non-empty ordered array of selectors; the first entry is primary and later entries are fallback candidates. A selector may be a provider-agnostic bare alias such as `glm-5.2[:effort]` or an explicit `provider/modelId[:effort]` pin, including nested model IDs such as `openrouter/anthropic/claude-sonnet-5`. `required_providers` lists explicit provider prerequisites and may be empty when availability is resolved from bare aliases.

### Fallback chains

Preset `model_mapping` roles, top-level `modelRoles`, and `task.agentModelOverrides` all accept `string | string[]`. Keep one selector per line when a chain needs to be readable:

```yaml
profiles:
  reliable:
    required_providers: [anthropic, openai]
    model_mapping:
      default: [anthropic/claude-sonnet-4-5, openai/gpt-4o-mini]
modelBindings:
  modelRoles:
    default: [anthropic/claude-sonnet-4-5, openai/gpt-4o-mini]
  agentModelOverrides:
    executor: [anthropic/claude-sonnet-4-5, openai/gpt-4o-mini]
```

Resolution-time skips for unavailable, unauthenticated, or unknown entries cost zero attempts and advance immediately. Only request-time retryable failures (such as 429, quota, authentication, or 5xx failures) consume an entry's `fallback.maxAttempts` total attempts (default: `3`). The active default fallback remains sticky for the session; role-override fallback state is fresh for each subagent call. The active model is shown consistently in status and `/model`.

Managed fallback attempts buffer provisional streamed output until an attempt is accepted, so output can appear later than it does for a one-model stream. Current Cursor-agent transports are fail-closed unavailable in retryable fallback chains: resolution rejects them with `Cursor model <selector> requires provider-side tool execution and cannot be used in a retryable fallback chain` because they do not provide a client-side tool-call mode.

Cancellation discards provisional output and emits exactly one cancelled `agent_end`; RPC, ACP, and the TUI therefore settle once. On load, the source-aware one-shot migration reads legacy `retry.fallbackChains`, prepends the effective role chain, and writes the ordered, deduplicated result to the corresponding role array; the legacy key is then ignored.

Built-in profiles are grouped by provider mix and tier:

- `codex-{eco,medium,pro}` — GPT-5.6 Sol/Terra/Luna role mixes tuned by tier and reasoning effort; `lunamaxxing` — OpenAI Codex Luna-only profile with maximum reasoning on delegated roles
- `astra-{lite,default,heavy}` — additive OpenAI Codex profiles led by `openai-codex/gpt-6-astra`, displayed as `ASTRA-Lite`, `ASTRA-Default`, and `ASTRA-Heavy` in the CODEX group
- `opencodego` — single OpenCode Go preset (Kimi K3 default and planner, DeepSeek executor/architect, MiMo critic)
- `commandcode-goat` — Command Code GOAT preset (GLM-5.3 default, DeepSeek V4 Flash executor, Kimi K3 planner, GLM-5.2 critic, and DeepSeek V4 Pro architect)
- Provider-agnostic open-model profiles are named by the model families they require. Single-family choices are `open-weights-{glm,deepseek,kimi,luna}`; two-family choices are `open-weights-glm-deepseek`, `open-weights-kimi-deepseek`, and `open-weights-kimi-glm`; `open-weights-kimi-glm-deepseek` uses all three open-weight families; `open-weights-all` adds GPT-5.6 Luna. Choose the smallest combination covered by the models available through your configured providers. Every selector is a bare final-segment alias with `required_providers: []`, so each family may come from any authenticated bundled or custom provider under Provider Priority. GPT-5.6 Luna is proprietary despite its inclusion in this group.
- `macos-omlx-{fast,balanced,quality}` — oMLX presets for local Apple Silicon inference, tuned by measured same-machine throughput. `fast` pins the 4-bit and `balanced` the 8-bit quant of Qwen 3.6 35B A3B; `quality` keeps the 8-bit MoE for the default, executor, planner, and architect roles and routes the critic to the official dense `Qwen3.8-27B-8bit` checkpoint; `macos-omlx-abliterated-{fast,balanced}` both pin `Qwen3.8-27B-Uncensored-MLX-4bit`, the faster of the measured uncensored quants. Every preset uses one role-effort ladder — critic and architect `high`, planner `medium`, executor and default `low` — and `fast`, `balanced`, and the abliterated presets serve a single model, so sub-agents never trigger an oMLX model unload/reload; `quality` swaps models only for the critic role. Selectors use the ids the local server returns from `/v1/models`; activate after starting oMLX on its default loopback endpoint (see [Implicit oMLX discovery](#implicit-omlx-discovery)) — the provider is keyless, so no `/login` is needed.
- `claude-opus` — Anthropic OAuth preset that prefers `claude-opus-5` and deterministically falls back to `claude-opus-4-6` when Opus 5 is absent from the active catalog
- `claude-fable` — Anthropic OAuth preset on `claude-fable-5-1` (default/architect `xhigh`, critic `high`, planner `low`) with `claude-sonnet-5` on the executor role. Fable 5.1 is served only by Anthropic's first-party API; it requires a Claude Code compatibility version of at least `2.1.251` and answers older fingerprints with an HTTP 400 `claude_code_version_too_old`.
- Single-provider tiers: `glm-{eco,medium,pro}`, `kimi-coding-plan-{eco,medium,pro}`, `mimo-{eco,medium,pro}`, `grok-{eco,medium,pro}`, `grok-45-{eco,medium,pro}`, `grok-46-{eco,medium,pro}`, `cursor-{eco,medium,pro}`, `minimax-{eco,medium,pro}`. The versioned Grok profiles use the existing xAI OAuth/subscription provider: `/login xai` authenticates both versions. Direct `/model` assignment requires an explicit effort for `xai/grok-4.5` (`low`, `medium`, or `high`) and `xai/grok-4.6` (`low`, `medium`, `high`, or `xhigh`) instead of leaving the role at `(inherit)`.
- Alibaba Token Plan: `alibaba-token-plan-balanced` preserves the established Qwen/DeepSeek V4 Pro/GLM mix; `alibaba-token-plan-pro` raises execution and independent criticism with DeepSeek V4 Flash 0731 max and GLM xhigh; `alibaba-token-plan-qwenmaxxing` stays Qwen-only; `alibaba-token-plan-qwen-deepseek` keeps Qwen 3.8 Max (`qwen3.8-max`) on the expensive default (high)/architect (xhigh)/critic (xhigh) roles and spends DeepSeek V4 Flash 0731 on the cheap planner (max) and executor (high) roles; `alibaba-token-plan-glm-deepseek` does the same with GLM 5.2 (`glm-5.2`) as the expensive model
- Combos: `opus-codex`, `codex-opencodego`, `fable-opus-codex`, `astra-fable`, and `astra-fable-opus`

GLM-5.3 always enables thinking and accepts only `low`, `high`, and `max`; `max` is the provider default and is recommended for coding. The GLM tiers preserve the former role ordering by collapsing `minimal`/`low` to `low`, `medium`/`high` to `high`, and `xhigh` to `max`. GLM-5.3-Flash keeps the same text contract (per z.ai docs, its text parameters are consistent with GLM-5.3 with a 1M-token context window) and now backs the high-volume lanes of the GLM tiers: `glm-eco` runs default, executor, and planner on `glm-5.3-flash:low` while critic and architect stay on `glm-5.3:high`; `glm-medium` and `glm-pro` keep every role on `glm-5.3` except the executor, which uses `glm-5.3-flash:low` (Medium) and `glm-5.3-flash:high` (Pro).

Gemini 3.7 Flash is bundled wherever Gemini 3.6 Flash already was (`google/gemini-3.7-flash`, `google-gemini-cli/gemini-3.7-flash`, Copilot, Antigravity effort variants, OpenCode Zen, OpenRouter, Vercel AI Gateway, Cursor, and the other 3.6 Flash gateways). First-class Google transports use `google-level` thinking and accept only `low`, `medium`, and `high`; `minimal` is rejected because the official Gemini API returns an error. Provider defaults stay on the existing Pro-class models.

The `eco`, `medium`, and `pro` Codex profile mappings are current product judgments: Eco assigns Terra low/Luna low/Luna high/Terra xhigh/Terra high to default/executor/planner/critic/architect; Medium assigns Sol low/Terra low/Terra high/Sol xhigh/Sol high; Pro assigns Sol medium/Terra medium/Sol high/Sol max/Sol xhigh; and LunaMaxxing assigns Luna medium/Luna xhigh/Luna max/Luna max/Luna max. `opus-codex` retains the Medium Codex executor, critic, and architect roles but uses `anthropic/claude-sonnet-5` for planner; `codex-opencodego` retains the Medium Codex default and architect roles; and `fable-opus-codex` uses the Pro Codex executor and architect roles with `anthropic/claude-opus-5:medium` for planner. The descriptive repeated local exact-edit evidence informs only selected executor-style TypeScript tasks; it does not evaluate or prove default, planner, architect, or critic performance. See [GPT-5.6 Codex preset benchmark](./gpt-5.6-codex-preset-benchmark.md). The Alibaba Pro role evidence and its limits are recorded separately in [Alibaba Token Plan Pro profile benchmark](./alibaba-token-plan-pro-profile-benchmark.md). Cursor Eco uses Composer 2.5 for every role; Medium keeps standard Composer for default/planning and spends the Fast premium on execution, criticism, and architecture; Pro uses Composer 2.5 Fast throughout. Composer does not expose a strength value through the current Cursor RPC, so these profiles use exact model IDs without inert generic effort suffixes. See [Cursor Composer profile tiers](./cursor-composer-profile-tiers.md). Effort suffixes are clamped to each model's supported thinking range at preview and activation time. Single-provider tiers pin each provider's current flagship (`zai/glm-5.2`, `kimi-code/kimi-k2.7-code`, `xiaomi/mimo-v2.5-pro`, `xai/grok-4.3`, `cursor/composer-2.5`, `minimax-code/MiniMax-M3`). User-defined profiles override built-ins by exact profile name.

GPT-6 Astra supports `low`, `medium`, `high`, `xhigh`, and `max`; the ASTRA profiles use only those catalog-backed levels. In default/executor/architect/planner/critic order, `astra-lite` assigns Astra medium/Luna xhigh/Terra xhigh/Astra xhigh/Sol high; `astra-default` assigns Astra medium/Luna max/Terra xhigh/Astra xhigh/Sol xhigh; and `astra-heavy` assigns Astra medium/Sol max/Astra max/Sol max/Astra max. `astra-fable` keeps the ASTRA-Default default, executor, and planner bindings while routing architect and critic to `anthropic/claude-fable-5-1:xhigh`; `astra-fable-opus` additionally routes planner to `anthropic/claude-opus-5:medium`. Both combinations require `openai-codex` and `anthropic` availability, either directly or through the configured preset proxy. The existing Codex presets and the `openai-codex` recommendation remain unchanged.

Use `gjc --mpreset <name>` to activate a profile for the current session only. Activation hard-blocks when any provider listed in `required_providers` lacks credentials. Add `--default` to persist the selected profile as `modelProfile.default` in `config.yml`, so it applies at startup:

```sh
gjc --mpreset codex-medium
gjc --mpreset astra-default
gjc --mpreset opencodego --default
```

### Routing built-in presets through a proxy (`modelProfile.proxyProvider`)

Built-in preset selectors pin a direct provider endpoint (`xai/grok-4.3`, `xiaomi/mimo-v2.5-pro`, …). To serve those models through your own OpenAI-compatible gateway (LiteLLM, OpenRouter, or a custom proxy) instead of each vendor's endpoint, configure the proxy provider id and routing mode in `config.yml`:

```yaml
modelProfile:
  proxyProvider: litellm
  proxyMode: always # use fallback to keep directly authenticated providers direct
```

The proxy provider is a normal `providers:` entry. Add it with `gjc setup provider --preset litellm --base-url <url>` or the generic `gjc setup provider --preset openai-compatible-proxy --base-url <url>` (both presets require `--base-url` and use live model discovery). The configured proxy must be authenticated and expose every routed model. Activation rewrites each selected built-in preset selector from `<direct-provider>/<model>` to `<proxy>/<direct-provider>/<model>` (for example `xai/grok-4.3` → `litellm/xai/grok-4.3`), matching the proxy's catalog entry for the model. The rules:

- Routing applies to **built-in presets only**. User-defined `profiles:` entries always keep their exact selectors — set them explicitly if you want them proxied.
- `proxyMode: fallback` (the default) routes only selectors whose direct provider is unauthenticated. `proxyMode: always` routes every proxy-routable built-in selector through the configured proxy, including selectors with direct credentials.
- The proxy id must name a configured provider. `proxyMode: always` requires `proxyProvider` and a usable proxy credential; activation fails closed when a required proxy is unset or unauthenticated. `auth: none` proxies count as authenticated.
- Only providers the bundled preset catalog treats as routable are rewritten; providers outside that set (for example a custom `acme-private`) keep the direct credential error.
- A routed selector must have exactly one matching proxy catalog model. Exact `<direct-provider>/<model>` proxy ids win over suffix matches; missing or ambiguous matches fail activation before any role can run.

The `/model` command opens to a preset landing view: presets are grouped by provider with live auth marks (✓/✗), highlighting a group expands its tiers, and selecting a tier shows the full role→model preview before applying for the session or as default. Typing jumps straight to model search, and `Browse all models` opens the classic tabbed model selector. In `/login`, `Add custom provider` is the first option for configuring credentials needed by custom or profile-required providers; after a successful provider login, the matching preset is recommended automatically. Custom providers participate in provider-agnostic alias resolution but require manual preset selection.

External SDK/ACP clients (e.g. the Paseo TUI) can select profiles like ordinary models: the SDK `models.list/current` (Q10) catalog exposes every usable profile as a synthetic `gajae-code/<profile>` entry (e.g. `gajae-code/codex-eco`), and selecting one through `model.set` (or the ACP Model picker) activates the profile for the live session only. Persisting a profile remains an explicit TUI choice, mirroring `gjc --mpreset <name> --default`. See [SDK model profiles](./sdk.md#model-profiles-as-synthetic-models-gajae-codeprofile).

MiniMax's OpenAI-compatible endpoint rejects multiple system messages and emits thinking in `reasoning_content`, so pin the public-safe compatibility fields when hand-authoring a custom provider:

```yaml
providers:
  minimax-custom:
    baseUrl: https://api.minimax.io/v1
    apiKeyEnv: MINIMAX_API_KEY
    api: openai-completions
    compat:
      supportsStore: false
      supportsDeveloperRole: false
      supportsReasoningEffort: false
      reasoningContentField: reasoning_content
    models:
      - id: MiniMax-M2.5
```

GLM via z.ai is available as the first-class `zai` provider. For a private GLM-compatible proxy, keep secrets in an env var and disable OpenAI-only request fields as needed:

```yaml
providers:
  glm-proxy:
    baseUrl: https://api.z.ai/api/paas/v4
    apiKeyEnv: ZAI_API_KEY
    api: openai-completions
    compat:
      supportsDeveloperRole: false
      supportsReasoningEffort: false
    models:
      - id: glm-4.6
```

### JetBrains AI (Junie)

`jetbrains-junie` is a first-class provider serving JetBrains-hosted models through the documented
Ingrazzio gateway (`https://ingrazzio-cloud-prod.labs.jb.gg`).

Authenticate with an access token generated at [junie.jetbrains.com/cli](https://junie.jetbrains.com/cli):

```sh
export JUNIE_API_KEY=...
```

The token is sent as `Authorization: Bearer` — JetBrains AI rejects requests that also carry `x-api-key`, so
this provider never lets the Anthropic SDK attach one. Usage is billed against your JetBrains AI
subscription, so bundled per-token costs are zero. There is no OAuth login flow; the environment variable is
the only supported credential source.

The gateway multiplexes transports by model family:

| Family | Models | Transport | Prompt limit |
| --- | --- | --- | --- |
| Claude | `claude-sonnet-4-6` (default), `claude-sonnet-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-fable-5` | `anthropic-messages` | 1M |
| GPT | `gpt-5-2025-08-07`, `gpt-5.2-2025-12-11`, `gpt-5.4`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` | `openai-completions` | 922K |
| GPT (Responses-only) | `gpt-5.3-codex` | `openai-responses` | 272K |

All models cap output at 128K. Junie also exposes Gemini and Grok, but those ride a proprietary Grazie
translation protocol that GJC does not implement, so they are deliberately not bundled. The bare
`opus`/`sonnet`/`gpt`/`grok` aliases are Junie CLI shorthands the gateway itself rejects.

### Allowed auth/discovery values

- `auth`: `apiKey` (default), `none`, or `oauth`; for `models.yml` custom models, `oauth` is accepted by schema but does not waive the `apiKey` requirement
- `models.yml` is strict: unknown provider/model keys fail validation before provider dispatch, so stale keys such as `requestTransform` or `wireModelId` only work where this document lists them.
- `discovery.type`: `ollama`, `llama.cpp`, `lm-studio`, `omlx`, `vllm`, `sglang`, `openai-models-list`, or `models-dev`; `models-dev` may select a different catalog entry with `modelsDevProvider`
- `cacheRetention`: `none`, `short`, or `long`; request-time options win over model/modelOverride values, then provider values, then `GJC_CACHE_RETENTION`, then the runtime default. The runtime default is `short` for most providers, but the Anthropic provider defaults to `long` because the ~5m cache is fragile for long-running subagent workflows. Canonical Anthropic models use top-level automatic caching and emit `ttl: "1h"` when long retention is supported. Claude-family models on non-canonical Anthropic-compatible endpoints default to explicit block markers because compatible proxies commonly inject, rewrite, or reject top-level cache controls; they omit `ttl` unless `compat.supportsLongCacheRetention: true` opts the endpoint into 1-hour retention. For OpenAI Responses, this controls `prompt_cache_retention` only; it does not disable `prompt_cache_key` when a stable session id exists.

## OpenAI-compatible proxy configuration

OpenAI-compatible proxy providers should use schema-supported provider keys first:
The first-class way to add a proxy provider is `gjc setup provider --preset litellm --base-url <url>` (LiteLLM) or `gjc setup provider --preset openai-compatible-proxy --base-url <url>` (any OpenAI-compatible gateway); both presets require `--base-url` and configure live model discovery. Proxy providers can also be used to route built-in model-preset selectors — see [Routing built-in presets through a proxy](#routing-built-in-presets-through-a-proxy-modelprofileproxyprovider). The YAML below shows the equivalent hand-written provider config:

```yaml
providers:
  proxy-provider:
    baseUrl: https://api.proxy.example/v1
    apiKeyEnv: PROXY_API_KEY
    api: openai-completions
    auth: apiKey
    headers:
      User-Agent: curl/8.7.1
    models:
      - id: local-gpt
        name: Local GPT
        reasoning: true
        thinking:
          minLevel: low
          maxLevel: high
          mode: effort
        compat:
          supportsReasoningEffort: true
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 400000
        maxTokens: 128000
```

Use provider-level `headers` for proxy-required headers. Keep the provider `api` set to `openai-completions` when the proxy exposes Chat Completions-compatible `/v1/chat/completions` semantics. `auth: apiKey` sends the resolved token as bearer auth; use `auth: none` only for trusted local/no-auth endpoints.

For an unknown custom endpoint, `reasoning: true` declares model capability but does not prove the proxy accepts a control parameter. A familiar provider id or model-family name is not transport evidence: configurable LiteLLM/vLLM/local endpoints still fail closed. Add `thinking` and `compat.supportsReasoningEffort: true` only when the endpoint documents OpenAI-style `reasoning_effort`; set `compat.thinkingFormat` as well when it uses a different documented request shape. Otherwise GJC keeps reasoning-level controls unavailable and omits the parameter.

`auth` selects the transport scheme only; it never supplies a credential. A provider that declares `models:` must therefore also declare where its key comes from, and `models.yml` validation rejects the config before model discovery otherwise:

| Intent | Required keys |
| --- | --- |
| Authenticated proxy (recommended) | `auth: apiKey` (default) + `apiKeyEnv: MY_TOKEN` |
| Authenticated proxy, key inline | `auth: apiKey` (default) + `apiKey: sk-…` (less safe; stored in plaintext) |
| Genuinely unauthenticated endpoint | `auth: none`, no key |

Omitting both `apiKey` and `apiKeyEnv` while leaving `auth` at its `apiKey` default fails with `Provider <name>: custom models need a credential source, but none is configured.` — the fix is to add one of the rows above, not to change `api` or `baseUrl`.

`input` is the model modality list GJC uses to decide whether image content is forwarded. When a custom model omits `input`, GJC defaults to `[text]` (unless a bundled model with the same id contributes a reference). Vision-capable upstream models therefore need an explicit `input: [text, image]`; otherwise `read`/tool images are stripped before the request and replaced with `[image omitted: model does not support vision]`, even if the remote model can see images.

```yaml
providers:
  ali:
    baseUrl: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
    apiKeyEnv: ALI_API_KEY
    api: openai-completions
    auth: apiKey
    models:
      # id-only → text-only; images will be omitted
      - id: some-text-model
      # vision-capable hosted model must declare image input
      - id: qwen3.8-max-preview
        name: Qwen3.8 Max Preview
        reasoning: true
        input: [text, image]
```

`requestTransform` and `wireModelId` remain supported for request-body shaping, but they are not needed for ordinary OpenAI-compatible proxies whose local model id is already the upstream wire id. Unknown config keys fail validation before a provider request is sent.

When request shaping is needed:

- `requestTransform.profile: openai-proxy` strips OpenAI SDK/Stainless telemetry and beta headers at final fetch time and sets a generic GJC user agent.
- `stripHeaders` replaces the preset strip list when provided.
- `setHeaders` is applied after stripping; use `null` to remove a header.
- `extraBody` is shallow-merged into the JSON request body after provider compatibility fields; core transport keys such as `model`, `messages`/`input`, `stream`, `tools`, and `tool_choice` are protected and ignored.
- Model-level `requestTransform` overrides provider-level fields and shallow-merges `setHeaders`/`extraBody`.
- `wireModelId` changes only the upstream request body model id; local selection still uses `provider/id`.

### Layofflabs-style proxy example

```yaml
providers:
  layofflabs:
    baseUrl: https://api.layofflabs.com/v1
    apiKeyEnv: OPENAI_API_KEY
    api: openai-completions
    auth: apiKey
    headers:
      User-Agent: curl/8.7.1
    models:
      - id: gpt-5.5
        name: GPT 5.5 via Layofflabs
        reasoning: true
        thinking:
          minLevel: low
          maxLevel: xhigh
          mode: effort
          defaultLevel: high
          levels: [low, medium, high, xhigh]
        compat:
          supportsReasoningEffort: true
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 400000
        maxTokens: 128000

modelBindings:
  modelRoles:
    default: layofflabs/gpt-5.5:high
  agentModelOverrides:
    executor: layofflabs/gpt-5.5:high
```

## Validation rules (current)

### Full custom provider (`models` is non-empty)

Required:

- `baseUrl`
- A credential source: `apiKeyEnv` or `apiKey`. `auth` selects the scheme, not the credential, so `auth: apiKey` (the default) still needs one of them. Exempt: `auth: none`, and `api: bedrock-converse-stream`, which resolves AWS credentials from its own chain.
- `api` at provider level or each model

### Override-only provider (`models` missing or empty)

Must define at least one of:

- `baseUrl`
- `headers`
- `compat`
- `requestTransform`
- `disableStrictTools`
- `modelOverrides`
- `discovery`

### Discovery

- `discovery` requires provider-level `api`.

### Model value checks

- `id` required
- `contextWindow` and `maxTokens` must be positive if provided
- unknown provider, model, override, and request-transform keys fail schema validation; remove stale keys instead of relying on them being ignored.

`maxTokens` on an explicit `models.yml` model (or `modelOverrides` entry) is the
authoritative default output budget for that configured model. A positive
per-request `maxTokens` option still wins. Built-in catalog values and runtime
discovery metadata retain the transport's conservative 32,000-token default
unless the caller supplies a positive request override; their displayed
`maxTokens`/`max-out` value is model metadata, not an unconditional request
promise. A request value of `0` is treated as unspecified and does not bypass
the safe default. Provider hard limits and reasoning-budget rules remain
enforced by the selected transport.
Valid budget values — configured or per-request — are positive safe integers
(1 … 9007199254740991). Fractional values and anything above
`Number.MAX_SAFE_INTEGER` fail schema validation in `models.yml`/overrides and
are treated as unspecified when passed programmatically, so integer-only
provider fields (`max_tokens`, `max_completion_tokens`, `max_output_tokens`)
never receive an unsatisfiable budget. The low-level `stream()`/`complete()`
boundary applies the same rule to provider options.

## Merge and override order

ModelRegistry pipeline (on refresh):

1. Load built-in providers/models from `@gajae-code/ai`.
2. Load `models.yml` custom config.
3. Apply provider overrides (`baseUrl`, `headers`, `requestTransform`, `disableStrictTools`, `cacheRetention`) to built-in models.
4. Apply `modelOverrides` (per provider + model id).
5. Merge custom `models`:
   - same `provider + id` replaces existing
   - otherwise append
6. Load cached/runtime-discovered models (Ollama, llama.cpp, LM Studio, plus built-in provider managers), then re-apply model overrides.

### Provider-model cache and static fingerprint

Cached per-provider model lists are persisted in the model-cache SQLite
database (schema v3) with a `static_fingerprint` column that hashes the
static catalog slice merged into the row. When `resolveProviderModels`
skips the network fetch and the fingerprint of the in-memory static
catalog matches the cached one, the cached rows are returned verbatim —
the static + dynamic merge is bypassed entirely. The fingerprint is
memoized per process via a WeakMap keyed by the static-models array
reference, so repeated cold-start calls do not re-hash.

## Canonical model equivalence and coalescing

The registry keeps every concrete provider model and then builds a canonical layer above them.

Canonical ids are official upstream ids only, for example:

- `anthropic-model-opus-4-6`
- `anthropic-model-haiku-4-5`
- `gpt-5.3-openai-code`

### `models.yml` equivalence config

Example:

```yaml
providers:
  zenmux:
    baseUrl: https://api.zenmux.example/v1
    apiKey: ZENMUX_API_KEY
    api: openai-codex-responses
    models:
      - id: openai-code
        name: Zenmux OpenAI code
        reasoning: true
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 200000
        maxTokens: 32768

equivalence:
  overrides:
    zenmux/openai-code: gpt-5.3-openai-code
    p-openai-code/openai-code: gpt-5.3-openai-code
  exclude:
    - demo/openai-code-preview
```

Build order for canonical grouping:

1. exact user override from `equivalence.overrides`
2. bundled official-id matches from built-in model metadata
3. conservative heuristic normalization for gateway/provider variants
4. fallback to the concrete model's own id

Current heuristics are intentionally narrow:

- embedded upstream prefixes can be stripped when present, for example `anthropic/...` or `openai/...`
- dotted and dashed version variants can normalize only when they map to an existing official id, for example `4.6 -> 4-6`
- ambiguous families or versions are not merged without a bundled match or explicit override

### Canonical and preset-equivalent resolution behavior

When multiple concrete variants are eligible for automatic resolution, the global provider policy uses this order:

1. explicit `config.yml` `modelProviderOrder` entries, in their saved order
2. omitted providers whose effective credential came from OAuth
3. omitted providers using a manual API key, unknown credential provenance, or keyless access
4. vision capability, exact canonical identity, canonical source quality, lowest `cost.input + cost.cacheRead`, stable registry model order, then concrete selector order

The explicit provider list may be partial. A listed API-key provider beats every omitted OAuth provider. Resetting Provider Priority clears the explicit list and restores OAuth-first plus deterministic fallback. Saved providers that are not currently available remain visible and persisted, but runtime resolution skips them.

Model-profile and preset assignments support a lookup-only alias when the assignment does not explicitly name a provider. For example, a bare preset assignment `gpt-5` can select any available concrete variant whose final model-id segment is `gpt-5`, ranked by the same global policy. An assignment such as `openai/gpt-5` is an explicit provider pin: if that exact model is unavailable, activation reports it unavailable instead of switching providers. Alias lookup never rewrites the selected model's concrete provider, full model id, or `wireModelId`; a known bare alias with no eligible variant is unavailable and does not fall through to a different fuzzy match. Direct model selection remains unchanged.
Runtime custom providers participate in the same lookup automatically. A custom provider model such as `hosted/glm-5.2` contributes the alias `glm-5.2` when the provider is registered, authenticated, and available; Provider Priority can rank that custom provider ahead of bundled providers without changing the preset. Custom IDs whose final segment differs (for example `glm-5.2-special`) do not join the alias.

A session that resolves a canonical or alias selector keeps its concrete variant across provider-priority edits and discovery refreshes. Updated priority applies to new or unpinned resolutions. The session re-ranks only after explicit reselection or when the sticky variant becomes unavailable. Session state and transcripts continue to record the concrete provider/model that executed the turn.

Provider defaults vs per-model overrides:

- Provider `headers` are baseline.
- Model `headers` override provider header keys.
- `modelOverrides` can override model metadata (`name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`, `headers`, `compat`, `contextPromotionTarget`).
- `compat` is deep-merged for nested routing blocks (`openRouterRouting`, `vercelGatewayRouting`, `extraBody`).

## Runtime discovery integration

### Implicit Ollama discovery

If `ollama` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `ollama`
- api: `openai-responses`
- base URL: `OLLAMA_BASE_URL` or `http://127.0.0.1:11434`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery calls Ollama endpoints and normalizes discovered OpenAI-compatible models to `openai-responses`.

### Implicit llama.cpp discovery

If `llama.cpp` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `llama.cpp`
- api: `openai-responses`
- base URL: `LLAMA_CPP_BASE_URL` or `http://127.0.0.1:8080`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery calls llama.cpp model endpoints and synthesizes model entries with local defaults.

### Implicit LM Studio discovery

If `lm-studio` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `lm-studio`
- api: `openai-completions`
- base URL: `LM_STUDIO_BASE_URL` or `http://127.0.0.1:1234/v1`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery fetches models (`GET /models`) and synthesizes model entries with local defaults.

### Implicit oMLX discovery

If `omlx` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `omlx`
- api: `openai-completions`
- base URL: `OMLX_BASE_URL` or `http://127.0.0.1:8080/v1`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery fetches models (`GET /v1/models`) and synthesizes model entries with local defaults and `max_model_len` support.

### Implicit vLLM discovery

If `vllm` is not explicitly configured, its bundled provider descriptor discovers the local server implicitly:

- provider: `vllm`
- api: `openai-completions`
- base URL: trusted `VLLM_BASE_URL` or `http://127.0.0.1:8000/v1` (a project `.env` cannot redirect authenticated traffic)
- auth mode: keyless (`auth: none` behavior), `VLLM_API_KEY` attaches when present

Runtime discovery fetches models (`GET /v1/models`) and synthesizes model entries with local defaults and `max_model_len` support. Credentialless implicit discovery is limited to loopback. For a remote vLLM server (for example, a LAN GPU box), set `VLLM_BASE_URL` and `VLLM_API_KEY` in the launching shell or a user-owned GJC environment file, or configure it explicitly under `providers` as shown below.

### Implicit SGLang discovery

If `sglang` is not explicitly configured, its bundled provider descriptor discovers the local server implicitly:

- provider: `sglang`
- api: `openai-completions`
- base URL: trusted `SGLANG_BASE_URL` or `http://127.0.0.1:30000/v1` (a project `.env` cannot redirect authenticated traffic)
- auth mode: keyless (`auth: none` behavior), `SGLANG_API_KEY` attaches when present

Runtime discovery fetches models (`GET /v1/models`) and synthesizes model entries with local defaults and `max_model_len` support. Credentialless implicit discovery is limited to loopback and needs no `/login`; `/login sglang` stores only an actual API key. For a remote SGLang server (for example, a LAN GPU box), set `SGLANG_BASE_URL` and `SGLANG_API_KEY` in the launching shell or a user-owned GJC environment file, or configure it explicitly under `providers` as shown below. Standard proxy environment variables remain explicit transport configuration, so include local SGLang hosts in `NO_PROXY` when local traffic must connect directly.

### Explicit provider discovery

You can configure discovery yourself:

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

### Extension provider registration

Extensions can register providers at runtime (`pi.registerProvider(...)`), including:

- model replacement/append for a provider
- custom stream handler registration for new API IDs
- custom OAuth provider registration

## Auth and API key resolution order

When requesting a key for a provider, effective order is:

1. Runtime override (CLI `--api-key`)
2. `models.yml` `providers.<name>.apiKey` literal pin
3. Stored API key credential in `agent.db` (written by `auth login`)
4. `models.yml` `providers.<name>.apiKeyEnv` indirection — a pointer to a key,
   not a pinned value, so a stored login credential outranks it; it still
   outranks stored OAuth credentials
5. Stored OAuth credential in `agent.db` (with refresh)
6. Environment variable mapping (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
7. ModelRegistry fallback resolver (provider `apiKey` from `models.yml`, env-name-or-literal semantics)

`models.yml` `apiKey` behavior:

- Value is first treated as an environment variable name.
- If no env var exists, the literal string is used as the token.

If `authHeader: true` and provider `apiKey` is set, models get:

- `Authorization: Bearer <resolved-key>` header injected.

Keyless providers:

- Providers marked `auth: none` are treated as available without credentials.
- `getApiKey*` returns `kNoAuth` for them.

### Broker mode

When `GJC_AUTH_BROKER_URL` (or `auth.broker.url`) is set, the local SQLite credential store is replaced by `RemoteAuthCredentialStore`. Layers 2 and 3 above (stored API key / OAuth in `agent.db`) are served from a broker-supplied snapshot whose `refresh` tokens are redacted; expiry triggers `POST /v1/credential/:id/refresh` on the broker rather than a local refresh.

`AuthStorage.setConfigApiKey` lets a `models.yml` `apiKey` win over a broker-resolved OAuth token without overriding a runtime `--api-key`. See [`auth-broker-gateway.md`](./auth-broker-gateway.md) for the full broker / gateway design and env surface (`GJC_AUTH_BROKER_URL`, `GJC_AUTH_BROKER_TOKEN`, `auth.broker.url`, `auth.broker.token`).

## Model availability vs all models

- `getAll()` returns the loaded model registry (built-in + merged custom + discovered).
- `getAvailable()` filters to models that are keyless or have resolvable auth.

So a model can exist in registry but not be selectable until auth is available.

## Runtime model resolution

### CLI and pattern parsing

`model-resolver.ts` supports:

- exact `provider/modelId`
- exact canonical model id
- exact model id (provider inferred)
- fuzzy/substring matching
- glob scope patterns in `--models` (e.g. `openai/*`, `*sonnet*`)
- optional `:thinkingLevel` suffix (`off|minimal|low|medium|high|xhigh`)

`--provider` is legacy; `--model` is preferred.

Resolution precedence for exact selectors:

1. exact `provider/modelId` bypasses coalescing
2. exact canonical id resolves through the canonical index
3. exact bare concrete id still works
4. fuzzy and glob matching run after the exact paths

Thinking suffixes are split once from the final `:` only after the complete selector does not resolve. This preserves concrete OpenRouter route IDs such as `openrouter/z-ai/glm-4.7:nitro`; `:high` can follow that route suffix. Multiple suffixes are not recursively consumed. A complete `provider/modelId` selector is exact-only: it never falls back to fuzzy, substring, glob, or another provider when that concrete selector is absent. Exact-case provider/model entries resolve deterministically for custom replacement semantics; a case-insensitive selector that remains ambiguous does not guess.

Preset/profile activation may use an unqualified assignment as a final-segment lookup alias after exact resolution fails. Provider-qualified assignments remain exact pins, and this opt-in does not apply to CLI or direct concrete model selection.

### Initial model selection priority

`findInitialModel(...)` uses this order:

1. explicit CLI provider+model
2. first scoped model (if not resuming)
3. saved default provider/model
4. known provider defaults (e.g. OpenAI/Anthropic/etc.) among available models
5. first available model

### Role aliases and settings

Supported model roles:

- `default` plus the agent assignment targets `executor`, `architect`, `planner`, `critic`

Role aliases like `pi/default` expand through `settings.modelRoles`. Each role value can also append a thinking selector such as `:minimal`, `:low`, `:medium`, or `:high`.

If a role points at another role, the target model still inherits normally and any explicit suffix on the referring role wins for that role-specific use.

Related settings:

- `modelRoles` (record)
- `enabledModels` (scoped pattern list)
- `modelProviderOrder` (global automatic provider precedence; editable under Settings → Providers with add/remove, move up/down, unavailable-entry retention, and Reset)
- `providers.kimiApiFormat` (`openai` or `anthropic` request format)
- `providers.openaiWebsockets` (`auto|off|on` websocket preference for OpenAI code provider transport)

`modelRoles` may store either:

- `provider/modelId` to pin a concrete provider variant
- a canonical id such as `gpt-5.3-openai-code` to allow provider coalescing

For `enabledModels` and CLI `--models`:

- exact canonical ids expand to all concrete variants in that canonical group
- explicit `provider/modelId` entries stay exact
- globs and fuzzy matches still operate on concrete models

Global `enabledModels` and `disabledProviders` entries may also be scoped to a path prefix:

```yaml
enabledModels:
  - anthropic-model-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/anthropic-model-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

String entries apply everywhere. Scoped entries apply when the current working directory is the configured path or one of its subdirectories. Use `path`, `paths`, `pathPrefix`, or `pathPrefixes`; use `models` for `enabledModels`, `providers` for `disabledProviders`, or `values` for either.

## `/model` and `--list-models`

Both surfaces keep provider-prefixed models visible and selectable.

They now also expose canonical/coalesced models:

- `/model` includes a canonical view alongside provider tabs
- `--list-models` prints a canonical section plus the concrete provider rows

Selecting a canonical entry stores the canonical selector. Selecting a provider row stores the explicit `provider/modelId`.

## Context promotion (model-level fallback chains)

Context promotion is an overflow recovery mechanism for small-context variants (for example `*-spark`) that automatically promotes to a larger-context sibling when the API rejects a request with a context length error. It is **off by default** (`contextPromotion.enabled` is `false`); opt in to enable it.

### Trigger and order

When a turn fails with a context overflow error (e.g. `context_length_exceeded`), `AgentSession` attempts promotion **before** falling back to compaction:

1. If `contextPromotion.enabled` is true, resolve a promotion target (see below).
2. If a target is found, switch to it and retry the request — no compaction needed.
3. If no target is available, fall through to auto-compaction on the current model.

### Target selection

Selection is model-driven, not role-driven:

1. `currentModel.contextPromotionTarget` (if configured)
2. smallest larger-context model on the same provider + API

Candidates are ignored unless credentials resolve (`ModelRegistry.getApiKey(...)`).

### OpenAI code provider websocket handoff

If switching from/to `openai-codex-responses`, session provider state key `openai-codex-responses` is closed before model switch. This drops websocket transport state so the next turn starts clean on the promoted model.

### Persistence behavior

Promotion uses temporary switching (`setModelTemporary`):

- recorded as a temporary `model_change` in session history
- does not rewrite saved role mapping

### Configuring explicit fallback chains

Configure fallback directly in model metadata via `contextPromotionTarget`.

`contextPromotionTarget` accepts either:

- `provider/model-id` (explicit)
- `model-id` (resolved within current provider)

Example (`models.yml`) for Spark -> non-Spark on the same provider:

```yaml
providers:
  openai-code:
    modelOverrides:
      gpt-5.3-openai-code-spark:
        contextPromotionTarget: openai-code/gpt-5.3-openai-code
```

The built-in model generator also assigns this automatically for `*-spark` models when a same-provider base model exists.

## Compatibility and routing fields

The `compat` block on a provider or model overrides the URL-based auto-detection in `packages/ai/src/providers/openai-completions-compat.ts`. It is validated by `OpenAICompatSchema` in `packages/coding-agent/src/config/model-registry.ts` and consumed by every `openai-completions` transport (`packages/ai/src/providers/openai-completions.ts`). The canonical type is `OpenAICompat` in `packages/ai/src/types.ts`.

`models.yml` accepts the following keys (all optional; unset falls back to URL detection):

Request shaping:

- `supportsStore` — emit `store: false` on requests. Default: auto (off for non-standard endpoints).
- `supportsDeveloperRole` — use the `developer` system role for reasoning models instead of `system`. Default: auto.
- `sendSessionHeaders` — forward the agent session id as `session_id` and `x-session-id` request headers so OpenAI-compatible relays/proxies can do session-affinity routing and reuse a server-side prompt cache. Default: `false`. Caller-set `headers`/`requestTransform` values are never overwritten.
- `supportsResponsesSessionAffinity` — for `openai-responses`, opt in to forwarding `session_id` and `x-client-request-id` affinity headers to a custom OpenAI-compatible relay. Canonical OpenAI routing remains automatic; known non-OpenAI provider IDs are rejected. Default: `false`.
- `supportsUsageInStreaming` — send `stream_options: { include_usage: true }` to receive token usage on streaming responses. Default: `true`.
- `maxTokensField` — `"max_completion_tokens"` or `"max_tokens"`. Default: auto.
- `supportsToolChoice` — emit the `tool_choice` parameter when the caller forces a specific tool. Default: `true`. Set `false` for endpoints that 400 on `tool_choice` (e.g. DeepSeek when reasoning is on).
- `disableReasoningOnForcedToolChoice` — drop `reasoning_effort` / OpenRouter `reasoning` whenever `tool_choice` forces a call. Default: auto (Kimi/Anthropic-fronted endpoints).
- `extraBody` — extra top-level fields merged into every request body (gateway hints, controller selectors, etc.).

Reasoning / thinking:

- `supportsReasoningEffort` — accept OpenAI-style `reasoning_effort`. Default: auto for bundled/audited providers and recognized first-party endpoints; `false` for unknown custom endpoints. Set `true` only from provider documentation or probe evidence, and pair it with explicit `reasoning: true` plus `thinking` metadata.
- `reasoningEffortMap` — partial map from internal effort levels (`minimal|low|medium|high|xhigh`) to provider-specific strings (e.g. DeepSeek maps `xhigh -> "max"`).
- `thinkingFormat` — request shape for thinking: `"openai"` (`reasoning_effort`), `"openrouter"` (`reasoning: { effort }`), `"zai"` (`thinking: { type: "enabled" }`), `"qwen"` (top-level `enable_thinking`), or `"qwen-chat-template"` (`chat_template_kwargs.enable_thinking`). Default: `"openai"`.
- `reasoningContentField` — assistant field carrying chain-of-thought: `"reasoning_content"`, `"reasoning"`, or `"reasoning_text"`. Default: auto.
- `requiresReasoningContentForToolCalls` — assistant tool-call turns must round-trip the reasoning field (DeepSeek-R1, Kimi, OpenRouter when reasoning is on). Default: `false`.
- `requiresAssistantContentForToolCalls` — assistant tool-call turns must include non-empty text content (Kimi). Default: `false`.

Tool / message normalization:

- `requiresToolResultName` — tool-result messages need a `name` field (Mistral). Default: auto.
- `requiresAssistantAfterToolResult` — a user message after a tool result needs an assistant turn in between. Default: auto.
- `requiresThinkingAsText` — convert thinking blocks to text wrapped in `<thinking>` delimiters (Mistral). Default: auto.
- `requiresMistralToolIds` — normalize tool-call ids to exactly 9 alphanumeric chars. Default: auto.
- `supportsStrictMode` — accept the per-tool `strict` field on tool schemas. Default: conservative auto-detect per provider/baseUrl.
- `toolStrictMode` — `"all_strict"` forces strict on every tool, `"none"` forces it off; unset keeps the existing per-tool mixed behavior.

Gateway routing (only applied when `baseUrl` matches the gateway):

- `openRouterRouting.only` / `openRouterRouting.order` — provider routing on `openrouter.ai` (see <https://openrouter.ai/docs/provider-routing>).
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — provider routing on `ai-gateway.vercel.sh` (see <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>).

Provider-level `compat` is the baseline; per-model `compat` is deep-merged on top, with `openRouterRouting`, `vercelGatewayRouting`, and `extraBody` merged as nested objects.

### Anthropic compatibility (`anthropic-messages`)

For `anthropic-messages` models, `compat.promptCacheMode` and `compat.supportsLongCacheRetention` are configurable at provider, model, and `modelOverrides` levels. Provider-level `compat` is the baseline; model and override values merge on top.

Prompt-cache modes:

- `automatic` — emit one top-level `cache_control` marker and let the Anthropic-compatible endpoint advance the breakpoint as the conversation grows.
- `explicit` — emit block-level breakpoints instead. Use this for endpoints that reject top-level `cache_control` but support Anthropic's explicit content-block markers.
- `none` — emit no generated Anthropic cache controls. Per-request or configured `cacheRetention: none` also disables generated caching.

Without an explicit mode, canonical Anthropic endpoints default to `automatic`, Claude-family model ids on non-canonical compatible endpoints default to `explicit`, and unknown non-Claude compatible endpoints default to `none`. Non-canonical endpoints get the default ~5m lifetime unless they opt into `supportsLongCacheRetention: true`. Set `promptCacheMode: automatic` only when a gateway is known to pass through Anthropic's top-level cache control without adding conflicting block markers.

If a gateway attaches enough cache markers of its own that ours push the request past Anthropic's four-breakpoint limit, Anthropic rejects it with `A maximum of 4 blocks with cache_control may be provided.` Those extra markers are not visible in the request GJC builds, so the limit is handled at runtime rather than predicted. Because the rejection means "too many" rather than "none allowed", recovery reduces the generated breakpoints one step at a time: `explicit` mode normally emits two markers (a conversation-prefix anchor and a current-turn refresh point), so the first retry keeps only the prefix anchor, and generated caching is disabled entirely only if that is rejected too. The reduced setting persists for the rest of the provider session, so an endpoint with one free slot keeps caching its conversation prefix instead of losing caching altogether. Set `promptCacheMode: none` on a gateway that never has a free slot to skip the wasted attempts.

```yaml
providers:
  corp-anthropic:
    baseUrl: https://proxy.example.com/anthropic
    apiKeyEnv: CORP_ANTHROPIC_API_KEY
    api: anthropic-messages
    compat:
      promptCacheMode: explicit
      supportsLongCacheRetention: false
    models:
      - id: claude-sonnet-4-5
        contextWindow: 200000
        maxTokens: 8192
```

Other Anthropic-side compatibility knobs such as `disableAdaptiveThinking` and `supportsEagerToolInputStreaming` remain built-in catalog metadata rather than `models.yml` fields. `disableStrictTools` stays a provider-level setting (below).

### Strict tool schemas (`disableStrictTools`)

Anthropic's API supports a `strict` field on tool definitions that forces the model to always follow the provided schema exactly. This is enabled by default for all `anthropic-messages` providers because it guarantees schema conformance in agentic systems.

Third-party providers that front the Anthropic API (AWS Bedrock, Azure, self-hosted proxies) do not always implement this field and will reject requests that include it. Set `disableStrictTools: true` at the provider level to opt out:

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: anthropic-model-sonnet-4-20250514
        name: Anthropic model Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools` is a provider-level flag that applies to all models in the provider.

Tool schemas going on the wire are normalized by the unified flow in
`packages/ai/src/utils/schema/normalize.ts` (Google/CCA/MCP dispatchers
plus the OpenAI strict-mode sanitize+enforce pipeline). See
[`ai-schema-normalize.md`](./ai-schema-normalize.md) for the strict-mode
edge cases (local `$ref` inlining, single-item `allOf` collapse,
`anyOf`-wrapper description hoist, enum/const primitive-type inference)
and the per-provider dispatcher mapping.
## Practical examples

### Local OpenAI-compatible endpoint (no auth)

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

### Hosted proxy with env-based key

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true  # if the proxy doesn't support strict tool schemas
    models:
      - id: anthropic-model-sonnet-4-20250514
        name: Anthropic model Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

### Override built-in provider route + model metadata

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/anthropic-model-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

## Legacy consumer caveat

Most model configuration now flows through `models.yml` via `ModelRegistry`. Explicit `.json` / `.jsonc` paths remain supported only when passed programmatically to `ModelRegistry`; the default user config is `~/.gjc/agent/models.yml`.

## Failure mode

If `models.yml` fails schema or validation checks:

- registry keeps operating with built-in models
- error is exposed via `ModelRegistry.getError()` and surfaced in UI/notifications
