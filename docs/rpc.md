# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), `workflow_gate_response`, extension UI responses, and host-tool updates/results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, `workflow_gate`, extension UI requests, host-tool requests/cancellations

Primary implementation:

- `src/modes/rpc/rpc-mode.ts`
- `src/modes/rpc/rpc-types.ts`
- `src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
gjc --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- RPC mode disables automatic session title generation by default to avoid an extra model call.
- RPC mode resets workflow-altering `todo.*`, `task.*`, `async.*`, and `bash.autoBackground.*` settings to their built-in defaults instead of inheriting user overrides.
- The process reads stdin as JSONL (`readJsonl(Bun.stdin.stream())`).
- At startup it writes `{ "type": "ready" }` before processing commands.
- When stdin closes, pending host-tool calls are rejected and the process exits with code `0`.
- Responses/events are written as one JSON object per line.

## Transport and Framing

Each frame is a single JSON object followed by `\n`.

Agent session events are wrapped in canonical `event` frames. Ready, response, workflow gate, extension UI/error, host tool, and host URI frames remain flat.

### Outbound frame categories (stdout)

1. Ready frame (`{ type: "ready" }`)
2. `RpcResponse` (`{ type: "response", ... }`)
3. Canonical event frames wrapping `AgentSessionEvent` objects (`{ type: "event", ... }`)
4. `RpcWorkflowGateEvent` (`{ type: "workflow_gate", ... }`)
5. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
6. Host tool requests/cancellations (`host_tool_call`, `host_tool_cancel`)
7. Host URI requests/cancellations (`host_uri_request`, `host_uri_cancel`)
8. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcWorkflowGateResponse` (`{ type: "workflow_gate_response", gate_id, answer }`)
3. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
4. Host tool updates/results (`host_tool_update`, `host_tool_result`)
5. Host URI results (`host_uri_result`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses are emitted with `id: undefined` (even if the request had an `id`).
- Parse/handler exceptions in the input loop emit `command: "parse"` with `id: undefined`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails.

## Command Schema (canonical)

`RpcCommand` is defined in `src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### State

- `{ id?, type: "get_state", include?: ("tools" | "dumpTools" | "systemPrompt")[] }` (`dumpTools` is accepted as an alias for the older response field name.)
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "workflow_gate_response", gate_id: string, answer: unknown }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`

### Messages

- `{ id?, type: "get_messages" }`

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string | object }`; typed control-plane failures use object-valued errors such as `{ "code": "scope_denied", ... }`.

Data payloads are command-specific and defined in `rpc-types.ts`.


By default, `get_state` omits large static fields. Request `include: ["tools"]` to include `dumpTools`, `include: ["systemPrompt"]` to include `systemPrompt`, or both when a host needs a one-shot full session dump.
### `get_state` payload

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "contextUsage": {
    "tokens": 0,
    "contextWindow": 200000,
    "percent": 0
  }
  // Optional with include: ["systemPrompt"]:
  // "systemPrompt": ["..."],
  // Optional with include: ["tools"] (or ["dumpTools"]):
  // "dumpTools": [
  //   { "name": "read", "description": "Read files and URLs", "parameters": {} }
  // ]
}
```

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns the normalized phase list:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

The response payload is:

```json
{
  "toolNames": ["echo_host"]
}
```

These tools are added to the active session tool registry before the next model
call. Re-sending `set_host_tools` replaces the previous host-owned set.

### `set_host_uri_schemes` payload

Replaces the current set of host-owned URL schemes the RPC server should
dispatch reads/writes through:

```json
{
  "id": "req_4",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

The response payload is:

```json
{
  "schemes": ["db"]
}
```

Schemes are case-insensitive on the wire and normalized to lowercase before
the response is sent. Re-sending `set_host_uri_schemes` replaces the entire
previous set — schemes missing from the new list are unregistered.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)` as canonical `event` frames:

```json
{
  "type": "event",
  "protocol_version": 2,
  "session_id": "...",
  "seq": 1,
  "frame_id": "...",
  "payload": {
    "event_type": "agent_start",
    "event": { "type": "agent_start" }
  }
}
```

`seq` is monotonic per session starting at `1`. `payload.event_type` duplicates the inner event `type` for routing, and `payload.event` contains the original `AgentSessionEvent` fields.

Common inner event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `todo_auto_clear`

Non-event stdout categories remain flat: `ready`, `response`, `workflow_gate`, `extension_ui_request`, `extension_error`, `host_tool_call`, `host_tool_cancel`, `host_uri_request`, and `host_uri_cancel`.

`message_update` includes streaming deltas in the inner event's `assistantMessageEvent` (text/thinking/toolcall deltas).

Extension runner errors are emitted separately as flat frames:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` are **acknowledged immediately**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != run completion
- final completion is observed via `agent_end`

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Workflow Gate Sub-Protocol

Interactive workflow stages emit a machine-addressable gate frame before the legacy extension UI request:

```json
{
  "type": "workflow_gate",
  "gate_id": "wg_4845_ralplan_000001",
  "stage": "ralplan",
  "kind": "approval",
  "schema": { "type": "string", "enum": ["approve", "request-changes", "reject"] },
  "schema_hash": "<sha256 of canonical schema>",
  "options": [{ "value": "approve", "label": "Approve execution" }],
  "context": { "title": "Approve plan?", "summary": "…" },
  "created_at": "2026-06-05T05:00:00.000Z",
  "required": true
}
```

Fields:

- `gate_id`: run-scoped, monotonic, stable id of the form `wg_<run>_<stage>_NNNNNN`.
- `stage`: one of `"deep-interview"`, `"ralplan"`, or `"ultragoal"` (`team` is reserved and rejected for v1).
- `kind`: one of `"question"`, `"approval"`, or `"execution"`.
- `schema`: documented JSON Schema 2020-12 subset for the expected answer; `schema_hash` is the canonical hash of `schema` and equals the server-side validation hash.
- `options`: optional `RpcWorkflowGateOption[]` (`{ value, label, description? }`), emitted for select-style gates.
- `context`: `RpcWorkflowGateContext` (`title`, `prompt`, `summary`, `stage_state`, `artifact_refs`, `language`).
- `created_at`: ISO timestamp the gate was opened; `required` is always `true`.

Hosts answer with:

```json
{ "id": "resp_1", "type": "workflow_gate_response", "gate_id": "wg_4845_ralplan_000001", "answer": "approve" }
```

A valid answer resolves the pending gate and returns:

```json
{ "id": "resp_1", "type": "response", "command": "workflow_gate_response", "success": true }
```

A schema mismatch is **not** a command failure: the response succeeds and the
resolution data carries `status: "rejected"` plus a typed validation `error`
with code `invalid_workflow_gate_answer`:

```json
{
  "id": "resp_1",
  "type": "response",
  "command": "workflow_gate_response",
  "success": true,
  "data": {
    "gate_id": "wg_1",
    "status": "rejected",
    "answer_hash": "…",
    "resolved_at": "…",
    "error": {
      "code": "invalid_workflow_gate_answer",
      "gate_id": "wg_1",
      "schema_hash": "…",
      "errors": [{ "path": "/answer", "keyword": "type", "message": "must be boolean" }]
    }
  }
}
```

Answering a gate that does not exist is a recoverable command failure carrying
the broker error code `unknown_gate` (other broker codes are `already_resolved`,
`idempotency_conflict`, and `invalid_workflow_stage`).
## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`, `cancel`
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`

Runtime note:

- Automatic session title generation is disabled in RPC mode, and `setTitle` UI
  requests are also suppressed by default because most hosts do not have a
  meaningful terminal-title surface. Set `GJC_RPC_EMIT_TITLE=1` to opt back in to
  the UI event only.

Example:

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires.

## Host Tool Sub-Protocol

RPC hosts can expose custom tools to the agent by sending `set_host_tools`, then
serving execution requests over the same transport.

### Outbound request

When the agent wants the host to execute one of those tools, RPC mode emits:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

If the tool execution is later aborted, RPC mode emits:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### Inbound updates and completion

Hosts can optionally stream progress:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

Completion uses:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

Set top-level `isError: true` on `host_tool_result` to reject the pending host tool call and surface the returned text content as a tool error.

## Host URI Sub-Protocol

RPC hosts can also own custom URL schemes (virtual files). After
`set_host_uri_schemes`, every read of `<scheme>://…` and write of
`<scheme>://…` (when registered as `writable`) is bounced back to the host
over the same transport.

### Outbound request

When a session tool resolves a host-owned URL, RPC mode emits:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

Writes look the same with `"operation": "write"` and an additional
`"content": "..."` field carrying the full replacement bytes.

If the request is later aborted (caller cancels, session ends), RPC mode
emits:

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_1"
}
```

### Inbound result

For successful reads:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

For successful writes, omit content:

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

To reject the request, set `isError: true` and either populate `error` with
a message or fall back to `content` for textual error surfacing:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "isError": true,
  "error": "row 42 not found"
}
```

### Constraints

- The agent's `edit` tool does not target host URIs. Hosts that want to
  mutate virtual files expose `write` and let the model use the `write` tool
  with replacement content.
- Schemes are global to the process; `set_host_uri_schemes` replaces the
  previous set, unregistering anything not in the new list.
- Schemes are normalized to lowercase before registration.

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses with unknown `id` are ignored.
- Process termination conditions are stdin close or explicit extension-triggered shutdown after the current command.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (typical):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [] }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## OpenClaw / Hermes host integrations

For OpenClaw- or Hermes-style hosts, keep MCP servers and skills on the host side and expose the selected capabilities through RPC host tools. Do not import GJC runtime MCP internals directly; those package paths are intentionally quarantined. See [OpenClaw / Hermes RPC integration notes](./openclaw-hermes-rpc-integration.md).

## Notes on `RpcClient` helper

`src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc`
- Correlates responses by generated `req_<n>` ids
- Dispatches recognized `AgentEvent` types to event listeners
- Dispatches top-level `workflow_gate` frames to `onWorkflowGate()` listeners
- Supports host-owned custom tools via `setCustomTools()` and automatic handling of `host_tool_call` / `host_tool_cancel`
- Exposes `respondGate()` for `workflow_gate_response` and waits for the accepted/rejected resolution envelope
- Does **not** expose helper methods for every protocol command (for example, `set_interrupt_mode` and `set_session_name` are in protocol types but not wrapped as dedicated methods)

Use raw protocol frames if you need complete surface coverage.

## Workflow gates (agent-driven lifecycle)

The workflow-gate contract makes every human-gated lifecycle moment
(deep-interview questions, ralplan approval, ultragoal execution sign-off)
machine-addressable so an external agent can answer it over RPC without
screen-scraping.

### Outbound event: `workflow_gate`

```json
{
  "type": "workflow_gate",
  "gate_id": "wg_4845_ralplan_000001",
  "stage": "ralplan",
  "kind": "approval",
  "schema": { "type": "string", "enum": ["approve", "request-changes", "reject"] },
  "schema_hash": "<sha256 of canonical schema>",
  "options": [{ "value": "approve", "label": "Approve execution" }],
  "context": { "title": "Approve plan?", "summary": "…" },
  "created_at": "2026-06-05T05:00:00.000Z",
  "required": true
}
```

- `gate_id` is **run-scoped and monotonic**: `wg_<run>_<stage>_<NNNNNN>`.
- `stage` is one of `deep-interview` | `ralplan` | `ultragoal`. `team` is
  reserved and rejected for v1 (single-agent only).
- `kind` is `question` | `approval` | `execution`.
- `schema` is a **documented subset of JSON Schema 2020-12**. Supported keywords:
  `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`,
  `items`, `minLength`, `maxLength`, `minimum`, `maximum`, `title`,
  `description`, `oneOf`, `anyOf`. Any other keyword is rejected at gate
  construction (`invalid_workflow_gate_schema`) so the server never advertises a
  schema it will not validate. `schema_hash` equals the server-side validation
  hash for that gate.

### Inbound command: `workflow_gate_response`

```json
{ "type": "workflow_gate_response", "gate_id": "wg_4845_ralplan_000001", "answer": "approve", "idempotency_key": "k1" }
```

The answer is validated against the advertised schema **before acceptance**:

- Valid → resolution persisted before the workflow advances; response:
  `{ "type": "response", "command": "workflow_gate_response", "success": true, "data": { "gate_id": "…", "status": "accepted", "answer_hash": "…", "resolved_at": "…" } }`.
- Invalid → the gate stays **pending** and the resolution carries a typed
  `invalid_workflow_gate_answer` error listing each `{ path, keyword, message, expected? }`.
- Idempotency: replaying the same `idempotency_key` + identical body returns the
  cached resolution; the same key with a different body is an
  `idempotency_conflict`; answering an already-accepted gate is `already_resolved`.
- Client helpers wait for this accepted/rejected resolution envelope; they must not treat the write of `workflow_gate_response` itself as completion.

### Entering unattended mode: `negotiate_unattended`

Unattended (zero-human) operation is **fail-closed**. The external agent must
declare its budget, scopes, and action allowlist up front:

```json
{
  "type": "negotiate_unattended",
  "declaration": {
    "actor": "openclaw/hermes",
    "budget": { "max_tokens": 2000000, "max_tool_calls": 5000, "max_wall_time_ms": 3600000, "max_cost_usd": 20 },
    "scopes": ["prompt", "control", "bash"],
    "action_allowlist": ["bash.readonly", "file.write"]
  }
}
```

A missing or partial declaration refuses unattended mode. Budget, scope, and
audit enforcement are layered on this contract by the unattended control plane
(see issues #318/#319/#320). Attended mode is unaffected: clients that never send
`negotiate_unattended` keep the existing extension-UI / permission behavior.


> **Status (live, #315/#318/#321):** the `workflow_gate` /
> `workflow_gate_response` / `negotiate_unattended` frames, the answer-schema
> validator, and the durable gate broker are defined, tested, and wired into
> live session dispatch. When an unattended control plane is attached to the
> session, `dispatchRpcCommand` routes `negotiate_unattended` and
> `workflow_gate_response` through it (see
> `packages/coding-agent/src/modes/shared/agent-wire/command-dispatch.ts`); a
> session without that control plane returns a typed "not available" error for
> these frames rather than silently dropping them.


### Answering gates from a client (#322)

Both clients expose typed `workflow_gate` receive + respond helpers so an agent
can answer a gate from its own memory via a callback.

For bridge sessions, gate responses are **not** posted through `/commands`. The
client must first own the UI/control plane, then post the answer body to
`POST /v1/sessions/{session_id}/ui-responses/{gate_id}` with
`X-GJC-Bridge-Owner-Token: <ownerToken>`. `Idempotency-Key` may be supplied as a
header and the same value is also accepted in the JSON body as `idempotency_key`.

`@gajae-code/bridge-client` (TypeScript):

```ts
import { BridgeClient } from "@gajae-code/bridge-client";

const client = new BridgeClient({ baseUrl, token });
// Headless policy: every received gate is routed to the resolver and answered.
for await (const { gate, answer } of client.consumeWorkflowGates(sessionId, ownerToken, gate => {
  if (gate.kind === "approval") return { decision: "approve" };
  if (gate.kind === "question") return { selected: [gate.options?.[0]?.value], other: false };
  return { decision: "approve" };
})) {
  console.log(`answered ${gate.gate_id} (${gate.kind}) with`, answer);
}
// Or answer a single gate directly:
await client.respondGate(sessionId, gateId, ownerToken, { decision: "approve" });
```

`python/gjc-rpc` (Python):

```python
from gjc_rpc import RpcClient, WorkflowGate

client = RpcClient(executable="gjc")

def resolver(gate: WorkflowGate) -> object:
    if gate.kind == "approval":
        return {"decision": "approve"}
    if gate.kind == "question":
        return {"selected": [gate.options[0].value] if gate.options else [], "other": False}
    return {"decision": "approve"}

# Headless policy: route every received gate to the resolver and respond.
client.run_workflow_gate_policy(resolver)
client.start()
# Or answer a single gate directly: client.respond_gate(gate_id, {"decision": "approve"})
```
