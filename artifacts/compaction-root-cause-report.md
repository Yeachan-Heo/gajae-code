# Root-Cause Report: Perceived Frequent Compaction (G002) — rev 3

Generated: 2026-07-17 (rev 3: rev 2 red-team corrections plus architect COMMENT wording fixes; QA at artifacts/g002-root-cause-qa-report.json).
Evidence base: artifacts/compaction-mining-v2.json (228 compaction evidence
records, event-time bucketed, threshold-relative, integrity-verified) and repo
commit history. Analysis: artifacts/compaction-frequency-analysis-v2.md.

## Verdict

**No frequency regression exists in normalized terms, and no defect in
tool-output limits (suspect 1) or token estimation (suspect 2) causes
premature compaction today.** The perceived increase decomposes into three
real, dated mechanisms — two are corrections that exposed previously-hidden
behavior, and one was a genuine structural gap that is already fixed:

## Mechanism 1 — Session volume grew ~2.8–5.7× (perception amplifier)

Weekly normalized rate is flat-to-down: 0.05–0.06 compactions/100 assistant
turns in July vs 0.03–0.22 across June. Week 2026-07-06 had 3,053 distinct
sessions / 101,685 turns vs 536–1,092 sessions across June weeks — roughly a
4× increase against a typical June week. At a constant per-turn rate, that
volume growth proportionally multiplies visible compaction summaries.

## Mechanism 2 — #1021 raised effective thresholds on 2026-06-23 (deliberate)

Commit 05f0b589 ("Fix auto compaction output reserve", #1021) changed the
auto-compaction call path to pass a zero output reserve into `shouldCompact`
(the `effectiveReserveTokens` helper itself still honors a nonzero
maxOutputTokens when callers pass one). Previously the call sites passed
`model.maxTokens`, making the reserve `max(15%·window, 16384, maxOutputTokens)`;
afterwards it is `max(15%·window, 16384)` — maxTokens is a capability ceiling,
not a per-turn reservation. On the user's 400k-window layofflabs models
(maxTokens=128k)
this moved the proactive trigger from 272,000 to 340,000 tokens. Evidence:
June triggers cluster at 255k–271k (pre-#1021 threshold-expected), July
triggers at 340k+ (post-#1021 threshold-expected). The v1 report's "272k
provider limit" reading was wrong — 272k was the old runtime threshold.
Effect: compaction happens LATER, not more often. Correct behavior.

## Mechanism 3 — Threshold-to-ceiling headroom races (structural; fixed by #2213)

Reactive compactions (provider rejects with a context-overflow error first;
compaction runs as recovery, pairing every compaction with a visible error)
occur whenever the proactive threshold sits close to the provider's effective
rejection region and no mid-turn check exists. The data shows **two** such
clusters, one per threshold regime:

- **June cluster (week 2026-06-15: 16 reactive / 4 proactive).** 15 of 16 are
  `layofflabs/gpt-5.5` with last valid provider usage 260k–271k, just under
  the pre-#1021 272k threshold (5 rows have tokensBefore=0/unknown-usage).
  The verified facts are the reactive classification (overflow-error
  predecessors) and the usage band; that the rejected prompt itself landed
  near the threshold is an evidence-backed inference — the rejected prompt
  size is not directly recorded. Under that inference, this is the same
  turn-boundary race in the earlier regime.
- **July cluster (week 2026-07-06: 49 reactive / 17 proactive; daily reactive
  3, 13, 12, 18, 8, 2 across 07-09..07-14, then 0).** Concentrated on
  `layofflabs/gpt-5.6-sol`. Last-valid-usage at rejection: 47 of 49 records
  fall in 292k–372k (dense band 362k–371.6k); one outlier at 428,628 (above
  the configured 400k window — proof the provider tolerates variable
  overshoot before rejecting, i.e. the rejection region is a band, not a
  fixed ceiling). With the post-#1021 threshold at 340k, headroom to the
  observed rejection band was ~20–30k — a single long tool-heavy turn crossed
  it mid-turn, where (pre-#2213) no maintenance check existed.

The common structural cause: **turn-boundary-only compaction checks + a
threshold within one turn's growth of the provider's rejection region.** The
regime change (#1021) moved which model/threshold pair was exposed, but the
gap existed in both regimes.

Fix: commit 2ff0daa3 (#2213, "cooperative mid-run context maintenance",
merged 2026-07-15) adds mid-turn `shouldCompact` checks using
provider-anchored usage plus a 1.2×-inflated unsent-delta heuristic.
Measured effect: reactive compactions are **zero from 2026-07-15 onward** in
the mined data (proactive-only: 1 on 07-15, 3 on 07-16, 1 on 07-17).

Supporting fixes in the same window (contributing, not causal):
- 663828fe (#2067, 07-12): CJK-aware token heuristic — pre-fix, CJK-heavy
  unsent context was undercounted 2–4×, holding estimates below threshold
  while the real prompt overflowed.
- 96f48793 / b47e8d28 (#2040, 07-11/12): provider-usage SSOT — estimates now
  anchor on provider-reported totals instead of drifting heuristics.

## Suspect disposition

| Suspect | Verdict | Evidence |
|---------|---------|----------|
| 1. Tool-output sanitization/truncation limits | **Exonerated** | DEFAULT_MAX_BYTES (50KB) unchanged; F19/F20 (6aad24b3) and F21 (a0b2ecf3) landed 06-16 with no tokens-at-trigger shift; per-turn frequency flat |
| 2a. Estimation | **Exonerated as a premature-trigger cause; it was UNDER-estimating, now fixed** | #2067 fixed CJK undercounting; SSOT anchors on provider usage; premature class = 16/228 with no temporal cluster |
| 2b. Trigger policy | **Root cause of both reactive clusters; already fixed** | Turn-boundary-only checks + thin threshold-to-rejection headroom in both regimes (272k/gpt-5.5 June; 340k/gpt-5.6 July); #2213 (07-15) adds mid-run checks; reactive count is zero after |
| 3. Composed prompt size | **Not investigated (sequential gate)** | Suspects 1+2 fully explain the observations; gate condition not met |

## Residual finding for G003

The configured `contextWindow: 400000` for the layofflabs gpt-5.x family
exceeds the provider's observed rejection region (dense band ~362k–371.6k in
47/49 July reactive records; one tolerated overshoot to 428k shows the
enforcement is band-like/variable, which makes planning against 400k even
less safe). The 340k threshold leaves ~20–30k margin to the dense rejection
band — post-#2213 the mid-run inflated estimator guards this, but a dense
turn (large tool results, CJK) still races it. G003 options: (a) retune the
configured window toward the observed dense band (evidence-backed retuning is
explicitly allowed), or (b) document as accepted behavior given #2213's
mid-run guard. Recommendation: (a), conservatively (e.g. 380k), which pulls
the default threshold to ~323k and widens the margin.

## Conclusion type

Per the approved spec, this is substantially a **"correct behavior,
documented"** outcome for the frequency claim (no regression; deliberate
threshold change plus volume growth), with one already-merged fix (#2213)
closing the genuine mid-turn race that produced both reactive clusters, and
one small evidence-backed retune opportunity handed to G003.
