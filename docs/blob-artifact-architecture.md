# Blob and artifact storage architecture

This document describes how coding-agent stores large/binary payloads outside session JSONL, how truncated tool output is persisted, and how internal URLs (`artifact://`, `agent://`) resolve back to stored data.

## Why two storage systems exist

The runtime uses two different persistence mechanisms for different data shapes:

- **Content-addressed blobs** (`blob:sha256:<hash>`): global storage used to externalize large image base64 payloads and provider image data URLs from persisted session entries.
- **Session-scoped artifacts** (files under `<sessionFile-without-.jsonl>/`): per-session text files used for full tool outputs and subagent outputs.

They are intentionally separate:

- blob storage optimizes deduplication and stable references by content hash,
- artifact storage optimizes append-only session tooling and human/tool retrieval by local IDs.

## Storage boundaries and on-disk layout

## Blob store boundary (global)

`SessionManager` constructs `BlobStore(getBlobsDir())`, so blob files live in a shared global blob directory (not in a session folder).

Blob file naming:

- file path: `<blobsDir>/<sha256-hex>`
- no extension
- reference string stored in entries: `blob:sha256:<sha256-hex>`

Implications:

- same binary content across sessions resolves to the same hash/path,
- writes are idempotent at the content level,
- blobs can outlive any individual session file.

## Artifact boundary (session-local)

`ArtifactManager` derives artifact directory from session file path:

- session file: `.../<timestamp>_<sessionId>.jsonl`
- artifacts directory: `.../<timestamp>_<sessionId>/` (strip `.jsonl`)

Artifact types share this directory:

- truncated tool output files: `<numericId>.<toolType>.log` (for `artifact://`)
- subagent output files: `<outputId>.md` (for `agent://`)

## ID and name allocation schemes

## Blob IDs: content hash

`BlobStore.put()` computes SHA-256 over the bytes it is given and returns:

- `hash`: hex digest,
- `path`: `<blobsDir>/<hash>`,
- `ref`: `blob:sha256:<hash>`.

No session-local counter is used.

## Artifact IDs: session-local monotonic integer

`ArtifactManager` scans existing `*.log` artifact files on first use to find max existing numeric ID and sets `nextId = max + 1`.

Allocation behavior:

- file format: `{id}.{toolType}.log`
- IDs are sequential strings (`"0"`, `"1"`, ...)
- resume does not overwrite existing artifacts because scan happens before allocation.

If artifact directory is missing, scanning yields empty list and allocation starts from `0`.

## Agent output IDs (`agent://`)

`AgentOutputManager` allocates IDs for subagent outputs as `<index>-<requestedId>` (optionally nested under parent prefix, e.g. `0-Parent.1-Child`). It scans existing `.md` files on initialization to continue from the next index on resume.

## Persistence dataflow

## 1) Session entry persistence rewrite path

Before session entries are written (`#rewriteFile` / incremental persist), `SessionManager` calls `prepareEntryForPersistence()` (via `truncateForPersistence`).

Key behaviors:

1. **Large string truncation**: oversized strings are cut and suffixed with `"[Session persistence truncated large content]"`; signature fields (`thinkingSignature`, `thoughtSignature`, `textSignature`) are cleared instead of truncated.
2. **Transient field stripping**: `partialJson` and `jsonlEvents` are removed from persisted entries.
3. **Image externalization to blobs**:
   - image blocks in `content` arrays are externalized when `data` is not already a blob ref and base64 length is at least threshold (`BLOB_EXTERNALIZE_THRESHOLD = 1024`),
   - provider-style `image_url` data URLs are externalized when they start with `data:image/` and contain `;base64,`,
   - image block `data` is stored as decoded binary bytes,
   - provider data URLs are stored as the original UTF-8 data URL string,
   - persisted values are replaced with `blob:sha256:<hash>`.

This keeps session JSONL compact while preserving recoverability.

## 2) Session load rehydration path

When opening a session (`setSessionFile`), after migrations, `SessionManager` runs `resolveBlobRefsInEntries()`.

For message/custom-message image blocks with `blob:sha256:<hash>` and for persisted provider `image_url` fields with blob refs:

- reads blob bytes from blob store,
- converts image-block bytes back to base64,
- converts provider `image_url` blobs back to the original string,
- mutates in-memory entry fields for runtime consumers.

If blob is missing:

- `resolveImageData()` logs warning,
- returns original ref string unchanged,
- load continues (no hard crash).

## 3) Tool output spill/truncation path

`OutputSink` powers streaming output in bash/python/ssh and related executors.

Behavior:

1. Every chunk is sanitized and appended to in-memory tail buffer.
2. When in-memory bytes exceed spill threshold (`DEFAULT_MAX_BYTES`, 50KB), sink marks output truncated.
3. If an artifact path is available, sink opens a file writer and writes:
   - existing buffered content once,
   - all subsequent chunks.
4. In-memory buffer is always trimmed to tail window for display.
5. `dump()` returns summary including `artifactId` only when file sink was successfully created.

Practical effect:

- UI/tool return shows truncated tail,
- full output is preserved in artifact file and referenced as `artifact://<id>`.

If file sink creation fails (I/O error, missing path, etc.), sink silently falls back to in-memory truncation only; full output is not persisted.

## URL access model

## `blob:` references

`blob:sha256:<hash>` is a persistence reference inside session entry payloads, not an internal URL scheme handled by the router. Resolution is done by `SessionManager` during session load.

## `artifact://<id>`

Handled by `ArtifactProtocolHandler`:

- requires active session artifact directory,
- ID must be numeric,
- resolves by matching filename prefix `<id>.`,
- returns raw text (`text/plain`) from the matched `.log` file,
- when missing, error includes list of available artifact IDs.

Missing directory behavior:

- if artifacts directory does not exist, throws `No artifacts directory found`.

## `agent://<id>`

Handled by `AgentProtocolHandler` over `<artifactsDir>/<id>.md`:

- plain form returns markdown text,
- `/path` or `?q=` forms perform JSON extraction,
- path and query extraction cannot be combined,
- if extraction requested, file content must parse as JSON.

Missing directory behavior:

- throws `No artifacts directory found`.

Missing output behavior:

- throws `Not found: <id>` with available IDs from existing `.md` files.

Read tool integration:

- `read` supports offset/limit pagination for non-extraction internal URL reads,
- rejects `offset/limit` when `agent://` extraction is used.

## Resume, fork, and move semantics

## Resume

- `ArtifactManager` scans existing `{id}.*.log` files on first allocation and continues numbering.
- `AgentOutputManager` scans existing `.md` output IDs and continues numbering.
- `SessionManager` rehydrates blob refs to base64 on load.

## Fork

`SessionManager.fork()` creates a new session file with new session ID and `parentSession` link, then returns old/new file paths. Artifact copying is handled by `AgentSession.fork()`:

- attempts recursive copy of old artifact directory to new artifact directory,
- missing old directory is tolerated,
- non-ENOENT copy errors are logged as warnings and fork still completes.

ID implications after fork:

- if copy succeeded, artifact counters in new session continue after max copied ID,
- if copy failed/skipped, new session artifact IDs start from `0`.

Blob implications after fork:

- blobs are global and content-addressed, so no blob directory copy is required.

## Move to new cwd

`SessionManager.moveTo()` renames both session file and artifact directory to the new default session directory, with rollback logic if a later step fails. This preserves artifact identity while relocating session scope.

## Failure handling and fallback paths

| Case                                                     | Behavior                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Blob file missing during rehydration                     | Warn and keep `blob:sha256:` ref string in-memory                     |
| Blob read ENOENT via `BlobStore.get`                     | Returns `null`                                                        |
| Artifact directory missing (`ArtifactManager.listFiles`) | Returns empty list (allocation can start fresh)                       |
| Artifact directory missing (`artifact://` / `agent://`)  | Throws explicit `No artifacts directory found`                        |
| Artifact ID not found                                    | Throws with available IDs listing                                     |
| OutputSink artifact writer init fails                    | Continues with tail-only truncation (no full-output artifact)         |
| No session file (some task paths)                        | Task tool falls back to temp artifacts directory for subagent outputs |

## Binary blob externalization vs text-output artifacts

- **Blob externalization** is for image payloads inside persisted session entry content and provider image data URLs; it replaces inline payload strings in JSONL with stable content refs.
- **Artifacts** are plain text files for execution output and subagent output; they are addressable by session-local IDs through internal URLs.

The two systems intersect only indirectly (both reduce session JSONL bloat) but have different identity, lifetime, and retrieval paths.

## Implementation files

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob reference format, hashing, put/get, externalize/resolve helpers.
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — session artifact directory model and numeric artifact ID/path allocation.
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink` truncation/spill-to-file behavior and summary metadata.
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — persistence transforms, blob rehydration on load, session fork/move interactions.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — artifact directory copy during interactive fork.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://` resolver.
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` resolver + JSON extraction.
- [`src/sdk/session.ts`](../packages/coding-agent/src/sdk/session.ts) — internal URL router wiring and artifacts-dir resolver.
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — session-scoped agent output ID allocation for `agent://`.
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — subagent output artifact writes (`<id>.md`) and temp artifact directory fallback.
