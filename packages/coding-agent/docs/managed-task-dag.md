# Managed task DAG — M1 domain contract

Policy-only milestone. This document describes the private durable domain snapshot and graph/resource reservation APIs. It is not a release, daemon, or verification-acceptance contract. No public PASS boolean, receipt source label, or caller-supplied verification id authorizes readiness.

## Boundary

- Protection applies only to enrolled managed callers that persist through this domain and later authenticated Broker admission (M2). Ordinary spawn, editors, raw shell, other task tools, and foreign control roots or agent directories are outside prevention.
- There is no OS-global write exclusion, sandbox, or syscall monitor. Identity checks observe declared drift; they do not certify unmanaged writers.
- Distinct control roots and agent-directory identities do not exclude one another.
- Linux, private, and offline is the first publication boundary. Cross-host and DrvFS semantics are out of scope.
- Native spawn journals, lock recovery, default workflow/role surfaces, and Workroom product code are unchanged by this slice.
- Verification acceptance is not installed. Attempt `accepted` remains null. Fabricated acceptance is refused and unpublished.

## Domain address and enrollment

Persist exactly one v1 snapshot per enrolled control root:

`<canonicalControlRoot>/.gjc/managed-task-domain/state.json`

Do not hunt the filesystem, copy per session/run/graph, or treat `commonDir` as root authority. Enrollment is explicit: control root, agent directory, enrollment id, worktrees, and optional aliases that still resolve to an enrolled target.

`createManagedDomainBinding` records canonical real paths plus directory device/inode identities. Changed, unprovable, or escaped bindings refuse later admission. Aliases are accepted only while their real target remains the enrolled target.

## Permissions and publication

Opt-in Linux private durable source publication (state writer `privateDurable`) applies only to this domain subtree:

- newly created domain directory `0700`
- domain state file `0600`
- sync the written file before rename and the publication directory after rename
- establish and sync new directory entries, including initial subtree creation through the existing parent

Existing unrelated directories are never chmodded or repaired. An unsafe or unprovable existing subtree is rejected. Generic writer callers keep their existing corruption policy.

Publication uses existing `withWorkflowStateLock`, strict `readExistingStateForMutation`, and `writeGuardedJsonAtomic` with `policy: "source"`, `expectedRevision`, and `lockHeld: true`. The generic writer receives no Broker or DAG types. Do not nest `updateJsonAtomic` or reacquire the same non-reentrant lock.

Once a domain is established, missing, corrupt, unreadable, non-object, extra-key, or binding-mismatched state fails closed. Fresh enrollment (`expectedRevision === 0` and absent file) requires `assertNoManagedEvidence` under the domain lock; it must not initialize an empty replacement automatically. Post-rename sync or audit failure is potentially committed: reload authoritative state; never discard a reservation or retry with a new native key.

## Graph, resources, and byte roles

`ManagedTaskGraph` / `ManagedTaskDefinition` bind node id, task revision, graph revision, attempts, dependency vectors, criteria identity, resource declarations, and native references. Duplicate ids, missing predecessors, cycles, extra keys, empty validation lists, and unauthorized bindings are rejected before mutation.

Readiness is deterministic and dependency-based: a node is ready only from an accepted current predecessor verification vector, never from `terminal_ok`, accepted seed, valid JSON, or a closed worker. M1 stores reservations with `accepted: null`, so successors stay unready until later trusted verification.

Resource overlap is domain-wide across graph runs:

- read/read allowed
- overlapping read/write and write/write denied
- path identity uses canonical path plus object identity; absent outputs use ancestor identity and normalized suffix
- recursive directory overlap is segment-aware (`a` is not an ancestor of `ab`)
- same-object hardlinks conflict; unprovable symlink/escape paths fail closed
- parent namespace writes are required for create/delete/rename
- named resources use canonical database identity, port (protocol/address/number), and integration target; supported address wildcards conflict with concrete values

Byte roles (I0/P/V/Q/PV) are recorded on attempts. M1 captures admission input manifests and predecessor vectors; it does not accept produced output or validation results. Conflicting artifact roles and missing namespace writes refuse graph mutation.

## Dual lifetimes (policy only)

Reservations remain while either native-worker or validation lifetime is unproven. `canRetireManagedAttempt` is conjunctive: worker is `no-effect` or `closed`, validation is `not-started` or `finished`, and a current fence still requires accepted verification. Unknown validation cannot retire. Cancel and revise fence logical success and retain immutable attempt history; they do not rewrite old reservations or release unproven effects.

## Exported APIs for M2

Trusted internal policy surface in `src/sdk/broker/managed-task-dag.ts`. Not a public wire parser.

| Symbol | Role |
| --- | --- |
| `createManagedDomainBinding` | Explicit enrollment identities |
| `managedTaskDomainPath` | Exact snapshot address |
| `transactManagedTaskDomain` | Domain lock, strict read, schema/binding, source CAS, private durable write |
| `defineManagedTaskGraph` | Atomic graph insert under a held transaction |
| `admitManagedTask` | All-or-none reservation; returns private `ManagedAttemptRef` |
| `readyManagedTasks` | Deterministic ready node ids |
| `canonicalizeManagedResources` / `managedResourcesOverlap` / `managedResourcesConflict` | Canonical overlap |
| `parseManagedTaskDefinitions` / `validateManagedTaskDomain` | Fail-closed schema |
| `captureManagedManifest` / `assertManagedManifestCurrent` | Byte identity |
| `cancelManagedTasks` / `reviseManagedTaskGraph` | Fence without releasing unproven lifetimes |
| `canRetireManagedAttempt` / `retireManagedAttempt` | Conjunctive retirement |
| `managedIdentity` | Canonical digest |
| `ManagedAttemptRef` | Internal handoff after durable reservation; M2 keeps it private after verified Broker admission |

`ManagedAttemptRef` binds control root, enrollment id, agent-directory identity, graph/node/task/attempt revisions, definition/input/predecessor/resource identities, and the caller-supplied native `deriveIdempotencyIdentity` result. Caller fields cannot mint this object on the wire.

`transactManagedTaskDomain({ binding, expectedRevision, assertNoManagedEvidence? }, mutation)` is the only durable mutation entry. CAS losers recompute from fresh state. Competing same-resource writers: exactly one complete reservation at the next revision; the loser is stale/conflict. Disjoint writers may both admit after retry.

## M2 raw wire and auth (test-only)

`task.dag` is on the Broker WebSocket allowlist (`BROKER_OPERATIONS`). The documented initial interface is protocolVersion 3 loopback `broker_request` through `Broker.start()` discovery URL/token. There is no CLI, generated protocol, or generic lifecycle lookup for spawn.

Placeholder envelope (not live credentials):

`{type:"broker_request",id:"req-1",operation:"task.dag",input:{action:"advance",controlRoot:"<canonical enrolled root>",enrollmentId:"<enrollment>",graphId:"g1",nodeId:"n1",expectedRevision:7,ownerSessionId:"<owner>",attestationEpoch:"<epoch>",masterCapability:"<live capability>",maxAdmissions:2}}`

Actions: `define`, `advance`, `status`, `revise`, `cancel`, `verify`. All require authenticated transport plus live master capability/owner/epoch and exact domain binding. Mutations require `expectedRevision`. Public `pass`/`accepted`/`receipt` fields are refused. Worker `cwd` is the admitted node `workspace`; an explicit caller cwd that does not match is refused before reservation. Exact same-key `advance` observes the original unretired reservation and re-enters native claim recovery; it does not allocate a second attempt.

Public `session.spawn` and `task.dag` both verify the live capability, erase it, then use one private verified-admission path. `ManagedAttemptRef` is minted only after durable domain reservation; wire fields cannot create it. Ordinary `session.spawn` on a known managed native identity is rejected without that internal authority. If the enrollment index cannot be proven readable, ordinary spawn is refused with a bounded membership error rather than authorized as unmanaged. Unrelated keys remain unmanaged only while the index is provable. No graph fields enter the spawn-authority journal.

Native fences recheck the current managed vector and cancel fence immediately before `prepared -> substrate_starting` and before `seed_prepared -> dispatching`. Launch authorization and the native `prepared -> substrate_starting` transition share the domain lock, same as seed; the lock is released before `provider.launch`. Domain lock is also released before registration, prompt dispatch, close, or validation. Workspace is part of definition and native identity, so a workspace-only revision fences the old attempt.
Clients consume `broker_hello` once after connect, then match each `broker_response` by request `id`. A leftover hello or unmatched frame is not a later action's result.

Wrong transport token never reaches the broker. Correct token with wrong master capability yields domain writes 0 and native launches 0. Competing same-resource advance starts 0 additional effects; disjoint pair starts 2.

M3 restores enrolled managed-key protection on cold restart from the durable enrollment index at `<agentDir>/.gjc/managed-task-enrollments/index.json` plus the domain snapshot. An unreadable index cannot authorize ordinary unknown membership. Ordinary spawn still does not hunt `agentDir` or TMPDIR.

## M3 recovery and close

Startup restores unretired ManagedAttemptRef values from enrolled control roots whose agentDir identity still matches, then reconciles native journals before Broker discovery publication. Same native identity cannot start a second effect. Authenticated retry of the original key with a live revision observes the existing reserved attempt and resumes native `claimOrJoin` for `reserved`/`prepared`/`seed_prepared` after revalidating the immutable vector; it does not mint a duplicate reservation. `substrate_starting`, `dispatching`, response loss, `uncertain`, and missing authority observe worker `unknown` and retain reservations. Accepted seed or a terminal turn does not close the worker.

Cancel/revise first fences logical success, then exact owned close of attempts belonging to that graph identity and affected node ids only. A second graph that reuses the same node id keeps its child. Signal, `close_requested`, and timeout do not prove gone. Pre-send rejection with a substrate still needs close. Release remains conjunctive: worker no-effect or exact closed/gone, and validation not-started or finished. A closed worker does not retire an active/unknown validator. Missing or corrupt evidence blocks; there is no TTL, new-key retry, process hunt, or lock cleanup.
Cancel and revise require the caller's `expectedRevision` to equal the live domain revision (strict CAS). A stale caller view is conflict, not applied over unseen current state. After both lifetimes are proven quiescent, retirement can admit a replacement attempt for the current node revision.
`session.close` of an exact spawn child observes worker `closed` in the same broker lifetime, so `task.dag verify` does not require a broker restart.

## M4a shared asynchronous validation runner

`defaultFinalizeChecks(workspace).runValidation(spec)` remains the one shared executor. It still returns `{ exactCommand, cwd, exitStatus, pass }` from `bash -lc spec.command` in `workspace`. Existing owner callers already await that Promise; the signature is unchanged.

The body is asynchronous Bun.spawn, not spawnSync. stdout and stderr are continuously drained and discarded as they arrive; chunks are not retained as unbounded buffers and are not returned. Spawn failure (no process) is a terminal `pass: false` with `exitStatus` 1. After spawn succeeds, a failed stream or exit observation is not a finished `ValidationRun`: the runner kills, awaits real exit, and throws `ValidationObservationUncertainError` so managed verification stays unknown. The return never includes pid, receipt id, output paths, or process authority.

The existing owner and finalizer catch this typed uncertainty, return a blocked outcome, and issue no validation receipt for that command or completion receipt. Later commands and publication checks do not continue after the uncertain observation. Managed verification reports `unknown` consistently with durable state; `commandsStarted` is true for the call that invoked validation and false for a later observation-only retry.

Git and gh methods on the same object are unchanged. During a long validation the event loop stays free for timers, Broker heartbeat, and status.

## M4b trusted verification

`task.dag` action `verify` runs `verifyManagedTaskAttempt` against the shared `defaultFinalizeChecks(workspace).runValidation` executor. Public `pass`/`accepted`/`receipt` fields remain refused. Trusted PASS is published only after:

1. worker is exact `closed`
2. durable verification-start marker (`validation: running` + execution id/commands) is stored before any command
3. sequential approved nonempty criteria, each actual `ValidationRun` persisted
4. I0 read-only and predecessor PV bytes still match, produced P frozen through V, Q on declared validation-output artifact roots including recursive children of a declared Q directory (paths outside those Q roots fail closed). Role roots are the declared artifact paths; recursive resources authorize coverage only and do not erase a declared input or enlarge P/Q to a covering workspace reservation.
5. existing `buildReceipt`/`validateReceipt` envelopes stored privately with owner sessionId, exact workspace, internal source, exitStatus 0 and pass true
6. domain CAS publishes `accepted` + `validation: finished`

Duplicate verify while running/unknown/finished starts 0 additional commands. Repeat verify of a current accepted attempt returns the existing trusted receipt only while fence is `current`, the attempt matches the current node definition/taskRevision, and I0/P/PV bytes still match; drifted bytes refuse a stale PASS. Historical accepted receipts after cancel/revise are not current PASS. Recursive children of a declared input/output artifact remain in I0/P/V/PV; a shared recursive write reservation over the workspace does not promote that reservation into the input or output role. The first failed criterion records `validation: finished` with `fence: failed` and the proven observations only; later commands do not run and the result is not `unknown`. Internal verification mutations recompute under the domain lock. `accepted.hash` is the stored receipt envelope `sha256`, not a composite digest. Start marker without finish, or receipt publication failure, becomes `validation: unknown` and retains reservations. A corrupt domain snapshot remains fail-closed (`managed-task: corrupt authority`); it is not re-initialized. Cancel/revise fence immediately; an active or unknown validator is not retired by worker close. Restart reconciles running markers to unknown before discovery publication. No PID authority, extra daemon, or client-uploaded PASS.

## Remaining limits

- Unknown validator recovery still requires independently authoritative evidence outside v1 automatic recovery.
- No new daemon, database, or lock-recovery path.
- Feature completeness waits for later connected offline acceptance.

## M5 revision and invalidation

`reviseManagedTaskGraph` validates the whole replacement graph, then seeds from changed task/criteria/resources/artifacts/validations/predecessor sets (including removed nodes and edges). Downstream closure is the union of old and new edges. Affected current attempts are fenced `superseded`; already canceled fences stay canceled. Immutable attempt history and reservation sets are retained. Global graph revision alone is not staleness: an unchanged T/I0/P/V/PV vector keeps its current PASS.

Successor eligibility still requires a current accepted predecessor vector and live consumed P bytes at admission. Cache-only Q writes are not predecessor inputs. A late verify cannot mint PASS after cancel/revise wins the domain transaction. `reducedWorkroomManagedDefinitions` is a native fixture for S5→UI1a→S8→UI1b→UI2, S5→S6→S7→S8, S8→S10a→S10b, optional S8→S9a→S9b; S11 is not a common prerequisite. Workroom product code is not edited.
Stored definition hashes are computed from JSON-canonical schema output so reload matches insert. Independent concurrent writers must declare disjoint write namespaces; a shared parent-directory write remains a real conflict.

## M6 connected offline boundary

Connected offline tests exercise authenticated `task.dag` WebSocket frames through `Broker.start()`, native spawn claim/launch/seed, shared `defaultFinalizeChecks.runValidation`, and trusted domain PASS. They do not enable a user-facing release.

Scenario inventory (parent gates):
Connected tests fetch live `task.dag` `status.stateRevision` before later define/advance/revise after native observation writes; they do not guess CAS counters.

1. Independent writers 2 launches; overlapping writer 0 extra effects. Wrong transport token and wrong master capability yield launches 0.
2. Same graph defines A then B. Same-broker-lifetime `session.close` observes worker `closed`, then verify PASS, then advance B consuming A's accepted P/PV and producing B's output.
3. Failed predecessor: close and verify A first (`exit 7` / absent required output, no accepted PV), then advance B is effects 0.
4. Response-loss then restart: same native identity launches 0 duplicates; ordinary spawn on the managed key is refused. This is spawn-uncertain retention, not a live validation-unknown start-marker.
5. Graph revise with live expectedRevision fences superseded attempts; stale expectedRevision is rejected. Reservations stay until both lifetimes are proven.

Honest limits: there is no OS-global write exclusion. Ordinary spawn, editors, and raw shell remain outside prevention. Undeclared sibling files are not a Q-isolation gate; Q isolation is declared validation-output roots and their children. Connected e2e kills a test-owned Broker after its shared validator starts, then checks recovered uncertainty, retained reservations, and a countable single invocation. It does not certify recovery from every OS or validator failure. Feature-complete requires independent architect/critic review of these gates; this slice is not a release advertisement.
