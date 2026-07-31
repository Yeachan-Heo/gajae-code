# 23 — sandbox-blocked broker child spawn (environment block, not a code defect)

- **Site:** `packages/coding-agent/src/sdk/broker/lifecycle.ts` — `spawn_failed` at
  `:3546`/`:3649`, then `terminal_uncertain` from post-child persistence
  verification at `:3659`
- **Owner stage:** Stage 12 residual defect triage (durable goal G010)
- **Disposition:** ACCEPT AS ENVIRONMENT BLOCK — explicitly labelled, never silently skipped

## What is blocked

Spawning a real broker child requires process-spawn and endpoint-persistence
permissions the sandboxed execution environment does not grant. The lifecycle code
handles that honestly: startup surfaces `spawn_failed` ("No ready SDK endpoint
remains available."), and when the post-child persistence check cannot prove the
cleanup, it degrades to `terminal_uncertain` ("Lifecycle startup cleanup could not
be proven; retained artifacts require reconciliation.") rather than claiming
success.

## Why this is not reclassified as a code defect

The failure is produced by the environment denying the spawn, not by a wrong branch
in the lifecycle state machine: with the spawn denied there is no child endpoint to
verify, and the only truthful outcomes are "spawn failed" and "terminal state
uncertain". The code reaches those outcomes deterministically, and the surrounding
`sdk-broker` suite is green (53 pass / 0 fail) because it exercises the lifecycle
through injected adapters rather than a real child.

Reclassifying this as FIX would require asserting that a real broker child can be
spawned here, which is false in this environment. Per the Stage 12 contract, any
reclassification requires an independent triage verdict.

## Why it is not silently skipped

No `test.skip` was added for this. The limitation is recorded here and is visible in
the code paths named above; the app-server acceptance tiers that genuinely need a
live child use the production in-process child bridge
(`packages/coding-agent/src/app-server/thread-runtime/production-child.ts`) instead
of the sandbox-blocked broker spawn, and the real-client gate exercises that path
end to end.

## What would close it

A host environment that permits child process spawn plus endpoint state
persistence, after which the broker-child startup path can be exercised for real
and this record replaced with a receipt.
