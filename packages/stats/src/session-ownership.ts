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
/** An exiting process waits at most this long for a concurrent `gjc stats` sync. */
const BUSY_TIMEOUT_MS = 250;

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
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
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

interface TotalRow {
	name: string;
	total: number;
	first: number;
	last: number;
}

/** Totals since `cutoff`, or `undefined` when nothing was recorded. Never creates the table. */
export function readSessionOwnershipStats(db: Database, cutoff = 0): SessionOwnershipStats | undefined {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE)) return undefined;
	const rows = db
		.prepare(
			`SELECT name, SUM(count) AS total, MIN(timestamp) AS first, MAX(timestamp) AS last
			FROM ${TABLE} WHERE timestamp >= ? GROUP BY name ORDER BY name`,
		)
		.all(cutoff) as TotalRow[];
	if (rows.length === 0) return undefined;
	return {
		counters: Object.fromEntries(rows.map(row => [row.name, row.total])),
		firstAt: Math.min(...rows.map(row => row.first)),
		lastAt: Math.max(...rows.map(row => row.last)),
	};
}
