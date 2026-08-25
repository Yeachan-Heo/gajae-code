# Custom providers and multi-account routing

Practical setup recipes for two power-user needs:

1. **Custom providers** — point GJC at any OpenAI/Anthropic-compatible endpoint, proxy, or local runtime through `~/.gjc/agent/models.yml`.
2. **Multi-account routing** — keep several OAuth accounts for the same provider (for example, two Claude Max seats) and control which one a session drains.

The canonical runtime behavior is described here; the field-by-field model reference remains [`models.md`](./models.md).

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

Ollama, llama.cpp, LM Studio, oMLX, vLLM, and SGLang are discovered implicitly when running — you usually do not need a manual entry for them. For other runtimes, `discovery.type: openai-models-list` auto-populates the model list.

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

A `models.yml` `apiKey` is a config API-key override: it beats a stored or broker-resolved OAuth token for that provider, but does not override an explicit runtime `--api-key`. This is useful when one environment must use a particular proxy key.

### Coding-plan provider presets

`gjc setup` ships ready-made presets for coding-plan providers with OpenAI-compatible APIs — for example `commandcode-goat` (Command Code GOAT, `CMD_API_KEY`). Presets render the provider block for you; plan entitlement is enforced by the provider. See [`models.md` → Coding-plan provider presets](./models.md#coding-plan-provider-presets).

### Custom providers join routing automatically

A registered, authenticated custom provider participates in preset/profile alias lookup: `hosted/glm-5.2` contributes the bare alias `glm-5.2`, and Provider Priority can rank the custom provider ahead of bundled ones without editing any preset. Validation is strict — unknown provider/model keys fail before dispatch.

Full field reference (compat flags, `api` values, override-only providers, fallback chains, and proxy routing for built-in presets): [`models.md`](./models.md).

## Multi-account UX

GJC treats stored OAuth credentials as an account pool. API-key sources can be visible in the same inventory, but the account-pinning and selective-removal UX is OAuth-only.

### `/login`: provider picker, account picker, and session scope

- Bare `/login` opens the OAuth provider picker. `/login <provider>` targets one provider directly.
- When the targeted provider already has OAuth rows, the account picker shows the existing identities plus **AUTO (ranked)** and **Add new account**. Selecting an existing identity pins that account for the current credential session only. **AUTO** masks session/global selectors for that session and returns to normal automatic selection.
- **Add new account** runs the normal OAuth flow and upserts the resulting credential. Re-logging a stable OAuth identity updates its existing row; a different identity adds another row. It does not create a persistent pin.
- A session selection is recorded with the session's credential scope, so it does not silently change another live session. Use `gjc accounts pin ... --persistent` when the intent is global for future sessions.
- With a direct broker configured, the same OAuth login path uses the broker's remote write hooks; the refresh token remains on the broker. `gjc auth-broker login <provider>` is the broker-host CLI flow when the operator is working on the broker host instead.

### `/logout`: selective local removal

`/logout` opens the OAuth provider picker. For a provider with local OAuth rows, its account picker can remove one selected account or **Remove all accounts**. Removal is local, atomic, and limited to OAuth rows; an inventory race leaves every row intact and asks you to retry.

A direct-broker client has no local hard-removal targets for individual rows, so `/logout` cannot selectively remove a broker row. Use `gjc auth-broker logout <provider>` on the broker host for provider-wide removal. The separate `gjc accounts logout` command is explicitly local-only and refuses to run when broker mode is configured.

### `/usage`: cache-only by default, explicit checks on demand

| Surface | Network behavior | What it presents |
| --- | --- | --- |
| `/usage` | Cache-only. It does not fetch usage or probe credentials. | Per-account rows from the current inventory, cached health, and cached usage (which can be fresh, stale-last-good, or unavailable), followed by session token statistics. |
| `/usage check` | Explicit sequential checks, one credential/source at a time. | Fresh per-row `ok`, `failed`, or `unknown/unverifiable` status and any safe usage report returned by the probe. |

The explicit checker probes active stored rows sequentially, then checks synthetic runtime/config/environment API-key sources sequentially. OAuth checks refresh an expired credential before probing when possible. Plain `/usage` never turns a presentation refresh into a provider request.

### `gjc accounts` command grammar

The command is intentionally payload-free and has four actions:

```text
gjc accounts list [--json]
gjc accounts check [<provider>] [--json]
gjc accounts pin <provider> <selector> --persistent [--json]
gjc accounts pin <provider> --clear --persistent [--json]
gjc accounts logout <provider> --account <id|email> [--json]
gjc accounts logout <provider> --all [--json]
```

Examples from the command help:

```sh
gjc accounts list
gjc accounts list --json
gjc accounts check
gjc accounts check anthropic --json
gjc accounts pin anthropic me@example.com --persistent
gjc accounts pin anthropic id:42 --persistent
gjc accounts pin anthropic --clear --persistent
gjc accounts logout anthropic --account me@example.com
gjc accounts logout anthropic --all
```

- `list` shows stored OAuth rows and configured API-key sources, with safe identity/source/health/usage-freshness fields. It does not probe.
- `check` performs the explicit sequential checker. `--json` emits safe machine-readable rows; a failed probe sets a non-zero exit status.
- `pin` requires `--persistent`. `<selector>` is a bare email, `id:<positive-row-id>`, `email:<email>`, or `account:<account-id>`. The command validates an active OAuth row and writes the canonical `id:<row-id>` selector to global configuration. `--clear` removes the provider's persistent pin.
- `logout` requires exactly one of `--account <id|email>` or `--all`; it removes only OAuth rows from the local store. It never removes API-key source rows, and it refuses to mutate a broker-backed store.

API-key rows remain visible and checkable so operators can see which source is selected, but they are not part of OAuth account pooling, cannot be pinned by `gjc accounts pin`, and cannot be removed by `gjc accounts logout`.

### `gjc accounts --json` output and failure contract

With `--json`, `gjc accounts` writes exactly one JSON document to stdout. A successful action uses an `{ "ok": true, ... }` envelope. An action-level failure uses `{ "ok": false, "error": { "code": "...", "message": "..." } }`, sets a nonzero exit status, and never writes a second stdout document. Diagnostics written to stderr are sanitized and bounded; they must not contain credential payloads, stacks, or unredacted provider responses. A completed `check` may still use an `ok: true` envelope with per-account failed/unknown check rows; its nonzero status reports those probe results rather than a command-format failure.

## Persistent auth configuration

The canonical configuration is nested YAML in the global `~/.gjc/agent/config.yml` (or the configured agent directory):

```yaml
auth:
  broker:
    url: https://broker.example.test:8765
    token: <literal-bearer-token>
  credentialRankingMode: balanced
  credentialPins:
    anthropic: id:42
    openai-codex: email:me@example.com
  credentialPinStoreIdentity: broker:https://broker.example.test:8765
```

- `auth.broker.url` and `auth.broker.token` select direct-broker mode. `GJC_AUTH_BROKER_URL` and `GJC_AUTH_BROKER_TOKEN` take precedence over the nested values; nested values may be literal strings or trusted `$ENV_NAME` references. Resolution order remains explicit env → nested value (after indirection) → the owner-only `<config-dir>/auth-broker.token` file, so an unresolved nested token does not displace the token-file authority. A configured URL without a resolvable token is a hard error; GJC does not silently fall back to local SQLite. An absent config file leaves broker mode disabled, while malformed or unreadable global startup-auth config fails closed with a typed `StartupAuthConfigError`.
- `auth.credentialRankingMode` is `balanced` (default) or `earliest-reset`. `GJC_CREDENTIAL_RANKING_MODE` takes precedence over the nested setting.
- `auth.credentialPins` is a global-only record of provider → selector. Project-scoped pins are ignored; do not place this record in project settings.
- Numeric `id:<positive-row-id>` pins are bound to the credential-store authority fingerprint (`broker:<normalized-url>` or `local:<absolute-agent-db-path>`). Changing broker URL or local database invalidates those numeric pins instead of retargeting a row with the same number; `email:` and `account:` selectors remain portable.
- `auth.credentialPinStoreIdentity` is managed alongside persistent pins and contains no credential material. Numeric pins are applied only when this value exactly matches the current store authority; missing or mismatched metadata invalidates the numeric pin rather than retargeting a same-number row. Email/account selectors remain portable across store changes.
- Literal dotted root keys such as `auth.broker.url: ...`, `auth.credentialRankingMode: ...`, or `auth.credentialPins: ...` are rejected. Startup reports the keys and prints manual rewrite guidance. Rewrite `config.yml` by hand using the nested shape above; there is no automatic migration, and secret values must not be copied into command output.

### Pin and credential precedence

API-key overrides are outside OAuth pinning:

1. Runtime `--api-key` is highest priority.
2. A `models.yml` provider `apiKey` config override comes next and beats stored/broker OAuth.
3. If no API-key override is active, an explicit session selector wins: `--credential ...` or an account selected in `/login <provider>`.
4. A global `auth.credentialPins` entry seeds that provider's selector when a new session starts. Session **AUTO** masks it for that session.
5. With no selector, OAuth accounts use automatic ranking (`balanced` or `earliest-reset`).

Ranking is performed at session start, or when the session's preferred account is blocked; a running session keeps its selected credential. Blocked/exhausted accounts sort last. Persistent pins and session selectors are valid only for active OAuth credentials. An API-key override (including a configured environment API-key source when creating a pin) makes OAuth pinning unavailable for that provider.

## Local, direct-broker, and gateway capabilities

| Capability | Local SQLite client | Direct-broker GJC client | Auth-gateway service |
| --- | --- | --- | --- |
| Credential writer | Local `agent.db` | Broker host's `agent.db` | Broker host's `agent.db` (gateway is a broker client) |
| OAuth login/add | `/login` picker and **Add new account** write locally | `/login` picker and **Add new account** write through the broker; `gjc auth-broker login` also works on the broker host | No login picker; use `gjc auth-broker login` on the broker host |
| Logout/removal | `/logout` can remove one local OAuth row or all local OAuth rows; `gjc accounts logout` selects by `--account` or `--all` | Selective local removal is unavailable; use provider-wide `gjc auth-broker logout` on the broker host; `gjc accounts logout` refuses in broker mode | No account-removal API; mutate the broker directly |
| Inventory/check | `/usage` and `gjc accounts list` are cache-only; `/usage check` and `gjc accounts check` probe sequentially | Same client presentation/check contract; expired OAuth refreshes route through the broker | One gateway instance owns one explicit provider scope; `gjc auth-gateway check` probes only that provider and `GET /v1/usage` serves scope-filtered cached usage |
| Pin/ranking | Session pins/AUTO plus global `gjc accounts pin --persistent` and ranking mode | Same GJC session/global controls; the broker remains the credential writer | The service has no TUI session scope; broker clients/operators control pins and ranking |
| Secret boundary | Local OAuth refresh/access material stays in the local credential store/process | Broker snapshots replace OAuth refresh tokens with `__remote__`; direct clients can hold access tokens but never the refresh token | Gateway clients never receive provider access tokens; the gateway injects them server-side |

## Broker metadata and cache-only presentation

The broker's payload-free `GET /v1/credentials/metadata` response has a wrapper (`generation`, `generatedAt`, `credentials`) and each `credentials[]` record has **exactly five fields**:

```json
{
  "id": 42,
  "provider": "anthropic",
  "type": "oauth",
  "identity": "me@example.com",
  "disabledCause": null
}
```

There are no token, key, raw credential, identity-object, or extension fields in a metadata record. The metadata endpoint may synchronize broker inventory, but it is not a provider health probe.

`/usage`, `gjc accounts list`, and the account picker render the current inventory plus retained health/usage observations. They do not probe providers merely to render a page. Broker-backed clients may receive a background snapshot/metadata update. An explicit check returns fresh per-row results and retains safe health state; it does not change the cache-only contract of the plain commands.

## Secret and log safety

- Account inventory, `/usage`, `/usage check`, and `gjc accounts --json` intentionally omit credential payloads and raw provider response bodies. Error reasons are bounded and scrub credential-shaped strings.
- OAuth refresh tokens are never sent in broker snapshots; they are replaced by the `__remote__` sentinel. Gateway consumers do not receive access tokens either.
- Keep broker and gateway bearer tokens in their `0600` token files under a `0700` config directory. Do not paste tokens, API keys, authorization headers, callback URLs containing secrets, or unredacted provider errors into issues, transcripts, or logs.

## See also

- [`models.md`](./models.md) — full `models.yml` reference and auth resolution order
- [`auth-broker-gateway.md`](./auth-broker-gateway.md) — broker/gateway endpoints, refresh ownership, and usage cache layers
- [`environment-variables.md`](./environment-variables.md) — broker variables and credential import roots