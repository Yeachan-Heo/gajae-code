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
