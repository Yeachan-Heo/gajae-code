This guide reflects the current implementation in `packages/coding-agent/src/` and focuses on architecture, extension points, and development workflow.

## Directory Tree (Current `src/` layout)

```text
src/
├── cli.ts, main.ts, index.ts, sdk.ts, config.ts
├── cli/                 # command-line argument and command adapters
├── commands/            # concrete command handlers (launch, shell, ssh, ...)
├── modes/               # interactive, print, rpc runtimes + UI controllers/components
├── session/             # AgentSession, persistence, storage, compaction, artifacts
├── tools/               # built-in tool implementations and render/meta helpers
├── task/                # subagent/task orchestration, concurrency, output management
├── capability/          # capability definitions and schemas
├── discovery/           # provider discovery modules (native/editor/MCP/etc.)
├── extensibility/       # extensions, hooks, custom tools/commands, plugins, skills
├── mcp/                 # MCP transport/manager/loader/tool bridge
├── lsp/                 # language server client/runtime integration
├── internal-urls/       # protocol router + handlers (agent://, docs://, rule://, ...)
├── exec/ eval/ ssh/     # execution backends (shell, eval runtimes, ssh)
├── web/                 # search providers + domain scrapers
├── patch/               # edit/patch parser + applicator + diff utilities
└── config/ utils/ tui/  # settings, helpers, low-level TUI primitives
```

## Boot Sequence: CLI Entry, Main Orchestration, and Mode Dispatch

### ASCII overview

```text
process argv
   │
   ▼
src/cli.ts (runCli)
   │  normalize subcommand (default: launch)
   ▼
src/commands/*
   │
   ▼
src/main.ts (runRootCommand)
   │  init theme/settings/models/session
   ▼
createAgentSession(...)
   │
   ├── runInteractiveMode(...)  -> InteractiveMode
   ├── runPrintMode(...)        -> one-shot output
   └── runRpcMode(...)          -> JSONL stdin/stdout server
```

### Runtime layers

1. **Command router layer** (`packages/coding-agent/src/cli.ts`)
   - Defines the root command table (`commands: CommandEntry[]`) and lazy-loads subcommands like `launch`, `commit`, `config`, `shell`, `stats`, and `search`.
   - Performs an early Bun runtime guard (`Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0`) and exits if the runtime is too old.
   - Exposes `runCli(argv: string[])`, which rewrites argv so non-subcommand invocations default to `launch`.

2. **Application orchestration layer** (`packages/coding-agent/src/main.ts`)
   - `runRootCommand(parsed: Args, rawArgs: string[])` initializes theme/settings/model registry/session options, creates an `AgentSession`, then dispatches runtime mode.
   - Handles early-exit utility paths before session creation (for example `version`, `listModels`, `export`).
   - Builds `CreateAgentSessionOptions` via `buildSessionOptions(...)` and calls `createAgentSession(...)` from `./sdk`.

3. **Mode runtime layer** (`packages/coding-agent/src/modes/index.ts`)
   - Re-exports mode entrypoints:
     - `InteractiveMode`
     - `runPrintMode`
     - `runRpcMode`
     - `RpcClient` (+ RPC types)
   - Registers a postmortem terminal recovery hook:
     - `postmortem.register("terminal-restore", () => emergencyTerminalRestore())`

4. **SDK/programmatic surface layer** (`packages/coding-agent/src/index.ts`)
   - Re-exports SDK/session/mode/theme/tool/types for non-CLI consumers.
   - Includes direct exports for `main`, `createAgentSession`, `runPrintMode`, `runRpcMode`, `InteractiveMode`, discovery helpers, and extension/custom-tool types.

### Startup flow (CLI path)

1. `packages/coding-agent/src/cli.ts` executes `await runCli(process.argv.slice(2))`.
2. `runCli(...)` decides whether argv already starts with a known subcommand; otherwise prepends `"launch"`.
3. The `launch` command eventually calls `runRootCommand(...)` in `packages/coding-agent/src/main.ts`.
4. `runRootCommand(...)` sequence (high-level):
   - `initTheme()` bootstrap, optional auto-chdir via `maybeAutoChdir(...)`.
   - `discoverAuthStorage()` + `new ModelRegistry(authStorage)` + `modelRegistry.refresh()`.
   - Initialize settings (`Settings.init({ cwd })`), collect piped input (`readPipedInput()`), preprocess `@file` inputs (`prepareInitialMessage(...)`).
   - Build/open session management (`createSessionManager(...)`, resume handling via `selectSession(...)` when `--resume` has no value).
   - Build options (`buildSessionOptions(...)`) and create runtime session (`createAgentSession(sessionOptions)`).
   - Dispatch mode:
     - `mode === "rpc"` -> `runRpcMode(session)`
     - interactive -> `runInteractiveMode(...)` (wrapper around `new InteractiveMode(...)` loop)
     - non-interactive text/json stream path -> `runPrintMode(session, ...)`

### CLI vs programmatic usage

- **CLI path**: starts at `src/cli.ts` (`#!/usr/bin/env bun`), uses command registry + argv normalization, and routes into command handlers.
- **Programmatic path**: imports from `src/index.ts` directly (for example `createAgentSession`, `runPrintMode`, `runRpcMode`, `InteractiveMode`, `Settings`, `ModelRegistry`) without going through `runCli` or command alias logic.

### What `index.ts` exposes for SDK consumers

`packages/coding-agent/src/index.ts` acts as the package barrel and includes:

- **Core runtime/session APIs**: `createAgentSession`, `AgentSession`, `SessionManager`, prompt/compaction/session types.
- **Mode APIs**: `InteractiveMode`, `runPrintMode`, `runRpcMode`, `RpcClient` and RPC event/types.
- **Discovery + tool constructors**: `discoverAuthStorage`, `discoverExtensions`, `discoverMCPServers`, `createTools`, built-in tool classes (`ReadTool`, `WriteTool`, `BashTool`, `EvalTool`, `FindTool`, `GrepTool`, `EditTool`).
- **Extensibility interfaces**: extension/custom-command/custom-tool/skill/slash-command types and loaders.
- **UI/theming helpers**: TUI components plus `initTheme`, `Theme`, and code-highlighting/theme utilities.
- **CLI callable export**: `main` is re-exported for embedding/integration contexts that invoke root behavior explicitly.

## Mode Implementations: Interactive, Print, and RPC

### ASCII overview

```text
                    AgentSession
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
InteractiveMode      runPrintMode      runRpcMode
(TUI event loop)     (non-TUI batch)   (JSONL protocol)
        │                │                │
controllers/components   stdout text/json  RpcCommand/RpcResponse
```

The coding agent exposes three execution styles in `packages/coding-agent/src/modes/`:

- Interactive TUI mode (`interactive-mode.ts`)
- One-shot print mode (`print-mode.ts`)
- Headless RPC mode (`rpc/rpc-mode.ts` + `rpc/rpc-types.ts` + `rpc/rpc-client.ts`)

### Interactive mode (`InteractiveMode`)

`InteractiveMode` (class in `interactive-mode.ts`) is the long-lived TUI runtime. It wires `AgentSession` to terminal UI components and controller modules.

Core responsibilities:

- Build and own TUI objects (`TUI`, editor, chat/status/todo containers, status line).
- Initialize keybindings, slash-command autocomplete (`refreshSlashCommandState()`), welcome/changelog rendering, and session history storage.
- Subscribe to `AgentSession` events (`#subscribeToAgent()` via `EventController`) and keep UI state in sync.
- Delegate command/input/selector/extension concerns to dedicated controllers (`CommandController`, `InputController`, `SelectorController`, `ExtensionUiController`).
- Persist and render todos from session artifacts (`#loadTodoList()`, `#renderTodoList()`, `todos.json`).
- Manage mode state transitions, including plan mode enter/exit/restore (`#enterPlanMode()`, `#exitPlanMode()`, `#restoreModeFromSession()`).
- Handle lifecycle shutdown (`stop()`, `shutdown()`) including session flush and terminal cleanup.

This file is orchestration-heavy: business logic mostly lives in session/controllers; `InteractiveMode` coordinates UI + lifecycle.

### Print mode (`runPrintMode`)

`runPrintMode(session, options)` in `print-mode.ts` is single-shot, non-interactive execution.

Behavior by output mode:

- `mode: "json"`
  - Writes session header (`session.sessionManager.getHeader()`) first if available.
  - Subscribes to session events and writes every event as one JSON line.
- `mode: "text"`
  - Sends prompts, then prints only text blocks from the final assistant message.
  - If final assistant stop reason is `error` or `aborted`, writes error to stderr and exits with code 1.

Additional responsibilities:

- Initializes extension runner with non-UI action/context adapters (command list is empty; no UI context object).
- Emits extension `session_start`.
- Supports `initialMessage` + `initialImages`, then additional queued `messages`.
- Flushes stdout before returning and disposes the session (`await session.dispose()`).

### RPC mode server (`runRpcMode`)

`runRpcMode(session)` in `rpc-mode.ts` is a stdin/stdout JSONL protocol server for embedding.

Transport and framing:

- Input: JSON lines from `readJsonl(Bun.stdin.stream())`.
- Output: one JSON object per line via `process.stdout.write(JSON.stringify(obj) + "\n")`.
- Startup handshake: immediately emits `{ "type": "ready" }`.

Command handling:

- Accepts `RpcCommand` unions (defined in `rpc-types.ts`).
- Responds with `RpcResponse` objects: `type: "response"`, `command`, `success`, optional `data`, optional `error`.
- Also streams raw `AgentSession` events through stdout via `session.subscribe(...)`.

Extension UI bridge:

- Implements `RpcExtensionUIContext` to translate extension UI calls into `extension_ui_request` output messages.
- Tracks pending dialog requests by generated `id` and resolves them when matching `extension_ui_response` arrives on stdin.
- Supports timeout/abort-aware dialog defaults for `select`, `confirm`, and `input`.
- Fire-and-forget UI notifications (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are emitted as requests without expected responses.
- TUI-specific operations are explicitly unsupported in RPC mode (`setFooter`, `setHeader`, theme switching, custom editor components).

Shutdown behavior:

- Extension `shutdown()` marks a deferred flag.
- After each command, `checkShutdownRequested()` emits `session_shutdown` (if handlers exist) and exits.
- EOF on stdin exits cleanly (`process.exit(0)`).

### RPC protocol shape (`rpc-types.ts`)

`RpcCommand` categories in source:

- Prompting: `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session`
- State: `get_state`
- Model: `set_model`, `cycle_model`, `get_available_models`
- Thinking: `set_thinking_level`, `cycle_thinking_level`
- Queue modes: `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`
- Compaction/retry: `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`
- Bash/session/messages: `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `branch`, `get_branch_messages`, `get_last_assistant_text`, `set_session_name`, `get_messages`

`RpcSessionState` (returned by `get_state`) includes model/thinking info, streaming/compaction flags, queue mode settings, session identity (`sessionFile`, `sessionId`, `sessionName`), and message queue counts.

`RpcResponse` is a discriminated union:

- Success variants are command-specific (many include typed `data` payloads).
- Failure variant is generic: `{ type: "response", command: string, success: false, error: string }`.

Extension protocol types:

- Outbound UI requests: `RpcExtensionUIRequest` (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`).
- Inbound UI replies: `RpcExtensionUIResponse` (`value`, `confirmed`, or `cancelled`).

### RPC client wrapper (`RpcClient`)

`RpcClient` in `rpc-client.ts` is a typed process wrapper around `--mode rpc`.

Key behaviors:

- Spawns `bun <cliPath> --mode rpc` (default `dist/cli.js`) with optional provider/model/session args.
- Waits for server ready signal (`type === "ready"`) with startup timeout (30s) and early-exit error propagation including captured stderr.
- Sends commands with generated request IDs (`req_<n>`), correlates responses through `#pendingRequests`, and enforces per-request timeout (30s).
- Exposes typed methods (`prompt`, `steer`, `setModel`, `bash`, `getState`, etc.) that map 1:1 to RPC commands.
- Emits only `AgentEvent` values through `onEvent()`; `waitForIdle()`/`collectEvents()` resolve on `agent_end`.
- Provides `stop()` and `[Symbol.dispose]()` for cleanup.

Notable current limitation from implementation: `#handleLine()` handles `RpcResponse` and agent events only; `extension_ui_request` messages are not surfaced by `RpcClient` APIs.

## Session Lifecycle, Persistence, and Settings Boundaries

### ASCII overview

```text
@gajae-code/agent-core Agent
            │ events/messages
            ▼
       AgentSession
       │    │    │
       │    │    └── Settings (config/settings.ts)
       │    │         global+project+override merge
       │    │
       │    └──── SessionManager (JSONL tree)
       │             │
       │             └── SessionStorage (file/memory backends)
       │
       └──── HistoryStorage (prompt recall SQLite)
```

### `AgentSession` is the runtime coordinator

`packages/coding-agent/src/session/agent-session.ts` defines `AgentSession`, which sits between the core `Agent` runtime and durable storage (`SessionManager` + `Settings`).

Key responsibilities in code:

- Subscribes once to agent events in constructor (`this.agent.subscribe(this.#handleAgentEvent)`), then fans out to UI/extensions via `subscribe()` and `#emitSessionEvent()`.
- Owns operational state not stored in model history (abort controllers, retry counters, queued steering/follow-up messages, plan mode state, provider session caches).
- Persists conversation events as they complete:
  - `message_end` with `user` / `assistant` / `toolResult` / `fileMention` -> `sessionManager.appendMessage(...)`
  - `message_end` with `custom` / `hookMessage` -> `sessionManager.appendCustomMessageEntry(...)`
  - TTSR injections -> `sessionManager.appendTtsrInjection(...)`
- Flushes persistence on shutdown via `dispose()` -> `await sessionManager.flush()`.

This keeps the agent loop and durable session log synchronized without requiring each caller mode to persist manually.

### Session restore and switching behavior

State restoration is explicit in `AgentSession.switchSession(sessionPath)`:

1. Abort current work and flush current writer (`await this.sessionManager.flush()`).
2. Load the target file (`await this.sessionManager.setSessionFile(sessionPath)`).
3. Rebuild branch-resolved context (`const sessionContext = this.sessionManager.buildSessionContext()`).
4. Replace in-memory conversation (`this.agent.replaceMessages(sessionContext.messages)`).
5. Restore model from `sessionContext.models.default` if available in current `ModelRegistry`.
6. Restore thinking level from session entries; if none exists, clamp `settings.defaultThinkingLevel` and append a new `thinking_level_change` entry.

Related lifecycle methods:

- `newSession(options)` resets agent messages and creates a fresh session file/header via `sessionManager.newSession(...)`.
- `fork()` duplicates current persisted session file + artifact directory and keeps current in-memory conversation.
- `branch(entryId)` creates a branched session path from a selected user message using `sessionManager.createBranchedSession(...)` / `newSession(...)` and then reloads context.
- `navigateTree(...)` moves the session leaf inside one file (`sessionManager.branch(...)` / `resetLeaf()` / `branchWithSummary(...)`) and rebuilds context.

### `SessionManager` file model: append-only tree in JSONL

`packages/coding-agent/src/session/session-manager.ts` is the persistence engine.

Storage model:

- File format is NDJSON with a `SessionHeader` first entry and typed `SessionEntry` records after it.
- `CURRENT_SESSION_VERSION = 3`; `migrateV1ToV2` and `migrateV2ToV3` run on load when needed.
- Entries are tree-linked (`id`, `parentId`) with a mutable leaf pointer (`#leafId`) for branching.
- Appends are type-specific (`appendMessage`, `appendThinkingLevelChange`, `appendModelChange`, `appendCompaction`, `appendCustomEntry`, `appendCustomMessageEntry`, `appendModeChange`, `appendTtsrInjection`, etc.).

Context reconstruction:

- `buildSessionContext(entries, leafId, byId)` resolves the active branch and emits the LLM-visible message stream.
- Compaction entries are handled specially: emit compaction summary message first, then kept messages from `firstKeptEntryId`, then later messages.
- `custom_message` participates in LLM context; `custom` does not (extension state persistence only).

Persistence mechanics:

- Incremental append writer: `NdjsonFileWriter`.
- Serialized write queue: `#persistChain` (prevents concurrent write races).
- Safe rewrites for migrations/edits: `#writeEntriesAtomically(...)` to temp file then rename.
- Terminal breadcrumb (`terminal-sessions/<tty-id>`) supports `continueRecent(...)` to prefer per-terminal last session.

### Session storage abstraction (`session-storage.ts`)

`packages/coding-agent/src/session/session-storage.ts` abstracts filesystem access for session persistence.

- `SessionStorage` interface defines sync/async primitives used by `SessionManager`.
- `FileSessionStorage` is the real implementation (Bun + `node:fs`), including `FileSessionStorageWriter` with held file descriptor and `fsync()`.
- `MemorySessionStorage` is an in-memory implementation used for tests/non-persistent flows.

This separation keeps `SessionManager` logic independent from storage backend and enables deterministic tests.

### Prompt history is separate from session history

`packages/coding-agent/src/session/history-storage.ts` (`HistoryStorage`) is not conversation state restoration.

- Stores prompt history in SQLite (`history.db`) with FTS5 index (`history_fts`).
- APIs are `add(prompt, cwd?)`, `getRecent(limit)`, `search(query, limit)`.
- Uses singleton `HistoryStorage.open(...)` and asynchronous insert (`setImmediate`) with duplicate-last-prompt suppression.

This is command/input recall data; it does not rebuild agent message trees.

### Settings responsibilities (`config/settings.ts`)

`packages/coding-agent/src/config/settings.ts` (`Settings`) manages durable configuration, not conversation content.

Source layers:

- Global config: `<agentDir>/config.yml` (`#global`)
- Project capability settings (`loadCapability(settingsCapability.id, { cwd })`) (`#project`)
- Runtime overrides (`#overrides`, not persisted)
- Effective merged view (`#merged`)

Persistence behavior:

- `set(path, value)` updates `#global`, tracks modified paths, debounces save (`#queueSave()`), then persists with `#saveNow()`.
- `#saveNow()` uses `withFileLock(configPath, ...)`, re-reads current YAML, applies only modified paths, writes back via `Bun.write`.
- `flush()` forces pending writes.
- Startup migration (`#migrateFromLegacy`) imports old `settings.json` / `agent.db` values into `config.yml`.

Runtime side effects are centralized in `SETTING_HOOKS` (theme mapping, symbol preset, color-blind mode), keeping call sites simple.

### Boundary summary

- `AgentSession`: live orchestration + event-driven persistence wiring.
- `SessionManager`/`SessionStorage`: session tree durability and restoration (`messages`, model changes, thinking changes, compaction, branch topology).
- `HistoryStorage`: prompt recall database only.
- `Settings`: user/project configuration lifecycle (load/merge/override/save), separate from session transcript state.

## Tool Registration, Output Metadata, and Streaming Result Flow

### ASCII overview

```text
tool call from agent
      │
      ▼
createTools(...) -> Tool instance
      │ execute()
      ▼
executor / implementation
      │ streaming chunks
      ▼
OutputSink + TailBuffer
      │ summary (bytes/lines/truncation/artifactId)
      ▼
ToolResultBuilder + OutputMetaBuilder
      │
      ▼
wrapToolWithMetaNotice(...) appends human/meta notices
```

### Tool registry and session-driven construction

`packages/coding-agent/src/tools/index.ts` centralizes tool wiring through two registries:

- `BUILTIN_TOOLS: Record<string, ToolFactory>`
- `HIDDEN_TOOLS: Record<string, ToolFactory>`

A `ToolFactory` is `(session: ToolSession) => Tool | null | Promise<Tool | null>`, so tool creation can be async and conditional.

`createTools(session, toolNames?)` is the entry point. It:

1. Normalizes requested tool names (`toolNames`).
2. Resolves eval backend allowance via `PI_PY` override (`getEvalBackendsFromEnv()`) or `eval.py` / `eval.js` settings.
3. Performs Python kernel preflight when applicable (`checkPythonKernelAvailability`).
4. Computes effective gating (`isToolAllowed`) from settings and runtime state:
   - feature toggles (`find.enabled`, `grep.enabled`, etc.)
   - recursion guard for `task` (`task.maxRecursionDepth` vs `session.taskDepth`)
   - yield mode (`requireYieldTool`) and `todo_write` suppression
5. Instantiates selected tools in parallel with `Promise.all`, records slow factory timings when `PI_TIMING=1`, and wraps results with `wrapToolWithMetaNotice`.
6. Includes `resolve` unconditionally so plan mode and deferred preview/apply workflows always have it available.

The wrapper step is not cosmetic: it enforces uniform meta-notice behavior and normalized error rendering across all tools.

### Output metadata model and notice formatting

`packages/coding-agent/src/tools/output-meta.ts` defines `OutputMeta` and builder logic used by tools to attach machine-readable output annotations under `details.meta`.

Key meta blocks:

- `truncation?: TruncationMeta`
- `source?: SourceMeta` (`path`, `url`, `internal`)
- `diagnostics?: DiagnosticMeta`
- `limits?: LimitsMeta`

`OutputMetaBuilder` provides fluent helpers:

- `truncation(result, options)` from `TruncationResult`
- `truncationFromSummary(summary, options)` from `OutputSummary`
- `truncationFromText(text, options)` for text-only truncation inference
- `limits(...)`, `matchLimit(...)`, `resultLimit(...)`, `headLimit(...)`, `columnTruncated(...)`
- `sourcePath(...)`, `sourceUrl(...)`, `sourceInternal(...)`
- `diagnostics(summary, messages)`

`formatOutputNotice(meta)` converts metadata into appended textual notices (for model visibility), including:

- shown line range and total line count
- byte-limit context via `formatBytes(...)`
- pagination hint (`nextOffset`) for head-truncated output
- artifact recovery hint (`Full: artifact://<id>`)
- limit and diagnostics notices

### Tool-level result builder pattern

`packages/coding-agent/src/tools/tool-result.ts` provides `toolResult(details?)` returning `ToolResultBuilder<TDetails>`.

The builder is the common tool return path:

- set content (`text(...)` / `content(...)`)
- attach metadata (`truncation*`, `limits`, `source*`, `diagnostics`)
- finalize with `done()`

`done()` behavior matters:

- calls `this.#meta.get()` and writes to `details.meta` only when non-empty
- omits `details` entirely if all fields are `undefined`

This keeps tool payloads compact while still enabling consistent metadata for truncation and provenance.

### Automatic meta notice injection and error normalization

Also in `output-meta.ts`, `wrapToolWithMetaNotice(tool)` patches `tool.execute` once (guarded by `kUnwrappedExecute`). Wrapped execution:

1. calls the original execute
2. reads `result.details?.meta`
3. appends formatted notice to the last text content block (or creates a new text block)
4. catches errors and rethrows `new Error(renderError(e))`

Result: tools can focus on structured metadata; user/model-facing notice text is generated centrally.

### Streaming output sink and truncation accounting

`packages/coding-agent/src/session/streaming-output.ts` implements `OutputSink` for streamed command/notebook output with bounded in-memory tail and optional artifact spill.

`OutputSummary` includes:

- `output`, `truncated`
- `totalLines`, `totalBytes`
- `outputLines`, `outputBytes`
- optional `artifactId`

`OutputSink` flow:

1. `push(chunk)` sanitizes chunk text via `sanitizeText(...)`.
2. Updates global counters (`#totalBytes`, `#totalLines`, `#sawData`).
3. Buffers in memory (`#buffer`) and enforces byte cap (`spillThreshold`, default `DEFAULT_MAX_BYTES`) by tail-trimming with UTF-8 boundary safety.
4. If spilling is enabled (`artifactPath`), lazily opens a `Bun.FileSink`, writes full stream to disk, and marks truncated.
5. `dump(notice?)` closes sink, prepends optional notice line, and returns `OutputSummary` with propagated `artifactId`.

This is the canonical source for streamed truncation metadata used by bash/python/ssh-style tools.

### Artifact allocation and propagation

`packages/coding-agent/src/tools/output-utils.ts` handles artifact plumbing:

- `getArtifactManager(session)` reuses or creates `ArtifactManager` from `session.getSessionFile()`
- `allocateOutputArtifact(session, toolType)` returns `{ artifactPath?, artifactId? }`

Tools that stream or truncate large output call `allocateOutputArtifact(...)` first, then pass IDs into execution/sink paths. Examples:

- `bash.ts`: allocates artifact, streams via executor, then `.truncationFromSummary(result, { direction: "tail" })`
- `fetch.ts`: writes full body to artifact on head truncation and uses `.truncation(truncation, { direction: "head", artifactId })`
- `read.ts`: uses `toolResult(...).limits(...)` and `.truncation(...)` for directory/file limits

Because summaries include `artifactId`, `OutputMetaBuilder.truncationFromSummary(...)` carries it into `details.meta.truncation.artifactId`, and wrapper-generated notices expose `artifact://...` retrieval hints consistently.

## Capability Discovery and Extensibility Loading

### ASCII overview

```text
discovery providers (native/editor/files/MCP/etc.)
                    │
                    ▼
           capability registry
     (defineCapability + registerProvider)
                    │
                    ▼
             loadCapability(...)
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
extensions loader  hooks loader   skills loader
     │              │              │
     └────── runtime registrations ──────► AgentSession/modes
```

### Discovery bootstrap and provider registration

`packages/coding-agent/src/discovery/index.ts` is a side-effect bootstrap module:

- It imports capability definitions first (`../capability/*`) so registry entries exist before providers register.
- It then imports provider modules (`./builtin`, `./anthropic-model`, `./agents`, `./openai-code`, `./cursor`, `./gemini`, `./opencode`, `./github`, `./mcp-json`, `./ssh`, `./vscode`, `./windsurf`, etc.).
- Providers self-register during module import.
- It re-exports the runtime API from `../capability` (`loadCapability`, provider enable/disable, cache controls, introspection helpers).

This file is the canonical "load everything" entrypoint for discovery.

### Capability registry behavior (`src/capability/index.ts`)

Core functions:

- `defineCapability(def)`: declares a capability and initializes `providers: []`.
- `registerProvider(capabilityId, provider)`: records provider metadata and inserts by descending `priority`.
- `loadCapability(capabilityId, options)`: builds `LoadContext` (`cwd`, `home`), filters disabled/allowed providers, then delegates to `loadImpl`.

`loadImpl` normalization/merge flow:

1. Executes all selected `provider.load(ctx)` calls concurrently (`Promise.all`).
2. Aggregates warnings with provider display-name prefixes.
3. Requires `_source` metadata on each item; missing `_source` is warned and skipped.
4. Deduplicates by `capability.key(item)` with **first win** semantics (effectively higher-priority provider wins because provider arrays are priority-sorted before loading).
5. Marks duplicates as `_shadowed = true` in `all` results.
6. Runs `capability.validate` (unless `includeInvalid`) and drops invalid deduped items with source-aware warnings.

Provider state controls:

- `initializeWithSettings(settings)` hydrates disabled provider IDs from `settings.get("disabledProviders")`.
- `disableProvider` / `enableProvider` / `setDisabledProviders` mutate in-memory state and persist it.

### Extension module loading (`src/extensibility/extensions/loader.ts`)

Key entrypoint: `discoverAndLoadExtensions(configuredPaths, cwd, eventBus?, disabledExtensionIds?)`.

Source collection order:

1. Capability discovery: `loadCapability<ExtensionModule>(extensionModuleCapability.id, { cwd })`.
2. Only extension-module items from `_source.provider === "native"` are auto-included here.
3. Explicit configured paths are then resolved and added.

Path normalization and filtering:

- `resolvePath` expands `~` via `expandPath()` and resolves relative paths against `cwd`.
- Disabled extension IDs are matched as `extension-module:<name>` where `<name>` is derived by `getExtensionNameFromPath()`.
- De-dup uses `path.resolve(extPath)` in a `seen` set.

Directory entry resolution:

- `resolveExtensionEntries(dir)` checks, in order:
  - `package.json` manifest (`gjc` or `pi`) with `extensions[]` entries,
  - `index.ts`, then `index.js` fallback.
- `discoverExtensionsInDir(dir)` applies one-level rules when the directory itself has no root entry:
  - direct `*.ts`/`*.js` files,
  - child directories with manifest or index entry.

Module loading:

- `loadExtension(extPath, cwd, eventBus, runtime)` does dynamic `import(resolvedPath)`.
- Accepts factory from `module.default ?? module`; must be a function.
- Runs factory with `ConcreteExtensionAPI`, collecting handlers/tools/commands/flags/shortcuts/renderers.
- Returns `{ extensions, errors, runtime }` from `loadExtensions`.

### Hook loading (`src/extensibility/hooks/loader.ts`)

Key entrypoint: `discoverAndLoadHooks(configuredPaths, cwd)`.

Flow:

1. Discover hook candidates via capability API:
   `loadCapability<Hook>(hookCapability.id, { cwd })`.
2. Add explicit configured paths (resolved through `resolveHookPath`).
3. De-duplicate by absolute resolved path (`path.resolve(...)`).
4. Load each hook with `loadHooks` / `loadHook`.

`loadHook` specifics:

- Uses dynamic `import(resolvedPath)`.
- Requires a **default export function** (`HookFactory`); otherwise returns error.
- Builds API via `createHookAPI(...)`, then calls `factory(api)` to register:
  - event handlers (`api.on`),
  - message renderers (`registerMessageRenderer`),
  - commands (`registerCommand`).
- Exposes deferred runtime wiring via `setSendMessageHandler` / `setAppendEntryHandler` on `LoadedHook`.

### Skills loading points (`src/extensibility/skills.ts`)

Primary entrypoint: `loadSkills(options)`.

Provider-driven loading:

- Calls `loadCapability<CapabilitySkill>(skillCapability.id, { cwd })`.
- Applies source gating through `isSourceEnabled(source)`:
  - explicit toggles for `openai-code:user`, `anthropic-model:user`, `anthropic-model:project`, `native:user`, `native:project`,
  - other providers treated as built-in and allowed when any built-in source toggle is enabled.
- Applies name filters using `includeSkills` / `ignoredSkills` (`Bun.Glob`).

Normalization and collision handling:

- Resolves real paths (`fs.realpath`) to collapse symlink duplicates.
- Keeps first skill per name; later name collisions are reported as warnings.
- Transforms capability skills to legacy `Skill` shape:
  - `filePath = capSkill.path`,
  - `baseDir` from `.../SKILL.md` trimming,
  - `source = "<provider>:<level>",`
  - preserves `_source`.

Custom directory loading (delegated scanner):

- `customDirectories` are scanned via `scanSkillsFromDir` from `src/discovery/helpers.ts` (not ad-hoc traversal in `extensibility/skills.ts`).
- Custom directory scans are non-recursive (`*/SKILL.md`).
- Scan uses one-level `readdir` candidate enumeration (`*/SKILL.md`) without recursive descent.
- Custom skills are stamped as `source: "custom:user"` with `_source.provider = "custom"`.

Also exported: `discoverSkillsFromDir({ dir, source })`, which delegates directly to `scanSkillsFromDir` with non-recursive scanning.

## MCP Manager, LSP Client Boundary, and Internal URL Routing

### ASCII overview

```text
MCP configs ──► MCPManager ──► connect/list tools ──► bridged CustomTools
                  │
                  └── cache/deferred tool exposure

LSP feature calls ──► lsp/client.ts ──► JSON-RPC transport ──► language server process

internal URL input (rule://, docs://, ...)
                  │
                  ▼
          InternalUrlRouter
                  │
                  ▼
      protocol-specific handlers
```

### MCP server lifecycle (`src/mcp/manager.ts`, `src/mcp/loader.ts`)

`MCPManager` is the lifecycle owner for MCP server connections and their exposed tools.

- Discovery entrypoint: `discoverAndConnect(options)` calls `loadAllMCPConfigs()` and then `connectServers()`.
- Connection state is tracked in private maps:
  - `#connections` (live `MCPServerConnection`)
  - `#pendingConnections` (in-flight connection promises)
  - `#pendingToolLoads` (in-flight `listTools()` promises)
  - `#sources` (server `SourceMeta` provenance)
- Config validation occurs per server via `validateServerConfig(name, config)` before any connect attempt.
- Auth/config resolution happens in `#resolveAuthConfig()`:
  - OAuth credentials from `AuthStorage` are injected into HTTP/SSE headers (`Authorization: Bearer ...`) or stdio env (`OAUTH_ACCESS_TOKEN`).
  - Dynamic config values are resolved with `resolveConfigValue()` for env/header entries.
- Connections and tool enumeration are parallelized in `connectServers()`:
  - connect with `connectToServer()`
  - list remote tools with `listTools()`
  - convert to agent tools using `MCPTool.fromTools(connection, serverTools)`
- Startup is bounded by `STARTUP_TIMEOUT_MS` (250ms). If tool loads are still pending, cached definitions may be used from `MCPToolCache` and exposed as deferred wrappers via `DeferredMCPTool.fromTools(...)`.
- Lifecycle operations:
  - `disconnectServer(name)` and `disconnectAll()` tear down connections via `disconnectServer(connection)` and remove associated `mcp__<server>_` tools.
  - `refreshServerTools(name)` / `refreshAllTools()` re-run `listTools()` and replace server tool registrations.

`discoverAndLoadMCPTools()` in `src/mcp/loader.ts` is the adapter from manager internals to extensibility-facing output:

- Optionally creates `MCPToolCache` (`resolveToolCache()` via `AgentStorage`).
- Creates/configures `MCPManager` (including optional `setAuthStorage()`).
- Normalizes output into `MCPToolsLoadResult`:
  - `tools: LoadedCustomTool[]`
  - `errors: Array<{ path: string; error: string }>` using `mcp:<server>` paths
  - `connectedServers` and `exaApiKeys`

### MCP tool bridge role

`MCPManager` does not expose raw MCP protocol tool records directly. It bridges server tool definitions into the coding-agent custom-tool system:

- Core conversion points:
  - eager: `MCPTool.fromTools(connection, serverTools)`
  - deferred/cached: `DeferredMCPTool.fromTools(name, cached, () => this.waitForConnection(name), source)`
- Internal tool registry is `#tools: CustomTool<TSchema, MCPToolDetails>[]`.
- Manager consumers access bridged tools through `getTools()`; loader re-wraps those tools into `LoadedCustomTool` entries with resolved display paths (`mcp:<server> via <provider>` when provider metadata exists).

### LSP client role and integration boundary (`src/lsp/client.ts`)

This module is a process-level JSON-RPC client/runtime for language servers. It is intentionally lower-level than feature tools.

- Client acquisition boundary: `getOrCreateClient(config, cwd, initTimeoutMs?)`.
  - Spawns server process (`ptree.spawn`) and optionally wraps command through lspmux (`isLspmuxSupported()`, `getLspmuxCommand()`).
  - Sends `initialize` request with static `CLIENT_CAPABILITIES`, stores `serverCapabilities`, then sends `initialized` notification.
- Message transport boundary:
  - framing/parsing via `parseMessage()`, `findHeaderEnd()`, `writeMessage()`
  - background reader `startMessageReader()` routes replies to `pendingRequests` and handles selected server-initiated requests (`workspace/configuration`, `workspace/applyEdit`).
- File sync boundary (editor-like document state into LSP):
  - `ensureFileOpen()`, `syncContent()`, `notifySaved()`, `refreshFile()`
  - per-file operation serialization via `fileOperationLocks`
- Request API boundary:
  - `sendRequest()` handles request IDs, timeout (`DEFAULT_REQUEST_TIMEOUT_MS`), abort propagation (`$/cancelRequest`), and promise settlement.
  - `sendNotification()` is fire-and-forget transport.
- Lifecycle boundary:
  - `shutdownClient()`, `shutdownAll()`, idle cleanup (`setIdleTimeout()`, periodic checker), and process-signal cleanup hooks.

In short, `src/lsp/client.ts` is the transport/session substrate; higher-level LSP feature modules call into it rather than reimplementing process or protocol handling.

### Internal URL routing responsibilities (`src/internal-urls/router.ts`, `src/internal-urls/index.ts`)

`InternalUrlRouter` is a protocol dispatcher for internal schemes (`<scheme>://...`).

- Handler registration: `register(handler)` keyed by `handler.scheme`.
- Fast capability check: `canHandle(input)` parses scheme and checks handler presence.
- Resolution pipeline in `resolve(input)`:
  1. Parse with `new URL(input)` (invalid URLs throw).
  2. Preserve decoded host/path fidelity by attaching `rawHost` and `rawPathname` to `InternalUrl`.
  3. Select handler by normalized scheme.
  4. Delegate to `handler.resolve(parsedInternalUrl)`.
  5. If scheme is unknown, throw with a supported-schemes list.

`src/internal-urls/index.ts` defines the public integration surface for this subsystem by exporting:

- Router + core types: `InternalUrlRouter`, `InternalResource`, `InternalUrl`, `ProtocolHandler`
- Protocol handlers (agent/artifact/docs/memory/plan/rule/skill)
- Query helpers (`applyQuery`, `parseQuery`, `pathToQuery`)

This keeps URL protocol resolution centralized and pluggable while keeping protocol-specific logic in dedicated handler modules.

## Execution Backends and Tool Adapters (Bash, Python, SSH)

### ASCII overview

```text
Tool adapters (tools/bash.ts, tools/eval.ts, tools/ssh.ts)
                │ schema + validation + onUpdate + error policy
                ▼
Executors (exec/bash-executor.ts, eval/py/executor.ts, ssh/ssh-executor.ts)
                │ process/kernel/session lifecycle
                ▼
            OutputSink
                │
                ▼
      result summary -> ToolResultBuilder
```

This subsystem is split into two layers:

- **Core executors** (`src/exec/bash-executor.ts`, `src/eval/py/executor.ts`, `src/ssh/ssh-executor.ts`) own process/kernel lifecycle and raw output capture.
- **Tool adapters** (`src/tools/bash.ts`, `src/tools/eval.ts`) own tool schemas, argument normalization, UX-facing updates, and error policy for agent tool calls.

### Core executor responsibilities

#### Bash executor (`src/exec/bash-executor.ts`)

- Entry point: `executeBash(command, options)`.
- Uses `Settings.getShellConfig()` and `Shell` from `@gajae-code/natives`.
- Reuses shell sessions via `shellSessions: Map<string, Shell>` keyed by `buildSessionKey(...)` (shell, prefix, snapshot path, env, optional `sessionKey`).
- Applies shell snapshot support via `getOrCreateSnapshot(...)` when using bash.
- Streams output into `OutputSink` (`onChunk`, artifact path/id support).
- Serializes sink writes with `pendingChunks` to preserve chunk ordering.
- Shapes terminal result into `BashResult`:
  - `output`, `truncated`, `totalLines/totalBytes`, `outputLines/outputBytes`, optional `artifactId`
  - `exitCode` / `cancelled` states for normal completion, timeout, and abort.

#### Python executor (`src/eval/py/executor.ts`)

- Entry points:
  - `executePython(code, options)`
  - `executePythonWithKernel(kernel, code, options)`
  - session utilities (`disposeAllKernelSessions`, `disposeKernelSessionsByOwner`).
- Manages kernel session lifecycle in `kernelSessions: Map<string, KernelSession>` with:
  - bounded session count (`MAX_KERNEL_SESSIONS`), LRU eviction (`evictOldestSession`)
  - idle cleanup timer (`cleanupIdleSessions`)
  - heartbeat/dead detection and restart (`restartKernelSession`).
- Supports two modes via `PythonKernelMode`:
  - `"session"` (reuse kernel per `sessionId`)
  - `"per-call"` (start/shutdown each execution).
- Uses `OutputSink` in `executeWithKernel(...)` for streaming/truncation/artifact output.
- Aggregates rich kernel outputs (`displayOutputs`) and stdin/timed-out/cancelled state into `PythonResult`.
- Caches prelude helper docs in `pycache` under agent dir (`buildPreludeCacheState`, `readPreludeCache`, `writePreludeCache`) for faster startup.

#### SSH executor (`src/ssh/ssh-executor.ts`)

- Entry point: `executeSSH(host, command, options)`.
- Ensures remote connectivity/metadata through `ensureConnection(...)` and optional `ensureHostInfo(...)`.
- Optional compat wrapping (`buildCompatCommand`) when `compatEnabled` and host advertises `compatShell`.
- Optional SSHFS mount attempt (`mountRemote`) when available.
- Runs SSH via `ptree.spawn(["ssh", ...buildRemoteCommand(...)])`.
- Streams both stdout/stderr into `OutputSink` and returns `SSHResult` with same truncation/accounting shape (`output`, byte/line totals, optional artifact id, `exitCode`, `cancelled`).

### Tool adapter responsibilities

#### Bash tool (`src/tools/bash.ts`)

- Adapter class: `BashTool implements AgentTool<typeof bashSchema, BashToolDetails>`.
- Defines tool contract (`bashSchema`: `command`, `timeout`, `cwd`, `pty`, optional `async`) and prompt text import (`../prompts/tools/bash.md`).
- Pre-execution adaptation:
  - optional command interception (`checkBashInterception`) based on settings
  - expands internal URLs (`expandInternalUrls`)
  - resolves/validates working directory (`resolveToCwd`, `fs.promises.stat`).
- Chooses backend:
  - PTY path: `runInteractiveBashPty(...)`
  - non-PTY path: `executeBash(...)`.
- Streaming to UI is adapter-owned: updates `onUpdate` using `createTailBuffer(...)` while backend runs.
- Post-execution shaping is adapter-owned:
  - converts backend cancellation/timeout/exit status into `ToolAbortError` / `ToolError`
  - returns `toolResult(...).text(...).truncationFromSummary(...)`.

#### Eval tool (`src/tools/eval.ts`)

- Adapter class: `EvalTool implements AgentTool<typeof evalSchema>`.
- Defines schema (`cells[]`, `language`, `timeout`, `reset`) and a static description from `prompts/tools/eval.md` (`getEvalToolDescription`).
- Supports proxy mode via `EvalProxyExecutor`; otherwise executes locally.
- Per-call adaptation:
  - validates and resolves working dir
  - clamps timeout and combines abort signals (`AbortSignal.any`)
  - allocates artifact output and local `OutputSink`
  - builds stable `sessionId` from session file + cwd.
- Executes cells sequentially by repeatedly calling core `executePython(...)`; adapter tracks cell-level state (`PythonCellResult`) and emits progressive updates (`onUpdate`).
- Adapter merges backend outputs into UI-facing shape:
  - combined text output across cells
  - JSON/image/status display outputs from `result.displayOutputs`
  - cell status transitions (`pending/running/complete/error`), duration, exit code.
- Adapter owns error messaging semantics for failed/aborted cells and final `toolResult(...).truncationFromSummary(...)` construction.

### Streaming and result-shaping boundaries

- **Streaming transport + truncation accounting** is implemented in executors through `OutputSink`.
- **Tool-progress rendering updates** (`onUpdate` with tail buffers and structured details) is implemented in adapters.
- **Final agent-tool response text and failure policy** (what becomes `ToolError` vs success) is implemented in adapters.
- **Executor return types** (`BashResult`, `PythonResult`, `SSHResult`) carry normalized low-level execution facts; adapters convert those into agent tool UX semantics.

## Task Tool: Agent Delegation, Selection, and Parallel Execution

### ASCII overview

```text
task tool request
      │
      ▼
TaskTool.execute(...)
      │ validate agent/tasks/schema
      ▼
discoverAgents + AgentOutputManager
      │
      ▼
mapWithConcurrencyLimit(...)
      │
      ├── runSubprocess(task A) -> child AgentSession
      ├── runSubprocess(task B) -> child AgentSession
      └── ...
      │
      ▼
yield/fallback normalization
      │
      ▼
aggregated task results (+ optional worktree patches)
```

The task subsystem is centered in `packages/coding-agent/src/task/index.ts` via `TaskTool`, which implements the `task` tool contract and delegates each requested task item to `runSubprocess(...)` from `src/task/executor.ts`.

Key orchestration responsibilities in `TaskTool.execute(...)`:

- Re-discover available agents on each call with `discoverAgents(this.session.cwd)`.
- Validate agent existence (`getAgent(...)`), disabled-agent settings (`task.disabledAgents`), and task list integrity (non-empty IDs, case-insensitive duplicate detection).
- Resolve model/thinking/output schema precedence:
  - model: `task.agentModelOverrides[agentName]` → resolved agent frontmatter patterns (single inheriting aliases fall back to the parent active model) → parent active model
  - output schema: agent frontmatter `output` → tool params `schema` → parent session schema
- Prepare shared context (`context.md`) and unique per-task IDs via `AgentOutputManager.allocateBatch(...)`.
- Execute all tasks with bounded concurrency using `mapWithConcurrencyLimit(...)` from `src/task/parallel.ts`.

### Agent Definitions and Selection

Bundled agent definitions are implemented in `packages/coding-agent/src/task/agents.ts`:

- Built-ins are embedded with `import ... with { type: "text" }` and parsed by `parseAgent(...)`.
- `loadBundledAgents()` caches parsed `AgentDefinition[]`.
- `task` and `quick_task` are injected from the same `task.md` body with different frontmatter defaults (`model`, `thinkingLevel`, `spawns`).

`TaskTool` applies additional runtime constraints in `index.ts`:

- `PI_BLOCKED_AGENT` prevents self-recursive spawn of a specific agent.
- Parent spawn policy (`session.getSessionSpawns()`) gates whether a child can be launched.
- In plan mode (`session.getPlanModeState?.().enabled`), effective subagent tools are replaced with a restricted set (`read`, `grep`, `find`, `ls`, `lsp`, `fetch`, `web_search`) and child spawning is disabled for that effective agent (`spawns: undefined`).

## Execution Boundary: In-Process Session, Not OS Subprocess

Despite the name `runSubprocess`, `packages/coding-agent/src/task/executor.ts` currently runs subagents in-process:

- File header: `In-process execution for subagents`.
- Execution path uses `createAgentSession(...)`, `SessionManager`, and direct event subscription (`session.subscribe(...)`).
- There is no `child_process` spawn path in this module.

What _is_ isolated is execution context and artifacts, not process memory:

- Optional filesystem isolation is controlled by the `task.isolation.mode` setting (`"none"`, `"worktree"`, `"fuse-overlay"`, or `"fuse-projfs"`).
  - **worktree**: `ensureWorktree(...)`, `applyBaseline(...)`, `captureDeltaPatch(...)`, `cleanupWorktree(...)`. Nested non-submodule git repos are discovered and handled independently.
  - **fuse-overlay**: `ensureFuseOverlay(...)`, `captureDeltaPatch(...)`, `cleanupFuseOverlay(...)` using `fuse-overlayfs` on Unix hosts. On Windows, this mode falls back to `worktree` with a system notification.
  - **fuse-projfs**: `ensureProjfsOverlay(...)`, `captureDeltaPatch(...)`, `cleanupProjfsOverlay(...)` using ProjFS on Windows. Missing ProjFS prerequisites fall back to `worktree` with a system notification; non-prerequisite startup errors still fail the task.
- The `task.isolation.merge` setting controls how isolated changes are integrated back:
  - **patch** (default): captures a diff via `captureDeltaPatch(...)`, combines patches, and applies with `git apply`.
  - **branch**: each task commits to a temp branch (`gjc/task/<id>`) via `commitToBranch(...)`, then `mergeTaskBranches(...)` cherry-picks them sequentially onto HEAD. If `git apply` fails inside `commitToBranch`, the error is non-fatal — the agent result is preserved with a `merge failed` status.
- The `task.isolation.commits` setting (`generic` or `ai`) controls commit messages for branch commits and nested repo patches. `ai` mode uses a smol model to generate conventional commit messages from diffs.
- Nested repo patches are applied via `applyNestedPatches(...)` after the parent merge, grouped by repo with one commit per repo.
- Child session JSONL/markdown outputs are written under the task artifacts directory (`<id>.jsonl`, `<id>.md`, and in isolated mode `<id>.patch`).

### Tooling Surface in Child Sessions

`runSubprocess(...)` computes active tools from agent frontmatter and runtime rules:

- Adds `task` tool automatically when `agent.spawns` is set and recursion depth permits.
- Removes `task` when max recursion depth is reached (`task.maxRecursionDepth`).
- Expands legacy `exec` alias into `eval` when any eval backend is enabled, and always includes `bash`.
- Forces `requireYieldTool: true` in `createAgentSession(...)`.
- Filters parent-owned tools out of child tools (`todo_write` is removed).

If parent MCP connections exist, executor creates in-process MCP proxy tools with `createMCPProxyTools(...)` so children reuse parent MCP connectivity rather than creating independent MCP sessions.

## Submit/Result Contract and Completion Semantics

`executor.ts` enforces structured completion around `yield`:

- Tracks tool events and extracted data through `subprocessToolRegistry` handlers.
- Retries reminder prompts up to 3 times (`MAX_YIELD_RETRIES`) using `subagent-yield-reminder.md` if `yield` was not called.
- Final output normalization is centralized in `finalizeSubprocessOutput(...)`:
  - If `yield.status === "aborted"`, task is converted to an aborted result payload.
  - If missing `yield`, fallback attempts JSON parse/validation against output schema.
  - Emits warnings when `yield` is missing/null and fallback cannot safely validate.

This module also accumulates token/cost usage from assistant `message_end` events and truncates returned output with `truncateTail(...)` using `MAX_OUTPUT_BYTES` and `MAX_OUTPUT_LINES`.

## Parallelization Model

`packages/coding-agent/src/task/parallel.ts` provides `mapWithConcurrencyLimit(...)`:

- Worker-pool scheduling with ordered result slots (`results[index]`).
- Concurrency normalization (`Math.floor`, bounded to `[1, items.length]`).
- Parent abort signal stops scheduling new tasks; already running tasks finish their own abort path.
- First non-abort worker error fails fast via internal abort controller + rejection promise.
- Return shape is `{ results: (R | undefined)[], aborted: boolean }`; undefined entries represent tasks skipped before start.

`TaskTool.execute(...)` post-processes these partial results into explicit failed/aborted placeholders so downstream rendering receives a complete `SingleResult[]`.

## Subprocess Tool Registry Hooks

`packages/coding-agent/src/task/subprocess-tool-registry.ts` defines a singleton registry (`subprocessToolRegistry`) used by executor event handling:

- `register(toolName, handler)` attaches optional hooks:
  - `extractData(event)` for structured extraction into `progress.extractedToolData[toolName][]`
  - `shouldTerminate(event)` to request early child termination after tool completion
  - `renderInline(...)` and `renderFinal(...)` for UI rendering integrations
- Executor consumes these hooks inside `tool_execution_end` processing to build structured task outputs (not only plain text streams).

This keeps tool-specific extraction/termination logic decoupled from generic task execution flow.

## Web I/O and Retrieval Architecture (`fetch`, `puppeteer`, `web_search`, scrapers)

### ASCII overview

```text
fetch tool
  │
  ├── specialHandlers (web/scrapers)
  ├── generic fetch/convert/render pipeline
  └── truncation/artifact metadata

browser tool (puppeteer)
  ├── stateful page/session control
  ├── observe/interact/extract actions
  └── screenshot/readability outputs

web_search
  ├── resolveProviderChain(...)
  ├── provider attempts + fallback order
  └── formatted response for LLM
```

### Responsibility boundaries

- `packages/coding-agent/src/tools/fetch.ts` implements the **`fetch` tool** (`FetchTool`) for URL retrieval and content transformation into model-friendly text.
- `packages/coding-agent/src/tools/browser.ts` implements the **`puppeteer` tool** (`BrowserTool`) for stateful browser automation (navigation, interaction, accessibility observation, screenshots).
- `packages/coding-agent/src/web/search/index.ts` + `packages/coding-agent/src/web/search/provider.ts` implement **web search orchestration** and provider abstraction/fallback.
- `packages/coding-agent/src/web/scrapers/index.ts` is the **special-handler registry** consumed by `fetch` for site-specific extraction before generic rendering.

These are separate pipelines: `fetch` is HTTP/content extraction, `puppeteer` is interactive browser control, and `web_search` is answer synthesis over external search APIs.

### `fetch` tool pipeline (`FetchTool.execute`)

`FetchTool.execute` clamps timeout (`1..45s`), calls `renderUrl(...)`, then truncates output (`truncateHead`) and may persist full output via `allocateOutputArtifact(...)`.

Core pipeline in `renderUrl(url, timeout, raw, signal)`:

1. Normalize URL (`normalizeUrl`) and short-circuit `pi-internal://`.
2. If not `raw`, run `handleSpecialUrls(...)` over `specialHandlers` from `../web/scrapers`.
3. Fetch with `loadPage(...)`.
4. Detect convertible binaries (`isConvertible`) and attempt `fetchBinary(...)` + `convertWithMarkit(...)`.
5. Handle structured/non-HTML content directly:
   - JSON: `formatJson`
   - RSS/Atom/XML feed: `parseFeedToMarkdown`
   - plain text/markdown passthrough
6. For HTML (non-raw), progressively try higher-signal alternatives:
   - `<link rel="alternate">` markdown/feed (`parseAlternateLinks`)
   - `.md` suffix (`tryMdSuffix`)
   - `/.well-known/llms.txt`, `/llms.txt`, `/llms.md` (`tryLlmEndpoints`)
   - `Accept: text/markdown, text/plain...` negotiation (`tryContentNegotiation`)
   - HTML-to-text conversion (`renderHtmlToText`)
7. If HTML conversion is low-quality (`isLowQualityOutput`), try document-link extraction (`extractDocumentLinks`) + markit.

`renderHtmlToText(...)` fallback order is explicit in code: Jina reader endpoint (`https://r.jina.ai/<url>`), then `trafilatura` (via `ensureTool`), then `lynx`, then native `htmlToMarkdown`.

### Scraper registry role (`web/scrapers/index.ts`)

`specialHandlers: SpecialHandler[]` is an ordered list of domain-specific handlers (for example GitHub/GitLab, social/news, package registries, academic/security/reference sources). `fetch.ts` calls them through `handleSpecialUrls(...)` and returns the first non-null `RenderResult`.

Operationally, this means scraper ordering in `specialHandlers` is precedence: earlier handlers can short-circuit generic fetch/render behavior.

### Browser automation tool (`BrowserTool`)

`BrowserTool` is stateful and action-driven (`browserSchema.action`), with internal session state:

- browser/page lifecycle: `#resetBrowser`, `#ensurePage`, `#closeBrowser`
- element cache for `observe`→`*_id` workflows: `#elementCache`, `#resolveCachedHandle`, stale-element invalidation
- stealth hardening: `#applyStealthPatches`, user-agent overrides via CDP, injected scripts from `src/tools/puppeteer/*.txt`

Major action classes:

- session/navigation: `open`, `goto`, `close`
- structured page introspection: `observe` (accessibility snapshot + viewport/scroll metadata)
- direct interaction: `click/type/fill/press/scroll/drag` and id-based variants
- extraction: `get_text`, `get_html`, `get_attribute`, `extract_readable` (Mozilla Readability + `htmlToBasicMarkdown`)
- capture: `screenshot` (PNG, resized/compressed before returning image content)

This tool is intentionally distinct from `fetch`: it executes page interactions and DOM-level extraction rather than stateless HTTP retrieval.

### Search abstraction and fallback (`web/search/index.ts`, `provider.ts`)

Provider registry (`PROVIDER_META`) and the explicit-selection/label/CLI order (`SEARCH_PROVIDER_ORDER`) are defined in `provider.ts`.

`resolveProviderChain(authStorage, preferredProvider, activeModelProvider?)` is active-model-gated, not credential-scanning:

- If `preferredProvider` is explicit (not `auto`) and `isAvailable()` is true, it becomes the primary.
- Otherwise the active model's own native search (`MODEL_PROVIDER_TO_SEARCH`: `openai|openai-codex→codex`, `anthropic`, `google|google-gemini-cli|google-antigravity|gemini→gemini`, `moonshot|kimi-code|kimi→kimi`, `zai`, `perplexity`, `synthetic`) becomes the primary when that provider's canonical creds exist (`isAvailable()`).
- Native-over-proxy: when no canonical native is selected, `activeContextNativeId(ctx)` maps the active model's wire `api` (+ model-id family) to a native provider, and — gated on the active model's OWN credential resolving (`getApiKey(ctx.provider, { baseUrl, modelId })`) — attempts it reusing those credentials and `ctx.baseUrl`. Dispatch: `anthropic-messages`+`claude-*`→`anthropic`, `openai-responses`/`openai-completions`→`openai-compatible`, `google-generative-ai`+`gemini-*`→`gemini`. `searchAnthropic`/`GeminiProvider.search` fall back to the active credential when their canonical creds are absent; all fail closed to `duckduckgo` if the endpoint ignores the web-search tool.
- Keyed standalone providers (brave/tavily/exa/kagi/jina/parallel/searxng) are never auto-selected — explicit selection only.
- `duckduckgo` (keyless, always available) is appended as the terminal fallback, so a missing primary or a primary runtime failure still returns results with zero configuration.

`executeSearch(...)` in `index.ts` then tries providers sequentially until one succeeds; it returns formatted text (`formatForLLM`) on first success. If all fail, it returns a synthesized error including provider list and last error.

Explicit provider selection is not fail-closed: an explicitly selected provider that is unavailable or fails at runtime still falls back to the keyless `duckduckgo` terminal provider, which `resolveProviderChain` appends unconditionally.

### Auth/availability signals represented in code

Only code-backed auth behavior should be assumed:

- Availability gating is provider-specific `isAvailable()` checks.
- `formatProviderError(...)` maps `SearchProviderError` status codes:
  - `401/403`: authorization failure message (special-case message passthrough for `zai`)
  - Anthropic `404`: specific endpoint/model-not-found message

No explicit rate-limit policy is encoded in these files beyond generic provider failure handling and fallback chaining.

## Local development workflow, tools registry, RPC, and hooks

### ASCII overview

```text
Change request
   │
   ├── built-in tool  -> tools/index.ts (imports/exports/BUILTIN_TOOLS)
   ├── RPC command    -> modes/rpc/rpc-types.ts (+ rpc-mode handler/client)
   └── hook event     -> extensibility/hooks/types.ts (+ emit sites)

Validation loop:
  bun --cwd=packages/coding-agent run check
  bun --cwd=packages/coding-agent run test
```

This section covers the day-to-day commands and three common extension paths in `packages/coding-agent`:

- add a built-in tool
- add an RPC command
- add a hook event

### Canonical references

- Package scripts: `packages/coding-agent/package.json` (`scripts`)
- Package-level docs pointer: `packages/coding-agent/README.md`
- Built-in tool registry: `packages/coding-agent/src/tools/index.ts`
- RPC protocol types: `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- Hook event and API types: `packages/coding-agent/src/extensibility/hooks/types.ts`

### Practical local command workflow

Use only script names that exist in `packages/coding-agent/package.json`:

- Typecheck package:
  - `bun --cwd=packages/coding-agent run check`
- Run package tests:
  - `bun --cwd=packages/coding-agent run test`
- Reformat prompt assets used by this package:
  - `bun --cwd=packages/coding-agent run format-prompts`
- Regenerate docs index files for package docs:
  - `bun --cwd=packages/coding-agent run generate-docs-index`
- Regenerate template artifacts:
  - `bun --cwd=packages/coding-agent run generate-template`
- Build compiled binary artifact (`dist/gjc`):
  - `bun --cwd=packages/coding-agent run build`

`packages/coding-agent/README.md` intentionally delegates install/config/CLI docs to the monorepo root README (`../../README.md`) and keeps package-specific references to `CHANGELOG.md`, `docs/`, and `DEVELOPMENT.md`.

### Playbook: add a built-in tool

Primary file: `packages/coding-agent/src/tools/index.ts`.

1. Add imports for the tool implementation and any exported detail/input types.
   - Example pattern: `import { ReadTool } from "./read";`
2. Export the tool/type symbols from this module so they are reachable through the tools barrel.
   - Example pattern: `export { ReadTool, type ReadToolDetails, type ReadToolInput } from "./read";`
3. Register a factory in `BUILTIN_TOOLS`.
   - `export const BUILTIN_TOOLS: Record<string, ToolFactory> = { ... }`
   - Key is the external tool name (e.g. `"read"`, `"web_search"`).
4. If it should be hidden/system-only, register under `HIDDEN_TOOLS` instead.
   - Existing hidden names: `yield`, `report_finding`, `resolve`.
5. Wire feature gates in `isToolAllowed(name)` when the tool needs runtime enable/disable behavior.
   - Existing gates use `session.settings.get("<tool>.enabled")` and recursion limits for `task`.
6. If the tool should be selectable by type, update `ToolName = keyof typeof BUILTIN_TOOLS` consumers as needed.

Notes from current behavior:

- `createTools()` always includes `resolve`. Plan mode uses it (via the agent calling `resolve` with `extra: { title }`) to submit a finalized plan for user approval; preview/apply tools (e.g. `ast_edit`) use it to gate apply/discard.
- `yield` is force-added when `session.requireYieldTool === true`.
- Eval availability is mode-driven (`PI_PY`, `eval.py`, `eval.js`); eval falls back to JavaScript when Python is unavailable and JavaScript is enabled. The standalone `bash` tool is always available.

### Playbook: add an RPC command

Primary file: `packages/coding-agent/src/modes/rpc/rpc-types.ts`.

1. Add the new command shape to `RpcCommand` with a unique `type` literal.
   - Pattern: `| { id?: string; type: "new_command"; ... }`
2. Add success response variant(s) to `RpcResponse`.
   - Pattern: `| { id?: string; type: "response"; command: "new_command"; success: true; data?: ... }`
3. Ensure failure path remains covered by the generic error arm:
   - `{ id?: string; type: "response"; command: string; success: false; error: string }`
4. If command changes exposed runtime state, update `RpcSessionState` accordingly.
5. `RpcCommandType` is derived (`RpcCommand["type"]`), so no separate enum update is needed.

Keep command naming consistent with existing protocol literals such as:

- prompting: `prompt`, `steer`, `follow_up`
- session: `switch_session`, `branch`, `get_branch_messages`
- execution: `bash`, `abort_bash`

### Playbook: add a hook event

Primary file: `packages/coding-agent/src/extensibility/hooks/types.ts`.

1. Define a strongly typed event interface with a literal `type` field.
   - Pattern: `export interface MyEvent { type: "my_event"; ... }`
2. Add the event to `HookEvent` union.
3. Add an overload to `HookAPI.on(...)` for the new event.
   - Pattern: `on(event: "my_event", handler: HookHandler<MyEvent, MyEventResult>): void;`
4. If handlers can influence execution, add a corresponding `...Result` interface.
   - Existing examples: `ToolCallEventResult`, `SessionBeforeCompactResult`, `ContextEventResult`.
5. Choose the right context type:
   - event handlers use `HookContext`
   - slash command handlers use `HookCommandContext` (adds `waitForIdle`, `newSession`, `branch`, `navigateTree`)

Current event groups to align with:

- session lifecycle (`session_start`, `session_before_switch`, `session_tree`, etc.)
- agent/turn lifecycle (`before_agent_start`, `agent_start`, `turn_end`)
- automation (`auto_compaction_start/end`, `auto_retry_start/end`, `todo_reminder`, `ttsr_triggered`)
- tool hooks (`tool_call`, `tool_result`)

If the event carries tool-specific post-execution details, follow the existing discriminated union pattern used by `ToolResultEvent` (`toolName` + typed `details`).
