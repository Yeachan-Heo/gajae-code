# Resume Session Memory Test Oracle Repair

**Goal:** Update two stale resume assertions so they verify the current `SessionManager.open` contract, including session memory mode.
**Saved:** `/private/tmp/gjc-resume-session-memory-oracle-20260809/.plans/2026-08-09-resume-session-memory-oracle.md`
**Status:** Active; approved for implementation.

## Context inspected

- Current base is `origin/dev@3793db0f7a27dd8f80889980feb50498dda63691`.
- Dev CI run `31302619126` fails only two assertions in `packages/coding-agent/test/resume-confirm-continue.test.ts`.
- Upstream commit `95c00d09e7` added `sessionMemoryMode` as the fifth argument to direct-path `SessionManager.open` calls.
- The two assertions still expect the prior four-argument call.
- `packages/coding-agent/src/main.ts` already passes the current setting value. No production repair is required.

## Non-goals

- Do not change production code.
- Do not change session behavior or public contracts.
- Do not change PR #4080 feature code.
- Do not add dependencies, native builds, unrelated tests, workflow files, or generated files.
- Do not edit this approved plan during implementation.

## Recommendation

Set the test settings fixture to return explicit values by key. Assert that each direct-resume call passes the selected session memory mode as its fifth argument. Preserve all existing destination and migration assertions.

## Global verification

- Run the focused test file and require all tests to pass.
- Run the coding-agent package check and require Biome and TypeScript to pass.
- Run `git diff --check`.
- Review the final diff for test-only scope.
- Push the branch and open an unmerged PR against `dev`.
- Monitor current-head CI and review threads.

## Risks and approval gates

- Stop if production code must change.
- Stop if current `dev` moves incompatibly before push.
- Stop if the focused test remains red after the one minimal repair.
- Stop if review requests work outside the stale test oracle.
- Do not merge any PR.

## Routing

- `reasoning_mode`: `procedural`
- `execution_topology`: `direct`
- `gjc_profile`: `procedural`
- `gjc_workflow`: `direct`
- `capability_evidence`: The cause and intended contract are proven by current source, Git blame, and exact CI failures. One test file requires a mechanical expectation update.
- `topology_evidence`: One writer can change and prove one coherent test-only outcome in one isolated worktree.
- `escalation_triggers`: Production changes, unresolved behavior choices, incompatible upstream movement, or focused-test failure after the minimal update.

## Plan

### Task 1: Update the stale resume assertions

**Objective:** Make the existing resume tests validate session memory mode propagation without weakening destination or migration checks.

**Files:**
- Modify: `packages/coding-agent/test/resume-confirm-continue.test.ts`

**Steps:**
1. Keep the current failing CI output as the RED receipt.
2. Make the settings fixture return explicit migration and session-memory values by key.
3. Add the expected fifth argument to all three affected call assertions.
4. Run the focused test file and require success.
5. Run package checks and `git diff --check`.
6. Commit one atomic test repair.

### Task 2: Review and publish the isolated repair

**Objective:** Prove the branch contains only the approved test correction and publish an unmerged PR.

**Steps:**
1. Review the final diff against this plan.
2. Run an adversarial review of the current branch.
3. Repair only verified findings already decided by this plan.
4. Push to `grantjayy/gajae-code`.
5. Open a PR against upstream `dev` with exact verification receipts.
6. Monitor current-head CI and review threads.
7. If the upstream repair lands, refresh #4080 and monitor its current-head checks.

## Execution handoff

Use canonical Hermes `gjc_run` with `profile=procedural`, `workflow=direct`, and the assigned worktree. GJC must not edit this plan. Hermes independently verifies Git state, tests, checks, PR metadata, CI, and review threads. The PR remains unmerged.
