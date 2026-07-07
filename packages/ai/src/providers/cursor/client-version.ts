/**
 * The Cursor client version reported to api2.cursor.sh.
 *
 * Every call against the Cursor backend must send the same
 * x-cursor-client-version: the backend gates features and minimum versions on
 * it, so a drift between the agent Run path and model discovery makes one of
 * them fail while the other keeps working. Keep this as the single source of
 * truth for the header value.
 */
export const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
