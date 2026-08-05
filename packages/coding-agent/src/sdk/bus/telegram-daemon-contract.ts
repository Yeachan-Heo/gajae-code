/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

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
 * code for idempotent archive settlement.
 */
export const DAEMON_GENERATION = 51;

/**
 * Serving-compatibility boundary for daemon lifecycle requests. Epoch 5
 * requires the complete generation-36 topic authority contract, so older
 * epoch-4 daemons cannot keep serving across an upgrade.
 */
export const SERVING_EPOCH = 5;
