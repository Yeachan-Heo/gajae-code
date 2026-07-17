# Ultragoal Pipeline & Validation-Batch Contracts Fragment

Internal Ultragoal sub-skill fragment (`kind: "skill-fragment"`, parent skill `ultragoal`, installed at `skill-fragments/ultragoal/pipeline-validation-contracts.md`). The Ultragoal leader loads it on demand before operating a pipeline overlap or checkpointing a validation-batch member; it is never user-facing, not slash-command discoverable, and never resolvable through `skill://`. The runtime enforces every rule below verbatim and fails closed.

## Runtime-backed pipeline overlap lifecycle

Use the lifecycle commands exactly when runtime metadata proves safety:

```sh
gjc ultragoal start-pipeline-overlap --prior-goal-id G001 --next-goal-id G002 --review-handles-json '<json>' --qa-handles-json '<json>' --implementation-handle-json '<json>' --json
gjc ultragoal join-pipeline-overlap --overlap-id <id> --review-result-json '<json>' --qa-result-json '<json>' --json
gjc ultragoal rebaseline-pipeline-overlap --overlap-id <id> --goal-id G002 --evidence "<evidence>" --target-state-json '<json>' --json
```

Runtime-backed pipelining is deliberately narrow:

- At most one eligible next goal may overlap the current goal's review/QA join window.
- G(N) remains active until `join-pipeline-overlap` records a clean join; do not checkpoint G(N) complete before clean join evidence exists.
- `start-pipeline-overlap` must fail closed for missing metadata, one-sided independence, shared target files/surfaces, stale metadata hashes, missing handles, another open overlap, or per-story mode.
- `join-pipeline-overlap` must fail closed for missing lane evidence or unresolved blockers. Continue G(N+1) only when structured blocker footprints are disjoint from G(N+1) targets; otherwise quarantine and re-baseline with `rebaseline-pipeline-overlap` before G(N+1) can complete.
- Complete checkpoints must fail closed for open overlaps, missing clean joins, stale metadata, quarantined next goals, shared or unattributable change-set paths, and any missing pipeline evidence.
- After a crash or lost live handles, the leader reruns review/QA lanes and joins with replacement evidence when metadata hashes still match; otherwise quarantine and re-baseline. Ultragoal must not auto-start G(N+2) during recovery.

## Validation-batch checkpoint contract

- **Non-final members** checkpoint `complete` with a single top-level `deferredToBatch` quality gate (kind `validation-batch-deferred`): targeted verification, ai-slop-cleaner pass, and a rerun iteration, plus a cumulative-since-base change set. A `deferredToBatch` gate must NOT contain `architectReview`, `executorQa`, or `validationBatchClose` — deferring never manufactures fake review approvals.
- **The final member** (`finalGoalId`) checkpoints `complete` with the normal full strict gate PLUS a top-level `validationBatchClose` proof that covers all member IDs, member metadata hashes, member receipt/checkpoint-ledger-event IDs, per-member change-set hashes, and union change-set coverage. The final close only starts once every non-final member is already `complete` with a structurally fresh deferred receipt (out-of-order close is rejected).
- Close state is append-only proof: it lives in the final member's checkpoint receipt and matching `goal_checkpointed` ledger row only. Never stamp `closedReceiptId`/`closedAt` or any close-state field onto member goals, and never append a separate close ledger event.
- Change sets are cumulative-since-base: each member's `changeSet.paths` is the whole-worktree diff vs base (`cumulativeFromBase: true`), `memberGoalId` is a label not a per-path attribution, and `unionChangeSet.paths` carries no per-goal attribution.
- Batch invalidation is fail-closed: steering mutations that would invalidate a batch are rejected while any member holds a fresh deferred receipt.
