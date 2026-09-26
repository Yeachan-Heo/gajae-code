# find

> Find filesystem paths by glob; use `search` when you need content matches instead of path matches.

## Source
- Entry: `packages/coding-agent/src/tools/find.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/find.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts` — normalize inputs; split base path vs glob.
  - `packages/coding-agent/src/tools/list-limit.ts` — apply result-count caps.
  - `packages/coding-agent/src/session/streaming-output.ts` — truncate text output at byte cap.
  - `packages/coding-agent/src/tools/tool-result.ts` — build `content` and `details.meta`.
  - `packages/coding-agent/src/tools/output-meta.ts` — encode limit / truncation metadata.
  - `packages/coding-agent/src/tools/tool-errors.ts` — map user-facing tool errors.
  - `packages/coding-agent/src/tools/index.ts` — register the built-in local implementation.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `paths` | `string[]` | Yes | One or more globs, files, or directories. Empty strings are rejected. Multiple entries may be merged into one brace-union search when their base paths can be resolved together. |
| `hidden` | `boolean` | No | Whether hidden files are included. Defaults to `true` (`hidden ?? true`). |
| `limit` | `number` | No | Max returned paths. Defaults to `1000`. Must be a finite positive number; non-integers are floored. |
| `gitignore` | `boolean` | No | Respect `.gitignore` during the scan. Defaults to `true` (`gitignore ?? true`); passed to the native glob. |
| `timeout` | `number` | No | Glob timeout in seconds, `0.5`–`60` (schema-validated). Defaults to `5` (`DEFAULT_GLOB_TIMEOUT_MS`). On timeout the tool returns the ranked partial matches collected so far with a `find timed out after <n>s; returning <k> partial matches — increase timeout or narrow pattern` notice. |

## Outputs
The tool returns a single text block plus structured `details`.

- Success text: newline-delimited paths, one per line, relative to the session cwd when possible; absolute when outside cwd. Exact file inputs return that file path as one line.
- Empty result text: `No files found matching pattern`.
- Multi-path partial miss: appends `Skipped missing paths: ...` after the result block, or after the empty-result line.
- `details` may include:
  - `scopePath`: display form of the searched root or merged roots.
  - `fileCount`: number of paths returned after result limiting.
  - `files`: returned paths as an array.
  - `truncated`: whether result count or byte truncation occurred.
  - `resultLimitReached`: reached result limit.
  - `missingPaths`: skipped missing inputs in multi-path calls.
  - `truncation` / `meta.limits`: structured truncation and limit metadata for renderers.
- Streaming: when the runtime supplies `onUpdate`, the local implementation emits incremental newline-delimited text snapshots during globbing, throttled to 200 ms.

## Flow
1. `FindTool.execute()` normalizes each `paths` entry with `normalizePathLikeInput()` and `/\\/g -> "/"` (`packages/coding-agent/src/tools/find.ts`). Empty normalized entries fail with `` `paths` must contain non-empty globs or paths ``.
2. For multi-path local calls, `partitionExistingPaths(..., parseFindPattern)` (`packages/coding-agent/src/tools/path-utils.ts`) stats each base path. Missing entries are skipped; if all are missing, the tool throws `Path not found: ...`. Single missing paths still hard-fail.
3. The tool tries `resolveExplicitFindPatterns()` to merge multiple inputs into one search rooted at a common base path. If that does not apply, it parses one input with `parseFindPattern()`.
4. `parseFindPattern()` determines `(basePath, globPattern, hasGlob)`:
   - no glob chars (`*`, `?`, `[`, `{`) => search that path with implicit `**/*`.
   - glob in the first segment => search from `.` and, unless the pattern already starts with `**/`, prefix it with `**/`.
   - glob later in the path => split at the first glob-bearing segment.
5. `resolveToCwd()` converts the base path to an absolute path under the session cwd. A resolved `/` is rejected with `Searching from root directory '/' is not allowed`.
6. `limit` is defaulted to `DEFAULT_LIMIT` (`1000`) and validated as a positive finite integer. `hidden` defaults to `true`. The tool also creates a 5 s timeout via `AbortSignal.timeout(GLOB_TIMEOUT_MS)`.
7. Execution then branches:
   - **Custom operations branch**: if `FindToolOptions.operations.glob` exists, the tool checks existence with `operations.exists()`, short-circuits exact-file inputs via `operations.stat()` when available, then calls `operations.glob(globPattern, searchPath, { ignore: ["**/node_modules/**", "**/.git/**"], limit })`.
   - **Built-in local branch**: the tool stats `searchPath`. Exact-file inputs return immediately. Directory inputs call `natives.glob()` with `fileType: File`, `hidden`, `maxResults: limit`, `sortByMtime: true`, `gitignore: true`, and the combined abort signal.
8. In the local branch, optional `onMatch` callbacks convert each match to a cwd-relative display path and emit throttled progress updates.
9. After native glob returns, JS sorts `result.matches` by `mtime` descending (`(b.mtime ?? 0) - (a.mtime ?? 0)`) before formatting paths.
10. `buildResult()` applies `applyListLimit()` to cap the array again at `limit`, joins paths with `\n`, then runs `truncateHead()` with `maxLines: Number.MAX_SAFE_INTEGER`. In practice this leaves the 50 KB byte cap in place while disabling the default 3000-line cap.
11. `toolResult()` packages text plus `details`, and records result-limit / truncation metadata for renderers.

## Modes / Variants
- **Exact file path**: if the parsed input has no glob and the resolved path stats as a file, output is that one path.
- **Directory path**: if the parsed input has no glob and stats as a directory, the tool searches it with implicit `**/*`.
- **Single glob path**: one input parsed by `parseFindPattern()`.
- **Merged multi-path search**: multiple inputs resolved by `resolveExplicitFindPatterns()` into one brace-union glob rooted at a common base path.
- **Partial multi-path search with missing inputs**: local multi-path calls skip missing base paths and surface them as `missingPaths` / `Skipped missing paths: ...`.
- **Custom delegated search**: uses injected `FindOperations` instead of local fs + native glob.

## Side Effects
- Filesystem
  - Stats the resolved base path, and in local multi-path mode stats every candidate base path up front.
  - Does not write files.
- Subprocesses / native bindings
  - Built-in local mode calls the native `@gajae-code/natives` glob implementation.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Emits structured progress updates when `onUpdate` is provided.
  - Adds truncation / limit metadata to the tool result.
- Background work / cancellation
  - Local globbing is cancellable through the caller abort signal plus an internal 5 s timeout.

## Limits & Caps
- Default result limit: `1000` (`DEFAULT_LIMIT` in `packages/coding-agent/src/tools/find.ts`).
- Local glob timeout: `5000` ms (`GLOB_TIMEOUT_MS` in `packages/coding-agent/src/tools/find.ts`).
- Output byte cap: `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`).
- Default generic line cap in `truncateHead()` is `3000`, but `find` overrides `maxLines` to `Number.MAX_SAFE_INTEGER`, so byte size — not line count — is the practical output truncation cap.
- Streaming update throttle: `200` ms between `onUpdate` emissions.
- Sort order: most recent `mtime` first in the built-in local branch and promised in the prompt. The tool re-sorts in JS even though native glob receives `sortByMtime: true` so native code can still stop early at `maxResults`.

## Errors
- User-facing `ToolError`s from `FindTool.execute()` include:
  - `` `paths` must contain non-empty globs or paths ``
  - `Path not found: ...`
  - `Searching from root directory '/' is not allowed`
  - `Limit must be a positive number`
  - `Path is not a directory: ...`
  - `find timed out after 5s`
- If the caller aborts, the local branch converts `AbortError` into `ToolAbortError`.
- Non-`ENOENT` stat failures and other unexpected errors are rethrown.
- Empty matches are not errors; they return the no-files text result.

## Notes
- Reach for `find` for filename / path discovery. Reach for `search` when the selection criterion is file contents or regex matches; `search` takes a `pattern` and returns anchored content matches, while `find` only returns matching paths (`packages/coding-agent/src/prompts/tools/find.md`, `packages/coding-agent/src/prompts/tools/search.md`).
- Bare top-level globs are made recursive. `*.ts` is parsed as base `.` plus glob `**/*.ts`; `src/*.ts` stays rooted at `src` with a non-recursive `*.ts` segment; `src/**/*.ts` preserves explicit recursion.
- `.gitignore` is always enabled in the built-in local branch (`gitignore: true`). There is no model-facing flag to disable it.
- `hidden` defaults to `true`; hidden-file exclusion is opt-out, not opt-in.
- Multi-path missing-input tolerance only applies in the built-in local branch. The custom-operations branch hard-fails the first missing `searchPath` it checks.
- The custom `FindOperations.glob()` hook receives `ignore` and `limit`, but not the `hidden` flag or an explicit `.gitignore` toggle. A remote delegate must account for that itself if it wants parity with the local branch.
- Built-in local globbing asks the native layer for `fileType: File`, so recursive directory searches yield files, not directories. Directory outputs are only possible through exact-path passthrough or custom delegates that return them.
