# Workflow recovery and risk-proportional validation (#4560)

Long `ralplan -> ultragoal` runs can compact mid-flight. Before #4560, compaction preserved only a thin best-effort projection (active goal objective/status, workflow phase, open todos) plus a generic continuation prompt, material intent was reconciled only after expensive consensus, and boundary validation applied the full review cohort unconditionally. This document describes the three mechanisms #4560 adds: **pre-consensus material-intent reconciliation**, a **structured workflow recovery projection** consumed by compaction, and a **deterministic validation-applicability policy** for Ultragoal boundary lanes.

## Pre-consensus material-intent reconciliation

Ralplan now persists an `intent` stage after the Planner artifact and before Architect/Critic review. The leader cross-checks the draft against current user constraints, relevant deep-interview specs, prior plans, and explicit non-goals. Only material decisions that can change objective, scope, acceptance criteria, architecture, or verification trigger an `ask`; a plan with no material open items proceeds without empty interview ceremony. Any material correction is incorporated into a persisted Planner `revision` before review, and the review lanes receive both the reconciled plan receipt and the `intent` receipt. The existing post-consensus interview remains as a delta gate for assumptions first introduced or exposed by review, rather than re-asking already settled decisions.

## Structured workflow recovery projection

`packages/coding-agent/src/gjc-runtime/workflow-recovery-projection.ts` derives a bounded projection from canonical durable state through read-only filesystem access:

- **Ralplan**: durable mode state selects the active run. During consensus, the latest confined `planner`/`revision` artifact supplies objective/scope/non-goals/acceptance criteria and the exact next action (`run-plan-review`, `revise-plan`, or `reconcile-intent`); after finalization the `final` artifact yields `awaiting-approval`. Legacy discovery orders runs by `index.jsonl` freshness and skips unfinished/malformed candidates. Artifact paths are realpath-confined to the run directory and their recorded SHA-256 must match the bytes read.
- **Ultragoal**: `goals.json` + `ledger.jsonl` produce the aggregate objective, per-goal accepted scope, completed-goal acceptance evidence, the current goal (active/failed or first schedulable), measurable progress counters (total/completed/outstanding goals, latest joined cohort generation + frozen `sourceHash`, newest ledger event id), and the exact next action class (`continue-current-goal`, `start-next-goal`, `resolve-review-blockers`, `final-aggregate-checkpoint`, ...).

Safety properties:

- **Safe degradation** — malformed, stale, unreadable, or tampered durable state yields `undefined` and compaction falls back to the previous thin projection; projection failures never abort compaction.
- **Read-only** — the projection never mutates `.gjc/` state.

### Compaction consumption

`AgentSession`'s compaction state snapshot attaches the projection whenever an active recognized workflow (`ultragoal` first, then `ralplan`) owns the session:

- `#compactionStateContext` renders bounded `<compaction-state>` lines: workflow contract, accepted scope, non-goals, acceptance criteria, current goal, progress (including frozen `sourceHash`), next action, and contract digest. These flow into the compaction summary through the existing state-aware context path.
- The post-compaction auto-continue prompt for active recognized workflows replaces the generic `auto-continue.md` text with a `<workflow-recovery>` block plus rules: reload the durable contract before acting, latest-user-intent supremacy, **no silent scope expansion** (work beyond accepted scope must be classified as new scope and recorded durably), no duplicate already-verified review generations when the recorded source hash and evidence basis are unchanged, and bounded zero-progress escalation.
- Inertness is preserved: paused goals, manifest-terminal phases, and unknown skills never receive the structured continuation (the generic prompt and existing skip logic stay authoritative).

### Bounded zero-progress cycles

Each compaction attempt fingerprints the projection's contract-relevant fields (`hashWorkflowRecoveryProjection`). Snapshot reads performed by authorization and prompt assembly reuse the same counter state and do not increment it. `trackWorkflowRecoveryZeroProgress` counts consecutive attempts with an unchanged fingerprint; at `ZERO_PROGRESS_STALL_THRESHOLD` (2) the third unchanged recovery attempt carries an explicit `STALLED` directive ordering a durable blocker/escalation instead of repeating the same next action. An attempt that aborts after its tracked snapshot still consumes one observation; any measurable durable progress (completed obligations, changed blocker disposition, changed source hash, goal status change) resets the counter. This bounds — but does not claim to eliminate — post-compaction continuation loops.

## Ultragoal validation-applicability policy

`packages/coding-agent/src/gjc-runtime/ultragoal-validation-policy.ts` selects expensive boundary lanes deterministically from durable facts. Selection is runtime-authoritative and inspectable; free-form model prose can never grant a reduction.

Low-risk eligibility (the only case where redundant lanes may be omitted) requires **all** of:

- a trusted, completely captured change set with a runtime-computed source-basis digest,
- exactly one outstanding goal,
- no open review blockers,
- no high-risk path (workflow enforcement itself, auth/security, native crates, SDK/extensibility public contract, agent-wire protocol, shared behavior registries), migration path, or computer-control-surface path.

Everything else — including a missing or untrusted change set — is high risk and keeps the full heavyweight cohort (`cleaner || architect || qa`, join-before-repair, terminal critic).

Omission mechanics:

- The **QA lane can never be omitted**. Targeted verification and real-surface evidence stay mandatory at every boundary.
- A leader presenting a reduced cohort must carry a top-level `validationLaneSelection` proof (`riskClass`, `reasons`, `omittedLanes`) that exactly mirrors the runtime-computed selection. Mismatches fail closed with typed diagnostics (`reduction_not_applicable`, `selection_mismatch`, `reasons_mismatch`, `omitted_lanes_mismatch`, `qa_lane_mandatory`, `selection_invalid`, `source_hash_mismatch`) and the full cohort requirement stays in force.
- The **terminal critic** is proportional: `criticReview.verdict: OKAY` remains mandatory for final aggregates except when the run is single-goal, low-risk, blocker-free, **and** the immutable source basis is unchanged (`basisUnchanged`), in which case the already-joined cohort evidence satisfies the terminus without a duplicate critic read pass.

### Unchanged-basis rerun avoidance

Run `gjc ultragoal quality-gate source-hash --json` on the clean frozen snapshot to obtain the only accepted cohort hash. `basisUnchanged` is true only when the newest ledger-recorded joined cohort source hash and the gate's current cohort hash both equal that runtime-computed digest, and no review blockers reopened. The digest binds integration base, merge base, normalized path/status rows, captured diff, and the identity/content of untracked files without following symlink targets. CI changed-path metadata participates only when the inspected Git root equals its authoritative `GITHUB_WORKSPACE`; an independent nested/temp repository cannot inherit unrelated outer-workspace paths. A changed source, a review fix, an integration-base change, incompletely captured content, or invalidated evidence forces a full rerun exactly as before; cohort parallelism and the frozen-source-hash lane binding are untouched whenever lanes run.

## Comparative and forced-compaction evidence

The regression matrix is deterministic evidence, not a claim of identical model outputs:

| Scenario | Baseline risk | Candidate assertion |
|---|---|---|
| Low-risk single-goal boundary | Unconditional cleaner + architect + terminal critic duplicated already-joined evidence | Runtime-authenticated lane selection may omit cleaner/architect; QA and source binding remain mandatory; critic omission additionally requires the unchanged authoritative digest |
| Multi-goal, workflow-enforcement, auth, migration, SDK/public-contract, native, computer/shared-registry, incomplete capture | A reduction could hide defects | Classified high-risk and retains the complete cohort plus terminal critic |
| Forced compaction during Ralplan review | Generic prose could lose the reviewed plan and next review action | Active run, confined plan artifact, digest, accepted/non-goal scope, and `run-plan-review`/`revise-plan`/`reconcile-intent` are restored |
| Forced compaction during Ultragoal execution and parallel executor work | Current goal and completed work could be reconstructed from stale conversation memory | Canonical goals/ledger restore current goal, completion counters, joined cohort generation/hash, and the next bounded action |
| Forced compaction during boundary review or blocker-fix re-review | Duplicate generations or scope drift | Joined cohort evidence and `resolve-review-blockers` survive compaction; zero-progress escalation counts actual compactions only |

The focused suites covering this matrix are `workflow-recovery-projection.test.ts`, `agent-session-workflow-recovery-continuation.test.ts`, and `ultragoal-validation-lanes.test.ts`. Broader compaction, Ralplan runtime, Ultragoal runtime/review/critic, type, and visible-definition gates remain the merge boundary.

## Guarantees preserved

- `sourceHash` frozen-snapshot binding, receipts, provenance, immutable cohort snapshots, join-before-repair, validation batches, and high-risk QA/live-surface evidence requirements are unchanged.
- Executor parallelism and `cleaner || architect || qa` cohort parallelism are unchanged (the policy only decides *whether* a lane applies, never how lanes that do apply are scheduled).
- Review-blocker recursion caps and terminal-critic ceilings are unchanged.
