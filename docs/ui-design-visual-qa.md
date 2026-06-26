# UI design and visual QA workflow

This is the repo-owned contract for future Gajae-Code UI, web, dashboard, terminal, and TUI visual work. It adapts the useful OMO design-reference and visual-QA workflow without vendoring any third-party design corpus.

It is not a fifth bundled workflow skill. Gajae-Code's public workflow surface remains `deep-interview`, `ralplan`, `ultragoal`, and `team`; use this document as planning/review guidance inside those workflows or direct implementation.

## Required branch before implementation

Before writing broad UI code, choose and record exactly one workflow branch in the plan, issue update, PR body, or local `DESIGN.md`:

1. **Existing design system** — the repository or product area already has a `DESIGN.md`, component system, theme, or comparable visual grammar. Read it first and update it when the change extends the system.
2. **Greenfield selected references** — no usable system exists, so pick a small shortlist of design references before implementation. Record the exact references loaded and translate them into first-party project guidance; do not copy raw vendor files into the repo.
3. **Extract existing system first** — the surface exists but its rules are implicit. The first deliverable is a minimal `DESIGN.md` that extracts the current tokens, layout grammar, component anatomy, and state rules before new product screens are built.

A UI task that skips this branch selection is not ready for implementation.

## `DESIGN.md` source material

New UI work must create or update the nearest product `DESIGN.md` before broad product-screen implementation. The document must be first-party source material for the implementation, not a screenshot dump or mood board. Include:

- **Tokens** — colors, typography, spacing, radii, borders, iconography, density, terminal color roles, and accessibility contrast constraints.
- **Layout grammar** — grids, page regions, navigation, hierarchy, rhythm, empty space, alignment, and composition rules.
- **Component anatomy** — named parts, slots, content rules, affordances, constraints, and when not to use the component.
- **States** — default, hover, active, focus, disabled, loading, empty, error, selected, expanded/collapsed, and permission/connection failure states where relevant.
- **Motion and depth** — animation timing/easing, transitions, shadows/elevation, overlays, focus movement, and reduced-motion behavior.
- **Responsive behavior** — mobile, tablet, desktop, narrow terminal, wide terminal, font scaling, wrapping, overflow, and high-density layouts.

For greenfield selected references, `DESIGN.md` must name the selected references and explain what was translated from each into the first-party system. It must not embed raw third-party corpus text as the system of record.

## Component showcase before product screens

Build or update a component showcase/state harness before implementing broad product screens. The harness may be Storybook, a local route, a CLI/TUI fixture, a docs page with runnable examples, or a purpose-built screenshot fixture, but it must expose the component states needed by the product surface.

The harness must cover:

- all states listed in `DESIGN.md` that the component supports;
- representative realistic content, including long strings, empty content, error copy, and localization-sensitive text;
- mobile/tablet/desktop or narrow/medium/wide terminal layouts as applicable;
- keyboard focus and accessibility-visible states for interactive components.

Product screens can follow only after the harness proves the component vocabulary is stable enough to reuse.

## Visual QA contract

Visual QA is completion evidence, not decoration. A UI story is not done until it has fresh full-surface evidence from the current branch.

Required evidence:

- **Fresh capture** — evidence must be generated after the current implementation, not reused from an older branch, design reference, or unrelated run.
- **Full-surface coverage** — capture every page, route, modal, drawer, tab, breakpoint, component state, and error/empty/loading state in scope. Sampling a few representative screenshots is not enough.
- **No hidden tails** — scrollable surfaces require evidence for top, middle, bottom, sticky regions, overflow behavior, and any virtualized content boundaries.
- **CJK semantic line breaks block completion** — Korean, Japanese, Chinese, and mixed CJK/Latin copy must not wrap in semantically broken or visually misleading ways. Bad CJK line breaks are blocking defects, not cosmetic polish.
- **Independent review before done** — a reviewer or review lane that did not author the implementation must inspect the full evidence set against `DESIGN.md`, the component harness, and acceptance criteria before the work is marked complete.
- **Evidence references** — PRs should link or attach the current evidence artifacts instead of describing them only in prose.

## Terminal and TUI evidence

Terminal/TUI visual work must preserve terminal semantics in future helper flows. Until Gajae-Code has a dedicated helper, terminal visual-QA evidence must document the exact helper requirements and avoid flattening away the data needed for review.

A terminal/TUI evidence helper must produce, at minimum:

- `terminal.txt` with readable plain text;
- `terminal-ansi.txt` preserving ANSI SGR color/style sequences and terminal control semantics needed for replay/review;
- `terminal.html` rendering the ANSI-styled output for browser review;
- optional `terminal.png` generated from the styled rendering when image evidence is useful;
- `metadata.json` containing command or replay source, terminal size, font/rendering assumptions, capture timestamp, tool version, wrapping/truncation policy, and whether the artifact is from a live PTY, replay, or fixture.

Reviewers must reject terminal/TUI evidence that only contains flattened text when the change depends on color, emphasis, cursor state, layout, wrapping, or other ANSI/terminal behavior.

## Provenance boundary

Do not vendor raw third-party design corpora, screenshots, brand guides, prompt packs, or critique/reference material into this repository without an explicit materializer and provenance design.

Allowed in a first PR:

- first-party `DESIGN.md` guidance written for Gajae-Code;
- a small hand-written reference index that names public sources and records why they were consulted;
- pinned links, citations, or manifests that do not copy raw third-party corpus content.

Requires explicit design before inclusion:

- raw third-party corpus files;
- copied design-system text, screenshots, or asset packs;
- submodules or generated materialized corpora;
- generated screenshots committed as durable source assets.

A future materializer design must define source ownership, license/provenance metadata, pinning strategy, reproducible generation, update review, generated-file boundaries, and what artifacts are safe to attach to GitHub without committing.

## PR checklist

For UI work, include this checklist in the PR body or equivalent review artifact:

- [ ] UI workflow branch selected: existing `DESIGN.md`, greenfield selected references, or extract existing system first.
- [ ] `DESIGN.md` created/updated with tokens, layout grammar, component anatomy, states, motion/depth, and responsive behavior.
- [ ] Component showcase/state harness exists before broad product screens.
- [ ] Fresh full-surface visual evidence covers every in-scope page/state/breakpoint; no sampling.
- [ ] CJK semantic line breaks were checked and any defects were fixed before completion.
- [ ] Terminal/TUI evidence preserves ANSI semantics or documents the exact helper requirements above.
- [ ] Independent review inspected the evidence before the work was marked done.
- [ ] No raw third-party corpus was vendored without an explicit materializer/provenance design.
