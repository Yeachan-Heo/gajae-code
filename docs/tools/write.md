# write

> Create or overwrite a file, archive entry, or SQLite row.

## Source
- Entry: `packages/coding-agent/src/tools/write.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/write.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/archive-reader.ts` — parse `archive.ext:entry` selectors.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — detect SQLite paths and perform row insert/update/delete.
  - `packages/coding-agent/src/lsp/index.ts` — format-on-write and diagnostics writethrough.
  - `packages/coding-agent/src/tools/auto-generated-guard.ts` — block overwriting generated files.
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — invalidate shared FS scan caches after writes.
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — resolve paths and enforce plan-mode write policy.

## Inputs
| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Target path. Plain file path writes a filesystem file. `archive.ext:inner/path` writes an archive entry for `.tar`, `.tar.gz`, `.tgz`, or `.zip`. `db.sqlite:table` inserts a row. `db.sqlite:table:key` updates or deletes a row. |
| `content` | `string` | Yes | Full replacement file content, archive entry content, or SQLite row payload. SQLite non-delete writes must parse as a JSON5 object. Empty or whitespace-only content deletes a SQLite row when `path` includes a row key. |

Worked examples:

```text
path: "src/generated/config.json"
content: "{\n  \"enabled\": true\n}\n"
```

```text
path: "fixtures/archive.zip:templates/email.txt"
content: "hello\n"
```

```text
path: "data/app.sqlite:users:42"
content: "{name: 'Ada', active: true}"
```

## Outputs
Single-shot result.

- Success always returns a text block.
  - Plain file write: `Successfully wrote <bytes> bytes to <relative-path>`.
  - Archive write: `Successfully wrote <bytes> bytes to <relative-archive-path>:<entry-path>`.
  - SQLite write: one of `Inserted row into <table>`, `Updated row '<key>' in <table>`, `No row updated ...`, `Deleted row ...`, `No row deleted ...`.
- If hashline prefixes were copied from `read` output and stripped first, the first text block gets an extra note.
- Plain file writes may also return `details.diagnostics` plus `details.meta.diagnostics` when LSP diagnostics-on-write is enabled.
- SQLite writes use `toolResult(...).sourcePath(...)`, so `details.meta.sourcePath` points at the database file.
- Archive writes return empty `details`.

## Flow
1. `WriteTool.execute()` in `packages/coding-agent/src/tools/write.ts` strips `LINE+ID|` hashline prefixes from `content` when the session is in hashline display mode.
2. It calls `#resolveArchiveWritePath()` first. That uses `parseArchivePathCandidates()` from `packages/coding-agent/src/tools/archive-reader.ts`, checks candidate archive files on disk, and falls back to the longest matching archive suffix even when the archive file does not exist yet.
3. Archive writes call `enforcePlanModeWrite(..., { op: exists ? "update" : "create" })`, then `#writeArchiveEntry()`.
   - The parent directory of the archive file is created with `fs.mkdir(..., { recursive: true })`.
   - `.zip` archives are read with `fflate.unzipSync()`, the target entry is replaced in an in-memory map, and the archive is rewritten with `fflate.zipSync()` + `Bun.write()`.
   - `.tar`, `.tar.gz`, and `.tgz` archives are read with `Bun.Archive`, existing entries are copied into an object map, the target entry is replaced, and `Bun.Archive.write()` rewrites the archive.
   - `invalidateFsScanAfterWrite()` runs on the archive file path.
4. If the path is not treated as an archive, `execute()` calls `#resolveSqliteWritePath()`. That uses `parseSqlitePathCandidates()` and `isSqliteFile()` from `packages/coding-agent/src/tools/sqlite-reader.ts`. Existing non-SQLite files suppress the SQLite path interpretation.
5. SQLite writes call `enforcePlanModeWrite(..., { op: "update" })`, then `#writeSqliteRow()`.
   - The database must already exist; missing DBs throw `SQLite database '<path>' not found`.
   - The tool opens `new Database(..., { create: false, strict: true })` and sets `PRAGMA busy_timeout = 3000`.
   - Whitespace-only `content` with a row key deletes a row.
   - Non-empty `content` is parsed with `Bun.JSON5.parse()`, must be a JSON object, and is routed to insert/update helpers from `packages/coding-agent/src/tools/sqlite-reader.ts`.
   - `invalidateFsScanAfterWrite()` runs on the DB path and the connection is closed in `finally`.
6. Otherwise the tool treats `path` as a plain filesystem file.
   - `enforcePlanModeWrite(..., { op: "create" })` runs before path resolution.
   - Existing files are checked by `assertEditableFile()` to block overwriting detected generated files.
   - The session’s writethrough callback writes content. With LSP enabled and `lsp.formatOnWrite` / `lsp.diagnosticsOnWrite` settings on, `createLspWritethrough()` may format content, sync it through LSP servers, save it, and collect diagnostics. Otherwise `writethroughNoop()` writes directly with `Bun.write()` or `file.write()`.
   - `invalidateFsScanAfterWrite()` runs on the file path.
7. The tool returns a text result and optional diagnostics metadata.

## Modes / Variants
### Plain file path
- Target is any path that does not resolve as an archive selector and does not resolve as an existing-or-new SQLite selector.
- Existing files are overwritten.
- `write.ts` does not call `fs.mkdir()` on this path; parent-directory creation is only implemented in the archive branch.

Example:

```text
path: "tmp/output.txt"
content: "hello\n"
```

### Archive entry write
- Selector syntax: `archive.ext:inner/path`.
- Supported archive suffixes come from `parseArchivePathCandidates()`: `.tar`, `.tar.gz`, `.tgz`, `.zip`.
- The inner path is normalized to `/`, strips empty and `.` segments, rejects `..`, and rejects directory targets ending in `/`.
- Rewrites the whole archive file after replacing one entry.
- Creates the parent directory for the archive file if needed.

Example:

```text
path: "build/assets.tar.gz:css/app.css"
content: "body { color: black; }\n"
```

### SQLite table insert
- Selector syntax: `db.sqlite:table`.
- `content` must parse as a JSON5 object.
- Empty object is allowed and becomes `INSERT INTO <table> DEFAULT VALUES`.
- Query parameters are rejected for SQLite writes.

Example:

```text
path: "data/app.db:users"
content: "{name: 'Ada', active: true}"
```

### SQLite row update / delete
- Selector syntax: `db.sqlite:table:key`.
- Non-empty `content` updates the row.
- Empty or whitespace-only `content` deletes the row.
- Row lookup uses the single-column primary key if present; otherwise it falls back to `rowid`. Composite primary keys and `WITHOUT ROWID` tables are rejected for key-based writes.

Example update:

```text
path: "data/app.sqlite:users:42"
content: "{email: 'ada@example.com'}"
```

Example delete:

```text
path: "data/app.sqlite:users:42"
content: ""
```

## Side Effects
- Filesystem
  - Creates or overwrites plain files.
  - Rewrites entire archive files when writing an archive entry.
  - Creates parent directories for archive files only.
  - Mutates existing SQLite databases; never creates a new SQLite DB.
- Subprocesses / native bindings
  - Uses Bun SQLite bindings via `bun:sqlite`.
  - Uses Bun archive APIs and lazily imports `fflate` for ZIP reads/writes.
  - May talk to configured LSP servers through `packages/coding-agent/src/lsp/index.ts`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Invalidates shared filesystem scan cache entries through `invalidateFsScanAfterWrite()`.
  - Enforces plan-mode write restrictions before mutating the target.
- Background work / cancellation
  - Marks the tool `nonAbortable = true` and `concurrency = "exclusive"` in `WriteTool`.
  - LSP writethrough can schedule deferred diagnostics fetches after a timeout, but plain `write.ts` only consumes the immediate return value.

## Limits & Caps
- `WriteTool` itself exposes no byte cap beyond storing `content` in memory and, for archives, rebuilding the archive in memory.
- Generated-file detection reads at most `CHECK_BYTE_COUNT = 1024` bytes and `HEADER_LINE_LIMIT = 40` header lines from an existing file in `packages/coding-agent/src/tools/auto-generated-guard.ts`.
- SQLite writes set `PRAGMA busy_timeout = 3000`.
- LSP writethrough uses a `5_000` ms operation timeout in `runLspWritethrough()` and may schedule a deferred diagnostics fetch with `AbortSignal.timeout(25_000)` in `scheduleDeferredDiagnosticsFetch()`.

## Errors
- Invalid archive subpaths throw `ToolError` with messages such as:
  - `Archive write path must target a file inside the archive`
  - `Archive write path must target a file, not a directory`
  - `Archive path cannot contain '..'`
- SQLite path parsing throws on unsupported forms:
  - `SQLite write paths do not support query parameters`
  - `SQLite write path must target a table`
  - `SQLite row writes require a non-empty row key`
- Missing SQLite DBs surface as `SQLite database '<path>' not found`.
- SQLite content errors are model-visible `ToolError`s, including invalid JSON5, non-object payloads, unknown columns, non-scalar values, empty update objects, composite primary keys, and `WITHOUT ROWID` tables.
- Existing plain files may be rejected by `assertEditableFile()` when they look generated.
- Archive read/write failures and unexpected SQLite exceptions are wrapped in `ToolError(error.message)`.
- If no LSP server matches or LSP formatting/diagnostics times out, file writes still fall back to writing content; diagnostics may be omitted.

## Notes
- Archive path detection runs before SQLite detection. A path that matches an archive selector is never treated as SQLite.
- SQLite detection declines when an existing file with a `.sqlite` / `.db` suffix is present but does not have SQLite magic bytes; then the path falls back to a plain file write.
- ZIP entry content is encoded with `new TextEncoder().encode(content)` in `#writeArchiveEntry()`. Non-ZIP archive writes pass the string directly to `Bun.Archive.write()`.
- The prompt forbids two common anti-patterns: using `write` for routine edits that should use `edit`, and creating `*.md` / `README` files unless explicitly requested. It also forbids emojis unless requested.
- Plain file writes report byte count using `cleanContent.length`, which is UTF-16 code units in JS, not an on-disk byte measurement.
- `stripWriteContent()` only removes hashline prefixes when the session’s file display mode has `hashLines` enabled; otherwise content is written unchanged.
