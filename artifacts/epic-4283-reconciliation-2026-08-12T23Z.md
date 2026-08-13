# Epic #4283 Reconciliation Ledger — 2026-08-12 23:58Z (refresh 3, replaces 11Z ledger)

**Coordination lane:** `owner/issue-4283-customization-epic` (epic-owner worktree, no child implementation, no child-branch mutation)
**Reference dev head:** `178fc2624803c76ee4fc5bc6ce89e7ed8f906373` (`origin/dev` at capture 23:57Z)
**Prior ledgers:** `artifacts/epic-4283-reconciliation-2026-08-12.md` (10:00Z), `artifacts/epic-4283-reconciliation-2026-08-12T11Z.md` (11:15Z, gen-3 precision-passed)
**Trigger:** owner-directed event-driven reconciliation (child terminal transitions + new PR #4357).

## Child-state ledger (freshly derived; all rows independently re-checkable)

| Child | Contract | Issue state (REST 23:57Z) | PR evidence | Git/CI evidence vs dev `178fc26248` | Terminal |
|---|---|---|---|---|---|
| #4284 | Stored MCP registrations active in ordinary sessions | **CLOSED 14:42:39Z** (lane evidence comment) | PR #4335 MERGED 11:52:32Z, merge commit `41473691c5` | `git merge-base --is-ancestor 41473691c5 origin/dev` → YES | ✅ Terminal |
| #4285 | Zero-config conventional SKILL.md discovery | CLOSED 11:13:28Z (epic-owner evidence comment-5265933569) | PR #4349 MERGED 11:07:45Z → `ef3bd5c227` | ancestor of dev (verified 11:15Z; stable) | ✅ Terminal |
| #4286 | Hook convention normalization | CLOSED 02:50:15Z | #4289 `77ce3f7b99` + #4307 `eef03e4617` | ancestors of dev (verified 11:15Z; stable) | ✅ Terminal |
| #4287 | Loose customization vs bundles | CLOSED 00:47:11Z | #4290 `364cbfe610` | ancestor of dev (verified 11:15Z; stable) | ✅ Terminal |
| #4288 | Provenance-aware customization doctor | OPEN | PR #4350 OPEN, non-draft, head `9a2e9bdf7c6b1f941c89fb78b9fbb572b62c18e4`, base `dev`; REST `mergeable_state=clean` at 23:57Z read (time-scoped) | 24/24 check-runs pass at exact head, **but** the lane's own detached verification amended its verdict at 00:00:09Z (comment `5274201507`): MERGE_READY (`5274191517`) → **REQUEST_CHANGES** — Finding A: disabled provider incorrectly shadows active provider in `discoverCapability()` winner map (`customize-doctor.ts:372-420`, missing disabled filter); Finding B: custom-directory skill-shadowing bug; Finding C: observation only. Bounded ~10-line repair, no CLI surface change | **Nonterminal — review-amended, bounded fix owed by child lane** |
| #4291 | `/extensions` UI + Claude/Codex import | OPEN (upd 22:12Z) | No PR. **No remote branch** (`git ls-remote` zero matches for `4291`/`extensions-ui`, re-verified 23:57Z) | Lane 22:12Z comment: ownership recovery — resident endpoint had zero token activity with substantial uncommitted local implementation; fresh SDK turn `1dbec6fe-dff9-4a0c-84f0-a928fe325af0` accepted and `in_flight`, required to preserve/audit artifacts, refresh vs current dev, publish branch + PR | **Nonterminal — lane owes publish evidence** |
| #4292 | MCP 2026-07-28 stateless protocol (v2) | OPEN (upd 11:45Z) | PR #4357 OPEN **draft**, head `97185fddb9`, base `dev`, REST `mergeable_state=unstable` at 23:57Z read | 33 check-runs at head, **3 failures**: `Affected path validation`, `evidence producer`, `check:@gajae-code/coding-agent` (same shard topology as the #4335 gen-1 failure); lane active, draft/stale per owner inventory | **Nonterminal — draft with failing package check** |

## Notes

- #4292's last issue comment (11:45:52Z) is a botched `@/tmp/issue-4292-update.md` path paste, not evidence; the PR #4357 draft is the lane's real current surface.
- Terminal transitions since the 11Z ledger: #4284 (merged 11:52Z, closed 14:42Z). 4/7 children now terminal — all verified by merge-commit ancestry, not by issue state alone.

## Epic acceptance gaps (owned by this epic lane; execute after remaining children land)

1. **Umbrella integration doc** (Claude Code / Codex / native `.gjc` precedence+trust model) — still absent on dev; per-surface docs exist (skills/hooks/plugins/mcp). Blocked on #4288 + #4291 final behavior.
2. **Representative cross-convention e2e fixture** (one MCP/skill/hook customization consumed via Claude Code, Codex, native GJC) — still absent; blocked on #4288 landing and #4292 protocol shape.

## Disposition

#4283 stays **OPEN**: 4/7 terminal; #4288 REQUEST_CHANGES at exact head (bounded ~10-line child-lane repair, amendment `5274201507`), #4291 unpublished, #4292 draft-with-failing-checks. No epic-level implementation admissible yet. This row supersedes the 23:58Z "merge decision only" reading — the amendment comment (00:00:09Z) predates the 23:58Z epic comment (`5274222552`) by ~2 minutes and was missed by the ledger capture window; corrected here and in superseding epic comment (gen-4, terminal-critic-driven).
**Bounded event-driven hold** — resume triggers: (a) #4350 review findings resolved + merged, (b) remote branch/PR appears for #4291, (c) #4357 exits draft with green `check:@gajae-code/coding-agent`, (d) any child terminal transition, (e) owner directive. No periodic busywork; next reconciliation is event-triggered only.
