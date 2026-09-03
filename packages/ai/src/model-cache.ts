/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import { Database } from "bun:sqlite";
import { getModelDbPath } from "@gajae-code/utils/dirs";
import type { Api, Model } from "./types";

const CACHE_SCHEMA_VERSION = 5;

interface CacheRow {
	provider_id: string;
	version: number;
	updated_at: number;
	authoritative: number;
	static_fingerprint: string;
	dynamic_model_ids: string | null;
	dynamic_model_provenance: string | null;
	models: string;
}

interface TableInfoRow {
	name: string;
}

interface CacheEntry<TApi extends Api = Api> {
	models: Model<TApi>[];
	fresh: boolean;
	authoritative: boolean;
	updatedAt: number;
	/**
	 * Hash of the static catalog slice that was merged into `models` when this
	 * row was written. `resolveProviderModels` compares against the current
	 * static fingerprint and bypasses the static+cache re-merge when they
	 * match — the cache already incorporates the same static state.
	 */
	staticFingerprint: string;
	/** IDs returned by the authoritative dynamic provider catalog, when retained. */
	dynamicModelIds: string[] | undefined;
	dynamicModelProvenance: string | undefined;
}

let sharedDb: Database | null = null;
let sharedDbPath: string | null = null;

function getDb(dbPath?: string): Database {
	const resolvedPath = dbPath ?? getModelDbPath();
	if (sharedDb && sharedDbPath === resolvedPath) {
		return sharedDb;
	}
	if (sharedDb) {
		sharedDb.close();
	}
	const db = new Database(resolvedPath, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA busy_timeout = 3000");
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache (
			provider_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL DEFAULT 0,
			static_fingerprint TEXT NOT NULL DEFAULT '',
			dynamic_model_ids TEXT,
			dynamic_model_provenance TEXT,
			models TEXT NOT NULL
		)
	`);
	migrateCacheSchema(db);

	sharedDb = db;
	sharedDbPath = resolvedPath;
	return db;
}

/** Close the shared cache only when it owns the exact requested database path. */
export function closeModelCache(dbPath?: string): boolean {
	const resolvedPath = dbPath ?? getModelDbPath();
	if (!sharedDb || sharedDbPath !== resolvedPath) return false;
	sharedDb.close();
	sharedDb = null;
	sharedDbPath = null;
	return true;
}

function migrateCacheSchema(db: Database): void {
	const columns = db.prepare("PRAGMA table_info(model_cache)").all() as TableInfoRow[];
	if (!columns.some(column => column.name === "static_fingerprint")) {
		db.run("ALTER TABLE model_cache ADD COLUMN static_fingerprint TEXT NOT NULL DEFAULT ''");
	}
	if (!columns.some(column => column.name === "dynamic_model_ids")) {
		db.run("ALTER TABLE model_cache ADD COLUMN dynamic_model_ids TEXT");
	}
	if (!columns.some(column => column.name === "dynamic_model_provenance")) {
		db.run("ALTER TABLE model_cache ADD COLUMN dynamic_model_provenance TEXT");
	}
	db.run("UPDATE model_cache SET version = ? WHERE version IN (2, 3, 4)", [CACHE_SCHEMA_VERSION]);
}

export function readModelCache<TApi extends Api>(
	providerId: string,
	ttlMs: number,
	now: () => number,
	dbPath?: string,
): CacheEntry<TApi> | null {
	try {
		const db = getDb(dbPath);
		const row = db.query<CacheRow, [string]>("SELECT * FROM model_cache WHERE provider_id = ?").get(providerId);
		if (!row || row.version !== CACHE_SCHEMA_VERSION) {
			return null;
		}
		const models = JSON.parse(row.models) as Model<TApi>[];
		const ageMs = now() - row.updated_at;
		const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
		return {
			models,
			fresh,
			authoritative: row.authoritative === 1,
			updatedAt: row.updated_at,
			staticFingerprint: row.static_fingerprint ?? "",
			dynamicModelIds: row.dynamic_model_ids === null ? undefined : (JSON.parse(row.dynamic_model_ids) as string[]),
			dynamicModelProvenance: row.dynamic_model_provenance ?? undefined,
		};
	} catch {
		return null;
	}
}

export function writeModelCache<TApi extends Api>(
	providerId: string,
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	dynamicModelIds?: readonly string[],
	dynamicModelProvenance?: string,
): void {
	try {
		const db = getDb(dbPath);
		db.run(
			`INSERT OR REPLACE INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, dynamic_model_ids, dynamic_model_provenance, models)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				providerId,
				CACHE_SCHEMA_VERSION,
				updatedAt,
				authoritative ? 1 : 0,
				staticFingerprint,
				dynamicModelIds === undefined ? null : JSON.stringify(dynamicModelIds),
				dynamicModelProvenance ?? null,
				JSON.stringify(models),
			],
		);
	} catch {
		// Cache writes are best-effort; failures should not break model resolution.
	}
}

export function publishModelCacheIfNotUpdatedAfter<TApi extends Api>(
	providerId: string,
	requestStartedAt: number,
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	dynamicModelIds?: readonly string[],
	dynamicModelProvenance?: string,
): boolean {
	try {
		const result = getDb(dbPath).run(
			`INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, dynamic_model_ids, dynamic_model_provenance, models)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(provider_id) DO UPDATE SET
				 version = excluded.version,
				 updated_at = excluded.updated_at,
				 authoritative = excluded.authoritative,
				 static_fingerprint = excluded.static_fingerprint,
				 dynamic_model_ids = excluded.dynamic_model_ids,
				 dynamic_model_provenance = excluded.dynamic_model_provenance,
				 models = excluded.models
			 WHERE model_cache.updated_at <= ?`,
			[
				providerId,
				CACHE_SCHEMA_VERSION,
				updatedAt,
				authoritative ? 1 : 0,
				staticFingerprint,
				dynamicModelIds === undefined ? null : JSON.stringify(dynamicModelIds),
				dynamicModelProvenance ?? null,
				JSON.stringify(models),
				requestStartedAt,
			],
		);
		return result.changes === 1;
	} catch {
		return false;
	}
}

export function insertModelCacheIfAbsent<TApi extends Api>(
	providerId: string,
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	dynamicModelIds?: readonly string[],
	dynamicModelProvenance?: string,
): boolean {
	try {
		const result = getDb(dbPath).run(
			`INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, dynamic_model_ids, dynamic_model_provenance, models)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(provider_id) DO NOTHING`,
			[
				providerId,
				CACHE_SCHEMA_VERSION,
				updatedAt,
				authoritative ? 1 : 0,
				staticFingerprint,
				dynamicModelIds === undefined ? null : JSON.stringify(dynamicModelIds),
				dynamicModelProvenance ?? null,
				JSON.stringify(models),
			],
		);
		return result.changes === 1;
	} catch {
		return false;
	}
}

export function updateModelCacheIfUnchanged<TApi extends Api>(
	providerId: string,
	expectedUpdatedAt: number,
	expectedDynamicModelIds: readonly string[] | undefined,
	expectedDynamicModelProvenance: string | undefined,
	expectedModels: readonly Model<TApi>[],
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	dynamicModelIds?: readonly string[],
	dynamicModelProvenance?: string,
): boolean {
	try {
		const expectedIds = expectedDynamicModelIds === undefined ? null : JSON.stringify(expectedDynamicModelIds);
		const provenance = expectedDynamicModelProvenance ?? null;
		const nextIds = dynamicModelIds === undefined ? null : JSON.stringify(dynamicModelIds);
		const nextProvenance = dynamicModelProvenance ?? null;
		const expectedModelsJson = JSON.stringify(expectedModels);
		const result = getDb(dbPath).run(
			`UPDATE model_cache
			 SET updated_at = ?, authoritative = ?, static_fingerprint = ?, dynamic_model_ids = ?,
			     dynamic_model_provenance = ?, models = ?
			 WHERE provider_id = ? AND updated_at = ?
			   AND dynamic_model_ids IS ? AND dynamic_model_provenance IS ? AND models = ?`,
			[
				updatedAt,
				authoritative ? 1 : 0,
				staticFingerprint,
				nextIds,
				nextProvenance,
				JSON.stringify(models),
				providerId,
				expectedUpdatedAt,
				expectedIds,
				provenance,
				expectedModelsJson,
			],
		);
		return result.changes === 1;
	} catch {
		return false;
	}
}
