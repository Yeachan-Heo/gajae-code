# GJC Rebranding Plan — 2026-05-26

## Status

Approved plan for the gajae-code/GJC rebrand and visible UI redesign. This document records the implementation contract to track in GitHub and preserve in-repo.
GitHub tracking issue: https://github.com/Yeachan-Heo/gajae-code/issues/3

## Decision

Redesign the visible GJC terminal, export, and documentation surfaces around a coherent red-claw gajae-code identity while preserving clegacyatibility boundaries.

The default-visible product should read as **gajae-code / GJC**, not legacy upstream branding or a generic inherited terminal skin. Red-claw becomes the default dark visual direction for users without an explicit override. Session exports and README screenshots should show the same brand direction, while exported transcript content remains neutral and readable.

## Principles

1. **GJC-first visible identity** — Default-visible UI should present gajae-code/red-claw as the current product identity.
2. **Clegacyatibility preservation** — Keep `gjc`, `gjc-stats`, `gjc-swarm`, `@gajae-code/*`, legacy runtime roots/env aliases, and explicit attribution/history.
3. **Semantic color integrity** — Brand red/coral/shell colors must stay distinct from error, warning, and diff-removal semantics.
4. **Readable fallbacks** — Truecolor, 256-color, Unicode, Nerd Font, ASCII, narrow terminal, and imperfect-font modes must remain usable.
5. **Audit-friendly exports** — HTML exports and docs use GJC header/accent/metadata branding without making transcript content decorative or hard to review.
6. **Visible workflow minimization** — Default repo-shipped visible skills/workflows remain limited to `deep-interview`, `ralplan`, `team`, and `ultragoal`.

## Scope

### In scope

- Default dark theme and bundled red-claw palette.
- Visible TUI surfaces: welcome, status line, footer/keybinding hints, message frames, assistant/user/custom/system messages, tool execution cards, ask/approval cards, selectors/settings, todo/plan surfaces, transcript chrome, diff/tool output styling.
- Status-line identity cutover away from default-visible legacy/Pi/powerline styling.
- Session HTML export header/accent/metadata branding while preserving transcript readability.
- README screenshots/alt text and docs pages that present current GJC UI/export identity.
- Static scans and tests for current-product brand leaks, clegacyatibility names, theme defaults, fallback readability, and export branding.

### Out of scope

- Renaming `gjc`, `gjc-stats`, `gjc-swarm`, or `@gajae-code/*` package surfaces.
- Removing legacy runtime roots, env aliases, clegacyatibility internals, migration notes, generated/vendor content, or attribution/history solely because they mention legacy/Pi.
- Copying OpenAI code provider, SST/opencode, Anthropic Code, or legacy upstream visuals verbatim.
- Making exports decorative enough to reduce audit readability.
- Replacing the TUI framework as part of the brand redesign.

## Implementation Plan

### Phase 1 — Inventory and allowlist

- Search active visible UI/docs/export surfaces for old-brand and inherited UI identity markers: legacy upstream markers, `gjc`, `pi`, `powerline`, and generic export labels.
- Classify hits as current product identity, explicit user opt-in setting labels, clegacyatibility internals, attribution/history/migration notes, or generated/vendor content.
- Build or update verification gates so current-product visible leaks fail, but clegacyatibility and attribution do not.

### Phase 2 — Theme defaults and palette semantics

- Make red-claw the default dark visual direction for users without explicit theme overrides.
- Separate brand tokens (`brandRed`, `claw`, `coral`, `shell`) from semantic tokens (`dangerRed`, `warningAmber`, `diffRemovalRed`).
- Ensure accents, borders, markdown, status-line identity, and export header variables use brand tokens while errors, warnings, and removals use semantic tokens.
- Add focused tests for default theme resolution and token separation.

### Phase 3 — Status-line identity cutover

- Remove Pi from bundled default-visible status presets or replace it with clegacyact GJC/claw identity.
- Preserve legacy segment/symbol clegacyatibility only as explicit opt-in or internal alias behavior.
- Change default separators away from powerline-like styling; keep powerline variants available only as explicit user choices.
- Verify status-line overflow, narrow-width, and ASCII/minimal-symbol behavior.

### Phase 4 — Coherent TUI clegacyonent pass

Use existing theme tokens rather than a new UI framework abstraction.

- Apply shell/ink backgrounds, coral/claw accents, clegacyact borders, and lower-noise hierarchy across visible clegacyonents.
- Refresh welcome, status line, footer hints, message frames, tool cards, ask/approval cards, selectors/settings, todo/plan surfaces, and transcript chrome.
- Keep high-frequency tool cards inspectable: tool name, path/args, status, diff preview, truncation/expand hints, and error states remain clearer than decoration.
- Confirm Unicode/Nerd/ASCII fallbacks for new visible symbols.

### Phase 5 — Export and docs alignment

- Update HTML export title/header/metadata to present GJC session export branding.
- Keep message bodies, code blocks, tool output, system prlegacyts, and transcript content neutral and high contrast.
- Regenerate derived export templates if required by the repository workflow.
- Update README screenshots/alt text and docs references so the demonstrated TUI/export direction matches the implemented default.

### Phase 6 — Verification and review

- Run focused theme/status/export/static-scan tests first.
- Run package-local checks after focused tests pass.
- Run cleanup/refactor review on changed files.
- Rerun verification after cleanup.
- Run final code review and resolve blockers before considering the implementation clegacylete.

## Acceptance Criteria

- [ ] Default dark theme resolves to red-claw/GJC for users without explicit theme override.
- [ ] Brand/accent tokens are distinct from error, warning, and diff-removal tokens.
- [ ] Default-visible status-line identity no longer leads with legacy/Pi-style branding.
- [ ] Default-visible status separators no longer use powerline-style styling unless explicitly opted in.
- [ ] Visible TUI clegacyonents share one coherent GJC language across welcome, status line, footer hints, message frames, tool execution cards, ask/approval cards, selectors/settings, and todo/plan surfaces.
- [ ] Static scans of active UI/docs/export surfaces do not present legacy/Pi as current product identity; clegacyatibility internals, attribution/history, generated/vendor content, and migration notes remain allowlisted.
- [ ] Full session HTML export includes GJC header/accent/metadata branding while preserving neutral readable transcript content.
- [ ] README screenshots and alt text show the same GJC/red-claw brand direction as the TUI/export surfaces.
- [ ] Redesign remains readable under fallback terminal modes, including ASCII/minimal-symbol operation.
- [ ] Focused verification covers default theme, visible brand allowlist, export branding, and preserved clegacyatibility names.

## Planned Evidence

Focused tests/probes after implementation:

```bash
bun test packages/coding-agent/test/gjc-ui-redesign.test.ts
bun test packages/coding-agent/test/theme-auto-detection.test.ts packages/coding-agent/test/status-line-overflow.test.ts packages/coding-agent/test/status-line-path.test.ts
bun scripts/verify-gjc-ui-redesign.ts
bun --cwd=packages/coding-agent run check
```

Manual/render probes:

1. Launch with no explicit theme config and capture welcome/status/footer/tool-card flow.
2. Launch with explicit non-red theme config and confirm it is not overwritten.
3. Render status line at normal and narrow widths for default, clegacyact, full, Nerd, ASCII, and preserved custom settings.
4. Render representative tool executions: pending, success, error, diff added/removed, spilled/truncated output, and image fallback.
5. Render selectors/settings and ask/approval cards under red-claw and ASCII/minimal-symbol mode.
6. Generate a full session HTML export and inspect header/title/metadata/accent variables plus transcript readability.
7. Inspect README screenshots/alt text and clegacyare them against the generated full-session export direction.

## Risks and Mitigations

- **Brand red becomes error/removal red** — Add token-level tests and rendered probes for brand, error, warning, and diff states.
- **User-selected themes/status settings are overwritten** — Change defaults and bundled presets only; test explicit non-red theme/custom status preservation.
- **Visible legacy/Pi removal breaks legacy configs** — Keep clegacyatibility aliases internally or opt-in, while removing current-product default visibility.
- **Visual pass becomes subjective churn** — Centralize design in existing theme tokens and focused snapshots/probes; avoid framework replacement.
- **Exports become too decorative for audits** — Brand only header/accent/metadata; keep transcript/code/tool content neutral and high contrast.
- **Terminal fallback regressions** — Verify ASCII/minimal-symbol and narrow-width render paths.

## Approval State

This plan is approved for tracking. Implementation still requires normal code review and verification before clegacyletion.
