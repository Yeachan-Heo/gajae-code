# SDK

For managed control and notification attachment policy, see [the Gajae-Code SDK](./sdk.md).

The SDK is the in-process integration surface for `@gajae-code/coding-agent`.
Use it when you want direct access to agent state, event streaming, tool wiring, and session control from your own Bun/Node process.

For process-isolated control, use a managed SDK-core adapter backed by `SessionRouter`; raw endpoint discovery and direct WebSocket clients are not public integration surfaces.

## Installation

```bash
bun add @gajae-code/coding-agent
```


## Entry points

`@gajae-code/coding-agent/sdk` is the canonical entry point for embedders. The package root exports the same SDK APIs for convenience.

Core exports for embedders:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `discoverAuthStorage`
- Discovery helpers for retained context/prompt surfaces (`discoverContextFiles`, `discoverPromptTemplates`)
- Tool factory surface (`createTools`, `BUILTIN_TOOLS`, tool classes)

## Quick start (auto-discovery defaults)

```ts
import { createAgentSession } from "@gajae-code/coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

## What `createAgentSession()` discovers by default

`createAgentSession()` follows “provide to override, omit to discover”.

If omitted, it resolves:

- `cwd`: `getProjectDir()`
- `agentDir`: `~/.gjc/agent` (via `getAgentDir()`)
- `authStorage`: `discoverAuthStorage(agentDir)`
- `modelRegistry`: `new ModelRegistry(authStorage)` + background `refreshInBackground()` when the registry is not provided
- `settings`: `await Settings.init({ cwd, agentDir })`
- `sessionManager`: `SessionManager.create(cwd)` (file-backed)
- context files and prompt templates
- built-in tools via `createTools(...)`
- LSP integration (enabled by default)
- `eventBus`: new `EventBus()` unless supplied

### Required vs optional inputs

Typically you must provide only what you want to control:

- **Must provide**: nothing for a minimal session
- **Usually provide explicitly** in embedders:
  - `sessionManager` (if you need in-memory or custom location)
  - `authStorage` + `modelRegistry` (if you own credential/model lifecycle)
  - `model` or `modelPattern` (if deterministic model selection matters)
  - `settings` (if you need isolated/test config)

## Session manager behavior (persistent vs in-memory)

`AgentSession` always uses a `SessionManager`; behavior depends on which factory you use.

### File-backed (default)

```ts
import { createAgentSession, SessionManager } from "@gajae-code/coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

console.log(session.sessionFile); // absolute .jsonl path
```

- Persists conversation/messages/state deltas to session files.
- Supports resume/open/list/fork workflows.
- `session.sessionFile` is defined.

### In-memory

```ts
import { createAgentSession, SessionManager } from "@gajae-code/coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

console.log(session.sessionFile); // undefined
```

- No filesystem persistence.
- Useful for tests, ephemeral workers, request-scoped agents.
- Session methods still work, but persistence-specific behaviors (file resume/fork paths) are naturally limited.

### Resume/open/list helpers

```ts
import { SessionManager } from "@gajae-code/coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

## Model and auth wiring

`createAgentSession()` uses `ModelRegistry` + `AuthStorage` for model selection and API key resolution.

### Explicit wiring

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@gajae-code/coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const available = modelRegistry.getAvailable();
if (available.length === 0)
  throw new Error("No authenticated models available");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model: available[0],
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(),
});
```

### Selection order when `model` is omitted

When no explicit `model`/`modelPattern` is provided:

1. restore model from existing session (if restorable + key available)
2. settings default model role (`default`)
3. first available model with valid auth

If restore fails, `modelFallbackMessage` explains fallback.

### Auth priority

`AuthStorage.getApiKey(...)` resolves in this order:

1. runtime override (`setRuntimeApiKey`)
2. stored credentials in `agent.db`
3. provider environment variables
4. custom-provider resolver fallback (if configured)

## Event subscription model

Subscribe with `session.subscribe(listener)`; it returns an unsubscribe function.

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "tool_execution_start":
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
  }
});
```

`AgentSessionEvent` includes core `AgentEvent` plus session-level events:

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `agent_failed` (diagnostic failure for the current attempt; the correlated
  terminal `agent_end` still follows and remains the lifecycle boundary)
- `retry_fallback_applied` / `retry_fallback_succeeded`
- `ttsr_triggered`
- `todo_reminder` / `todo_auto_clear`
- `irc_message`

## Prompt lifecycle

`session.prompt(text, options?)` is the primary entry point.

Failure consumers should handle `agent_failed` as an additive diagnostic event,
not as terminal completion. It carries only the sanitized `{ code, message }`
diagnostic for the correlated attempt — never the raw provider/local error —
so consumers must not depend on provider-specific detail or raw error objects;
continue waiting for `agent_end` before releasing prompt ownership, deadlines,
or transport resources. This ordering also applies when the run is canceled or
enters a maintenance continuation.

Behavior:

1. optional command/template expansion (`/` commands, custom commands, file slash commands, prompt templates)
2. if currently streaming:
   - requires `streamingBehavior: "steer" | "followUp"`
   - queues instead of throwing work away
3. if idle:
   - validates model + API key
   - appends user message
   - starts agent turn

### Queued input lifecycle

Keep admission, consumption, and completion separate when embedding the SDK:

| Session state | Admission | Consumption | Completion |
| --- | --- | --- | --- |
| Fresh or settled idle with an assistant tail | `prompt()` starts a turn; an explicit `followUp` is accepted into the executable queue | The next turn consumes the queued message and normally starts its own run | That run publishes its own terminal `agent_end` |
| Live model/tool loop | `steer` may be consumed by the current run; `followUp` waits for the next turn | The live loop can consume the message before its terminal boundary | The message may share the current run and terminal; it is not necessarily a separate model call |
| Prompt unwind after the Agent loop emitted `agent_end` | An explicit `followUp` is still accepted | The SDK schedules a queued-only successor after the unwind finishes; it is not left waiting for an unrelated prompt | The successor owns a new run and terminal boundary |
| Paused, cancelled, or a non-resumable non-assistant tail | The message can remain queued | No automatic successor is promised until a supported resume/abort path makes the queue deliverable | The admission is not completion; clear/remove the queue or resume it explicitly |
| Existing queued input ahead of a new submission | The new message is ordered behind the existing queue | Queue order is preserved; later plain prompts do not overtake an earlier follow-up | Each consumed message is correlated at its actual dequeue boundary |

`session.waitForIdle()` waits for active Agent work, session settlement, and
continuations that the SDK has scheduled. It is **not** a receipt that every
steering/follow-up queue is empty. Inspect `pendingMessageCounts` or use the
queue APIs when queue state matters. A queued follow-up can also share the
predecessor's run and terminal when the live loop consumes it; do not equate
one accepted submission with one model call or one `agent_end` event.

Generic embedders can use `session.submitQueuedInput()` for independently
correlated live controls, or an application-owned queue of bounded
`session.prompt()` calls for full turns. The `sendUserMessage` promise still has
delivery-mode dependent completion semantics:

- An ordinary idle submission with no `deliverAs` queues nothing and awaits the
  prompt turn, including its terminal completion.
- An explicit queued `steer`/`followUp`, or a submission diverted into a queue
  because a live turn is active, resolves when the submission is admitted to
  that delivery path. Use supported session events to correlate its later
  consumption, completion, and cancellation.

Neither promise is a generic queue-drained receipt. Do not build a generic
embedder contract around internal dispatch or promotion-correlation hooks.

### Supported queued-submission ownership

`submitQueuedInput(text, { mode: "steer" | "followUp", images?, queuePolicy? })`
returns a `QueuedInputSubmission` with a stable `submissionId` and `cancel()`.
Subscribe **before** submission: admission and even consumption may be published
before the returned promise resolves. `QueuedInputEvent` is exported from
`@gajae-code/coding-agent` and is part of `AgentSessionEvent`.

```ts
const unsubscribe = session.subscribe(event => {
  switch (event.type) {
    case "queued_input_admitted":
      // Record event.submissionId and the actual event.mode.
      break;
    case "queued_input_consumed":
      // Bind this exact submission to event.runId and consumption attempt scope.
      // startsOwnRun distinguishes successor promotion from joining a run.
      break;
    case "queued_input_removed":
      // Finish this submission as removed, without waiting for any agent_end.
      break;
    case "queued_input_terminal":
      // event.terminal is the owning run's published agent_end.
      break;
  }
});
const submission = await session.submitQueuedInput("Check the result", {
  mode: "followUp",
  queuePolicy: "sequential",
});
// submission.cancel() removes only this input while still queued; it returns
// false after consumption/removal and never aborts the owning run.
```

Each admission has its own identity even when text is identical. Consumption
binds to actual executable dequeue, not disappearance from a display queue.
`startsOwnRun: false` means the input joined the current run; `true` means it was
promoted into a new run. `runId` is the logical owning run across attempt-scope
changes during retry or maintenance. Only that run's final published terminal
completes a consumed submission; continuing maintenance boundaries do not. Removal or
cancellation before execution instead emits `queued_input_removed` immediately.
An idle steer may be admitted as a follow-up by the existing continuation rules;
the admission event reports the actual mode.

If continuation fails before a run is accepted (for example, no model is
configured), surviving dequeued inputs return to their executable queue ahead of
newer admissions. Their submission identities remain pending and cancellable;
no consumption or terminal success is fabricated. A later supported continuation
can deliver them after the admission problem is corrected.

`queuePolicy: "sequential"` delivers one submission per queue poll in FIFO order
within either selected queue, overriding its default batching mode. It does not
promise a separate run per message or impose ordering between the steering and
follow-up queues. Follow-ups admitted during predecessor unwind retain automatic
successor scheduling. These events are in-process lifecycle observations, not a
durable receipt across process restart; use SDK reconciliation for that boundary.
Unsubscribe when the embedder no longer needs lifecycle events.

Related APIs:

- `sendUserMessage(content, { deliverAs? })`
- `submitQueuedInput(text, { mode, images?, queuePolicy? })`
- `steer(text, images?)`
- `followUp(text, images?)`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

## Tools integration

### Built-ins and filtering

- Built-ins come from `createTools(...)` and `BUILTIN_TOOLS`.
- `toolNames` acts as an allowlist for built-ins.
- Hidden tools (for example `yield`) are opt-in unless required by options.

```ts
const { session } = await createAgentSession({
  toolNames: ["read", "search", "find", "write"],
  requireYieldTool: true,
});
```

### Runtime tool set changes

`AgentSession` supports runtime activation updates:

- `getActiveToolNames()`
- `getAllToolNames()`
- `setActiveToolsByName(names)`

System prompt is rebuilt to reflect active tool changes.

## Discovery helpers

Use these when you want partial control without recreating internal discovery logic:

- `discoverAuthStorage(agentDir?)`
- `discoverContextFiles(cwd?, _agentDir?)`
- `discoverPromptTemplates(cwd?, agentDir?)`
- `buildSystemPrompt(options?)`

## Subagent-oriented options

For SDK consumers building orchestrators (similar to task executor flow):

- `outputSchema`: passes structured output expectation into tool context
- `requireYieldTool`: forces `yield` tool inclusion
- `taskDepth`: recursion-depth context for nested task sessions
- `parentTaskPrefix`: artifact naming prefix for nested task outputs

These are optional for normal single-agent embedding.

## `createAgentSession()` return value

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  modelFallbackMessage?: string;
  lspServers?: Array<{
    name: string;
    status: "ready" | "error";
    fileTypes: string[];
    error?: string;
  }>;
  eventBus: EventBus;
};
```

Use `setToolUIContext(...)` only if your embedder provides UI capabilities that tools should call into.

## Startup performance

`createAgentSession()` runs two background optimizations to overlap I/O with the rest of session setup:

- **Model-host preconnect.** As soon as the model is resolved, the SDK fires a best-effort `fetch.preconnect(model.baseUrl)` so DNS + TCP + TLS + HTTP/2 to the provider's host happens in parallel with tool registry build, and system-prompt assembly. The first real `fetch(...)` then reuses the warm connection, saving 100–300 ms on transcontinental hops (e.g. residential IP → `api.anthropic.com`). Implementation lives in `preconnectModelHost()` in `packages/coding-agent/src/sdk/session.ts`. If `fetch.preconnect` is unavailable (non-Bun runtime) or the call throws, the optimization is silently skipped — never a hard dependency. Applies to interactive, print, and ACP modes.
- **Conditional LSP warmup.** Startup LSP servers (those returned by `discoverStartupLspServers(cwd)`) are only warmed when **all** of these hold:
  - `enableLsp !== false` on the session options, **and**
  - `options.hasUI === true` (interactive TUI), **and**
  - the `lsp.diagnosticsOnWrite` setting is enabled.

  Print, script, and ACP invocations (`hasUI=false`) skip the warmup entirely: they don't render the warmup status indicator and typically finish before the language servers would stabilize, so warming them just spends CPU parsing big `initialize` responses concurrently with the LLM stream consumer and jitters perceived latency. Tools that actually need an LSP server still spin one up on demand through `getOrCreateClient()` — only the *startup* warmup is skipped. The returned `lspServers` field in `CreateAgentSessionResult` is therefore `undefined` (not an empty array) whenever the warmup branch was bypassed.

## Minimal controlled embed example

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@gajae-code/coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
  "compaction.enabled": true,
  "retry.enabled": true,
});

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  sessionManager: SessionManager.inMemory(),
  toolNames: ["read", "search", "find", "edit", "write"],
  enableLsp: true,
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Find all TODO comments in this repo and propose fixes.");
await session.dispose();
```
