import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { type GeneratedProvider, getBundledModel, type Usage } from "@gajae-code/ai";
import { getConfigRootDir, getStatsDbPath } from "@gajae-code/utils";
import type {
	AggregatedStats,
	BehaviorModelStats,
	BehaviorOverallStats,
	BehaviorTimeSeriesPoint,
	CostTimeSeriesPoint,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	ParsedMessageStats,
	TimeSeriesPoint,
	UserMessageLink,
	UserMessageStats,
} from "./types";

type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type UsageCost = Usage["cost"];
type CostTokens = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;

interface CostBackfillRow {
	id: number;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

let db: Database | null = null;

const BACKFILL_COMPLETE = "complete";
const BACKFILL_PENDING = "pending";
const USER_MESSAGES_BACKFILL_KEY = "user_messages_v5";
const USER_MESSAGE_LINKS_REPAIR_KEY = "user_message_links_v1";
const PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY = "premium_requests_priority_v1";
function shouldResetBackfill(value: string | undefined): boolean {
	return value !== BACKFILL_COMPLETE && value !== BACKFILL_PENDING;
}
/**
 * Initialize the database and create tables.
 */
export async function initDb(): Promise<Database> {
	if (db) return db;

	// Ensure directory exists
	await fs.mkdir(getConfigRootDir(), { recursive: true });

	db = new Database(getStatsDbPath());
	db.exec("PRAGMA journal_mode = WAL");

	// Create tables
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
		CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_folder ON messages(timestamp, folder);
		CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);

		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			yelling INTEGER NOT NULL,
			profanity INTEGER NOT NULL,
			anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0,
			repetition INTEGER NOT NULL DEFAULT 0,
			blame INTEGER NOT NULL DEFAULT 0,
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
	if (!messageColumns.some(column => column.name === "premium_requests")) {
		db.exec("ALTER TABLE messages ADD COLUMN premium_requests REAL NOT NULL DEFAULT 0");
	}
	db.exec("UPDATE messages SET premium_requests = 0 WHERE premium_requests IS NULL");
	// Each behavior-metric bump invalidates previously-ingested rows. We detect
	// the stale schema by column name and drop the table; `IF NOT EXISTS` above
	// already produced the new schema, but we want a clean wipe + re-ingest.
	// `backfillUserMessages` then clears `file_offsets` so the next sync
	// re-parses every session under the current metric definitions.
	//   v1 -> v2: yelling sentences replace `caps_words`.
	//   v2 -> v3: `drama_runs` folded into a single `anguish` signal that
	//             also captures elongated interjections, `dude`, and dot runs,
	//             gated on a stripped prose-line budget.
	//   v3 -> v4: added `negation`, `repetition`, `blame` frustration signals
	//             plus profanity dictionary expansion + word-boundary fix.
	//   v4 -> v5: column `yelling_sentences` renamed to `yelling` to match
	//             the other single-word signal columns.
	const userMessageColumns = db.prepare("PRAGMA table_info(user_messages)").all() as {
		name: string;
	}[];
	const hasStaleColumn =
		userMessageColumns.length > 0 &&
		(userMessageColumns.some(column => column.name === "caps_words") ||
			userMessageColumns.some(column => column.name === "drama_runs") ||
			userMessageColumns.some(column => column.name === "yelling_sentences"));
	const hasV4Columns = userMessageColumns.some(column => column.name === "negation");
	const hasOldUserMessages = userMessageColumns.length > 0;
	if (hasStaleColumn || (hasOldUserMessages && !hasV4Columns)) {
		db.exec("DROP TABLE user_messages");
		db.exec(`
			CREATE TABLE user_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				model TEXT,
				provider TEXT,
				chars INTEGER NOT NULL,
				words INTEGER NOT NULL,
				yelling INTEGER NOT NULL,
				profanity INTEGER NOT NULL,
				anguish INTEGER NOT NULL,
				negation INTEGER NOT NULL DEFAULT 0,
				repetition INTEGER NOT NULL DEFAULT 0,
				blame INTEGER NOT NULL DEFAULT 0,
				UNIQUE(session_file, entry_id)
			);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);
		`);
	}
	backfillUserMessages(db);
	repairUserMessageLinks(db);
	backfillPriorityPremiumRequests(db);
	backfillMissingCatalogCosts(db);
	return db;
}

function hasBillableCost(cost: ModelCost): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function getBundledModelCost(provider: string, modelId: string): ModelCost | null {
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	return model?.cost ?? null;
}

function getCatalogCost(provider: string, modelId: string): ModelCost | null {
	const primaryCost = getBundledModelCost(provider, modelId);
	if (primaryCost && hasBillableCost(primaryCost)) {
		return primaryCost;
	}

	if (provider === "openai-codex") {
		const openAICost = getBundledModelCost("openai", modelId);
		if (openAICost && hasBillableCost(openAICost)) {
			return openAICost;
		}
	}

	return null;
}

function calculateCatalogCost(provider: string, modelId: string, tokens: CostTokens): UsageCost | null {
	const cost = getCatalogCost(provider, modelId);
	if (!cost) return null;

	const input = (cost.input / 1_000_000) * tokens.input;
	const output = (cost.output / 1_000_000) * tokens.output;
	const cacheRead = (cost.cacheRead / 1_000_000) * tokens.cacheRead;
	const cacheWrite = (cost.cacheWrite / 1_000_000) * tokens.cacheWrite;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}

function resolveStoredCost(stats: ParsedMessageStats): UsageCost {
	const raw = stats.usage.cost;
	const recorded = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
	const keys = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
	// Complete zero-cost payloads historically request catalog pricing. A partial
	// payload is different: preserve every valid recorded value, including zero.
	const allZero = keys.every(key => recorded[key] === 0);
	const catalog = calculateCatalogCost(stats.provider, stats.model, stats.usage);
	const component = (key: keyof ModelCost): number => {
		if (!allZero && finite(recorded[key])) return recorded[key];
		const fallback = catalog?.[key];
		return finite(fallback) ? fallback : 0;
	};
	const input = component("input");
	const output = component("output");
	const cacheRead = component("cacheRead");
	const cacheWrite = component("cacheWrite");
	const sum = input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: !allZero && finite(recorded.total) ? recorded.total : finite(sum) ? sum : 0,
	};
}

function backfillMissingCatalogCosts(database: Database): void {
	const rows = database
		.prepare(`
			SELECT id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
			FROM messages
			WHERE cost_total = 0 AND total_tokens > 0
				AND cost_input = 0 AND cost_output = 0 AND cost_cache_read = 0 AND cost_cache_write = 0
		`)
		.all() as CostBackfillRow[];

	if (rows.length === 0) return;

	const update = database.prepare(`
		UPDATE messages
		SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ?
		WHERE id = ?
	`);

	const applyBackfill = database.transaction(() => {
		for (const row of rows) {
			const cost = calculateCatalogCost(row.provider, row.model, {
				input: row.input_tokens,
				output: row.output_tokens,
				cacheRead: row.cache_read_tokens,
				cacheWrite: row.cache_write_tokens,
			});

			if (!cost || cost.total === 0) continue;

			update.run(cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total, row.id);
		}
	});

	applyBackfill();
}

/**
 * Get the stored offset for a session file.
 */
export function getFileOffset(sessionFile: string): { offset: number; lastModified: number } | null {
	if (!db) return null;

	const stmt = db.prepare("SELECT offset, last_modified FROM file_offsets WHERE session_file = ?");
	const row = stmt.get(sessionFile) as { offset: number; last_modified: number } | undefined;

	return row ? { offset: row.offset, lastModified: row.last_modified } : null;
}

/**
 * Update the stored offset for a session file.
 */
export function setFileOffset(sessionFile: string, offset: number, lastModified: number): void {
	if (!db) return;

	const stmt = db.prepare(`
		INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified)
		VALUES (?, ?, ?)
	`);
	stmt.run(sessionFile, offset, lastModified);
}

/**
 * Insert message stats into the database.
 */
export function insertMessageStats(stats: ParsedMessageStats[]): number {
	if (!db || stats.length === 0) return 0;

	// Use UPSERT so a re-sync can fix up `premium_requests` for rows persisted
	// before priority service-tier traffic was counted as premium. The guard
	// `WHERE messages.premium_requests < excluded.premium_requests` keeps every
	// other column immutable and never demotes an existing count (e.g. when a
	// later parse drops back to 0 for the same row).
	const stmt = db.prepare(`
		INSERT INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp,
			duration, ttft, stop_reason, error_message,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_file, entry_id) DO UPDATE SET
			premium_requests = excluded.premium_requests
		WHERE messages.premium_requests < excluded.premium_requests
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const cost = resolveStoredCost(s);
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.model,
				s.provider,
				s.api,
				s.timestamp,
				s.duration,
				s.ttft,
				s.stopReason,
				s.errorMessage,
				s.usage.input,
				s.usage.output,
				s.usage.cacheRead,
				s.usage.cacheWrite,
				s.usage.totalTokens,
				s.usage.premiumRequests ?? 0,
				cost.input,
				cost.output,
				cost.cacheRead,
				cost.cacheWrite,
				cost.total,
			);
			if (result.changes > 0) inserted++;
		}
	});

	insert();
	return inserted;
}

/**
 * Build aggregated stats from query results.
 */
function buildAggregatedStats(rows: any[]): AggregatedStats {
	if (rows.length === 0) {
		return {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			cacheRate: 0,
			totalCost: 0,
			totalPremiumRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: 0,
			lastTimestamp: 0,
		};
	}

	const row = rows[0];
	const totalRequests = row.total_requests || 0;
	const failedRequests = row.failed_requests || 0;
	const successfulRequests = totalRequests - failedRequests;
	const totalInputTokens = row.total_input_tokens || 0;
	const totalCacheReadTokens = row.total_cache_read_tokens || 0;
	const totalPremiumRequests = row.total_premium_requests || 0;

	return {
		totalRequests,
		successfulRequests,
		failedRequests,
		errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
		totalInputTokens,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		cacheRate:
			totalInputTokens + totalCacheReadTokens > 0
				? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)
				: 0,
		totalCost: row.total_cost || 0,
		totalPremiumRequests,
		avgDuration: row.avg_duration,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
		firstTimestamp: row.first_timestamp || 0,
		lastTimestamp: row.last_timestamp || 0,
	};
}

/**
 * Get overall aggregated stats.
 */
export function getOverallStats(cutoff?: number): AggregatedStats {
	if (!db) return buildAggregatedStats([]);

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`);

	const rows = hasCutoff ? stmt.all(cutoff) : stmt.all();
	return buildAggregatedStats(rows as any[]);
}
/**
 * Get stats grouped by model.
 */
export function getStatsByModel(cutoff?: number): ModelStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			model,
			provider,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_requests DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as any[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		...buildAggregatedStats([row]),
	}));
}

/**
 * Get stats grouped by folder.
 */
export function getStatsByFolder(cutoff?: number): FolderStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			folder,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY folder
		ORDER BY total_requests DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as any[];
	return rows.map(row => ({
		folder: row.folder,
		...buildAggregatedStats([row]),
	}));
}

/**
 * Get time series data.
 */
export function getTimeSeries(hours = 24, cutoff?: number | null, bucketMs = 60 * 60 * 1000): TimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - hours * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			COUNT(*) as requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as errors,
			SUM(total_tokens) as tokens,
			SUM(cost_total) as cost
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket
		ORDER BY bucket ASC
	`);

	const rows = hasCutoff
		? (stmt.all(bucketMs, bucketMs, seriesCutoff) as any[])
		: (stmt.all(bucketMs, bucketMs) as any[]);
	return rows.map(row => ({
		timestamp: row.bucket,
		requests: row.requests,
		errors: row.errors,
		tokens: row.tokens,
		cost: row.cost,
	}));
}

/**
 * Get daily performance time series data for the last N days.
 */
/**
 * Get daily model usage time series data for the last N days.
 */
export function getModelTimeSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ModelTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			model,
			provider,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{ bucket: number; model: string; provider: string; requests: number }>;
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
	}));
}

/**
 * Get daily model performance time series data for the last N days.
 */
export function getModelPerformanceSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ModelPerformancePoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			model,
			provider,
			COUNT(*) as requests,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{
		bucket: number;
		model: string;
		provider: string;
		requests: number;
		avg_ttft: number | null;
		avg_tokens_per_second: number | null;
	}>;
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
	}));
}

/**
 * Get total message count.
 */
export function getMessageCount(): number {
	if (!db) return 0;
	const stmt = db.prepare("SELECT COUNT(*) as count FROM messages");
	const row = stmt.get() as { count: number };
	return row.count;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function rowToMessageStats(row: any): MessageStats {
	return {
		id: row.id,
		sessionFile: row.session_file,
		entryId: row.entry_id,
		folder: row.folder,
		model: row.model,
		provider: row.provider,
		api: row.api,
		timestamp: row.timestamp,
		duration: row.duration,
		ttft: row.ttft,
		stopReason: row.stop_reason as any,
		errorMessage: row.error_message,
		usage: {
			input: row.input_tokens,
			output: row.output_tokens,
			cacheRead: row.cache_read_tokens,
			cacheWrite: row.cache_write_tokens,
			totalTokens: row.total_tokens,
			premiumRequests: row.premium_requests ?? 0,
			cost: {
				input: row.cost_input,
				output: row.cost_output,
				cacheRead: row.cost_cache_read,
				cacheWrite: row.cost_cache_write,
				total: row.cost_total,
			},
		},
	};
}

export function getRecentRequests(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT * FROM messages 
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return (stmt.all(limit) as any[]).map(rowToMessageStats);
}

export function getRecentErrors(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT * FROM messages 
		WHERE stop_reason = 'error'
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return (stmt.all(limit) as any[]).map(rowToMessageStats);
}

export function getMessageById(id: number): MessageStats | null {
	if (!db) return null;
	const stmt = db.prepare("SELECT * FROM messages WHERE id = ?");
	const row = stmt.get(id);
	return row ? rowToMessageStats(row) : null;
}

/**
 * Get daily cost time series data for the last N days, broken down by model.
 */
export function getCostTimeSeries(days = 90, cutoff?: number | null): CostTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / 86400000) * 86400000 as bucket,
			model,
			provider,
			SUM(cost_total) as cost,
			SUM(cost_input) as cost_input,
			SUM(cost_output) as cost_output,
			SUM(cost_cache_read) as cost_cache_read,
			SUM(cost_cache_write) as cost_cache_write,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rows = hasCutoff ? (stmt.all(seriesCutoff) as any[]) : (stmt.all() as any[]);
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		cost: row.cost,
		costInput: row.cost_input,
		costOutput: row.cost_output,
		costCacheRead: row.cost_cache_read,
		costCacheWrite: row.cost_cache_write,
		requests: row.requests,
	}));
}

/**
 * Reset `file_offsets` (and any existing `user_messages` rows) so the next
 * successful sync re-parses every session and re-derives behavioral metrics.
 * Run once per metric-definition bump; the meta sentinel is only marked
 * complete after `syncAllSessions` finishes. Older timestamp sentinel values
 * are treated as pending so a failed compiled-binary sync cannot permanently
 * suppress the backfill.
 *
 * - v1: initial introduction of `user_messages`.
 * - v2: yelling-sentence metric replaces caps-word counts; existing rows are
 *   computed under the old definition and must be discarded.
 * - v3: drama runs collapsed into `anguish` (drama + elongated interjections
 *   + `dude` + dot runs), scored on a stripped prose body and gated on
 *   line count. Existing rows used the narrower definition.
 * - v4: added `negation` / `repetition` / `blame` signals and fixed a
 *   latent word-boundary bug in the profanity / anguish regexes that had
 *   left those metrics matching nothing in real prose.
 * - v5: renamed `yelling_sentences` column to `yelling` to match the other
 *   single-word signal columns (profanity, anguish, negation, ...).
 *
 * Existing `messages` rows are unaffected - `INSERT OR IGNORE` keeps them.
 */
function backfillUserMessages(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(USER_MESSAGES_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.exec("DELETE FROM user_messages");
	database.exec("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(USER_MESSAGES_BACKFILL_KEY, BACKFILL_PENDING);
}

/**
 * One-shot wipe of `file_offsets` to force `parseSessionFile` to re-parse
 * every session from byte zero. We don't touch `user_messages`; the parser
 * now emits a `UserMessageLink` for every assistant->parent pair, and the
 * guarded `updateUserMessageLinks` UPDATE fixes any row whose `model` was
 * left NULL by the old in-pass-only linking logic. Idempotent: gated by a
 * sentinel row in `meta`.
 */
function repairUserMessageLinks(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(USER_MESSAGE_LINKS_REPAIR_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.exec("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(USER_MESSAGE_LINKS_REPAIR_KEY, BACKFILL_PENDING);
}

/**
 * One-shot wipe of `file_offsets` so the next sync re-parses every session
 * and re-derives `premium_requests` from recorded `service_tier_change`
 * entries. Earlier ingestions captured priority OpenAI traffic with
 * `premium_requests = 0` because the AI layer only set the field for GitHub
 * Copilot traffic. The parser now folds priority requests into the same
 * counter; combined with the UPSERT in `insertMessageStats`, a single sync
 * pass brings the messages table up to date without touching any other
 * column. Idempotent: gated by a sentinel row in `meta`.
 */
function backfillPriorityPremiumRequests(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.exec("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY, BACKFILL_PENDING);
}

export function markPriorityPremiumRequestsBackfillComplete(): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
		PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY,
		BACKFILL_COMPLETE,
	);
}

export function markUserMessagesBackfillComplete(): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
		USER_MESSAGES_BACKFILL_KEY,
		BACKFILL_COMPLETE,
	);
}

export function markUserMessageLinksRepairComplete(): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
		USER_MESSAGE_LINKS_REPAIR_KEY,
		BACKFILL_COMPLETE,
	);
}

/**
 * Insert user-message stats. Idempotent via UNIQUE(session_file, entry_id).
 */
export function insertUserMessageStats(stats: UserMessageStats[]): number {
	if (!db || stats.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT OR IGNORE INTO user_messages (
			session_file, entry_id, folder, timestamp, model, provider,
			chars, words, yelling, profanity, anguish,
			negation, repetition, blame
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.timestamp,
				s.model,
				s.provider,
				s.chars,
				s.words,
				s.yelling,
				s.profanity,
				s.anguish,
				s.negation,
				s.repetition,
				s.blame,
			);
			if (result.changes > 0) inserted++;
		}
	});
	insert();
	return inserted;
}

/**
 * Backfill the responding `model`/`provider` on user-message rows that were
 * persisted before their assistant reply was parsed (a side effect of
 * incremental `fromOffset` syncing: the `userByEntryId` map in
 * `parseSessionFile` only spans a single pass). Each row is updated at most
 * once because the `model IS NULL` guard short-circuits subsequent passes.
 *
 * Returns the number of rows actually updated.
 */
export function updateUserMessageLinks(links: UserMessageLink[]): number {
	if (!db || links.length === 0) return 0;

	const stmt = db.prepare(`
		UPDATE user_messages
		   SET model = ?, provider = ?
		 WHERE session_file = ? AND entry_id = ? AND model IS NULL
	`);

	let updated = 0;
	const apply = db.transaction(() => {
		for (const link of links) {
			const result = stmt.run(link.model, link.provider, link.sessionFile, link.entryId);
			if (result.changes > 0) updated++;
		}
	});
	apply();
	return updated;
}

const UNKNOWN_MODEL = "unknown";

interface BehaviorSeriesRow {
	bucket: number;
	model: string;
	provider: string;
	messages: number;
	yelling: number | null;
	profanity: number | null;
	anguish: number | null;
	negation: number | null;
	repetition: number | null;
	blame: number | null;
	chars: number | null;
}

/**
 * Daily behavioral time series, grouped by responding model+provider.
 */
export function getBehaviorTimeSeries(cutoff?: number | null): BehaviorTimeSeriesPoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			(timestamp / 86400000) * 86400000 as bucket,
			COALESCE(model, ?) as model,
			COALESCE(provider, ?) as provider,
			COUNT(*) as messages,
			SUM(yelling) as yelling,
			SUM(profanity) as profanity,
			SUM(anguish) as anguish,
			SUM(negation) as negation,
			SUM(repetition) as repetition,
			SUM(blame) as blame,
			SUM(chars) as chars
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);
	const rows = (
		hasCutoff ? stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff) : stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL)
	) as BehaviorSeriesRow[];
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		messages: row.messages,
		yelling: row.yelling ?? 0,
		profanity: row.profanity ?? 0,
		anguish: row.anguish ?? 0,
		negation: row.negation ?? 0,
		repetition: row.repetition ?? 0,
		blame: row.blame ?? 0,
		chars: row.chars ?? 0,
	}));
}

interface BehaviorOverallRow {
	total_messages: number;
	total_yelling: number | null;
	total_profanity: number | null;
	total_anguish: number | null;
	total_negation: number | null;
	total_repetition: number | null;
	total_blame: number | null;
	total_chars: number | null;
	first_timestamp: number | null;
	last_timestamp: number | null;
}

/**
 * Overall behavioral totals across the cutoff window.
 */
export function getBehaviorOverall(cutoff?: number | null): BehaviorOverallStats {
	const empty: BehaviorOverallStats = {
		totalMessages: 0,
		totalYelling: 0,
		totalProfanity: 0,
		totalAnguish: 0,
		totalNegation: 0,
		totalRepetition: 0,
		totalBlame: 0,
		totalChars: 0,
		firstTimestamp: 0,
		lastTimestamp: 0,
	};
	if (!db) return empty;
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as BehaviorOverallRow | undefined;
	if (!row?.total_messages) return empty;
	return {
		totalMessages: row.total_messages,
		totalYelling: row.total_yelling ?? 0,
		totalProfanity: row.total_profanity ?? 0,
		totalAnguish: row.total_anguish ?? 0,
		totalNegation: row.total_negation ?? 0,
		totalRepetition: row.total_repetition ?? 0,
		totalBlame: row.total_blame ?? 0,
		totalChars: row.total_chars ?? 0,
		firstTimestamp: row.first_timestamp ?? 0,
		lastTimestamp: row.last_timestamp ?? 0,
	};
}

interface BehaviorByModelRow {
	model: string;
	provider: string;
	total_messages: number;
	total_yelling: number | null;
	total_profanity: number | null;
	total_anguish: number | null;
	total_negation: number | null;
	total_repetition: number | null;
	total_blame: number | null;
	total_chars: number | null;
	last_timestamp: number | null;
}

/**
 * Per-model behavioral totals over the cutoff window. "Unknown" represents
 * user messages that never received an assistant reply.
 */
export function getBehaviorByModel(cutoff?: number | null): BehaviorModelStats[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COALESCE(model, ?) as model,
			COALESCE(provider, ?) as provider,
			COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_messages DESC
	`);
	const rows = (
		hasCutoff ? stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff) : stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL)
	) as BehaviorByModelRow[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		totalMessages: row.total_messages,
		totalYelling: row.total_yelling ?? 0,
		totalProfanity: row.total_profanity ?? 0,
		totalAnguish: row.total_anguish ?? 0,
		totalNegation: row.total_negation ?? 0,
		totalRepetition: row.total_repetition ?? 0,
		totalBlame: row.total_blame ?? 0,
		totalChars: row.total_chars ?? 0,
		lastTimestamp: row.last_timestamp ?? 0,
	}));
}
