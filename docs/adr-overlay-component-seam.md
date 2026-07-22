# ADR: Overlay rich-rendering component seam

## Decision

The transcript overlay gains narrowed rich tool rendering through **pure, width-taking line renderers**, invoked at `TranscriptViewerOverlay.#rebuild`'s `contentWidth`. It does not mount a `Component` inside `#rebuild`.

The implementation seam is a coding-agent-only rendered-lines hook whose tool implementation is:

```ts
renderToolDisplayLines(descriptor, contentWidth, theme): string[]
```

That function is the single owner of section identity, output validation, wrapping, result capping, and the truncation sentinel. `TranscriptViewerOverlay.#rebuild` consumes its returned `string[]` as final trusted display lines: it must not split, validate, wrap, Markdown-render, or cap those lines again.

This is deliberately narrowed fidelity, not byte-for-byte parity with the inline tool UI. The inline `ToolExecutionComponent` remains unchanged.

## Drivers

1. **Terminal safety.** `TranscriptViewerOverlay.#rebuild` currently routes the chosen text source through `sanitizeText` before rendering it as Markdown or raw wrapped text (`packages/coding-agent/src/modes/components/transcript-viewer-overlay.ts`). That boundary prevents terminal control sequences but also removes renderer styling. Rich output needs a replacement boundary that is auditable and no broader than SGR.
2. **Useful width-aware rendering.** The overlay already calculates `contentWidth` in `#rebuild`. Reusing pure helpers at that width preserves useful diff, JSON-tree, status, and theme styling without constructing a live TUI component.
3. **Bounded work without stale cache state.** The overlay rebuilds display lines repeatedly. Input budgets, selected-and-expanded rich rendering, and visible result caps bound the work without an LRU or theme/render revision invalidation scheme.

## Existing seam and canonical projection

The current overlay string pipeline selects `payload.text` in raw mode, otherwise `getEntryText?.(entry, expanded)`, then `entry.getDisplayText?.(expanded)`, then `payload.text`; it trims and calls `sanitizeText`, and finally uses `wrapTextWithAnsi` for raw text or `Markdown` for expanded text. The relevant code is `TranscriptViewerOverlay.#rebuild` in `packages/coding-agent/src/modes/components/transcript-viewer-overlay.ts`.

This ADR builds on the WS5 canonical-versus-descriptor split:

- `buildToolTranscriptEntry` in `packages/coding-agent/src/modes/components/tool-transcript-format.ts` keeps `canonicalPayload` as the entry `payload`, including the byte-preserving source used by copy and raw mode.
- `createToolTranscriptRenderDescriptor` sanitizes and recursively freezes display-only fields before they are formatted. Its optional string `details` remains available for legacy text; its structured `detailsData` projection carries result details/diffs, including `perFileResults`, through the same sanitizer/freeze recursion. Both adapters supply it from the real tool result, and it is subject to the rich input budgets.
- Rich rendering reads only that sanitized descriptor. It does not mutate canonical payload bytes.

Overlay chrome continues to use `theme.fg` (as it does for the selected marker and muted entry label), and rich helper SGR is produced against the current supplied theme.

## `renderToolDisplayLines` pipeline contract

`renderToolDisplayLines` first composes a local typed internal shape:

```ts
type ToolDisplaySections = {
  callLines: string[];
  statusLines: string[];
  resultLines: string[];
};
```

The order below is normative and is owned entirely by that function:

1. Apply the input budget gate.
2. Build `ToolDisplaySections` from the sanitized descriptor.
3. Validate every line with the SGR-only display validator.
4. ANSI-aware wrap every section at `contentWidth`.
5. Cap **only wrapped `resultLines`** at 100 lines.
6. When capped, append `... N more lines`, where `N` is the number of hidden post-wrap result lines.
7. Flatten `callLines`, `statusLines`, and capped `resultLines` (plus sentinel) last, returning final `string[]`.

Call and status lines are never charged against the 100-line result cap. The cap is post-wrap, so its count reflects what the overlay can display. The overlay may use the final lines for its collapsed presentation, but it must not re-split them or repeat any validation, wrapping, cap, or sentinel accounting.

The pure helper repertoire is intentionally limited:

- `renderDiff` is the diff primitive imported by `packages/coding-agent/src/modes/components/tool-execution.ts`.
- `renderJsonTreeLines` is the JSON tree primitive used there for structured arguments and results.
- `renderStatusLine` is used there to produce tool status output.

`renderDiff(diffText, options?: { filePath? }): string` is the diff primitive; it does **not** accept a width. `renderJsonTreeLines` likewise produces rich SGR text without owning final display width. `renderToolDisplayLines` is the width-taking owner: it invokes those helpers, validates their output, and ANSI-aware wraps every section at `contentWidth`. `renderStatusLine` produces status output; other tools fall back to plain sanitized text. `toolRenderers.renderCall` and `toolRenderers.renderResult` are not part of this seam: they return components, and `ToolExecutionComponent` is stateful (`Container`, live TUI, animation, image, and asynchronous edit-preview concerns). Neither is pure line projection.

## Security contract

Rich display has two boundaries in this order:

1. **Sanitize inputs before formatting.** Every untrusted descriptor value—arguments, result content, string details, structured `detailsData`, paths, errors, and display text—is cleaned with `sanitizeText` before interpolation into helpers. `createToolTranscriptRenderDescriptor` is the canonical display descriptor producer.
2. **Validate outputs before terminal display.** Split rich output on newlines before validating each line. Normalize tabs to spaces, then reject or remove every remaining C0 or C1 control byte. The sole permitted control sequence is SGR, `ESC [ <params> m`, with one-to-three-digit decimal parameters in the 0–255 range, separated by single semicolons and subject to a bounded total sequence length; this refines the prior numeric/semicolon grammar.

The validator rejects or removes all other control data, including all OSC (explicitly including OSC 8 hyperlinks), DCS, APC, PM, SOS, Kitty and Sixel/image sequences, every non-SGR CSI action such as cursor movement or erase, and every C0/C1 byte after tab normalization. The allowlist is intentionally stricter than a URI validator: hyperlink fidelity is not a v1 capability.

Raw mode is different by design. It reads canonical `payload.text`, applies `sanitizeText`, then wraps ANSI-free canonical text at `contentWidth`. It bypasses the rich hook, validator, and Markdown. Copy remains exempt: `TranscriptViewerOverlay.#copy` copies `entry.payload.text` unchanged.

The rich input work limits are:

| Limit | Value |
| --- | ---: |
| Source bytes | 1 MiB (1,048,576) |
| Source lines | 50,000 |
| Scalar length | 8,192 |
| JSON depth | 32 |
| JSON nodes | 20,000 |

On an exceeded budget, truncate before any rich helper runs, set `inputTruncated`, and prepend `... input truncated for rendering (press r for raw)`.

## Alternatives rejected

### Mount `ToolExecutionComponent` in `TranscriptViewerOverlay.#rebuild` (D2)

Rejected because it couples the transcript projection to a stateful `Container` with live TUI requests, spinner animation, image handling, and asynchronous diff preview. It also cannot expose the typed call/status/result boundaries required for a result-only cap. Revisit only when inline-to-overlay drift is a reported defect **and** renderer factories expose width-aware annotated sections.

### LRU render cache (D4)

Rejected because a cache key must faithfully include every descriptor input and all theme state; partial fingerprints yield stale rich output. Recompute is bounded by the input budgets, selected-and-expanded rendering, and visible caps. Revisit only when a performance lane proves bounded recompute exceeds the 16 ms overlay frame budget; any replacement key must canonically fingerprint name, arguments, result, details, error/partial state, and theme through a single revision-bumping theme setter.

### Lazy viewport / virtualization (D3)

Rejected because this overlay does not yet have stable `scrollTop`/`viewportRows` geometry or a specified virtual-line architecture. Non-tool expanded bodies retain their separate bounded post-Markdown contract instead. Revisit only when stable geometry exists and full reachability of entries beyond the cap is a hard requirement.

### Validated OSC 8 hyperlinks

Rejected: the output allowlist is SGR only. Revisit only after a renderer needs hyperlink fidelity and fixtures prove all of: the OSC 8 grammar, an `https`/`http`/`mailto` URI allowlist, `{id}`-only parameters, mandatory paired close, and overlay-generated—not untrusted—link bytes.

## Consequences

- The overlay can show theme-aware diffs, JSON trees, and status lines at its actual content width while preserving the terminal trust boundary.
- Rich rendering has no claim of parity with `ToolExecutionComponent`; custom component renderers and unsupported tools use the sanitized plain-text path.
- Section ownership makes the result-only cap mechanically enforceable and prevents call/status output from being accidentally hidden.
- The seam is synchronous, pure, read-only, and excludes animation, images, Kitty/Sixel, async work, and live TUI access.
- Canonical transcript and clipboard bytes remain unchanged; only display projection is sanitized and validated.
- Rich rendering is recomputed rather than cached, so the selected expanded entry is the only rich work candidate per rebuild.

## Follow-ups and revisit criteria

- **D1 — ANSI-free raw:** retain `sanitizeText` then wrap raw display. Revisit only for a demonstrated colored-raw user need with a specified and fixtured SGR-preserving raw normalizer.
- **D2 — narrowed pure-helper fidelity:** retain the pure width-taking line renderer boundary. Revisit only for a reported inline/overlay drift defect plus width-aware annotated renderer sections.
- **D3 — no lazy viewport:** retain bounded non-tool rendering. Revisit only with stable viewport geometry and a hard full-reachability requirement.
- **D4 — no cache:** retain bounded recompute. Revisit only when measured performance exceeds the 16 ms frame budget and a complete canonical invalidation key exists.
- WS5 read-group entries remain on the existing string path until their independent projection work is approved.
- A cache is a gated WS5c follow-up, not a prerequisite for this seam.

Architect approval of this ADR is required before the rendered-lines seam or pure-helper rich rendering implementation merges.
