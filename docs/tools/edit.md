# edit

> Applies source edits; the default `edit.mode: auto` routes the edit protocol by model family.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/coding-agent/src/edit/modes/replace.ts` — exact/fuzzy text replacement
  - `packages/coding-agent/src/edit/modes/patch.ts` — structured JSON diff-hunk mode
  - `packages/coding-agent/src/edit/modes/apply-patch.ts` — freeform patch-envelope format
  - `packages/coding-agent/src/tools/vim.ts` — persistent modal editing buffer
  - `packages/coding-agent/src/edit/file-read-cache.ts` — per-session read snapshot cache
  - `packages/coding-agent/src/edit/streaming.ts` — computes in-flight diff previews for the TUI

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | Edit instructions in the format specific to the active edit mode. See **Modes / Variants** below for format details. |

## Outputs
- Single-shot tool result; most modes do not use a `resolve` preview/apply handshake.
- `content` contains one text block per call. For a successful single-file edit it is either:
  - A compact diff preview, or
  - `Updated <path>` / `Created <path>` when no preview text is emitted.
- Parse or recovery warnings are appended as needed.
- `details` is `EditToolDetails` from `packages/coding-agent/src/edit/renderer.ts`:
  - `diff`: unified diff string
  - `firstChangedLine`: first changed post-edit line
  - `diagnostics`: LSP/format result if available
  - `op`: `"create"` or `"update"`
  - `meta`: output metadata
  - `perFileResults`: present for multi-file input
- Multi-file input returns one aggregated result with combined text and per-file details.
- While the model is still typing arguments, the TUI can compute a diff preview with `packages/coding-agent/src/edit/streaming.ts`; that preview is not a deferred action and does not block execution.

## Flow
1. `EditTool.execute()` in `packages/coding-agent/src/edit/index.ts` resolves the active mode. The default setting is `auto`, which routes by model family:
   - GPT/Codex → `apply_patch`
   - Claude/DeepSeek/Qwen → `replace`
   - Other models → `replace`
   - Precedence: `GJC_EDIT_VARIANT`/`PI_EDIT_VARIANT` env force, then a matching `edit.modelVariants` rule, then explicit non-`auto` `edit.mode`, then a model-catalog edit recommendation when the session exposes one, then the built-in family mapping, then the `replace` fallback.
2. The appropriate mode engine processes the input according to the mode's schema.
3. The edited text is persisted via `serializeEditFileText()` in `packages/coding-agent/src/edit/read-file.ts`.
4. The writethrough callback from `createLspWritethrough()` may format the file and fetch diagnostics.
5. `invalidateFsScanAfterWrite()` calls `invalidateFsScanCache(path)` so filesystem-backed tools do not serve stale scan results.
6. The session file-read cache is refreshed with the post-edit file text via `recordFull()`.
7. The final response is built from a unified diff and any accumulated warnings.

## Modes / Variants

### apply_patch

Freeform patch-envelope format with optional `*** Begin Patch` / `*** End Patch` markers. Internally expanded into patch-mode entries. Used by GPT/Codex models.

Format:
```
*** Update File: path/to/file.ts
--- path/to/file.ts
+++ path/to/file.ts
@@ -START,COUNT +START,COUNT @@
-old line
+new line
```

### patch

Structured JSON diff-hunk mode. Each hunk specifies old line ranges, new line ranges, and line content. Used as an intermediate format.

### replace

Exact/fuzzy old/new text replacement. The model provides a JSON object for each change specifying the old text to find and the new text to replace it with. Used by Claude, DeepSeek, and Qwen models.

### vim

Persistent modal editing buffer. The model issues vim commands to edit files interactively. Implements a minimal vim subset.

## Errors
- Varies by mode. See the specific mode documentation for detailed error handling.

## Notes
- File-read cache invalidation is conflict-based, not write-through invalidation. If `read` later records content for a line that disagrees with the cached snapshot, the entire snapshot for that path is replaced with the newly observed lines.
- There is no resolve-style apply/discard phase for most edit modes. The primary exception is vim mode, which maintains an interactive buffer.
- BOM and line ending styles are preserved from the original file.
- For multi-file edits, each file is processed independently but failures in one may prevent others from applying depending on the mode.
