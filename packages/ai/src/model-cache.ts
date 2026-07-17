/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import { Database } from "bun:sqlite";
import { getModelDbPath } from "@gajae-code/utils/dirs";
import type { Api, Model } from "./types";

const CACHE_SCHEMA_VERSION = 3;

interface CacheRow {
	provider_id: string;
	version: number;
	updated_at: number;
	authoritative: number;
	static_fingerprint: string;
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
	db.run("UPDATE model_cache SET version = ? WHERE version = 2", [CACHE_SCHEMA_VERSION]);
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
): void {
	try {
		const db = getDb(dbPath);
		db.run(
			`INSERT OR REPLACE INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				providerId,
				CACHE_SCHEMA_VERSION,
				updatedAt,
				authoritative ? 1 : 0,
				staticFingerprint,
				JSON.stringify(models),
			],
		);
	} catch {
		// Cache writes are best-effort; failures should not break model resolution.
	}
}
