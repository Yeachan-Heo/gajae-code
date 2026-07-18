# 16 — withWorkflowStateLock / updateJsonAtomic can lose updates for critical sections longer than staleMs

- **Severity:** Medium (mutual exclusion breaks for long holders)
- **Scope:** `packages/coding-agent/src/config/file-lock.ts:95-101,145-147` (stale-by-elapsed-time reaping), consumed by `packages/coding-agent/src/gjc-runtime/state-writer.ts:439-475`
- **Surface:** cross-process workflow-state serialization (PR #652 / commit 4d5099a6)
- **Found by:** post-0.5.1 dogfood (G002), architect `1-ArchG002-StateSession`

## Summary

PR #652 correctly routes `updateJsonAtomic` through `withFileLock` keyed on the
resolved `.gjc` target and exposes `withWorkflowStateLock` as a CAS primitive.
Release is safe (`withFileLock` releases in `finally`). The dogfood harness (16
concurrent fast cross-process writers) all landed — confirmed.

The gap is **liveness**: the inherited lock backend treats a lock holder as
*stale* purely by elapsed wall-clock time (default `staleMs` 10000 ms) and then
removes the lock directory, with no heartbeat or owner-token check on the live
holder. A mutator (or multi-step `withWorkflowStateLock` section) that runs
longer than `staleMs` can have its lock reaped, letting a second writer enter
the same critical section → the exact read-modify-write clobber #652 set out to
prevent.

## Impact

`withWorkflowStateLock` is not strict serialization for long-running workflow
mutations. `updateJsonAtomic` can still lose updates if the mutator/audit stalls
past `staleMs`. Short writes (the common case, and the dogfood case) are safe;
long critical sections are not.

## Suggested fix

Do not reap an *alive* owner by elapsed time alone — add a heartbeat and/or
owner-token compare (mirroring the file-lock GC owner-token guard from #618)
before removing a lock dir. Add a regression where the holder sleeps past
`staleMs` and a second writer must not overlap.

## Resolution

**Resolved.** `packages/coding-agent/src/config/file-lock.ts` now stamps PID start-time identity and refuses to reap a live holder; state-sidecar and lease mutation paths use the same lock. Regression coverage: `packages/coding-agent/test/file-lock-gc-toctou.test.ts` and `packages/coding-agent/test/session-state-sidecar.test.ts`.
