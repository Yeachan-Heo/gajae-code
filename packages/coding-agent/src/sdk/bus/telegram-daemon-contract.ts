/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

/**
 * Operational generation for daemon ownership reloads. It changes independently
 * from the stable wire protocol so upgraded hosts replace older live daemons.
 */
export const DAEMON_GENERATION = 4;
