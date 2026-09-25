## Terminal critic gate

The terminal critic gate is a fail-closed, once-per-run-terminus review. It guards both terminal exits with a read-only `critic` role agent's `OKAY` verdict; it does not run per story. It is additive to, and does not change, the existing per-story `architect` review and `executor` QA/red-team lanes.

### Completion terminus

Before assembling the final-aggregate `--quality-gate-json`, the leader delegates the terminal critic. Only the final-aggregate completion checkpoint requires the additional top-level `criticReview` key; `criticReview` is tolerated but ignored on non-final checkpoints. A clean final aggregate requires `verdict: "OKAY"`, non-empty `evidence`, and an empty `blockers` array:

```json
{
  "criticReview": {
    "verdict": "OKAY",
    "evidence": "terminal critic review of the final required-goal state",
    "blockers": []
  }
}
```

### Pause/blocked terminus

At a `human_blocked` terminus, the leader first runs `gjc ultragoal classify-blocker --classification human_blocked` (capturing that classification's ledger `eventId`), then delegates the terminal critic and records its verdict with `gjc ultragoal record-critic-verdict --terminus pause --classification-event-id <eventId>` before calling `goal({"op":"pause"})`. The pause is allowed only when a later fresh `critic_verdict` ledger receipt exists with `terminus: "pause"`, `verdict: "OKAY"`, non-empty evidence, an empty blockers array, the current `planGeneration`, and a `classificationEventId` bound to the latest `blocker_classified` event, which must be `human_blocked`. Freshness is scoped to the final required-goal state, so required-goal or steer changes stale the receipt, and a newer classification supersedes an older verdict.

The critic must verify that the `human_blocked` classification is genuine, including catching false pauses where needed resources exist locally or the asserted blocker is resolvable. A `REJECT` (or `ITERATE`) verdict refuses the terminal pause; the run keeps executing. The pause (`goal({"op":"pause"})`) is the gated terminal park-and-wait exit — a per-goal `gjc ultragoal checkpoint --status blocked` remains available as non-terminal blocker bookkeeping that never signals run completion and keeps the blocker outstanding until resolved.

### Invocation and containment

At each terminus, the leader gives the read-only `critic` role agent `brief.md`, `goals.json`, `ledger.jsonl`, and the cumulative change set. For completion, invoke it before assembling the final-aggregate gate JSON. For pause, invoke it after the `human_blocked` classification and before `goal({"op":"pause"})`. The terminal critic must not spawn nested `ralplan`, `deep-interview`, or `ultragoal` workflows. This creates no interactive surface: `ask` remains blocked while an Ultragoal run is active.

On repeat terminus attempts within the same run (after an `ITERATE`/`REJECT` reopen cycle or a superseded pause classification), **resume the prior terminal-critic subagent when resumable** instead of freshly spawning one: the critic already holds `brief.md`, `goals.json`, the ledger history, and its own prior findings, so re-invocation only needs the delta (new ledger events, the updated cumulative change set, and evidence addressing the prior blockers). Resume via existing `subagent` resume/steer controls; on `context_unavailable`, `not_found`, `no_runner`, or `resume_failed` — or after a process restart — fall back to a fresh `critic` spawn with the full context bundle. A resumed terminal critic remains read-only, keeps the same containment rules, and must issue a fresh verdict against the current state — a prior `ITERATE` is never carried forward as pre-judged, and each verdict is still recorded through `gjc ultragoal record-critic-verdict`.

### Non-OKAY loop and ceiling

For completion-side `ITERATE` or `REJECT`, the leader MUST first record the terminal verdict so the run-level counter observes it: `gjc ultragoal record-critic-verdict --terminus completion --verdict <ITERATE|REJECT> --evidence "<critic findings>"`; then record the findings with `gjc ultragoal record-review-blockers` and reopen the run. The dedicated counter ceiling is 5, independently of the give-up nudge budget, and is **RUN-LEVEL**: it counts every non-OKAY terminal-critic verdict across the whole run and all reopen cycles. On reaching that ceiling, both pause and final completion are blocked until a human or leader records `gjc ultragoal record-critic-gate-override --evidence "<authorization evidence>"`. There is no automatic pause override.

This gate is always fail-closed and has no grandfathering: in-flight runs must obtain a terminal verdict when they reach a terminus.

#### Deferred / out of scope

Gating active-aggregate `goal drop` after nudge exhaustion is a known follow-up not covered by this gate; `drop` remains governed by the existing nudge discipline.
