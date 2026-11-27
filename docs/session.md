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

Path-backed descendant stores reject a final pathname symlink even when it points to the original directory with the same device and inode. A derived subtree store owns its newly retained native authority: closing the store releases that authority once, and failed construction releases it before returning an error. Directly supplied authorities remain borrowed and caller-owned.

GC retirement receipt publication rejects a candidate exceeding 64 MiB of canonical UTF-8 JSON, including its trailing newline, before candidate codec serialization or receipt-buffer allocation. Strict authority and continuation validation still applies to admitted receipts. Stored committed histories have per-target quotas below, plus a distinct 50,000-entry receipt-directory limit shared by every transcript in one scope; neither limit proves writer quiescence or physical retirement.

Managed artifact rollback removes only the exact captured named artifact or an attempt's issued subtree identity; newly observed `.gjc-*` or `.removing` names are not deletion authority. Attempt cleanup releases its own retained child on every outcome without closing the borrowed parent or independent authorities. Native tree removal can durably detach the exact tree into recovery quarantine and report `cleanup_pending`; direct discard propagates that outcome. At the post-publication staging cleanup boundary, authorized pending cleanup preserves the completed artifact mapping and reservation rather than rolling back published files, including for empty-artifact staged sessions. Publication and identity failures still fail normally. Canonical absence or returned quarantine evidence does not prove physical reclamation or authorize a residue sweep.

Existing cleanup-pending history consumers replay incrementally with fresh per-replay limits: 50,000 inventory entries and receipt reads each, 100,000 charged work units, 64 MiB per receipt and 512 MiB of cumulative receipt bytes. Inventory is admitted before retaining entries, and no-follow descriptor size is admitted before allocation; canonical positive safe-integer attempts replay in numeric, contiguous order. Protocol inspection preserves retained-file authority and reports `managed_gc_journal_capacity_exceeded` rather than treating exhaustion as absence or corruption. The same explicit code survives SDK `session.list` saved-session omission diagnostics. These replay limits do not establish operation-wide nested-work or append admission, independent writer quiescence or physical reclamation.

Each transcript's committed GC retirement history admits at most 50,000 distinct persisted state files and 512 MiB of unique stored receipt bytes, with the same 64 MiB individual-receipt limit. Separately, a scope's shared receipt directory admits at most 50,000 retirement-receipt entries across all transcript targets. Readers, publishers, prepared-target discovery, and protocol inspectors use streamed bounded inventories and no-follow bounded reads; an over-limit target or shared directory fails the whole inspection rather than disappearing from discovery. Replay keeps incremental continuation evidence, checks canonical numeric contiguous attempts, and rejects immutable-field changes or authority expansion, including shrink then reintroduction. Publishers hold a scope-wide lease while admitting the projected new receipt and per-transcript bytes before candidate codec serialization, buffer allocation, or publication, preventing concurrent appends for distinct transcripts from overshooting the shared directory-entry limit. An idempotent nonappend does not consume another stored slot. These stored-history limits are distinct from the fresh per-replay inventory/read/work limits above; no aggregate operation-wide cumulative read, transcript/hash, nested-work, or append-reservation budget is installed. None of these limits establish writer quiescence or physical reclamation.

Leased and read-only GC receipt readers admit stored-history bytes from the original no-follow descriptor's size and link count before allocating receipt buffers. Reads cannot expand beyond that admitted size, and final descriptor and named-file generation checks reject growth or replacement. GC reader cleanup preserves the original capture failure when closing also fails. These checks do not establish operation-wide traversal admission or writer quiescence.

Separately, managed-session descriptor preflight and bounded range reads preserve the original metadata, pathname, or range error when closing their actual file descriptor also fails; close-only errors after a successful read still propagate. This narrow error-precedence behavior does not complete or expand whole-GC inspection capacity, capture, or protocol admission, nor does it imply completion of broader task-owner work.

Read-only receipt reads, discovery calls, and each protocol-inspector invocation separately admit the shared count/collect inventory family within 100,000 work units and 50,000 aggregate physical entry observations. Both passes, unrelated entries, repeated inventories and internal discovery consume the same invocation budget; acquisition, read attempts including EOF/errors, retention and metadata checks reserve work before proceeding. These units are conservative admitted actions, not exact syscall counts or elapsed time. Each stream has a one-entry buffer and closes on refusal; a fresh independent invocation gets a fresh budget. Multiple passes can exhaust admission below 50,000 distinct stored files and report `managed_gc_journal_capacity_exceeded`. Genuine leased receipt reader/publication paths preserve their stored quotas and ownership checks without this new post-publication inspection cap.

Standalone read-only receipt lookup reuses its admitted initial count for final verification only after fresh directory evidence matches. It still performs a fresh collecting stream and checks counts, names, types and final directory evidence. This removes one redundant count-only stream without changing quotas or leased, discovery, protocol-inspector or destructive paths.

This inventory admission does not cover separate cleanup-receipt replay, artifact-manifest or native-tree enumeration, aggregate file reads/hashing/nested work, or future writer reservations before serialization. Existing authority and discovery fences remain required; exhaustion is not absence, reclamation, quiescence or deletion permission.

Discovery retains each processed scope's original binding and receipt inventory, including authenticated absence, until its terminal consistency check. A new populated scope or journal inserted into an already-processed scope causes refusal instead of silent target omission or adoption of newly observed authority. Original readers are closed on success and refusal.

Exchange-placeholder capture and cleanup verification use a bounded native empty-directory proof. It retains no-follow root/parent handles, stops at the first child instead of traversing or hashing foreign payload, and rechecks the original native identity and metadata. An unexpected child or replacement refuses cleanup without changing it. This proof does not establish physical reclamation, revoke live writers, or bound other GC traversal paths.

On Linux filesystems where the exact POSIX ACL xattr operation returns `ENOTSUP`/`EOPNOTSUPP`, GJC treats that result only as proof that the filesystem cannot store that ACL attribute. The ACL gate still requires the same opened object to pass effective-owner, exact `0700` directory or `0600` file mode, safe-type, no-follow traversal, and identity/replacement checks. Permission denial, I/O errors, present or malformed ACL data, and unknown results remain failures. Managed descriptors use close-on-exec and are not delegated as authority to subprocesses. This compatibility rule does not change explicit `--session-dir`, macOS ACL, or Windows DACL policy.

Managed migration-lock release checks its retained descriptor before native security verification. On Linux, a closed or reused descriptor can be replaced only by reopening the same lock file with no-follow, owner-only security and original file identity checks; the original attempt id must still own the lock before its released record is written. A successor or an insecure replacement is never release authority. Repeated release is inert and cannot retire a successor.

Managed replacement receipts bind the exact staging attempt to a publisher (PID,
kernel process incarnation, host, and JS-isolate owner). Both pending-receipt
promotion and canonical-receipt retirement defer to a live or unobservable
publisher. A stopped process is still an owner; age alone is never permission
to reconcile. The publishing isolate releases its local attempt only after the
transaction exits. A different process or isolate requires positive owner-exit
or PID-reuse evidence before recovering its receipt. A foreign host remains
unresolved. Existing orphan receipts still follow the exact receipt-identity
recovery protocol; a missing pending name is accepted only when the canonical
receipt proves the same file object and bytes.

Deploy this protocol at an owner-coordinated checkpoint for every writer and
reconciler sharing a managed scope: older writers do not honor the publisher
field. Updating one binary does not update already-running processes or clear
their latched persistence errors. Preserve live owners, descendants, locks,
transcripts, and ambiguous commit evidence; do not delete guards, refresh an
expected inode blindly, or retry an uncertain write. A successful SDK query is
not a durable-append or recovery verdict.

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
- Remaining lines are `SessionEntry` values or v4/v5 append-only patch records. `header_patch` records update header metadata and `entry_patch` records replace a message payload when replay metadata is sanitized.
- Entries and patch records are append-only at runtime; branch navigation moves a pointer (`leafId`) rather than mutating existing entries.

### Header (`SessionHeader`)

```json
{
  "type": "session",
  "version": 5,
  "id": "1f9d2a6b9c0d1234",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "starredPatchVersion": 1,
  "starred": true,
  "parentSession": "optional lineage marker"
}
```

Notes:

- `version` is optional in v1 files; absence means v1.
- `starredPatchVersion: 1` declares that the transcript can contain standalone star patches. It lets discovery skip star scans for older v5 transcripts while keeping their existing title/cwd patch lookup bounded.
- `starred` is optional and defaults to `false`. `/star` and `/unstar` persist changes through append-only `header_patch` records; writers checkpoint the current star state beside later title/cwd patches so reverse discovery remains bounded. Starring adds no star-aware branch to ID resolution, `--continue`, deletion, or retention pruning and never protects a session. Like every transcript append, the metadata write updates the file's ordinary modification time, which those existing policies may already consume.
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
- `discovered_builtin_tool_selection`

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

### `discovered_builtin_tool_selection`

```json
{
  "type": "discovered_builtin_tool_selection",
  "id": "e2f3g4h5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:28:31.000Z",
  "selectedToolNames": ["search_tool_bm25"],
  "mutationCorrelationId": "4c2b9c60-20d7-4a18-8d2a-8edc1f892b89"
}
```

`selectedToolNames` is the explicit discovered built-in selection. `mutationCorrelationId` is optional and correlates adjacent MCP and discovered built-in selection records from one mutation.

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

Current session version: `5`.

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
- Introduces append-only `header_patch` and `entry_patch` records.

### v4 -> v5

Applied when header `version < 5`:

- Sets header `version = 5`.
- Separates MCP (`mcp_tool_selection`) and discovered built-in (`discovered_builtin_tool_selection`) selection authority. The legacy v4 combined built-in field remains readable.
- Patch records replay for v4 and v5 transcripts. Headers with a version greater than 5 are rejected before replay.

### Migration Trigger and Persistence

- v1-v4 transcripts remain readable without mutation during read-only inspection and strict resume selection. Patch records replay for v4 and v5 transcripts; headers with a version greater than 5 are rejected before replay.
- Mutable loads migrate v1-v4 entries in memory but do not rewrite on read. Migration and the complete v5 rewrite are deferred until the first authorized persistence.
- v5 sessions load without a migration rewrite. Once v5 data exists, do not roll back to a v4 writer: v4 writers cannot preserve v5 selection authority.

### Discovery selection authority

MCP and discovered built-in authority are independent. Constructor `toolNames` establishes authority only for the domain it names; currently essential built-ins remain baseline policy and never become discovered-built-in authority. A list containing only non-essential built-ins does not suppress configured or exact-config MCP defaults, and a list containing only MCP tools does not suppress built-in baselines. An explicit empty list clears both applicable domains. Explicit new-session names and empty clears are persisted as separate domain entries; omitted selections, essential baselines, and configured/exact baselines are not authoritative and are not persisted. Resume reconstructs state without appending authority entries.

A combined activation appends an MCP entry first and a discovered-built-in entry second. Both entries carry the same optional `mutationCorrelationId`; older entries without this field remain valid.
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

Verified memory deletion rejects owner-bearing transcripts, including replayed header patches, and owner-retirement targets before changing transcript or spill keys. An absent transcript does not prove physical owner retirement; the memory backend cannot execute that protocol. Owner-store opening and deletion-evidence capture also require the final manifest to retain the requested session association, not merely the same owner locator.

`SessionStorageWriter` exposes `writeLine`, `flush`, `fsync`, `close`, `getError`.

Rollback snapshots are authenticated by the issuing live manager; copied, modified, or foreign objects cannot redirect restoration. Explicit persisted-file identity checks support already-admitted cold transcripts above 128 MiB without hashing the entire file: each check requests at most 8,585,217 bytes and compares the canonical pathname, session ID, file identity, size, and modification/change timestamps across bounded reads. This metadata-dependent fingerprint is not whole-file cryptographic coverage or one retained descriptor; unsampled changes preserving every compared field remain outside its detection boundary. Rejected cold restoration leaves the current session installed.

## Session Discovery Utilities

Defined in `session-manager.ts`:

- `getRecentSessions(sessionDir, limit)` -> lightweight metadata for UI/session picker
- `findMostRecentSession(sessionDir)` -> newest by mtime
- `list(cwd, sessionDir?)` -> sessions in one project scope
- `listAll()` -> sessions across all project scopes under `~/.gjc/agent/sessions`

Metadata extraction reads only a prefix (`readTextPrefix(..., 4096)`) where possible.

## Read-only `/btw` and the provider cache prefix

`/btw` is a side question that never changes the main conversation history, running tools, or provider state. Tool calls the model returns alongside its text are never executed. Closing the panel cancels the side request and releases the retained snapshot. Cancelling the main request and cancelling the side request are independent.

The side request uses one of two input paths:

- **A: bounded state projection.** Only user/assistant text and `[tool] name target: ok|error|aborted|running` lines tied to real tool call/result IDs are sent. Targets are limited to per-tool allowlisted fields, and shell commands contribute only the first program name. Raw tool results, full arguments, thinking, and images are never included. After registered secrets are masked, each status line is capped at 192 UTF-8 bytes and all lines at 2048 bytes, dropping the oldest status first. The projection is not evidence for hidden results or earlier changes.
- **C: verified main-prefix extension.** The completed main request's system prompt, tools, and messages are kept, followed by the final assistant answer (including signed thinking) and the side question. Main body settings such as `tool_choice`, thinking, and output budget are unchanged. The side instruction and earlier side exchanges live only in the appended user turn.

C initially covers **the official `api.anthropic.com` endpoint with API-key authentication and automatic prompt cache**. OAuth, OpenAI/Codex, gateways such as OCI/OpenCodex, custom clients or `fetch`, and server-executed tools are outside the verified scope and use A. A running main turn, unpaired tool calls, a changed history/model/credential, or an exceeded cache lifetime, context budget, or lookback limit also use A. The 5-minute/1-hour cache-control lifetime is checked from the request time using the larger of wall-clock and monotonic elapsed time plus a 30-second margin. This eligibility check does not guarantee a server-side cache hit or a billing discount.

Right before the final `fetch` hand-off (after transport transforms such as gzip), the root settings and main message prefix of the C request are compared against the observed main request. A mismatch blocks the request before network I/O. Credentials and URL/header comparison values are kept only as in-process HMACs and are never written to logs or transcripts. When C produces text, only that text is shown; A is called once only when C shows no text. Caller cancellation, timeouts, and errors after partial text never re-answer through A.

## Session ownership (single-owner claims)

A process that opens a persisted session for writing takes a claim on it: a kernel lock on a sidecar under `~/.gjc/runtime/session-owners/`, with a small holder record beside it. The lock ends when the holder exits, however it exits, so a crashed or killed `gjc` leaves no lock behind. The sidecar file itself stays: one `.session-owner` sidecar accumulates per session ever opened, until sidecar pruning lands. The sidecars are empty and harmless; do not delete them by hand while gjc runs, because a deleted sidecar lets a second process lock a new one for the same session. `gjc doctor` warns only above 100,000 of them. Remote clients (ACP editors, `gjc sdk`, the notification daemons) attach to the endpoint of the process that owns the session and never claim. When no process is running the session, the host the broker launches for it is that owner and claims it as `sdk-host`.

A broker `session.resume` with no live endpoint to reuse first probes the claim, in `observe` and `enforce`. The probe takes nothing. If another process holds the session, for example a TUI that is still starting or has just switched to it, the broker waits for that process's endpoint and returns it as `reused: true`. The wait lasts at most 2 seconds under `observe` and 8 seconds under `enforce`, never longer than the request's readiness timeout, and it counts from when the broker received the request, so resumes queued on the same session do not add their waits up. If no endpoint appears:
- under `observe`, resume goes on as before ownership. Beside an embedding such as the desktop app, it launches a host, and that host counts the conflict. A TUI started with `GJC_SDK_DISABLE=1` gets the old `endpoint_stale` answer, and no host is launched.
- under `enforce`, resume fails with `live_session`, a message naming the holder, and `holder: { surface, pid }`, and launches nothing.

If the holder lets go while the broker waits, resume goes on as before ownership: it launches a host if no live row remains, and a live generation-0 row that remains gets the old answer.

The broker reads the mode at the probe and at every poll of the wait, taking its own mode lowered by an explicit lower value in `config.yml`. So `off` set during a wait ends the wait, and `observe` set during a wait stops its refusal. The broker's own mode is cached at its first ownership read, so a raise reaches it only after a restart. A host it launches reads `config.yml` when it starts, though, so after a raise to `enforce`, a holder with no index row is still refused, through that host's claim.

The global setting `session.ownership.mode` decides what claims do:

| Mode | Behaviour |
| --- | --- |
| `off` | No claims and no lock calls. The process is invisible to other processes' claims. |
| `observe` (default) | Claims, releases and counts. A session that another process already holds is counted as a conflict and opened anyway: nothing is refused and no warning is shown; the log records it. A broker resume of a held session waits briefly for the holder's endpoint first (above). |
| `enforce` | Claims as `observe` does, and a session another process holds is not opened for writing (below). Not the default yet. |

Under `enforce`, a session open for writing in another process is refused before anything is written to it:

- `gjc -p --resume <id>` and `gjc -p --continue` (when the newest session is held) print the holder and a `gjc -p --fork <id>` command on stderr and exit non-zero, before any model call. The command repeats a transcript path, quoted for the shell, or adds `--session-dir`, so it finds the same session. Without a terminal, an interactive `gjc --resume <id>` refuses the same way.
- In a terminal, `gjc --resume <id or path>`, the `--resume` picker and `/resume` inside the TUI show a warning that names the holder (`This session is open in another process … another terminal (pid N)`), with **Fork into a new session** and **Cancel**. Fork copies the conversation into a new session in the current folder, reading the held one in place, and continues there; the original is untouched. Cancel exits at launch, returns to the list in the picker, and keeps the current session for `/resume`. At launch the warning comes before the "different project" question, which Fork also answers. The picker marks rows another process holds (`• in terminal`).
- When the holder is a host the broker launched (its index row carries a lifecycle request id: a session created or resumed by ACP, Telegram, the coordinator or `gjc sdk`), the warning also offers **Continue here**. It asks the broker to close that host only between turns (`session.close` with `ifIdle`), waits for the host to exit, and opens the session in this terminal. Clients attached to the host do not block it; they re-attach through the broker to this terminal's endpoint, and an ACP client's next prompt runs here without `session/load`. A host that is running a turn or holds a work lease refuses, and the warning shows again with `The session is running a turn; try again when it finishes.` Continue here is never offered when the holder is another terminal, the app or an embedding.
- While a terminal takes a session over, it holds a generation-0 row in the index from before the close until it has claimed the session. A broker resume that arrives in that gap waits for the terminal's endpoint, as it waits on a held claim, instead of refusing the row or launching another host.
- A switch an embedding requests (`AgentSession.switchSession`), and `SessionManager.setSessionFile`, throw `SessionHeldError` for a held target before any event.
- `gjc --continue` in the TUI, and `autoResume` (in the TUI and with `-p`), start a new session instead and say why: `Your most recent session is open in another terminal (pid N), so a new session was started.` A held candidate that could not have been continued anyway is skipped, as before.
- The SDK session factories (`SessionManager.open`, `openExistingStrict`, `continueRecent`) and `createAgentSession` throw `SessionHeldError`, with `holder` naming the process (its surface and pid). A fork's source is never refused: `gjc --fork` reads a held source where it is.
- An owners directory that fails its safety checks refuses the session too (`SessionOwnershipError`), as the append lock does.
- Remote clients are unaffected: ACP `session/load` and `gjc sdk` attach to the holder's endpoint. If a launched host's open is refused anyway (another process claimed the session after the broker checked), the broker reports the same `live_session` outcome as the resume wait above.

A claim that cannot lock fails open: the session opens without a claim, the attempt counts `fail_open`, and the writes that follow are not counted as `session_write_without_claim`. On Windows there is no native lock yet, so every claim fails open and `gjc session owners` is always empty. One lock timeout (a stalled network filesystem, for example) turns claims off for the rest of that process, so later opens never wait for the lock again.

Operator notes:

- **Kill switch:** `gjc config set session.ownership.mode off` writes the global config (`config.yml` in the agent directory). The setting is global-only: a project `.gjc/settings.json` or `config.yml` cannot change it, and SDK `config.patch` refuses it.
- **Environment override:** `GJC_SESSION_OWNERSHIP=off` (or `observe`) can only lower the configured mode, never raise it. A value that comes from a project `.env` is ignored. A value set in your shell applies only to processes started from that shell. Hosts launched by the SDK broker (ACP sessions, `gjc sdk`, Telegram and other daemon sessions) take the broker's environment, not the shell of the client that asked for them, so use `config.yml` to change their mode.
- **When a change applies:** restart running gjc processes after changing the mode; processes started afterwards use the new mode. A running TUI keeps claiming under the mode it started with, for `/new`, `/resume` and `/fork` too, even on Linux, where it hot-reloads other `config.yml` settings. An SDK embedding without process settings reads `config.yml` once. Refusals are the exception: each refusal reads `config.yml` again and is dropped when that file now names `off` or `observe`, so setting either stops the next refusal in a running process at once. A file that names no mode, or cannot be read (gjc logs a warning), leaves the refusal as it was.
- **Where to look:** `gjc session owners` (or `--json`) lists the sessions held right now and their holder's surface and pid. `gjc stats --summary` and `gjc stats --json` show the ownership counters (`claim_taken`, `claim_released`, `claim_conflict`, `held_at_exit`, `session_write_without_claim`, and others), per gjc version. A process adds its counts only when it exits cleanly, so the totals are a lower bound and a long-running process reports when it stops.

## Related but Distinct: Prompt History Storage

`HistoryStorage` (`history-storage.ts`) is a separate SQLite subsystem for prompt recall/search, not session replay.

- DB: `~/.gjc/agent/history.db`
- Table: `history(id, prompt, created_at, cwd)`
- FTS5 index: `history_fts` with trigger-maintained sync
- Deduplicates consecutive identical prompts using in-memory last-prompt cache
- Async insertion (`setImmediate`) so prompt capture does not block turn execution

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.
