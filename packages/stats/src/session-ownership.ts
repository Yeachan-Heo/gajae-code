/**
 * Session ownership counters (single-owner design §2.9) in the local stats database.
 *
 * Each gjc process that counted ownership events adds one row per counter when it exits. The
 * writer is synchronous and self-contained, because it runs in a process `exit` handler; it is the
 * only code that creates the table, so a machine that never counted anything keeps its database
 * exactly as before. Nothing here leaves the machine.
 */
import { Database } from "bun:sqlite";
import type { SessionOwnershipStats } from "./shared-types";

const TABLE = "session_ownership_events";
const COUNTER_NAME = /^[a-z_]{1,64}$/;
/** An exiting process waits at most this long for a concurrent `gjc stats` sync, then drops its counts. */
export const SESSION_OWNERSHIP_WRITE_BUSY_TIMEOUT_MS = 1_000;

/**
 * Append one process's counts. Zero and malformed entries are skipped, and with nothing left the
 * database is not opened at all. Never creates a directory: a missing parent fails, like any other
 * failure, with an error the caller drops.
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
		db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp INTEGER NOT NULL,
			name TEXT NOT NULL,
			count INTEGER NOT NULL,
			gjc_version TEXT NOT NULL
		)`);
		const insert = db.prepare(`INSERT INTO ${TABLE} (timestamp, name, count, gjc_version) VALUES (?, ?, ?, ?)`);
		db.transaction(() => {
			for (const [name, count] of rows) insert.run(meta.timestamp, name, count, meta.gjcVersion);
		})();
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
 * reports (distinct write times) they come from, so "zero" reads apart from "nothing reported".
 * `undefined` when nothing valid was recorded or the table has another shape. Never creates it.
 */
export function readSessionOwnershipStats(db: Database, cutoff = 0): SessionOwnershipStats | undefined {
	try {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE)) return undefined;
		const columns = new Set(
			(db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]).map(column => column.name),
		);
		if (!COLUMNS.every(column => columns.has(column))) return undefined;
		const totals = db
			.prepare(
				`SELECT gjc_version AS version, name, SUM(count) AS total FROM ${TABLE}
				WHERE ${VALID_ROW} GROUP BY gjc_version, name ORDER BY gjc_version, name`,
			)
			.all(cutoff) as TotalRow[];
		if (totals.length === 0) return undefined;
		const reports = db
			.prepare(
				`SELECT gjc_version AS version, COUNT(DISTINCT timestamp) AS reports, MIN(timestamp) AS first,
				MAX(timestamp) AS last FROM ${TABLE} WHERE ${VALID_ROW} GROUP BY gjc_version
				UNION ALL SELECT NULL, COUNT(DISTINCT timestamp), MIN(timestamp), MAX(timestamp)
				FROM ${TABLE} WHERE ${VALID_ROW}`,
			)
			.all(cutoff) as ReportRow[];
		return summarize(totals, reports);
	} catch {
		return undefined;
	}
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
