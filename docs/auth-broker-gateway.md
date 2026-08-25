# Auth Broker and Auth Gateway

The auth broker and auth gateway are two cooperating HTTP services that move OAuth refresh tokens and provider access tokens off developer laptops and into a single broker host.

- **`gjc auth-broker serve`** holds the canonical SQLite credential vault, performs OAuth refreshes, and exposes a small REST API (`/v1/snapshot`, `/v1/credential/:id/refresh`, `/v1/credential/:id/disable`, `/v1/credential`, `/v1/usage`, `/v1/usage/scoped?provider=<provider>`, `/v1/healthz`).
- **`gjc auth-gateway serve --provider=<provider>`** is a provider-scoped forward-proxy. It accepts OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses requests, injects the broker-resolved access token, and dispatches only through the selected provider catalog. Clients (containerised gjc, llm-git, the macOS usage widget, …) never see the access token.

Transport security between operator, broker, and gateway is delegated to the operator (Tailscale / Wireguard / reverse proxy + TLS). Every endpoint except `/v1/healthz` (broker) and `/healthz` (gateway) requires a bearer token when bearer authentication is configured. The gateway's `--no-auth` mode disables inbound bearer checks only on a loopback bind; an unauthenticated non-loopback bind is rejected at startup.

Source: `packages/ai/src/auth-broker/`, `packages/ai/src/auth-gateway/`, `packages/coding-agent/src/cli/auth-broker-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-cli.ts`, `packages/coding-agent/src/session/startup-auth-config.ts`.

## Data flow

```
                ┌────────────────────────────────────────────────────────────┐
                │ broker host                                                │
                │                                                            │
  developer ──▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  laptop /      │  │  gjc auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI          │  │  - holds refresh tokens  │    │  (canonical writer)│    │
                │  │  - background refresher  │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  gjc auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  pulls /v1/snapshot at boot, │
                │  │  /v1/usage, /v1/models   │  refreshes credentials by id │
                │  └─────────┬────────────────┘  via the broker on expiry    │
                └────────────┼───────────────────────────────────────────────┘
                             │  bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  unauthenticated clients
                  (llm-git, macOS widget, IDE plugins, …)
                                │
                                ▼ same path is forwarded with Authorization
                  api.anthropic.com / api.openai.com / …
```

The broker is the only writer of OAuth refresh tokens. Clients (including the gateway itself) load a redacted snapshot in which every `refresh` field has been replaced with `REMOTE_REFRESH_SENTINEL`; when an access token expires the client calls `POST /v1/credential/:id/refresh` and the broker performs the refresh server-side. `RemoteAuthCredentialStore` rejects any local code path that tries to write through it, with an error pointing at `gjc auth-broker login` / `gjc auth-broker logout`.

## auth-broker

### CLI

```
gjc auth-broker serve     [--bind=host:port]                    # boot the broker
gjc auth-broker token     [--regenerate] [--json]               # print or rotate the bearer token
gjc auth-broker login     <provider> [--via=user@host] [--dry-run]
gjc auth-broker logout    <provider>
gjc auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
gjc auth-broker migrate   --from-local [--dry-run] [--json]
gjc auth-broker status    [--json]
```

- `serve` opens the local SQLite store at `getAgentDbPath()` and binds an HTTP listener (default `127.0.0.1:8765`). On startup a token is ensured at `<config-dir>/auth-broker.token` (mode `0600`, `0700` parent dir). The background refresher refreshes any OAuth credential whose `expires - Date.now() < refreshSkewMs` (default 5 min) every `refreshIntervalMs` (default 60 s).
- `token` prints the cached bearer or generates a new one. `--regenerate` rotates it.
- `login <provider>` runs the per-provider OAuth flow locally, or — with `--via=user@host` — `ssh -L <callback-port>:127.0.0.1:<callback-port> user@host gjc auth-broker login <provider>` so the OAuth callback hits the local browser but the credential is written on the broker host. Built-in callback ports: `anthropic:54545`, `openai-code:1455`, `google-gemini-cli:8085`, `google-antigravity:51121`, `gitlab-duo:8080`.
  When no port forward is possible, run the interactive TUI on that host and use `/login anthropic --manual`, which pairs by pasting the code Anthropic renders at `https://platform.claude.com/oauth/code/callback` instead of using a loopback callback at all. `gjc auth-broker login` itself has no manual mode.
- `logout <provider>` deletes every credential row for `<provider>`.
- `import <file|dir>` imports CLIProxyAPI-style JSON credentials into the local SQLite store. Maps `type` field → gjc provider (`anthropic-model → anthropic`, `openai-code → openai-code`, `gemini → google-gemini-cli`, `antigravity → google-antigravity`, `gemini-cli → google-gemini-cli`).
- `migrate --from-local` walks the local SQLite store + env-derived credentials and idempotently uploads them to the configured broker (`POST /v1/credential`).
- `status` health-pings the configured remote broker.

### Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET`  | `/v1/healthz` | none | Liveness + version |
| `GET`  | `/v1/snapshot` | bearer | Redacted snapshot (refresh tokens replaced by sentinel) |
| `POST` | `/v1/credential` | bearer | Upsert one OAuth or API-key credential |
| `POST` | `/v1/credential/:id/refresh` | bearer | Force-refresh one OAuth credential |
| `POST` | `/v1/credential/:id/disable` | bearer | Disable one credential with a recorded cause |
|| `GET`  | `/v1/usage` | bearer | Aggregate `UsageReport[]` across credentials |
| `GET`  | `/v1/usage/scoped?provider=<provider>` | bearer | Provider-scoped `UsageReport[]`; unavailable on legacy brokers |

Requests use `Authorization: Bearer <token>`. The server compares against an in-memory token allow-list; the gateway’s implementation uses a timing-safe comparison.

### Background refresher

`AuthBrokerRefresher` iterates active OAuth credentials at `refreshIntervalMs` cadence and refreshes any within `refreshSkewMs` of expiry. Refreshes are single-flighted per credential id so a slow refresh cannot be retriggered. The refresher distinguishes:

- **definitive failures** (`invalid_grant`, `invalid_token`, `revoked`, unauthorized refresh-token, 401/403 not from a network blip) — credentials are passed to `AuthStorage.disableCredentialById(id, cause)` so the next snapshot pull surfaces a clean delete on the client;
- **transient failures** (timeout / ECONNREFUSED / fetch failed) — left in place for the next sweep.

## auth-gateway

### CLI

```
gjc auth-gateway serve   --provider=<provider> [--bind=host:port] [--no-auth]
gjc auth-gateway token   [--regenerate] [--json]
gjc auth-gateway status  [--provider=<provider>] [--json]
gjc auth-gateway check   [--provider=<provider>] [--json]
```

- `serve` requires an explicit `--provider`. It fetches the broker snapshot before binding and fails closed unless that snapshot contains an enabled credential for the selected provider. The gateway is itself a broker client: it calls `AuthBrokerClient.fetchSnapshot()`, wraps it in `RemoteAuthCredentialStore`, and constructs an `AuthStorage` that resolves access tokens through the broker. Default bind is `127.0.0.1:4000`. The gateway token is stored at `<config-dir>/auth-gateway.token` (`0600`); `--no-auth` disables the inbound bearer check only on a loopback bind for non-browser local clients. Browser-Origin requests and preflight are rejected in no-auth mode. A non-loopback unauthenticated bind is rejected at startup.
- The selected provider is the complete gateway scope. The bundled catalog is filtered to that provider before startup; model ids from other providers are never admitted, so duplicate ids cannot select a credential by enumeration order. An unscoped `serve` invocation is rejected rather than using first-write routing. Requests require exact membership in the scoped catalog and resolve credentials only for the scoped provider.
- `status` and `check` accept `--provider` to report or probe one scope. Their JSON and text output includes the scope and redacts credential/token material; an unscoped `status` reports not-ready instead of claiming gateway readiness.
- `token` manages only the inbound gateway bearer token.

### Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET`  | `/healthz` | none | Liveness + version |
| `GET`  | `/v1/usage` | bearer | Aggregate `UsageReport[]` for the selected provider scope |
| `GET`  | `/v1/credentials/check` | bearer | Credential health for the selected provider scope |
| `GET`  | `/v1/models` | bearer | Bundled-model catalog for the selected provider scope |
| `POST` | `/v1/chat/completions` | bearer | OpenAI Chat Completions wire format |
| `POST` | `/v1/messages` | bearer | Anthropic Messages wire format |
| `POST` | `/v1/responses` | bearer | OpenAI Responses wire format |
| `POST` | `/v1/pi/stream` | bearer | Native gjc stream format |

The model id is read from the top-level `model` field and must be an exact member of the selected provider’s source-backed catalog. The gateway resolves the scoped model and obtains the credential for that model’s provider only; it never falls back to a credential from another provider. `/v1/models` emits the catalog model’s `owned_by` and `api` values. In particular, an `openai-codex` scope exposes Codex-owned rows with `owned_by: "openai-codex"` and `api: "openai-codex-responses"`; it cannot project the same id through GitHub Copilot or generic OpenAI Responses.

All provider-format routes parse into gjc’s canonical `Context`, dispatch through `streamSimple()`, and encode back to the inbound wire format. This keeps provider-specific OAuth shaping, headers, and transport selection on the source-backed model.

`idleTimeout` on the underlying `Bun.serve` is set to `255 s` so long thinking-budget calls do not get killed by Bun’s default idle timeout.

## Usage cache: server-side 5-min jitter + client-side 15 s single-flight

Two layers cache the aggregate provider-usage report. Both are intentional and stacked.

### Server-side cache (broker `AuthStorage`)

`AuthStorage` caches each credential’s `UsageReport` in the broker’s SQLite store at a **5-minute per-credential TTL with ±25 % jitter**. Anthropic and OpenAI rate-limit `/usage` aggressively per source IP, and a synchronized 5-credential fan-out trips 429s every cycle; the jitter decorrelates refresh times within a few cycles. On fetch failure the store keeps the **last-good** report for up to 24 h with a short jittered re-poll window — so a transient upstream blip never blanks out the widget.

Constants: `USAGE_REPORT_TTL_MS = 5 * 60_000`, `USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000` (`packages/ai/src/auth-storage.ts`).

### Client-side single-flight (`RemoteAuthCredentialStore`)

When the gateway (or any other broker client) calls `fetchUsageReports()` / `getUsageReport(provider, credential)`, `RemoteAuthCredentialStore` uses the versioned `/v1/usage/scoped?provider=<provider>` route for provider-scoped calls and caches the result for **15 s** in memory. Legacy brokers that do not expose the scoped route fail closed instead of falling back to aggregate usage.

- `USAGE_CACHE_TTL_MS = 15_000` (`packages/ai/src/auth-broker/remote-store.ts`).
- A single `#usageInflight` promise is shared across all callers; a per-caller `AbortSignal` is **raced** against the shared promise, not threaded into it, so one caller’s abort never cascades into a peer’s in-flight request.
- On fetch failure the rejected promise is logged and the awaited value is `null` — callers (`AuthStorage.fetchUsageReports`, `#getUsageReport`) treat a `null` report as "no usage signal for this cycle" and proceed without it. **This is the 15 s TTL fallback**: the client absorbs transient broker outages by suppressing the error, returning `null` to ranking, and re-attempting after the 15 s window.

The 15 s client window deliberately sits below the broker’s 5 min server cache, so almost every client poll is served from the broker’s already-cached value; the client cache exists to absorb the parallel fan-out generated by `AuthStorage.#rankOAuthSelections` into a single broker round-trip.

## Operator opt-in

The broker is **off** unless `GJC_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) is set. When set, `discoverAuthStorage` in `packages/coding-agent/src/sdk/session.ts` swaps the local SQLite credential store for `RemoteAuthCredentialStore` and every API call resolves credentials through the broker.

### Environment variables

| Variable | Purpose | Required when |
| -------- | ------- | ------------- |
| `GJC_AUTH_BROKER_URL`   | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`). Selecting this puts the client in broker mode — local SQLite is bypassed. | Any time the gjc client should resolve credentials through a broker (and required by `gjc auth-gateway serve --provider=<provider>`). |
| `GJC_AUTH_BROKER_TOKEN` | Bearer token used for every broker endpoint except `/v1/healthz`. | When a broker URL is set and no token is available from nested config or `<config-dir>/auth-broker.token`. |

### Startup resolver and configuration

The startup resolver reads the global agent `config.yml` before the normal settings layer. Broker settings must use the canonical nested YAML shape:

```yaml
auth:
  broker:
    url: https://broker.example.test:8765
    token: <literal-bearer-token>
```

Resolution is explicit and ordered:

1. `GJC_AUTH_BROKER_URL` takes precedence over the nested `auth.broker.url` value.
2. If a URL is resolved, `GJC_AUTH_BROKER_TOKEN` takes precedence over nested `auth.broker.token`, which takes precedence over the trimmed contents of `<config-dir>/auth-broker.token`.
3. A resolved URL without a token is a hard startup error; GJC does not fall back to the local SQLite store.

The nested URL and token entries may be literal strings or exact `$ENV_NAME` references resolved from the trusted process environment. Missing config is allowed and leaves broker mode disabled. An unreadable file, invalid YAML, non-mapping root, malformed `auth`/`broker`/`gateway` section, unresolved nested URL reference, invalid ranking mode, or invalid credential-pin record fails closed with a typed `StartupAuthConfigError` rather than silently downgrading to local authority. An unresolved nested token reference may still fall through to the owner-only token file. Legacy literal dotted auth keys are rejected with manual nested-YAML rewrite guidance.

The gateway has no dedicated env vars — it inherits `GJC_AUTH_BROKER_*` because it is itself a broker client.

### `config.yml` keys

| Key | Default | Purpose |
| --- | ------- | ------- |
| `auth.broker.url`   | unset | Same as `GJC_AUTH_BROKER_URL`; env wins. Hidden from the settings UI. |
| `auth.broker.token` | unset | Same as `GJC_AUTH_BROKER_TOKEN`; env wins. Accepts a literal bearer token or exact `$ENV_NAME` reference. |

### Token files

| Path | Owner | Mode |
| ---- | ----- | ---- |
| `<config-dir>/auth-broker.token`  | `gjc auth-broker serve` (created at first start) | `0600` in a `0700` parent dir |
| `<config-dir>/auth-gateway.token` | `gjc auth-gateway serve` (skipped under `--no-auth`) | `0600` in a `0700` parent dir |

`<config-dir>` resolves to `~/.gjc/` (respecting `GJC_CONFIG_DIR`).

## Interaction with the local API-key resolution order

The broker only owns OAuth credentials and provider-API-key credentials that were uploaded to it. The standard credential ladder in `models.md` (`Auth and API key resolution order`) is preserved, with one addition committed alongside the gateway:

- `AuthStorage.setConfigApiKey / removeConfigApiKey / clearConfigApiKeys` let a `models.yml` `apiKey` beat a stored OAuth token **without** overriding an explicit `--api-key`. This is what allows a broker-resolved OAuth credential to be reliably shadowed by a per-environment `models.yml` config key when both are present.

## See also

- [`secrets.md`](./secrets.md) — secret obfuscation around tokens that *do* leak through (e.g. `GJC_AUTH_BROKER_TOKEN` in shell output).
- [`models.md`](./models.md) — provider auth resolution order; the broker plugs in at layers 2–3 (stored credentials).
- [`environment-variables.md`](./environment-variables.md) — full env reference including `GJC_AUTH_BROKER_URL` / `GJC_AUTH_BROKER_TOKEN`.
