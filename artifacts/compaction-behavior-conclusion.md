# Conclusion: Compaction Frequency Behavior Is Correct — Documented (G003)

Generated: 2026-07-17. This is the G003 deliverable, taking the approved
spec's explicitly-permitted "increased compaction is correct behavior,
documented — no code change" outcome. Evidence chain:
artifacts/compaction-mining-v2.json (228-record forensic evidence base,
architect-approved) → artifacts/compaction-frequency-analysis-v2.md →
artifacts/compaction-root-cause-report.md (rev 3, architect-approved,
red-team-hardened via artifacts/g002-root-cause-qa-report.json).

## Why no code change is required

1. **There is no frequency regression.** Normalized compaction frequency is
   0.05–0.06 per 100 assistant turns in July — at or below every June week
   except the 2026-06-01 spike (0.22). The perceived increase is a
   raw-count effect of ~2.8–5.7× session-volume growth.

2. **The "under-count → correction" story holds, in two parts:**
   - **Thresholds:** #1021 (05f0b589, 2026-06-23) deliberately stopped
     reserving `maxOutputTokens` in the auto-compaction path, moving
     400k-window thresholds from 272k to 340k. Compaction now happens
     *later*, with more usable context — the opposite of a regression.
   - **Estimation:** the pre-#2067 heuristic UNDER-counted CJK text 2–4×
     and pre-SSOT estimates drifted from provider truth. Those under-counts
     caused provider overflows (reactive compactions paired with visible
     errors), not premature compactions. #2067 (663828fe) and the
     provider-usage SSOT (96f48793/b47e8d28) corrected the counting; #2213
     (2ff0daa3, 2026-07-15) added mid-run checks with a 1.2× safety
     inflation. Measured effect: **zero reactive compactions from
     2026-07-15 onward** in the mined data.

3. **The only genuine defect found (mid-turn check gap) is already fixed
   and already regression-tested.** #2213 shipped with
   `packages/coding-agent/test/agent-session-midrun-compaction.test.ts`
   (18 tests) and `agent-session-midrun-maintenance.test.ts`, which lock in
   the corrected trigger behavior — the regression-test obligation of this
   story is satisfied by the existing merged suite, re-verified below.

## Verification (current state)

- `bun test packages/coding-agent/test/compaction.test.ts
  agent-session-context-usage-ssot.test.ts context-usage-ssot-redteam.test.ts
  agent-session-midrun-compaction.test.ts agent-session-midrun-maintenance.test.ts`
  → **92 pass, 0 fail** (2 skip). Note: during this audit, two
  compaction.test.ts tests intermittently failed because Bun resolved the
  `@gajae-code/agent-core/compaction/compaction` workspace alias to the PARENT
  checkout (~/Documents/Workspace/gajae-code) instead of this worktree,
  running an older implementation. Fixed with a one-line worktree-relative
  import in the test file (the only tracked-file change of this audit).
- Post-fix measurement: mined evidence shows estimated-vs-provider anchoring
  is SSOT-based (estimates anchor on `calculateContextTokens` of provider
  usage) and no premature-trigger cluster exists (16/228 premature records,
  spanning five weeks, several being expected overflow-recovery keep-window
  corrections).

## One evidence-backed recommendation (user config, not repo code)

The user's `~/.gjc/agent/models.yml` declares `contextWindow: 400000` for the
layofflabs gpt-5.x family, but the provider's observed rejection region is a
band at ~362k–372k (47/49 July reactive records; one tolerated overshoot at
428k proves enforcement is variable). The post-#1021 threshold (340k) leaves
only ~20–30k margin to that band; #2213's inflated mid-run estimator guards
it, but a single dense turn can still race it.

**Recommendation:** in `~/.gjc/agent/models.yml`, set
`contextWindow: 380000` for the `layofflabs` gpt-5.x entries actually used
(gpt-5.5, gpt-5.6-sol/-terra/-luna). Effect: default threshold becomes
380,000 − max(floor(0.15·380,000), 16,384) = 323,000, widening the margin to
the observed rejection band from ~20–30k to ~40–50k with a ~5% usable-context
cost. This is user configuration; it is intentionally NOT applied by this
audit (live sessions read the file, and the choice trades context for
safety), but the evidence above fully supports it if the user prefers zero
overflow-error noise over maximum context depth.

## Spec acceptance mapping

| Acceptance criterion | Status |
|---|---|
| Session-history mining artifact (frequency + tokens-at-trigger, genuine vs false, versions) | Done — compaction-mining-v2.json + analysis-v2.md (G004) |
| Root cause named with evidence, or documented correct-behavior conclusion | Done — root-cause-report rev 3 (G002): mechanisms with commits + measured effects |
| If fixing: regression test | N/A (no-change branch selected). Supplemental assurance: the pre-existing merged #2213 suites (midrun-compaction 18 tests, midrun-maintenance 13 tests) lock the corrected trigger behavior; re-verified in the 92-pass run |
| If fixing: post-fix measurement (delta bound, no premature triggers) | N/A (no-change branch selected). Supplemental assurance: zero reactive compactions post-07-15 in mined data; premature class 16/228 spanning five weeks with no cluster |
| If no-change: written explanation with under-count → correction evidence | This document |
