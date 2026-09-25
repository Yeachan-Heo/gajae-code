# edit

> Applies source edits; the default `edit.mode: auto` routes the edit protocol by model family, with the hashline patch language (single `input` string) as the fallback mode documented here.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/hashline.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/coding-agent/src/hashline/grammar.lark` — custom-tool grammar for hashline mode
  - `packages/coding-agent/src/hashline/input.ts` — splits `§PATH` sections
  - `packages/coding-agent/src/hashline/parser.ts` — parses op-prefixed edits and verbatim payload lines
  - `packages/coding-agent/src/hashline/apply.ts` — validates anchors and applies edits
  - `packages/coding-agent/src/hashline/anchors.ts` — stale-anchor mismatch formatting
  - `packages/coding-agent/src/hashline/recovery.ts` — cache-based stale-anchor recovery
  - `packages/coding-agent/src/hashline/hash.ts` — computes `LINEhh|` anchors shared with `read`/`search`
  - `packages/coding-agent/src/edit/file-read-cache.ts` — per-session read snapshot cache
  - `packages/coding-agent/src/tools/read.ts` — emits anchored lines and records read snapshots
  - `packages/coding-agent/src/tools/search.ts` — records sparse snapshots from matches/context
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — invalidates FS scan caches after writes
  - `packages/coding-agent/src/edit/streaming.ts` — computes in-flight diff previews for the TUI

## Inputs

### Hashline mode

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more edit sections. First non-blank line must be `§PATH` unless the caller supplies the legacy fallback `path` outside the model schema and the body already looks like hashline ops (`packages/coding-agent/src/hashline/input.ts`). Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- Section header: `§PATH`
- Insert after: `»ANCHOR`
- Insert before: `«ANCHOR`
- Replace/delete range: `≔A..B`
- Single-line replace/delete sugar: `≔A` means `≔A..A`
- `≔A..B` with no payload deletes the range. To keep a blank line, include one explicit empty payload line.
- Payload lines: verbatim file content after `»`, `«`, or `≔`
- Special anchors: `BOF`, `EOF`
- Anchor token: `<line><2-char-hash>`, for example `41th`

Anchors come from `read`/`search` output. `read` formats lines as `LINEhh|TEXT` via `formatHashLine` / `formatHashLines` in `packages/coding-agent/src/hashline/hash.ts`; copy only the token left of `|` into op lines.

Other edit modes exist (`replace`, `patch`, `vim`, `apply_patch`) and are selected outside the tool payload by `resolveEditMode()` in `packages/coding-agent/src/utils/edit-mode.ts`. With the default `edit.mode: auto`, the mode is routed by detected model family (GPT/Codex → `apply_patch`; Claude/DeepSeek/Qwen → `replace`; MiniMax/GLM/Kimi and unknown models → `hashline`). Precedence: `GJC_EDIT_VARIANT`/`PI_EDIT_VARIANT` env force, then a matching `edit.modelVariants` rule, then explicit non-`auto` `edit.mode`, then a model-catalog edit recommendation when the session exposes one, then the built-in family mapping, then the `hashline` fallback. Their schemas are different; this document covers hashline mode.

## Outputs
- Single-shot tool result; hashline mode does not use a `resolve` preview/apply handshake.
- `content` contains one text block per call. For a successful single-file edit it is either:
  - `<path>:` plus a compact diff preview from `packages/coding-agent/src/hashline/diff-preview.ts`, or
  - `Updated <path>` / `Created <path>` when no compact preview text is emitted.
- Parse or recovery warnings are appended as:

```text
Warnings:
...
```

- `details` is `EditToolDetails` from `packages/coding-agent/src/edit/renderer.ts`:
  - `diff`: unified diff string
  - `firstChangedLine`: first changed post-edit line
  - `diagnostics`: LSP/format result if available
  - `op`: `"create"` or `"update"` for hashline mode
  - `meta`: output metadata
  - `perFileResults`: present for multi-section input
- Multi-section input returns one aggregated result with combined text and per-file details.
- While the model is still typing arguments, the TUI can compute a diff preview with `packages/coding-agent/src/edit/streaming.ts`; that preview is not a deferred action and does not block execution.

## Flow
1. `EditTool.execute()` in `packages/coding-agent/src/edit/index.ts` resolves the active mode. The default setting is `auto`, which routes by model family; `hashline` is the unknown-model fallback. `customFormat` exposes the grammar for the selected mode, with hashline's `packages/coding-agent/src/hashline/grammar.lark` placeholders `$HFMT$` / `$HOP_INSERT_BEFORE$` / `$HOP_INSERT_AFTER$` / `$HOP_REPLACE$` / `$HOP_CHARS$` / `$HFILE$` filled from `packages/coding-agent/src/hashline/hash.ts`.
2. `executeHashlineSingle()` in `packages/coding-agent/src/hashline/execute.ts` splits the raw `input` into `§PATH` sections with `splitHashlineInputs()`.
3. If multiple sections target the same path, `mergeSamePathSections()` concatenates them before execution so every op still refers to the original file snapshot.
4. Multi-section calls run a preflight pass (`preflightHashlineSection()`): parse ops, enforce plan-mode write rules, load the current file, reject anchor-scoped edits against missing files, reject auto-generated files, apply edits in memory, and fail if the result is a no-op. This prevents partial batches.
5. `parseHashlineWithWarnings()` in `packages/coding-agent/src/hashline/parser.ts` tokenizes the diff body:
   - ignores blank lines and optional `*** Begin Patch`
   - stops at `*** End Patch`
   - stops at `*** Abort` and emits `ABORT_WARNING`
   - turns `»` / `«` payload runs into one `insert` edit per payload line
   - turns `≔A..B` with payload into inserts before `A`, then deletes for `A..B`
   - turns `≔A..B` with no payload into one `delete` edit per line in the range; a blank-in-place edit requires one explicit empty payload line
6. `applyHashlineEdits()` in `packages/coding-agent/src/hashline/apply.ts` validates every referenced anchor before mutating anything. Each anchor hash is recomputed from current file content with `computeLineHash()`.
7. If any anchor hash differs, `applyHashlineEdits()` throws `HashlineMismatchError`. `execute.ts` catches only that class and calls `tryRecoverHashlineWithCache()`.
8. Recovery replays the edits against each retained snapshot generation for that path, newest first (`packages/coding-agent/src/edit/file-read-cache.ts`), then 3-way merges the result onto current disk content using `Diff.applyPatch(..., { fuzzFactor: 0 })` in `packages/coding-agent/src/hashline/recovery.ts`. Older generations cover a follow-up edit that reuses anchors from the original read after this session's own edit shifted lines. A generation is used only if every anchored line is in it with a matching hash, every replayed hunk's context comes from lines that snapshot actually observed, and each hunk's old side occurs exactly once in the live file. On success the edit proceeds with a warning; on failure the original mismatch error is re-thrown.
9. Before splicing lines, `absorbReplacementBoundaryDuplicates()` normalizes some malformed-but-recoverable ranges:
   - duplicate prefix/suffix lines adjacent to a replacement can be absorbed by widening the delete range
   - pure inserts can auto-drop duplicated leading/trailing payload lines when `edit.hashlineAutoDropPureInsertDuplicates` is enabled
   - all such fixes append warnings
10. `after_anchor` inserts are normalized to `before_anchor` of the next line, or `EOF` if the anchor was the last line.
11. Anchor-targeted edits are bucketed by target line and applied bottom-up so earlier splices do not invalidate later original line numbers. `BOF` and `EOF` inserts are applied after that.
12. The edited text is restored to the original BOM and line ending style with helpers from `packages/coding-agent/src/edit/normalize.ts` and persisted via `serializeEditFileText()` in `packages/coding-agent/src/edit/read-file.ts`.
13. The writethrough callback from `createLspWritethrough()` may format the file and fetch diagnostics. Late diagnostics are queued back into session state as a hidden deferred message by `EditTool.#injectLateDiagnostics()` in `packages/coding-agent/src/edit/index.ts`.
14. `invalidateFsScanAfterWrite()` calls `invalidateFsScanCache(path)` so filesystem-backed tools do not serve stale scan results.
15. The session file-read cache is refreshed with the post-edit file text via `recordFull()`, making the just-written content the newest recovery generation while the pre-edit view is kept behind it.
16. The final response is built from a unified diff (`generateDiffString()`), a compact preview, and any accumulated warnings.

## Modes / Variants
- `hashline` — unknown-model fallback mode; line-anchored patch language described here (`packages/coding-agent/src/utils/edit-mode.ts`).
- `replace` — exact/fuzzy old/new text replacement (`packages/coding-agent/src/edit/modes/replace.ts`).
- `patch` — structured JSON diff-hunk mode (`packages/coding-agent/src/edit/modes/patch.ts`).
- `apply_patch` — freeform patch-envelope `*** Begin Patch` envelope, internally expanded into patch-mode entries (`packages/coding-agent/src/edit/modes/apply-patch.ts`).
- `vim` — persistent modal editing buffer (`packages/coding-agent/src/tools/vim.ts`).

Hashline op examples:

```text
§src/a.ts
»4fb
const added = true;
```

```text
§src/a.ts
«4fb
const addedBefore = true;
```

```text
§src/a.ts
≔4fb..6qx
```

```text
§src/a.ts
≔4fb..5dm
const clean = (name || DEF).trim();
return clean.length === 0 ? DEF : clean.toUpperCase();
```

BOF/EOF examples:

```text
§src/a.ts
»BOF
const HEADER = true;
```

```text
§src/a.ts
»EOF
export const done = true;
```

Delete / blank examples:

```text
§src/a.ts
≔4fb
```

```text
§src/a.ts
≔4fb

»EOF
export const done = true;
```

## Side Effects
- Filesystem
  - Reads target files with `readEditFileText()`.
  - Writes full updated file contents with `serializeEditFileText()`.
  - Preserves BOM and original line-ending style.
- Subprocesses / native bindings
  - `createLspWritethrough()` may trigger formatter / diagnostics work through the LSP subsystem.
  - `invalidateFsScanAfterWrite()` calls native `invalidateFsScanCache()` from `@gajae-code/natives`.
- Session state
  - Reads and updates the per-session `FileReadCache` used for stale-anchor recovery.
  - Stores pending deferred-diagnostics abort controllers per path inside `EditTool`.
  - Queues late diagnostics back into the session transcript as a hidden custom message.
- Background work / cancellation
  - A new edit to the same path aborts the prior deferred diagnostics fetch for that path (`packages/coding-agent/src/edit/index.ts`).
  - The tool itself is marked `nonAbortable = true` and `concurrency = "exclusive"` in `packages/coding-agent/src/edit/index.ts`.

## Limits & Caps
- Default `edit.mode` is `auto` (model-family routing); `hashline` (`DEFAULT_EDIT_MODE`) is the fallback for unknown models, in `packages/coding-agent/src/utils/edit-mode.ts`.
- Anchor hashes are always 2 lowercase letters from a stable 647-entry bigram table (`HL_BIGRAMS_COUNT`) in `packages/coding-agent/src/hashline/hash.ts`.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/coding-agent/src/hashline/constants.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` (`HASHLINE_RECOVERY_FUZZ_FACTOR`) in `packages/coding-agent/src/hashline/recovery.ts`.
- The mismatch report searches 20 lines either side of a stale anchor for where its content moved (`MISMATCH_RELOCATE_WINDOW`).
- The per-session read cache keeps at most 30 paths (`MAX_PATHS_PER_SESSION`) and 4 snapshot generations per path (`MAX_GENERATIONS_PER_PATH`) in `packages/coding-agent/src/edit/file-read-cache.ts`.
- Hashline streaming chunk defaults are 200 lines or 64 KiB per chunk (`packages/coding-agent/src/hashline/types.ts`, consumed by `packages/coding-agent/src/hashline/stream.ts`).
- `HL_OP_INSERT_BEFORE` is `«`, `HL_OP_INSERT_AFTER` is `»`, `HL_OP_REPLACE` is `≔`, `HL_OP_CHARS` is `«»≔`, `HL_FILE_PREFIX` is `§`, and `HL_BODY_SEP` is `|` (`packages/coding-agent/src/hashline/hash.ts`).

## Errors
- Missing section header:
  - `input must begin with "§PATH" on the first non-blank line; got: ... Example: "§src/foo.ts" then edit ops.`
- Empty header:
  - `Input header "§" is empty; provide a file path.`
- Bad anchor token:
  - `line N: expected a full anchor such as "119sr"; got "...".`
- Line number without a hash (`≔16`, `≔23-25`, `≔23..25`):
  - `line N: anchor "16" is missing its hash; ...` followed by `The edit was NOT applied. Current anchors for <path>:` and up to 20 current `LINEhh|TEXT` lines for the referenced span. The edit is never applied on a line number alone.
- Bad range syntax:
  - `line N: explicit ranges are required for replacement...`
  - `line N: range must include exactly two full anchors separated by "..".`
  - `line N: range A..B ends before it starts.`
  - `line N: range A..B uses two different hashes for the same line.`
- Missing payload for `»` / `«`:
  - `line N: » and « operations require at least one verbatim payload line.`
- Stray payload line:
  - `line N: payload line has no preceding », «, or ≔ operation.`
- Unknown op:
  - `line N: unrecognized op. Use «ANCHOR..., »ANCHOR..., ≔A..B...`
- Delete vs blank:
  - `≔A..B` with no payload deletes. To blank in place, include one explicit empty payload line before the next op/header/EOF.
- Missing file for anchor-scoped edits:
  - `File not found: <path>`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale anchors throw `HashlineMismatchError`. The error message contains re-read guidance and reprints nearby current file lines as `LINEhh|TEXT`; mismatched lines are marked `*`. When a stale anchor's hash matches exactly one line within 20 lines, the header adds `Likely moved (marked >; verify the content before reusing): 2ab -> 3ab.` and that line is shown marked `>`; the edit is still not applied. `displayMessage` renders the same information in a code-frame style.
- No-op edit:
  - `Edits to <path> resulted in no changes being made.`
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the original mismatch error is surfaced unchanged.

## Notes
- `read` and `search` are the authoritative source of anchors. The edit parser does not want the trailing `|TEXT`; copy only the `LINEhh` token.
- Multi-op patches are parsed against the original file snapshot. Do not renumber later anchors after earlier ops; `applyHashlineEdits()` buckets and applies them bottom-up.
- `≔A..B` is not a primitive replace in the parser. With payload, it expands to inserts before `A` plus deletes for `A..B`; with no payload, it only deletes `A..B`. To blank in place, include one explicit empty payload line. Stale-anchor checking still happens on the original range lines.
- Interior lines of a multi-line range use hash `**` (`RANGE_INTERIOR_HASH`) and are not individually verified; only the first and last anchor hashes are checked.
- `computeLineHash()` trims trailing whitespace before hashing. Anchors survive line-ending changes and trailing-space-only changes, but not substantive line edits.
- For punctuation-only lines, the hash mixes in the line number; identical `}` lines on different lines intentionally get different anchors.
- `splitHashlineInputs()` normalizes absolute `§PATH` headers back to a cwd-relative path when the file is inside the current working tree. Headers with any run of leading `§` chars (e.g. `§foo.ts`, `§§foo.ts`, `§§§foo.ts`) are accepted; the canonical form is `§PATH`.
- Optional `*** Begin Patch` / `*** End Patch` markers are accepted in hashline mode, but the file sections are still `§PATH`-based, not OpenAI code `*** Update File:` hunks.
- `*** Abort` terminates parsing early and returns `ABORT_WARNING`; ops parsed before the marker still apply.
- File-read cache invalidation is conflict-based, not write-through invalidation. If `read` later records content for a line that disagrees with the cached snapshot, the entire snapshot for that path is replaced with the newly observed lines (`packages/coding-agent/src/edit/file-read-cache.ts`).
- There is no resolve-style apply/discard phase for hashline edits. The only preview path is the transient TUI diff preview in `packages/coding-agent/src/edit/streaming.ts`.
