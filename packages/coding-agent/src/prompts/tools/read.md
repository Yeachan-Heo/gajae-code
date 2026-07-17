Read files, directories, archives, SQLite databases, images, documents, internal resources, and web URLs through a single `path` string.

<instruction>
- One tool for filesystem, archives, SQLite, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), internal URIs, and web URLs (reader-mode by default).
- You SHOULD parallelize independent reads when exploring related files.
- You SHOULD reach for `read` — not a browser/puppeteer tool — for fetching web content.
</instruction>

## Parameters

- `path` — required. Local path, internal URI (`agent://`, `artifact://`, `rule://`, `local://`), or URL. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).

## Selectors

Append `:<sel>` to `path`. The bare path falls back to the default mode.

- _(none)_ — parseable code → structural summary (signatures kept, bodies elided); other files → read from the start (up to {{DEFAULT_LIMIT}} lines).
- `:50` / `:50-` — read from line 50 onward.
- `:50-200` — lines 50–200 inclusive.
- `:50+150` — 150 lines starting at line 50.
- `:20+1` — exactly one line.
- `:5-16,960-973` — multiple ranges in one call (sorted, overlaps merged).
- `:raw` — verbatim text; no anchors, no summary, no line prefixes.
- `:2-4:raw` or `:raw:2-4` — range AND verbatim; the two compose in either order.
- `:conflicts` — one-line-per-block index of every unresolved git merge conflict.

# Files

- Reading a directory path returns a depth-limited dirent listing.
{{#if IS_HL_MODE}}
- Reading a file with an explicit selector returns lines prefixed with `line+hash` anchors: `41th|def alpha():`. The 2-char hash is a content fingerprint that `edit` / `apply_patch` consume — copy it verbatim, NEVER fabricate. The pipe character after the hash is a separator, not part of the file content.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Reading a file with an explicit selector returns lines prefixed with line numbers: `41|def alpha():`.
{{/if}}
{{/if}}
- Parseable code without a selector returns a **structural summary**: declarations kept, large bodies collapsed to `..` (merged brace pair) or `…` (standalone). Summarized output ends with a footer of the form:

  `[NN lines across MM elided regions; read <path>:raw or a line range like <path>:1-9999 for verbatim content]`

  If the elided body is what you actually need, re-issue the **exact selector the footer names**. NEVER guess what's inside `..` / `…` — those markers carry no content.

# Documents & Notebooks

Extracts text from PDF, Word, PowerPoint, Excel, RTF, and EPUB. Notebooks (`.ipynb`) are shown as editable `# %% [type] cell:N` text; edits round-trip back to the underlying JSON preserving notebook metadata. Add `:raw` to a notebook to bypass the converter and read the JSON directly.

# Images

Reading an image path returns the image itself for visual inspection by a vision-capable model.

# Archives

Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read a member, and append a normal selector to the inner path: `archive.zip:dir/file.ts:50-60`.

# SQLite

For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
- `file.db` — list tables with row counts
- `file.db:table` — schema + sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query

# URLs

- Default reader-mode: HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs → clean text/markdown.
- `:raw` returns untouched HTML; line selectors (`:50`, `:50-100`, `:50+150`) paginate the cached fetched output.
- Bare `host:port` URLs collide with the selector grammar — add a trailing slash before the selector: `https://example.com/:80`.

# Internal URIs

`agent://<id>`, `artifact://<id>`, `rule://<name>`, and `local://<name>.md` resolve transparently and accept the same line selectors as filesystem paths. Use `artifact://<id>` to recover full output that a previous bash/eval/tool result spilled or truncated.

<critical>
- Always include `path`; never call `read` with `{}`.
- For line ranges, append the selector to `path`.
- Re-issue the selector named by a summary footer before relying on elided content.
</critical>
