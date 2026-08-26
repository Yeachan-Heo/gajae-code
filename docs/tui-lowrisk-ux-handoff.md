# TUI low-risk UX batch — handoff

Branch `research/ui`, PR [#4965](https://github.com/Yeachan-Heo/gajae-code/pull/4965) into `dev`.

Six defects where the TUI rendered an affordance nothing could reach, or discarded information without saying so. Planned via `ralplan` (Architect `CLEAR`/`APPROVE`, Critic `OKAY`), executed via `ultragoal`.

## What shipped

| Slice | Fix |
|---|---|
| `nav-palette-entries` | Six navigation actions had a registry callback and predicate but no palette entry and no key dispatch. Now listed through an **opt-in** availability gate (`#availabilityGatedPaletteActions`), with remap loops and `defaultKeys: []`. |
| `todo-hud-expand` | `toggleTodoExpansion()` had zero callers. Now reachable via `alt+shift+t` and an availability-gated palette entry. |
| `nav-keybinding-defaults` | `alt+shift+s`/`f`/`r` for session tree/fork/resume. Data-only; the dispatch loops already existed. |
| `reduced-motion` | New public setting `startup.skipLogoAnimation` (Interaction tab, default `false`), read once at startup. |
| `statusline-overflow` | Silent segment eviction now cued with a width-reserved marker. Count is exact or intentionally absent, never truncated. Eviction **order** unchanged. |
| `editor-registry-routing` | Five `tui.editor.*` chords moved off hard-coded literals onto the registry, plus a `ctrl+backspace` repair for Windows Terminal. |

## Deferred, with rationale

These are numbered non-goals in the approved plan, not oversights.

1. **`NO_COLOR` contract** — `Theme.fg`/`Theme.bg` always emit SGR; only `isHyperlinkEnabled` consults `NO_COLOR`. This violates the contract in `packages/coding-agent/src/modes/DESIGN.md`. Reaches **103 files** under `packages/coding-agent/src` and needs a conflicting raw reverse-video fallback in `src/tools/vim.ts` reversed. Highest-value follow-up; needs its own reviewed change.
2. **Default bindings for the six palette-only nav ids** — `sendNow` and `mode.cycle` sit in `ACTION_HINT_PRIORITY`, so binding them mutates default composer hints. Needs a product decision on hint priority first.
3. **Full curated-palette availability/dispatch migration** — filtering every curated entry (not just the opt-in six) changes visible palette contents for pre-existing thinking, model-cycle, editor, copy, queue and session actions. Two execution models coexist today: pre-existing entries are direct closures, the gated six route through `#executeAction`.
4. **Status-line eviction priority** — `right` is a bare `string[]` with no identity parallel to `leftSegIds`, so a cross-segment priority policy needs new typed provenance and would override the retention users express through configured segment order.
5. **Editor `ctrl+a`/`ctrl+e` precedence** — those literals still shadow the registry-driven `cursorLineStart`/`cursorLineEnd` branches. Named as explicit exceptions in `docs/keybindings.md` so the published contract is accurate rather than silently false.
6. **`app.mode.cycle`** — dispatches byte-identically to `app.plan.toggle` with no distinct behavior. Left unbound; needs a product call on whether it should exist.
7. **Higher-risk research findings, untouched** — unified session hub (merging `SessionsDashboardComponent` with `SessionSelectorComponent`), notification rail, reviewable large-paste cards, inline `CollapsedChatHistoryComponent` recovery.

Also deferred: whether the theme `ascii` symbol preset should govern the truncation ellipsis repo-wide. `Ellipsis.Ascii` is currently unused in `packages/coding-agent/src` and no renderer branches on the preset.

## Known pre-existing failure

`bun run check:ts` fails at `check:sdk-closure` (`sdk-acp-adapter.test.ts`, "SDK internal launch refused: runtime dependency escapes its trusted root"). Reproduces at the merge base with this branch's commits stashed, emits no TypeScript diagnostics, and touches no path this work modifies. Not from this branch.

## Landmines for whoever touches this next

Hard-won during review; worth reading before editing these files.

- **`render()` applies `truncateToWidth` after status rows are built.** An assertion that reads only `render(width)` output cannot distinguish the reserved overflow marker from an ellipsis that truncation manufactured. Two real defects hid behind exactly that. Assert `getPreviewContent(width)` raw rows *before* the rendered ones.
- **`ActionRegistry` memoizes availability per microtask** and clears it on a queued microtask. Tests that flip a predicate and re-probe must yield first.
- **Editing `settings-schema.ts` triggers the mandatory computer-use red-team gate.** It is a shared behavior registry, so `ultragoal` requires all seven cases (`kill-switch-bypass`, `suspended-enforcement`, `permission-revoked`, `display-stale`, `out-of-bounds-drift`, `runaway-loop-halt`, `blast-radius`) even for a change with no computer-use behavior. A real suite exists at `packages/coding-agent/src/tools/computer.{redteam,enforcement}.test.ts` — run it, do not fabricate cases.
- **`sticky-viewport-showcase` fails fast on the first witness mismatch.** One reported key does not mean one drifted key; enumerate all 20 against a fresh capture. This batch found three.
- **The witness table is an anti-restatement oracle.** `STICKY_VIEWPORT_FRAME_TEXT_WITNESS` and the verifier derivation are both in `ORACLE_SOURCES`. Updating it requires a fresh capture plus an `independent-review.json` whose `reviewer_identity` the verifier machine-checks as distinct from the bundle's `capture-sticky-viewport-showcase` author/executor.
- **Terminal visual evidence has a real contract** (`docs/ui-design-visual-qa.md:62-66`): `terminal.html` must *render* ANSI as styled markup, not print escape notation, and `metadata.json` must carry font/rendering assumptions, capture timestamp, tool version, and live-PTY/replay/fixture mode. A bundle can prove the behavior and still fail this.
- **Test oracles must not iterate the production list under test.** `AVAILABILITY_GATED_NAV_PALETTE_ACTIONS` is asserted against a literal six-id expectation in both suites precisely so removing an id fails a test.
