import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@gajae-code/ai";
import { getAgentDbPath, isRecord, logger } from "@gajae-code/utils";
import type { RawSettings as Settings } from "../config/settings";

/** Row shape for settings table queries */
type SettingsRow = {
	key: string;
	value: string;
};

/** Row shape for model_usage table queries */
type ModelUsageRow = {
	model_key: string;
	last_used_at: number;
};

/** Bump when schema changes require migration */
const SCHEMA_VERSION = 5;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/** Singleton instances per database path */
const instances = new Map<string, AgentStorage>();

/**
 * Unified SQLite storage for agent settings, model usage, and auth credentials.
 * Delegates auth credential operations to AuthCredentialStore from @gajae-code/ai.
 * Uses singleton pattern per database path; access via AgentStorage.open().
 */
export class AgentStorage {
	#db: Database;
	#authStore: AuthCredentialStore;
	#dbPath: string;
	#closed = false;

	#listSettingsStmt: Statement;
	#upsertModelUsageStmt: Statement;
	#listModelUsageStmt: Statement;
	#modelUsageCache: string[] | null = null;

	private constructor(dbPath: string) {
		this.#dbPath = dbPath;
		this.#ensureDir(dbPath);
		try {
			this.#db = new Database(dbPath);
		} catch (err) {
			const dir = path.dirname(dbPath);
			const dirExists = fs.existsSync(dir);
			const errMsg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to open agent database at '${dbPath}': ${errMsg}\n` +
					`Directory '${dir}' exists: ${dirExists}\n` +
					`Ensure the directory is writable and not corrupted.`,
			);
		}

		this.#initializeSchema();
		this.#hardenPermissions(dbPath);

		// Create AuthCredentialStore with our open database
		this.#authStore = new SqliteAuthCredentialStore(this.#db);

		this.#listSettingsStmt = this.#db.prepare("SELECT key, value FROM settings");
		this.#upsertModelUsageStmt = this.#db.prepare(
			`INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ${SQLITE_NOW_EPOCH}) ON CONFLICT(model_key) DO UPDATE SET last_used_at = ${SQLITE_NOW_EPOCH}`,
		);
		this.#listModelUsageStmt = this.#db.prepare(
			"SELECT model_key, last_used_at FROM model_usage ORDER BY last_used_at DESC",
		);
	}

	/**
	 * Creates tables if missing and migrates legacy settings.
	 * AuthCredentialStore handles auth_credentials and cache tables.
	 */
	#initializeSchema(): void {
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS model_usage (
	model_key TEXT PRIMARY KEY,
	last_used_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
`);

		const settingsInfo = this.#db.prepare("PRAGMA table_info(settings)").all() as Array<{ name?: string }>;
		const hasSettingsTable = settingsInfo.length > 0;
		const hasKey = settingsInfo.some(column => column.name === "key");
		const hasValue = settingsInfo.some(column => column.name === "value");

		if (!hasSettingsTable) {
			this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
		} else if (!hasKey || !hasValue) {
			// Migrate v1 schema: single JSON blob in `data` column → per-key rows
			let legacySettings: Record<string, unknown> | null = null;
			const row = this.#db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data?: string } | undefined;
			if (row?.data) {
				try {
					const parsed = JSON.parse(row.data);
					if (isRecord(parsed)) {
						legacySettings = parsed;
					} else {
						logger.warn("AgentStorage legacy settings invalid shape");
					}
				} catch (error) {
					logger.warn("AgentStorage failed to parse legacy settings", { error: String(error) });
				}
			}

			const migrate = this.#db.transaction((settings: Record<string, unknown> | null) => {
				this.#db.run("DROP TABLE settings");
				this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
				if (settings) {
					const insert = this.#db.prepare(
						`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ${SQLITE_NOW_EPOCH})`,
					);
					for (const [key, value] of Object.entries(settings)) {
						if (value === undefined) continue;
						const serialized = JSON.stringify(value);
						if (serialized === undefined) continue;
						insert.run(key, serialized);
					}
				}
			});

			migrate(legacySettings);
		}

		const versionRow = this.#db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		const schemaVersion = typeof versionRow?.version === "number" ? versionRow.version : 0;
		if (versionRow?.version !== undefined && versionRow.version !== SCHEMA_VERSION) {
			logger.warn("AgentStorage schema version mismatch", {
				current: versionRow.version,
				expected: SCHEMA_VERSION,
			});
		}
		if (schemaVersion < SCHEMA_VERSION) {
			this.#migrateSchema(schemaVersion);
		}
		this.#db.prepare("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
	}

	#migrateSchema(fromVersion: number): void {
		if (fromVersion < 4) {
			// v3 → v4: Add disabled column to auth_credentials (handled by AuthCredentialStore)
			// Nothing to do here - AuthCredentialStore will handle this migration
		}
		if (fromVersion < 5) {
			this.#migrateSchemaV4ToV5();
		}
	}

	#migrateSchemaV4ToV5(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE settings RENAME TO settings_legacy");
			this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
			this.#db.run(`
INSERT INTO settings (key, value, updated_at)
SELECT key, value, updated_at
FROM settings_legacy
`);
			this.#db.run("DROP TABLE settings_legacy");

			this.#db.run("ALTER TABLE model_usage RENAME TO model_usage_legacy");
			this.#db.run(`
CREATE TABLE model_usage (
	model_key TEXT PRIMARY KEY,
	last_used_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
			this.#db.run(`
INSERT INTO model_usage (model_key, last_used_at)
SELECT model_key, last_used_at
FROM model_usage_legacy
`);
			this.#db.run("DROP TABLE model_usage_legacy");
		});
		migrate();
	}

	/**
	 * Returns singleton instance for the given database path, creating if needed.
	 * Retries on SQLITE_BUSY with exponential backoff.
	 * @param dbPath - Path to the SQLite database file (defaults to config path)
	 * @returns AgentStorage instance for the given path
	 */
	static async open(dbPath: string = getAgentDbPath()): Promise<AgentStorage> {
		const existing = instances.get(dbPath);
		if (existing) return existing;

		const maxRetries = 3;
		const baseDelayMs = 100;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const storage = new AgentStorage(dbPath);
				instances.set(dbPath, storage);
				return storage;
			} catch (err) {
				const isSqliteBusy = err && typeof err === "object" && (err as { code?: string }).code === "SQLITE_BUSY";
				if (!isSqliteBusy) {
					throw err;
				}
				lastError = err as Error;
				const delayMs = baseDelayMs * 2 ** attempt;
				await Bun.sleep(delayMs);
			}
		}

		throw lastError ?? new Error("Failed to open database after retries");
	}

	/**
	 * Retrieves all settings from storage (legacy, for migration only).
	 * Settings are now stored in config.yml. This method is only used
	 * during migration from agent.db to config.yml.
	 * @returns Settings object, or null if no settings are stored
	 * @deprecated Use config.yml instead. This is only for migration.
	 */
	getSettings(): Settings | null {
		const rows = (this.#listSettingsStmt.all() as SettingsRow[]) ?? [];
		if (rows.length === 0) return null;
		const settings: Record<string, unknown> = {};
		for (const row of rows) {
			try {
				settings[row.key] = JSON.parse(row.value) as unknown;
			} catch (error) {
				logger.warn("AgentStorage failed to parse setting", {
					key: row.key,
					error: String(error),
				});
			}
		}
		return settings as Settings;
	}

	/**
	 * @deprecated Settings are now stored in config.yml, not agent.db.
	 * This method is kept for backward compatibility but does nothing.
	 */
	saveSettings(settings: Settings): void {
		logger.warn("AgentStorage.saveSettings is deprecated - settings are now stored in config.yml", {
			keys: Object.keys(settings),
		});
	}

	/**
	 * Records model usage, updating the last-used timestamp.
	 * @param modelKey - Model key in "provider/modelId" format
	 */
	recordModelUsage(modelKey: string): void {
		try {
			this.#upsertModelUsageStmt.run(modelKey);
			this.#modelUsageCache = null;
		} catch (error) {
			logger.warn("AgentStorage failed to record model usage", { modelKey, error: String(error) });
		}
	}

	/**
	 * Gets model keys ordered by most recently used.
	 * Results are cached until recordModelUsage is called.
	 * @returns Array of model keys ("provider/modelId") in MRU order
	 */
	getModelUsageOrder(): string[] {
		if (this.#modelUsageCache) {
			return this.#modelUsageCache;
		}
		try {
			const rows = this.#listModelUsageStmt.all() as ModelUsageRow[];
			this.#modelUsageCache = rows.map(row => row.model_key);
			return this.#modelUsageCache;
		} catch (error) {
			logger.warn("AgentStorage failed to get model usage order", { error: String(error) });
			return [];
		}
	}

	/**
	 * Checks if any auth credentials exist in storage.
	 * @returns True if at least one credential is stored
	 */
	hasAuthCredentials(): boolean {
		return this.#authStore.listAuthCredentials().length > 0;
	}

	/**
	 * Returns the underlying {@link AuthCredentialStore} so callers that need
	 * the lower-level pi-ai abstraction (e.g. `findAnthropicAuth(store)`) can
	 * reuse this storage's open database connection instead of opening their
	 * own.
	 */
	get authStore(): AuthCredentialStore {
		return this.#authStore;
	}

	/**
	 * Lists auth credentials, optionally filtered by provider.
	 * Only returns active (non-disabled) credentials by default.
	 * @param provider - Optional provider name to filter by
	 * @param includeDisabled - If true, includes disabled credentials
	 * @returns Array of stored credentials with their database IDs
	 */
	listAuthCredentials(provider?: string, includeDisabled = false): StoredAuthCredential[] {
		const credentials = this.#authStore.listAuthCredentials(provider);
		if (!includeDisabled) return credentials;

		const stmt = this.#db.prepare(
			provider
				? "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id ASC"
				: "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials ORDER BY id ASC",
		);
		const rows = (provider ? stmt.all(provider) : stmt.all()) as Array<{
			id: number;
			provider: string;
			credential_type: string;
			data: string;
			disabled_cause: string | null;
		}>;

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.data);
				if (!parsed || typeof parsed !== "object") continue;

				let credential: AuthCredential;
				if (row.credential_type === "api_key" && typeof (parsed as { key?: unknown }).key === "string") {
					credential = { type: "api_key", key: (parsed as { key: string }).key };
				} else if (row.credential_type === "oauth") {
					credential = { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
				} else {
					continue;
				}

				results.push({ id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause });
			} catch {}
		}
		return results;
	}

	/**
	 * Atomically replaces all credentials for a provider.
	 * Useful for OAuth token refresh where old tokens should be discarded.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @param credentials - New credentials to store
	 * @returns Array of newly stored credentials with their database IDs
	 */
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		return this.#authStore.replaceAuthCredentialsForProvider(provider, credentials);
	}

	/**
	 * Updates an existing auth credential by ID.
	 * @param id - Database row ID of the credential to update
	 * @param credential - New credential data
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		this.#authStore.updateAuthCredential(id, credential);
	}

	/**
	 * Disables an auth credential by ID with a persisted cause.
	 * @param id - Database row ID of the credential to disable
	 * @param disabledCause - Human-readable cause stored with the disabled row
	 */
	deleteAuthCredential(id: number, disabledCause: string): void {
		this.#authStore.deleteAuthCredential(id, disabledCause);
	}

	/**
	 * Disables all auth credentials for a provider with a persisted cause.
	 * @param provider - Provider name whose credentials should be disabled
	 * @param disabledCause - Human-readable cause stored with the disabled rows
	 */
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		this.#authStore.deleteAuthCredentialsForProvider(provider, disabledCause);
	}

	/**
	 * Gets a cached value by key. Returns null if not found or expired.
	 */
	getCache(key: string): string | null {
		return this.#authStore.getCache(key);
	}

	/**
	 * Sets a cached value with expiry time (unix seconds).
	 */
	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#authStore.setCache(key, value, expiresAtSec);
	}

	deleteCachePrefix(prefix: string): void {
		this.#authStore.deleteCachePrefix?.(prefix);
	}

	/**
	 * Deletes expired cache entries. Call periodically for cleanup.
	 */
	cleanExpiredCache(): void {
		this.#authStore.cleanExpiredCache();
	}

	/**
	 * Release prepared statements and the shared SQLite handle.
	 *
	 * AgentStorage instances are cached by path, so closing also evicts this
	 * instance and allows a later open() to create a fresh handle.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#listSettingsStmt.finalize();
		this.#upsertModelUsageStmt.finalize();
		this.#listModelUsageStmt.finalize();
		this.#authStore.close();
		if (instances.get(this.#dbPath) === this) instances.delete(this.#dbPath);
	}
	/**
	 * Ensures the parent directory for the database file exists.
	 * @param dbPath - Path to the database file
	 */
	#ensureDir(dbPath: string): void {
		const dir = path.dirname(dbPath);
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// EEXIST is fine - directory already exists
			if (code !== "EEXIST") {
				throw new Error(`Failed to create agent storage directory '${dir}': ${code || err}`);
			}
		}
		// Verify directory was created
		if (!fs.existsSync(dir)) {
			throw new Error(`Agent storage directory '${dir}' does not exist after creation attempt`);
		}
	}

	#hardenPermissions(dbPath: string): void {
		const dir = path.dirname(dbPath);
		try {
			fs.chmodSync(dir, 0o700);
		} catch (error) {
			logger.warn("AgentStorage failed to chmod agent dir", { path: dir, error: String(error) });
		}

		if (!fs.existsSync(dbPath)) return;
		try {
			fs.chmodSync(dbPath, 0o600);
		} catch (error) {
			logger.warn("AgentStorage failed to chmod db file", { path: dbPath, error: String(error) });
		}
	}
}
