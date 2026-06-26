# Bridge Protocol Reference (Experimental, Fail-Closed)

Bridge mode runs the coding agent as an experimental network control surface over
HTTPS. The session-control surface is intentionally **fail-closed by default**
while the bridge security model is hardened.

Default availability:

- `GET /healthz` is available without auth and returns `{ "status": "ok" }`.
- `GET /v1/help` is available without auth and reports the fail-closed endpoint
  matrix.
- `POST /v1/handshake` remains authenticated, but the default response advertises
  no enabled session endpoints, no accepted capabilities, no accepted scopes, and
  no frame types.
- `GET /v1/sessions/{session_id}/events` fails closed with
  `403 endpoint_disabled` after bearer auth succeeds.
- `POST /v1/sessions/{session_id}/commands` fails closed with
  `403 endpoint_disabled` after bearer auth succeeds and before body parsing,
  command validation, scope checks, or dispatch.
- `POST /v1/sessions/{session_id}/control:claim` and
  `POST /v1/sessions/{session_id}/control:disconnect` fail closed with
  `403 endpoint_disabled` after bearer auth succeeds.
- `POST /v1/sessions/{session_id}/ui-responses/{correlation_id}` fails closed
  with `403 endpoint_disabled` after bearer auth succeeds and before body parsing
  or controller checks.
- `POST /v1/sessions/{session_id}/host-tool-results/{correlation_id}` and
  `POST /v1/sessions/{session_id}/host-uri-results/{correlation_id}` fail closed
  with `403 endpoint_disabled` after bearer auth succeeds and before body parsing
  or host callback handling.

The implementation still contains the v1 protocol scaffolding and internal tests
for the previously enabled surface, but external clients must treat events,
commands, controller ownership, UI responses, host tool results, and host URI
results as unavailable unless a future release explicitly re-enables them.

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
- One bridge process serves exactly **one live `AgentSession`**.
- The default endpoint matrix disables session events, commands, controller
  ownership, UI responses, host tool results, and host URI results.

### Configuration (environment variables)

See `docs/environment-variables.md` for the authoritative table. Summary:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `GJC_BRIDGE_TOKEN` | Yes | — | Bearer token for authenticated endpoints. **Secret — never commit.** |
| `GJC_BRIDGE_TLS_CERT` | Yes | — | Path to the TLS certificate (PEM). |
| `GJC_BRIDGE_TLS_KEY` | Yes | — | Path to the TLS private key (PEM). **Secret — never commit.** |
| `GJC_BRIDGE_HOST` | No | `127.0.0.1` | Bind hostname. |
| `GJC_BRIDGE_PORT` | No | `4077` | Bind port (1–65535). |
| `GJC_BRIDGE_SCOPES` | No | `prompt` | Parsed for internal compatibility, but default session endpoints are fail-closed. |

## Security and TLS

The bridge is a network control surface, so it is **secure-by-default**:

- **TLS is mandatory for every bind, including loopback.** Startup fails closed
  with a clear error if `GJC_BRIDGE_TLS_CERT` and `GJC_BRIDGE_TLS_KEY` are not
  both set. There is no plaintext fallback and no insecure/trust-bypass switch.
- **Bearer token is mandatory** for every endpoint except `GET /healthz` and
  `GET /v1/help`.
- The TypeScript SDK refuses bearer-token clients over non-`https` URLs by
  default. It allows plaintext only for `localhost`, `127.0.0.1`, or `[::1]`
  when the caller explicitly passes the localhost/test opt-in.
- Session endpoints fail closed by default even when bearer auth and scopes are
  otherwise valid.

## Handshake

```
POST /v1/handshake   (authenticated)
```

The client sends its supported protocol version range, requested capabilities,
and requested scopes. Version mismatch returns `status: "rejected"`,
`reason: "incompatible_version"`. Malformed request bodies return
`400 invalid_request`.

In the default fail-closed configuration, a successful authenticated
handshake returns:

- `protocol_version` — the server protocol version (`BRIDGE_PROTOCOL_VERSION`, `2`).
- `session_id` — the single session id this bridge serves.
- `accepted_capabilities` — empty.
- `accepted_scopes` — empty.
- `unsupported` — every requested capability.
- `endpoints` — all session endpoint descriptors present but empty strings.
- `frame_types` — empty.

## Fail-Closed Endpoint Matrix

The disabled endpoint matrix is:

| Surface | Endpoint(s) | Default |
| --- | --- | --- |
| Events | `GET /v1/sessions/{session_id}/events?last_seq=<n>` | Disabled |
| Commands | `POST /v1/sessions/{session_id}/commands` | Disabled |
| Control | `POST /v1/sessions/{session_id}/control:claim`, `POST /v1/sessions/{session_id}/control:disconnect` | Disabled |
| UI responses | `POST /v1/sessions/{session_id}/ui-responses/{correlation_id}` | Disabled |
| Host tool results | `POST /v1/sessions/{session_id}/host-tool-results/{correlation_id}` | Disabled |
| Host URI results | `POST /v1/sessions/{session_id}/host-uri-results/{correlation_id}` | Disabled |

Authenticated requests to disabled endpoints return:

```json
{ "error": "endpoint_disabled", "endpoint": "commands" }
```

The `endpoint` value is one of `events`, `commands`, `control`, `uiResponses`,
`hostToolResults`, or `hostUriResults`.

## Protocol Catalog Kept for Internal Compatibility

The bridge protocol module still defines the v1 command and scope catalog so
existing internal tests can validate the dormant implementation and future
re-enable work has a stable baseline.

When internally enabled for compatibility tests, event replay still uses `last_seq` and the bounded replay reset marker `replay_window_exceeded`; command and UI response retries still use `Idempotency-Key`. These mechanisms are dormant for default external bridge clients because the endpoint matrix rejects the endpoints before they reach replay, body parsing, idempotency, scope, or dispatch logic.

Workflow-gate responses are part of the UI-response surface, not the dormant command surface: when internally enabled, an answerer responds to `workflow_gate` frame `wg_...` by posting `{ "gate_id": "wg_...", "answer": ... }` to `POST /v1/sessions/{session_id}/ui-responses/{gate_id}`. Gate answers are authorized by bearer auth, the `control` scope on this (default-disabled) endpoint, and the currently claimed controller owner token. `X-GJC-Bridge-Owner-Token` must match the claimed controller token; mismatches return `403 not_controller` and do not resolve the gate. `Idempotency-Key` is optional and is also forwarded as `idempotency_key` when supplied by SDK helpers.

### Scopes

The configurable scope set (`BRIDGE_COMMAND_SCOPES`) is:

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

The mandatory compliance floor (`MANDATORY_FLOOR_COMMAND_SCOPES`) remains
`prompt` for the dormant command surface. Because commands are disabled by the
endpoint matrix, the default handshake advertises no accepted scopes.

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
| `get_pending_workflow_gates` | `message:read` |
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
| `negotiate_unattended` | `control` |
| `workflow_gate_response` | `control` |

### Dormant capabilities and frame types

These names remain in the protocol code for future compatibility and internal
conformance tests, but they are not advertised by the default fail-closed
handshake:

Capabilities: `events`, `prompt`, `permission`, `elicitation`, `ui.declarative`,
`host_tools`, `host_uri`, `workflow_gate`.

Frame types: `ready`, `event`, `response`, `ui_request`, `permission_request`,
`host_tool_call`, `host_uri_request`, `reset`, `workflow_gate`, `error`.

## UI Capability Parity

Bridge UI parity remains **semantic, not pixel-perfect** when the dormant UI
surface is explicitly enabled for internal validation. Local-only UI capabilities
continue to report typed unsupported results instead of silent defaults:

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
controller/UI/host-callback helpers, and an idempotency-key helper. The bridge
session-control surface remains fail-closed by default, so against an
unconfigured bridge those helpers should be expected to fail because the server
endpoint matrix disables the corresponding session endpoints until they are
explicitly enabled.

`BridgeClient.respondGate(sessionId, gateId, ownerToken, answer, options)` posts to the fail-closed UI-response endpoint and returns the gate resolution envelope emitted by the bridge. It deliberately does not send `workflow_gate_response` through `/commands`. Gate answers are authorized by bearer auth, the `control` scope on the (by-default-disabled) `ui-responses` endpoint, and the current controller owner token; unauthorized owner-token attempts return `403 not_controller` without resolving the gate.

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
- Session events, commands, controller ownership, UI responses, host tool
  results, and host URI results are disabled by default.
- Coarse per-token scopes only (no fine-grained per-command policy yet).
- UI parity is semantic, not pixel-perfect (see UI Capability Parity).

## Hermes/Claw orchestration layering

For Hermes/Claw-style orchestration, treat `gjc` as an external runner. The orchestration agent should choose or create the repository checkout first, preferably a dedicated Git worktree for branch-local work, then launch or attach a leader session with `gjc --tmux` from that directory. GJC is not embedded runtime injection into Hermes, Claw Code, or another coding tool.

Public orchestration boundaries:

1. Choose the repo/worktree and branch that will own changes, logs, and review evidence.
2. Start or attach the GJC leader with `gjc --tmux` from that directory. If you want GJC to create the sibling worktree, use `gjc --tmux --worktree <branch-like-name>`; the argument is a worktree/branch name, not a filesystem path.
3. Submit the workflow appropriate to the task: `/skill:deep-interview` for requirements discovery, `/skill:ralplan` for plan consensus, and `gjc ultragoal ...` for durable goal tracking through execution and verification.
4. Use `gjc team ...` only when coordinated parallel tmux workers help with implementation or verification; single-lane work should stay in the leader session.
5. Collect the handoff state: whether the session stopped cleanly, changed files, commands/checks run, failures, unresolved risks, and evidence summaries.

Bridge mode remains the public remote-control protocol for an already-running GJC session, but the session-control endpoints are fail-closed by default. Keep lifecycle, worktree selection, and evidence policy above the bridge frames, and avoid documenting private deployment, routing, or credential internals. Introducing another authenticated remote-control protocol for the same purpose should require ADR-level rationale.

The same external-runner workflow is summarized in the README section [Using GJC with other coding agents](../README.md#using-gjc-with-other-coding-agents).
