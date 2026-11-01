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

### Settings catalog and layer provenance

`getSettingsCatalog(settings)` returns a detached, read-only schema snapshot, not
mutation authority or a managed operation. It includes schema paths, choices,
scalar display values and `settings.getResolutionSnapshot()` provenance.
Scalar origins follow `global < project < runtime`; `default` means the merged
leaf is absent, including when a higher layer replaces its ancestor. `layers`
lists permitted layers declaring the path, even when a higher ancestor replacement
erases it. Object origin `layered` describes construction, not per-leaf provenance.
`resolution.allowedLayers` describes merge policy, not filesystem write permission.

All free-form strings and compound values are withheld, including endpoints,
headers and command snippets. Secret-shaped paths are withheld using the shared
SDK classifier. Only typed booleans, finite numbers and declared enums are displayed;
withheld does not mean unset. UI metadata is not a promise that a terminal row is
visible. Runtime choices report `host-required` and unaudited application timing
reports `unclassified`. This catalog does not install a writer or replace the
notification-atomic editor's ownership. Full settings UI parity remains incomplete.

```ts
import { getSettingsCatalog } from "@gajae-code/coding-agent/sdk";
const catalog = getSettingsCatalog(session.settings);
// durableStorage is storage capability, not an individual save receipt.
```

### Atomic settings batches

`settings.commitAtomicBatch(patches)` writes one file under a single-file CAS: the patch
set is applied to `config.yml` through a staged temp file with fsync, an identity-checked
publish. Cross-file atomicity is **not** provided. A caller that needs to undo a committed
change after activation fails must explicitly call `receipt.restore()`; restoration uses
path-level CAS and refuses to overwrite a newer writer.

```ts
const receipt = await settings.commitAtomicBatch([
	{ path: "temperature", op: "set", value: 0.4 },
]);
// receipt.revisions: path-level before/after hashes and opaque revisions
//   (populated for in-memory Settings.isolated() batches too).
const restored = await receipt.restore();
// status is "restored", "conflict", "discarded", or "not-restorable".
// "restored" includes an independently owned inverse receipt.
// A conflict means a newer writer owns one of the paths; nothing is overwritten.
```

`settings.flush()` and `settings.flushOrThrow()` reserve the pending debounced save so it
cannot be overtaken. A caller that holds an active YAML lease cannot flush that file and
gets `Cannot flush Settings for busy atomic YAML file`; `flush()` resolves after a failed
background save while `flushOrThrow()` rejects.

### Required vs optional inputs

Typically you must provide only what you want to control:

- **Must provide**: nothing for a minimal session
- **Usually provide explicitly** in embedders:
  - `sessionManager` (if you need in-memory or custom location)
  - `authStorage` + `modelRegistry` (if you own credential/model lifecycle)
  - `model` or `modelPattern` (if deterministic model selection matters)
  - `settings` (if you need isolated/test config)

### Local notification setup

`createNotificationsEditorOperations({ settings, session, sessionManager })` is
the same trusted service used by the TUI. Mutations and external runtime actions
require writable durable settings; memory-only settings cannot configure or start
a notification daemon. Inactive saves reconcile the current session and report
reconciliation failure separately from successful persistence.

Keep prepared Telegram/provider configurations inside the trusted host. They are
frozen, instance-bound, one-shot authority, not renderer JSON. Forward display data
only, bind renderer actions to retained objects, discard on cancellation, and prepare
a fresh draft after a consumed commit attempt. Forged/copied/foreign/replayed
provider drafts return `invalid_draft` without saving bindings. Secret inputs use
`NotificationSetupSecretValue`; never serialize them into renderer state or queries.

Foreign or unknown Telegram daemon identity prevents activation, but permits an
inactive save or discard. Active commit rechecks identity before writing without
locking out external daemon changes. Single-file CAS restoration preserves newer
writers; it does not make configuration and runtime activation cross-file atomic.
Health diagnostics and free-form daemon metadata redact configured provider tokens
and their fingerprints. Recovery endpoint identities and filesystem/path metadata
can still contain sensitive values: keep raw recovery reports inside the trusted
host and sanitize display data before forwarding it. Unknown foreign secrets
cannot be recognized reliably.

Treat runtime-fence and restore-marker failures as degraded: a blocked reconnect
can fail to establish a durable inactive marker. A restore-time marker conflict
may not protect the restored identity or notify observers of retained markers, and
a blocked reconnect after both receipts restore does not establish a marker for
the restored identity. Successful persistence is not proof of successful activation.

### Smart-routing intents and live sampling

`createRoutingSettingsService({ settings, getCatalog, getProviderOrder, isScoped,
activate })` exposes the same preview/apply/refresh/clear/enable intents used by the
TUI. Keep previews inside the trusted host: their display fields are detached from
instance-bound authority, and copied/forged/foreign/discarded previews cannot authorize
writes. Hand-edit confirmation is bound to the exact guarded state and refresh proof;
catalog drift or intervening edits require fresh review instead of silent replacement.
The host must serialize scope changes through each operation's completion.

Refresh regenerates global configuration from the current provider order. Effective
project/runtime overlays remain distinct from persisted global state. Outcomes report
`durability` and `activation` separately; activation-notification failure attempts
single-file CAS restore, preserving newer writers. Restore conflict/failure invalidates
shared authority on that Settings instance; opening another service over stale Settings
does not regain write authority. Reload durable Settings before fresh review. Failed
post-commit view refresh is not evidence that persistence failed.

Sampling changes to `temperature`, `topP`, `topK`, `minP`, `presencePenalty` and
`repetitionPenalty` now reach sessions through Settings' synchronous `apply` phase,
before schema hooks or ordinary observers can start a run. In-flight model runs retain
their captured sampling; later runs use the newly effective values. These six catalog
entries therefore report `next-run`; other unaudited application timing stays
`unclassified`. Session disposal unregisters the listener. Settings UI reads and writes
the active session's Settings rather than a process-global singleton.

### Builtin slash commands over a host transport

Import `ACP_BUILTIN_SLASH_COMMANDS` and `executeAcpBuiltinSlashCommand` from
`@gajae-code/coding-agent/sdk`. The catalog advertises only text-mode handlers
allowed over ACP; it is not the full TUI command list or an authorization grant.
A host must still enforce its own session-rotation and installed-capability policy.

Call `executeAcpBuiltinSlashCommand(text, runtime)` and dispatch its result:

- `false`: not handled; forward the original text through the host's normal prompt path.
- `{ consumed: true }`: handled (including refusal diagnostics); do not start a model turn.
- `{ prompt: string }`: handled with a residual prompt; forward that prompt rather than the original text.

Handlers returning `undefined` are normalized to `{ consumed: true }`. Recognized
commands disallowed over ACP emit an unavailable diagnostic and are consumed.
Other diagnostic-only results can also be consumed; do not infer a model prompt
from absence in the advertised catalog.

`runtime` supplies the matching `session`, `sessionManager`, `settings`, `cwd`,
and three required callbacks: `output(text)` emits operator-visible command text,
`refreshCommands()` re-advertises commands (a non-ACP host may use a no-op), and
`reloadPlugins()` reloads caches and registries and re-advertises them. Optional
`notifyTitleChanged()` and `notifyConfigChanged()` notify host views after changes.
The SDK does not supply a host's plugin-reload or view-notification implementation.

With `{ disabledOnly: true }`, transport-disallowed commands are still refused
and consumed, but enabled commands return `false` without executing. This mode
supports an ACP refusal-policy prepass, not execution of the advertised commands.

### Portable extension interactions and owned jobs

`ExtensionInteractionService` and `JobObservation` are trusted host compositions,
not new managed operations or proof of TUI parity. They are public SDK/root exports.

Construct an interaction service for one session ID, admit a renderer with
`connect()`, and keep its connection ID private to that renderer. Install
`service.ui` through `result.setToolUIContext(service.ui, true)`. Separately call
`initializeExtensions(session, { uiContext: service.ui, reportSendError,
reportRuntimeError, onShutdown })` to initialize extension/function-hook context
and emit `session_start`; it is not a repeatable UI setter.

`subscribe()` and `snapshot()` expose bounded detached pending requests. Replies
require matching session, connection and request IDs. Reconnect rotates responder
authority while retaining pending requests. Unsupported terminal/dialog callbacks
fail explicitly. A reply, including workflow approval, grants no execution permission.

The host must call `service.dispose()` **before** awaiting `session.dispose()`
and before replacing session identity. Disposal settles pending requests and
refuses later requests, including those from awaited shutdown handlers. Also
register `session.registerToolSessionCleanup(() => service.dispose())` as an
idempotent safety net: cleanup runs after shutdown handlers, so it cannot unblock
a handler waiting for an already-disconnected renderer.

`result.jobObservation` lazily returns one stable view captured from the factory's
actual background manager and agent owner, not the transcript session ID or the
process-global manager. It is unavailable without a manager, or when first read
after disposal. Snapshots filter jobs, task identities and cron schedules by owner.
Monitor actions require observed generations; cron deletion requires observed
`createdAt`. Folded work is read-only and terminal cancellation refuses with
`already_terminal`. Session cleanup disposes an existing view; stale handles refuse
work, and a manually disposed view is never silently recreated.

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

### Live session task-role selections

`session.setSessionAgentModelSelection(role, model)` selects a concrete available model for `executor`, `planner`, `critic` or `architect` without changing the main model, thinking level or shared `Settings`. These choices last only for the live session: passing `null` removes the session choice and reveals the current inherited profile/configuration. `getAgentModelOverrides()` returns a cloned effective selector map; `hasSessionAgentModelOverride(role)` distinguishes the session-owned source. Real task dispatch, detached task snapshots and eager-delegation prompts consume the same map. Successful explicit profile or session-identity replacement retires choices; failed activation/transition and ordinary configuration refresh preserve them. Default model selection remains the separate durable `setDefaultModelSelection` operation. These are in-process APIs, not new transport mutation authority.

### Automatic session titles

Call `session.generateAutoSessionTitle(text, { signal })` independently at first accepted input, before its first user message is recorded. It reuses SDK model/credential/obfuscation logic and returns `applied`, `skipped` (with a reason), or `failed`; it never changes prompt delivery. Do not seed a display placeholder using a user-sourced name. Existing/manual names win, duplicate generation is coalesced, and session identity/lifecycle changes fence late completion. Hosts must abort their signal synchronously before retiring/replacing the live owner and must recheck ownership before publishing derived metadata. A successful result has committed the SDK title; a redundant application catalog cache can be reconciled from it on reopening. No generation transport operation is implicitly admitted.

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

If restore fails, `modelFallbackMessage` explains the outcome. Without a usable
explicit key, an unavailable saved credential pin leaves the model unselected
with an actionable diagnostic rather than silently switching model or provider.

### Auth priority

`AuthStorage.getApiKey(...)` resolves in this order:

1. runtime override (`setRuntimeApiKey`)
2. stored credentials in `agent.db`
3. provider environment variables
4. custom-provider resolver fallback (if configured)

An unavailable saved credential pin blocks implicit fallback to another stored
account. An explicit runtime key or literal provider key registered by the
current model registry can override that availability failure without clearing
the unavailable-pin marker. Another registry's key or an `apiKeyEnv` indirection
must not authorize selection of a different stored account.

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

For generic embedders, prefer an application-owned queue of bounded full turns
submitted through `session.prompt()`, and use `steer`/`followUp` only for live
conversational controls. When a queued control must remain pending until its
exact ownership is known, use `submitUserMessage()`:

```ts
const submission = await session.submitUserMessage("refresh the status", {
  deliverAs: "followUp",
  queuePolicy: "sequential",
  trackSubmission: true,
});

await submission.admitted;
const execution = await submission.execution;
// execution.disposition is "joined-current-run", "promoted-to-run", or "removed".
// For execution, attemptScope identifies the run that owns the terminal boundary.
await submission.terminal;
```

`submissionId` is generated per call, so identical message text remains
independently correlatable. `admitted` resolves only after the exact queue
entry exists. `execution` resolves at same-run consumption, successor-run
promotion, or exact removal. `terminal` resolves at the owning run's
`agent_end` boundary, or immediately for removal. `submission.cancel()` removes
the entry when it is still queued; it returns `false` after execution or
removal. `queuePolicy: "sequential"` preserves FIFO delivery one queued input
at a time, including when the session's configured follow-up/steering mode is
`"all"`.

The ordinary `sendUserMessage` promise retains its delivery-mode-dependent
completion semantics:

- An ordinary idle submission with no `deliverAs` queues nothing and awaits the
  prompt turn, including its terminal completion.
- An explicit queued `steer`/`followUp`, or a submission diverted into a queue
  because a live turn is active, resolves when the submission is admitted to
  that delivery path. Use `submitUserMessage` when later consumption,
  completion, and cancellation must be correlated to one exact submission.

Neither promise is a generic queue-drained receipt. Do not build a generic
embedder contract around internal dispatch or promotion-correlation hooks.

Related APIs:

- `sendUserMessage(content, { deliverAs? })`
- `steer(text, images?)`
- `followUp(text, images?)`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

### Bounded image input and durable acceptance

`createSessionImageInput(session)` returns a generation-owned controller for
canonical user-selected image bytes. Its `prompt(text, images, options)` and
`submitUserMessage(text, images, options)` share the session's image admission
budget; creating another controller does not reset that budget. The queued
method returns the same tracked submission receipt described above. For direct
`prompt` local dispatch, image-bearing extension/custom/MCP slash commands are
rejected before their handler can run or discard the attached bytes. Queued
`submitUserMessage` retains the slash text as queued message input; it does not
execute a local command handler.

Both methods accept `onPreflightAcceptCommit?: () => void | Promise<void>`.
The SDK awaits this callback before admitting the input. A rejected callback
prevents admission and releases only that invocation's image reservation.
Cancellation and controller ownership are rechecked after an awaited callback.
Use this fence to persist an embedder-owned delivery record before execution
can begin, not as proof that execution or transcript persistence has happened:
subsequent cancellation or ingress checks can still prevent a run.

Retain the original text and attachment payload independently of redacted
presentation DTOs until a correlated outcome is known. `removed` and its
`reason` are meaningful terminal outcomes, not successful delivery. In particular,
`reason: "refused"` records a positive core decision not to start the queued run;
a provider failure after run acceptance is not a refusal. After a
crash without a conclusive receipt, preserve an unknown outcome and require an
explicit user decision; do not automatically replay potentially executed input.

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

- **Model-host preconnect.** As soon as the model is resolved, the SDK fires a best-effort `fetch.preconnect(model.baseUrl)` so DNS + TCP + TLS + HTTP/2 to the provider's host happens in parallel with tool registry build, and system-prompt assembly. The first real `fetch(...)` then reuses the warm connection, saving 100–300 ms on transcontinental hops (e.g. residential IP → `api.anthropic.com`). `packages/coding-agent/src/sdk/session.ts` triggers it through the `startup.networkPrewarm` runtime service (`packages/coding-agent/src/runtime/network-prewarm-service.ts`); setting `startup.networkPrewarm: false` skips it. If `fetch.preconnect` is unavailable (non-Bun runtime) or the call throws, the optimization is skipped (failures are logged at debug level) — never a hard dependency. Applies to interactive, print, and ACP modes.
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
