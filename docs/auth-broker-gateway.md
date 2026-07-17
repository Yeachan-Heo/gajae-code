# Auth Broker and Auth Gateway

The auth broker and auth gateway are two cooperating HTTP services that move OAuth refresh tokens and provider access tokens off developer laptops and into a single broker host.

- **`gjc auth-broker serve`** holds the canonical SQLite credential vault, performs OAuth refreshes, and exposes a small REST API (`/v1/snapshot`, `/v1/credential/:id/refresh`, `/v1/credential/:id/disable`, `/v1/credential`, `/v1/usage`, `/v1/healthz`).
- **`gjc auth-gateway serve`** is a forward-proxy. It accepts OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses requests, injects the broker-resolved access token, and forwards the bytes to the real provider. Clients (containerised gjc, llm-git, the macOS usage widget, …) never see the access token.

Transport security between operator, broker, and gateway is delegated to the operator (Tailscale / Wireguard / reverse proxy + TLS). Every endpoint except `/v1/healthz` (broker) and `/healthz` (gateway) requires a bearer token.

Source: `packages/ai/src/auth-broker/`, `packages/ai/src/auth-gateway/`, `packages/coding-agent/src/cli/auth-broker-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-cli.ts`, `packages/coding-agent/src/session/auth-broker-config.ts`.

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
| `GET`  | `/v1/usage` | bearer | Aggregate `UsageReport[]` across credentials |

Requests use `Authorization: Bearer <token>`. The server compares against an in-memory token allow-list; the gateway’s implementation uses a timing-safe comparison.

### Background refresher

`AuthBrokerRefresher` iterates active OAuth credentials at `refreshIntervalMs` cadence and refreshes any within `refreshSkewMs` of expiry. Refreshes are single-flighted per credential id so a slow refresh cannot be retriggered. The refresher distinguishes:

- **definitive failures** (`invalid_grant`, `invalid_token`, `revoked`, unauthorized refresh-token, 401/403 not from a network blip) — credentials are passed to `AuthStorage.disableCredentialById(id, cause)` so the next snapshot pull surfaces a clean delete on the client;
- **transient failures** (timeout / ECONNREFUSED / fetch failed) — left in place for the next sweep.

## auth-gateway

### CLI

```
gjc auth-gateway serve   [--bind=host:port] [--no-auth]
gjc auth-gateway token   [--regenerate] [--json]
gjc auth-gateway status  [--json]
```

- `serve` requires `GJC_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) — the gateway is itself a broker client. It calls `AuthBrokerClient.fetchSnapshot()`, wraps it in `RemoteAuthCredentialStore`, and constructs an `AuthStorage` that resolves access tokens through the broker. Default bind is `127.0.0.1:4000`. The gateway token is stored at `<config-dir>/auth-gateway.token` (`0600`); `--no-auth` disables the bearer check entirely (loopback-only use).
- `token` / `status` mirror the broker’s equivalents.

### Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET`  | `/healthz` | none | Liveness + version |
| `GET`  | `/v1/usage` | bearer | Aggregate `UsageReport[]` (proxied through `AuthStorage`) |
| `GET`  | `/v1/models` | bearer | Bundled-model catalog filtered to providers with credentials |
| `POST` | `/v1/chat/completions` | bearer | OpenAI Chat Completions wire format |
| `POST` | `/v1/messages` | bearer | Anthropic Messages wire format |
| `POST` | `/v1/responses` | bearer | OpenAI Responses wire format |

The model id is read from the top-level `model` field. The gateway picks the first bundled `Model<Api>` matching that id and:

- **Passthrough fast-path** — when the inbound wire format matches the model’s native API (`openai-chat → openai-completions`, `anthropic-messages → anthropic-messages`, `openai-responses → openai-responses`), the request body is forwarded byte-for-byte with the client `Authorization`/`x-api-key` stripped and replaced by `Authorization: Bearer <resolved-access-token>`. Provider-specific fields (`cache_control`, `service_tier`, tool-choice extensions, …) flow through unmodified. Hop-by-hop headers (RFC 7230) plus `Content-Encoding`/`Content-Length` are stripped from the upstream response.
- **Translate path** — when the inbound format and the resolved model’s API differ (e.g. `/v1/chat/completions` targeting an Anthropic model, or `/v1/responses` targeting `openai-code-responses` which runs over a websocket transport), the request is parsed against the wire schema, rebuilt into an gjc `Context`, dispatched through `streamSimple()`, and re-encoded back to the inbound format (SSE for streamed responses).

`idleTimeout` on the underlying `Bun.serve` is set to `255 s` so long thinking-budget calls do not get killed by Bun’s default idle timeout.

## Usage cache: server-side 5-min jitter + client-side 15 s single-flight

Two layers cache the aggregate provider-usage report. Both are intentional and stacked.

### Server-side cache (broker `AuthStorage`)

`AuthStorage` caches each credential’s `UsageReport` in the broker’s SQLite store at a **5-minute per-credential TTL with ±25 % jitter**. Anthropic and OpenAI rate-limit `/usage` aggressively per source IP, and a synchronized 5-credential fan-out trips 429s every cycle; the jitter decorrelates refresh times within a few cycles. On fetch failure the store keeps the **last-good** report for up to 24 h with a short jittered re-poll window — so a transient upstream blip never blanks out the widget.

Constants: `USAGE_REPORT_TTL_MS = 5 * 60_000`, `USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000` (`packages/ai/src/auth-storage.ts`).

### Client-side single-flight (`RemoteAuthCredentialStore`)

When the gateway (or any other broker client) calls `fetchUsageReports()` / `getUsageReport(provider, credential)`, `RemoteAuthCredentialStore` coalesces concurrent calls into a single `GET /v1/usage` round-trip and caches the result for **15 s** in memory.

- `USAGE_CACHE_TTL_MS = 15_000` (`packages/ai/src/auth-broker/remote-store.ts`).
- A single `#usageInflight` promise is shared across all callers; a per-caller `AbortSignal` is **raced** against the shared promise, not threaded into it, so one caller’s abort never cascades into a peer’s in-flight request.
- On fetch failure the rejected promise is logged and the awaited value is `null` — callers (`AuthStorage.fetchUsageReports`, `#getUsageReport`) treat a `null` report as "no usage signal for this cycle" and proceed without it. **This is the 15 s TTL fallback**: the client absorbs transient broker outages by suppressing the error, returning `null` to ranking, and re-attempting after the 15 s window.

The 15 s client window deliberately sits below the broker’s 5 min server cache, so almost every client poll is served from the broker’s already-cached value; the client cache exists to absorb the parallel fan-out generated by `AuthStorage.#rankOAuthSelections` into a single broker round-trip.

## Operator opt-in

The broker is **off** unless `GJC_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) is set. When set, `discoverAuthStorage` in `packages/coding-agent/src/sdk/session.ts` swaps the local SQLite credential store for `RemoteAuthCredentialStore` and every API call resolves credentials through the broker.

### Environment variables

| Variable | Purpose | Required when |
| -------- | ------- | ------------- |
| `GJC_AUTH_BROKER_URL`   | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`). Selecting this puts the client in broker mode — local SQLite is bypassed. | Any time the gjc client should resolve credentials through a broker (and required by `gjc auth-gateway serve`). |
| `GJC_AUTH_BROKER_TOKEN` | Bearer token used for every broker endpoint except `/v1/healthz`. | When `GJC_AUTH_BROKER_URL` is set and no token is available from `auth.broker.token` or `<config-dir>/auth-broker.token`. |

Resolution order in `resolveAuthBrokerConfig()`:

1. `GJC_AUTH_BROKER_URL` env (else `auth.broker.url` from `config.yml`, with `$ENV_NAME` resolution);
2. `GJC_AUTH_BROKER_TOKEN` env (else `auth.broker.token` from `config.yml`, else `<config-dir>/auth-broker.token`);
3. URL set but no token resolvable → hard error pointing at the token file path.

The gateway has no dedicated env vars — it inherits `GJC_AUTH_BROKER_*` because it is itself a broker client.

### `config.yml` keys

| Key | Default | Purpose |
| --- | ------- | ------- |
| `auth.broker.url`   | unset | Same as `GJC_AUTH_BROKER_URL`; env wins. Hidden from the settings UI. |
| `auth.broker.token` | unset | Same as `GJC_AUTH_BROKER_TOKEN`; env wins. Values may be the literal token or `$ENV_NAME` to indirect through env. |

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
