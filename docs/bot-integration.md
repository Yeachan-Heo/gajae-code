# External controller integration guide

This guide is for authors of bots and orchestrators that want to drive Gajae-Code (`gjc`) without scraping terminal scrollback. Hermes, OpenClaw, GitHub bots, chatops bots, and custom schedulers are examples of external controllers; none of them need bespoke GJC behavior if they can speak the Coordinator MCP or RPC lifecycle below.

GJC is an external runner. Your controller owns queueing, identity, policy, and credentials; GJC owns the coding-agent session, workflows, tools, artifacts, and evidence inside the selected repository or worktree.

## Integration surfaces

Use the smallest surface that fits your bot:

| Surface | Best for | Command | Stability notes |
| --- | --- | --- | --- |
| Coordinator MCP | Any external controller that can call MCP tools to start/register tmux sessions, send turns, answer questions, and read artifacts. | `gjc mcp-serve coordinator` | Preferred orchestration surface. `gjc mcp-serve hermes` is a compatibility alias, not a separate contract. |
| Setup adapter | Rendering a portable MCP config and operator instructions for a controller profile. | `gjc setup hermes --root /path/to/repo` | Compatibility-oriented config renderer; does not call an LLM or validate provider credentials. |
| RPC stdio | A controller that embeds a single `gjc --mode rpc` subprocess and handles JSONL frames directly or through `python/gjc-rpc`. | `gjc --mode rpc` | Best for process-backed, single-session bot workers. |
| Bridge HTTPS | Experimental remote control for an already-running session. | `gjc --mode bridge` | Session-control endpoints are fail-closed by default; do not use as the default bot lifecycle surface yet. |
| Visible tmux fallback | Human-supervised lanes where an existing visible `gjc --tmux` pane should become coordinator-authoritative. | `gjc --tmux`, then `gjc_coordinator_register_session` | Use when an operator already opened a pane or wants direct terminal visibility. |

## Recommended architecture

```text
external controller / bot
  ├─ chooses repo/worktree and task policy
  ├─ starts MCP server: gjc mcp-serve coordinator
  ├─ starts or registers one GJC tmux session
  ├─ sends one bounded turn at a time
  ├─ answers structured questions explicitly
  ├─ marks turn completion/failure with report_status
  └─ reads artifacts/reports from allowlisted roots
```

Do not infer completion from terminal output. Treat durable turn state as authoritative and tmux tail output as advisory debug context only.

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

Mutating calls require both startup opt-in and per-call `allow_mutation: true`. Missing either one fails closed.

## Generic smoke strategy

Use three different smoke levels so CI does not depend on one operator's model, API key, tmux layout, or desktop:

| Smoke | Required for CI | What it proves | Example |
| --- | --- | --- | --- |
| Contract smoke | Yes | MCP server metadata, tool discovery, exported tool names, input schemas, read-only default, and mutation-gate failures. No provider credentials or tmux pane required. | `gjc mcp-serve coordinator --check --json` and focused tests around `tools/list` plus mutation denial. |
| Dry-run lifecycle smoke | Yes when changed behavior affects lifecycle state | A generic controller can start/register a mocked session, send a turn, observe active-turn protection, report terminal status, and read the completed turn without a real LLM. | `bun test packages/coding-agent/test/coordinator-mcp.test.ts` uses mocked coordinator services and temporary state roots. |
| Optional live smoke | No | One operator's local provider/model/profile/tmux setup can run end-to-end in their chosen repo. Failure diagnoses that setup; it must not fail CI or PR validation. | Start `gjc mcp-serve coordinator` with local env, dispatch a tiny task, then report/read evidence. |

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

### Start a managed GJC session

Call `gjc_coordinator_start_session` with a canonical workdir inside `GJC_COORDINATOR_MCP_WORKDIR_ROOTS`:

```json
{
  "cwd": "/path/to/repo",
  "prompt": "Optional first bounded task prompt",
  "allow_mutation": true
}
```

The returned payload includes `session.session_id`, `session_state`, and, when a prompt is provided, `turn_id`, `status`, `delivery`, `queued`, and `delivered`.

### Register a visible tmux fallback session

If an operator already started a visible session, register it instead of starting a hidden coordinator session:

```sh
gjc --tmux
```

```json
{
  "session_id": "visible-gjc-1",
  "cwd": "/path/to/repo",
  "tmux_session": "visible-gjc-1",
  "tmux_target": "visible-gjc-1:0.0",
  "visible": true,
  "source": "operator-visible-tmux",
  "allow_mutation": true
}
```

`gjc_coordinator_register_session` validates safe ids, workdir allowlists, tmux target syntax, and liveness before writing coordinator state.

### Send work as turns

Send one bounded task prompt and persist the returned `turn_id`:

```json
{
  "session_id": "gjc-demo",
  "prompt": "Use /skill:ralplan to build a plan for ...",
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
  "allow_mutation": true
}
```

Use `status: "failed"` plus `blocker` for provider failures, unrecoverable tool failures, missing credentials, policy denial, or task blockers.
Use `status: "cancelled"` when the coordinator policy intentionally stops tracking an active turn, for example after an operator abort or a bot-side shutdown decision. This records the turn as terminal in coordinator state; it does not kill the underlying tmux process. To supersede one active turn with replacement work, send the replacement prompt with `force: true` and preserve the superseded turn id in your audit trail.

### Answer structured questions

List pending questions:

```json
{
  "session_id": "gjc-demo",
  "status": "pending"
}
```

Then answer by id:

```json
{
  "session_id": "gjc-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "question_id": "question-1",
  "answer": { "decision": "approve" },
  "allow_mutation": true
}
```

Always answer the advertised shape. Do not synthesize approvals for destructive actions unless your bot policy explicitly permits that action.

### Read artifacts and reports

Use `gjc_coordinator_list_artifacts` to inspect safe roots and `gjc_coordinator_read_artifact` to read a bounded artifact:

```json
{ "path": "/path/to/repo/.gjc/ultragoal/ledger.jsonl" }
```

Artifact paths are canonicalized, symlink escapes are rejected, and output is byte-capped. Use `gjc_coordinator_read_coordination_status` for status reports written through `gjc_coordinator_report_status`.

## RPC stdio integration

Use RPC when your bot owns a single worker subprocess rather than an MCP coordinator. The wire protocol is JSONL over stdio:

```sh
gjc --mode rpc --provider anthropic --model claude-sonnet-4-5
```

Recommended Python client:

```python
from gjc_rpc import RpcClient, WorkflowGate

with RpcClient(no_session=True, no_rules=True) as client:
    client.install_headless_ui()

    def on_gate(gate: WorkflowGate) -> None:
        if gate.kind == "approval":
            client.respond_gate(gate.gate_id, {"decision": "approve"})

    client.on_workflow_gate(on_gate)
    turn = client.prompt_and_wait("Inspect this repo and report the integration contract.")
    print(turn.require_assistant_text())
```

RPC hosts can also expose host-owned tools and URI schemes. Use these to give GJC controlled access to your bot's issue tracker, queue, database rows, or artifact store without leaking long-lived credentials into the GJC process.

Key RPC lifecycle facts:

- `{ "type": "ready" }` means the subprocess is ready for commands.
- `prompt` is acknowledged immediately; completion is observed through `agent_end` or `RpcClient.prompt_and_wait()`.
- `workflow_gate` frames are answered with `workflow_gate_response`.
- `extension_ui_request` frames are answered with `extension_ui_response` or a headless policy.
- Host tool calls and host URI requests are explicit callback frames that must be completed or rejected by the host.
- `RpcClient` enforces single-flight prompt lifecycle collection; use one client per concurrent worker.
- `abort` and `abort_and_prompt` are the RPC cancellation commands for subprocess workers; coordinator MCP cancellation is recorded through terminal turn status instead.

## Error handling playbook

| Situation | Bot behavior |
| --- | --- |
| `coordinator_mutation_class_disabled:*` | Re-render setup with the required mutation class, or keep the bot in read-only mode. |
| `coordinator_mutation_call_not_allowed:*` | Add `allow_mutation: true` only after policy approval for that specific call. |
| `unknown_session` | Re-list sessions; start a new managed session or register the visible tmux fallback. |
| `active_turn_exists` | Poll the active turn, send with `queue: true`, or use `force: true` only when supersession is intentional. |
| `timeout` from `await_turn` | Treat as non-terminal. Poll again or inspect `read_status`/`read_tail`; do not mark failure solely from a bounded wait timeout. |
| Coordinator cancellation | Use `gjc_coordinator_report_status` with `status: "cancelled"` for an intentionally stopped turn, or send replacement work with `force: true` when supersession is policy-approved. This is coordinator state, not a tmux process kill. |
| Stale tmux/session state | Check `read_status.session_state` and advisory liveness. Register a new visible session or report the turn failed with a recoverable blocker. |
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
- [`docs/rpc.md`](./rpc.md) — JSONL RPC protocol, event frames, workflow gates, host tools, and host URI schemes.
- [`docs/bridge.md`](./bridge.md) — experimental HTTPS bridge and fail-closed endpoint matrix.
- [`python/gjc-rpc/README.md`](../python/gjc-rpc/README.md) — typed Python RPC client examples.
- [`python/robogjc/README.md`](../python/robogjc/README.md) — example self-hosted GitHub bot using `gjc --mode rpc`.
