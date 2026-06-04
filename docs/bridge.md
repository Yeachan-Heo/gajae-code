# Bridge Protocol Reference (Experimental)

Bridge mode runs the coding agent as a network-reachable control surface over
**HTTPS REST + an authenticated SSE-style fetch event stream**. It exposes the
full agent surface (events, commands, permission/elicitation, host tool/URI
callbacks) to a remote client, and ships a TypeScript SDK in
`@gajae-code/bridge-client`.

> **Stability: experimental.** The bridge protocol is versioned
> (`BRIDGE_PROTOCOL_VERSION`, currently `1`) and negotiated through
> `POST /v1/handshake`. Treat the wire format and SDK surface as experimental:
> they may change in additive, version-negotiated ways before a stable release.
> Do not assume long-term API stability yet.

Primary implementation:

- `src/modes/bridge/bridge-mode.ts`
- `src/modes/bridge/auth.ts`
- `src/modes/bridge/event-stream.ts`
- `src/modes/bridge/bridge-client-bridge.ts`
- `src/modes/bridge/bridge-ui-context.ts`
- `src/modes/shared/agent-wire/*` (protocol, scopes, handshake, command dispatch/validation, host bridges)
- `packages/bridge-client/src/*`

## Startup

```bash
gjc --mode bridge [regular CLI options]
```

Behavior notes:

- The bridge is served over **HTTPS only**. Startup refuses to bind without TLS
  configured (see Security and TLS). There is no unencrypted startup path.
- `@file` CLI arguments are rejected in bridge mode (as in RPC mode).
- Bridge mode reuses the RPC default-setting overrides and suppresses automatic
  session title generation.
- One bridge process serves exactly **one live `AgentSession`** (see Limitations).

### Configuration (environment variables)

See `docs/environment-variables.md` for the authoritative table. Summary:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `GJC_BRIDGE_TOKEN` | Yes | — | Bearer token for all authenticated endpoints. **Secret — never commit.** |
| `GJC_BRIDGE_TLS_CERT` | Yes | — | Path to the TLS certificate (PEM). |
| `GJC_BRIDGE_TLS_KEY` | Yes | — | Path to the TLS private key (PEM). **Secret — never commit.** |
| `GJC_BRIDGE_HOST` | No | `127.0.0.1` | Bind hostname. |
| `GJC_BRIDGE_PORT` | No | `4077` | Bind port (1–65535). |
| `GJC_BRIDGE_SCOPES` | No | `prompt` | Comma-separated command scopes to grant (see Commands and Scopes). |

## Security and TLS

The bridge is a network control surface that can drive a live agent (including
running bash and editing files via commands), so it is **secure-by-default**:

- **TLS is mandatory for every bind, including loopback.** Startup fails closed
  with a clear error if `GJC_BRIDGE_TLS_CERT` and `GJC_BRIDGE_TLS_KEY` are not
  both set. There is no plaintext fallback and no insecure/trust-bypass switch.
- **Bearer token is mandatory.** `GJC_BRIDGE_TOKEN` must be set; every endpoint
  except `GET /healthz` requires `Authorization: Bearer <token>`. The event
  stream uses an authenticated fetch GET (NOT a browser `EventSource`) so the
  token is never placed in a URL.
- `GET /healthz` is the only unauthenticated endpoint; it returns
  `{ "status": "ok" }` and exposes no session data.

### Handling secrets and local development

- `GJC_BRIDGE_TOKEN` and the TLS **private key** are secrets. Never commit cert,
  key, or token material to the repository. All examples below use placeholders.
- Restrict the private key to owner-read only, e.g. `chmod 600 bridge-key.pem`
  (or your platform's stricter equivalent).
- For local development with a self-signed certificate, **add the local CA /
  certificate to your client's trust store** (or configure your SDK client with
  an explicit trusted CA). Always keep TLS certificate validation enabled on the
  client; never bypass it with validation-skipping flags.

Example (placeholders only — do not commit real values):

```bash
export GJC_BRIDGE_TOKEN="<your-secret-token>"     # secret
export GJC_BRIDGE_TLS_CERT="/path/to/bridge-cert.pem"
export GJC_BRIDGE_TLS_KEY="/path/to/bridge-key.pem" # secret; chmod 600
export GJC_BRIDGE_SCOPES="prompt,control"
gjc --mode bridge
```

## Handshake

```
POST /v1/handshake   (authenticated)
```

The client sends its supported protocol version range, requested capabilities,
and requested scopes; the server replies with the negotiated result:

- `protocol_version` — the server protocol version (`BRIDGE_PROTOCOL_VERSION`, `1`).
- `session_id` — the single session id this bridge serves.
- `accepted_capabilities` / `unsupported` — capabilities the server supports vs.
  requested-but-unsupported.
- `accepted_scopes` — the subset of requested scopes the server grants.
- `endpoints` — the per-session endpoint descriptors.
- `frame_types` — the server-advertised event-stream frame types.

Version mismatch returns `status: "rejected"`, `reason: "incompatible_version"`.
Malformed request bodies return `400 invalid_request`.

### Capabilities

Server-advertised capabilities (observe the live set through the handshake
response, not by importing internal constants):

- `events`
- `prompt`
- `permission`
- `elicitation`
- `ui.declarative`
- `host_tools`
- `host_uri`

## Transport and Framing

The event stream is an authenticated `GET` that streams Server-Sent-Events-style
frames (`data: <json>\n\n`). Every frame envelope carries:

- `protocol_version`
- `session_id`
- `seq` (monotonic per-session sequence)
- `frame_id`
- optional `correlation_id`
- `type`
- `payload`

### Frame types

Server-advertised frame types (from the handshake `frame_types`):

- `ready`
- `event`
- `response`
- `ui_request`
- `permission_request`
- `host_tool_call`
- `host_uri_request`
- `reset`
- `error`

## Commands and Scopes

Commands are posted to `POST /v1/sessions/{session_id}/commands` and dispatched
through the shared agent-wire command dispatcher. Each command type is validated
for shape before dispatch and mapped to exactly one coarse authorization scope.

### Scopes

Authorization is coarse per-token. The configurable scope set
(`BRIDGE_COMMAND_SCOPES`) is:

- `prompt`
- `control`
- `bash`
- `export`
- `session`
- `model`
- `message:read`
- `host_tools`
- `host_uri`
- `admin`

The mandatory compliance floor (`MANDATORY_FLOOR_COMMAND_SCOPES`) is always
`prompt`: the `prompt` scope is the minimum floor that is always present even
when `GJC_BRIDGE_SCOPES` requests a narrower set. A command whose scope is not
granted is rejected with `403 scope_denied`.

> Fine-grained per-token/per-command authorization policy is **future work**;
> v1 enforces only these coarse scopes.

### Command catalog and scope mapping

| Command | Scope |
| --- | --- |
| `prompt` | `prompt` |
| `steer` | `prompt` |
| `follow_up` | `prompt` |
| `abort` | `prompt` |
| `abort_and_prompt` | `prompt` |
| `new_session` | `session` |
| `get_state` | `message:read` |
| `set_todos` | `control` |
| `set_host_tools` | `host_tools` |
| `set_host_uri_schemes` | `host_uri` |
| `set_model` | `model` |
| `cycle_model` | `model` |
| `get_available_models` | `model` |
| `set_thinking_level` | `model` |
| `cycle_thinking_level` | `model` |
| `set_steering_mode` | `control` |
| `set_follow_up_mode` | `control` |
| `set_interrupt_mode` | `control` |
| `compact` | `control` |
| `set_auto_compaction` | `control` |
| `set_auto_retry` | `control` |
| `abort_retry` | `control` |
| `bash` | `bash` |
| `abort_bash` | `bash` |
| `get_session_stats` | `message:read` |
| `export_html` | `export` |
| `switch_session` | `session` |
| `branch` | `session` |
| `get_branch_messages` | `session` |
| `get_last_assistant_text` | `message:read` |
| `set_session_name` | `session` |
| `handoff` | `admin` |
| `get_messages` | `message:read` |
| `get_login_providers` | `admin` |
| `login` | `admin` |

## Controller Ownership and UI Responses

A single active controller per session is enforced via
`POST /v1/sessions/{session_id}/control:claim`, which responds with
`{ "status": "claimed", "ownerToken": "<token>" }`. (A client may also supply a
preferred token via the `X-GJC-Bridge-Owner-Token` request header.)

- Permission and elicitation prompts are emitted as `permission_request` /
  `ui_request` frames and answered through
  `POST /v1/sessions/{session_id}/ui-responses/{correlation_id}`, sending the
  `ownerToken` back in the `X-GJC-Bridge-Owner-Token` header.
- A duplicate response is `409`; an unauthorized (wrong-owner) response is
  `403 not_controller`.
- `POST /v1/sessions/{session_id}/control:disconnect` (also authorized by the
  `X-GJC-Bridge-Owner-Token` header) releases the lock and cancels pending
  requests.

## Event Stream and Replay

```
GET /v1/sessions/{session_id}/events?last_seq=<n>   (authenticated)
```

- Frames are delivered in `seq` order.
- Reconnecting clients resume with `last_seq`; only an absent or all-decimal
  `last_seq` is accepted (invalid cursors return `400`).
- The replay buffer is bounded (default `1000` frames). If a client's `last_seq`
  predates the retained window, the server emits a `reset` frame with payload
  `{ reason: "replay_window_exceeded", first_seq }` so the client knows to
  resynchronize rather than silently miss frames.

## Idempotency and Retries

The **commands** endpoint and the **ui-responses** endpoint honor an
`Idempotency-Key` header (the controller claim/disconnect and host tool/URI
result callbacks do not). Records are scoped by route, body, and (for UI
responses) owner token, and in-flight requests are coalesced so concurrent
retries dispatch the underlying command only once. The in-flight record is
installed before dispatch.

> Eviction nuance: the bounded idempotency cache prunes only when a **new**
> record is inserted, and it evicts only **completed** (non-pending) records.
> Pending records are never evicted, so a burst of concurrent pending requests
> can push the cache above its nominal bound; it returns to the bound only as
> later inserts evict completed records. There is no universal hard cap during
> such a burst.

## UI Capability Parity

Bridge UI parity is **semantic, not pixel-perfect**. UI surfaces fall into three
classes:

- **Core (mandatory):** `select`, `confirm`, `input`, `editor` elicitation —
  bridged through the UI request broker.
- **Declarative-advanced (optional):** `notify`, status, declarative widgets
  (`lines`-based), title, editor text — emitted as serializable data
  (`ui.declarative`).
- **Local-only (unsupported):** executable component factories, synchronous
  editor reads, raw terminal input, and theme switching are local-only and
  return a typed `unsupported` result instead of a silent default. The reported
  unsupported capabilities are:
  - `ui.terminal_input`
  - `ui.widget.component`
  - `ui.footer.component`
  - `ui.header.component`
  - `ui.custom.component`
  - `ui.editor.get_text`
  - `ui.editor.component`
  - `ui.tools_expanded`
  - Theme switching is unsupported (`setTheme` returns `{ success: false }`).

## SDK Usage

`@gajae-code/bridge-client` exposes `BridgeClient` with handshake, command
helpers mirroring the full RPC command catalog, an `events()` async generator,
controller/UI/host-callback helpers, and an idempotency-key helper.

> Response typing: in this experimental version, `command()` and the typed
> command helpers return `Promise<unknown>`. Callers narrow the response
> themselves. Importing `@gajae-code/coding-agent` internal `rpc-types` into the
> SDK is intentionally avoided to preserve the package boundary; stable shared
> protocol response types are tracked as follow-up work.

## Limitations

- **Single session per process.** A bridge process serves exactly one live
  `AgentSession`. The `session_id` is present in every frame and endpoint for
  ordering and future additive multiplexing, but multi-session multiplexing is
  **not** implemented in v1.
- Coarse per-token scopes only (no fine-grained per-command policy yet).
- UI parity is semantic, not pixel-perfect (see UI Capability Parity).

## Hermes/Claw orchestration layering

For Hermes/Claw-style orchestration, treat `gjc` as an external runner. The orchestration agent should choose or create the repository checkout first, preferably a dedicated Git worktree for branch-local work, then launch or attach a leader session with `gjc --tmux` from that directory. GJC is not embedded runtime injection into Hermes, Claw Code, or another coding tool.

Public orchestration boundaries:

1. Choose the repo/worktree and branch that will own changes, logs, and review evidence.
2. Start or attach the GJC leader with `gjc --tmux` (or `gjc --tmux --worktree <path>` when the worktree path is part of the launch).
3. Submit the workflow appropriate to the task: `/skill:deep-interview` for requirements discovery, `/skill:ralplan` for plan consensus, and `gjc ultragoal ...` for durable goal tracking through execution and verification.
4. Use `gjc team ...` only when coordinated parallel tmux workers help with implementation or verification; single-lane work should stay in the leader session.
5. Collect the handoff state: whether the session stopped cleanly, changed files, commands/checks run, failures, unresolved risks, and evidence summaries.

Bridge mode remains the public remote-control protocol for an already-running GJC session. Keep lifecycle, worktree selection, and evidence policy above the bridge frames, and avoid documenting private deployment, routing, or credential internals. Introducing another authenticated remote-control protocol for the same purpose should require ADR-level rationale.

The same external-runner workflow is summarized in the README section [Using GJC with other coding agents](../README.md#using-gjc-with-other-coding-agents).
