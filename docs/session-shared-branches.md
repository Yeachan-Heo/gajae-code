# Shared session branches across processes

Two surfaces (TUI, desktop) may open the same managed session and keep
independent conversation branches. The transcript stays one logical session and
one tree; each open keeps its own selected leaf and live context. Only the
persistence step is serialized, never a lifetime writer lease, and no session is
copied or brokered to achieve it.

This document is the working plan for the multi-PR effort. It is not a
description of shipped behavior until the final gate passes.

## Invariants

- One logical session, one transcript tree, entry ids and parent links preserved.
- A live process keeps its selected leaf and live messages while canonical state
  is refreshed below it. Ambient refresh never adopts another process's branch.
- Every canonical mutation runs inside one short cross-process transaction and
  validates its parent and ids against the state it observes there.
- Uncertainty is reported, never guessed: a mutation that may have landed is
  reconciled against canonical state, never retried blindly, and tools are never
  re-executed because their transcript receipt failed.
- Old transcripts stay readable and resumable. Migration of a format that must
  change runs once, inside the transaction, with an atomic publish and a
  recoverable source; read-only listing never migrates.
- Concurrent old/new writers are explicitly unsupported. Old binaries do not
  honor the transaction, so writers must be stopped before upgrade. A marker or
  advisory lock cannot prove an uncooperative writer absent.

## Slices

Each slice is a separate reviewable pull request, roughly 800 changed lines
including tests and docs. A slice that lands before the gate does not enable or
advertise concurrent session sharing.

1. **Transaction primitive** — `managed-session-transaction.ts`: one lease per
   logical session, session-keyed so it survives transcript replacement, typed
   busy / ownership-lost / unproven-release outcomes, bounded wait.
2. **Cursor-preserving refresh and sibling publication** — refresh canonical
   graph knowledge without moving the caller's leaf; publish a child of that
   leaf; stable ids per publication intent; validate the whole pending chain.
3. **Migration under the transaction** — reuse the existing version migrations;
   commit exactly one migrated generation; recover from a crash before, during
   and after publication; do not restore a rollback source over newer branches.
4. **Complete mutation coverage** — append, metadata, rewrite, compaction,
   eviction, near-limit recovery, delete, relocate, recreate, blob publication
   and derived caches all join the transaction or fail explicitly without
   mutating.
5. **Runtime ownership** — only where a real collision is demonstrated, separate
   per-open provider/job/endpoint/cleanup ownership from the logical session id.
6. **TUI integration and gate** — real two-process runs; enable for users only
   after the aggregate gate passes. Desktop adoption follows, reusing the same
   SDK contract.

## Canonical mutation inventory

Measured by search over `packages/coding-agent/src/session/session-manager.ts` at commit
`1806c823d4`, so later slices can wrap existing funnels instead of hunting for writes.

| Site | Role | References |
|---|---|---|
| `#appendManagedRecordsSync` | The single funnel every record append goes through before `appendExpectedIdentitySync` | defined once, called from the near-limit and normal append paths |
| `appendExpectedIdentitySync` | Identity-checked append primitive | 3 call sites |
| `replaceExpectedIdentitySync` | Identity-checked whole-file replacement | 3 call sites, including the atomic rewrite |
| `#writeEntriesAtomicallySync` | Materializes the whole entry list (used by rewrites) | 4 references |
| `#rewriteFile` / `#rewriteFileSync` | Whole-file rewrite entry points, including migration and recovery | 11 and 4 references |
| `#appendHeaderPatch` | Header/header-patch publication (star, cwd) | defined once, 6 references |
| `evictCompactedContent` | Relocates compacted ancestors into blobs and arms a rewrite | 1 site |
| `deleteSessionVerified` | Verified hard delete | 2 references |

The two funnels that matter most are the record append and the atomic whole-file
materialization: a transaction that covers only one of them leaves the other able
to publish a stale graph over a sibling branch.

Runtime ownership is a separate lane. In `packages/coding-agent/src/sdk/session.ts`
the provider session identity is derived from the logical session id at one
`owner_busy` site, and endpoint/job state is referenced throughout the host
runtime, so slice 5 must classify those consumers before changing anything.

## Migration ordering constraint

A legacy transcript's migrated entries are derived at load time, and publication is
deferred: resume sets `#needsFullRewriteOnNextPersist`, and the whole-file rewrite
happens on the first persist through the atomic rewrite funnel.

That deferral is why slice 3 cannot be satisfied by wrapping the rewrite funnel
alone. Two processes could each derive different migrated ids for the same legacy
file before either publishes. The order must be: acquire the transaction, re-read
the canonical transcript, migrate only if it is still legacy, then publish. A
reader that merely lists sessions must never migrate or reserve ids.

## Open questions before wiring sibling publication

An attempt to adopt a sibling branch inside the managed append funnel was reverted
because two behaviours were not understood well enough to ship:

1. `SessionManager.open(file, destination)` on an existing managed transcript did
	not report the session id the writer had. A resume path that changes logical
	identity cannot be the basis for sibling publication, so the resume/id rule must
	be pinned first.
2. A freshly opened manager's first persist can take the whole-file rewrite path
	rather than the append path. That rewrite materialises the resident graph and can
	put a deleted record back, which is exactly the stale-graph overwrite the
	transaction exists to prevent. The rewrite funnel must therefore be covered before
	the append funnel is extended, not after.

Recorded so the next attempt starts from those two facts instead of rediscovering
them.

## Obligations carried forward

- The managed internal locks directory currently validates lock names against
  `^(?:[a-f0-9]{64}|gc-retirement-[a-f0-9]{64})\.lock$` in
  `packages/coding-agent/src/session/internal/managed-session-scope.ts`. A
  transaction lease placed there fails `managed_gc_protocol_lock_role_invalid`
  and aborts GC inventory. The wiring slice must either place the lease outside
  that validated role or extend the validator and its GC inventory test.
- `ManagedSessionReleaseError` means the body's commit state is unknown. Callers
  publishing inside the transaction must reconcile before retrying.
- The lease is heartbeated, so a body that stalls keeps other writers waiting,
  and a process that dies mid-body leaves the session busy until the lease
  expires.
