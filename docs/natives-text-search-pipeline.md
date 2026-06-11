# Natives Text/Search Pipeline

This document maps the `@gajae-code/natives` text/search/code surface from generated JS/TS exports to Rust N-API modules and back to JS result objects.

Terminology follows `docs/natives-architecture.md`:

- **Generated binding**: public API in `packages/natives/native/index.d.ts`.
- **Rust module layer**: N-API exports in `crates/pi-natives/src/*`.
- **Shared scan cache**: `fs_cache`-backed directory-entry cache used by discovery/search flows.

## Implementation files

- `packages/natives/native/index.d.ts`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/glob_util.rs`
- `crates/pi-natives/src/fs_cache.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/tokens.rs`

## JS API ↔ Rust export mapping

| JS API                                                                          | Rust export (`#[napi]`, snake_case -> camelCase) | Rust module    |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| `grep(options, onMatch?)`                                                       | `grep`                                           | `grep.rs`      |
| `search(content, options)`                                                      | `search`                                         | `grep.rs`      |
| `hasMatch(content, pattern, ignoreCase?, multiline?)`                           | `hasMatch`                                       | `grep.rs`      |
| `fuzzyFind(options)`                                                            | `fuzzyFind`                                      | `fd.rs`        |
| `glob(options, onMatch?)`                                                       | `glob`                                           | `glob.rs`      |
| `invalidateFsScanCache(path?)`                                                  | `invalidateFsScanCache`                          | `fs_cache.rs`  |
| `astGrep(options)`                                                              | `astGrep`                                        | `ast.rs`       |
| `astEdit(options)`                                                              | `astEdit`                                        | `ast.rs`       |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrapTextWithAnsi`                               | `text.rs`      |
| `truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth)`                      | `truncateToWidth`                                | `text.rs`      |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `sliceWithWidth`                                 | `text.rs`      |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extractSegments`                                | `text.rs`      |
| `visibleWidth(text, tabWidth)`                                                  | `visibleWidth`                                   | `text.rs`      |
| `highlightCode(code, lang, colors)`                                             | `highlightCode`                                  | `highlight.rs` |
| `supportsLanguage(lang)`                                                        | `supportsLanguage`                               | `highlight.rs` |
| `getSupportedLanguages()`                                                       | `getSupportedLanguages`                          | `highlight.rs` |
| `countTokens(input, encoding?)`                                                 | `countTokens`                                    | `tokens.rs`    |

## Pipeline overview by subsystem

## 1) Regex search (`grep`, `search`, `hasMatch`)

### Input/options flow

1. Callers invoke generated native exports directly; there is no package-local TS wrapper that renames `search` to `searchContent`.
2. Rust option structs in `grep.rs` deserialize camelCase fields (`ignoreCase`, `maxCount`, `contextBefore`, `contextAfter`, `maxColumns`, `timeoutMs`).
3. `grep` creates `CancelToken` from `timeoutMs` + `AbortSignal` and runs inside `task::blocking("grep", ...)`.
4. `search` and `hasMatch` operate on provided string/`Uint8Array` content and do not scan the filesystem.

### Execution branches

- **In-memory branch**
  - `search` -> `search_sync` / search helpers over provided content bytes.
  - `hasMatch` compiles/checks pattern against provided content and returns a boolean.
  - No filesystem scan, no `fs_cache`.
- **Single-file branch**
  - `grep` resolves path, checks metadata is file, and searches that file.
- **Directory branch**
  - Optional cache lookup via `fs_cache::get_or_scan` when `cache: true`.
  - Fresh scan via `fs_cache::force_rescan` when `cache: false`.
  - Optional empty-result recheck when cached results are older than the empty-result recheck threshold.
  - Entry filtering: file-only + optional glob filter (`glob_util`) + optional type filter mapping (`js`, `ts`, `rust`, etc.).

### Search/collection semantics

- Regex engine: `grep_regex::RegexMatcherBuilder` with `ignoreCase` and `multiline`.
- Context resolution:
  - `contextBefore/contextAfter` override legacy `context`.
  - Non-content modes do not collect context.
- Output modes:
  - `content` -> one `GrepMatch` per hit.
  - `count` and `filesWithMatches` map to count-style entries (`lineNumber=0`, `line=""`, `matchCount` set).
- Limits:
  - Global `offset` and `maxCount` apply across files.
  - Parallel path is used only when `maxCount` is unset and `offset == 0`; otherwise sequential path preserves deterministic global offset/limit semantics.

### Result shaping back to JS

- Rust `SearchResult`/`GrepResult` fields map to TS interfaces via N-API object conversion.
- Counters are clamped before crossing N-API where needed.
- `GrepResult.limitReached` is optional and emitted when true.
- Streaming callback receives each shaped `GrepMatch` for content or count-style entries.

### Failure behavior

- `search` returns `SearchResult.error` for regex/search failures instead of throwing.
- `grep` rejects on hard errors such as invalid path, invalid glob/regex, or cancellation timeout/abort.
- `hasMatch` returns a boolean on success and throws on invalid pattern/UTF-8 conversion errors.
- File open/search errors in multi-file scans are skipped per-file; scan continues.

### Malformed regex handling

`grep.rs` sanitizes braces before regex compile:

- Invalid repetition-like braces are escaped (`{`/`}` -> `\{`/`\}`) when they cannot form `{N}`, `{N,}`, `{N,M}`.
- This prevents common literal-template fragments (for example `${platform}`) from failing as malformed repetition.
- Remaining invalid regex syntax still returns a regex error.

## 2) File discovery (`glob`) and fuzzy path search (`fuzzyFind`)

`glob` and `fuzzyFind` share `fs_cache` scans; matching logic differs.

### `glob` flow

1. Caller passes `GlobOptions` directly. `pattern` and `path` are required in the generated type.
2. Rust resolves the search path and compiles pattern via `glob_util::compile_glob`.
3. Entry source:
   - `cache=true` -> `get_or_scan` + optional stale-empty `force_rescan`.
   - `cache=false` -> `force_rescan(..., store=false)` (fresh only).
4. Filtering:
   - skip `.git` always;
   - skip `node_modules` unless requested (`includeNodeModules`) or pattern mentions `node_modules`;
   - apply glob match;
   - apply file-type filter; symlink `file`/`dir` filters resolve target metadata.
5. Optional sort by mtime descending (`sortByMtime`) before truncating to `maxResults`.

### `fuzzyFind` flow

1. Rust implementation lives in `fd.rs`; generated export is `fuzzyFind`.
2. Shared scan source from `fs_cache` with the same cache/no-cache split and stale-empty recheck policy.
3. Scoring:
   - exact / starts-with / contains / subsequence-based fuzzy score;
   - separator/punctuation-normalized scoring path;
   - directory bonus and deterministic tie-break (`score desc`, then `path asc`).
4. Symlink entries are excluded from fuzzy results.

### Failure behavior

- Invalid glob pattern returns an error from `glob_util::compile_glob`.
- Search root must resolve to an existing directory for directory discovery flows.
- Cancellation/timeouts propagate as abort errors via `CancelToken::heartbeat()` checks in loops.

### Malformed glob handling

`glob_util::build_glob_pattern` is tolerant:

- normalizes `\` to `/`,
- auto-prefixes simple recursive patterns with `**/` when `recursive=true`,
- auto-closes unbalanced `{...` alternation groups before compile.

## 3) AST search/edit (`astGrep`, `astEdit`)

`ast.rs` exposes syntax-aware code search and rewrite operations.

- `astGrep(options)` returns matches with byte/line/column coordinates and optional metavariable bindings.
- `astEdit(options)` returns replacement changes, per-file counts, searched/touched file counts, parse errors, and whether edits were applied.
- `dryRun` defaults to true for edit options in the generated documentation.
- Options include language override, path/glob/selector, strictness, limits, parse-error policy, `signal`, and `timeoutMs`.

These exports are direct native APIs used by tooling; they are not mediated by a TS wrapper in `packages/natives`.

## 4) Shared scan/cache lifecycle (`fs_cache`)

`fs_cache` stores scan results as normalized relative entries (`path`, `fileType`, optional `mtime`) keyed by:

- canonical search root,
- `include_hidden`,
- `use_gitignore`.

### Cache state transitions

1. **Miss / disabled**
   - TTL is `0` or key absent/expired -> fresh collection.
2. **Hit**
   - Entry age is within TTL -> return cached entries + `cache_age_ms`.
3. **Stale-empty recheck**
   - If query yields zero matches and cache age exceeds the empty-result threshold, force one rescan.
4. **Invalidation**
   - `invalidateFsScanCache(path?)`:
     - no arg: clear all keys;
     - path arg: remove keys for roots affected by that path.

### Stale-result tradeoff

- Cache favors low-latency repeated scans over immediate consistency.
- TTL window can return stale positives/negatives.
- Empty-result recheck reduces stale negatives for older cached scans at the cost of one extra scan.
- Explicit invalidation is the intended correctness hook after file mutations.

## 5) ANSI text utilities (`text`)

These are pure, in-memory utilities.

### Boundaries and responsibilities

- `text.rs` owns terminal-cell semantics:
  - ANSI sequence parsing,
  - grapheme-aware width and slicing,
  - wrap/truncate/sanitize behavior,
  - explicit tab-width parameter on width-sensitive APIs.
- `grep.rs` line truncation (`maxColumns`) is separate:
  - simple character-boundary truncation of matched lines with `...`,
  - not ANSI-state-preserving and not terminal-cell width aware.

### Key behaviors

- `wrapTextWithAnsi`: wraps by visible width, carries active SGR codes across wrapped lines.
- `truncateToWidth`: visible-cell truncation with ellipsis policy (`Unicode`, `Ascii`, `Omit`), optional right padding.
- `sliceWithWidth`: column slicing with optional strict width enforcement.
- `extractSegments`: extracts before/after segments around an overlay while restoring ANSI state for the `after` segment.
- `sanitizeText` (ANSI/control/surrogate stripping with line-ending normalization) no longer lives in `text.rs`; it moved to `@gajae-code/utils` as a pure-JS implementation in `packages/utils/src/sanitize-text.ts`. The native binding was removed in the same change because the JS version was competitive on the benchmarked workloads, and keeping a Rust copy forced every caller (including `pi-utils`) to pull in `@gajae-code/natives`.
- `visibleWidth`: counts visible terminal cells using caller-supplied tab width.

### Failure behavior

Text functions generally return deterministic transformed output; errors are limited to N-API argument/string conversion boundaries.

## 6) Syntax highlighting (`highlight`)

`highlight.rs` is pure transformation; it does not use the filesystem scan cache.

### Flow

1. Caller passes `code`, optional `lang`, and ANSI color palette.
2. Rust resolves syntax by token/name lookup, extension lookup, alias table fallback, then plain-text fallback.
3. Each line is parsed with syntect `ParseState` and scope stack.
4. Scopes map to semantic color categories and ANSI color codes are injected/reset.

### Failure behavior

- Per-line parse failure does not fail the call: that line is appended unhighlighted and processing continues.
- Unknown/unsupported language falls back to plain text syntax.

## 7) Token counting (`tokens`)

`countTokens(input, encoding?)` is an in-memory utility.

- `input` may be a single string or an array of strings.
- Arrays return one aggregate count and are encoded in parallel in Rust.
- Default encoding is `O200kBase`; `Cl100kBase` remains available as a compatibility alias routing to `o200k_base` in default builds.
- The implementation uses ordinary tokenization, not special-token handling.

## Pure utility vs filesystem-dependent flows

| Flow                         | Filesystem access | Shared cache         | Notes                                         |
| ---------------------------- | ----------------- | -------------------- | --------------------------------------------- |
| `search` / `hasMatch`        | No                | No                   | regex on provided bytes/string only           |
| `text` module functions      | No                | No                   | ANSI/width/sanitization only                  |
| `highlight` module functions | No                | No                   | syntax + ANSI coloring only                   |
| `countTokens`                | No                | No                   | tokenization only                             |
| `astGrep` / `astEdit`        | Yes               | No                   | syntax-aware file search/edit                 |
| `glob`                       | Yes               | Optional             | directory scans + glob filtering              |
| `fuzzyFind`                  | Yes               | Optional             | directory scans + fuzzy scoring               |
| `grep` (file/dir path)       | Yes               | Optional in dir mode | ripgrep over files, optional filters/callback |

## End-to-end lifecycle summary

1. Caller invokes generated native export with typed options.
2. Rust validates/normalizes options and builds matcher/search config.
3. For filesystem flows, entries are scanned (cache hit/miss/rescan where applicable) then filtered/scored/searched.
4. Worker loops periodically call cancel heartbeat; timeout/abort can terminate execution.
5. Rust shapes outputs into N-API objects (`lineNumber`, `matchCount`, `limitReached`, etc.).
6. Generated bindings return typed JS objects and optional per-match callbacks for `grep`/`glob`.
