# SDK v3 RPC parity audit

**Status:** internal, closed-inventory audit. This is a comparison of the retired
RPC contract at `6e147d58~1:docs/rpc.md` with SDK v3; it is not an event-plane
parity claim. The CLI rejects the retired `--mode rpc`, `rpc-ui`, and `bridge`
modes and directs external control to the SDK (`packages/coding-agent/src/cli/args.ts:117-127`).

## Method and classifications

The inventory below is **closed**. Command, frame, and sub-protocol rows were
recovered from `git show 6e147d58~1:docs/rpc.md`; the supplemental
`rpc-sessions` registry and `--listen` Unix-socket rows were recovered from
parent-commit source because they do not appear in that document:
`6e147d58~1:packages/coding-agent/src/cli/args.ts:157-158`,
`6e147d58~1:packages/coding-agent/src/modes/rpc/rpc-mode.ts:892-907,984-992`,
and
`6e147d58~1:packages/coding-agent/src/modes/shared/agent-wire/session-registry.ts:1-53`.
`SDK equivalent` means a current operation or documented SDK protocol covers the
control/query intent, not that its transport or event semantics are identical.
`transport-gap — closed by Phase 1` means Phase 1's `gjc sdk serve` and typed
`gjc_sdk` Python package provide the replacement transport/client surface.
`phase-2-gap` means no equivalent has been implemented by this audit.

Operation names and their stated roles are from
`packages/coding-agent/src/sdk/protocol/operation-registry.ts:66-166`; dispatch
coverage is from `packages/coding-agent/src/sdk/host/control/dispatch.ts:138-253`.
SDK protocol and lifecycle references use stable heading references in
`docs/sdk.md`. Command, frame, and sub-protocol rows cite
`6e147d58~1:docs/rpc.md`; the two supplemental rows cite the parent-commit
sources above.

## Closed command inventory

| Retired family | Retired command | SDK v3 equivalent or classification | Evidence |
| --- | --- | --- | --- |
| Prompting | `prompt` | `turn.prompt` | retired doc; registry:67; dispatch:139-140 |
| Prompting | `steer` | Partial SDK equivalent: `turn.steer` is text-only and loses retired `images` | `6e147d58~1:docs/rpc.md:77`; registry:68; dispatch:141-142 |
| Prompting | `follow_up` | Partial SDK equivalent: `turn.follow_up` is text-only and loses retired `images` | `6e147d58~1:docs/rpc.md:78`; registry:69; dispatch:143-144 |
| Prompting | `abort` | `turn.abort` | retired doc; registry:70; dispatch:145-146 |
| Prompting | `abort_and_prompt` | `turn.abort_and_prompt` | retired doc; registry:71; dispatch:147-148 |
| Prompting | `new_session` | Partial SDK equivalent: `session.new` takes no input and loses retired `parentSession` | `6e147d58~1:docs/rpc.md:81`; registry:93; dispatch:196-197 |
| State | `get_state` | Partial SDK equivalent: query bundle `context.get` (includes `systemPrompt`), `tools.list` (Q20), `models.list/current`, `todo.list`, `queue.messages.list`, `session.metadata`, and `session.stats`; no one-shot legacy-shaped snapshot, no retired `dumpTools` include-toggle/exact dump schema, and some legacy snapshot fields remain absent | `6e147d58~1:docs/rpc.md:85,169-222`; registry:132-152; sdk/bus/index.ts:1804-1808,1852-1855; host/query/handlers.ts:91,116; docs/sdk.md “Protocol” and “Model catalog query (Q10)” |
| State | `set_todos` | `todo.replace` | retired doc; registry:78; dispatch:166-167 |
| State | `set_host_tools` | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: `host_tools.register` | `6e147d58~1:docs/rpc.md:87,255-291`; registry:105,164; dispatch:220-221; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| State | `set_host_uri_schemes` | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: `host_uri.register` | `6e147d58~1:docs/rpc.md:88,293-323`; registry:106,165; dispatch:222-223; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| State | `workflow_gate_response` | `workflow.gate_answer` (durable Q12 gate ID) | retired doc; registry:73; dispatch:151-157; docs/sdk.md “Durable workflow controls and Q12” |
| Model | `set_model` | `model.set` | retired doc; registry:79; dispatch:168-169 |
| Model | `set_default_model_selection` | `model.set` with `thinkingLevel`; equivalent active-model/default-selection intent, not the retired durable-selector response envelope | retired doc; registry:79; dispatch:168-169; docs/sdk.md “Model catalog query (Q10)” |
| Model | `cycle_model` | `model.cycle` | retired doc; registry:80; dispatch:170-171 |
| Model | `get_available_models` | `models.list/current` / Q10 | retired doc; registry:141; docs/sdk.md “Model catalog query (Q10)” |
| Thinking | `set_thinking_level` | `thinking.set` | retired doc; registry:81; dispatch:172-173 |
| Thinking | `cycle_thinking_level` | `thinking.cycle` | retired doc; registry:82; dispatch:174-175 |
| Queue modes | `set_steering_mode` | `queue.steering_mode.set` | retired doc; registry:84; dispatch:178-179 |
| Queue modes | `set_follow_up_mode` | `queue.follow_up_mode.set` | retired doc; registry:85; dispatch:180-181 |
| Queue modes | `set_interrupt_mode` | `queue.interrupt_mode.set` | retired doc; registry:86; dispatch:182-183 |
| Compaction | `compact` | Partial SDK equivalent: `compaction.run` takes no input and loses retired `customInstructions` | `6e147d58~1:docs/rpc.md:111`; registry:87; dispatch:184-185 |
| Compaction | `set_auto_compaction` | `compaction.auto.set` | retired doc; registry:88; dispatch:186-187 |
| Retry | `set_auto_retry` | `retry.auto.set` | retired doc; registry:89; dispatch:188-189 |
| Retry | `abort_retry` | `retry.abort` | retired doc; registry:90; dispatch:190-191 |
| Bash | `bash` | `bash.execute` | retired doc; registry:91; dispatch:192-193 |
| Bash | `abort_bash` | `bash.abort` | retired doc; registry:92; dispatch:194-195 |
| Session | `get_session_stats` | `session.stats` | retired doc; registry:146; docs/sdk.md “Protocol” |
| Session | `export_html` | Partial SDK equivalent: `session.export_html` takes no input and loses retired `outputPath` | `6e147d58~1:docs/rpc.md:127`; registry:101; dispatch:212-213 |
| Session | `switch_session` | Partial SDK equivalent: retired `switch_session` was path-addressed (`sessionPath`), while `session.switch` is ID-addressed | `6e147d58~1:docs/rpc.md:128`; registry:97; dispatch:204-205 |
| Session | `branch` | `session.branch` | retired doc; registry:98; dispatch:206-207 |
| Session | `get_branch_messages` | `session.branch_candidates` plus `transcript.list`/`transcript.body`; no identical combined payload | retired doc; registry:132-133,147; docs/sdk.md “Protocol” |
| Session | `get_last_assistant_text` | `session.last_assistant` | retired doc; registry:148; docs/sdk.md “Protocol” |
| Session | `set_session_name` | `session.rename` | retired doc; registry:99; dispatch:208-209 |
| Messages | `get_messages` | `transcript.list` and `transcript.body`; no identical monolithic payload | retired doc; registry:132-133; docs/sdk.md “Protocol” |

## Closed framing, sub-protocol, registry, and transport inventory

| Retired family | Retired frame, protocol, or transport | SDK v3 equivalent or classification | Evidence |
| --- | --- | --- | --- |
| Outbound frame | `ready` | transport-gap — closed by Phase 1; WebSocket connection/authentication replaces JSONL readiness | retired doc; docs/sdk.md §Endpoint discovery |
| Outbound frame | `response` | transport-gap — closed by Phase 1; SDK control request/response replaces JSONL `RpcResponse` | retired doc; registry:66-119; dispatch:138-253 |
| Outbound frame | canonical `event` | phase-2-gap; no renderer-grade canonical `AgentSessionEvent` stream | retired doc; docs/sdk.md §Protocol |
| Outbound frame | `workflow_gate` | Partial SDK equivalent: `action_needed` with `workflowGateId`, plus Q12; not the retired frame/schema | retired doc; docs/sdk.md §Server → client, §Durable workflow controls and Q12 |
| Outbound frame | `extension_ui_request` | phase-2-gap for extension UI methods; `action_needed` covers only generic asks | retired doc; docs/sdk.md §Server → client |
| Outbound frame | `host_tool_call`, `host_tool_cancel` | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: reverse `host_tool.invoke/cancel/update/result` with `host_tools.register` | `6e147d58~1:docs/rpc.md:45-46,357`; registry:105,164; dispatch:220-221; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| Outbound frame | `host_uri_request`, `host_uri_cancel` | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: reverse `host_uri.read/write/cancel/result` with `host_uri.register` | `6e147d58~1:docs/rpc.md:46,357`; registry:106,165; dispatch:222-223; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| Outbound frame | `extension_error` | phase-2-gap; no SDK extension-error frame contract | retired doc; docs/sdk.md §Protocol |
| Inbound frame | `RpcCommand` | SDK control and query operations | retired doc; registry:66-157; dispatch:138-253 |
| Inbound frame | `workflow_gate_response` | `workflow.gate_answer` | retired doc; registry:73; docs/sdk.md “Durable workflow controls and Q12” |
| Inbound frame | `extension_ui_response` | phase-2-gap except generic `reply` for an `action_needed` ask | retired doc; docs/sdk.md §Client → server |
| Inbound frame | `host_tool_update`, `host_tool_result` | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: reverse `host_tool.invoke/cancel/update/result` | `6e147d58~1:docs/rpc.md:54`; registry:164; dispatch:220-221; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| Inbound frame | `host_uri_result` | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: reverse `host_uri.read/write/cancel/result` | `6e147d58~1:docs/rpc.md:55`; registry:165; dispatch:222-223; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| Workflow gate sub-protocol | `workflow_gate` / `workflow_gate_response` with schema and durable broker semantics | Partial SDK equivalent: `action_needed`, `reply`, Q12 `workflow.gates.list`, and `workflow.gate_answer`; IDs and authority rules differ | retired doc; registry:73,143; docs/sdk.md “Answer semantics” and “Durable workflow controls and Q12” |
| Extension UI sub-protocol | select/confirm/input/editor/cancel/notify/status/widget/title/editor-text | phase-2-gap; generic action presentation is not extension UI parity | retired doc; docs/sdk.md §Server → client |
| Host tool sub-protocol | registration, call/cancel, update/result | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: `host_tools.register` plus reverse callback operations | `6e147d58~1:docs/rpc.md:45,54,255-291,357`; registry:105,164; dispatch:220-221; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| Host URI sub-protocol | scheme registration, read/write/cancel/result | Partial SDK equivalent — provider-only/machine attachment; not installed on the ordinary per-session endpoint: `host_uri.register` plus reverse callback operations | `6e147d58~1:docs/rpc.md:46,55,293-323,357`; registry:106,165; dispatch:222-223; sdk/bus/index.ts:1654,1726-1738,2325-2327 |
| Unattended sub-protocol | `negotiate_unattended` declaration/budget/scopes/allowlist | phase-2-gap | retired doc; docs/sdk.md §Coordinator MCP question pull loop |
| `rpc-sessions` registry | Cross-process session registry and reattach semantics | phase-2-gap. Per-session discovery files are only partial endpoint location, not a registry/reattach protocol | parent source: `6e147d58~1:packages/coding-agent/src/modes/rpc/rpc-mode.ts:892-907,984-992`; `6e147d58~1:packages/coding-agent/src/modes/shared/agent-wire/session-registry.ts:1-53`; docs/sdk.md §Endpoint discovery, §Architecture |
| Transport | stdio JSONL | transport-gap — closed by Phase 1 (`gjc sdk serve` + `gjc_sdk` typed Python client) | retired doc; Phase 1 approved plan; removal evidence `args.ts:117-127` |
| Transport | `--listen` Unix socket | transport-gap — closed by Phase 1 (`gjc sdk serve` + `gjc_sdk` typed Python client); replacement is not Unix-socket wire compatibility | parent source: `6e147d58~1:packages/coding-agent/src/cli/args.ts:157-158`; `6e147d58~1:packages/coding-agent/src/modes/rpc/rpc-mode.ts:892-971`; Phase 1 approved plan; docs/sdk.md §Endpoint discovery; removal evidence `args.ts:117-127` |

## Five-gap reduction verdict

SDK v3 has broad control/query coverage: the operation registry includes turn,
model, thinking, queue, compaction, retry, bash, session, host callback, and
workflow operations (`operation-registry.ts:66-166`), and control dispatch
implements the control path (`dispatch.ts:138-253`). That does **not** erase the
user-perceived reduction. It is **REAL** across five dimensions:

1. **stdio JSONL and Unix-socket transports.** Phase 1 (`gjc sdk serve` plus the
   typed `gjc_sdk` Python package) closes this transport/client gap, while not
   promising byte-for-byte JSONL or Unix-socket compatibility.
2. **Typed Python client.** Phase 1 closes the absence of a supported typed
   Python client through `gjc_sdk`.
3. **`negotiate_unattended`.** No fail-closed unattended negotiation with the
   retired declaration, budget, scope, and allowlist exists: this remains Phase 2.
4. **Cross-process session registry/reattach.** Discovery files locate a live
   endpoint but do not provide the retired registry or reattach lifecycle: this
   remains Phase 2.
5. **Renderer-grade full event stream.** SDK v3's minimal frames and optional
   threaded-client frames are not the retired canonical session event stream.
   **No event-plane parity is claimed.**

## Ranked Phase-2 follow-up register — NOT implemented

1. **Unattended negotiation equivalent — NOT implemented.** Add a fail-closed
   equivalent to `negotiate_unattended` only with explicit actor, budget, scopes,
   allowlist, and audit enforcement. Partial equivalent only: Q12
   `workflow.gates.list` plus the Coordinator MCP pull loop can enumerate and
   answer durable workflow gates; they are not unattended negotiation
   (`docs/sdk.md §Coordinator MCP question pull loop`).
2. **Reattach/registry — NOT implemented.** Define cross-process registry and
   reattachment semantics. Partial equivalent only: discovery files at
   `.gjc/state/sdk/<sessionId>.json` provide endpoint location and token for a
   live session (`docs/sdk.md §Endpoint discovery`); architecture explicitly says there is no
   shared upstream registry (`docs/sdk.md §Architecture`).
3. **Full event stream — NOT implemented.** Define a renderer-grade session
   event contract only if consumers require it. Partial equivalent only:
   `action_needed`, `action_resolved`, `reply_rejected`, and optional threaded
   frames such as `turn_stream` exist, but there is **no `onSessionEvent`-style
   SDK equivalent** (`docs/sdk.md §Server → client`).

## Completeness checklist

- [x] Prompting — every retired command represented.
- [x] State — every retired command represented.
- [x] Model — every retired command represented.
- [x] Thinking — every retired command represented.
- [x] Queue modes — every retired command represented.
- [x] Compaction — every retired command represented.
- [x] Retry — every retired command represented.
- [x] Bash — every retired command represented.
- [x] Session — every retired command represented.
- [x] Messages — every retired command represented.
- [x] Outbound and inbound frame categories — every retired category represented.
- [x] Workflow gate sub-protocol represented.
- [x] Extension UI sub-protocol represented.
- [x] Host tool sub-protocol represented.
- [x] Host URI sub-protocol represented.
- [x] `negotiate_unattended` sub-protocol represented.
- [x] `rpc-sessions` registry represented from parent-commit source (supplemental to the recovered document inventory).
- [x] stdio JSONL represented from the recovered document inventory; `--listen` Unix-socket transport represented from parent-commit source.
