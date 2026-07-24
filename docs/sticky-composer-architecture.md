# Sticky Composer Architecture Decision Record

- **Status:** Accepted
- **Issue:** #3056
- **Design source:** [`packages/coding-agent/DESIGN.md`](../packages/coding-agent/DESIGN.md)
- **UI workflow branch:** Extract existing system first

## Context

The interactive TUI previously rendered transcript content, status/widgets, and the editor in one vertical stream. Browsing terminal history could move the input out of view, while a long multiline draft could consume too much terminal height.

Issue #3056 requires two user-visible behaviors:

1. Keep the composer visible and active while users browse older transcript turns.
2. Cap composer growth and scroll long drafts internally while keeping the cursor visible.

Detailed visual tokens, responsive states, CJK/ANSI rules, and the evidence matrix live in `packages/coding-agent/DESIGN.md`. This ADR records only the architecture decision and its consequences.

## Decision

Use a vertical split:

1. A bounded, independently scrollable transcript viewport.
2. Measured transient/status and widget rows.
3. A persistent composer capped at 18 border-inclusive rows.

The transcript follows live output by default. Explicit browsing pauses follow-tail; new streamed rows increase an unseen count without forcing a jump. `Alt+PageUp` and `Alt+PageDown` page history, and `Alt+End` returns to the live tail.

The composer remains mounted and focused during transcript browsing. Input exceeding the editor budget scrolls inside the editor, and cursor movement reveals the cursor-bearing wrapped row.

## Ownership

### `packages/tui`

Owns reusable terminal mechanics:

- `ScrollViewport` row-window source and offset/tail state;
- offscreen viewport-anchor reveal delegation;
- editor maximum height and internal cursor-follow scrolling;
- runtime autocomplete row budgets;
- focus replacement and resize-safe viewport repainting.

These APIs do not contain coding-agent session or message semantics.

### `packages/coding-agent`

Owns product behavior:

- composing transcript/status/widgets/composer into the terminal row budget;
- follow-tail, paused-history, unseen-content, and return-to-tail affordances;
- transcript keybindings and overlay/autocomplete precedence;
- applying layout budgets to default and replacement editors;
- preserving upstream semantic turn anchors and IRC split rendering.

## Responsive and focus invariants

- Re-measure every region at the current terminal width and height.
- Remove optional autocomplete and secondary widget rows before sacrificing the cursor-bearing editor row.
- Pad short transcript content above the lower stack so the composer remains bottom-aligned.
- Preserve paused-history intent across width reflow using a stable anchor or distance from tail.
- Offscreen previous/next turn navigation must move the internal viewport to the target anchor.
- Overlay focus restoration must target the current replacement editor, never a disposed editor.
- Resize repainting must re-anchor at the live viewport origin before redrawing; relative cursor movement is unsafe after terminal reflow.

## Alternatives rejected

- **Native terminal scrollback only:** moves the composer out of view and cannot represent follow-tail/unseen state reliably.
- **One unbounded component stream:** cannot guarantee persistent input access or bounded draft growth.
- **Composer overlay:** obscures transcript rows and complicates cursor/IME placement.
- **Separate sticky editor implementation:** duplicates Unicode, history, autocomplete, paste, and extension behavior.
- **Mouse-wheel capture in this change:** risks breaking native selection and scrollback; keyboard controls remain deterministic.

## Consequences

### Benefits

- Users can browse earlier output while continuing to type and submit.
- Streaming does not force history readers back to the tail.
- Long drafts remain bounded and cursor-accessible.
- Resize and offscreen turn navigation have explicit ownership and regression coverage.

### Costs

- Transcript and editor maintain independent scroll positions.
- Width changes require transcript and editor reflow.
- The current container-backed transcript source may re-render more content than a future semantic row-addressable source; that performance optimization is a separate follow-up.

## Rollback

Rollback requires no data migration:

1. Restore transcript components to the previous linear root composition and bottom-pinning behavior.
2. Remove coding-agent transcript paging/follow-tail wiring.
3. Retain additive TUI primitives if other callers use them, or remove them in a separate compatibility-reviewed change.
4. Do not change session files, persisted messages, or provider/tool ordering.

## Verification boundary

Completion evidence is defined by `packages/coding-agent/DESIGN.md`. At minimum, tests and captures must cover transcript top/middle/tail, paused streaming, unseen rows, offscreen anchor reveal, editor overflow, overlays, custom-editor replacement, CJK/ANSI content, and repeated terminal resize across tiny/narrow/medium/wide grids.
