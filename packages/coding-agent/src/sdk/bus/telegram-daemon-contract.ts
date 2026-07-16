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
 * The current development baseline already includes #2299's generation 4;
 * this behavior change therefore advances the operational generation to 5.
 */
export const DAEMON_GENERATION = 5;
