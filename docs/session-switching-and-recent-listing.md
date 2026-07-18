# Session switching and recent session listing

This document describes how coding-agent discovers recent sessions, resolves `--resume` targets, presents session pickers, and switches the active runtime session.

It focuses on current implementation behavior, including fallback paths and caveats.

## Implementation files

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/cli/session-picker.ts`](../packages/coding-agent/src/cli/session-picker.ts)
- [`../src/modes/components/session-selector.ts`](../packages/coding-agent/src/modes/components/session-selector.ts)
- [`../src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)
- [`../src/sdk/session.ts`](../packages/coding-agent/src/sdk/session.ts)
- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## Recent-session discovery

### Directory scope

The default managed scope is `~/.gjc/agent/sessions/v2-<identity-digest>/`, where the digest is derived from the native canonical workspace identity rather than a path-string substitution. It is collision-resistant, but the digest is not a public injective identity or an authentication credential. POSIX aliases and supported Windows local aliases for the same directory resolve to the same scope; UNC/network workspaces are rejected as unsupported.

`SessionManager.list(cwd, sessionDir?)` reads the selected directory unless an explicit `sessionDir` is provided. The public readonly SDK API is `resolveManagedSessionScope()` followed by `listManagedSessionCandidates()` from `@gajae-code/coding-agent/sdk`; both are versioned by `SESSION_DIRECTORY_API_VERSION` (currently `1`). The resolver/listing API creates, migrates, and deletes nothing. Listing reports validated v2 and legacy candidates, invalid candidates, and a foreign count instead of treating arbitrary files as owned sessions.

Default writes are v2-only. Legacy discovery/migration is lazy, validates identity before use, and follows `session.directoryMigration` (`copy-retain` by default; `disabled` to opt out); no automatic legacy cleanup occurs.

### Two listing paths with different payloads

There are two different listing pipelines:

1. `getRecentSessions(sessionDir, limit)` (welcome/summary view)
   - Reads a bounded 4KB prefix plus bounded trailing v4 header patches from each file.
   - Parses header metadata, applicable tail patches, and the earliest user text preview.
   - Returns lightweight `RecentSessionInfo` with lazy `name` and `timeAgo` getters.
   - Sorts by file `mtime` descending.

2. `SessionManager.list(...)` / `SessionManager.listAll()` (resume pickers and ID matching)
   - Reads a bounded 4KB prefix plus at most 16KB of trailing v4 header patches for file-backed sessions.
   - Builds `SessionInfo` objects from bounded metadata and preview extraction; buried patches outside the tail budget deliberately fall back to line-1 header metadata.
   - Drops sessions with zero `message` entries and sorts by `modified` descending.

### Metadata fallback behavior

For recent summaries (`RecentSessionInfo`):

- display name preference: `header.title` -> first user prompt -> `header.id` -> filename
- name is truncated to 40 chars for compact displays
- control characters/newlines are stripped/sanitized from title-derived names

For `SessionInfo` list entries:

- `title` is `header.title` or latest compaction `shortSummary`
- `firstMessage` is first user message text or `"(no messages)"`

## `--continue` resolution and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` resolves the target in this order:

1. Read terminal-scoped breadcrumb (`~/.gjc/agent/terminal-sessions/<terminal-id>`)
2. Validate breadcrumb:
   - current terminal can be identified
   - breadcrumb cwd matches current cwd (resolved path compare)
   - referenced file still exists
3. If breadcrumb is invalid/missing, fall back to newest file by mtime in the session dir (`findMostRecentSession`)
4. If none found, create a new session

Terminal ID derivation prefers TTY path and falls back to env-based identifiers (`KITTY_WINDOW_ID`, `TMUX_PANE`, `TERM_SESSION_ID`, `WT_SESSION`).

Breadcrumb writes are best-effort and non-fatal.

## Startup-time resume target resolution (`main.ts`)

### `--resume <value>`

`createSessionManager(...)` handles string-valued `--resume` in two modes:

1. Path-like value (contains `/`, `\\`, or ends with `.jsonl`)
   - direct `SessionManager.open(sessionArg, parsed.sessionDir)`

2. ID prefix value
   - find match in `SessionManager.list(cwd, sessionDir)` by `id.startsWith(sessionArg)`
   - if no local match and `sessionDir` is not forced, try `SessionManager.listAll()`
   - first match is used (no ambiguity prompt)

Cross-project match behavior:

- if matched session cwd differs from current cwd, CLI prompts whether to fork into current project
- yes -> `SessionManager.forkFrom(...)`
- no -> throws error (`Session "..." is in another project (...)`)

No match -> throws error (`Session "..." not found.`).

### `--resume` (no value)

Handled after initial session-manager construction:

1. list local candidates through the bounded read-only resume-picker path
2. if empty: print `No sessions found` and exit early
3. open the TUI picker; cancellation returns silently and exits without writes
4. inspect the selected transcript read-only and confirm resumable tail state when required
5. strictly open the approved identity, rechecking ownership before any replay-sanitization persistence
6. publish the terminal breadcrumb only after strict-open sanitation succeeds, then continue startup from the opened manager
### `--continue`

Uses `SessionManager.continueRecent(...)` directly (breadcrumb-first behavior above).

## Picker-based selection internals

## CLI picker (`src/cli/session-picker.ts`)

`selectSession(sessions)` creates a standalone TUI with `SessionSelectorComponent` and resolves exactly once:

- selection -> resolves selected path
- cancel (Esc) -> resolves `null`
- hard exit (Ctrl+C path) -> stops TUI and `process.exit(0)`

## Interactive in-session picker (`SelectorController.showSessionSelector`)

Flow:

1. fetch sessions from the current session directory via `SessionManager.listForResumePickerReadOnly(currentCwd, currentSessionDir)`
2. mount `SessionSelectorComponent` in editor area using `showSelector(...)`
3. callbacks:
   - select -> close selector and call `handleResumeSession(sessionPath)`
   - cancel -> restore editor and rerender
   - exit -> `ctx.shutdown()`

## Session selector component behavior

`SessionList` supports:

- arrow/page navigation
- Enter to select
- Esc to cancel
- Ctrl+C to exit
- fuzzy search across session id/title/cwd/first message/all messages/path

Empty-list render behavior:

- renders a message instead of crashing
- Enter on empty does nothing (no callback)
- Esc/Ctrl+C still work

Caveat: UI text says `Press Tab to view all`, but this component currently has no Tab handler and current wiring only lists current-scope sessions.

## Runtime switch execution (`AgentSession.switchSession`)

`switchSession(sessionPath)` is the core in-process switch path.

Lifecycle/state transition:

1. capture `previousSessionFile`
2. emit `session_before_switch` hook event (`reason: "resume"`, cancellable)
3. if canceled -> return `false` with no switch
4. disconnect from current agent event stream
5. abort active generation/tool flow
6. clear queued steering/follow-up/next-turn message buffers
7. flush session writer (`sessionManager.flush()`) to persist pending writes
8. `sessionManager.setSessionFile(sessionPath)`
   - updates session file pointer
   - writes terminal breadcrumb
   - loads entries / migrates / blob-resolves / reindexes
   - if missing/invalid file data: initializes a new session at that path and rewrites header
9. update `agent.sessionId`
10. rebuild display context via `buildDisplaySessionContext()`
11. restore persisted/discovered MCP tool selections and rebuild active tools/system prompt when discovery is enabled
12. emit `session_switch` hook event (`reason: "resume"`, `previousSessionFile`)
13. replace agent messages with rebuilt context and sync todos
14. close provider sessions when switching to a different session or when same-session reload changed replay messages
15. restore default model from `sessionContext.models.default` if available and present in model registry
16. restore thinking level and service tier:
    - thinking uses persisted `thinking_level_change`, otherwise the configured default clamped to model capability
    - service tier uses persisted `service_tier_change`, otherwise the configured `serviceTier` setting (`"none"` becomes unset)
17. reconnect agent listeners and return `true`

## UI state rebuild after interactive switch

`SelectorController.handleResumeSession` performs UI reset around `switchSession`:

- stop loading animation
- clear status container
- clear pending-message UI and pending tool map
- reset streaming component/message references
- call `session.switchSession(...)`
- clear chat container and rerender from session context (`renderInitialMessages`)
- reload todos from new session artifacts
- show `Resumed session`

So visible conversation/todo state is rebuilt from the new session file.

## Startup resume vs in-session switch

### Startup resume (`--continue`, `--resume`, direct open)

- Session file is chosen before `createAgentSession(...)`.
- `sdk.ts` builds `existingSession = sessionManager.buildSessionContext()`.
- Agent messages are restored once during session creation.
- Model/thinking are selected during creation (including restore/fallback logic).
- Interactive mode then runs `#restoreModeFromSession()` to re-enter persisted mode state (currently plan/plan_paused).

### In-session switch (`/resume`-style selector path)

- Uses `AgentSession.switchSession(...)` on an already-running `AgentSession`.
- Messages/model/thinking are rebuilt immediately in place.
- Hook `session_before_switch`/`session_switch` events are emitted.
- UI chat/todos are refreshed.
- No dedicated post-switch mode restore call is made in selector flow; mode re-entry behavior is not symmetric with startup `#restoreModeFromSession()`.

## Failure and edge-case behavior

### Cancellation paths

- CLI picker cancel -> returns `null`; bare resume exits silently without writes.
- Interactive picker cancel -> editor restored, no session change.
- Hook cancellation (`session_before_switch`) -> `switchSession()` returns `false`.

### Empty list paths

- CLI `--resume` (no value): empty list prints `No sessions found` and exits.
- Interactive selector: empty list renders message and remains cancellable.

### Missing/invalid target session file

When opening/switching to a specific path (`setSessionFile`):

- ENOENT -> treated as empty -> new session initialized at that exact path and persisted.
- malformed/invalid header (or effectively unreadable parsed entries) -> treated as empty -> new session initialized and persisted.

This is recovery behavior, not hard failure.

### Hard failures

Switch/open can still throw on true I/O failures (permission errors, rewrite failures, etc.), which propagate to callers.

### ID prefix matching caveats

- ID matching uses `startsWith` and takes first match in sorted list.
- No ambiguity UI if multiple sessions share prefix.
- `SessionManager.list(...)` excludes sessions with zero messages, so those sessions are not resumable via ID match/list picker.
