# Coding-agent terminal UI design system

This document is the first-party visual and interaction contract for the coding-agent terminal UI. It records the repository-required UI workflow branch for issue #3056:

> **Extract existing system first** — the interactive TUI already exists, but its visual grammar was implicit. This document extracts that grammar before the transcript viewport and persistent composer are extended.

The guidance describes intended contracts. Implementation and visual-QA evidence must be verified independently; this document is not evidence that a state or test already passes.

## Scope and principles

The primary surface is the interactive transcript, status/widgets, and composer. Selectors, overlays, hook-provided editors, and autocomplete participate in the same terminal budget.

1. Preserve the transcript as the dominant reading surface.
2. Keep the composer visible and focused while the user browses earlier transcript rows.
3. Spend rows deterministically: fixed/status content first, bounded composer second, autocomplete only from remaining optional space, transcript last with at least a useful reading window when the terminal permits.
4. Preserve ANSI styles, grapheme boundaries, terminal cursor semantics, IME anchoring, and CJK display width throughout measurement, slicing, wrapping, and capture.
5. Prefer semantic theme roles and existing box/symbol presets over literal colors or new ornament.
6. Degrade by removing optional information, not by hiding the cursor-bearing editor row or corrupting content.

## Tokens

### Color roles

Use the existing theme API; do not introduce sticky-composer-only literal colors.

| Role | Use |
| --- | --- |
| `text`, `muted`, `dim` | Transcript body, secondary metadata, placeholders, inline hints, and low-priority instructions. |
| `accent`, `borderAccent`, `borderMuted`, `border` | Prompt prefix, focus/session accent, selected autocomplete item, composer chrome, separators, and neutral frames. |
| `success`, `warning`, `error` | Completed, caution/paused, and error states. Color must supplement readable text or symbols rather than carry meaning alone. |
| `userMessageBg`, `userMessageText` | Submitted user-message surface. |
| `customMessageBg`, `customMessageText`, `customMessageLabel` | Extension/custom-message surfaces. |
| `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput` | Tool execution states. |
| `statusLineBg`, `statusLineSep`, `statusLineModel`, `statusLinePath`, and other `statusLine*` roles | Status rail and its semantic segments. |
| `selectedBg` | Selection surfaces when foreground accent alone is insufficient. |

Every bundled and custom theme must retain readable contrast for focused/unfocused borders, selected/unselected autocomplete rows, warning/error text, and cursor/placeholder combinations. ANSI-disabled or low-color terminals must remain understandable from copy, spacing, and symbols.

### Typography, symbols, and density

- The terminal's monospace cell grid is the typography system; no layout may assume a particular font beyond correct terminal cell width.
- Use the existing Unicode, Nerd Font, or ASCII symbol preset. Composer anatomy must remain valid in ASCII mode.
- The default composer is a rounded, closed border box with one column of horizontal padding, a themed `> ` input prefix, and `Type your message...` placeholder.
- Use sharp borders for data-heavy or diagnostic frames; rounded borders identify the primary conversational input surface.
- Keep transcript rhythm compact: blank rows separate semantic blocks, not every wrapped line.
- There is no shadow or simulated elevation. Layering is expressed through border shape, semantic background roles, and z-order.

### Spacing and limits

- The composer height is measured in rendered terminal rows, including border rows and wrapped input.
- The composer must never exceed **18 rows**.
- Normal layouts reserve sufficient room for transcript, status, widgets, and composer chrome. On constrained terminals, optional autocomplete rows are removed before the cursor-bearing editor content row.
- A bounded editor scrolls internally when wrapped input exceeds its visible content height. Moving the cursor must reveal the cursor row without expanding the composer.
- Short transcripts are blank-padded above the lower region so the status/composer stack remains bottom-aligned.

## Layout grammar

The selected product composition is a vertical split:

1. **Transcript viewport** — the flexible upper region. It follows the live tail by default and becomes independently scrollable when the user browses history.
2. **Transient/status region** — pending work, loaders, todo/Btw content, status rail, and hook widgets, measured as real rendered rows.
3. **Persistent composer** — the bounded editor at the bottom. It retains focus while transcript history is browsed.
4. **Overlays** — selectors, dialogs, and extension surfaces rendered above the base composition; they own input while visible.

The allocator must use rendered row counts at the current terminal width. Source line counts are not layout measurements because Markdown, ANSI text, CJK, wide glyphs, and editor content reflow.

The transcript viewport owns a stable row window rather than depending on terminal scrollback. New streamed rows follow the tail only while follow mode is active. Browsing upward pauses follow mode without pausing the agent.

## Component anatomy

### Transcript viewport

- **Source:** rendered conversation rows at the current width.
- **Window:** offset, height, total row count, and optional overscan.
- **Follow state:** live-tail following versus paused-history browsing.
- **Unseen indicator:** count or concise notice for rows appended after the last seen tail while browsing.
- **Return affordance:** `Alt+End` returns to and resumes the live tail.
- **Paging affordances:** `Alt+PageUp` and `Alt+PageDown` page the transcript without changing composer focus.

Do not use the transcript viewport for modal selectors, editor input, or arbitrary extension takeovers. Those surfaces have their own focus and lifecycle contracts.

### Persistent composer

- **Frame:** rounded closed border using `borderMuted` by default and the existing session/focus accent where configured.
- **Prefix:** semantic mode marker (`>`, shell, shell no-context, or Python mode) inside the input content area.
- **Content:** Unicode-normalized editor lines wrapped by terminal display width.
- **Cursor:** software cursor or zero-width hardware-cursor marker, with placeholder and IME anchoring preserved.
- **Hint:** dim inline ghost text when it fits.
- **Autocomplete:** selected list appended to the composer and constrained by a runtime row budget.
- **Internal viewport:** visible wrapped-line slice that follows the editor cursor after the 18-row cap is reached.
- **Status relationship:** the status rail is adjacent to the composer but remains a separately measured component.

Do not create a second editor implementation for the sticky layout. Custom/hook editors must satisfy the shared editor component contract or explicitly replace the composer surface through the established extension UI lifecycle.

### Autocomplete

- The selected row uses the existing accent and navigation cursor symbol; descriptions and scroll position use muted text.
- Descriptions collapse before the primary value becomes unreadable on narrow widths.
- The row budget includes any scroll-position row.
- A one-row budget must still show the selected option and omit the scroll-position row.
- Autocomplete is optional under height pressure and must never displace the only cursor-bearing editor row.

### Unseen-history affordance

The indicator is informational, not modal. It must state that new transcript content exists and provide the return-to-tail key. It must not steal focus, cover the composer, or reset the user's viewport offset as streaming continues.

## States

| State | Contract |
| --- | --- |
| Default | Transcript follows the tail; composer is visible, rounded, bottom-aligned, and ready for input. |
| Focus | Composer emits a valid cursor marker or visible software cursor. Focus is distinguishable without relying only on color. |
| Streaming | New assistant/tool rows extend the transcript. At tail, the viewport follows; composer remains usable for steering/queueing according to existing session rules. |
| Paused history | `Alt+PageUp` or equivalent browsing disables tail-follow without moving focus out of the composer. Existing transcript rows remain stable as new rows arrive. |
| Unseen content | While history is paused, appended rows increase the unseen count. Returning to the tail clears the count and resumes following. |
| Autocomplete | The dropdown owns selection/navigation/confirm/cancel keys before transcript browsing or editor history. It is height-budgeted and does not obscure the cursor. |
| Overlay | The topmost visible overlay owns keyboard input. The base transcript/composer layout remains mounted and resumes unchanged when the overlay closes. |
| Error | Errors use semantic error styling plus readable copy. Rendering failures must remain bounded to their component/fallback and must not erase composer access. |
| Tiny terminal | Optional autocomplete and secondary status/widget detail collapse first. Preserve one cursor-bearing editor content row whenever any interactive layout is possible; clamp all arithmetic and avoid negative widths/heights. |
| Custom editor | A replacement editor receives the same computed maximum height, theme, history/autocomplete configuration where supported, focus, and resize updates. Unsupported optional capabilities degrade explicitly rather than breaking layout. |

## Responsive behavior

Widths are capability bands, not device classes. Harness fixtures use exact dimensions so changes remain comparable.

| Band | Representative fixture | Behavior |
| --- | --- | --- |
| Tiny | `40x10` | Emergency degradation: omit optional autocomplete/status detail, keep the composer cursor reachable, and give remaining non-negative rows to transcript. |
| Narrow | `48x16` | Single-column composition; autocomplete descriptions collapse; long labels truncate by visible width; transcript and editor wrap aggressively. |
| Medium | `80x24` | Reference layout; bounded composer, status rail, several autocomplete rows, and useful transcript window coexist. |
| Wide | `140x40` | Same vertical grammar, not a side-by-side redesign. More content fits per row and the transcript gains height; composer still caps at 18 rows. |

Resize rules:

- Re-measure transcript, status/widgets, editor, and autocomplete at the new width and height.
- Preserve the editor text and logical cursor position; then reveal its new wrapped cursor row.
- Preserve paused-history intent. Anchor the same logical reading region as closely as reflow permits; do not silently jump to the live tail.
- At the live tail, remain at the live tail after reflow.
- Never reuse stale row counts across widths.

## CJK, ANSI, and cursor requirements

- Wrap and truncate by display cells and grapheme clusters, never UTF-16 indices or byte length.
- NFC-normalize inserted and loaded editor text consistently with the existing editor boundary.
- Korean, Japanese, Chinese, and mixed CJK/Latin fixtures are mandatory. Semantic line-break defects are blocking: punctuation must not become misleadingly detached, wide glyphs must not be split, and continuation rows must align with composer chrome.
- ANSI SGR and OSC 8 sequences are zero-width for measurement and must remain balanced at viewport slice boundaries. Styles and hyperlinks must not bleed between rows.
- Transcript virtualization/windowing must not cut through a terminal control sequence or return rows with stale style state.
- A focused editor must emit the existing zero-width cursor marker at the visual cursor cell. The TUI strips it and positions the hardware cursor for IME candidate windows.
- Placeholder rendering must retain a valid hardware cursor anchor during IME composition.
- Software cursor fallback must remain visible at the right edge, including on wide graphemes and zero-spare-column layouts.

## Keyboard and mouse precedence

Keyboard dispatch order is contractual:

1. Topmost visible modal overlay or selector.
2. Open autocomplete list.
3. High-priority interrupt/transient UI handlers.
4. Explicit transcript controls: `Alt+PageUp`, `Alt+PageDown`, and `Alt+End`.
5. Composer/application shortcuts and editor text/navigation/history behavior.

Transcript browsing never transfers focus from the composer. Plain Up/Down and PageUp/PageDown retain their existing editor/autocomplete meanings; transcript paging uses the Alt-modified bindings to avoid collisions.

This change does not require SGR mouse capture. Preserve native terminal selection and scrollback rather than hijacking the wheel. If routed mouse scrolling is added later, precedence must be topmost overlay, autocomplete under pointer, internally scrollable composer under pointer, transcript viewport, then native terminal behavior; the helper must prove it does not regress terminal selection or scrollback.

## Motion and depth

- Streaming appends and viewport paging are immediate terminal updates; do not add animated scrolling.
- Existing loader/shimmer motion may continue, but paused-history content must not move merely because a spinner advances.
- Respect low-capability and reduced-motion environments by relying on stable text/status symbols rather than animation for meaning.
- Overlay z-order, not shadows, communicates depth.

## State harness and evidence matrix

A deterministic TUI state harness must expose the following matrix before the UI work is considered complete. Each cell requires a fresh full-surface capture where applicable; a single representative screenshot is insufficient.

| Scenario | Tiny `40x10` | Narrow `48x16` | Medium `80x24` | Wide `140x40` |
| --- | ---: | ---: | ---: | ---: |
| Default empty composer + placeholder/focus | Required | Required | Required | Required |
| Long Latin transcript at live tail | Required | Required | Required | Required |
| Streaming at live tail | Required | Required | Required | Required |
| Paused history while streaming | Required | Required | Required | Required |
| Unseen rows + return-to-tail affordance | Required | Required | Required | Required |
| Multiline editor below cap | Required | Required | Required | Required |
| Editor exceeding 18 rows/internal scroll at top, middle, bottom | Required | Required | Required | Required |
| Autocomplete selected/scrolling/no-match | Required | Required | Required | Required |
| Autocomplete under row pressure | Required | Required | Required | Required |
| Overlay over paused and live-tail bases | Required | Required | Required | Required |
| Error/fallback rendering | Required | Required | Required | Required |
| Custom editor replacement and restore | Required | Required | Required | Required |
| CJK transcript + mixed CJK/Latin composer wrapping | Required | Required | Required | Required |
| Hardware cursor/IME anchor and software cursor fallback | Required | Required | Required | Required |
| Resize live-tail and paused-history states | Required | Required | Required | Required |

For scrollable surfaces, evidence must include top, middle, bottom/tail, sticky composer, overflow, and unseen-content boundaries. Terminal evidence must provide:

- `terminal.txt` readable plain text;
- `terminal-ansi.txt` preserving SGR, OSC, and cursor/control semantics needed for review;
- `terminal.html` rendering the styled output;
- optional `terminal.png`;
- `metadata.json` with replay source, terminal dimensions, font/rendering assumptions, timestamp, tool version, wrapping policy, and live-PTY/replay/fixture provenance.

An independent reviewer must compare the complete evidence set against this document and the harness. Flattened text alone is insufficient for cursor, focus, color, wrapping, overlay, or ANSI-sensitive states.

## Provenance boundary

This is first-party guidance extracted from Gajae-Code's existing implementation and repository conventions. Do not vendor third-party design corpora, screenshots, prompt packs, or brand guides as source material for this system without the materializer and provenance design required by `docs/ui-design-visual-qa.md`.
