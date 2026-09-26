# search

> Search file contents with a regex across files, directories, globs, and internal URLs.

## Source
- Entry: `packages/coding-agent/src/tools/search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/match-line-format.ts` — model-facing anchor formatting.
  - `packages/coding-agent/src/tools/path-utils.ts` — path normalization, glob splitting, internal URL resolution.
  - `packages/coding-agent/src/tools/file-recorder.ts` — file ordering for grouped output.
  - `packages/coding-agent/src/tools/grouped-file-output.ts` — grouped per-file text layout.
  - `packages/coding-agent/src/session/streaming-output.ts` — line truncation and final byte truncation.
  - `packages/coding-agent/src/config/settings-schema.ts` — default context lines.
  - `packages/natives/native/index.d.ts` — native `grep()` types exposed to TS.
  - `crates/pi-natives/src/grep.rs` — native regex/file search implementation.
  - `docs/natives-text-search-pipeline.md` — native search pipeline overview.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Regex pattern. `search.ts` trims it and rejects empty input. The native matcher enables multiline only when the pattern text contains a literal newline or the two-character sequence `\\n`. The model prompt explicitly documents literal-brace escaping such as ``interface\\{\\}``, although the native layer also auto-escapes braces that cannot be valid repetition quantifiers. |
| `paths` | `string[]` | Yes | One or more file paths, directory paths, glob-like paths, or internal URLs. Empty strings are rejected after trimming/quote stripping. Internal URLs must resolve to a backing file and cannot contain glob characters. |
| `i` | `boolean` | No | Case-insensitive search. Defaults to `false`. Passed to native `ignoreCase`. |
| `gitignore` | `boolean` | No | Respect `.gitignore` during directory scans. Defaults to `true`. Passed to native `gitignore`. |
| `skip` | `number` | No | Global match offset. Defaults to `0`. `search.ts` floors finite numbers and rejects negative or non-finite values. |
| `timeout` | `number` | No | Search timeout in seconds, `0.5`–`60` (schema-validated). Defaults to `5` (`DEFAULT_SEARCH_TIMEOUT_MS`). On timeout the tool fails with `Search timed out after <n>s; increase timeout or narrow paths/pattern`. |

## Outputs
The tool returns a single text block in `content[0].text` plus structured `details`.

- Match lines are formatted by `formatMatchLine()` as `*<anchor>|<line>` for matches and ` <anchor>|<line>` for context.
  - Hashline mode: `*5th|content`, ` 9x}|content`.
  - Plain mode: `*5|content`, ` 9|content`.
- Directory results are grouped by file, with `# <path>` headings and blank lines between groups.
- `details` may include:
  - `scopePath` — formatted search scope.
  - `matchCount`, `fileCount`, `files`, `fileMatches` — counts for the returned page, not necessarily total corpus counts.
  - `matchLimitReached` — visible-page limit hit (`100`).
  - `resultLimitReached` — native preselection limit hit (`500`).
  - `linesTruncated` — one or more matched lines were shortened to `1024` chars plus `…`.
  - `truncated` and `meta.truncation` — final text output was head-truncated by `truncateHead()`.
  - `displayContent` — TUI-only rendering text with `│` gutters instead of model anchors.
  - `missingPaths` — multi-path entries skipped because their base path did not exist.
- No-match result text is `No matches found`, optionally followed by `Skipped missing paths: ...`.

## Flow
1. `SearchTool.execute()` validates and normalizes input in `packages/coding-agent/src/tools/search.ts`:
   - trims `pattern`, rejects empty patterns;
   - normalizes `skip` to a non-negative integer;
   - reads `search.contextBefore` and `search.contextAfter` from session settings (`1` and `3` by default);
   - enables multiline only when `pattern` contains `\n` or an actual newline.
2. Each `paths` entry is normalized with `normalizePathLikeInput()`.
3. Internal URLs are resolved through `session.internalRouter`:
   - glob metacharacters (`*`, `?`, `[`, `{`) are rejected for internal URLs;
   - URLs without `resource.sourcePath` fail;
   - immutable sources are tracked so output can suppress editable hashline anchors per file.
4. For multi-path calls, `partitionExistingPaths()` skips only ENOENT entries. If every entry is missing, the tool errors.
5. Path resolution branches:
   - one entry: `parseSearchPath()` splits `basePath` and optional glob;
   - multiple entries: `resolveExplicitSearchPaths()` computes a common base directory, brace-union glob, exact-file list, or degenerate-root target list.
6. `search.ts` stats the resolved base path to decide file vs directory behavior.
7. It calls native `grep()` from `@gajae-code/natives` with:
   - `pattern`, `ignoreCase`, `multiline`, `gitignore`;
   - `hidden: true`;
   - `cache: false`;
   - `contextBefore` / `contextAfter` from settings;
   - `maxColumns: 1024`;
   - `mode: content`.
8. Native execution happens in `crates/pi-natives/src/grep.rs`:
   - `build_matcher()` sanitizes non-quantifier braces before regex compile;
   - if compile fails with unopened/unclosed-group errors, it retries after escaping previously unescaped parentheses;
   - directory scans use the grep pipeline described in `docs/natives-text-search-pipeline.md`.
9. Search dispatch differs by resolved path set:
   - exact explicit files or degenerate-root multi-targets: JS loops over targets and merges `grep()` results itself;
   - single file/directory base: one `grep()` call handles offset/limit natively.
10. JS output shaping then:
   - round-robins directory matches down to `100` visible matches so one file does not monopolize the page;
   - keeps the first `100` file matches for single-file searches;
   - formats lines through `formatMatchLine()` for the model and `formatCodeFrameLine()` for TUI;
   - records non-truncated matched/context lines into the session file-read cache with `recordSparse()`.
11. Final text is passed through `truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })`, so the effective cap is the default byte cap from `streaming-output.ts`, not the default line cap.
12. `toolResult()` attaches text plus limit/truncation metadata.

## Modes / Variants
1. **Single file path**
   - `grep()` searches one file.
   - Output is a flat list of match/context lines.
   - Visible limit is the first `100` matches after native offset handling.
2. **Single directory path or single glob-like path**
   - `parseSearchPath()` may split the input into `path` + `glob`.
   - One native `grep()` scans the directory tree with `gitignore` and `hidden:true`.
   - Native `offset` handles `skip` globally across files.
   - JS round-robins the returned matches to `100` visible rows.
3. **Multiple explicit paths/globs**
   - `resolveExplicitSearchPaths()` collapses them into a common base and either a brace-union glob, an explicit file list, or per-target searches when the only common base is the filesystem root.
   - Missing entries are skipped non-fatally unless all are missing.
4. **Internal URL paths**
   - Supported only when the internal resource resolves to a real backing file.
   - No internal-URL globbing.
   - Immutable sources switch to the immutable display mode when formatting anchors.

## Side Effects
- Filesystem
  - Stats resolved search roots and input paths.
  - Reads matched files through native `grep()`.
  - Records sparse matched/context lines into the session file-read cache via `getFileReadCache(...).recordSparse(...)`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Reads session settings for context defaults.
  - Uses `session.internalRouter` to resolve internal URLs.
  - Populates tool `details.meta` with truncation/limit metadata.
- Background work / cancellation
  - Wrapped in `untilAborted(signal, ...)` at the JS level.
  - `search.ts` does not pass `signal` or `timeoutMs` into native `grep()`, so native grep cancellation/timeouts are not used by this tool.

## Limits & Caps
- Visible page limit: `100` matches (`DEFAULT_MATCH_LIMIT` in `packages/coding-agent/src/tools/search.ts`).
- Native preselection limit: `500` matches (`internalLimit = Math.min(DEFAULT_MATCH_LIMIT * 5, 2000)` in `packages/coding-agent/src/tools/search.ts`).
- Line truncation: `1024` characters per emitted line (`DEFAULT_MAX_COLUMN` in `packages/coding-agent/src/session/streaming-output.ts`). Native grep marks truncated lines; JS reports `linesTruncated`.
- Final text truncation: `truncateHead()` default byte cap `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`). `search.ts` overrides `maxLines` to `Number.MAX_SAFE_INTEGER`, so normal search output is byte-capped, not line-capped.
- Context defaults: `search.contextBefore = 1`, `search.contextAfter = 3` in `packages/coding-agent/src/config/settings-schema.ts`.
- Pagination: `skip` is a global match offset. In single-base searches it is pushed into native `offset`; in exact-file/multi-target aggregation it is applied in JS with `matches.slice(skip)`.
- Native directory-scan cache: available in `grep.rs`, but this tool always sets `cache: false`.

## Errors
- `Pattern must not be empty` when trimmed `pattern` is empty.
- `Skip must be a non-negative number` for negative or non-finite `skip`.
- `` `paths` must contain non-empty paths or globs `` when any normalized path is empty.
- `Glob patterns are not supported for internal URLs: ...` for internal URL + glob metacharacters.
- `Cannot search internal URL without a backing file: ...` when the router resolves a virtual resource without `sourcePath`.
- `Path not found: ...` when the resolved base path is missing, or when every multi-path entry is missing.
- Regex compile failures bubble from native `grep()` as tool errors. `search.ts` has a special catch for messages beginning with `regex parse error`, then otherwise rethrows.
- Multi-file native scans skip per-file open/search failures inside `grep.rs`; the scan continues with surviving files.

## Notes
- The model-facing prompt documents standard regex syntax plus two search-specific rules: escape literal braces, and use `\n` or a literal newline for cross-line matching.
- Native `build_matcher()` already auto-escapes braces that cannot be valid quantifiers, so patterns like `${platform}` become searchable instead of failing. Valid quantifiers like `a{2,4}` remain unchanged.
- Native compile retry also escapes unescaped literal parentheses only after an unopened/unclosed-group parse error. It is a fallback, not a general parser mode.
- Internal URLs are resolved before path existence checks. After resolution, the native layer sees ordinary filesystem paths.
- `hidden:true` is hard-coded in `search.ts`; there is no model-facing flag to exclude dotfiles.
- `gitignore:false` only affects native directory traversal. It does not disable the tool's own path normalization or explicit-file handling.
- When `paths` resolves to multiple exact files, `search.ts` does not apply the native `500` match cap and reports `totalMatches` internally as the post-skip length for that branch.
- The anchor suffix in hashline mode comes from `computeLineHash()` in `packages/coding-agent/src/hashline/hash.ts`; `search` itself only formats it.
