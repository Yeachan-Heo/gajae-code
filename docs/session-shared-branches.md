# Shared session branches across processes

Two surfaces (TUI, desktop) may open the same managed session and keep
independent conversation branches. The transcript stays one logical session and
one tree; each open keeps its own selected leaf and live context. Only the
persistence step is serialized, never a lifetime writer lease, and no session is
copied or brokered to achieve it.

This is the working plan for the effort. It does not describe shipped behavior
until the final gate passes, and it does not describe a complete design for the
durability contract that Phase B has to settle.

## Invariants

- One logical session, one transcript tree, entry ids and parent links preserved.
- A live process keeps its selected leaf and live messages while canonical state
  is refreshed below it. Ambient refresh never adopts another process's branch.
- Every canonical mutation runs inside one short cross-process transaction and
  validates its parents and ids against the state it observes there.
- Model and tool execution never holds the transaction and is never repeated
  because a transcript receipt failed. An uncertain publication is reconciled
  against canonical state before any retry.
- Old transcripts stay readable and resumable. Migration of a format that must
  change runs once, inside the transaction, with an atomic publish and a
  recoverable source; read-only listing never migrates.
- Concurrent old/new writers are explicitly unsupported. Old binaries do not
  honor the transaction, so writers must be stopped before upgrade. The
  guarantee is cooperative local writers surviving process death, not power-loss
  durability.
- Transcript isolation does not isolate the files tools modify in the workspace.

## Current storage behavior

Measured on this branch, not inferred from fixtures, and pinned by
`packages/coding-agent/test/shared-session-transcript-contract.test.ts`. This is
characterization, not target behavior: two of these cases assert what the sharing
work intends to replace, and are the red tests for the later phases.

- A user-only append followed by `flush()` does **not** create the transcript.
  Publication starts once a resident assistant entry exists or `ensureOnDisk()`
  is called. A "resumed" path may therefore have been missing on disk, which is
  why an earlier round mistook a new session for identity mutation.
- Once the transcript is written, reopening it in the same destination preserves
  the logical session id. The transcript carries no cursor: open restores the last
  persisted record, so a non-tip selection is lost. Keeping the cursor per open is
  therefore a Phase C obligation, not something the format already provides.
- The managed append funnel compares the whole transcript identity
  (`dev`/`ino`/`nlink`/`size`/`sha256`) against what that writer last observed. A
  mismatch is rejected before writing; the resident entry is rolled back and the
  rejected process keeps its own cursor.
- That rejection latches the manager: every later send from the same process fails
  the same way. Recovery today is reopen or replace, not retry. Phase C must decide
  whether reconciliation clears the latch or requires replacement.
- A **deleted** transcript is treated as a missing predecessor: the next append
  republishes the complete resident graph through the rewrite path and recreates
  the file. Deletion must become lifecycle-authorized, otherwise a stale writer can
  revive a session its owner removed.
- An externally **truncated** transcript is not rewritten by a rejected append.

## Durability boundary

The transaction is acquired asynchronously, so persistence-bearing APIs must be
explicitly awaited. Synchronous helpers stay for pure work (entry construction,
id allocation, admission) but must not hide deferred durability behind an
existing synchronous contract. Callers that depend on durability convert in
bounded families with type checks before anything is wired to shared writing.

## Phases

Each phase is one or more pull requests against `dev`, each under 800 changed
lines including tests and docs. Split further rather than drop coverage. A phase
landing does not enable or advertise concurrent writing.

- **A. Evidence and fixture contract** — correct earlier conclusions, pin the
  storage contract above.
- **B. Durability contract and lock domain** — awaited persistence APIs, caller
  families, stable lock-directory identity across aliases and relocation, GC
  lock-role compatibility, bounded contention, owner-death and release
  ambiguity behavior.
- **C. Canonical, pending and cursor state** — immutable pending intent with
  frozen payload and operation-owned blobs, prepared resident installation that
  preserves the cursor, rollback that removes only definitely uncommitted work,
  committed / not-committed / unknown receipts with reconciliation. This phase
  also decides whether reconciliation clears the latched persistence error or
  requires replacing the manager, and makes deletion lifecycle-authorized so a
  stale writer cannot revive a removed transcript.
- **D. Migration before writable admission** — acquire, reread, migrate only if
  still legacy, publish, then expose the cursor; crash recovery never restores a
  source over newer branches; read-only listing never migrates.
- **E. Test-only sibling publication** — coherent read, validate and publish
  under the lease, including ordered pending chains.
- **F. Complete mutation coverage** — header and staged model-selection paths,
  rewrites, compaction, eviction, near-limit recovery, sanitation, delete,
  recreate, relocation, blobs, markers, caches and GC. Every path either joins
  the transaction or rejects before mutating; a stale resident whole graph is
  never replayed.
- **G. Runtime ownership** — reproduce real collisions first, then separate
  provider, endpoint, job and cleanup ownership only where exclusivity is
  required. Credentials and cache affinity keep their own continuity rules.
- **H. Integration gate and activation** — SDK multi-process and real two-TUI
  runs on macOS and Linux, then a separate activation pull request.

## Branch and worktree layout

One branch and one worktree per pull request, stacked on the phase before it:

| Phase | Branch | Worktree |
|---|---|---|
| A | `feat/shared-session-branches` | `.wt/shared-session-branches` |
| B | `feat/shared-session-durability` | `.wt/shared-session-durability` |
| C | `feat/shared-session-state` | `.wt/shared-session-state` |
| D | `feat/shared-session-migration` | `.wt/shared-session-migration` |
| E | `feat/shared-session-publish` | `.wt/shared-session-publish` |
| F | one branch per mutation family | one worktree per family |
| G | `feat/shared-session-runtime` | `.wt/shared-session-runtime` |
| H | `feat/shared-session-activation` | `.wt/shared-session-activation` |

A worktree is created when its phase starts, not reserved up front. The paused
`#7616` checkout and its dirty files stay untouched.

## Review rules

- Implement, verify, commit atomically, then have architect and critic review the
  exact committed SHA. Fix and re-review both after any further commit,
  including documentation. Push only after both approve, and record the approved
  SHA in the pull request.
- Approval covers a phase, not activation. Nothing advertises shared writing
  until H passes.

## Canonical mutation inventory

Measured by search over `packages/coding-agent/src/session/session-manager.ts`
at commit `1806c823d4`, so later phases wrap existing funnels instead of hunting
for writes. Re-measure when a phase touches these paths.

| Site | Role | References |
|---|---|---|
| `#appendManagedRecordsSync` | Funnel every managed record append goes through | 1 definition, 2 call sites |
| `appendExpectedIdentitySync` | Identity-checked append primitive | 3 call sites |
| `replaceExpectedIdentitySync` | Identity-checked whole-file replacement | 3 call sites |
| `#writeEntriesAtomicallySync` | Materializes the whole entry list | 4 references |
| `#rewriteFile` / `#rewriteFileSync` | Whole-file rewrite, migration and recovery | 11 and 4 references |
| `#appendHeaderPatch` | Header and header-patch publication | 1 definition, 6 references |
| `evictCompactedContent` | Relocates compacted ancestors and arms a rewrite | 1 site |
| `deleteSessionVerified` | Verified hard delete | 2 references |

The two funnels that matter most are the record append and the atomic whole-file
materialization. Covering only one leaves the other able to publish a stale
graph.

## Migration ordering constraint

A legacy transcript's migrated entries are derived at load time, and publication
is deferred to the first whole-file rewrite. Wrapping only the rewrite funnel
would let two processes derive different migrated ids for the same legacy file
before either publishes, so the transaction must be taken before the reread and
the migration, not around the write alone.

## Carried-forward obligations

- The transaction lock directory is
  `<session directory>/.gjc-managed-session-internal/locks`, derived by
  `managedSessionTransactionLocksDirectory` from the managed session directory, never
  from a cwd. The separate-directory alternative is closed: the lease belongs in the
  directory GC already inventories, next to the transcripts it guards.
- The managed locks directory validates lock names before inventory. The transaction
  lease role is registered in `isManagedGcLockRoleName`, and inventory is proven to
  accept a **held** lease while still refusing an unclassified name.
- Relocation changes the lock domain. `SessionManager.moveTo` rescopes the transcript
  into a different session directory, so a lease taken before the move does not cover
  the destination. Taking the lease across a relocation, and the case of a lease
  heartbeating while GC captures the directory, stay open for Phase C.
- GC capture rejects any file whose size or timestamps change mid-scan, and the lease
  rewrites itself on every heartbeat, so a scan overlapping a heartbeat can abort
  inventory. Unverified.
- `ManagedSessionReleaseError` means the body's commit state is unknown. A caller
  that published inside the transaction must reconcile before retrying.
- The lease is heartbeated, so a body that stalls keeps other writers waiting,
  and a process that dies mid-body leaves the session busy until the lease
  expires.
- The transaction wrapper only fences publication when the caller invokes
  `assertOwned()`; acquiring the lease alone does not.

## Mutation coverage: what is pinned, and what is not

Every mutation family has to either take part in the shared-write protocol or refuse
before it writes. The families below are pinned by tests; the rest are open.

Pinned:

- **Model, thinking-level and service-tier changes.** Entries on the same identity-checked
  append. A second opener's change is refused before anything is written, and the refusal
  latches persistence, so a later shared publish reports `stale`.
- **Title and star (`header_patch`).** Same funnel, different record kind. A refused title
  used to stay applied on the opener that lost the fence; the rollback now also covers a
  definite not-committed rejection. The losing opener reverts to its own pre-attempt value
  and does not converge on the committed one.
- **Staged default-model selection.** Replaces the whole file from resident entries, so it
  is the destructive shape of the surface. A second opener's promotion is refused with
  `managed_replace_identity_mismatch` and the transcript stays byte-identical.
- **Compaction.** A stale opener's compaction is refused; its branch entry list and the
  bytes are unchanged, and a published compaction's `firstKeptEntryId` still resolves.
- **Two real processes.** Two children spawned against one transcript each commit three
  shared appends; all six commits are on disk under the reported ids and every parent link
  resolves. This does not show the children interleave, nor that either is unblocked while
  the other is alive.
- **Delete and recreate of the transcript.** A shared append refuses the rebuild a missing
  transcript would force (`stale` / `rewrite_required`, the file stays deleted and no phantom
  leaf appears). Outside the shared path a deleted transcript is recreated from the resident
  graph, which is the single-writer behavior.

Open:

- **Eviction and near-limit recovery.** Both arm a whole-file rewrite instead of an append.
  The rewrite itself is identity-fenced, so a stale eviction is refused rather than allowed
  to drop another opener's branch; what is unpinned is that refusal for these two triggers
  specifically. Building the eviction case needs the right fixture shape, not a bigger
  payload: `#coldSpillClone` passes a `message` entry's content field through untouched when it
  is a string, at any length, so only content-block arrays or `custom_message` string content
  spill that way; a message's `details` can still produce spill writes on its own, and eviction
  skipped because no writes were produced evicts nothing. Near-limit
  recovery is a separate trigger (the managed per-file cap) and shares none of that.
- **Relocation of a transcript under a shared writer.** The lock domain moves with the
  directory, so a lease taken before a move does not cover the destination. The shared append
  does take the transaction lease, but it derives that lease from the transcript path it holds,
  so a manager still pointing at the old path cannot publish at the new one and a stale opener
  is refused rather than granted the destination's lock.
- **Sanitation.** It sets rewrite debt when a transcript is opened for writing, which makes
  the next publish a whole-file replacement. Unpinned on a shared transcript.
- **Blobs, markers, caches and GC.** Two processes can reach the same blob store and GC
  capture. No case yet shows what happens when one evicts a payload the other still reads.
- **Provider, endpoint, job and cleanup ownership.** Runtime context is process-local by
  construction, so there is no collision to separate until a real two-TUI run exhibits one.

## Activation gate

Shared writing stays unadvertised until the open families above have a decision and a real
two-TUI run on macOS and Linux passes: two interactive TUIs on one session, each keeping its
own cursor, a crash and restart, and old-format, branched and compacted histories. The
activation change itself is a separate PR that only turns the behavior on.
- The lease lives inside the session directory, so relocating that directory moves the
  lease with it. The holder's next `assertOwned()` fails (its name is gone) and release is
  reported as unproven. The destination then stays busy for as long as the moved holder is
  alive: expiry alone never authorizes taking a lease from a live owner, and reclaim only
  happens once that process is gone. A relocation therefore has to finish or abandon its
  writers, not carry them across.
