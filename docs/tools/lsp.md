# lsp

> Query language servers for diagnostics, navigation, symbols, renames, code actions, capabilities, and raw requests.

## Source
- Entry: `packages/coding-agent/src/lsp/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/lsp.md`
- Key collaborators:
  - `packages/coding-agent/src/lsp/client.ts` — client process lifecycle and JSON-RPC
  - `packages/coding-agent/src/lsp/config.ts` — config loading, auto-detect, server selection
  - `packages/coding-agent/src/lsp/lspmux.ts` — optional `lspmux` command wrapping
  - `packages/coding-agent/src/lsp/edits.ts` — apply `WorkspaceEdit` and text edits
  - `packages/coding-agent/src/lsp/utils.ts` — URI conversion, symbol resolution, formatting, glob expansion
  - `packages/coding-agent/src/lsp/types.ts` — tool schema and protocol types
  - `packages/coding-agent/src/lsp/clients/index.ts` — custom linter client cache/factory
  - `packages/coding-agent/src/lsp/clients/lsp-linter-client.ts` — LSP-backed linter adapter
  - `packages/coding-agent/src/lsp/clients/biome-client.ts` — Biome CLI diagnostics/formatting adapter
  - `packages/coding-agent/src/lsp/clients/swiftlint-client.ts` — SwiftLint CLI diagnostics adapter
  - `packages/coding-agent/src/tools/index.ts` — tool registration and `lsp.enabled` gating
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout defaults and clamping
  - `packages/coding-agent/src/lsp/defaults.json` — built-in server definitions for auto-detect

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string enum | Yes | One of `diagnostics`, `definition`, `references`, `hover`, `symbols`, `rename`, `rename_file`, `code_actions`, `type_definition`, `implementation`, `status`, `reload`, `capabilities`, `request`. |
| `file` | string | No | File path; for `diagnostics` also a glob; for workspace forms use `"*"`; for `rename_file` this is the source path. |
| `line` | number | No | 1-indexed line number for position-based actions. Defaults to `1` on the single-file action path. |
| `symbol` | string | No | Substring used to resolve the column on `line`. Supports `name#N` occurrence selectors; `N` is 1-indexed and defaults to `1`. |
| `query` | string | No | Workspace symbol query, code-action selector/filter, or LSP method name for `action=request`. |
| `new_name` | string | No | Required for `rename` and `rename_file`. |
| `apply` | boolean | No | For `rename`/`rename_file`, apply unless explicitly `false`. For `code_actions`, list unless explicitly `true`. |
| `timeout` | number | No | Seconds, clamped by `clampTimeout("lsp", ...)` to `5..60`, default `20`. |
| `payload` | string | No | JSON string for `action=request`; overrides auto-built params. |

## Outputs
- Single-shot `AgentToolResult`.
- `content` is always one text block: `[{ type: "text", text: string }]`.
- `details` is `LspToolDetails`: `action`, `success`, optional `serverName`, optional original `request`.
- No streaming updates.
- No artifact URIs or background jobs.
- Many validation failures are returned as ordinary text results with `details.success: false`; aborts throw `ToolAbortError` instead.

## Flow
1. `packages/coding-agent/src/tools/index.ts` registers `lsp: LspTool.createIf`; session creation also gates it behind `session.enableLsp !== false` and `settings.get("lsp.enabled")`.
2. `LspTool.execute()` in `packages/coding-agent/src/lsp/index.ts` clamps `timeout` with `clampTimeout("lsp", ...)`, builds an `AbortSignal.timeout(...)`, and combines it with the caller signal.
3. `getConfig()` loads and caches `LspConfig` per cwd, applies idle-timeout config via `setIdleTimeout()`, and reuses the cached config on later calls.
4. Config loading in `packages/coding-agent/src/lsp/config.ts` merges `defaults.json` with JSON/YAML overrides from project, project config dirs, user config dirs, plugin roots, and home; if there are no overrides it auto-detects servers from root markers plus executable discovery.
5. Server routing uses `getServersForFile()` / `getServerForFile()` from `config.ts`: extension or basename match, then sort primary servers before linters. `index.ts` further filters custom linter clients out of navigation/refactor paths with `getLspServersForFile()` / `getLspServerForFile()`.
6. `getOrCreateClient()` in `client.ts` creates one process per `command:cwd`, optionally wraps supported commands with `lspmux`, spawns the server, starts the background message reader, sends `initialize`, stores server capabilities, then sends `initialized`.
7. The message reader in `client.ts` parses LSP frames, resolves pending requests, caches `publishDiagnostics`, tracks `$/progress` tokens for project-load completion, answers `workspace/configuration`, and applies `workspace/applyEdit` requests through `applyWorkspaceEdit()`.
8. File-scoped actions call `ensureFileOpen()` before requests. Column resolution uses `resolveSymbolColumn()` from `utils.ts`: read the target file, pick first non-whitespace when `symbol` is omitted, otherwise find the exact or case-insensitive match on the target line and honor `#N` occurrence selectors.
9. Actions dispatch in `LspTool.execute()` through dedicated branches: workspace-only branches (`status`, some `diagnostics`, workspace `symbols`, workspace `reload`, `capabilities`, `request`) run before the single-file switch; all other single-file actions share one client lookup and `switch(action)`.
10. Requests go through `sendRequest()` in `client.ts`, which allocates an incrementing JSON-RPC id, installs abort and timeout handling, sends `$/cancelRequest` on abort, and rejects on timeout or process exit.
11. Actions that return edits either preview with `formatWorkspaceEdit()` or apply with `applyWorkspaceEdit()` from `edits.ts`; `rename_file` also performs the filesystem rename and then sends `workspace/didRenameFiles`.
12. Non-abort failures inside the single-file action block are converted to `LSP error: ...`; many precondition failures return explicit text without throwing.

## Modes / Variants
### Routing and workspace scope
- `file: "*"` is only special for `diagnostics`, `symbols`, and `reload`.
- `status` ignores `file`.
- `capabilities` with omitted `file` or `"*"` inspects all non-custom LSP servers; with a concrete file it scopes to matching non-custom servers.
- `request` with omitted `file` or `"*"` chooses the first available non-custom LSP server; with a concrete file it chooses that file's primary non-linter server.
- `rename_file` sends `workspace/willRenameFiles` and `workspace/didRenameFiles` to every non-custom LSP server from `getLspServers(config)`, not just one file-scoped server.
- Diagnostics are the only tool action that queries both normal LSP servers and custom linter clients (`BiomeClient`, `SwiftLintClient`, or `LspLinterClient`).

### `diagnostics`
**Inputs**
- Required: `file`, unless using workspace mode with `file: "*"`.
- Optional: `timeout`.

**Execution**
- `file: "*"`: `runWorkspaceDiagnostics()` detects project type from root markers and runs one subprocess command: Rust `cargo check --message-format=short`, TypeScript `npx tsc --noEmit`, Go `go build ./...`, Python `pyright`.
- Concrete file or glob: `resolveDiagnosticTargets()` treats non-globs as one target, otherwise expands a `Bun.Glob` up to `MAX_GLOB_DIAGNOSTIC_TARGETS`.
- Per file, every matching server runs: custom clients call `lint(file)`; real LSP servers optionally wait for project load, capture `diagnosticsVersion`, `refreshFile()`, then `waitForDiagnostics()` for fresh `publishDiagnostics`.
- Results are deduplicated by range+message and severity-sorted.

**Output text**
- Single target with no issues: `OK`.
- Single target with issues: `<summary>:\n<grouped diagnostics>`.
- Batch/glob target: one section per file, plus an initial truncation warning when the glob exceeds the file cap.
- Workspace mode: `Workspace diagnostics (<detected description>):\n<command output>`.

### `definition`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `timeout`.

**Execution**
- Sends `textDocument/definition` with `{ textDocument, position }`.
- Accepts `Location`, `Location[]`, `LocationLink`, or `LocationLink[]`; `normalizeLocationResult()` converts `LocationLink` to `targetSelectionRange ?? targetRange`.
- Waits for project load before the request.

**Output text**
- `No definition found` or `Found N definition(s):` followed by `file:line:col` and one context line above/below each location.

### `type_definition`
Same as `definition`, but sends `textDocument/typeDefinition` and reports `type definition(s)`.

### `implementation`
Same as `definition`, but sends `textDocument/implementation` and reports `implementation(s)`.

### `references`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `timeout`.

**Execution**
- Sends `textDocument/references` with `includeDeclaration: true`.
- For project-aware servers, retries up to `REFERENCES_RETRY_COUNT` times when the only hit is the queried declaration; between retries it waits for project load and sleeps `REFERENCES_RETRY_DELAY_MS`.
- First `REFERENCE_CONTEXT_LIMIT` references include surrounding context; the rest are location-only.

**Output text**
- `No references found` or `Found N reference(s):` with contextual entries first, then `... M additional reference(s) shown without context` when truncated.

### `hover`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `timeout`.

**Execution**
- Sends `textDocument/hover`.
- `extractHoverText()` flattens strings, markup content, marked-string objects, or arrays into plain text.

**Output text**
- `No hover information` or the extracted hover text.

### `symbols`
**Inputs**
- Workspace mode: `file: "*"` or omitted file on the early workspace branch, plus required `query`.
- Document mode: required `file`.
- Optional: `timeout`.

**Execution**
- Workspace mode sends `workspace/symbol` to every non-custom LSP server, post-filters matches with `filterWorkspaceSymbols()`, deduplicates with `dedupeWorkspaceSymbols()`, then truncates to `WORKSPACE_SYMBOL_LIMIT`.
- Document mode sends `textDocument/documentSymbol` to the primary server. If the first item has `selectionRange`, it formats hierarchical `DocumentSymbol`s; otherwise it formats flat `SymbolInformation`s.

**Output text**
- Workspace mode: `Found N symbol(s) matching "query":` plus formatted `name @ file:line:col`, with an omission line when over the limit.
- Document mode: `Symbols in <file>:` plus hierarchical or flat symbol lines.

### `rename`
**Inputs**
- Required: `file`, `new_name`.
- Optional: `line`, `symbol`, `apply`, `timeout`.

**Execution**
- Waits for project load, sends `textDocument/rename`, receives a `WorkspaceEdit`.
- `apply !== false` applies edits immediately with `applyWorkspaceEdit()`.
- `apply === false` renders a preview with `formatWorkspaceEdit()`.

**Output text**
- `Rename returned no edits`, `Applied rename:` plus applied change lines, or `Rename preview:` plus summarized edits.

### `rename_file`
**Inputs**
- Required: `file` source path, `new_name` destination path.
- Optional: `apply`, `timeout`.

**Execution**
- Resolves absolute source and destination, rejects identical paths, missing source, existing destination, empty rename set, or directories with more than `MAX_RENAME_PAIRS` files.
- `enumerateRenamePairs()` returns one `{oldUri,newUri}` pair for a file or walks every regular file in a directory tree.
- Sends `workspace/willRenameFiles` with `{ files: pairs }` to every non-custom LSP server; collects returned `WorkspaceEdit`s and server notes.
- Preview mode (`apply === false`) only formats those edits.
- Apply mode runs each returned `WorkspaceEdit`, renames the source path on disk, sends `textDocument/didClose` for every renamed open file, deletes those `openFiles` entries, then sends `workspace/didRenameFiles`.

**Output text**
- Preview: `Rename preview: <file-count label> → <dest>` plus per-server edit summaries and optional server notes.
- Apply: `Renamed <file-count label> → <dest>` plus applied edit summaries, filesystem rename line, and optional server notes.

### `code_actions`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `query`, `apply`, `timeout`.

**Execution**
- Reads cached diagnostics for the open URI from `client.diagnostics` and sends `textDocument/codeAction` for a zero-width range at the resolved position.
- When `apply !== true`, `query` is passed as `context.only: [query]`; this is a server-side kind filter.
- When `apply === true`, `query` becomes a required client-side selector: either a zero-based numeric index or a case-insensitive substring of the action title.
- Applying a `CodeAction` uses `applyCodeAction()`: optionally `codeAction/resolve`, then `applyWorkspaceEdit(edit)`, then optional `workspace/executeCommand`.
- Applying a bare `Command` only runs `workspace/executeCommand`.

**Output text**
- List mode: `N code action(s):` plus `index: [kind] title` lines.
- Apply mode success: `Applied "title":` plus `Workspace edit:` and/or `Executed command(s):` sections.
- Apply mode miss: `No code action matches "query". Available actions:`.
- Apply mode with no edit/command: `Action "title" has no workspace edit or command to apply`.

### `status`
**Inputs**
- None.

**Execution**
- Reads configured servers from cached `LspConfig`, not `getActiveClients()`.
- Calls `detectLspmux()` and appends status text when `lspmux` is installed.

**Output text**
- `Active language servers: ...` or `No language servers configured for this project`, optionally followed by `lspmux: active (multiplexing enabled)` or `lspmux: installed but server not running`.

### `reload`
**Inputs**
- Workspace mode: `file: "*"` or omitted `file`.
- Single-file mode: required `file`.
- Optional: `timeout`.

**Execution**
- Workspace mode reloads every non-custom LSP server.
- Single-file mode reloads the primary server for that file.
- `reloadServer()` tries `rust-analyzer/reloadWorkspace`, then `workspace/didChangeConfiguration` with `{ settings: {} }`; if neither works it kills the process so the next request cold-starts a new client.

**Output text**
- One line per server: `Reloaded <server>`, `Restarted <server>`, or `Failed to reload <server>: ...`.

### `capabilities`
**Inputs**
- Optional: `file`, `timeout`.

**Execution**
- With a concrete `file`, inspects matching non-custom servers for that file.
- With omitted `file` or `"*"`, inspects every non-custom configured server.
- Starts servers as needed and dumps `client.serverCapabilities ?? {}` as pretty JSON.

**Output text**
- Per server: `<server>:` followed by indented `capabilities: { ... }`, or `<server>: failed to start (...)`.

### `request`
**Inputs**
- Required: `query` method name.
- Optional: `file`, `line`, `symbol`, `payload`, `timeout`.

**Execution**
- Chooses one non-custom server: file-scoped primary server, otherwise the first configured non-custom server.
- Param building precedence:
  1. If `payload` is present, parse JSON and use it verbatim.
  2. Else if `file` is concrete and `line` is present, build `{ textDocument: { uri }, position: { line: line - 1, character } }` using `resolveSymbolColumn()`.
  3. Else if `file` is concrete, build `{ textDocument: { uri } }`.
  4. Else use `{}`.
- Opens the file first when `file` is concrete.

**Output text**
- Success: `<server> ← <method>:\n<formatted result>`, where non-string results are `JSON.stringify(..., null, 2)` and nullish values become `null`.
- Failure: `LSP error from <server> on <method>: ...`.

## Side Effects
- Filesystem
  - Reads config files, target files, and root markers.
  - `rename` and `code_actions` may edit/create/delete/rename files via `applyWorkspaceEdit()`.
  - `rename_file` always renames the source path on disk in apply mode.
  - Server-initiated `workspace/applyEdit` requests also mutate files through `applyWorkspaceEdit()`.
- Network
  - None directly; communication is local stdio JSON-RPC to subprocesses.
- Subprocesses / native bindings
  - Spawns language servers with `ptree.spawn()`.
  - Workspace diagnostics spawns `cargo`, `npx`, `go`, or `pyright`.
  - `BiomeClient` and `SwiftLintClient` spawn CLI tools.
  - Optional `lspmux` detection spawns `lspmux status`; supported servers may be wrapped through `lspmux client`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Caches config per cwd in `configCache`.
  - Caches LSP clients per `command:cwd`, with `pendingRequests`, `diagnostics`, `openFiles`, `serverCapabilities`, and project-load state.
  - Caches custom linter clients by `serverName:cwd`.
  - Updates client `lastActivity`; optional idle-timeout cleanup is driven by `setIdleTimeout()`.
- Background work / cancellation
  - Every request has an abortable timeout signal.
  - Aborting an in-flight LSP request sends `$/cancelRequest`.
  - Background message readers persist for each live client until process exit/shutdown.

## Limits & Caps
- Tool timeout clamp: default `20`, min `5`, max `60` seconds — `TOOL_TIMEOUTS.lsp` in `packages/coding-agent/src/tools/tool-timeouts.ts`.
- LSP request default timeout inside `sendRequest()`: `30_000ms` — `DEFAULT_REQUEST_TIMEOUT_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Warmup initialize timeout default: `5_000ms` — `WARMUP_TIMEOUT_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Project-load wait fallback: `15_000ms` — `PROJECT_LOAD_TIMEOUT_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Idle-client sweep interval when enabled: `60_000ms` — `IDLE_CHECK_INTERVAL_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Diagnostic message output cap: first `50` messages — `DIAGNOSTIC_MESSAGE_LIMIT` in `packages/coding-agent/src/lsp/index.ts`.
- Single-file diagnostics wait: `3_000ms` — `SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS`.
- Batch/glob diagnostics wait per file: `400ms` — `BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS`.
- Glob diagnostic target cap: first `20` matches — `MAX_GLOB_DIAGNOSTIC_TARGETS`.
- Workspace symbol cap: first `200` entries — `WORKSPACE_SYMBOL_LIMIT`.
- Reference context cap: first `50` references include source context — `REFERENCE_CONTEXT_LIMIT`.
- References retry count: `2` retries, `250ms` backoff — `REFERENCES_RETRY_COUNT`, `REFERENCES_RETRY_DELAY_MS`.
- Directory rename cap: `1_000` file pairs — `MAX_RENAME_PAIRS`.
- `detectLspmux()` state cache TTL: `5 * 60 * 1000ms`; liveness check timeout: `1_000ms` — `STATE_CACHE_TTL_MS`, `LIVENESS_TIMEOUT_MS` in `packages/coding-agent/src/lsp/lspmux.ts`.
- Workspace diagnostics output cap: first `50` lines from the subprocess.

## Errors
- Missing or invalid inputs are usually returned as text with `details.success: false`, not thrown:
  - missing `file`/`query`/`new_name`
  - invalid JSON in `payload`
  - no matching server
  - invalid `rename_file` source/destination conditions
- `resolveSymbolColumn()` throws explicit errors for missing files, missing symbols, and out-of-bounds `#N` selectors; these surface as `LSP error: ...` or request-specific error text.
- `sendRequest()` rejects on timeout with `LSP request <method> timed out after <ms>ms`.
- Client process exit rejects all pending requests with an exit-code/stderr error assembled in `getOrCreateClient()`.
- Single-file action failures inside the main `try` become `LSP error: <message>`.
- `request` has its own error envelope: `LSP error from <server> on <method>: <message>`.
- Some server failures are intentionally softened:
  - diagnostics continue when one server fails
  - `rename_file` suppresses `workspace/willRenameFiles` “method not found” errors and records other server errors as notes
  - `code_actions` ignores `codeAction/resolve` failures and applies unresolved actions when possible
- Aborts are not converted to text: `ToolAbortError` is rethrown.

## Notes
- `status` reports configured/available servers from `LspConfig`, not currently active client processes from `getActiveClients()`.
- `getLspServerForFile()` excludes `createClient` adapters and linter-only servers; navigation/refactor actions never target Biome/SwiftLint custom clients.
- `getServersForFile()` matches both file extensions and exact basenames from `fileTypes`; config can target names like `Dockerfile` if present.
- `symbol` matching is exact first, then case-insensitive, and falls back to the Nth occurrence on the specified line only; it never scans other lines.
- `code_actions` uses `query` in two different ways: server-side `context.only` filter in list mode, client-side title/index selector in apply mode.
- `rename` and `rename_file` default to apply. Preview requires `apply: false`.
- `request` with `file: "*"` is treated the same as omitted `file`: it does not build workspace-specific params.
- `reload` does not recreate a client immediately after killing it; the next request triggers reinitialization.
- `workspace/applyEdit` can apply edits initiated by the server outside the direct tool action result path.
- `detectLspmux()` can be disabled with `GJC_DISABLE_LSPMUX=1`; only `rust-analyzer` is in `DEFAULT_SUPPORTED_SERVERS`.
- Startup LSP warmup (`discoverStartupLspServers(cwd)` in `sdk.ts`) is gated on `enableLsp && options.hasUI && settings.get("lsp.diagnosticsOnWrite")` — print, ACP, and script sessions skip it and let `getOrCreateClient()` cold-start servers on demand. See `docs/sdk-embedding.md` § Startup performance.
- `configCache` is per-process and never auto-invalidated; config changes require a fresh process to be observed by `getConfig()` callers.