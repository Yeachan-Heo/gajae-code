# Model-profile ownership invariants (PM proposal)

Status: **PM PROPOSAL — awaiting upstream design approval. Not implemented and not approved behavior.**

Issue: [#5585](https://github.com/Yeachan-Heo/gajae-code/issues/5585)

Measured `dev`: [`5b26c07d98c78b550b9847d473b9d798a2689c2b`](https://github.com/Yeachan-Heo/gajae-code/tree/5b26c07d98c78b550b9847d473b9d798a2689c2b)

No profile-lifecycle implementation should begin until upstream approves this ownership contract. This document records the requested product decisions; it does not independently approve them.

## Problem and current behavior

On measured `dev`, `modelProfile.default` is a persisted setting whose UI description says it is applied at startup, while `modelRoles` is a separate persisted record ([settings schema](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/config/settings-schema.ts#L670-L680)). Runtime overrides are stored separately and explicitly do not persist ([settings override API](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/config/settings.ts#L1019-L1048)). Profile activation nevertheless installs runtime role layers, may clear and rewrite durable role/profile settings, then flushes them when `persistDefault` is requested ([activation apply](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/config/model-profile-activation.ts#L1276-L1352)). Its rollback restores captured values with later writes, not an explicit cross-session compare-and-swap ownership rule ([activation rollback](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/config/model-profile-activation.ts#L1353-L1455)).

The current session marker is an in-memory string. New-session logic conditionally removes session-only layers but retains a marker matching the durable default ([reset policy](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/session/agent-session.ts#L16556-L16603)); switching reconstructs the marker from either the live marker, configured profile, or saved chain identity according to resume mode ([switch reconstruction](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/session/agent-session.ts#L24254-L24312)). Profile deletion currently materializes effective bindings into durable role settings before removing the durable profile marker ([deletion materialization](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/config/model-profile-activation.ts#L1496-L1558)). These are current code facts, not the proposed target.

Startup and SDK also derive profile identity in different places: CLI startup reapplies the configured profile ([CLI startup policy](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/main.ts#L473-L550)), while SDK construction combines an inherited marker, saved-chain identity, and resume behavior ([SDK construction](https://github.com/Yeachan-Heo/gajae-code/blob/5b26c07d98c78b550b9847d473b9d798a2689c2b/packages/coding-agent/src/sdk/session.ts#L1909-L1977)). Neither constitutes the target ownership contract below.

## Proposed state model and invariants

Every invariant in this section is a **PM PROPOSAL awaiting upstream design approval**.

| State | Owner and lifetime | Marker | Precedence | Persistence rule |
| --- | --- | --- | --- | --- |
| Durable profile baseline | Config store; shared by future sessions | `profile(name, version)` | Lowest profile layer; supplies defaults only where a higher layer is not explicit | Written only by an explicit durable command using CAS |
| Durable explicit clear | Config store; shared by future sessions | `cleared(version)` tombstone | Suppresses profile fallback; it is not absence | Written only by explicit durable clear using CAS |
| Session profile override | One session identity | `profile(name, sourceVersion?)` | Above durable baseline | Never writes durable state implicitly |
| Session explicit clear | One session identity | `cleared` tombstone | Suppresses both saved-session profile and durable fallback for that session | Saved with the session when session state is persisted; never converted to absence |
| No session decision | One session identity | `inherit` | Consult durable baseline, including its tombstone | No write |
| Runtime recovery | One process/session instance | `recovery(profile, cause)` diagnostic only | Supplies a callable model only after saved-model recovery qualifies | Never persisted and never replays profile lifecycle |

The effective state is computed from immutable inputs in this order: session tombstone or session profile; otherwise durable tombstone or durable profile; otherwise ordinary role/model baselines. `cleared` is a value. It must survive serialization, fork, resume, and deletion chains and must never be interpreted as “missing, therefore fall back.”

| Layer | Baseline | Profile contribution | Override/clear rule |
| --- | --- | --- | --- |
| Default model chain | Durable ordinary `modelRoles.default` | Effective profile default chain | Session concrete-model or profile selection is session-local unless explicitly committed; clear reveals the non-profile ordinary baseline, not another profile |
| Named model roles | Durable ordinary `modelRoles` | Profile-owned keys overlay the ordinary baseline | Omitting a role removes the prior profile contribution and reveals the ordinary baseline |
| Agent model overrides | Durable ordinary `task.agentModelOverrides` | Profile-owned agent keys overlay the ordinary baseline | Same replacement semantics as named roles; no predecessor-profile leakage |
| Active marker | Durable baseline plus session decision | Identifies the owner of installed profile layers | Marker and installed-layer ownership change atomically |

Durable config is the persisted baseline. A session-local activation, concrete selection, clear, resume, new session, switch, or fork must not implicitly mutate it. Durable activation and durable clear are separate explicit commands. Materializing effective profile values into ordinary durable role settings is not an implicit side effect of session activity or profile deletion.

## Proposed transition contract

Each transition operates on a snapshot `(sessionState, durableVersion, effectiveState)`. “Commit” below is the single visibility point only for the live, serialized requesting-session transition: that session does not serve requests with the new effective state until validation, required persistence, and runtime installation finish. A durable CAS is independently visible and authoritative as soon as it commits; this proposal does not claim atomic visibility across processes or across a process crash.

| Transition | Old state | New state | Persistence commit point | Emitted event | Failure/rollback |
| --- | --- | --- | --- | --- | --- |
| Switch/resume | Source session decision + durable snapshot | Target saved decision; `inherit` consults the latest durable snapshot, `cleared` suppresses fallback | Target session load/validation is durable and its ownership snapshot is installed | One post-commit `profile_ownership_changed` with old/new markers and session ids; existing `session_switch` follows the same boundary | Restore the complete source effective snapshot; no event |
| New | Current session decision | `inherit` over the latest durable baseline | New session identity and initial ownership marker are durable | One post-commit ownership event, then `session_switch(reason=new)` | Keep old session/effective state; no event |
| Fork | Parent decision and the durable version it observed | Exact copy of the parent session marker, including `cleared`; thereafter independent | Fork file and copied ownership marker are durable before adoption | One post-commit ownership event, then `session_switch(reason=fork)` | Keep parent authoritative; discard uncommitted fork; no event |
| Session clear | Any session marker | Session `cleared` tombstone; ordinary non-profile baseline becomes effective | Tombstone is appended with the context-clear transaction | One post-commit ownership event | Restore old context and effective snapshot; no event |
| Explicit durable switch | Durable profile/tombstone at version `v` | Durable profile at `v+1`; requesting session may separately choose `inherit` | CAS write of the complete baseline record; requesting-session visibility waits for runtime installation | Emit success only after the live requesting session installs its effective state; a crash may leave committed durable state with no success notification | Before CAS, retain old state; CAS conflict retains the winner; after a committed CAS, crash reconciliation treats the durable version as authoritative |
| Explicit durable clear | Durable profile/tombstone at `v` | Durable `cleared(v+1)` | CAS write of the tombstone; requesting-session visibility waits for runtime installation | Same live-session boundary and crash caveat as durable switch | Same conflict and crash-authority rules; absence is never written as the clear signal |

No hidden cross-session broadcast is permitted. A durable commit makes new state available to later startup, restore, reconciliation, new session, or explicit refresh; it does not mutate already-running surviving sessions. Event payloads must include transition id, source (`session`, `durable`, or `recovery`), old/new markers, observed durable version, committed version when applicable, and outcome. Failed attempts may emit a diagnostic failure event, but never the success event. Delivery is best-effort, not exactly once: absence of a success notification means the outcome is unknown and requires a durable read, not that the CAS rolled back. Reconciliation reports its own diagnostic outcome and never replays the missing transition success event.

### Version and rollback ownership

The durable baseline is one CAS-owned record with a monotonically increasing version. A transition that intends a durable write supplies its observed version. The config layer commits only if that version is still current. During the same live process, rollback may restore runtime/session state from its snapshot, but may reverse a durable write only with a CAS receipt proving that the transition still owns the exact committed version. After process crash or restart there is no rollback owner: the committed durable version is authoritative and must not be reversed from a stale session snapshot. If another writer has advanced the version, neither live rollback nor restart reconciliation may write captured old values over it; they report `concurrent_write_conflict`, re-read the winner, and recompute the requesting session's effective state.

| Persistence outcome | Durable result | Session result | Event result |
| --- | --- | --- | --- |
| Validation fails before write | Unchanged | Restore old effective state | Failure diagnostic only |
| CAS succeeds, runtime apply succeeds | New version retained | Install new effective state | One success event after both are ready |
| CAS conflicts | Newer writer retained | Old session state or recomputed state, per explicit operation contract | Conflict diagnostic; no success event |
| CAS succeeds, runtime apply fails in the same live process, transition still owns version | CAS rollback to a new compensating version or fail closed, as upstream chooses | Restore old effective state | Failure diagnostic records compensation |
| CAS succeeds, runtime apply fails, newer write exists | Newer writer retained; never overwrite it | Recompute from newer durable state while preserving explicit session marker | Conflict/failure diagnostic; no stale rollback write |
| Session persistence fails | Durable state untouched unless separately and explicitly committed | Restore complete old effective snapshot | No success event |

### Crash reconciliation and retries

On startup or restoration after an interrupted durable transition, the session must reconcile before serving requests. It reads the current durable baseline, then recomputes effective state from that baseline plus still-valid session-local `profile`, `cleared`, or `inherit` layers. Reconciliation is not transition replay: it neither reconstructs a missing success notification nor repeats the original CAS.

| Crash boundary | Authoritative state | Reconciliation/event result |
| --- | --- | --- |
| Before CAS | Previously committed durable version | Restore from that version plus valid session-local layers; no transition success event |
| After CAS, before runtime/session install | Newly committed durable version, unless a later writer won | Discard stale effective layers derived from the older version and recompute before serving; emit reconciliation diagnostics only |
| After runtime/session install, before success event | Current durable version plus the persisted valid session marker | Recompute idempotently; missing success remains an unknown notification outcome and is not replayed |
| A later durable write exists | Latest durable version | Never restore or compensate an older version; recompute against the winner and report the conflict |
| Reconciliation cannot produce a valid effective state | Current durable version remains authoritative | Fail closed before serving model requests, preserve diagnostic session intent, and require explicit repair; do not roll back durable state or emit transition success |

A retry after an unknown outcome first reads the current durable version and desired value. If the desired durable value already committed, it reconciles without another write or success-event replay. Otherwise it starts a new transition with a fresh observed version and transition id; a stale retry must fail CAS rather than clobber a later write.

## Deletion, cleared chains, and recovery

| Input chain | Proposed result |
| --- | --- |
| Session `profile(P)`; `P` is deleted | Preserve the marker as unresolved diagnostic intent; fail closed or require explicit replacement. Do not fall through silently. |
| Session `cleared`; any durable state | Remain cleared. |
| Session `inherit`; durable `profile(P)`; `P` is deleted | Durable owner performs an explicit CAS transition to a replacement or `cleared`; sessions do not materialize `P` into ordinary settings. |
| Session `inherit`; durable `cleared` | Remain cleared. |
| Saved model deleted, profile still valid | Eligible for runtime-only saved-model recovery; saved intent and all lifecycle markers remain unchanged. |
| Recovery target fails | Restore the prior effective runtime snapshot; do not replay activation, deletion, switch, or clear. |

PR [#5512](https://github.com/Yeachan-Heo/gajae-code/pull/5512) is separate, unmerged recovery work. It still has exact head [`9bf0154131f317bb9f74bf90ca0f4871267eebbf`](https://github.com/Yeachan-Heo/gajae-code/tree/9bf0154131f317bb9f74bf90ca0f4871267eebbf) at measurement time and explicitly restricts recovery to saved selectors that are absent from the full catalog before resolving the durable profile default ([guard and resolver](https://github.com/Yeachan-Heo/gajae-code/blob/9bf0154131f317bb9f74bf90ca0f4871267eebbf/packages/coding-agent/src/config/model-profile-activation.ts#L650-L719)). It installs an in-memory fallback controller with runtime origin rather than changing saved intent ([runtime installation](https://github.com/Yeachan-Heo/gajae-code/blob/9bf0154131f317bb9f74bf90ca0f4871267eebbf/packages/coding-agent/src/session/agent-session.ts#L16875-L16911)). That behavior is neither on measured `dev` nor an ownership design approval. This proposal preserves its boundary: deleted saved-model recovery is runtime-only and must not replay profile lifecycle. The implementation of #5512 itself is out of scope here.

## Startup and SDK propagation boundaries

| Surface | Inputs | Output | Forbidden propagation |
| --- | --- | --- | --- |
| CLI startup | Current durable baseline version, saved session marker, explicit CLI selector | Reconciled ownership snapshot before requests are served; explicit CLI selection is session-local unless an explicit durable command was requested | No startup write merely because effective state was reconciled; no replay of a missing success event |
| SDK create | Caller session marker or `inherit`, current durable snapshot | Same reconciliation resolver and snapshot shape as CLI | No independent marker inference from mutable runtime layers |
| SDK resume/switch | Saved marker, current session marker, resume policy, current durable snapshot | Same transition and pre-serve reconciliation contract as CLI/TUI | No direct durable mutation, success-event replay, or broadcast to sibling sessions |
| SDK fork/new/clear | Same transition inputs and commit points defined above | Same marker semantics, including tombstones | No SDK-only fallback semantics |
| Running sibling session | Its own committed snapshot | A surviving session remains unchanged until explicit refresh or its next defined transition; a restored session reconciles before serving | No hidden reaction to another session's durable commit |

CLI, TUI, and SDK must call one ownership resolver/transition contract. They may adapt errors and presentation, but may not reconstruct ownership independently.

## Test plan (no executable tests in this proposal)

| Area | Planned evidence |
| --- | --- |
| Marker matrix | Table tests for durable/session `profile`, `cleared`, and `inherit`, including every precedence pair |
| Role/agent layers | Prove omitted profile keys reveal the ordinary baseline, prior-profile keys do not leak, and session activation performs zero durable writes |
| Switch/new/fork/clear | For every row above, assert old/new state, exact persistence boundary, one success event, and complete rollback before commit |
| Tombstone/deletion | Resume and fork preserve clear; deletion never turns clear into absence or materializes profile bindings implicitly |
| CAS conflicts | Deterministically interleave two durable writers and a failing runtime apply; prove the newer durable version is never overwritten |
| Crash boundaries | Simulate crash before CAS, after CAS/before install, and after install/before event; then cover a later newer durable write and failed reconciliation |
| Event ordering | Success event only after live persistence and effective-state installation; prove missing notification is unknown outcome, reconciliation does not replay success, and failure/conflict paths never emit success |
| Retry semantics | Retry each unknown-outcome state; prove already-committed intent causes read/reconcile only and stale versions cannot overwrite a newer winner |
| Startup/SDK parity | Feed identical snapshots to CLI and SDK construction/resume and assert identical ownership/effective results |
| Recovery separation | With #5512 behavior available, prove recovery changes only runtime fallback state and emits no profile lifecycle mutation/event |

These are planned contract tests for a later approved implementation, not tests claimed to exist or pass in this documentation change.

## Approval questions and scope

Upstream must approve the event name/payload, whether a still-live owner may compensate its own failed durable commit with a new version or must fail closed, and the operator-facing behavior for references to deleted profiles. Crash/restart recovery is not an owner and always treats the current durable version as authoritative. Until those questions and the invariants above are approved, lifecycle implementation is explicitly unresolved and must not start.

Out of scope: model discovery, compaction, and implementation of #5512. This proposal does not merge or close either issue or PR.
