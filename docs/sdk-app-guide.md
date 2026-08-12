# Building Applications on the Gajae-Code SDK

A beginner-friendly guide to using Gajae-Code as the **agent runtime for your own
application** — mobile apps, desktop apps, custom web frontends, chat bots, and
vertical AI products.

> Proof that this works in production: the bundled **Telegram, Discord, and Slack
> integrations are SDK-core managed adapters**. They use opaque Router attachments
> and provider-neutral presentation contracts rather than private endpoint credentials.

Related references:

- [SDK wire protocol & machine interfaces](./sdk.md) — internal wire semantics and supported managed adapters
- [Embedding SDK](./sdk-embedding.md) — the in-process TypeScript API
- [External control readiness](./external-control-readiness.md) — supported surfaces

## Why build on Gajae-Code?

Every vertical AI app ends up needing the same backend pieces: an agentic loop,
tool execution, session persistence, model/auth management, streaming, retries,
and compaction. Some also need a configured remote-notification integration.
Teams keep rebuilding these from scratch.

Gajae-Code packages the runtime as a reusable component:

- **Drop the agentic loop from your codebase.** `createAgentSession()` gives you
  a production agent loop (tools, retries, compaction, session files, model
  fallback chains) in one call.
- **A managed machine interface is available.** Top-level sessions host an internal
  loopback endpoint, while SDK-core `SessionRouter` retains its discovery record,
  credentials, replay cursor, and exact attachment authority. Applications use
  Coordinator MCP, the SDK session CLI, or a configured managed adapter rather
  than opening that endpoint directly.
- **Many subscribers, one session.** In-process subscribers and configured managed
  adapters can observe the same session without sharing endpoint credentials.
- **Not just for coding.** Tools, skills, rules, and the system prompt are all
  injectable, so the same runtime powers legal assistants, research agents,
  data-analysis products — any vertical.


## Managed masters for application orchestration

Use the managed **master** daemon when your application needs a durable
orchestrator that can own several workers, keep decisions and provider effects
across restarts, and expose one aggregate control surface. A master is not a
normal top-level session with fewer prompt options, and its endpoint is not the
ordinary SDK v3 endpoint described in the table below.

### Create and configure masters

```sh
gjc master create <name> [--workdir <path>] [--max-concurrent-workers <n>]
gjc master list [--json]
gjc master configure <name> --max-concurrent-workers <n>
```

Names use `[a-z][a-z0-9-]{0,62}`. A create workdir must be a real canonical
directory admitted by the frozen Coordinator authority. Each master defaults to
`maxConcurrentWorkers: 3`; configured capacity is a positive safe integer
(`>= 1`). `configure` changes only capacity. The command persists the record
before reloading the managed daemon, so a reload failure leaves a stopped,
recoverable record.

Master state is private and global to GJC under `$GJC_HOME/master` (normally
`~/.gjc/master`), not under an app repository's `.gjc` directory. The root
contains daemon ownership/heartbeat, aggregate events, per-master queue,
workers, ownership, claims, decisions, channels, presentation outbox, and the
master's transcript/blob/resident-cache storage. Provider workers execute leased
side effects and never write this root.

### Master SDK v1 versus ordinary SDK v3

A master-aware app reads `$GJC_HOME/master/sdk/master-daemon.json`:

```json
{
  "version": 1,
  "protocolVersion": 1,
  "url": "ws://127.0.0.1:<port>/master",
  "token": "<private token>",
  "pid": 12345,
  "startedAt": "<UTC ISO timestamp>",
  "heartbeatAt": "<UTC ISO timestamp>"
}
```

The v1 server binds to `127.0.0.1` and requires the discovery token in the
query string; a missing or wrong token returns HTTP `401`. Its `hello` frame
advertises `master-sdk-v1`. This is a different discovery/protocol contract
from the ordinary per-session v3 file `<repo>/.gjc/state/sdk/<sessionId>.json`.
Use v1 frames (`subscribe`, `get_snapshot`, `get_queue_page`,
`master_user_message`, claim operations, provider-effect operations, and
`ping`) rather than v3 `turn.*` or `session.*` operations. The v1 event sequence
is globally contiguous: snapshot subscriptions establish a cut, cursor
subscriptions replay retained events in order, and a replay gap requires a
fresh resync. Queue pagination uses a null first cursor and explicit page
resync for stale cursors.

### What a master can do

The master AgentSession has exactly these orchestration tools:

```text
master_queue_list
master_queue_enqueue
master_queue_assign
master_worker_create
master_worker_observe
master_worker_follow_up
master_record_decision
master_escalate
master_claim_request
master_memory_read
master_memory_write
```

There is no filesystem, edit, write, bash, image, web, goal, LSP, generic
provider, MCP, extension, skill, rule, or workspace-discovery capability. There
is no bundled/default skill or agent. Doctrine is loaded from the master state
as evidence; the model cannot edit doctrine or repository/product code.

Worker lifecycle uses only the frozen Coordinator operations
`gjc_coordinator_start_session`, `gjc_coordinator_send_prompt`,
`gjc_coordinator_await_turn`, and `gjc_coordinator_register_session`. The
Coordinator's roots, mutation classes, explicit state root, namespace, and
session command are frozen and fingerprinted; a changed authority blocks
rather than widening access. Master-created workers are started without a
prompt, receive master ownership before prompt delivery, quarantine pre-active
observations, and become active only after the idempotent prompt is proven.
Worker leases and observations are independent. Snapshots expose worker
session/task/owner/lifecycle identity; user-owned workers remain in the direct
user path.

Ownership claims are two-step. Provider ingress mints an opaque expiring
authorization, the model consumes it once with `master_claim_request`, and a
distinct second authenticated interaction from the same actor approves it via
the endpoint. Models cannot mint or approve claims.

### Capacity and provider semantics

Admission requires `capacityState: "within_limit"` and
`activeWorkerCount < maxConcurrentWorkers`. Reducing capacity never revokes a
worker. Counts above the new limit persist as `draining_over_capacity`; no new
lease is admitted while draining, equality is still not enough for admission,
and independent terminal releases must bring the count strictly below the new
limit. The state survives restart.

Master v1 currently has Telegram and Discord provider bindings. At least one
configured provider with an active reconciled binding is enough for turns. Zero
active providers is `channel_blocked` with `no_active_provider`. A binding can
remain active while its provider is degraded because a presentation is pending;
that provider is represented as both active and degraded, while a healthy second
provider keeps the master available.

Availability does not waive eventual delivery. Every presentation event has a
per-provider durable outbox row with stable effect identity, nonce, fence, and
lease. Receipt cursors advance only after exact reconciliation. On provider
recovery, pending rows replay in that provider's original event order and the
provider is marked recovered only when the backlog is zero. Telegram uses
`Master · <name>` topics and Discord uses `master-<name>` threads. Chat daemons
perform leased provider I/O and return receipts; they do not write master state.

### Memory boundary

The master profile disables ordinary product memory. An injected v1
`MemoryContract` with global-scope `read`, `write`, and `subscribe` is the sole
memory path. Read/write activity is emitted as `memory_activity`; an unavailable
contract records unavailable evidence without making durable queue or worker
state non-authoritative.

For a normal application session, continue with the embedding or WebSocket SDK
v3 surfaces below. For a durable orchestrator, use the master v1 discovery,
strict frames, snapshot/event replay, and provider-effect leases above; do not
mix the two endpoint contracts.

## The two supported integration surfaces

| | Embedding SDK (in-process) | Managed external control |
| --- | --- | --- |
| What it is | Import `@gajae-code/coding-agent` as a library | Use Coordinator MCP, SDK session CLI, or a configured Telegram/Discord/Slack adapter |
| Language | TypeScript / Bun (Node-compatible) | Any client capable of the selected MCP/CLI/provider interface |
| Telemetry | Full token deltas, tool events, and session events | Curated provider-neutral frames and queries |
| Trust model | Your process hosts the runtime | SDK core retains endpoint credentials and issues exact opaque attachments |
| Typical consumer | Your app UI and business logic | Bots, dashboards, and orchestrators |

A common production shape combines an in-process UI with one or more configured
managed adapters. Applications never discover endpoint records or open raw session
WebSockets.


## Quick start: embed the runtime

```bash
bun add @gajae-code/coding-agent
```

```ts
import { createAgentSession } from "@gajae-code/coding-agent";

const { session } = await createAgentSession();

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta); // token-level stream
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
await session.dispose();
```

`createAgentSession()` follows *provide to override, omit to discover*: with no
options it auto-discovers auth, models, settings, tools, context files, and a
file-backed session store. Everything is overridable.

## Customizing the runtime for your vertical

This is the part that turns Gajae-Code from "a coding agent" into a general
execution runtime. All of the following are `createAgentSession()` options; see
the [Embedding SDK](./sdk-embedding.md) for the public API.

### Restrict or drop tools

```ts
const { session } = await createAgentSession({
  // Allowlist of built-ins — everything else is dropped.
  toolNames: ["read", "grep", "find"],
  // Optionally restrict bash to specific command prefixes.
  bashAllowedPrefixes: ["git status", "git log"],
});
```

Runtime changes are also supported: `session.getActiveToolNames()`,
`session.getAllToolNames()`, `session.setActiveToolsByName(names)` — the system
prompt is rebuilt automatically.

### Add custom tools

```ts
const { session } = await createAgentSession({
  toolNames: ["read"],
  customTools: [myDomainTool], // CustomTool | ToolDefinition
  // Or bring tools from an MCP server you own:
  mcpConfigPath: "/abs/path/to/mcp-config.json",
});
```

### Inject skills, rules, and identity

```ts
const { session } = await createAgentSession({
  skills: myVerticalSkills,        // replaces bundled skill discovery
  rules: myRules,
  contextFiles: [{ path: "DOMAIN.md", content: domainKnowledge }],
  systemPrompt: (defaults) => [...defaults, myVerticalPromptBlock],
  promptTemplates: myTemplates,
});
```

### Isolate state for request-scoped agents

```ts
import { SessionManager, Settings } from "@gajae-code/coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(), // no filesystem persistence
  settings: Settings.isolated({ "compaction.enabled": true }),
});
```

### Structured-output subagents

`outputSchema`, `requireYieldTool`, `taskDepth`, and `parentTaskPrefix` support
orchestrator patterns where a session must return machine-readable results.

### Observability

Pass `telemetry: {}` to enable OpenTelemetry GenAI-semantic-convention spans
(no-op unless an OTEL SDK is registered in your host).

## Attach from another process

Process-isolated integrations use an SDK-core adapter backed by `SessionRouter`. Endpoint discovery records and bearer tokens are internal implementation details; applications must not read them or open raw session WebSockets.

Managed adapters receive opaque `SessionAttachment` capabilities for live controls and submit lifecycle mutations through `SessionLifecycleService`. See [sdk.md](./sdk.md) for the ownership and adapter contract.

The `models.list/current` (Q10) catalog also lists model profiles as synthetic
`gajae-code/<profile>` entries (e.g. `gajae-code/codex-eco`). Treat them as
logical selections, not API providers: sending the id back through `model.set`
activates the profile for the live session only. Persisting remains an explicit
TUI choice. Request Q27 (`models.profiles.list`) when you need the
full profile catalog including unavailable profiles and their `available`
status. See [Model profiles as synthetic models](./sdk.md#model-profiles-as-synthetic-models-gajae-codeprofile).

## Creating and supervising sessions

Embedding creates a session directly with `createAgentSession()`. For an
external controller that needs lifecycle operations, use Coordinator MCP or the
SDK session CLI. A lifecycle CLI request names the `global` action,
provides its operation and JSON input, and supplies a caller-chosen idempotency
key:

```bash
gjc sdk session raw global --op session.create \
  --idempotency-key <unique-key> \
  --json-input '{"cwd":"/absolute/path/to/repo"}'
```

The CLI connects to the broker as needed; broker bootstrap is not an embedder
API. See the [external controller integration guide](./bot-integration.md#integration-surfaces)
for the supported controller surfaces and lifecycle constraints.


## Application recipes

- **Vertical AI app.** Embed with `toolNames`, `customTools`, `skills`, and a domain
  `systemPrompt`. Subscribe in-process for full-fidelity streaming.
- **Custom web app or dashboard.** Keep the agent runtime in your backend process;
  expose your own authenticated product API, or use Coordinator MCP for supported
  external orchestration. Do not relay the internal session endpoint.
- **Mobile or desktop companion.** Pair through a configured managed notification
  adapter for actions and approvals, or call an application backend that embeds GJC.
- **Fleet orchestrator.** Use Coordinator MCP or daemon-session lifecycle operations
  to create and supervise worktree-scoped sessions.

## External interface constraints

- Endpoint records, bearer tokens, and raw session WebSockets are private SDK-core
  implementation details.
- `config.patch` rejects secret fields, and `session.get_endpoint` is prohibited on
  public adapters.
- Full-fidelity token deltas remain an in-process embedding capability.
- Action identity is fail-closed: stale IDs never regain authority.

Destructive operations (`session.delete`, `context.clear`) require
`confirm: true`.

## FAQ

**Is embedding a subprocess?** No — it is a library import; the agent loop runs
in your process. Process-isolated control uses Coordinator MCP, SDK session CLI,
or a configured managed adapter.

**Can multiple consumers watch one session?** Yes. In-process subscribers and
managed adapters are additive; replies to asks remain first-valid-wins.

**Can the TUI and my code share a session?** Use in-process embedding for code that
hosts the runtime, or Coordinator MCP/managed adapters for process-isolated control.
Session files remain resumable through canonical lifecycle operations.

**I need another language.** Use Coordinator MCP or your own authenticated backend
around the TypeScript embedding SDK. Dedicated embedding-like Rust/Python SDKs are
roadmap work, not raw endpoint contracts.
