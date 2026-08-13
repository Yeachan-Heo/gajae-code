# Epic #4283 Reconciliation Ledger — 2026-08-13 14:05Z (refresh 4, replaces 23Z ledger)

**Coordination lane:** `owner/issue-4283-customization-epic` (epic-owner worktree; coordination-only, no child implementation, no child-branch mutation, no shared #4291 files)
**Reference dev head:** `d2f6e8a4091a219f00d3ab304cc1b124e43cc0d3` (`origin/dev` at capture 14:04Z)
**Prior ledgers:** `…-2026-08-12.md` (10:00Z), `…-T11Z.md` (11:15Z), `…-T23Z.md` (23:58Z + 00:15Z correction)
**Trigger:** owner-directed full acceptance-checklist refresh against dev `d2f6e8a4`.

## Acceptance checklist (epic body contract)

| # | Acceptance item | State | Evidence |
|---|---|---|---|
| 1 | All child issues merged or explicitly closed with evidence | **6/7 terminal; #4291 OPEN with no pushed evidence** | per-child rows below |
| 2 | Integration documentation describes the precedence/trust model | **Gap stands** — per-surface docs only (`docs/skills.md`, `docs/hooks.md`, `docs/standalone-mcp.md`, `docs/gjc-plugins.md`); no umbrella doc tying Claude Code / Codex / native `.gjc` precedence+trust into one model (re-scanned on `d2f6e8a4`) | epic-lane-owned; admissible once #4291 lands |
| 3 | E2E fixture: same representative MCP/skill/hook customization consumed via Claude Code, Codex, and native GJC conventions | **Gap stands** — only per-surface cross-convention tests on dev (`customize-doctor.test.ts` is the doctor's provenance surface, not a consumption fixture; `hook-event-normalization.test.ts` hooks-only; skills tests skills-only) | epic-lane-owned; admissible once #4291 lands |

## Child-state ledger (freshly derived at 14:04Z; all rows independently re-checkable)

| Child | Contract | Issue state (REST) | PR / merge evidence | Ancestry vs dev `d2f6e8a4` | Terminal |
|---|---|---|---|---|---|
| #4284 | MCP registrations active in ordinary sessions | CLOSED 2026-08-12T14:42:39Z | PR #4335 MERGED 11:52:32Z → merge commit `41473691c5` | `--is-ancestor` YES (verified 23:57Z; stable) | ✅ |
| #4285 | Zero-config SKILL.md discovery | CLOSED 11:13:28Z | PR #4349 MERGED 11:07:45Z → `ef3bd5c227` | YES (stable) | ✅ |
| #4286 | Hook convention normalization | CLOSED 02:50:15Z | #4289 `77ce3f7b99` + #4307 `eef03e4617` | YES (stable) | ✅ |
| #4287 | Loose customization vs bundles | CLOSED 00:47:11Z | #4290 `364cbfe610` | YES (stable) | ✅ |
| #4288 | Provenance-aware customization doctor | **CLOSED 2026-08-13T01:31:21Z** | PR #4350 MERGED 01:30:40Z → merge commit `b7e0dea98c07082830b2a3bf66ec933c89633ffd`, final head `ca537cab57` (REQUEST_CHANGES findings A/B repaired post-amendment `5274201507`; dev `customize-doctor.ts` carries the full provenance taxonomy incl. `disabled-provider`, `shadowed-by-precedence`) | `--is-ancestor b7e0dea98c origin/dev` → YES (14:04Z) | ✅ |
| #4291 | `/extensions` UI + Claude/Codex import | **OPEN** (upd 2026-08-12T22:12:36Z — 16h stale) | **No PR. No remote branch** (`git ls-remote` zero matches for `4291`/`extensions-ui`, re-verified 14:04Z). Lane's 22:12Z comment: ownership recovery, fresh turn `1dbec6fe-dff9-4a0c-84f0-a928fe325af0` `in_flight`, owes preserve/audit + refresh + publish | N/A | **Nonterminal — sole remaining child; lane owes publish evidence** |
| #4292 | MCP 2026-07-28 stateless protocol | **CLOSED 07:29:12Z** | PR #4357 MERGED 07:27:39Z → merge commit `12e1df1724bec0b7b1a40988cdc2a0c7dcca29ec`, final head `104e0e2f35` | `--is-ancestor 12e1df1724 origin/dev` → YES (14:04Z) | ✅ |

## Disposition

**#4283 stays OPEN.** Terminal transitions since the 23Z ledger: #4288 (merged 01:30Z) and #4292 (merged 07:27Z). Remaining: child #4291 (no remote evidence; its lane was steered to publish at 22:12Z and has produced nothing remotely visible in 16h) plus the two epic-lane acceptance items (umbrella doc + representative fixture), which are deliberately sequenced after #4291 because both must describe/consume its final import behavior.

**Bounded event-driven hold** — resume triggers: (a) remote branch or PR appears for #4291 (checked via `git ls-remote`/PR list); (b) #4291 closed with evidence; (c) owner directive. On trigger (a)/(b) this lane executes the umbrella doc + representative fixture as the final epic-lane acceptance work. No periodic busywork.
