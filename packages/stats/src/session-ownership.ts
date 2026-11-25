/**
 * Session ownership counters (single-owner design §2.9) in the local stats database.
 *
 * Each gjc process that counted ownership events adds one row per counter when it exits. The
 * writer is synchronous and self-contained, because it runs in a process `exit` handler; it is the
 * only code that creates the table, so a machine that never counted anything keeps its database
 * exactly as before. Nothing here leaves the machine.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { SessionOwnershipStats } from "./shared-types";

const TABLE = "session_ownership_events";
const COUNTER_NAME = /^[a-z_]{1,64}$/;
/** An exiting process waits at most this long for a concurrent `gjc stats` sync, then drops its counts. */
export const SESSION_OWNERSHIP_WRITE_BUSY_TIMEOUT_MS = 1_000;

/**
 * Append one process's counts, as one report: every row of a write carries the same fresh
 * `report_id`, so two processes that exit in the same millisecond still count as two reports.
 * Zero and malformed entries are skipped, and with nothing left the database is not opened at all.
 * Never creates a directory: a missing parent fails, like any other failure, with an error the
 * caller drops. A table from before `report_id` gains the column here, inside the write's
 * transaction; the reader never alters it.
 *
 * The transaction is IMMEDIATE: it takes the write lock first, waiting under the busy timeout. The
 * writer reads (the table check and its columns) before it inserts, and a deferred transaction that
 * has read cannot upgrade once another process has committed: it fails at once, without waiting.
 */
export function recordSessionOwnershipCounts(
	dbPath: string,
	counts: Readonly<Record<string, number>>,
	meta: { readonly timestamp: number; readonly gjcVersion: string },
): void {
	const rows = Object.entries(counts).filter(
		([name, count]) => COUNTER_NAME.test(name) && Number.isSafeInteger(count) && count > 0,
	);
	if (rows.length === 0) return;
	const db = new Database(dbPath, { create: true });
	try {
		db.exec(`PRAGMA busy_timeout = ${SESSION_OWNERSHIP_WRITE_BUSY_TIMEOUT_MS}`);
		const reportId = randomUUID();
		db.transaction(() => {
			db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				timestamp INTEGER NOT NULL,
				name TEXT NOT NULL,
				count INTEGER NOT NULL,
				gjc_version TEXT NOT NULL,
				report_id TEXT
			)`);
			if (!tableColumns(db).has("report_id")) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN report_id TEXT`);
			const insert = db.prepare(
				`INSERT INTO ${TABLE} (timestamp, name, count, gjc_version, report_id) VALUES (?, ?, ?, ?, ?)`,
			);
			for (const [name, count] of rows) insert.run(meta.timestamp, name, count, meta.gjcVersion, reportId);
		}).immediate();
	} finally {
		db.close();
	}
}

/**
 * Rows the reader trusts: the columns typed as the writer writes them, a counter name and a version
 * of the writer's shapes, a positive count, and a timestamp a `Date` can hold. Anything else (a
 * hand-edited or corrupted row) is skipped rather than allowed to break or skew the report.
 */
const VALID_ROW = `typeof(timestamp) = 'integer' AND timestamp BETWEEN ?1 AND 8640000000000000
	AND typeof(count) = 'integer' AND count BETWEEN 1 AND 1000000000
	AND typeof(name) = 'text' AND length(name) BETWEEN 1 AND 64 AND name NOT GLOB '*[^a-z_]*'
	AND typeof(gjc_version) = 'text' AND length(gjc_version) BETWEEN 1 AND 64
	AND gjc_version NOT GLOB '*[^0-9A-Za-z.+-]*'`;
const COLUMNS = ["timestamp", "name", "count", "gjc_version"];

function tableColumns(db: Database): Set<string> {
	return new Set((db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]).map(column => column.name));
}

/**
 * What identifies one process report: its `report_id`, or, for a row written before that column
 * (null, or a table the writer has not migrated yet), its write time, as the reader counted before.
 */
function reportKey(hasReportId: boolean): { readonly key: string; readonly valid: string } {
	const legacy = `'t:' || timestamp`;
	if (!hasReportId) return { key: legacy, valid: "1" };
	return {
		key: `COALESCE(report_id, ${legacy})`,
		valid: "(report_id IS NULL OR (typeof(report_id) = 'text' AND length(report_id) BETWEEN 1 AND 64))",
	};
}

interface TotalRow {
	version: string;
	name: string;
	total: number;
}

interface ReportRow {
	version: string | null;
	reports: number;
	first: number;
	last: number;
}

/**
 * All-time totals (or since `cutoff`), per counter and per gjc version, with how many process
 * reports they come from (distinct report ids; distinct write times for legacy rows), so "zero"
 * reads apart from "nothing reported". `undefined` when nothing valid was recorded or the table has
 * another shape. Never creates or alters it. One read transaction, so the column check, the totals
 * and the report counts see the same rows while processes exit and write.
 */
export function readSessionOwnershipStats(db: Database, cutoff = 0): SessionOwnershipStats | undefined {
	try {
		return db.transaction(() => readInSnapshot(db, cutoff))();
	} catch {
		return undefined;
	}
}

function readInSnapshot(db: Database, cutoff: number): SessionOwnershipStats | undefined {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE)) return undefined;
	const columns = tableColumns(db);
	if (!COLUMNS.every(column => columns.has(column))) return undefined;
	const report = reportKey(columns.has("report_id"));
	const where = `${VALID_ROW} AND ${report.valid}`;
	const totals = db
		.prepare(
			`SELECT gjc_version AS version, name, SUM(count) AS total FROM ${TABLE}
				WHERE ${where} GROUP BY gjc_version, name ORDER BY gjc_version, name`,
		)
		.all(cutoff) as TotalRow[];
	if (totals.length === 0) return undefined;
	const reports = db
		.prepare(
			`SELECT gjc_version AS version, COUNT(DISTINCT ${report.key}) AS reports, MIN(timestamp) AS first,
				MAX(timestamp) AS last FROM ${TABLE} WHERE ${where} GROUP BY gjc_version
				UNION ALL SELECT NULL, COUNT(DISTINCT ${report.key}), MIN(timestamp), MAX(timestamp)
				FROM ${TABLE} WHERE ${where}`,
		)
		.all(cutoff) as ReportRow[];
	return summarize(totals, reports);
}

function summarize(totals: readonly TotalRow[], reports: readonly ReportRow[]): SessionOwnershipStats | undefined {
	const counters: Record<string, number> = {};
	const byVersion: Record<string, { reports: number; counters: Record<string, number> }> = {};
	for (const row of reports) if (row.version !== null) byVersion[row.version] = { reports: row.reports, counters: {} };
	for (const row of totals) {
		counters[row.name] = (counters[row.name] ?? 0) + row.total;
		const version = byVersion[row.version];
		if (version) version.counters[row.name] = row.total;
	}
	const all = reports.find(row => row.version === null);
	if (!all) return undefined;
	const sorted = Object.fromEntries(Object.entries(counters).sort(([a], [b]) => a.localeCompare(b)));
	return { counters: sorted, firstAt: all.first, lastAt: all.last, reports: all.reports, byVersion };
}
