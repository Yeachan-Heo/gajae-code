# External controller integration guide

This guide is for authors of bots and orchestrators that want to drive Gajae-Code (`gjc`) without scraping terminal scrollback. Hermes, OpenClaw, GitHub bots, chatops bots, and custom schedulers are examples of external controllers; none of them need bespoke GJC behavior if they can speak the Coordinator MCP tools or the SDK WebSocket lifecycle below.

GJC is an external runner. Your controller owns queueing, identity, policy, and credentials; GJC owns the coding-agent session, workflows, tools, artifacts, and evidence inside the selected repository or worktree.

## Integration surfaces

Use the smallest surface that fits your bot:

| Surface | Best for | Command | Stability notes |
| --- | --- | --- | --- |
| Coordinator MCP | Any external controller that can discover SDK-backed sessions, send turns, answer questions, and read artifacts. | `gjc mcp-serve coordinator` | Preferred orchestration surface. `gjc mcp-serve hermes` is a compatibility alias, not a separate contract. |
| Setup adapter | Rendering a portable MCP config and operator instructions for a controller profile. | `gjc setup hermes --root /path/to/repo` | Compatibility-oriented config renderer; does not call an LLM or validate provider credentials. |
| SDK WebSocket | A controller that drives one live session directly: state queries, events, actions, and workflow-gate replies. | Connect to the session's loopback SDK endpoint (see [`docs/sdk.md`](./sdk.md)) | The canonical machine interface. `--mode rpc`, `--mode rpc-ui`, and `--mode bridge` have been removed. |
| Daemon session CLI | Scripted control/queries against a live session with JSON output. | `gjc daemon session list\|control\|query\|global` | A pure SDK client; honors the same protocol and dispositions. |

## Recommended architecture

```text
external controller / bot
  ├─ chooses repo/worktree and task policy
  ├─ starts MCP server: gjc mcp-serve coordinator
  ├─ discovers or starts one SDK-backed GJC session
  ├─ sends one bounded turn at a time
  ├─ answers structured questions explicitly
  ├─ marks turn completion/failure with report_status
  └─ reads artifacts/reports from allowlisted roots
```

Do not infer completion from terminal output. Treat SDK-backed durable turn state as authoritative. Tmux identifiers, when present, are advisory process metadata only.

## Coordinator MCP setup

Render a non-mutating config preview:

```sh
gjc setup hermes --root /path/to/repo --profile my-bot --repo my-repo
```

Install into a Hermes-compatible profile only when the target path is intentional:

```sh
gjc setup hermes \
  --root /path/to/repo \
  --profile my-bot \
  --repo my-repo \
  --mutation sessions,questions,reports \
  --profile-dir /path/to/hermes/profile \
  --install
```

Run provider-independent contract smokes before trying a live model:

```sh
gjc setup hermes --root /path/to/repo --smoke --json
gjc mcp-serve coordinator --check --json
```

`gjc mcp-serve coordinator --check --json` (and the `hermes` compatibility alias) is a discovery-only, non-mutating catalog check. Its successful JSON payload retains `ok`, `server`, `readOnly`, and `tools`, and adds `catalog: { "ready": true, "reason": null }` plus `broker`. `broker.discovery_status` is `ready`, `unavailable`, or `error`; its reason is one of `absent_or_invalid`, `unsupported_state_version`, `discovery_access_denied`, or `discovery_read_failed` (or `null` when ready). `broker.operational_ready` is always `null`: this check observes canonical broker discovery but does not connect, ensure/bootstrap, write, repair, or delete. It reports `bootstrap_supported: true` and `bootstrap_attempted: false`, and never exposes broker paths, authority, endpoint, process, token, or raw error details. The human output remains the server/tools summary. SDK check behavior is separate and unchanged.

The generated config uses these environment variables:

| Variable | Purpose |
| --- | --- |
| `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` | Required allowlist for workdirs and artifact paths. |
| `GJC_COORDINATOR_MCP_MUTATIONS` | Startup opt-in for mutation classes: `sessions`, `questions`, `reports`, or `all`. |
| `GJC_COORDINATOR_MCP_SESSION_COMMAND` | Command used to start real GJC sessions, defaulting to `gjc --worktree` in generated setup. |
| `GJC_COORDINATOR_MCP_PROFILE` | Optional profile namespace so one bot cannot enumerate another profile's state. |
| `GJC_COORDINATOR_MCP_REPO` | Optional repo namespace so one repo cannot enumerate another repo's state. |
| `GJC_COORDINATOR_MCP_STATE_ROOT` | Optional coordination state root; defaults under `.gjc/state/coordinator-mcp`. |
| `GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP` | Maximum bytes returned by artifact reads. |

Mutating calls require both startup opt-in, per-call `allow_mutation: true`, and the required caller-provided `idempotency_key`. Missing any one fails closed.

## Generic smoke strategy

Use three different smoke levels so CI does not depend on one operator's model, API key, or desktop:

| Smoke | Required for CI | What it proves | Example |
| --- | --- | --- | --- |
| Contract smoke | Yes | MCP server metadata, tool discovery, exported tool names, input schemas, read-only default, and mutation-gate failures. No provider credentials required. | `gjc mcp-serve coordinator --check --json` and focused tests around `tools/list` plus mutation denial. |
| Dry-run lifecycle smoke | Yes when changed behavior affects lifecycle state | A generic controller can discover a mocked SDK session, send a turn, observe active-turn protection, report terminal status, and read the completed turn without a real LLM. | `bun test packages/coding-agent/test/coordinator-mcp-server.test.ts` uses mocked SDK services and temporary state roots. |
| Optional live smoke | No | One operator's local provider/model/profile setup can run end-to-end in their chosen repo. Failure diagnoses that setup; it must not fail CI or PR validation. | Start `gjc mcp-serve coordinator` with local env, dispatch a tiny task, then report/read evidence. |

A public bot integration change should at least preserve the contract smoke and local-leak docs test. Live smokes are diagnostics, not mandatory gates.

## MCP tool contract

Read-only tools:

- `gjc_coordinator_list_sessions`
- `gjc_coordinator_read_status`
- `gjc_coordinator_read_tail`
- `gjc_coordinator_read_turn`
- `gjc_coordinator_await_turn`
- `gjc_coordinator_list_questions`
- `gjc_coordinator_list_artifacts`
- `gjc_coordinator_read_artifact`
- `gjc_coordinator_read_coordination_status`
- `gjc_coordinator_watch_events`

Mutating tools:

- `gjc_coordinator_start_session`
- `gjc_coordinator_register_session`
- `gjc_coordinator_send_prompt`
- `gjc_coordinator_submit_question_answer`
- `gjc_coordinator_report_status`
- `gjc_coordinator_stop_session`

`gjc_coordinator_stop_session` closes a coordinator delegate-created (ephemeral) session through canonical SDK broker lifecycle control, then removes its coordinator metadata only after the broker reports success. It refuses sessions with an active turn. User-registered sessions require both `force: true` and the `GJC_COORDINATOR_MCP_FORCE_STOP` capability; the same SDK lifecycle path reaps abandoned ephemeral delegate sessions after the configured idle TTL.

High-level delegation tools:

- `gjc_delegate_plan`
- `gjc_delegate_execute`
- `gjc_delegate_team`

The `gjc_delegate_*` tools package common GJC workflows for hosts that want to delegate an entire planning, execution, or team turn without manually composing `start_session` and `send_prompt`. They use the same coordinator mutation gates and workdir allowlists as the lower-level session tools.

### Start a managed GJC session

Call `gjc_coordinator_start_session` with a canonical workdir inside `GJC_COORDINATOR_MCP_WORKDIR_ROOTS`:

```json
{
  "cwd": "/path/to/repo",
  "prompt": "Optional first bounded task prompt",
  "idempotency_key": "start-gjc-demo-1",
  "allow_mutation": true
}
```

The returned payload includes `session.session_id`, `session_state`, and, when a prompt is provided, `turn_id`, `active_turn_id`, `status`, `delivery`, `queued`, and `delivered`. The top-level `status`, `queued`, and `delivered` exactly mirror the nested durable turn; `active_turn_id` is the current active turn.

### Register an SDK-discoverable session

Register an already-running GJC session only after its endpoint is discoverable from the selected workdir:

```json
{
  "session_id": "visible-gjc-1",
  "cwd": "/path/to/repo",
  "idempotency_key": "register-visible-gjc-1",
  "allow_mutation": true
}
```

`gjc_coordinator_register_session` validates the session id and workdir allowlist, then verifies SDK endpoint discovery before writing coordinator state. Optional `tmux_session` and `tmux_target` fields are advisory process metadata only.

### Send work as turns

Send one bounded task prompt and persist the returned `turn_id`:

```json
{
  "session_id": "gjc-demo",
  "prompt": "Use /skill:ralplan to build a plan for ...",
  "idempotency_key": "send-gjc-demo-1",
  "allow_mutation": true
}
```

A session may have one active turn by default. A second prompt returns `active_turn_exists` unless the bot passes:

- `queue: true` to enqueue a durable follow-up turn, or
- `force: true` to supersede the previous active turn and audit the supersession.

### Wait or watch for completion

Use `gjc_coordinator_read_turn` for polling or `gjc_coordinator_await_turn` for bounded waiting:

```json
{
  "session_id": "gjc-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "timeout_ms": 30000,
  "poll_interval_ms": 1000,
  "lines": 80
}
```

Terminal turn statuses are `completed`, `failed`, `cancelled`, and `superseded`. Non-terminal statuses include `queued`, `delivering`, `active`, `waiting_for_answer`, and `completing`.

When the work is done, your bot must call `gjc_coordinator_report_status` with the turn id. This writes the final response/error, evidence paths, and coordinator report that later reads consume:

```json
{
  "session_id": "gjc-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "status": "completed",
  "summary": "Implemented the requested fix and ran focused tests.",
  "evidence_paths": ["/path/to/repo/test-output.txt"],
  "idempotency_key": "report-gjc-demo-1",
  "allow_mutation": true
}
```

Use `status: "failed"` plus `blocker` for provider failures, unrecoverable tool failures, missing credentials, policy denial, or task blockers.
Use `status: "cancelled"` when the coordinator policy intentionally stops tracking an active turn, for example after an operator abort or a bot-side shutdown decision. This records the turn as terminal in coordinator state; it does not kill or control any tmux process. To supersede one active turn with replacement work, send the replacement prompt with `force: true` and preserve the superseded turn id in your audit trail.

### Forward finish/stop lifecycle notifications

Discord, Hermes, Clawhip, and similar external notifiers should be opt-in and should forward only the public lifecycle surface. Use one of these supported paths:

- Coordinator controllers: watch or poll turn state with `gjc_coordinator_watch_events`, `gjc_coordinator_await_turn`, or `gjc_coordinator_read_turn`, then notify from the terminal turn status your controller records with `gjc_coordinator_report_status`.
- In-process extensions or hooks: subscribe to the public lifecycle events `turn_end` and `agent_end` from the shared hook/extension event contract.

Recommended notification mapping:

| Notification intent | Public surface | Safe meaning |
| --- | --- | --- |
| Turn finished | `turn_end` or terminal coordinator turn status `completed` | One LLM turn produced its final assistant message. |
| Agent stopped / finished | `agent_end` | The agent loop ended for the submitted prompt. |
| Waiting for user | Coordinator turn status `waiting_for_answer` | The agent is blocked on a structured question. |
| Failed or blocked | Coordinator status `failed` with a public `blocker` summary | The controller recorded a terminal failure. |
| Cancelled / superseded | Coordinator status `cancelled` or `superseded` | The controller intentionally stopped tracking or replaced the turn. |

Do not forward raw prompts, transcripts, tool outputs, hidden instructions, private configs, host paths, channel ids, webhook URLs, or tokens. If your notifier needs a human-readable sentence, create a caller-supplied sanitized summary and keep provider/tool details out of the payload.

Example public-safe extension event payloads:

```json
{ "type": "turn_end", "turnIndex": 2, "summary": "Turn finished; review the local GJC session for details." }
```

```json
{ "type": "agent_end", "summary": "Agent loop ended; no raw transcript is included." }
```

Example opt-in forwarding policy:

```json
{
  "enabled": true,
  "events": ["turn_end", "agent_end"],
  "destination": "external-notifier-profile",
  "redaction": "metadata-only"
}
```

GJC does not currently expose a structured stop-reason field on `agent_end`; integrators that need `waiting_for_answer`, `failed`, `cancelled`, or `superseded` should prefer the Coordinator MCP turn status because it is explicit, terminal-state oriented, and safe to relay after controller-side redaction.

### Answer structured questions

Pull questions for one required session; every call reconciles durable pending `workflow.gates.list` rows before returning a bounded `questions`, `diagnostics`, and `reconciliation` snapshot. Filter `status: "pending"`; legacy `status: "open"` remains a compatibility alias for pending. A session can return multiple questions, so handle every pending row independently. The public rows include only the safe question shape and a per-pending-row `answer_binding`; they never expose private gate payloads or gate values.

```json
{ "session_id": "gjc-demo", "status": "pending" }
```

Submit the exact identifiers and binding from one pending row. `answer` uses public option ids (`opt_0`, etc.), or the advertised `other`/`clarify` form:

```json
{
  "session_id": "gjc-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "question_id": "question-1",
  "answer_binding": "<binding returned by list_questions>",
  "answer": { "selected": ["opt_0"] },
  "idempotency_key": "answer-gjc-demo-1",
  "allow_mutation": true
}
```

`gjc_coordinator_submit_question_answer` requires `session_id`, `turn_id`, `question_id`, `answer_binding`, `answer`, `idempotency_key`, and `allow_mutation: true`; it resolves through `workflow.gate_answer`, never generic `ask.answer`. It revalidates against a complete fresh snapshot after restart and before resolution. Incomplete reconciliation returns `terminal_uncertain`; stale, terminal, absent, or ownership-mismatched rows are not answerable. Retry only an identical request with the same idempotency key: it replays the accepted result; reusing that key with conflicting arguments returns `idempotency_conflict`. Always answer the advertised shape; do not synthesize destructive approvals unless bot policy permits them.

This Coordinator MCP pull loop is separate from #2549/#2551 and unattended plain-CLI behavior; those paths do not gain coordinator gate access.

### Read artifacts and reports

Use `gjc_coordinator_list_artifacts` to inspect safe roots and `gjc_coordinator_read_artifact` to read a bounded artifact:

```json
{ "path": "/path/to/repo/.gjc/ultragoal/ledger.jsonl" }
```

Artifact paths are canonicalized, symlink escapes are rejected, and output is byte-capped. Use `gjc_coordinator_read_coordination_status` for status reports written through `gjc_coordinator_report_status`.

## SDK WebSocket integration

Use the SDK when your bot owns a single live session rather than an MCP coordinator. Each running session exposes a loopback WebSocket endpoint discovered via `.gjc/state/sdk/<sessionId>.json`; the wire protocol (state queries, control operations, event subscription and replay, workflow-gate replies, reverse host-tool leases) is documented in [`docs/sdk.md`](./sdk.md).

Key SDK workflow-gate facts:
- The discovery file carries the endpoint URL and per-session token; a wrong
  token is rejected at the WebSocket handshake. `server_hello` marks a
  connection ready, and `gjc daemon session control|query|global` uses the same
  protocol for shell scripts.

- `action_needed.id` is an opaque, transient presentation ID. It is the only
  generic `reply.id` authority. Do not equate it with a durable workflow gate.
- A durable workflow-gate presentation optionally includes additive SDK v3 `workflowGateId`. It correlates to Q12's durable `gate_id` only within `(sessionId, workflowGateId)` on the current authenticated endpoint; it never authorizes generic reply.
- `workflow.gate_answer` and `workflow.plan_approve` use the durable `gate_id`. `expectedSessionId` omission remains accepted and audited for the entire SDK v3 line so deployed v3 clients continue to work, but new clients must send it. Mandatory enforcement or removal may occur no earlier than SDK v4 and only after at least one full published deprecation release/window with deployed-client notice. A supplied session mismatch is rejected before resolution.
- One session has one active answerable presentation. Additional Q12 gates stay queued while Q12 exposes durable pending records and additive SDK v3 diagnostics. A same-server reconnect replays the active action ID; a process restart quarantines old records and a rebuilt workflow remints fresh gate and presentation IDs.
- A native generic reply claim wins a direct-control race once acquired; a direct control wins only by atomically retiring the exact unclaimed active presentation. Terminal, stale, and reissued action IDs never regain authority. Do not use text, option/order, durable-ID, or history heuristics, and fail closed rather than guess when identity is unsafe or ambiguous. Do not persist private route/claim/receipt/epoch/generation state.
- Rust/N-API compatibility is additive: legacy `ActionNeeded`, `register_ask`,
  and `registerAsk` stay uncorrelated; explicit workflow reader/registration
  APIs preserve correlation without exposing private arbitration state.
- The `@gajae-code/coding-agent` runtime and `@gajae-code/natives` native addon ship from the same source release at exact matching package versions; the native loader version sentinel enforces the pair. Mixed native/runtime versions are unsupported and cannot claim SDK compatibility.

The prior documented invariant `action_needed.id == gate_id` is incorrect for
v3 and must not be implemented by controllers. See [`docs/sdk.md`](./sdk.md)
for exact wire examples, Q12 tags/lifecycle diagnostics, and control payloads.

`--mode rpc`, `--mode rpc-ui`, and `--mode bridge` have been removed along with their JSONL/HTTPS protocols and the former Python RPC client. There are no compatibility shims; migrate controllers to the SDK endpoint or Coordinator MCP.

## Error handling playbook

| Situation | Bot behavior |
| --- | --- |
| `coordinator_mutation_class_disabled:*` | Re-render setup with the required mutation class, or keep the bot in read-only mode. |
| `coordinator_mutation_call_not_allowed:*` | Add `allow_mutation: true` only after policy approval for that specific call. |
| `unknown_session` | Re-list sessions; start a new managed session or register a session after its SDK endpoint is discoverable. |
| `active_turn_exists` | Poll the active turn, send with `queue: true`, or use `force: true` only when supersession is intentional. |
| `timeout` from `await_turn` | Treat as non-terminal. Poll again or inspect `read_status`; do not mark failure solely from a bounded wait timeout. |
| Coordinator cancellation | Use `gjc_coordinator_report_status` with `status: "cancelled"` for an intentionally stopped turn, or send replacement work with `force: true` when supersession is policy-approved. This is coordinator state, not process control. |
| Stale session state | Check `read_status.session_state` and SDK endpoint discovery. Register a new discoverable session or report the turn failed with a recoverable blocker. |
| Provider/auth failure | Capture the model/provider error in `report_status` with `status: "failed"`; do not retry forever without a policy budget. |
| Artifact denied | Keep the artifact inside allowlisted roots and avoid symlink escapes. |
| Malformed or invalid question answer | Re-read the question/gate schema and submit a value matching the advertised shape. |
| Bot shutdown | Persist `session_id` and active `turn_id`; on restart use `read_turn` and `read_status` before sending more work. |

## Controller examples

Generic MCP controller config:

```json
{
  "mcp_servers": {
    "gjc_coordinator": {
      "command": "gjc",
      "args": ["mcp-serve", "coordinator"],
      "env": {
        "GJC_COORDINATOR_MCP_WORKDIR_ROOTS": "/home/bot/src/project:/home/bot/src/worktrees",
        "GJC_COORDINATOR_MCP_MUTATIONS": "sessions,questions,reports",
        "GJC_COORDINATOR_MCP_PROFILE": "controller-prod",
        "GJC_COORDINATOR_MCP_REPO": "project",
        "GJC_COORDINATOR_MCP_SESSION_COMMAND": "gjc --worktree"
      },
      "enabled": true
    }
  }
}
```

Example controller loop:

```text
1. Start `gjc mcp-serve coordinator` with repo/worktree roots allowlisted.
2. Call `gjc_coordinator_start_session` for a GJC-managed worktree session.
3. Send `/skill:deep-interview`, `/skill:ralplan`, or an approved `gjc ultragoal ...` task as one turn.
4. Await the turn; answer `gjc_coordinator_list_questions` entries using bot policy.
5. Report terminal status with evidence paths.
6. Read artifacts/reports for the user-facing bot response.
```

Hermes and OpenClaw can use the same MCP tool contract. Their names here are examples of controller products, not privileged integration modes.

## Security and credential boundaries

- Do not put provider API keys, GitHub tokens, or bot secrets in prompts.
- Prefer host tools, host URI schemes, or bot-side sidecars for credentialed external writes.
- Keep `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` narrow; do not allow `/`, `/home`, or broad parent directories.
- Use namespaces for multi-tenant bots.
- Keep mutation classes minimal: read-only for dashboards, `sessions` for work dispatch, `questions` for answering questions, and `reports` for final state.
- Treat `.gjc/` as local runtime state and evidence. Do not expose it wholesale to untrusted users.

## Related references

- [`docs/hermes-mcp-bridge.md`](./hermes-mcp-bridge.md) — coordinator MCP details and setup adapter behavior.
- [`docs/sdk.md`](./sdk.md) — SDK wire protocol, event frames, workflow gates, host tools, and host URI schemes.
- [`docs/external-control-readiness.md`](./external-control-readiness.md) — readiness classification of the supported external-control surfaces.
