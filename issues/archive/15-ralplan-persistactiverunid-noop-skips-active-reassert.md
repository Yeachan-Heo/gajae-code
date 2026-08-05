# 15 — ralplan persistActiveRunId early no-op can skip the promised active:true re-assertion

- **Severity:** Medium (Stop-hook disarm edge; narrows the #647 guarantee)
- **Scope:** `packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts:235-246` (`persistActiveRunId` no-op guard)
- **Surface:** ralplan run-state / handoff Stop hook (PR #647 / commit e20f5ad9)
- **Found by:** post-0.5.1 dogfood (G001), architect `0-ArchG001-Workflow`

## Summary

PR #647 claims a successful `--write` *always* re-asserts `active: true`
(`existing.active = true`). But the early no-op optimization returns **before**
that line when run_id, state version, and the computed phase all match:

```ts
if (
  existing.run_id === runId &&
  existing.version === WORKFLOW_STATE_VERSION &&
  existing.current_phase === nextPhase
) {
  return;            // <- returns even if existing.active === false
}
...
existing.active = true;     // never reached on that path
```

The predicate omits `existing.active === true`. So a same-run `--write` whose
phase already equals the written stage can persist while the mode-state stays
`active: false` (e.g. after a prior `gjc state ralplan clear` that set
`active:false, current_phase:"planner"`, followed by a same-run planner write at
the same phase).

## Impact

`modeStateReleasesStop` keys on `state.active !== true`. A same-run write that
hits the no-op path leaves `active:false`, so the handoff-required Stop hook
stays **released** even though ralplan is actively producing artifacts —
silently disarming the safety mechanism #647 was meant to re-arm.

The happy paths verified in dogfood (new-run re-activation, locked-phase drop)
are correct; this is the residual same-run-phase-equal edge.

## Suggested fix

Add `existing.active === true` to the no-op predicate (only no-op when already
active), while preserving the deliberate same-run terminal/cleared guard that
#647's tests cover. Add a regression: state `{run_id, active:false,
current_phase:"planner", version:2}` + same-run planner `--write` → `active:true`
re-asserted.

## Resolution

**Resolved.** The active-state reassertion regression is covered by the ralplan runtime implementation and its focused regression tests. See `packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts` and `packages/coding-agent/test/gjc-runtime/ralplan-runtime.test.ts`.
