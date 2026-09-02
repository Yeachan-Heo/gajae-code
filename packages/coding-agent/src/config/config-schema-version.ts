/**
 * The current settings/config schema version. A `config.yml` whose
 * `configSchemaVersion` is newer is treated as read-only by Settings migrations
 * (a future schema must not inherit stale keys); the workflow-settings
 * resolver mirrors that guard when deciding whether a migration target is
 * non-publishable (so the retained legacy fallback still applies). Defined in
 * this dependency-light module so the resolver can import it without pulling in
 * the TUI/AI-heavy settings schema.
 */
export const CONFIG_SCHEMA_VERSION = 2;

/**
 * Normalize a durable `configSchemaVersion` marker into a comparable version.
 *
 * Every version decision (future-schema detection, migration-pending state, and
 * the ordered migration registry) must read the SAME normalized value: a
 * malformed marker read as a future schema by one guard and as unmigrated by
 * the next would skip legacy migrations while still re-running v0 transforms.
 * A finite malformed value floors to the nearest completed version; a
 * non-finite or non-numeric one carries no version information and normalizes
 * to 0 (fully unmigrated). `undefined` stays `undefined` (no marker written).
 */
export function normalizeConfigSchemaVersion(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}
