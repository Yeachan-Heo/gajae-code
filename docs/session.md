# Session Storage and Entry Model

This document is the source of truth for how coding-agent sessions are represented, persisted, migrated, and reconstructed at runtime.

## Scope

Covers:

- Session JSONL format and versioning
- Entry taxonomy and tree semantics (`id`/`parentId` + leaf pointer)
- Migration/compatibility behavior when loading old or malformed files
- Context reconstruction (`buildSessionContext`)
- Persistence guarantees, failure behavior, truncation/blob externalization
- Storage abstractions (`FileSessionStorage`, `MemorySessionStorage`) and related utilities

Does not cover `/tree` UI rendering behavior beyond semantics that affect session data.

## Implementation Files

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts)
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts)
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts)
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts)

## On-Disk Layout

Default managed session file location:

```text
~/.gjc/agent/sessions/v2-<52-char-base32-sha256>/<timestamp>_<sessionId>.jsonl
```

The `v2-…` component is a fixed-width SHA-256/base32 digest of the native canonical workspace identity (identity version 1); it is **not** a reversible or injective user-facing encoding. The binding file `.gjc-managed-session-scope.v2.json` records the canonical identity and digest. Existing bindings must be regular, canonically encoded files that agree with the resolved identity; a mismatch or unsafe path fails closed.

Identity is platform-specific:

- POSIX paths and supported local aliases that resolve to the same native directory identity share the same v2 scope.
- On Windows, equivalent supported local path spellings (including drive-letter/case aliases) resolve through the native identity API before the scope is derived.
- UNC/network workspaces are unsupported and return a `network_unsupported` resolution result; no SMB share is needed or assumed by this design.

The default managed writer creates new data only in v2 scopes. It never writes new legacy-layout data. `--session-dir` is an explicit storage/lookup override and is not a request to derive the default managed scope.

### Legacy migration and retention

Legacy encoded directories are discovered only after validating each candidate's header and workspace identity. With `session.directoryMigration: "copy-retain"` (the default), an eligible legacy session is copied into the v2 scope without replacing an existing destination; the legacy source is retained. Set `session.directoryMigration: "disabled"` to leave legacy candidates unmigrated. Migration is lazy and guarded by a managed lock, binding checks, no-follow/owner-only path checks, and source identity validation; conflicts, unsafe artifacts, or changed sources fail rather than guessing.

Migration does not automatically clean up legacy files, copied files, locks, artifacts, or abandoned data. A migration tombstone records a completed/retired source so repeated scans do not reinterpret it as a new migration request; it is not evidence that the old data was deleted. Artifact copying is bounded and rejects symlinks, hard links, excessive depth, file count, or size.

### Security boundary

Managed storage enforces owner-only directory/file security and refuses unsafe symlinks or malformed bindings on the paths it verifies. This is a local storage-integrity boundary, not authentication, authorization, encryption, or a guarantee against a hostile concurrent local actor/race outside the verified operations. Callers must still protect the agent directory and session contents.

Blob store location:

```text
~/.gjc/agent/blobs/<sha256>
```

Terminal breadcrumb files are written under:

```text
~/.gjc/agent/terminal-sessions/<terminal-id>
```

Breadcrumb content is two lines: original cwd, then session file path. `continueRecent()` prefers this terminal-scoped pointer before scanning most-recent mtime.

## File Format

Session files are JSONL: one JSON object per line.

- Line 1 is always the session header (`type: "session"`).
- Remaining lines are `SessionEntry` values or v4 append-only patch records. `header_patch` records update header metadata and `entry_patch` records replace a message payload when replay metadata is sanitized.
- Entries and patch records are append-only at runtime; branch navigation moves a pointer (`leafId`) rather than mutating existing entries.

### Header (`SessionHeader`)

```json
{
  "type": "session",
  "version": 4,
  "id": "1f9d2a6b9c0d1234",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "parentSession": "optional lineage marker"
}
```

Notes:

- `version` is optional in v1 files; absence means v1.
- `parentSession` is an opaque lineage string. Current code writes either a session id or a session path depending on flow (`fork`, `forkFrom`, `createBranchedSession`, or explicit `newSession({ parentSession })`). Treat as metadata, not a typed foreign key.

### Entry Base (`SessionEntryBase`)

All non-header entries include:

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

`parentId` can be `null` for a root entry (first append, or after `resetLeaf()`).

## Entry Taxonomy

`SessionEntry` is the union of:

- `message`
- `thinking_level_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `ttsr_injection`
- `session_init`
- `mode_change`
- `mcp_tool_selection`

### `message`

Stores an `AgentMessage` directly.

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "anthropic-model-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "timestamp": 1760000000000
  }
}
```

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role` is optional; missing is treated as `default` in context reconstruction.

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": "flex"
}
```

`serviceTier` can also be `null`.

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

If branching from root (`branchFromId === null`), `fromId` is the literal string `"root"`.

### `custom`

Extension state persistence; ignored by `buildSessionContext`.

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "my-extension",
  "data": { "state": 1 }
}
```

### `custom_message`

Extension-provided message that does participate in LLM context. `content` can be a string or text/image content blocks, and `attribution` records whether the user or agent initiated it.

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined` clears a label for `targetId`.

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `mcp_tool_selection`

```json
{
  "type": "mcp_tool_selection",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:28:30.000Z",
  "selectedToolNames": ["server.tool"]
}
```

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": "...",
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" }
}
```

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFile": "/tmp/plan.md" }
}
```

## Versioning and Migration

Current session version: `4`.

### v1 -> v2

Applied when header `version` is missing or `< 2`:

- Adds `id` and `parentId` to each non-header entry.
- Reconstructs a linear parent chain using file order.
- Migrates compaction field `firstKeptEntryIndex` -> `firstKeptEntryId` when present.
- Sets header `version = 2`.

### v2 -> v3

Applied when header `version < 3`:

- For `message` entries: rewrites legacy `message.role === "hookMessage"` to `"custom"`.
- Sets header `version = 3`.

### v3 -> v4

Applied when header `version < 4`:

- Sets header `version = 4`.
- Enables v4 append-only `header_patch` and `entry_patch` records. Patch records are applied only when the header version is exactly `4`; they are ignored for v1-v3 transcripts.

### Migration Trigger and Persistence

- v1-v3 transcripts remain readable without mutation during read-only inspection and strict resume selection.
- Mutable session loads migrate v1-v3 entries in memory and immediately rewrite the complete JSONL file at version 4.
- v4 sessions load without a migration rewrite.

## Load and Compatibility Behavior

`loadEntriesFromFile(path)` behavior:

- Missing file (`ENOENT`) -> returns `[]`.
- Non-parseable lines are handled by lenient JSONL parser (`parseJsonlLenient`).
- If first parsed entry is not a valid session header (`type !== "session"` or missing string `id`) -> returns `[]`.

`SessionManager.setSessionFile()` behavior:

- `[]` from loader is treated as empty/nonexistent session and replaced with a new initialized session file at that path.
- Valid files are loaded, migrated if needed, blob refs resolved, then indexed.

## Tree and Leaf Semantics

The underlying model is append-only tree + mutable leaf pointer:

- Every append method creates exactly one new entry whose `parentId` is current `leafId`.
- The new entry becomes the new `leafId`.
- `branch(entryId)` moves only `leafId`; existing entries remain unchanged.
- `resetLeaf()` sets `leafId = null`; next append creates a new root entry (`parentId: null`).
- `branchWithSummary()` sets leaf to branch target and appends a `branch_summary` entry.

`getEntries()` returns all non-header entries in insertion order. Existing entries are not deleted in normal operation; rewrites preserve logical history while updating representation (migrations, move, targeted rewrite helpers).

## Context Reconstruction (`buildSessionContext`)

`buildSessionContext(entries, leafId, byId?)` resolves what is sent to the model.

Algorithm:

1. Determine leaf:
   - `leafId === null` -> return empty context.
   - explicit `leafId` -> use that entry if found.
   - otherwise fallback to last entry.
2. Walk `parentId` chain from leaf to root and reverse to root->leaf path.
3. Derive runtime state across path:
   - `thinkingLevel` from latest `thinking_level_change` (default `"off"`)
   - `serviceTier` from latest `service_tier_change`
   - model map from `model_change` entries (`role ?? "default"`)
   - fallback `models.default` from assistant message provider/model if no explicit model change
   - deduplicated `injectedTtsrRules` from all `ttsr_injection` entries
   - selected MCP discovery tools from latest `mcp_tool_selection`
   - mode/modeData from latest `mode_change` (default mode `"none"`)
4. Build message list:
   - `message` entries pass through
   - `custom_message` entries become `custom` AgentMessages via `createCustomMessage`
   - `branch_summary` entries become `branchSummary` AgentMessages via `createBranchSummaryMessage`
   - if a `compaction` exists on path:
     - emit compaction summary first (`createCompactionSummaryMessage`)
     - emit path entries starting at `firstKeptEntryId` up to the compaction boundary
     - emit entries after the compaction boundary

`custom`, `session_init`, `service_tier_change`, `mcp_tool_selection`, and `ttsr_injection` entries do not inject model context directly.

## Persistence Guarantees and Failure Model

### Persist vs in-memory

- `SessionManager.create/open/continueRecent/forkFrom` -> persistent mode (`persist = true`).
- `SessionManager.inMemory` -> non-persistent mode (`persist = false`) with `MemorySessionStorage`.

### Write pipeline

Writes are serialized through an internal promise chain (`#persistChain`) and `NdjsonFileWriter`.

- `append*` updates in-memory state immediately.
- Persistence is deferred until at least one assistant message exists.
  - Before first assistant: entries are retained in memory; no file append occurs.
  - When first assistant exists: full in-memory session is flushed to file.
  - Afterwards: new entries append incrementally.

Rationale in code: avoid persisting sessions that never produced an assistant response.

### Durability operations

- `flush()` flushes writer and calls `fsync()`.
- Atomic full rewrites (`#rewriteFile`) write to temp file, flush+fsync, close, then rename over target.
- Used for migrations, `setSessionName`, `rewriteEntries`, move operations, and tool-call arg rewrites.

### Error behavior

- Persistence errors are latched (`#persistError`) and rethrown on subsequent operations.
- First error is logged once with session file context.
- Writer close is best-effort but propagates the first meaningful error.

## Data Size Controls and Blob Externalization

Before persisting entries:

- Large strings are truncated to `MAX_PERSIST_CHARS` (500,000 chars) with notice:
  - `"[Session persistence truncated large content]"`
- Transient fields `partialJson` and `jsonlEvents` are removed.
- If object has both `content` and `lineCount`, line count is recomputed after truncation.
- Image blocks in `content` arrays with base64 length >= 1024 are externalized to blob refs:
  - stored as `blob:sha256:<hash>`
  - raw bytes written to blob store (`BlobStore.put`)

On load, blob refs are resolved back to base64 for message/custom_message image blocks.

## Storage Abstractions

`SessionStorage` interface provides all filesystem operations used by `SessionManager`:

- sync: `ensureDirSync`, `existsSync`, `writeTextSync`, `statSync`, `listFilesSync`
- async: `exists`, `readText`, `readTextPrefix`, `writeText`, `rename`, `unlink`, `openWriter`

Implementations:

- `FileSessionStorage`: real filesystem (Bun + node fs)
- `MemorySessionStorage`: map-backed in-memory implementation for tests/non-persistent sessions

`SessionStorageWriter` exposes `writeLine`, `flush`, `fsync`, `close`, `getError`.

## Session Discovery Utilities

Defined in `session-manager.ts`:

- `getRecentSessions(sessionDir, limit)` -> lightweight metadata for UI/session picker
- `findMostRecentSession(sessionDir)` -> newest by mtime
- `list(cwd, sessionDir?)` -> sessions in one project scope
- `listAll()` -> sessions across all project scopes under `~/.gjc/agent/sessions`

Metadata extraction reads only a prefix (`readTextPrefix(..., 4096)`) where possible.

## Related but Distinct: Prompt History Storage

`HistoryStorage` (`history-storage.ts`) is a separate SQLite subsystem for prompt recall/search, not session replay.

- DB: `~/.gjc/agent/history.db`
- Table: `history(id, prompt, created_at, cwd)`
- FTS5 index: `history_fts` with trigger-maintained sync
- Deduplicates consecutive identical prompts using in-memory last-prompt cache
- Async insertion (`setImmediate`) so prompt capture does not block turn execution

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.
