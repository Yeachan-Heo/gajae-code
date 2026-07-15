/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

/**
 * Operational generation the current daemon build speaks. It is tied to the
 * wire protocol version so a freshly-upgraded host can identify an older,
 * still-live daemon without coupling status readers to the daemon runtime.
 */
export const DAEMON_GENERATION = NOTIFICATION_PROTOCOL_VERSION;
