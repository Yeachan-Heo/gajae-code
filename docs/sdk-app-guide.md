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
