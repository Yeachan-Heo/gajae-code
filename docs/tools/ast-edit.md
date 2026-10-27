# ast_edit

> Preview and apply structural rewrites over source files via native ast-grep.

## Source
- Entry: `packages/coding-agent/src/tools/ast-edit.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ast-edit.md`
- Key collaborators:
  - `crates/pi-natives/src/ast.rs` — native rewrite planning and file mutation
  - `crates/pi-ast/src/language/mod.rs` — language aliases and extension inference
  - `packages/coding-agent/src/tools/path-utils.ts` — path/glob parsing and multi-path resolution
  - `packages/coding-agent/src/tools/resolve.ts` — preview/apply queueing
  - `packages/coding-agent/src/tools/render-utils.ts` — parse-error dedupe and display caps
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline vs line-number diff references
  - `packages/coding-agent/src/hashline/hash.ts` — stable hashline diff anchors
  - `packages/natives/native/index.d.ts` — JS-visible native binding contract

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ops` | `{ pat: string; out: string }[]` | Yes | One or more rewrite rules. `pat` must be non-empty. Duplicate `pat` values fail before native execution. Empty `out` deletes the matched node. |
| `paths` | `string[]` | Yes | One or more files, directories, globs, or internal URLs with backing files. Empty entries are rejected. Globs are forbidden for internal URLs. |

Shared AST pattern grammar and language catalog: see [`ast_grep`](./ast-grep.md#inputs).

- `ast_edit` uses the same `$NAME`, `$_`, `$$$NAME`, and `$$$` metavariable semantics.
- The tool prompt adds rewrite-specific constraints:
  - metavariable names must be uppercase and must stand for whole AST nodes,
  - captures from `pat` are substituted into `out`,
  - each rewrite is a 1:1 structural substitution; one capture cannot expand into multiple sibling nodes unless the grammar itself permits that expansion at that position.

## Outputs
- Single-shot preview result from `ast_edit` itself.
- Model-facing `content` is one text block showing proposed edits, grouped by file for directory/multi-file runs.
  - Each change renders as two lines: `-REF|before` and `+REF|after` in hashline mode, or `-LINE:COLUMN before` / `+LINE:COLUMN after` when hashlines are off.
  - Only the first line of each `before`/`after` snippet is shown, truncated to 120 characters in the wrapper.
  - `Limit reached; narrow paths.` and formatted parse issues are appended when applicable.
- If no rewrites match, text is `No replacements made` plus formatted parse issues when present.
- `details` includes aggregate preview metadata:
  - `totalReplacements`, `filesTouched`, `filesSearched`, `applied`, `limitReached`
  - optional `parseErrors`, `scopePath`, `files`, `fileReplacements`, `displayContent`, `meta`
- The tool always previews first (`applied: false` in the direct result). Actual file writes happen only later through `resolve(action: "apply", ...)`.
- When preview produced replacements, `ast_edit` also queues a pending `resolve` action. Successful apply returns a separate `resolve` result, not another `ast_edit` result.

## Flow
1. `AstEditTool.execute()` validates each op in `packages/coding-agent/src/tools/ast-edit.ts`:
   - empty `pat` fails,
   - at least one op is required,
   - duplicate `pat` values fail,
   - ops are converted to a `Record<pattern, replacement>`.
2. The wrapper reads `GJC_MAX_AST_FILES` via `$envpos(..., 1000)` and uses that as the native `maxFiles` cap for both preview and apply.
3. Path normalization, internal URL handling, missing-path partitioning, and multi-path resolution follow the same `path-utils.ts` flow as `ast_grep`.
4. The wrapper stats the resolved base path to decide whether to render grouped directory output.
5. `runAstEditOnce(...)` always runs native `astEdit(...)` with `dryRun: true` and `failOnParseError: false` on the first pass.
6. Native `ast_edit` in `crates/pi-natives/src/ast.rs`:
   - normalizes the rewrite map and sorts rules by pattern string,
   - resolves strictness (`smart` by default),
   - collects candidate files from a file or gitignore-aware directory scan,
   - infers a single language for the whole call unless `lang` was supplied,
   - compiles every rewrite pattern for that language,
   - parses each file, skips files with syntax-error trees, collects `replace_by(...)` edits for every match, enforces replacement and file caps, and returns textual before/after slices plus source ranges.
7. The TS wrapper deduplicates parse errors, groups changes by file, and renders preview diff lines.
8. If preview found replacements and `applied` is false, `queueResolveHandler(...)` registers a forced `resolve` action and injects a `resolve-reminder` steering message.
9. On `resolve(action: "apply")`, the queued callback reruns the same rewrite set with `dryRun: false`, recomputes counts, and rejects the apply as an error if the live result no longer matches the preview (`stalePreview`).
10. On a non-stale apply, the callback returns `Applied N replacements in M files.`; on discard, `resolve` returns a discard message without mutating files.

## Modes / Variants
- Single file: preview or apply against one file.
- Directory + optional glob: native scan walks the directory, then filters by compiled glob.
- Multiple explicit paths/globs: wrapper unions them into one synthetic scope or runs per-target native calls when paths only meet at root.
- Internal URL inputs: only supported when the router resolves them to a backing file path.
- Preview mode: always the direct `ast_edit` tool result.
- Apply mode: only reachable through the queued `resolve` callback after a preview.
- Hashline output mode vs plain line/column mode: controlled by `resolveFileDisplayMode()`.

## Side Effects
- Filesystem
  - Preview reads files and scans directories.
  - Apply rewrites files in place with `std::fs::write(...)`, but only when the computed output differs from the original source.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Queues a one-shot forced `resolve` tool choice through `queueResolveHandler(...)`.
  - Adds a `resolve-reminder` steering message.
- User-visible prompts / interactive UI
  - Direct `ast_edit` results are previews.
  - Follow-up apply/discard is exposed through the hidden `resolve` tool.
- Background work / cancellation
  - Native preview/apply work runs on a blocking worker via `task::blocking(...)`.
  - Cancellation and optional native timeout are cooperative through `CancelToken::heartbeat()`.

## Limits & Caps
- File cap exposed by the wrapper: `GJC_MAX_AST_FILES`, default `1000`, in `packages/coding-agent/src/tools/ast-edit.ts`.
- Native `maxFiles` and `maxReplacements` are both clamped to at least `1` when provided in `crates/pi-natives/src/ast.rs`.
- The wrapper never sets `maxReplacements`; native behavior therefore defaults to effectively unbounded replacements for a run.
- Parse issues are rendered with at most `PARSE_ERRORS_LIMIT = 20` lines in `packages/coding-agent/src/tools/render-utils.ts`; `details.parseErrors` is deduplicated but not capped.
- Directory scans use `include_hidden: true`, `use_gitignore: true`, and skip `node_modules` unless the glob text explicitly mentions `node_modules` in `crates/pi-natives/src/ast.rs`.
- No separate glob-expansion count cap exists. Candidate count is whatever the resolved path/glob expands to after gitignore filtering, then native `maxFiles` stops mutations after the configured number of touched files.
- Preview text truncates each rendered `before` and `after` first line to 120 characters in `packages/coding-agent/src/tools/ast-edit.ts`.

## Errors
- TS wrapper throws `ToolError` for empty patterns, duplicate rewrite patterns, empty path entries, unsupported internal-URL globs, internal URLs without `sourcePath`, and missing paths.
- Native code returns hard errors for:
  - inability to infer one language across all candidates when `lang` is absent,
  - unsupported explicit `lang`,
  - bad glob compilation or unreadable search roots,
  - overlapping computed edits (`Overlapping replacements detected; refine pattern to avoid ambiguous edits`),
  - out-of-bounds edit ranges or non-UTF-8 replacement text,
  - write failures during apply,
  - cancellation or timeout.
- With `failOnParseError: false` (the wrapper always uses this), pattern compile failures and file parse failures become `parseErrors` instead of aborting the whole run.
- If every rewrite pattern fails to compile, native `ast_edit` returns a successful zero-replacement result with `parseErrors` populated.
- Files containing tree-sitter error nodes are skipped for rewriting; they do not get partial edits.
- Apply can fail after a successful preview if the preview becomes stale. The resolve callback compares replacement totals and per-file counts and returns an error result rather than applying a mismatched preview silently.

## Notes
- `ast_edit` does not expose the native `lang`, `strictness`, `selector`, `maxReplacements`, `failOnParseError`, or `timeoutMs` fields to the model. The runtime fixes the call shape to a preview-first, smart-strictness, best-effort parse mode.
- Because the wrapper does not expose `lang`, mixed-language rewrites only succeed when every candidate infers to the same canonical language. This is stricter than `ast_grep`.
- Idempotency is not enforced syntactically. A rewrite like `foo($A) -> foo($A)` previews zero changes because output equals input; a rewrite that keeps matching its own output may still produce replacements on repeated calls.
- Rewrites are accumulated per file, then applied from the end of the file backward after an overlap check. Independent matches can coexist; overlapping matches abort the run.
- Native rewrite rule order is by pattern-string sort, not by the original `ops` array order, because `normalize_rewrite_map(...)` sorts the `(pattern, rewrite)` pairs.
- Preview/apply parity is validated only by totals and per-file counts, not by a byte-for-byte diff of every replacement payload.