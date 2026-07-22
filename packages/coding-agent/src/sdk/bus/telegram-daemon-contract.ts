/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

/**
 * Operational generation the current daemon build speaks. Decoupled from
 * {@link NOTIFICATION_PROTOCOL_VERSION} (#2304): additive `tool_activity` /
 * `reasoning_summary` frames do not bump the wire protocol version, but a
 * freshly-upgraded host must still recognize an older, still-live daemon that
 * predates capability-gated frame enforcement and trigger a reload. Bump this
 * on every daemon-behavior change independent of the wire version.
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
 * startup recovery in generation 16, and Telegram topic recovery authority
 * fencing in generation 17.
 */
export const DAEMON_GENERATION = 17;
