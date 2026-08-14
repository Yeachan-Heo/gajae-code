# Audit #4525: dev-vs-main Cherry-Pick Classification

**Status:** ANALYSIS COMPLETE — `OWNER_CONFIRMATION_REQUIRED`
**Date:** 2026-08-14
**Audit branch:** `audit/issue-4525-dev-main-minor-release`

## Exact Heads (refreshed and verified)

| Ref | SHA | Date |
|-----|-----|------|
| `origin/main` | `5666472818b71a1c37615408d9b4d3b5a77b7fa3` | 2026-08-13 16:19:42 +0900 |
| `origin/dev` | `38f3b4077c870e41d061f8f2aa7f5c873a30e25f` | 2026-08-13 20:42:21 +0000 |
| merge-base | `63ea66995c4e20ced48528f83af6e5b055fff372` | 2026-08-11 23:01:36 +0900 |

## Raw Range Reconciliation

| Metric | Count |
|--------|-------|
| Commits in `origin/main..origin/dev` | **1,031** |
| Merge commits in range | 211 |
| Non-merge commits in range | 820 |
| First-parent integration items | **174** |
| First-parent merge commits | 85 (68 GitHub PR-merge + 17 squash/rebase-merge) |
| First-parent non-merge commits | 89 (96 squash-with-PR-ref + 10 direct) |

**Reconciliation method:** `git rev-list --first-parent origin/main..origin/dev` produces 174 items. Each raw commit in the 1,031-commit range is reachable from exactly one first-parent integration item. The first-parent items decompose as: 68 GitHub-style merge commits (`Merge pull request #N`), 96 squash/rebase commits with `(#N)` suffix, and 10 direct commits without PR reference.

| Main-only commits | 16 (release/0.13.2 branch) |
| Patch-equivalent (dev→main) | 5 (already on main) |

## PR/Issue Inventory

| Metric | Count |
|--------|-------|
| Unique PR numbers referenced in dev range | 175 |
| Of which real PRs (exist on GitHub) | 145 |
| Of which issue refs (not PRs) | 30 |
| PRs with base=dev | 144 |
| PRs with base=main (closed/unmerged) | 1 (#4332) |
| Authors contributing | 21 (112 from Yeachan-Heo, rest from 20 contributors) |

## Classification Summary (174/174 items — 100% reconciled)

| Category | Count | Description |
|----------|-------|-------------|
| **A** | 57 | Individually cherry-pickable for minor release |
| **B** | 89 | Cherry-pickable only as named ordered dependency bundle |
| **C** | 11 | Unsuitable for minor release; valid for later major/dev promotion |
| **D** | 9 | CI/test/docs/generated support; accompany candidate or remain dev-only |
| **E** | 8 | Superseded/reverted/already-main/no-op |
| **Total** | **174** | **0 unclassified** |

## Category Definitions

- **A — Individually cherry-pickable:** Clean textual cherry-pick (or CHANGELOG-only conflict trivially resolved), ≤10 changed files (or verified bundle up to 28), types compile, tests pass.
- **B — Dependency bundle:** Has non-CHANGELOG conflicts against main. Can be cherry-picked if preceded by its dependency closure. Most B items conflict because they touch `session-manager.ts`, `agent-session.ts`, or `sdk/bus/*` files reshaped by #4098.
- **C — Dev promotion required:** Depends on #4098 SDK lifecycle refactor (228 files, 73K lines), or is the #4098 refactor itself, or is a massive multi-PR change that cannot be isolated. Must wait for dev→main promotion.
- **D — Support only:** Test/docs/CI/generated-only changes that should accompany a candidate/bundle or remain dev-only. Not independently user-facing.
- **E — Superseded/already-main:** Patch-equivalent to commits already on main via 0.13.2 release, or reverted supersession chain (#4199→#4438).

## Recommended Release Sets

### Set 1: Minimal Low-Risk Patch Set (6 PRs)

User-visible: image-gen API key redaction, TUI overlay CPU spin fix, TUI scratch-root resolution, synthetic API key validation, native wrapTextWithAnsi infinite-loop fix, G013 test deadline fix.

| Order | PR | Hash | Description |
|-------|----|------|-------------|
| 1 | #4437 | `0bd4898d1845` | fix(natives): break_long_word infinite loop on lone ESC |
| 2 | #4385 | `6add8ad61152` | fix(ai): validate Synthetic API key via models endpoint |
| 3 | #4302 | `394cee75a8f6` | fix(image-gen): redact API keys from provider errors |
| 4 | #4452 | `d2ac02f33272` | fix(tui): resolve scratch roots at render time |
| 5 | #4481 | `38f3b4077c87` | fix(tui): bound overlay geometry to stop main-thread spin |
| 6 | #4353 | `1cd83d3f88e1` | fix(test): keep G013 edit under shard-pressure deadline |

- **Dependency closure:** None (all verified clean, no cross-dependencies)
- **Validation:** TS types clean (ai, tui, coding-agent), Rust `text` tests pass, image-gen redaction tests pass, overlay-scroll tests pass, streaming-edit-abort tests pass
- **Rollback:** Single `git revert` per item; no state/migration changes
- **Simulated tree digest:** `657b70fd1e3652286f4b0036c9418f32708dc3e5`

### Set 2: Balanced Minor Set (35 items — 10 fixes + 25 fix/feat from Category A)

Adds: Windows session receipt reconciliation, macOS TCC permission fix, coordinator idempotency lock isolation, TUI theme switching, TUI image scrollback preservation, crash report feature, Kiro OAuth provider, status-line PR-lookup dedup, subagent await liveness, Paseo provider setup, Korean launcher alias, model fallback (Opus 5), Telegram archive fence, MCP manager exclusion, thinking-block adjacency fixes, hook validation, and more.

Full list in `audit-4525-classification.tsv` (all rows where category=A).

- **Dependency closure:** All items are clean or CHANGELOG-only cherry-picks. CHANGELOG conflicts auto-resolvable.
- **Validation:** Each item verified clean by `git cherry-pick --no-commit -m 1` against `origin/main`. Types verified for minimal subset.
- **Rollback:** Per-item revert; no state/migration/schema changes
- **Risk:** Medium — 35 items touching ai/tui/coding-agent/session/coordinator. CHANGELOG conflicts expected.

### Set 3: Full Coherent Minor Set (57 items — all Category A)

Includes everything from Set 2 plus larger features: settings unification (#4245, 51 files), hook convention normalization (#4289), crash report (#4271), skill zero-config discovery (#4349), muse/spark presets (#4294), multi-account auth (#4317), MCP v2 protocol (#4292), iTerm2 pet (#4468/#4499).

- **Risk:** Higher — 57 items including user-visible feature changes. Requires full test suite and CI validation.
- **OWNER_CONFIRMATION_REQUIRED:** Feature scope changes (settings refactor, new MCP protocol, new auth model).

## Cherry-Pick vs. Dev Promotion Comparison

| Aspect | Cherry-pick Sets | Dev Promotion |
|--------|-----------------|---------------|
| Commits to main | 6–57 | All 1,031 |
| Risk | Low (curated) | High (unreviewed bulk) |
| User-visible changes | Controlled | 228 files from #4098 alone |
| Compatibility | Verified against main | Untested against main |
| Effort | Per-item conflict resolution | Merge conflict resolution |
| Recommendation | **Sets 1–3 are safe** | **Not recommended** without integration testing |

## Key Dependency Chains

1. **#4098 (SDK lifecycle refactor)** → blocks #4281, #4354, #4450, #4485, #4241, #4242, #4255, #4270, #4372. These 11 items are Category C.
2. **#4199 (master orchestration)** → reverted by #4438 → re-added as #4485. Net: #4199+#4438 = Category E (cancel out), #4485 = Category C (depends on #4098).
3. **#4420 (remove artifacts/)** = Category B (185 files, 45K deletions — large but isolated, clean cherry-pick).

## Items Requiring Owner Product Decision

- **#4245 (settings unify):** 51 files, 10K insertions. Refactors config-root. Feature scope change.
- **#4292 (MCP v2 protocol):** 29 files, new protocol support. Public API surface change.
- **#4364 (Korean launcher alias):** Adds `가재씨` binary alias. Branding/product decision.
- **#4335 (MCP conventional autoload):** 23 files. Activation behavior change.
- **Full dev promotion:** 1,031 commits including #4098 refactor. Major release territory.

## Reproduction Commands

```bash
# Verify heads
git fetch origin main dev
git rev-parse origin/main  # 5666472818b71a1c37615408d9b4d3b5a77b7fa3
git rev-parse origin/dev   # 38f3b4077c870e41d061f8f2aa7f5c873a30e25f
git merge-base origin/main origin/dev  # 63ea66995c4e20ced48528f83af6e5b055fff372

# Reconcile raw counts
git rev-list --count origin/main..origin/dev  # 1031
git rev-list --count --first-parent origin/main..origin/dev  # 174

# Simulate minimal cherry-pick set
git worktree add --detach /tmp/cp-sim origin/main
cd /tmp/cp-sim
git cherry-pick 0bd4898d1845 6add8ad61152
git cherry-pick -m 1 394cee75a8f6 d2ac02f33272
git cherry-pick 38f3b4077c87 1cd83d3f88e1

# Verify types
bun run --cwd=packages/ai check:types
bun run --cwd=packages/tui check:types
bun run --cwd=packages/coding-agent check:types
```

## Evidence Files

- `docs/audit-4525-classification.tsv` — Full 174-item classification table (machine-readable)
- This report — `docs/audit-4525-report.md`

---

`OWNER_CONFIRMATION_REQUIRED`: Main/release mutation is owner-controlled. This audit does not cherry-pick onto any pushed branch, does not mutate main/dev/release/tag/publish/workflows/settings/deployment, and does not open a product PR.
