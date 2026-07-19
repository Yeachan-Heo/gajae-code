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
 * Generation 5 introduced capability-gated tool activity. The durable
 * Telegram tool-activity delivery policy changes daemon behavior again, so
 * upgraded hosts must replace generation-5 owners before attaching.
 */
export const DAEMON_GENERATION = 6;
