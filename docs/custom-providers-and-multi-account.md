# Custom providers and multi-account routing

Practical setup recipes for two power-user needs:

1. **Custom providers** — point GJC at any OpenAI/Anthropic-compatible endpoint, proxy, or local runtime through `~/.gjc/agent/models.yml`.
2. **Multi-account routing** — keep several OAuth accounts for the same provider (e.g. two Claude Max seats) and control which one each session drains.

Authoritative field-by-field reference: [`models.md`](./models.md). This page is the setup-oriented companion.

## Custom providers (`~/.gjc/agent/models.yml`)

### Local OpenAI-compatible endpoint (no auth)

```yaml
providers:
  my-local:
    name: My Local Runtime
    baseUrl: http://127.0.0.1:8000/v1
    api: openai-completions
    auth: none
    models:
      my-model:
        name: My Model
        contextWindow: 128000
        maxTokens: 32000
```

Ollama, llama.cpp, and LM Studio are discovered implicitly when running — you usually do not need a manual entry for them. For other runtimes, `discovery.type: openai-models-list` auto-populates the model list.

### Hosted proxy with an env-based key

```yaml
providers:
  hosted:
    name: Hosted Proxy
    baseUrl: https://proxy.example.com/v1
    api: openai-completions
    apiKey: MY_PROXY_KEY        # env-name-or-literal semantics
    discovery:
      type: openai-models-list
```

A `models.yml` `apiKey` deliberately beats a stored/broker-resolved OAuth token for the same provider without overriding an explicit `--api-key` — this is how you pin one environment to a specific key.

### Coding-plan provider presets

`gjc setup` ships ready-made presets for coding-plan providers with OpenAI-compatible Provider APIs — for example `commandcode-goat` (Command Code GOAT, `CMD_API_KEY`). Presets render the provider block for you; plan entitlement is enforced by the provider. See [`models.md` → Coding-plan provider presets](./models.md#coding-plan-provider-presets).

### Custom providers join routing automatically

A registered, authenticated custom provider participates in preset/profile alias lookup: `hosted/glm-5.2` contributes the bare alias `glm-5.2`, and Provider Priority can rank the custom provider ahead of bundled ones without editing any preset. Validation is strict — unknown provider/model keys fail before dispatch.

Full field reference (compat flags, `api` values, override-only providers, fallback chains, proxy routing for built-in presets): [`models.md`](./models.md).

## Multi-account routing

### Add more than one account per provider

Run `/login` in a session again for the same provider with a different account (broker setups use `gjc auth-broker login <provider>`). Credentials are deduplicated by identity (account/email), so re-logging the same account replaces its row while a different account adds a new one to the pool. `gjc setup credentials` and startup auto-import can also pull existing Claude Code / Codex CLI credentials from disk (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` are honored).

### Session-start ranking strategy

When a provider has several OAuth credentials, GJC ranks them at session start and picks one. Strategy is opt-in via env:

```sh
# default: prefer the least-drained account (spreads load, keeps burst headroom)
GJC_CREDENTIAL_RANKING_MODE=balanced

# drain the soonest-to-reset account first (good for perishable tumbling-window
# quota like Claude 5h/7d windows)
GJC_CREDENTIAL_RANKING_MODE=earliest-reset
```

Blocked or exhausted accounts always sort last regardless of strategy. Ranking affects session start only; a running session keeps its credential.

### Prefer one account, with automatic fallback

`GJC_CREDENTIAL_RANKING_MODE` only weighs ranking heuristics — it cannot pin one specific account ahead of the others by identity. `--prefer-credential <selector>` does: it names one stored OAuth credential (by `id`, `email`, `account`, or `project`) to try first, ahead of the ranking strategy's normal order, while still falling back to the rest of the pool the instant that account hits a quota or rate limit:

```sh
gjc --prefer-credential email:name@example.com
```

Unlike `--credential` (a hard pin that never rotates and fails the session on exhaustion), `--prefer-credential` is soft: it wins the initial pick, and a content-free quota/rate-limit failure switches to another active credential immediately and keeps the fallback sticky for the rest of the session. See [`non-compaction-retry-policy.md` → Preferred credential quota fallback](./non-compaction-retry-policy.md#preferred-credential-quota-fallback) for the full failure-mode contract.

### Provider order across vendors

Which *provider* serves a bare model alias is a separate ladder:

1. explicit `modelProviderOrder` entries in `config.yml` (Provider Priority in Settings), in saved order
2. omitted providers whose credential came from OAuth
3. omitted providers on manual API keys or keyless access
4. deterministic tie-breakers (vision, canonical identity, `cost.input + cost.cacheRead`, registry order)

A listed API-key provider beats every omitted OAuth provider; resetting Provider Priority restores OAuth-first.

### Team-scale pools: auth broker / gateway

To share one credential pool across machines or containers, run `gjc auth-broker serve` as the single refresh owner and point clients at it with `GJC_AUTH_BROKER_URL` / `GJC_AUTH_BROKER_TOKEN`. The gateway (`gjc auth-gateway serve`) additionally hides access tokens from clients entirely. Per-credential health probing surfaces which row in a multi-account pool is producing 401s. See [`auth-broker-gateway.md`](./auth-broker-gateway.md).

## See also

- [`models.md`](./models.md) — full `models.yml` reference, auth resolution order, presets
- [`multi-vendor-profiles.md`](./multi-vendor-profiles.md) — role-based cross-vendor profiles
- [`environment-variables.md`](./environment-variables.md) — `GJC_CREDENTIAL_RANKING_MODE`, broker vars, credential import roots
