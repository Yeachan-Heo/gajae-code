# Compaction Frequency Analysis v2 (G001/G004 corrected methodology)

Generated: 2026-07-17. Derived solely from artifacts/compaction-mining-v2.json
(miner: scripts/mine-compaction-history.ts; provenance and methodology fields
inside the JSON are authoritative). Supersedes
compaction-frequency-analysis-2026-07-17.md, whose session-start-week
bucketing, static 60/75% fullness bands, and tokensBefore=0 narrative were
rejected by architect review.

## Methodology (from JSON)

- Event bucketing: every assistant turn and compaction bucketed by its own UTC
  timestamp; --since applied per event.
- Reactive = consecutive error/aborted assistant predecessors immediately
  before the compaction contain a context-overflow pattern (incl.
  `context_too_large`, "exceeds the context window", "exceeds the available
  context size", "prompt is too long"). Non-context errors (e.g.
  `invalid_prompt: Request blocked`) do NOT count.
- Trigger fullness is threshold-relative using production semantics
  (`resolveThresholdTokens` / `effectiveReserveTokens`, strict `>` trigger,
  floored 15% reserve): pre-#1021 (before 2026-06-23) the reserve included
  maxOutputTokens=128k → threshold 272,000 on 400k windows; post-#1021 the
  reserve excludes it → threshold 340,000.
- tokensBefore=0 → unknown-usage (runtime `getLastAssistantUsage` skips error
  turns; no walkback claim is made).
- Model windows: exact provider/model keys from ~/.gjc/agent/models.yml
  (2026-07-16); 1 genuinely unknown key (glm-zcode/glm-5.2 ×1).
- Integrity: 8,298 files scanned, 0 failed, 894,815 lines parsed, 0 rejected,
  0 invalid timestamps. Median = nearest-rank lower-of-two.

## Weekly frequency (event-week, per 100 assistant turns)

| week       | turns   | compactions | per100 | reactive | proactive |
|------------|--------:|------------:|-------:|---------:|----------:|
| 2026-05-25 |   5,765 |           6 |  0.10  |        1 |         5 |
| 2026-06-01 |  33,059 |          72 |  0.22  |       19 |        53 |
| 2026-06-08 |  25,746 |           7 |  0.03  |        3 |         4 |
| 2026-06-15 |  24,123 |          20 |  0.08  |       16 |         4 |
| 2026-06-22 |  20,490 |           7 |  0.03  |        2 |         5 |
| 2026-06-29 |  46,680 |          30 |  0.06  |        7 |        23 |
| 2026-07-06 | 101,685 |          66 |  0.06  |       49 |        17 |
| 2026-07-13 |  38,780 |          20 |  0.05  |       10 |        10 |

Finding 1 — no normalized frequency regression: July rates (0.05–0.06/100
turns) are at or below the June average and far below the 2026-06-01 peak
(0.22). The perceived increase tracks session volume (3,050 sessions in week
2026-07-06 vs ~600–800 in June weeks): more sessions → more visible compaction
summaries at a flat per-turn rate.

Finding 2 — July mode shift to reactive: week 2026-07-06 is 49 reactive vs 17
proactive. Daily onset (from dailyAggregates): reactive counts 3 (07-09), 13
(07-10), 12 (07-11), 18 (07-12), 8 (07-13), 2 (07-14), then 0 on 07-15/16/17.
These compactions ran as recovery AFTER the provider rejected with a context
overflow — each one paired with a visible error, which plausibly amplified the
perceived "frequent compaction".

## Trigger fullness vs runtime thresholds (228 compactions)

| class          | count | meaning |
|----------------|------:|---------|
| expected       |   116 | tokensBefore > applicable threshold (normal trigger) |
| between        |    73 | within 90%–100% of threshold |
| premature      |    16 | below 90% of threshold |
| unknown-usage  |    22 | tokensBefore=0 (no valid usage anchor recorded; cause not claimed) |
| unknown-window |     1 | glm-zcode/glm-5.2 |

Finding 3 — June ~272k triggers were the correct pre-#1021 threshold, not a
provider limit: before 2026-06-23 the auto-compaction reserve included
maxOutputTokens (128k), so 400k-window models compacted above 272,000. Commit
05f0b589 (#1021, 2026-06-23) set the reserve's maxOutput component to 0,
moving the threshold to 340,000. This is the deliberate change that lets
context run ~68k tokens deeper before proactive compaction.

Finding 4 — the July 9–14 reactive cluster on layofflabs/gpt-5.6-sol: provider
usage shows hard rejections at ~362k–371k while the configured window is
400,000 and the post-#1021 threshold is 340,000. Estimated context crossed
340k only shortly before the provider's effective input ceiling, and
turn-end/pre-prompt checks anchored on stale usage lagged, so the provider
error frequently arrived first (reactive). Mid-run cooperative maintenance
(#2213, merged 2026-07-15) adds mid-turn threshold checks with a 1.2×-inflated
unsent-delta estimate; in this dataset reactive compactions drop to zero from
2026-07-15 onward (proactive-only: 1 on 07-15, 3 on 07-16, 1 on 07-17).

Finding 5 — premature (16) and unknown-usage (22) rows are a small minority
with mixed models and no temporal cluster; several premature rows are
overflow-recovery compactions whose corrected keep-window shrank the estimate
(expected behavior for recovery), and the 2026-07-16 50,560-token row follows
`invalid_prompt: Request blocked` errors (the #2282/#2314 poisoned-history
path), not a threshold bug.

## G002 direction (root-cause inputs)

- Suspect 1 (tool-output limits): no signal — tokens-at-trigger did not shift
  down and per-turn frequency is flat.
- Suspect 2 (estimation/trigger policy): two real mechanisms:
  (a) #1021 deliberately raised effective thresholds (272k→340k on 400k
  windows) — later compaction, not more;
  (b) between #1021 and #2213, gpt-5.6-family sessions regularly hit the
  provider's ~370k effective input ceiling before the 340k-threshold check ran
  at a turn boundary, producing error-then-compact (reactive) recovery. #2213
  closes this gap; post-07-15 data shows no reactive compactions.
- The 400k configured window vs ~370k observed provider ceiling mismatch
  remains the residual question for G002/G003 (retune window/threshold, or
  document as provider-side behavior).
