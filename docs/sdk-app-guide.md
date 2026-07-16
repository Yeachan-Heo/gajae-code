# Building Applications on the Gajae-Code SDK

A beginner-friendly guide to using Gajae-Code as the **agent runtime for your own
application** — mobile apps, desktop apps, custom web frontends, chat bots, and
vertical AI products.

> Proof that this works in production: the bundled **Telegram, Discord, and Slack
> integrations are themselves ordinary SDK clients**. They use the exact same
> public contract described here — no private hooks, no upstream changes.

Related references:

- [SDK wire protocol & machine interfaces](./sdk.md) — the full WebSocket contract
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
- **A local machine interface is available by default.** Top-level sessions host
  a loopback WebSocket endpoint, so a client you build can observe actions and
  send replies without scraping a terminal. Remote transport, identity, and
  delivery remain your client's responsibility.
- **Many subscribers, one session.** The event stream supports multiple
  subscribers: your app UI, a configured remote client, and an audit logger can
  all watch the same session simultaneously.
- **Not just for coding.** Tools, skills, rules, and the system prompt are all
  injectable, so the same runtime powers legal assistants, research agents,
  data-analysis products — any vertical.


## The two surfaces (pick one, or combine)

| | Embedding SDK (in-process) | WebSocket SDK (out-of-process) |
| --- | --- | --- |
| What it is | Import `@gajae-code/coding-agent` as a library | Connect to a running session's loopback WS endpoint |
| Language | TypeScript / Bun (Node-compatible) | Any language (JSON frames) |
| Telemetry | Full: token deltas, tool events, session events | Curated: action/ask frames, summarized turn stream, queries |
| Trust model | You are the host — full access | Token-authenticated client — secrets are never exposed |
| Typical consumer | Your app's own UI and business logic | Bots, mobile clients, dashboards, orchestrators |

A common production shape uses **both**: your app UI is the in-process
subscriber (full-fidelity streaming), while a configured remote client attaches
over WebSocket for notifications and approvals.


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

## Quick start: attach from outside

Any running top-level session (including one your embedded app created) writes a
discovery file:

```
<repo>/.gjc/state/sdk/<sessionId>.json   →  { url, port, token, ... }
```

Connect with any WebSocket client (`ws://127.0.0.1:<port>/?token=<token>`), or
use the TypeScript transport package:

```bash
bun add @gajae-code/bridge-client
```

```ts
import { SdkClient } from "@gajae-code/bridge-client";
```

A minimal client only handles three frames:

- `action_needed` — a question needs an answer (`kind: "ask"`) or the agent is idle
- `action_resolved` — that action is no longer answerable
- `reply_rejected` — your reply failed (e.g. `already_answered`)

and sends one: `reply`. See [sdk.md](./sdk.md#minimal-client-example) for the
complete example and the optional threaded frames (`turn_stream`,
`context_update`, `activity`, `image_attachment`, …).

Beyond frames, the WS surface exposes typed **control operations**
(`turn.prompt`, `turn.steer`, `ask.answer`, `model.set`, `session.fork`,
`bash.execute`, …) and **queries** (`transcript.list/body`, `diff.*`,
`usage.get`, `models.list/current`, `workflow.gates.list`, …). See the
[SDK wire protocol & machine interfaces](./sdk.md) for the complete catalog.


## Creating and supervising sessions

Embedding creates a session directly with `createAgentSession()`. For an
external controller that needs lifecycle operations, use Coordinator MCP or the
public daemon-session CLI. A lifecycle CLI request names the `global` action,
provides its operation and JSON input, and supplies a caller-chosen idempotency
key:

```bash
gjc daemon session global --op session.create \
  --idempotency-key <unique-key> \
  --json-input '{"cwd":"/absolute/path/to/repo"}'
```

The CLI connects to the broker as needed; broker bootstrap is not an embedder
API. See the [external controller integration guide](./bot-integration.md#integration-surfaces)
for the supported controller surfaces and lifecycle constraints.


## Application recipes

- **Vertical AI app (delete your agentic loop).** Embed with `toolNames` +
  `customTools` + `skills` + a domain `systemPrompt`. Your product UI subscribes
  in-process for token-level streaming. Add remote notifications or approvals
  only after configuring, enabling, and completing the required credentials or
  pairing for a managed adapter, or after deploying your own WS client; see
  [managed notification adapters](./sdk.md#managed-notification-adapters).
- **Custom web app / dashboard.** Run sessions under the broker; your web
  backend attaches as a WS client, renders `turn_stream` snapshots, answers asks
  with `reply`, and reads history with `transcript.*` queries.
- **Mobile / desktop companion.** Build a client for the WS contract: discover
  endpoints, render `action_needed`, and send `reply`. Threaded frames give you
  live activity and context updates.
- **Fleet orchestrator.** Use Coordinator MCP or the documented daemon-session
  lifecycle operations to create and supervise many worktree-scoped sessions.

## What the WS surface deliberately does not do

So you design around it rather than fight it:

- **Loopback only.** Remote transport (like the Telegram daemon) is a
  client-side concern.
- **No secrets on the wire.** `config.patch` rejects secret fields;
  `session.get_endpoint` is prohibited through chat adapters and MCP.
- **Summarized streaming.** `turn_stream` is a throttled snapshot stream (no
  thinking tokens, redaction-gated). Full-fidelity token deltas are an
  in-process embedding capability.
- **Fail-closed action identity.** One active answerable presentation at a
  time; stale IDs never regain authority. Do not retry by matching text.

Destructive operations (`session.delete`, `context.clear`) require
`confirm: true`.

## FAQ

**Is embedding a subprocess?** No — it is a library import; the agent loop runs
in your process. Process isolation is what the broker/WS path is for.

**Can multiple clients watch one session?** Yes. Subscribers are additive on
both surfaces; replies to asks are arbitrated first-valid-wins.

**Can the TUI and my code share a session?** Concurrently: run the TUI and
attach your code as a WS client. Sequentially: sessions are `.jsonl` files —
resume/fork/handoff between your embedded app and `gjc`.

**I need full streaming in another language.** Today: spawn a session and use
the WS contract, or wrap the embedding SDK in a small TS host you own.
Dedicated embedding-like Rust/Python SDKs are tracked as roadmap issues.
