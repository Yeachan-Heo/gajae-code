# GJC durable terminal and steer truth for Hermes issue #815

**Goal:** Give GJC one durable public contract for execution outcome, receipt availability, and retry-safe steer acknowledgement.

**Status:** Active implementation plan. No product code has been changed.

**Repository:** `/private/tmp/gjc-815-plan-20260804`
**Branch:** `plan/gjc-815-terminal-truth-20260804`
**Base:** `ded5926ad3c538a680449d61c1d31ac508499b2e` (`origin/dev`)
**Issue:** `grantjayy/hermes-agent-private#815`, upstream work in `Yeachan-Heo/gajae-code`
**Hermes consumer plan:** `/private/tmp/hermes-gjc-815-final-plan-20260804/docs/plans/2026-08-04-issue-815-native-gjc-lifecycle-repair-plan.md`

## Context and evidence

- `packages/coding-agent/src/gjc-runtime/session-state-sidecar.ts` maps most `agent_end` events to coarse `state: "completed"` even when final text is absent.
- Evidence session `9c91745c-6daa-4cbf-a29a-1f83dc765492` persisted `completed` with no receipt while its durable prompt reconciliation said `failed / prompt_deadline_exceeded`.
- `packages/coding-agent/src/sdk/bus/reconciliation-store.ts` durably stores prompt and skill execution outcome, but no receipt state.
- `settleProcessRestart()` can finalize a stopped prompt as `terminal_ok` without durable evidence that a reportable receipt exists.
- `packages/coding-agent/src/sdk/bus/index.ts::terminalizePrompt()` receives final text only after it claims the durable terminal outcome. The pending claim does not preserve receipt state.
- `packages/coding-agent/src/coordinator-mcp/server.ts` already defines reportable output as non-empty trimmed text or a non-empty artifact path. Missing output remains an advisory attached to `status: "completed"`, which still looks like ordinary success.
- `turn.steer` is an ordered control. The host dispatches only text to `surface.steer()`. No durable correlation query distinguishes accepted, rejected, or uncertain delivery after a lost response.
- Hermes commit `9a0338460f` fixed the immediate steer payload key from `prompt` to public `text`. The payload repair does not make retries idempotent or reconcile transport uncertainty.
- Focused baseline tests are green after installing dependencies and building the local native addon. The install regenerated one unrelated docs index; that generated diff is not part of this plan.

## First broken invariant

GJC publishes terminal and control facts through separate surfaces that cannot answer two safety questions after process or transport loss:

1. Did execution finish, and does a reportable receipt exist?
2. Did this logical steer take effect, and can the same message identity be retried without duplicate delivery?

## Settled architecture

Use existing GJC-owned durable files. Do not add another lifecycle ledger.

### Shared receipt contract

Create `packages/coding-agent/src/sdk/receipt-state.ts` as the single definition used by the Software Development Kit bus, runtime sidecar, and coordinator.

The module exports:

- `ReceiptState = "absent" | "present" | "missing" | "unknown"`;
- `ExecutionState = "accepted" | "in_flight" | "terminal_ok" | "failed" | "unknown"`;
- `reportableReceipt({text, artifactPath})`;
- `receiptStateForTerminal({text, artifactPath})`.

A reportable receipt requires non-empty trimmed text or a non-empty trimmed artifact path. Whitespace and null are missing.

### Durable prompt and skill settlement

Extend existing reconciliation version 1 additively:

- active records expose `receiptState: "absent"`;
- terminal records persist `receiptState: "present" | "missing" | "unknown"`;
- an in-progress terminal claim may persist `pendingReceiptState: "present" | "missing"` beside `pendingOutcome`;
- `claimPendingOutcome(correlation, outcome, receiptState)` atomically claims both prompt axes; `finalizePromptOutcome()` copies the pending receipt state and removes `pendingReceiptState`;
- `noteTransition(..., {type: "agent_end", finalText})` settles skill receipt state from the real last assistant text; the bus passes `lastAssistantText()` after `invokeSkill()` resolves rather than treating skill metadata as a receipt;
- process restart preserves a prompt's pending receipt state and never invents `present`; a stopped prompt with no pending receipt evidence becomes `missing`, while failed prompt or skill restart settlement without body evidence becomes `unknown`;
- a legacy terminal record without `receiptState` is accepted and projected as `unknown`, never ordinary receipt success.

Execution and receipt remain separate. A stopped prompt with no receipt is `terminal_ok + missing`, not failed. A failed prompt may have a partial present receipt.

### Runtime-state sidecar

Mirror the same axes at the top level of version-1 runtime state:

- `execution_state` uses the shared execution values;
- `receipt_state` uses the shared receipt values;
- coarse `state` remains a liveness compatibility field;
- `agent_end` with `error` or `aborted` assistant stop reason records failed execution;
- non-failing textless `agent_end` keeps coarse `state: "completed"`, but records `execution_state: "terminal_ok"`, `receipt_state: "missing"`, and stable `error.code: "receipt_missing"`;
- ordinary success requires `execution_state: "terminal_ok"`, `receipt_state: "present"`, and reportable body;
- no model-generated summary or Git-derived fallback is allowed.

Older sidecar files without the additive fields remain readable and project `unknown` rather than optimistic receipt success.

### Coordinator projection

Add `receipt_missing` to the coordinator turn status enum as a terminal, non-success status.

`markTurnTerminalFromSessionState()` consumes sidecar dual-axis fields:

- failed execution becomes `failed`;
- terminal execution with a reportable receipt becomes `completed`;
- terminal execution without a reportable receipt becomes `receipt_missing` with stable error code `receipt_missing`;
- legacy completed sidecar state without dual-axis fields is checked against its body and fails closed to `receipt_missing` when empty.

`read_turn` and `await_turn` return `execution_state` and `receipt_state` explicitly. The current advisory-only shape is removed for the dual-axis path. Existing schema version remains 1.

### Durable steer acknowledgement

Extend the existing `.sdk-reconciliation/<sessionId>.json` document with `kind: "steer"`; do not create another file.

`DurableReconciliationRecord` becomes a discriminated union. Prompt and skill records keep required `commandId`, `turnId`, `acceptedAt`, and their existing execution statuses. A steer record has exactly:

- `kind: "steer"`;
- required `clientRef`, 64-lowercase-hex `textDigest`, `createdAt`, and `status`;
- `status: "dispatching" | "accepted" | "rejected" | "uncertain"`;
- `settledAt` only for accepted, rejected, or uncertain records;
- `error` only for rejected or uncertain records;
- no `commandId`, `turnId`, body, receipt state, or prompt outcome.

`isValidRecord()` validates those kind-specific invariants. `settleProcessRestart()` maps only a steer still in `dispatching` to retained `uncertain` with `settledAt` and stable `process_restart_uncertain`; it never maps steer to `failed/process_restart` and never redispatches.

Steer records use key `steer:<clientRef>`. Settled steer records use `settledAt` as their terminal timestamp and share the existing reconciliation retention time and capacity bounds. Cleanup evicts expired or over-capacity settled steer records without changing prompt or skill cleanup. A live `dispatching` record is retained as active work and is not evicted by terminal cleanup.

Add public `turn.steer` correlation:

- input accepts optional `clientRef` for backward compatibility;
- when `clientRef` is present, a steer-specific `reserveSteer(clientRef, textDigest)` API validates and reserves one logical steer using SHA-256 over the exact validated `text` bytes;
- the durable record is written as `dispatching` before queueing;
- successful queueing changes the record to `accepted`;
- a definite pre-effect rejection changes it to `rejected` with bounded error;
- a crash or lost response while `dispatching` remains `uncertain`; restart never redispatches it;
- replay with the same `clientRef` and digest returns the stored accepted, rejected, or uncertain result without calling `surface.steer()` again;
- replay or Q30 lookup while the matching record is still `dispatching` projects `uncertain` immediately and never queues another message;
- replay with the same `clientRef` and another digest returns `client_ref_conflict`;
- steer text is never stored; only the digest and bounded metadata are durable.

Do not route steer through prompt/skill `admit()`: its existing "never reuse a clientRef" contract remains unchanged. Add `reserveSteer`, `settleSteer`, and `lookupSteer` as separate methods on `KindAwareReconciliation`. `ControlSurface.steer(text, clientRef?)`, control dispatch, and the bus `sendSteer()` use these methods. Uncorrelated steer keeps its current behavior.

Add public query Q30, `turn.steer_status`, with `kind: "query"` and `continuityClass: "scalar_snapshot"`. `SessionSurface.getSteerStatus({clientRef})` and `QueryHandlers` require exactly one valid `clientRef`; values are `accepted`, `rejected`, `uncertain`, or `unknown`, with durable `dispatching` projected as `uncertain`. A query never dispatches work. Q30 follows Q23–Q29 messaging policy: Telegram, Discord, and Slack dispositions are `prohibited`. Regenerate the checked-in operation inventory and update behavioral count invariants from 29 to 30 queries and 95 to 96 total operations.

A caller that receives `uncertain` may query or replay the same `clientRef`. GJC returns the same durable result and never queues a second message. A new logical steer requires a new `clientRef`.

## Public contracts

### Prompt and skill status

`turn.prompt_status` and `skill.invoke_status` retain their existing `status` field and include `receiptState` on every response. Unknown lookup returns `status: "unknown"` and `receiptState: "unknown"`. Hermes maps GJC `status` to its own `executionState`; GJC does not add a duplicate execution field to these two queries.

### Terminal success

Ordinary success requires all three facts:

1. `executionState == "terminal_ok"`;
2. `receiptState == "present"`;
3. reportable text or artifact path exists at the canonical transcript or runtime sidecar.

A durable `present` marker without a readable body is consumer-visible uncertainty, not fabricated success.

### Steer result

A correlated `turn.steer` result includes:

- `sessionId`;
- `clientRef`;
- `status: accepted | rejected | uncertain`;
- `acceptedAt` or `terminalAt` when known;
- bounded stable `error` for rejected or uncertain outcomes.

No response echoes steer text.

## Non-goals

- Do not add a fourth durable state file.
- Do not store prompt, steer, transcript, credential, or provider response bodies in reconciliation.
- Do not auto-retry a prompt, steer, skill, or worker.
- Do not change prompt ordering, prompt deadlines, cancellation ownership, or owner-isolation rules.
- Do not make GJC read Hermes state.
- Do not bump runtime or reconciliation schema version unless an existing parser makes additive compatibility impossible.
- Do not merge or release upstream during this work loop.

## Implementation tasks

### Task 1: Define receipt semantics with red tests

**Create:**
- `packages/coding-agent/src/sdk/receipt-state.ts`
- `packages/coding-agent/test/sdk-receipt-state.test.ts`

**Steps:**
1. Add table-driven red tests for null, empty, whitespace, text, artifact path, and partial failed output.
2. Implement the two enums and shared predicate.
3. Run `bun test packages/coding-agent/test/sdk-receipt-state.test.ts`.

### Task 2: Add receipt state to durable prompt and skill reconciliation

**Modify:**
- `packages/coding-agent/src/sdk/prompt-status.ts`
- `packages/coding-agent/src/sdk/bus/reconciliation-store.ts`
- `packages/coding-agent/src/sdk/bus/kind-aware-reconciliation.ts`
- `packages/coding-agent/src/sdk/bus/prompt-reconciliation.ts`
- `packages/coding-agent/src/sdk/bus/index.ts`
- `packages/coding-agent/test/sdk-prompt-terminal-arbiter.test.ts`
- `packages/coding-agent/test/sdk-reconciliation-recovery.test.ts`
- `packages/coding-agent/test/sdk-reconciliation-store.test.ts`
- `packages/coding-agent/test/sdk-kind-aware-reconciliation.test.ts`
- `packages/coding-agent/test/sdk-q26-prompt-status.test.ts`

**Steps:**
1. Add red tests for accepted/in-flight absent receipt, terminal text present, textless terminal missing, failed partial output, and legacy unknown.
2. Add `receiptState` and `pendingReceiptState` validation.
3. Extend `claimPendingOutcome` and `finalizePromptOutcome` to carry prompt receipt state through claim and finalization.
4. Extend skill `agent_end` transitions with `finalText`; pass the real `lastAssistantText()` from the bus after invocation resolves.
5. Make restart settlement preserve prompt pending state, default stopped prompt without evidence to missing, and use unknown for body-unproven failure/skill settlement.
6. Add receipt state to public prompt and skill status responses.
7. Prove failed outcome remains authoritative when a later event contains text.
8. Run the focused Software Development Kit reconciliation tests.

### Task 3: Mirror dual-axis truth into runtime state

**Modify:**
- `packages/coding-agent/src/gjc-runtime/session-state-sidecar.ts`
- `packages/coding-agent/test/session-state-sidecar.test.ts`

**Create:**
- `packages/coding-agent/test/agent-session-terminal-receipt-state.test.ts`

**Steps:**
1. Add red cases for successful text, whitespace-only, absent assistant, error, aborted, and failed-with-partial-text.
2. Add one pure terminal reducer that uses `receipt-state.ts`.
3. Route state, final response, error, execution state, and receipt state through that reducer.
4. Preserve version-1 compatibility, file locking, identity checks, managed-owner verdicts, and hot-path no-sync-read rules.
5. Drive the real `AgentSession` event-to-file path for success and aborted textless cases.
6. Run the sidecar and integration tests.

### Task 4: Make coordinator completion fail closed

**Modify:**
- `packages/coding-agent/src/coordinator-mcp/server.ts`
- `packages/coding-agent/test/coordinator-mcp-server.test.ts`

**Steps:**
1. Replace the local reportable-response predicate with the shared helper.
2. Add `receipt_missing` as a terminal turn status.
3. Project sidecar execution and receipt fields into `read_turn` and `await_turn`.
4. Convert completed-without-body to `receipt_missing` with stable error code.
5. Preserve failed execution and optional partial text.
6. Add red tests proving the old advisory-only completed response is rejected.
7. Run `bun test packages/coding-agent/test/coordinator-mcp-server.test.ts`.

### Task 5: Add retry-safe correlated steer records

**Modify:**
- `packages/coding-agent/src/sdk/protocol/operation-registry.ts`
- `packages/coding-agent/src/sdk/protocol/operation-inventory.generated.json`
- `packages/coding-agent/src/sdk/host/control/dispatch.ts`
- `packages/coding-agent/src/sdk/host/control/operations.ts`
- `packages/coding-agent/src/sdk/host/query/handlers.ts`
- `packages/coding-agent/src/sdk/session.ts`
- `packages/coding-agent/src/sdk/bus/reconciliation-store.ts`
- `packages/coding-agent/src/sdk/bus/kind-aware-reconciliation.ts`
- `packages/coding-agent/src/sdk/bus/index.ts`
- `packages/coding-agent/test/sdk-control-dispatch.test.ts`
- `packages/coding-agent/test/sdk-operation-inventory.test.ts`
- `packages/coding-agent/test/sdk-operation-matrix.test.ts`
- `packages/coding-agent/test/sdk-adapter-dispositions.test.ts`
- `packages/coding-agent/test/sdk-reconciliation-store.test.ts`
- `packages/coding-agent/test/sdk-kind-aware-reconciliation.test.ts`

**Create:**
- `packages/coding-agent/test/sdk-steer-reconciliation.test.ts`
- `packages/coding-agent/test/sdk-q30-steer-status.test.ts`

**Steps:**
1. Add red tests for the exact steer union, accepted steer, definite pre-effect rejection, response loss, restart while dispatching, concurrent same-ref replay, conflicting digest, cleanup retention, and unknown lookup.
2. Add steer-specific reserve/settle/lookup APIs keyed by `steer:<clientRef>`; do not alter prompt/skill admission replay semantics.
3. Reserve `dispatching` durably before `api.sendUserMessage(..., {deliverAs: "steer"})`; settle accepted only after queueing returns and settle rejected only when that call definitely rejects before effect.
4. Replay retained records without calling `api.sendUserMessage()` or `surface.steer()`.
5. Thread optional `clientRef` through `ControlSurface.steer` and control dispatch.
6. Project matching live `dispatching` as `uncertain` for replay and Q30 without redispatch.
7. Apply the existing retention time and capacity bounds to settled steer records through `settledAt`; never terminal-evict live `dispatching`.
8. Register Q30 `turn.steer_status`, implement exact-selector validation, prohibit messaging adapters, regenerate the inventory, and update 29→30 and 95→96 count assertions.
9. Keep text out of durable state and bound all public errors.
10. Preserve uncorrelated legacy steer behavior for callers that omit `clientRef`.
11. Run the focused steer, control, query, inventory, matrix, disposition, and reconciliation tests.

### Task 6: Document the additive public contract

**Modify:**
- `packages/coding-agent/CHANGELOG.md`
- `docs/sdk.md`

**Steps:**
1. Add one `Unreleased` fix note for dual execution/receipt state and explicit receipt-missing outcomes.
2. Add one note for correlated retry-safe steer acknowledgement and `turn.steer_status`.
3. Document Q30, correlated steer input/result/replay semantics, receipt fields, restart uncertainty, and legacy uncorrelated behavior.
4. State that existing version-1 files remain readable and bodies are not stored in reconciliation.

### Task 7: Focused and full verification

Run in order:

1. `bun test packages/coding-agent/test/sdk-receipt-state.test.ts`
2. `bun test packages/coding-agent/test/session-state-sidecar.test.ts packages/coding-agent/test/agent-session-terminal-receipt-state.test.ts`
3. `bun test packages/coding-agent/test/sdk-prompt-terminal-arbiter.test.ts packages/coding-agent/test/sdk-reconciliation-recovery.test.ts packages/coding-agent/test/sdk-reconciliation-store.test.ts packages/coding-agent/test/sdk-kind-aware-reconciliation.test.ts packages/coding-agent/test/sdk-q26-prompt-status.test.ts`
4. `bun test packages/coding-agent/test/sdk-steer-reconciliation.test.ts packages/coding-agent/test/sdk-q30-steer-status.test.ts packages/coding-agent/test/sdk-control-dispatch.test.ts packages/coding-agent/test/sdk-operation-inventory.test.ts packages/coding-agent/test/sdk-operation-matrix.test.ts packages/coding-agent/test/sdk-adapter-dispositions.test.ts`
5. `bun test packages/coding-agent/test/coordinator-mcp-server.test.ts`
6. `bun --cwd=packages/coding-agent run check`
7. `bun run check:ts`
8. `bun run test:ts`

A pass-on-retry is a defect. Fix the flake before review.

### Task 8: Independent review and pull request

1. Run an independent adversarial review against this plan and the full diff.
2. Allow at most three repair rounds.
3. Build a local GJC package and run the public Software Development Kit smoke used by the Hermes consumer tests.
4. Push to Grant's Gajae-Code fork.
5. Open one upstream pull request against `dev` with issue #815 context, focused test receipts, privacy bounds, restart semantics, and compatibility notes.
6. Do not merge or release upstream.

## Verification of verification

The receipt tests would fail silently if they called only the helper. The integration test must drive `AgentSession` through the real sidecar consumer and inspect the canonical file.

The reconciliation tests would fail silently if they covered only final records. At least one test must crash between pending claim and finalization, reload the real file, and prove receipt state never becomes optimistically present.

The steer tests would fail silently if they mocked the durable reservation. The acceptance test must invoke the real control dispatch twice with one `clientRef` and assert `surface.steer()` ran once.

The coordinator tests would fail silently if they asserted only extra fields. The real `await_turn` result must not retain ordinary `completed` status for missing output.

Temporary mutation proofs must make tests fail when each of these legs is removed:

- receipt state from terminal claim;
- restart default-to-missing;
- sidecar dual-axis write;
- coordinator receipt-missing status;
- steer pre-dispatch reservation;
- steer replay short-circuit;
- steer status query.

Revert every mutation before commit.

## Risks and material-fork boundaries

- A correlated steer that dies in `dispatching` stays uncertain forever. GJC must not redispatch because the first queue effect is unknowable.
- Existing uncorrelated steer callers remain non-idempotent by design. Hermes must always send `clientRef` after adopting this contract.
- A durable `receiptState: "present"` can outlive a damaged transcript. Consumers must still require a readable body before ordinary success.
- Prompt/skill admission keeps its current no-reuse rule; only steer has same-reference replay semantics.
- Changing schema version, storing content in reconciliation, or adding automatic retry requires a plan amendment.
- An upstream request to preserve advisory-only empty completion requires Grant's decision because it violates issue #815.

## Routing

```yaml
routing:
  reasoning_mode: adversarial
  execution_topology: direct
  gjc_profile: adversarial
  gjc_workflow: direct
  capability_evidence:
    - The change owns durable terminal truth, crash windows, ordered-control idempotency, and public compatibility.
    - False success or duplicate steering can corrupt an autonomous coding loop.
    - Verification must cover process restart and lost transport responses.
  topology_evidence:
    - One GJC durability model owns prompt, skill, sidecar, coordinator, and steer projections.
    - Splitting writers would create conflicting schema changes and weaken crash-window review.
  escalation_triggers:
    - A new durable file or stored content body is required.
    - Existing public compatibility cannot be preserved additively.
    - Exactly-once steer requires automatic redispatch after an uncertain crash window.
    - Verification requires credentials, release, destructive cleanup, or upstream merge.
```

## Execution handoff

Use this exact plan in the isolated GJC worktree. Follow test-driven development and atomic commits. Do not edit the approved plan during implementation. Any material contradiction requires an explicit amendment and fresh approval.
