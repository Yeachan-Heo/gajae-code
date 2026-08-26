/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

/** Telegram transport generation; independent from SDK lifecycle protocol changes. */
export const TELEGRAM_TRANSPORT_GENERATION = 1;

/** Notification event schema version; payload compatibility is versioned separately. */
export const NOTIFICATION_EVENT_SCHEMA_VERSION = 1;

/** SDK Router/lifecycle protocol negotiated by core, not by Telegram transport. */
export const SDK_LIFECYCLE_ROUTER_PROTOCOL_VERSION = 1;

/**
 * Guarded behavior-inventory version for the current daemon build. Bump this
 * on every guarded daemon-behavior change independent of the wire version; it
 * does not force a live daemon reload by itself.
 * The current development baseline already includes #2299's generation 4,
 * incarnation fencing in generation 5, owner-lock authority in generation 6,
 * identity-atomic transition markers in generation 7, stable signaling plus
 * tri-state foreign-owner provenance in generation 8, retained managed
 * filesystem authority changes in generation 9, SDK-startup auto-reclaim of a
 * confirmed-dead owner's lock in generation 10, legacy stopped-tombstone
 * reclamation in generation 11, force-escalated SIGKILL of an unresponsive
 * older-generation owner during automatic generation-upgrade reload in
 * generation 12, restored macOS daemon signaling (kill(2) with a start-time
 * incarnation recheck, replacing the darwin no-op) in generation 13, retained
 * legacy stopped-lock reclamation in generation 14, Windows expected-identity
 * ACL verification and repair in generation 15, identity-fenced stale endpoint
 * startup recovery in generation 16, Telegram topic recovery authority fencing
 * in generation 17, fail-closed blank-token validation plus lifecycle-startup
 * stop fencing in generation 18, recommended ask metadata rendering in
 * generation 19, authoritative terminal session-close delivery and cleanup
 * fencing, attested generation-bearing pre-incarnation owner handoff in
 * generation 20, guarded modern generation-absent predecessor signaling in
 * generation 21, dead Windows v0.10 owner replacement in generation 22, and
 * retained native cleanup authority revalidation in generation 23, and typed
 * retained exact-unlink cleanup authority acceptance (concrete detached
 * quarantine plus proven canonical absence) in generation 24.
 * Generation 25 adds startup dead-root prune + leak-artifact self-heal
 * on TelegramNotificationDaemon.run (#2958). Generation 26 adds bounded reload
 * cooldown and lazy Telegram topic lifecycle safeguards (#2956, #2960, #2984).
 * Generation 27 refreshes retained native path and process authority semantics.
 * Generation 28 rejects special files before retained native authority opens.
 * Generation 29 adds serving-epoch compatibility, sidecar heartbeat, root GC,
 * and Bot API cooldown structural fixes (#2956, #2960, #3048).
 * Generation 30 adds opt-in tool activity delivery, closed lifecycle phases,
 * and capability-versioned mixed-host compatibility. Generation 31 rolls out
 * non-Linux direct tmux lifecycle cleanup semantics. Generation 32 applies
 * Telegram sound-notification policy across daemon delivery paths. Generation
 * 33 adds action-bound multi-select state rendering and replay-safe option
 * snapshots. Generation 34 converts non-photo image formats (including WebP)
 * into Telegram-compatible photo uploads when possible. Generation 35 adds
 * user-created topic adoption (forum-topic folder picker). Generation 36 bound
 * managed-session replacement to exact native filesystem authority; generation
 * 37 retires that binding (revert of #3489, which stalled POSIX artifact
 * cleanup); generation 38 binds exact cleanup to parent and link-count authority.
 * Generation 39 applies rustfmt and clippy-equivalent cleanup to the pi-shell
 * process-tree authority (#3682); generation 40 hardens exact Bash process-tree
 * ownership, settlement, and descendant cleanup authority. Generation 38 also
 * adds durable provider-intent admission without changing owner, reclaim,
 * signal, or spawn authority.
 * Generation 41 applies first-class provider-settings admission to Telegram
 * lifecycle controls, plus cross-host topic-registry CAS convergence, host-and-epoch
 * archive fencing, retained topic history, user-topic adoption provenance, and
 * exact versionless shared-state upgrades with quarantined source snapshots.
 * Generation 42 applies first-class provider-settings admission to Telegram
 * lifecycle controls. Generation 43 applies identity-bound exact replacement
 * cleanup shared by managed-session and daemon filesystem authority. Generation
 * 44 makes callback recovery restart-safe by revoking persisted routes and
 * callback receipts durable before routing and binds aliases to exact asks.
 * Generation 46 stages accepted callback activation and makes callback
 * consumption transactional under exact pending and lease authority. Generation
 * 47 settles failed staged revocation and guards the complete callback authority
 * and polling dependency chain. Generation 48 uses crash-durable callback
 * receipts, a legacy-disjoint random alias namespace, and exact topic leases.
 * Generation 49 drains every admitted session-message handler before final
 * durable persistence and ownership release. Generation 50 resolves intermediate
 * notifications-directory symlinks before native exact unlink while keeping
 * final-component file symlinks fail-closed under AT_SYMLINK_NOFOLLOW (bounded
 * #3761 multi-account activation repair). Generation 51 adds shared durable
 * topic authority, archive recovery, and requires Telegram's documented error
 * code for idempotent archive settlement. Generation 52 is claimed by the
 * pre-readiness daemon-child exit diagnostics slice (#3761). Generation 53
 * renders multi-select state for ask-tool asks, not only durable workflow
 * gates, and renumbers pre-numbered options exactly once around the selection
 * marker. Generation 54 records owner `stoppedAt` on unclean daemon death
 * (`markDaemonOwnerStopped` + postmortem/finally wiring) so a dead process
 * cannot keep advertising itself as the ready owner (#3965). Generation 55
 * contains a shared-topic-authority outage: a failed lease renewal on the
 * liveness heartbeat and a failed startup registry load are reported instead
 * of escaping to the process-level fatal handler, authority-failure throws
 * preserve their underlying cause, and the compensation fence retry is bounded.
 * Generation 56 moves exact unlink and process-incarnation authority behind
 * lazy native bindings for the startup-cost cut (#3846). Generation 57 clears
 * disconnect-grace-only fields whenever a topic enters an archive state, so
 * one stale session cannot make the shared registry unreadable and block every
 * later session from creating a topic or replaying notifications. Generation
 * 58 preserves that invariant during durable-fence load promotion and restores
 * the exact grace deadline when a failed archive publication rolls back.
 * Generation 59 moves lifecycle and attachment authority into SDK core,
 * removes provider root scanning and direct endpoint credentials, and rebuilds
 * Telegram presentation bindings from SessionRouter attachments. Generation 60
 * persists Router publication receipts, awaits inbound attachment dispatch,
 * restores actor-scoped create throttling, and exact-unlinks ownership locks.
 * Generation 61 durably claims provider publication identities before dispatch
 * and retains ambiguous claims across restart to prevent duplicate effects.
 * Generation 62 confirms receipts only from accepted provider outcomes,
 * retains queued/fallback claims, and quarantines legacy v1 confirmations.
 * Generation 63 applies the same deferred confirmation boundary while draining
 * replay-state and live-held frames during attachment recovery.
 * Generation 64 additionally defers stale-lease frames, requires authoritative
 * model message IDs, and retains claims when continuation admission fails.
 * Generation 65 treats malformed or unknown Bot API responses as ambiguous
 * rather than accepting them without a provider receipt.
 * Generation 66 propagates publication identity through selected and ephemeral
 * direct effects, retries definite pre-send route failures, and aggregates the
 * worst continuation disposition before confirmation.
 * Generation 67 quarantines oversized persisted receipt maps and retains claims
 * for pending-topic frames evicted before provider delivery.
 * Generation 68 releases claimed BTW publications when shutdown prevents dispatch.
 * Generation 69 settles selected acknowledgements and queued BTW publications
 * only from positive Telegram message receipts.
 * Generation 70 separates queued claims from provider-attempt ambiguity so
 * pre-send work remains replayable after daemon restart.
 * Generation 71 preserves queued state through cooldown/shutdown suppression and
 * never converts replay-suppressed ambiguity into delivered confirmation.
 * Generation 72 keeps invalid selected publications queued and mirrors attempted
 * BTW rejection outcomes across duplicate publication identities.
 * Generation 73 reports queued publication disposition to SessionRouter so
 * same-process reconnect retains the unadvanced replay cursor.
 * Generation 74 serializes each Router frame until its durable publication state
 * becomes attempted or delivered, preserving sequence order without cursor gaps.
 * Generation 75 routes every direct effect through the suppression-aware adapter
 * and gives each publication queue item a non-coalescing identity.
 * Generation 76 adds durable terminal rejection for invalid direct frames and
 * confirms accepted non-OK BTW status publications before returning.
 * Generation 77 bounds terminal rejection receipts alongside delivered receipts.
 * Generation 78 retries stale direct authority before dispatch and terminalizes
 * intentionally superseded queued live publications.
 * Generation 79 preserves rejected state through outer/replay confirmation and
 * settles publication-level continuation and retry barriers.
 * Generation 80 terminalizes every no-dispatch queue branch and revalidates
 * terminal publication state after cooldown waits.
 * Generation 81 terminalizes flat, pending, and stopped-pool no-dispatch work
 * and removes the raw Router Broker mutation tunnel.
 * Generation 82 terminalizes expired and out-of-band queue removals, defers BTW
 * completion across all chunks, and classifies definitive direct rejections.
 * Generation 83 terminalizes pending frames discarded during topic flush.
 * Generation 84 closes policy/archive/selected direct waiter cleanup and routes
 * pre-identity threaded output through flat delivery instead of a blocked queue.
 * Generation 85 removes the obsolete pending-frame admission path entirely.
 * Generation 86 terminalizes queued selected acknowledgements during shutdown.
 * Generation 87 routes every run-loop exit through the publication stop boundary.
 * Generation 88 rejects all queued publications before Router shutdown, disables
 * implicit provider retries, and durably joins receipt persistence.
 * Generation 89 rejects all pool submissions once a stop is requested.
 * Generation 90 terminalizes replay-queued publications before Router shutdown.
 * Generation 91 routes selected-ack retries through the stop admission fence.
 * Generation 92 rejects Router waiters when terminal receipt persistence fails.
 * Generation 93 aborts provider delivery immediately and resets failed settlement
 * resolvers before same-daemon replay.
 * Generation 94 wires the immediate delivery abort into every publication call.
 * Generation 95 propagates selected-ack receipt persistence failure to Router.
 * Generation 96 routes rich-draft delivery through the publication abort boundary.
 * Generation 97 bounds strict tool terminalization with shutdown abort authority.
 * Generation 98 applies delivery abort authority to every supervised Bot API call.
 * Generation 99 propagates generic terminal receipt persistence failure to Router.
 * Generation 100 centralizes terminal receipt failure propagation in state transitions.
 * Generation 101 isolates batch terminal failures and replays rejected rollback.
 * Generation 102 isolates expired and superseded pre-batch receipt failures.
 * Generation 103 fences and joins Router reconciliation during stop.
 * Generation 104 prevents Router timer installation after concurrent stop.
 * Generation 105 revokes attachment capabilities immediately when Router stop begins.
 * Generation 106 isolates every Router client close attempt during shutdown.
 * Generation 107 joins reconnect replay within Router pending shutdown work.
 * Generation 108 interrupts replay requests immediately when Router stop begins.
 * Generation 109 isolates stale attachment client and provider cleanup failures.
 * Generation 110 installs replay stop handling before starting the request.
 * Generation 111 isolates replacement client and provider cleanup failures.
 * Generation 112 preserves provider handoff while isolating replacement close failure.
 * Generation 113 removes old provider authority when replacement races stop.
 * Generation 114 removes successor provider authority when handoff races stop.
 * Generation 115 removes provider authority for every attachment disposed by stop.
 * Generation 116 creates publication waiters only after claim admission succeeds.
 * Generation 117 exposes tentative claims to concurrent teardown and aborts revoked admission.
 * Generation 118 prevents failed concurrent rejection from reviving tentative claims.
 * Generation 119 bounds Router stop and preserves rejected failed continuations.
 * Generation 120 awaits provisional rejection durability before replay suppression.
 * Generation 121 fences bounded-stop continuations from later Router runs.
 * Generation 122 fences every nested replay suppression on rejection durability.
 * Generation 123 scopes stale Router errors to their originating run epoch.
 * Generation 124 detaches restart tails and restores rejected rollback as replayable.
 * Generation 125 prevents stale run cleanup from deleting restarted attachments.
 * Generation 126 fences stale callback bookkeeping and distinguishes definitive rejection.
 * Generation 127 keeps malformed accepted selected sends transport-ambiguous.
 * Generation 128 bounds Discord provider work before Router revocation.
 * Generation 129 bounds every Discord REST operation across retries.
 * Generation 130 invalidates Discord effect lease renewal when shutdown drain expires.
 * Generation 131 invalidates Discord effect leases at the journal mutation boundary.
 * Generation 132 invalidates Discord create-intent leases at drain expiry.
 * Generation 133 serializes Discord creator invalidation with in-flight admission.
 * Generation 134 durably restores replay after definitive provider rejection.
 * Generation 135 revokes attachments whose provider publication hook rejects.
 * Generation 136 keeps provider attachment publication provisional until recovery succeeds.
 * Generation 137 fences stale reconciliation, frame tails, and identity-less replay rejection.
 * Generation 138 starts provider handshakes only after Router publication.
 * Generation 139 privatizes raw SDK clients and removes the Python transport package.
 * Generation 140 retires failed handshakes and holds provisional frames until publication.
 * Generation 141 awaits the provider handshake before Router replay to prevent retained-event deadlock.
 * Generation 142 migrates live adoption reservations and applies create throttling to topic adoption.
 * Generation 143 preserves topic presentation continuity across exact Router endpoint replacement.
 * Generation 144 revalidates endpoint authority before exact publication-time requests.
 * Generation 145 distinguishes transport reconnect from a changed same-generation endpoint successor.
 * Generation 146 revokes token-zero and callback leases before endpoint replacement while retaining topic presentation.
 * Generation 147 uses a restart-stable opaque Router endpoint-incarnation identity.
 * Generation 148 classifies reconnect-time endpoint successors before attachment retirement.
 * Generation 149 serializes successor attachment behind predecessor provider retirement.
 * Generation 150 version-fences attaches already in flight when retirement begins.
 * Generation 151 preserves provider continuity for endpoint-before-index replacement cleanup.
 * Generation 152 contains a thrown steady heartbeat renewal in the run loop
 * (a transient EPERM/EACCES/EBUSY on the state or ownership-lock read) the
 * same way instead of terminating the daemon (#4200).
 * Generation 153 restricts Telegram forum-topic ownership, replay, routing, callbacks,
 * and lease renewal to identities with coordinator or lifecycle provenance.
 * Generation 154 archives private-chat topics through deleteForumTopic, settles
 * TOPIC_ID_INVALID as definitive, and drains durable archive retries periodically.
 * Generation 155 unifies the duplicated durable terminal-retention write path
 * (bus and SDK-only host runtimes) into a single `boundTerminalRetentionState`
 * helper in `session/terminal-abort.ts` (#4329).
 * Generation 156 derives Telegram session eligibility from configuration
 * (Telegram configured and effectively enabled) instead of coordinator or
 * lifecycle launch provenance, and stops consulting a session's self-declared
 * eligibility for topic admission: threaded mode always uses threads. Before
 * this, every ordinary interactive session declared itself ineligible, the
 * daemon rejected its identity header, no topic was created, and nothing was
 * delivered while attachments still looked healthy.
 * Generation 157 adds orphan-topic reconciliation: FORUM_TOPIC_NOT_FOUND is
 * settled as definitive, and the unsupported-method fallback closes when
 * deleteForumTopic is unavailable on older Bot API deployments.
 * Generation 158 updates terminal-abort notification admission and cleanup semantics.
 * Generation 159 fences the Windows process-incarnation authority: the native
 * binding fallback no longer spawns powershell.exe when it cannot bind a pid,
 * so older daemons that may still flash a console window during liveness polling
 * are fenced off (#4362).
 * Generation 160 introduces provider-local Telegram subscriptions, detached
 * cleanup, stable topic bindings, and explicit archive authority. Older daemons
 * retain attachment-level lifecycle coupling and may not serve this contract.
 * Generation 161 completes that authority split: archive reasons and cleanup
 * receipts are durable, topic recovery no longer reconstructs SDK endpoint
 * authority, and replay generation cannot mutate lifecycle authority.
 * Generation 162 removes chat-daemon ownership from the session-open critical
 * path: the host acquires provider ownership only AFTER publishing its core
 * endpoint, through a single-flight coordinator keyed to the full provider
 * identity, and never awaits it on a lifecycle path. The daemon also sweeps
 * inert notification-dir debris at startup. Older daemons assume ownership is
 * proved before publication and do not perform that sweep. Generation 165
 * preserves a bounded lean settlement window across autonomous continuations,
 * so the Telegram terminal receipt cannot lose a prior user-request result.
 * Generation 166 introduces complete owned process-group cleanup (killTree
 * instead of root-only signalRoot), identity-fenced orphan-owner reconciliation
 * in the daemon run loop, pre-poll stale-poller fencing, and fail-closed
 * watchdog behavior when stable identity authority is unavailable (#4403).
 * Generation 167 repairs the telegram daemon generation guard bootstrap so the
 * generator's post-fix manifest check always byte-compares the regenerated disk
 * manifest against the current tree, and auto-reaps pre-registry legacy stray
 * Telegram daemons (#4533).
 * Generation 168 adds per-update inbound acknowledgement authority and monotonic
 * reaction settlement for Telegram notification delivery (#4528).
 * Generation 169 delivers every ring-positioned session event live through the
 * bounded, capability-gated directed subscriber leg used by replay.
 * Generation 172 fences the SessionRouter idle-poll/change-stamp rollout (#4689).
 * The daemon constructs a SessionRouter, and the router's idle tick no longer
 * re-acquires the machine-global session-index lock on every 2s pass: unchanged
 * polls are stat-only and staleness retirement moved to a 30s sweep. A daemon
 * still running the pre-#4689 router keeps the old hot polling loop and its
 * lock contention, so an already-running owner must be replaced rather than
 * retained across this upgrade.
 * Generation 177 consumes an exact same-window lean settlement receipt only
 * after its autonomous ask lead-in publishes successfully, preventing idle
 * replay without changing the serving protocol. Generation 178 refreshes the
 * native filesystem authority boundary for exact Paseo publication and bridge
 * recovery.
 */
export const DAEMON_GENERATION = 179;

/**
 * Serving-compatibility boundary for daemon lifecycle requests. Epoch 7
 * requires durable publication receipts and acknowledged attachment dispatch,
 * so epoch-6 daemons cannot serve across the delivery-safety cutover. Epoch 8
 * requires the durable claimed/confirmed publication receipt format. Epoch 9
 * requires accepted-only confirmation and legacy receipt quarantine. Epoch 10
 * requires replay admission to retain deferred publication claims. Epoch 11
 * requires strict direct receipts and fail-closed continuation admission. Epoch 12
 * requires malformed provider responses to remain unconfirmed claims.
 * Epoch 13 requires complete direct-effect identity and pre-send retry semantics.
 * Epoch 14 requires bounded receipt loading and fail-closed pending eviction.
 * Epoch 15 requires BTW shutdown to preserve Router replay authority.
 * Epoch 16 requires accepted-only settlement for special provider queues.
 * Epoch 17 requires durable queued/attempted/confirmed publication states.
 * Epoch 18 requires suppression-aware attempt transitions and replay confirmation.
 * Epoch 19 requires direct invalid/rejected outcomes to retain exact receipt state.
 * Epoch 20 requires Router cursor advancement to follow settled publication state.
 * Epoch 21 requires ordered Router settlement waiters for queued publications.
 * Epoch 22 requires unified dispatch guards and non-coalescing publication work.
 * Epoch 23 requires explicit rejected state and terminal direct settlement.
 * Epoch 24 requires bounded terminal rejection retention.
 * Epoch 25 requires stale-dispatch retry and superseded publication settlement.
 * Epoch 26 requires terminal-state exclusivity and complete publication barriers.
 * Epoch 27 requires no-dispatch terminalization and post-wait revalidation.
 * Epoch 28 requires terminal flat/pending admission and list-only Broker routing.
 * Epoch 29 requires complete removal terminalization and direct rejection state.
 * Epoch 30 requires terminal settlement for pending-frame flush discards.
 * Epoch 31 requires complete direct waiter closure and pre-identity delivery.
 * Epoch 32 removes identity-gated pending publication admission.
 * Epoch 33 requires selected-ack shutdown removal to settle publication state.
 * Epoch 34 requires control-file exits to terminalize queued publications first.
 * Epoch 35 requires complete publication teardown and single-attempt dispatch.
 * Epoch 36 closes the retry-after-stop queue race.
 * Epoch 37 closes replay-queue settlement during stop.
 * Epoch 38 closes selected-ack retry-after-stop settlement.
 * Epoch 39 propagates terminal receipt persistence failure to Router shutdown.
 * Epoch 40 closes hanging-delivery shutdown and transient persistence replay.
 * Epoch 41 closes ordinary publication hangs during shutdown.
 * Epoch 42 closes selected terminal receipt persistence settlement.
 * Epoch 43 closes rich-draft transport hangs during shutdown.
 * Epoch 44 closes terminal tool transport hangs during shutdown.
 * Epoch 45 closes raw topic and callback transport hangs during shutdown.
 * Epoch 46 closes timer-finalized publication persistence settlement.
 * Epoch 47 covers every delivered/rejected persistence rollback path.
 * Epoch 48 preserves unrelated batch settlement and rejected replayability.
 * Epoch 49 preserves every removed inventory settlement after individual failure.
 * Epoch 50 prevents attachment resurrection after provider shutdown.
 * Epoch 51 fully fences Router startup and reconciliation after stop.
 * Epoch 52 prevents provider dispatch throughout the Router stop window.
 * Epoch 53 prevents one transport close timeout from skipping later cleanup.
 * Epoch 54 prevents Router return before replay callbacks complete.
 * Epoch 55 closes pending reconnect replay without hanging Router shutdown.
 * Epoch 56 guarantees provider authority cleanup despite transport close failure.
 * Epoch 57 prevents orphaned replay request rejection during stop.
 * Epoch 58 guarantees old authority cleanup before replacement attachment.
 * Epoch 59 drops old provider authority only when replacement creation fails.
 * Epoch 60 closes provider cleanup for replacement creation interrupted by stop.
 * Epoch 61 closes provider cleanup after published replacement handoff.
 * Epoch 62 covers stop during recovered-frame and replay awaits.
 * Epoch 63 prevents capacity and claim-persistence waiter leaks.
 * Epoch 64 closes attachment replacement during claim persistence.
 * Epoch 65 closes dual persistence failure during tentative claim teardown.
 * Epoch 66 prevents callback shutdown deadlock and false ambiguous rejection.
 * Epoch 67 closes concurrent claim/rejection persistence cursor concession.
 * Epoch 68 prevents pre-stop reconciliation authority after same-instance restart.
 * Epoch 69 prevents provisional nested replay cursor concession.
 * Epoch 70 prevents stale run failures from stopping a restarted Router.
 * Epoch 71 restores bounded Router restart and rejected publication replay.
 * Epoch 72 identity-fences provider cleanup after bounded restart.
 * Epoch 73 preserves successor retry state and ambiguous dispatched cleanup.
 * Epoch 74 prevents replay after accepted responses lacking message identity.
 * Epoch 75 prevents hung Discord REST work from blocking daemon shutdown.
 * Epoch 76 cancels hung Discord REST before active-work drain expires.
 * Epoch 77 fences late Discord effect commits after Router revocation.
 * Epoch 78 atomically marks timed-out Discord work uncertain before Router revocation.
 * Epoch 79 releases timed-out Discord creator ownership for successor recovery.
 * Epoch 80 terminalizes leases admitted after shutdown invalidator snapshot.
 * Epoch 81 preserves definitive provider rejection across persistence failure and restart.
 * Epoch 82 fails closed before exposing provider attachments after cleanup recovery failure.
 * Epoch 83 binds provider commands to the exact opaque attachment identity.
 * Epoch 84 prohibits provider lifecycle-equivalent controls and detaches replacement work.
 * Epoch 85 removes direct relay attachment and prohibits lifecycle controls on every adapter.
 * Epoch 86 removes public discovery/client exports and retires cross-process raw transports.
 * Epoch 87 preserves accepted Telegram delivery ambiguity and advances poisoned poll cursors.
 * Epoch 88 requires the #4689 SessionRouter idle-poll contract: generation alone
 * does not force replacement, so the serving boundary advances to guarantee a
 * pre-#4689 daemon cannot keep serving with the old per-tick locked rescan.
 */
export const SERVING_EPOCH = 88;
