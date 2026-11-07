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
