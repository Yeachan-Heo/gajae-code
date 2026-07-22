# read

> Read files, directories, archives, SQLite databases, internal resources, images, documents, and URLs through one `path` string.

## Source
- Entry: `packages/coding-agent/src/tools/read.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/read.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts` — split `path` from trailing selectors; normalize local paths.
  - `packages/coding-agent/src/tools/archive-reader.ts` — detect `archive.ext:inner/path`, index archives, list/read entries.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — detect SQLite targets, parse selectors, render tables.
  - `packages/coding-agent/src/tools/fetch.ts` — URL parsing, fetch/render pipeline, URL cache/artifacts.
  - `packages/coding-agent/src/internal-urls/router.ts` — resolve public internal URLs (`agent://`, `artifact://`, `local://`, `gjc://`, and `rule://`) plus legacy non-public compatibility handlers.
  - `packages/coding-agent/src/edit/notebook.ts` — convert `.ipynb` to editable `# %% [...] cell:N` text.
  - `packages/coding-agent/src/utils/file-display-mode.ts` — decide hashline vs line-number vs raw display.
  - `packages/coding-agent/src/workspace-tree.ts` — render directory trees.
  - `packages/coding-agent/src/edit/file-read-cache.ts` — cache read lines for later hashline edit recovery.
  - `packages/coding-agent/src/tools/index.ts` — registers `read: s => new ReadTool(s)`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Filesystem path, internal URL, or web URL. May end with a trailing selector such as `:50-100` or `:raw`. |

### Selector grammar

For normal file-like reads, `splitPathAndSel()` in `packages/coding-agent/src/tools/path-utils.ts` recognizes the final suffix only when it matches one of these forms:

| Suffix | Meaning |
| --- | --- |
| `:raw` | Raw/verbatim mode. Disables structural summaries and line prefixes. |
| `:N` / `:LN` | Start at 1-indexed line `N`, open-ended. |
| `:A-B` / `:LA-LB` | Inclusive 1-indexed line range. |
| `:A+C` / `:LA+LC` | `C` lines starting at `A`; tool converts this to end line `A + C - 1`. |
| `:range:raw` or `:raw:range` | Same line selection, but raw output. |

Validation in `parseLineRangeChunk()`:
- line numbers are 1-indexed; `:0` throws.
- `+` counts must be `>= 1`.
- `-` end must be `>= start`.

Selector parsing intentionally falls through for unrecognized trailing `:...`; archive and SQLite paths consume their own colon syntax.

URL selectors are parsed separately in `packages/coding-agent/src/tools/fetch.ts` and support only `:raw`, `:N`, `:A-B`, and `:A+C` — no optional `L` prefix there.

## Outputs
- Single-shot `AgentToolResult` built through `toolResult()` in `packages/coding-agent/src/tools/tool-result.ts`.
- `content` is usually one text block. Image reads may return `[text, image]`.
- `details` is path-dependent. `ReadToolDetails` may include:
  - `kind: "file" | "url"` (URL path uses `kind: "url"`; file reads usually omit `kind`)
  - `isDirectory`
  - `resolvedPath`
  - `suffixResolution`
  - URL fields: `url`, `finalUrl`, `contentType`, `method`, `notes`
  - `truncation`
  - `displayContent` (unprefixed text + starting line for TUI rendering)
  - `summary` (`lines`, `elidedSpans`, `elidedLines`) for structural summaries
  - `meta` from `packages/coding-agent/src/tools/output-meta.ts`
- `details.meta.source` is set to the backing path, URL, or internal URL.
- `details.meta.truncation` carries shown range, total lines/bytes, next offset, and optional `artifactId` for cached URL output.
- Directory/archive listings and SQLite table lists also set `details.meta.limits` when list limits trigger.

## Flow
1. `ReadTool.execute()` accepts `{ path }`. `file://...` inputs are expanded first with `expandPath()`.
2. It tries URL handling first via `parseReadUrlTarget()` from `packages/coding-agent/src/tools/fetch.ts`.
   - Plain URL reads call `executeReadUrl()`.
   - URL reads with line selectors load or refresh the URL cache with `loadReadUrlCacheEntry()` and paginate the cached text locally with `#buildInMemoryTextResult()`.
3. If not a web URL, it checks `session.internalRouter.canHandle(...)`.
   - Internal URLs are resolved with `internalRouter.resolve()`.
   - `agent://` query extraction (`/path` or `?q=`) bypasses pagination and returns the extracted content directly.
   - Other internal resources are paginated in-memory by `#buildInMemoryTextResult()`.
4. It tries archive resolution next with `#resolveArchiveReadPath()`.
   - `parseArchivePathCandidates()` scans for `.tar`, `.tar.gz`, `.tgz`, or `.zip` anywhere before `:sub/path`.
   - On success, `#readArchive()` either lists a directory or decodes an entry as UTF-8 text.
5. It tries SQLite resolution with `#resolveSqliteReadPath()`.
   - `parseSqlitePathCandidates()` scans for `.sqlite`, `.sqlite3`, `.db`, `.db3` before any `:table`, `:key`, or `?query` suffix.
   - `#readSqlite()` dispatches on `parseSqliteSelector()`.
6. Otherwise it treats the input as a local filesystem path.
   - `resolveReadPath()` expands `~`, resolves relative to session cwd, treats bare `/` as session cwd, and retries macOS screenshot/NFD/curly-quote variants.
   - If the path does not exist, `findUniqueSuffixMatch()` does a workspace glob-based unique suffix lookup (skipped for remote mounts).
7. Directories go through `#readDirectory()`.
8. Non-directories branch by content type:
   - image metadata / inline image
   - editable notebook text
   - markit-converted document
   - structural summary for parseable code/prose
   - streamed text/line-range read
9. Local text reads are streamed by `streamLinesFromFile()` rather than loading the whole file. The tool adds up to 3 lines of context before/after explicit bounded ranges.
10. Non-empty contiguous local reads are recorded into `getFileReadCache(session)` for later hashline edit recovery.
11. If suffix resolution happened, the first text block is prefixed with `[Path '...' not found; resolved to '...' via suffix match]`.

## Modes / Variants

### Local text files
- No selector: if summarization is enabled and the file is small enough, `#trySummarize()` calls `summarizeCode()`.
  - Guards: file size `<= 2 MiB` (`MAX_SUMMARY_BYTES`), line count `<= 20_000` (`MAX_SUMMARY_LINES`).
  - Summary output keeps selected declarations and replaces elided spans with `...`. When at least one span is elided, the text content ends with a footer like `[NN lines across MM elided regions; read <path>:raw or a line range like <path>:1-9999 for verbatim content]` so the agent has a concrete recovery selector instead of a bare marker.
  - When an elided block sits between matching brace lines, `#renderSummary()` may merge them into one anchored line rather than emitting separate opener/closer lines.
- Explicit selector or summarization miss: streamed text read.
  - Default open-ended limit is `min(session setting read.defaultLimit, DEFAULT_MAX_LINES)`.
  - Explicit ranges expand by `RANGE_LEADING_CONTEXT_LINES = 1` / `RANGE_TRAILING_CONTEXT_LINES = 3` on the constrained sides only.
  - Non-raw output uses `resolveFileDisplayMode()`:
    - hashline anchors when edit mode is hashline, read is not raw, source is mutable, edit tool exists, and `readHashLines !== false`
    - otherwise optional line numbers when `readLineNumbers === true`
    - raw mode suppresses both
- Prefix format in hashline mode is `lineNumber + 2-char line hash + "|"`, e.g. `41th|def alpha():`, from `formatHashLine()` in `packages/coding-agent/src/hashline/hash.ts`.
- Those anchors are what the `edit`/hashline path consumes later; immutable sources and `:raw` intentionally suppress them.

### Directory listings
- `#readDirectory()` calls `buildDirectoryTree()` with:
  - `maxDepth = 2`
  - `perDirLimit = 12`
  - `rootLimit = null`
  - `lineCap = limit` when a line selector was present, else unlimited at this layer
- `buildDirectoryTree()` sorts siblings by recency, shows file sizes and relative ages, and may mark `limits.resultLimit` when the tree truncates.
- Empty directories render as `(empty directory)`.

### Archives
- Supported archive containers: `.tar`, `.tar.gz`, `.tgz`, `.zip`.
- Syntax: `archive.ext`, `archive.ext:path/inside`, `archive.ext:path/inside:50-60`.
- `openArchive()` reads the whole archive into memory, then:
  - tar/tgz uses `new Bun.Archive(bytes)`
  - zip uses `fflate.unzipSync()`
- Archive paths normalize `/`, drop `.` segments, and reject `..`.
- Directory reads list immediate children; files show `name` plus ` (size)` when size > 0.
- Directory listing default limit is `500` entries in `#readArchiveDirectory()`.
- File entries are UTF-8 decoded. Non-UTF-8 entries return `[Cannot read binary archive entry '...' (...)]` instead of bytes.
- Text archive entries reuse the normal in-memory pagination/anchoring path.

### SQLite databases
- Database detection requires both a matching extension and a valid SQLite file header (`isSqliteFile()`).
- Selector forms from `parseSqliteSelector()`:

#### `db.sqlite`
- `kind: "list"`
- Lists non-`sqlite_%` tables with row counts.
- `#readSqlite()` caps the rendered list to `500` tables via `applyListLimit()`.

#### `db.sqlite:table`
- `kind: "schema"`
- Returns `sqlite_master.sql` plus sample rows.
- Sample size is `DEFAULT_SCHEMA_SAMPLE_LIMIT = 5`.

#### `db.sqlite:table:key`
- `kind: "row"`
- Resolves by primary key when the table has exactly one PK column; otherwise falls back to `rowid` lookup.
- No query parameters allowed on row lookups.

#### `db.sqlite:table?limit=...&offset=...&order=...&where=...`
- `kind: "query"`
- Defaults: `limit = 20`, `offset = 0`.
- `limit` is capped at `500`.
- `order` accepts `column` or `column:asc|desc` and must name an existing column.
- `where` is accepted only after `validateWhereClause()` rejects comments, semicolons, and control keywords like `LIMIT`, `OFFSET`, `UNION`, `ATTACH`, `PRAGMA`.
- Unknown query parameters throw.

#### `db.sqlite?q=SELECT ...`
- `kind: "raw"`
- Cannot be combined with table selectors or any other query param.
- Accepts exactly one explicit top-level `SELECT`. Comments, NUL, non-`SELECT` forms, and statement tails are rejected; semicolons inside quoted values and one final terminator are allowed.
- `executeReadQuery()` revalidates the same contract, rejects bound parameters, and streams at most 1,000 rows.

- Rendering caps in `packages/coding-agent/src/tools/sqlite-reader.ts`:
  - ASCII table width `120` (`MAX_RENDER_WIDTH`)
  - per-column width `40` (`MAX_COLUMN_WIDTH`)
- `#readSqlite()` opens Bun SQLite in `{ readonly: true, strict: true }`, enables and verifies `PRAGMA query_only = ON`, then sets `PRAGMA busy_timeout = 3000`. Readonly and query-only modes are defense in depth behind query validation.

### Documents
- `CONVERTIBLE_EXTENSIONS` in `packages/coding-agent/src/tools/read.ts` covers `.pdf`, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, `.epub`.
- `convertFileWithMarkit()` converts the file to text/markdown.
- Converted output is then head-truncated with normal shared limits; there is no line selector support inside the source document before conversion.
- Conversion failures return a text block like `[Cannot read .pdf file: ...]`.

### Jupyter notebooks
- `.ipynb` goes through `readEditableNotebookText()` unless `:raw` was requested.
- Output is editable plain text with markers like:

```text
# %% [code] cell:0
...
```

- Raw mode bypasses that conversion and falls back to file-text reading.

### Images
- Image detection is metadata-based (`readImageMetadata()`).
- Max accepted image size is `20 MiB` (`MAX_IMAGE_INPUT_BYTES`, re-exported as `MAX_IMAGE_SIZE`). Larger files throw.
- For an image path, `read` calls `loadImageInput()` and returns:
  - a text note from the image loader
  - an inline image block (for direct visual inspection by a vision-capable model)
- Unsupported/undecodable image formats throw a `ToolError`.

### Internal URLs
- `read` does not resolve these itself; it delegates to `session.internalRouter.resolve()`.
- Registered public protocols include `agent://`, `artifact://`, `issue://`, `local://`, `gjc://`, `pr://`, and `rule://`. Non-public compatibility handlers may exist in the router for legacy persisted guidance, but they are not part of the public coding-harness URI contract and must not be documented as user/model-facing read targets.
- `#handleInternalUrl()` behavior:
  - parses the URL with `parseInternalUrl()` so colons inside the host segment are legal
  - for `agent://`, treats non-root path extraction or `?q=` extraction as a special no-pagination mode
  - otherwise paginates the resolved text in memory
  - passes `immutable` through to `resolveFileDisplayMode()` so anchors are suppressed for immutable resources such as artifacts and agent outputs
- `issue://<N>` / `pr://<N>` (and the long form `issue://<owner>/<repo>/<N>` / `pr://<owner>/<repo>/<N>`) route through the same SQLite cache the `github` tool writes to; `?comments=0` selects the no-comments rendering. Bare `issue://` / `pr://` (and `issue://<owner>/<repo>` / `pr://<owner>/<repo>`) issue a live `gh issue list` / `gh pr list` for browsing, accepting `?state=`, `?limit=`, `?author=`, `?label=`. PR diffs share the same cache through `pr://<N>/diff` (numbered file listing with per-file hints), `pr://<N>/diff/<i>` (single file slice; 1-indexed), and `pr://<N>/diff/all` (verbatim unified diff); the listing and per-file slices are reconstructed from the cached unified-diff payload, so all three variants share one `gh pr diff` invocation per PR. Diff content is served as `text/plain`. Soft TTL `github.cache.softTtlSec` (default 5 minutes), hard TTL `github.cache.hardTtlSec` (default 7 days). Stale-hit returns the cached row and schedules a background refresh.

### Web URLs
- `parseReadUrlTarget()` accepts `http://`, `https://`, or `www.` targets.
- Plain URL reads call `executeReadUrl()` in `packages/coding-agent/src/tools/fetch.ts`.
- `:raw` means raw HTML/body fallback path; plain URL reads prefer rendered/reader-friendly output.
- `:N`, `:A-B`, `:A+C` do not refetch. They page over cached output from the prior or current URL render.
- URL render pipeline in `renderUrl()`:
  1. normalize scheme (`https://` added for bare `www.`)
  2. try special handlers for known sites unless raw
  3. fetch with `loadPage()`
  4. if content is image/PDF/DOCX/etc., try binary fetch + markit/image handling
  5. handle JSON directly, feeds via feed parser, plain text directly
  6. for HTML and non-raw mode, try markdown alternates, `URL.md`, content negotiation, feed alternates, HTML-to-text renderers, extracted linked documents, then `llms.txt`
  7. fall back to raw body text/html
- URL output is wrapped with a small header:

```text
URL: ...
Content-Type: ...
Method: ...
Notes: ...

---
```

- `method` records the winning path (`json`, `feed`, `text`, `alternate-markdown`, `md-suffix`, `content-negotiation`, `image`, `markit`, `llms.txt`, `raw`, `raw-html`, `insane`, etc.).
- URL reads may return an inline image block when the fetched resource is a supported image and survives resizing.

### Insane Search fallback (opt-in)

- Setting: `web.insaneFallback` (default **off**). When enabled, blocked or degraded public URL reads escalate through the vendored [`fivetaku/insane-search`](https://github.com/fivetaku/insane-search) engine (`packages/coding-agent/vendor/insane-search`) before `read` gives up.
- It runs at three points in `renderUrl()`: the hard fetch failure (`!response.ok`, e.g. 403/WAF), the renderer-failure raw-HTML branch, and the low-quality/JS-gated branch — the latter only after the existing document-extraction and `llms.txt` fallbacks fail. A successful escalation is tagged `Method: insane`.
- **Public content only.** A pre-spawn guard (`src/web/insane/url-guard.ts`) rejects non-HTTP(S) schemes, URL credentials, `localhost`/`.local`/`.internal` hosts, loopback/private/link-local/reserved IPs (IPv4, IPv6, and IPv4-mapped IPv6), and DNS names that resolve to any private/reserved address — **before** any dependency probe or subprocess runs.
- **Raw mode is never escalated.** `read <url>:raw` performs no guard DNS, no dependency probe, and no subprocess.
- **Dependencies are required, never auto-installed.** Phase 0–2 need `python3` + `curl_cffi`; the browser phase needs `node` + `playwright`/`playwright-extra`/`puppeteer-extra-plugin-stealth` under `vendor/insane-search/engine/templates`. Missing dependencies surface a stable `insane fallback unavailable: …` note and `read` continues with its normal degraded result.
- **Login/paywall is not bypassed.** An `authentication required` verdict maps to a note (`insane fallback stopped: authentication required`) and normal degraded output.
- **Residual risk:** the engine performs its own network requests and may follow redirects that this guard never re-validates. This is accepted, documented risk, mitigated by validating the input target and keeping the feature opt-in/off by default. Enabling it changes network posture by allowing TLS/browser impersonation for public pages.

## Side Effects
- Filesystem
  - Opens and streams local files.
  - Reads entire archives into memory before indexing.
  - May read URL-cache artifact files from the session artifacts directory.
  - Writes URL output artifacts when URL output is truncated or when line-range pagination needs a persisted cache body.
- Network
  - URL mode performs HTTP fetches, binary refetches, and alternate-endpoint probes.
- Subprocesses / native bindings
  - Uses Bun SQLite for `.db`/`.sqlite*`.
  - Uses `Bun.Archive` for tar/tgz and `fflate` for zip.
  - URL HTML rendering can delegate into site handlers and HTML-to-text backends from `packages/coding-agent/src/tools/fetch.ts`.
- Session state
  - Records local text lines into `session.fileReadCache` for later stale-anchor recovery.
  - Uses `session.internalRouter` for internal URLs.
  - Uses `session.allocateOutputArtifact()` for cached/truncated URL output.
- Background work / cancellation
  - Most branches honor `AbortSignal`; the tool itself is marked `nonAbortable = true`, but helper paths still call `throwIfAborted(signal)`.

## Limits & Caps
- Shared text truncation defaults from `packages/coding-agent/src/session/streaming-output.ts`:
  - `DEFAULT_MAX_LINES = 3000`
  - `DEFAULT_MAX_BYTES = 50 * 1024`
- Local text open-ended default line limit: `read.defaultLimit`, clamped to `[1, DEFAULT_MAX_LINES]`.
- Explicit line ranges add `1` leading and `3` trailing context lines on the constrained sides (`RANGE_LEADING_CONTEXT_LINES` / `RANGE_TRAILING_CONTEXT_LINES`).
- File streaming chunk size: `8 * 1024` bytes (`READ_CHUNK_SIZE`).
- Local streamed byte budget for line reads: `max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512)`.
- Structural summaries only run when file size `<= 2 MiB` and line count `<= 20_000`.
- Image input max: `20 MiB`.
- Directory tree caps for local directories: depth `2`, per-directory children `12`.
- Archive directory default list cap: `500` entries.
- SQLite:
  - default row query limit `20`
  - schema sample limit `5`
  - max query limit `500`
  - table list cap `500`
  - render width `120`, column width `40`
  - busy timeout `3000` ms
- URL read result shown to the model is truncated to `300` lines and `50 KiB` in `executeReadUrl()`; full cached output can be attached as an artifact.
- Inline fetched URL images:
  - source bytes cap `20 MiB`
  - post-resize inline output cap `300 KiB`
- Unique suffix auto-resolution glob timeout: `5000` ms.
- File-read cache holds `30` paths per session.

## Errors
- Validation and operational failures surface as `ToolError`.
- Selector errors include:
  - `Line selector 0 is invalid; lines are 1-indexed. Use :1.`
  - invalid `A+B` / `A-B` shapes
  - `Cannot combine query extraction with offset/limit` for `agent://.../path:50`
- Missing local/archive/sqlite paths first attempt unique suffix resolution; if no unique match exists they error.
- Out-of-bounds line reads do not throw. They return explanatory text with a suggestion such as `Use :1 ...` or `Use :<last line> ...`.
- Binary archive entries do not throw; they return a text notice.
- Document conversion failure returns a text notice.
- Image oversize/unsupported/invalid cases throw.
- SQLite parser rejects unsupported parameter combinations early; DB/runtime errors are caught and rethrown as `ToolError(message)`.
- URL fetch failure does not throw when HTTP fetch succeeds but `response.ok === false`; it returns a failed URL read with `method: "failed"` and explanatory notes.

## Notes
- `readSchema` examples include `https://example.com:L1-L40`, but URL selector parsing in `packages/coding-agent/src/tools/fetch.ts` does not accept `L` prefixes.
- Hashline anchors are suppressed for raw reads and immutable internal resources because there is no editable backing target for later `edit` consumption.
- `splitPathAndSel()` intentionally treats unknown trailing `:...` as part of the path so `archive.zip:inner/file` and `db.sqlite:table:key` still work.
- `resolveReadPath()` contains macOS-specific filename fallbacks for screenshot timestamps, NFD Unicode normalization, and curly apostrophes.
- A bare `/` resolves to the session cwd, not the filesystem root.
- URL cache keys are session-scoped and normalized by requested URL + raw/rendered mode; both requested URL and final redirected URL are cached.
- URL line-range reads request `ensureArtifact: true, preferCached: true` so a later paginated read can reopen the same rendered body from artifact storage.
- Raw SQLite `q=` uses the same single explicit `SELECT` validator at selector parsing and execution; readonly and verified query-only connection modes remain defense in depth.
- The file-read cache is not a read acceleration cache. It exists to recover hashline edits when the file changed after the read.
