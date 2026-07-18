# 20 — state-runtime `stamped` revision is a post-lock re-read (concurrent-write race)

## Severity
MEDIUM (non-blocking follow-up; surfaced during the 0.6.5 release completion gate)

## Context
The 0.6.5 release unblock fixed a sequential active-state/HUD stale-skip by reflecting the
freshly written `state_revision` onto the in-memory payload before the derived active-state sync
(`packages/coding-agent/src/gjc-runtime/deep-interview-recorder.ts`,
`packages/coding-agent/src/gjc-runtime/state-runtime.ts`). The recorder path is concurrency-sound
because it uses optimistic `expectedRevision + 1` knowledge from the locked source write.

## Problem
`writeJsonAtomic` (state-runtime) produces `stamped` by re-reading the file **after** the source
writer lock is released (`state-runtime.ts:807-851`). The CLI write path then copies
`stamped.state_revision` onto `merged` and derives `sourceRevision` from it
(`state-runtime.ts:1401-1420`). Under concurrent `gjc state write` for the same mode/session,
writer A can re-read a revision that writer B committed after A's lock released, so A may publish
its older `merged` payload tagged with B's newer `source_state_revision`; the legitimate newer
sync can then be equal-revision stale-skipped, leaving stale active-state/HUD.

## Fix direction
Return the exact stamped envelope/revision computed **inside** the locked source write
(`writeGuardedWorkflowEnvelopeAtomic`) and use that causally-owned value for `merged.state_revision`
and the receipt, instead of a post-write file re-read. Add an interleaving regression test that
forces writer A to re-read after writer B commits and asserts A cannot publish B's revision.

## Non-goal
Do not disable the equal-revision stale-skip (would reopen nondeterministic cache overwrites and
weaken the monotonic source-revision contract).

## References
- Architect review: `.gjc/_session-.../plans/ralplan/.../stage-04-architect.md` (finding #1)
- Released in 0.6.5 (sequential case fixed); concurrency hardening tracked here for a later patch.

## Resolution

**Resolved.** The state-runtime locked revision handoff and its interleaving regression are implemented in `packages/coding-agent/src/gjc-runtime/state-runtime.ts` and `packages/coding-agent/test/gjc-runtime/state-runtime.test.ts`.
