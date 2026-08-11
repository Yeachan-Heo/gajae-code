# SDK Terminal Receipt and Correlated Steer Plan

**Status:** approved implementation contract
**Repository:** `/private/tmp/gjc-3825-current-dev-20260807`
**Branch:** `fix/sdk-terminal-receipt-steer-20260807`
**Base:** `origin/dev@b9cb17124b9cefadf9e5acc0e1ecabaddb7a0609`
**Source work:** closed PR #3825 and open issue #3956

## Goal

Make SDK terminal outcomes truthful and retry-safe: execution completion must not imply a usable receipt, and `turn.steer` must support durable caller correlation and authoritative status lookup after uncertain transport or process outcomes.

## Evidence and root constraint

- Current Coordinator code can mark a turn completed while returning only the advisory `completion_missing_final_response`.
- Current state has no shared receipt-state module, no `receipt_missing` terminal outcome, and no dual execution/receipt projection.
- Current `turn.steer` accepts text without a caller correlation key and exposes no `turn.steer_status` query.
- Current architecture has two steering paths: the SDK bus control surface and the host session-runtime control surface. Both must implement one contract.
- Closed PR #3825 contains reusable pure modules, test cases, and invariants, but its integration predates the current SDK surface factory.
- Open issue #3956 covers the correlated-steering half and has no implementing pull request at this base.

## Settled behavior

### Terminal receipt truth

- Track execution state separately from receipt state.
- A terminal execution with a reportable final response has a present receipt.
- A terminal execution without a reportable final response fails closed as `receipt_missing`; it must not appear as successful completion.
- Preserve existing terminal failure and cancellation meaning.
- Persist only outcome metadata. Do not store prompt, steer text, transcript, credentials, or provider response bodies in reconciliation records.
- Preserve current schema compatibility where existing readers require it.

### Correlated steering

- `turn.steer` accepts optional `clientRef`, using the same trimmed, non-empty, 128-character contract as existing prompt and skill correlation.
- A retained duplicate `clientRef` is rejected before dispatch.
- A caller can query `turn.steer_status` using either `clientRef` or the canonical command/turn identity returned at acceptance.
- A durable accepted record allows callers to reconcile uncertain replies without duplicate delivery.
- Status hydration after process restart is conservative. Missing durable proof must never become successful delivery.
- Both current steering entrypoints use the same reconciliation owner and observable contract.

## Non-goals

- Do not restore the old inline SDK factory architecture.
- Do not revive committed generated docs-index files that current `dev` removed.
- Do not change prompt or skill correlation semantics.
- Do not store request or response bodies in durable reconciliation records.
- Do not change unrelated Coordinator lifecycle, provider, model, workflow, or UI behavior.
- Do not split receipt truth and steering into separate pull requests without Grant's approval.
- Do not edit this approved plan during implementation.

## Architecture

Use the current kind-aware reconciliation store as the single durable correlation owner. Add `steer` as a typed record kind and add one small receipt-state module for execution/receipt reduction. Wire current bus and host factory paths to those primitives rather than copying the old PR's integration hunks.

Coordinator and sidecar projections consume the shared receipt-state semantics. The operation registry remains the public SDK authority and regenerates its inventory through the repository generator.

## Implementation tasks

### Task 1: Add receipt-state semantics with failing tests

**Create:**
- `packages/coding-agent/src/sdk/receipt-state.ts`
- `packages/coding-agent/test/sdk-receipt-state.test.ts`

**Adapt tests:**
- `packages/coding-agent/test/agent-session-terminal-receipt-state.test.ts`

Add behavioral tests for reportable output, empty output, failure, cancellation, and conservative unknown states. Run the focused tests and record the expected RED result before implementation. Add the minimum typed reducer required to pass.

### Task 2: Extend durable reconciliation for steering

**Modify:**
- `packages/coding-agent/src/sdk/bus/reconciliation-store.ts`
- `packages/coding-agent/src/sdk/bus/kind-aware-reconciliation.ts`
- `packages/coding-agent/src/sdk/bus/prompt-reconciliation.ts`
- `packages/coding-agent/src/sdk/prompt-status.ts`

**Add or adapt tests:**
- `packages/coding-agent/test/sdk-reconciliation-store.test.ts`
- `packages/coding-agent/test/sdk-reconciliation-recovery.test.ts`
- `packages/coding-agent/test/sdk-kind-aware-reconciliation.test.ts`
- `packages/coding-agent/test/sdk-steer-reconciliation.test.ts`

Introduce a discriminated `steer` record with correlation metadata and digest-only request identity. Prove admission, duplicate rejection, accepted/in-flight/terminal status, recovery, eviction, corruption handling, and no body persistence.

### Task 3: Wire both steering entrypoints

**Modify:**
- `packages/coding-agent/src/sdk/bus/index.ts`
- `packages/coding-agent/src/sdk/host/session-runtime.ts`
- `packages/coding-agent/src/sdk/host/control/operations.ts`
- `packages/coding-agent/src/sdk/host/control/dispatch.ts`
- `packages/coding-agent/src/sdk/host/query/handlers.ts`

**Add or adapt tests:**
- `packages/coding-agent/test/sdk-steer-dispatch-integration.test.ts`
- `packages/coding-agent/test/sdk-q30-steer-status.test.ts`
- `packages/coding-agent/test/sdk-host-wiring.test.ts`
- `packages/coding-agent/test/helpers/sdk-production-host.ts`

Add optional `clientRef`, return canonical correlation after durable acceptance, and expose authoritative `turn.steer_status`. Prove the SDK bus and host session-runtime paths behave identically. Prove status-only replay never dispatches another steer.

### Task 4: Make terminal projections fail closed

**Modify:**
- `packages/coding-agent/src/gjc-runtime/session-state-sidecar.ts`
- `packages/coding-agent/src/coordinator-mcp/server.ts`

**Adapt tests:**
- `packages/coding-agent/test/session-state-sidecar.test.ts`
- `packages/coding-agent/test/coordinator-mcp-server.test.ts`
- `packages/coding-agent/test/sdk-prompt-terminal-arbiter.test.ts`
- `packages/coding-agent/test/sdk-q26-prompt-status.test.ts`

Project execution and receipt states independently. Replace advisory success for missing final output with the typed `receipt_missing` failure. Preserve attributable terminal authority and existing failure/cancellation paths.

### Task 5: Update public contract and generated inventory

**Modify:**
- `packages/coding-agent/src/sdk/protocol/operation-registry.ts`
- `packages/coding-agent/src/sdk/protocol/operation-inventory.generated.json` through the repository generator
- `packages/coding-agent/test/sdk-operation-inventory.test.ts`
- `packages/coding-agent/test/sdk-operation-matrix.test.ts`
- `packages/coding-agent/test/sdk-adapter-dispositions.test.ts`
- `packages/coding-agent/test/manifests/sdk-adapter-parity-v1.json`
- `docs/sdk.md`
- `packages/coding-agent/CHANGELOG.md`

Document receipt truth, `turn.steer` correlation, `turn.steer_status`, conservative restart semantics, duplicate behavior, and retention limits. Regenerate rather than hand-edit generated authority.

## Verification

Run focused tests after each task. Final verification must include:

- Receipt-state and terminal-receipt tests.
- Reconciliation store, recovery, kind-aware, prompt arbiter, and Q26 tests.
- Steering reconciliation, dispatch, Q30, and both control-surface integration tests.
- Coordinator and sidecar tests.
- Operation inventory, matrix, and adapter parity tests.
- Mutation proof that removing receipt classification makes missing-output tests fail.
- Mutation proof that bypassing durable steer acceptance makes replay/status tests fail.
- Mutation proof that either steering entrypoint omits correlation makes its path-specific test fail.
- `bun --cwd=packages/coding-agent run check`.
- Repository-required generated inventory checks.
- `bun run build` or the current canonical coding-agent build command.
- Built artifact `gjc --smoke-test`.
- `git diff --check`.
- Independent adversarial review after implementation.
- Current-head pull-request checks and unresolved-thread review after push.

## Risks and stop conditions

Stop before mutation beyond this contract when:

- Current source requires separate public semantics for the two steering entrypoints.
- Durable receipt truth requires storing prompt, steer, transcript, credential, or provider-response bodies.
- Current upstream adds a materially overlapping implementation.
- The implementation must split into separate pull requests.
- A generated or public contract change exceeds the behavior settled above.

Mechanical current-source changes needed to apply the settled contract are not material forks.

## Routing

```yaml
routing:
  reasoning_mode: investigative
  execution_topology: direct
  gjc_profile: investigative
  gjc_workflow: direct
  capability_evidence:
    - The root constraint and public behavior are settled, but integration spans persistence, two control paths, terminal projection, and generated SDK authority.
    - Current architecture differs materially from the old pull-request integration and requires source-guided adaptation.
    - Behavioral and mutation tests provide strong oracles, so adversarial architecture routing is unnecessary.
  topology_evidence:
    - One coherent SDK outcome owns all changes and can be implemented and proven in one isolated worktree.
    - No independent long-lived work lanes or cross-session coordination are required.
  escalation_triggers:
    - Public SDK behavior differs between current steering entrypoints.
    - Receipt truth requires sensitive body persistence.
    - Upstream adds overlapping work.
    - One-pull-request scope becomes invalid.
```

## Execution handoff

Run the GJC CLI from `/private/tmp/gjc-3825-current-dev-20260807` so repository `AGENTS.md` applies. Use the approved investigative direct route. The writer must keep this plan unchanged, implement through test-driven development, commit coherent checkpoints, and return exact test and commit receipts. The final pull request must target `Yeachan-Heo/gajae-code:dev`, reference closed PR #3825 and issue #3956, and remain unmerged.
