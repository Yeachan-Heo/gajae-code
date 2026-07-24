# Sticky Composer Architecture Decision Record

- **Status:** Accepted design contract
- **Issue:** #3056
- **Decision branch:** **Extract existing system first**
- **Design source:** [`packages/coding-agent/DESIGN.md`](../packages/coding-agent/DESIGN.md)

This ADR records the intended architecture. It does not claim that implementation, tests, or visual-QA evidence are already complete.

## Context

The interactive coding-agent TUI historically renders conversation, transient status, widgets, status rail, and editor in one vertical component stream. Long transcripts rely heavily on terminal scrollback, and a growing multiline editor can consume an unbounded share of the visible terminal. Browsing older output can therefore move the active prompt out of view or compete with input, autocomplete, overlays, streaming updates, CJK reflow, and hardware-cursor placement.

The product requirement is to keep prompt composition available while users browse earlier transcript rows, without replacing the existing component/theme/editor systems or breaking terminal semantics.

## Decision

Adopt a **split transcript viewport above a persistent composer**.

The upper region is a bounded transcript viewport. The lower region contains measured transient/status content and the composer, with the composer remaining mounted, visible, and focused during transcript browsing. The transcript follows the live tail by default. Explicit browsing pauses follow mode; streaming may continue and accumulate an unseen-row count without forcing a jump. `Alt+PageUp` and `Alt+PageDown` page transcript history, and `Alt+End` returns to the live tail.

The composer is capped at **18 border-inclusive terminal rows**. When input wraps beyond the visible editor content area, the editor scrolls internally and keeps the cursor row visible. Terminal-height degradation removes optional autocomplete rows and secondary detail before sacrificing the cursor-bearing editor row. Short transcript content is padded above the lower region so the composer remains bottom-aligned.

Visible overlays and autocomplete retain input precedence over transcript controls. Transcript browsing does not transfer focus away from the composer. The initial change does not capture the mouse wheel; native terminal selection and scrollback remain intact.

## Package ownership

### `packages/tui`

Owns reusable terminal mechanics with no coding-agent session semantics:

- row-window viewport primitive and source contract;
- viewport state: offset, height, total rows, tail-follow, tail position, and unseen rows;
- editor maximum-height and cursor-following internal scroll behavior;
- runtime autocomplete row budget;
- ANSI/display-width-safe rendering boundaries, focus marker, and terminal cursor placement;
- generic selection/list behavior under constrained row budgets.

These APIs are additive primitives. They must not know about assistant messages, tool calls, session streaming, status segments, GJC keybindings, or extension policy.

### `packages/coding-agent`

Owns product composition and semantics:

- rendering session messages into transcript rows;
- measuring transcript, pending/status/todo/Btw/hook widgets, status rail, editor, and autocomplete at the live terminal size;
- allocating the split layout and synchronizing it on resize/state changes;
- mapping live-tail, paused-history, and unseen-content state to user-facing affordances;
- wiring `Alt+PageUp`, `Alt+PageDown`, and `Alt+End` after overlay/autocomplete precedence;
- retaining composer focus and existing session steering/queue/interrupt behavior;
- applying the 18-row cap and tiny-terminal degradation policy to the default and replacement editors;
- exposing deterministic product states through the state harness and producing visual evidence.

### Extensions and custom editors

The compatibility boundary remains the existing component/editor and extension UI contracts. Extensions may replace the editor or show an overlay through established lifecycles; they do not receive direct ownership of transcript viewport internals. Replacement editors should consume shared optional capabilities such as maximum height, autocomplete provider/budget, history, focus, and resize invalidation when supported. Unsupported optional capabilities must degrade explicitly and must not create a parallel sticky-layout implementation.

## Layout allocation contract

For each render or relevant state/resize update:

1. Resolve current terminal width and height using non-negative integer arithmetic.
2. Measure fixed and transient rows at the current width: status, loaders, todo/Btw, hook widgets, and other lower-region content.
3. Measure the editor with its border-inclusive maximum of 18 rows and at least one visible cursor-bearing content row when an interactive layout is possible.
4. Allocate autocomplete from remaining optional rows, bounded by its configured maximum and including any scroll-position row.
5. Assign the remaining rows to the transcript viewport.
6. If the transcript is shorter than its allocation, pad above it rather than between the status rail and composer.
7. Clamp every result; tiny terminals must produce deterministic empty/short regions, never negative slicing or stale rows.

Measurements must use rendered terminal rows at the current width. Markdown source lines, JavaScript string length, or ANSI-bearing string length are not substitutes for display-cell measurement.

## State model

The transcript viewport has two principal modes:

- **Follow tail:** offset tracks the maximum offset. Appended rows are immediately visible and unseen count is zero.
- **Paused history:** an explicit user scroll fixes a historical window. Appended rows do not change the reading offset; they increase unseen rows relative to the last seen tail. Returning to the tail clears unseen rows and restores follow mode.

Transcript shrink, session rebuild, width reflow, and resize must clamp offsets. At the tail, reflow remains at the tail. While paused, the implementation should preserve the same logical reading region as closely as rendered-row remapping permits and must not silently opt back into follow mode.

The editor has a separate internal wrapped-row viewport. Transcript scrolling and editor scrolling are independent; neither may mutate the other's offset or focus.

## Input precedence

Keyboard dispatch order is:

1. topmost visible overlay/selector;
2. open autocomplete;
3. high-priority interrupt/transient UI handling;
4. transcript controls (`Alt+PageUp`, `Alt+PageDown`, `Alt+End`);
5. coding-agent and editor shortcuts/navigation/history.

This ordering preserves plain Up/Down and PageUp/PageDown for existing editor and autocomplete behavior. Transcript paging is available while composer focus remains active.

Mouse-wheel routing is intentionally outside the initial compatibility surface. The TUI must not enable SGR mouse capture solely for the sticky composer. A later routed implementation must prove overlay-under-pointer, autocomplete, internal editor, transcript, and native scrollback precedence without regressing selection or IME behavior.

## ANSI, Unicode, and cursor boundary

The viewport and editor operate on rendered rows whose widths are computed after excluding ANSI control sequences and respecting grapheme/display-cell width. They must preserve balanced SGR/OSC state across sliced rows and prevent hyperlink/style bleed.

CJK and mixed CJK/Latin content are first-class acceptance cases. Reflow must not split grapheme clusters or wide cells, misalign borders, detach punctuation in a semantically misleading way, or leave a cursor inside the second cell of a wide glyph.

Focused editors emit the shared zero-width cursor marker at the visual cursor cell. The TUI strips the marker and positions the hardware cursor, preserving IME candidate-window anchoring. Placeholder and inline-hint paths must preserve this anchor. Software cursor fallback remains required when hardware cursor display is disabled.

## Compatibility boundary

The decision is intentionally additive:

- Existing theme color and symbol keys remain authoritative; no new required theme token is introduced.
- Existing transcript component renderers remain the source of content rows.
- Existing editor text, history, autocomplete provider, submit, paste, IME, queue, and app-shortcut contracts remain in force.
- Existing overlay focus ownership remains in force.
- Existing non-interactive/print/RPC modes are outside this layout change.
- The generic TUI viewport and autocomplete-budget APIs may be adopted incrementally by other surfaces without importing coding-agent semantics.

The transcript viewport is a presentation boundary, not session storage. It must not change message persistence, compaction, provider streaming, export fidelity, or tool execution ordering.

## Alternatives rejected

### Rely only on native terminal scrollback

Rejected because browsing moves away from the active input, behavior differs across terminals/multiplexers, and the application cannot reliably represent paused history or unseen streamed rows.

### Keep one unbounded vertical component stream

Rejected because a long composer or transcript competes for the same screen height and cannot guarantee persistent input access.

### Overlay or float the composer over transcript rows

Rejected because covered transcript content becomes unreadable, terminal z-order is fragile, cursor/IME placement is harder to reason about, and visual evidence becomes terminal-dependent.

### Put transcript and composer side by side on wide terminals

Rejected because it creates a second layout grammar, reduces readable width for code/CJK content, and complicates responsive behavior. Wide terminals use the same vertical split with more row/column capacity.

### Capture mouse scrolling as the primary interaction

Rejected for the initial change because SGR mouse reporting can hijack native selection and terminal scrollback. Explicit keyboard controls provide deterministic behavior without a new terminal capability dependency.

### Implement viewport semantics only in `packages/coding-agent`

Rejected because bounded row-windowing, tail following, unseen tracking, editor internal scrolling, and autocomplete row budgets are reusable TUI mechanics. Product semantics remain in coding-agent, while generic mechanics belong in TUI.

### Fork a special sticky composer editor

Rejected because it would duplicate Unicode, IME, history, autocomplete, paste, cursor, and extension behavior. The shared editor receives additive constraints instead.

## Consequences

### Positive

- Users can read earlier output while retaining a visible, focused composer.
- Streaming no longer forces history readers back to the tail.
- Composer growth is bounded and cursor navigation remains available through internal scrolling.
- Tiny-terminal behavior and autocomplete height become deterministic.
- Reusable viewport/autocomplete-budget primitives become available to other TUI surfaces.
- The state model creates an explicit place for unseen-content affordances and evidence.

### Costs and risks

- Rendered transcript rows must be measurable/windowable at the active width; width changes invalidate row maps.
- ANSI state, Markdown wrapping, images, and variable-height components make row boundaries more complex than source-message boundaries.
- Two independent scroll positions now exist: transcript history and editor content.
- Tiny terminals may show very little transcript or no autocomplete, by design.
- Extension/custom-editor compatibility needs explicit harness coverage.
- Visual QA must cover a larger cross-product of state, terminal size, cursor mode, and localization.

## Rollback

Rollback is a composition change, not a data migration:

1. Remove coding-agent transcript viewport allocation and transcript keybindings/affordance wiring.
2. Restore transcript components to the existing linear root component stream and existing bottom-pinning behavior.
3. Leave additive `packages/tui` viewport, editor maximum-height/internal-scroll, and autocomplete-budget APIs in place if other callers use them; otherwise remove them in a separate compatibility-reviewed change.
4. Do not alter session files, message schemas, or persisted history; the decision introduces none.

If a staged rollout needs a temporary guard, it must select between complete old and new composition paths. It must not mix a viewport-rendered transcript with terminal-scrollback assumptions in one frame.

## Verification and evidence contract

Implementation review must use the matrix in `packages/coding-agent/DESIGN.md`, including default, focus, streaming, paused-history, unseen, autocomplete, overlay, error, tiny-terminal, custom-editor, CJK, ANSI, cursor, and resize states across tiny/narrow/medium/wide fixtures.

Evidence must include plain text, ANSI-preserving text, HTML rendering, metadata, and images where useful. Scrollable transcript and editor captures must show top, middle, and bottom/tail boundaries. An independent reviewer must inspect the full fresh evidence set. This ADR does not assert that those checks have been performed.

## Follow-up: semantic extension renderer

A later extension API may expose a **semantic transcript renderer** rather than raw row mutation. An extension would return typed blocks (for example label, body, status, code, actions, accessibility text, and stable identity), while coding-agent owns theme mapping, ANSI sanitization, width-aware wrapping, viewport row indexing, focus rules, and evidence fixtures.

This follow-up should be designed separately. It must not allow extensions to inject unmeasured ANSI/control sequences directly into viewport bookkeeping, bypass row budgets, steal composer focus, or depend on private transcript offsets. The semantic boundary would make extension content compatible with sticky browsing without freezing today's internal component tree as public API.
