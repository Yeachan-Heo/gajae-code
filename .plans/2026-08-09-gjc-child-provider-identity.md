# GJC Parallel Child Provider Identity Fix

**Goal:** Prevent parallel GJC task children from contending for one Pooler websocket owner by assigning each child a unique, stable provider-facing continuity identity through the real managed persistence path.
**Saved:** `/private/tmp/gjc-child-provider-identity-20260809/.plans/2026-08-09-gjc-child-provider-identity.md`
**Status:** Active approved implementation plan; immutable during execution.

## Context inspected
- Production Pooler telemetry recorded 415 `owner_busy` bridge fallbacks in one hour while GJC websocket share fell to about 48%.
- Two hot parent sessions produced 15 parallel child JSONL artifacts whose headers reused their respective parent UUIDs.
- `packages/coding-agent/src/sdk/session.ts:createAgentSession` defaults provider identity to the logical `SessionManager` ID.
- `packages/coding-agent/src/task/executor.ts:ManagedTaskPersistence.openSession` uses `SessionManager.openNestedManaged` for production child persistence.
- Commit `b621997ee` removed fork-seed identity inheritance but its regression used a standalone explicit child file, not the production nested managed path.
- Pooler deliberately rejects a busy websocket owner and falls back to HTTP; it exposes no bridge queue or multiplexing setting.

## Settled direction
- Give each parallel task child a distinct provider-facing identity at the task-child ownership seam.
- Keep that identity stable for the child’s serial turns and detached resume.
- Preserve existing logical session headers and parent artifact hierarchy; do not rewrite persistence semantics merely to obtain provider uniqueness.
- Prefer an existing durable child identifier already owned by task persistence/execution. Do not add a global registry, queue, Pooler option, or dependency.

## Non-goals
- No Pooler code, deployment, restart, or configuration change.
- No GJC concurrency reduction or task serialization.
- No model/provider configuration changes.
- No public API or persisted session schema change.
- No deletion or modification of `~/.gjc/agent/models.yml`.
- The separately approved removal of stale `gjc.ralplan.autoHandoff` from `~/.gjc/agent/config.yml` is an operator cleanup outside this repository diff.

## Global verification
- Capture RED through a behavioral test using `ManagedTaskPersistence`/nested managed artifacts that reproduces shared provider identity for parallel children.
- Capture GREEN proving distinct child identities and stable detached resume identity.
- Run targeted task identity/fork-context/replay suites and `bun --cwd=packages/coding-agent run check`.
- Run repository lint/format checks applicable to changed files and canonical broader checks required by project law.
- Perform adversarial review of the shared-transport concurrency boundary.
- Run one bounded live parallel GJC smoke and query Pooler receipts for distinct continuity IDs, websocket transport, zero `owner_busy`, and cache behavior. No process kill or deployment is authorized.
- Open an unmerged PR against `dev` with exact receipts.

## Verification of verification
- Trigger: this regression class escaped once because a standalone fixture did not model the production managed persistence seam.
- Silent failure mode: coverage gap/drifted oracle—the test can stay green while nested managed children still share identity.
- Cheapest effective protection: the regression itself must construct children through `ManagedTaskPersistence` and assert outbound/provider identity behavior for concurrent children plus resume. During TDD, revert or disable the production fix once and confirm this exact test goes RED. No extra framework or recursive meta-layer.

## Risks and escalation triggers
- Stop if the minimal fix requires changing persisted session compatibility, the public API, credential/auth behavior, dependencies, or Pooler runtime behavior.
- Stop if distinct identities cannot remain stable across detached resume without a new persisted schema.
- Stop before destructive commands, process termination, deployment, or config mutation beyond the separately named stale setting removal.

## Routing
- `reasoning_mode: adversarial`
- `execution_topology: direct`
- `gjc_profile: adversarial`
- `gjc_workflow: direct`
- `capability_evidence:` Shared-transport concurrency and persistence identity are subtle cross-system invariants; the same regression escaped an earlier fix and caused material cache waste.
- `topology_evidence:` One tightly coupled outcome owns the production seam, implementation, regression, resume proof, and live smoke; splitting writers would increase coordination risk without independent deliverables.
- `escalation_triggers:` persisted schema compatibility, public API, credentials/auth, dependencies, Pooler runtime/deploy, destructive operations, or inability to preserve resume identity.

## Plan

### Task 1: Reproduce the production persistence collision
**Objective:** Add a behavioral regression that creates parallel task children through the nested managed persistence path and fails because provider identities collide.
**Files:**
- Modify: `packages/coding-agent/test/task-cache-key.test.ts` or the nearest production-faithful task persistence test selected from current source.
- Inspect/possibly modify test helpers only in the same test surface.
**Steps:**
1. Build parent artifacts and child persistence using `createManagedTaskPersistence`/`ManagedTaskPersistence.openSession` as production does.
2. Create at least two parallel-equivalent children from the same parent context.
3. Assert inherited conversation content as applicable, distinct provider identities, and no parent identity reuse.
4. Run the focused test and preserve the expected RED caused by identity collision.

### Task 2: Implement the smallest stable child provider identity
**Objective:** Derive provider identity from a child-owned durable identifier while preserving logical headers and artifact hierarchy.
**Files:**
- Modify only the exact task execution/session creation files proven by the failing test, expected among `packages/coding-agent/src/task/executor.ts`, `packages/coding-agent/src/task/index.ts`, and `packages/coding-agent/src/sdk/session.ts`.
- Modify: `packages/coding-agent/CHANGELOG.md` under Unreleased.
**Steps:**
1. Trace initial child creation and detached resume through the same persistence owner.
2. Pass or derive one stable child provider identity at that seam without changing parent logical persistence.
3. Keep explicit `providerSessionId` precedence intact.
4. Run the focused regression and existing provider-identity suites to GREEN.
5. Prove the new regression goes RED against the pre-fix behavior and GREEN with the fix.

### Task 3: Verify concurrency, resume, and repository integrity
**Objective:** Close all acceptance evidence before publication.
**Files:**
- Test files only if an uncovered approved invariant needs direct coverage; no unrelated refactors.
**Steps:**
1. Run targeted task cache-key, fork-context, and Responses replay tests.
2. Run package check and applicable lint/format/canonical gates.
3. Perform adversarial review focused on uniqueness, stability, explicit override precedence, credential stickiness, cancellation, and nested managed persistence.
4. Repair only verified in-scope findings and rerun checks.
5. Run the bounded live parallel smoke; verify distinct Pooler continuity IDs, websocket attempts, zero `owner_busy` for the smoke sessions, and report cache receipts without inventing a threshold.
6. Commit atomically, push, and open an unmerged PR against `dev`.

## Execution handoff
Use one canonical `gjc_run` with `profile=adversarial`, `workflow=direct`, and this isolated worktree. The plan is immutable. Any escalation trigger stops the writer and returns evidence rather than changing scope.
