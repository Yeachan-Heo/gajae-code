import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getHistoryDbPath, logger } from "@gajae-code/utils";

export interface HistoryEntry {
	id: number;
	prompt: string;
	created_at: number;
	cwd?: string;
}

type HistoryRow = {
	id: number;
	prompt: string;
	created_at: number;
	cwd: string | null;
};

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

// Escape LIKE wildcards so user input is treated as literal text.
// Matches the `ESCAPE '\\'` clause used by substring-search statements.
function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

const HISTORY_SUFFIXES = ["", "-wal", "-shm"] as const;
let openingHistory: Database | undefined;

function secureHistoryPath(pathname: string, kind: "directory" | "file"): void {
	if (process.platform !== "win32") return;
	const native = require("@gajae-code/natives") as typeof import("@gajae-code/natives");
	const applied = native.applyOwnerOnlyPathSecurity(pathname, kind);
	const verified = native.verifyOwnerOnlyPathSecurity(pathname, kind);
	if (applied?.ok !== true || verified?.ok !== true) {
		throw new Error("history database owner-only protection could not be established");
	}
}

function historyErrno(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function historyLeaf(dbPath: string, suffix: string): fs.BigIntStats | undefined {
	try {
		return fs.lstatSync(`${dbPath}${suffix}`, { bigint: true });
	} catch (error) {
		if (historyErrno(error) !== "ENOENT") throw error;
		return undefined;
	}
}

function assertRegularHistoryLeaf(existing: fs.BigIntStats | undefined): void {
	if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
		throw new Error("history database path is not a regular file");
	}
}

function assertHistoryLeaves(dbPath: string): Set<string> {
	const present = new Set<string>();
	for (const suffix of HISTORY_SUFFIXES) {
		const existing = historyLeaf(dbPath, suffix);
		assertRegularHistoryLeaf(existing);
		if (existing) present.add(suffix);
	}
	return present;
}

function removeNewHistoryLeaves(): void {
	// A WAL reader can stay live while BEGIN EXCLUSIVE succeeds, so failure
	// cleanup must not unlink a database another opener has adopted.
	try {
		openingHistory?.close();
	} catch {
		// The caller reports the original open failure.
	}
	openingHistory = undefined;
}

function readHistoryDirectory(dir: string): fs.Stats | undefined {
	let existing: fs.Stats;
	try {
		existing = fs.lstatSync(dir);
	} catch (error) {
		if (historyErrno(error) !== "ENOENT") throw error;
		return undefined;
	}
	if (existing.isSymbolicLink() || !existing.isDirectory()) {
		throw new Error("history database directory is not a real directory");
	}
	return existing;
}

function tightenHistoryDirectory(dir: string): void {
	let existing = readHistoryDirectory(dir);
	if (!existing) {
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (error) {
			if (historyErrno(error) !== "EEXIST") throw error;
		}
		existing = readHistoryDirectory(dir);
		if (!existing) throw new Error("history database directory is not a real directory");
	}
	secureHistoryPath(dir, "directory");
	if (process.platform === "win32") return;
	// 0300/0700 are already owner-only. Sticky directories are shared and stay as they are.
	// chmod(2) needs no read bit, so mode 0333 becomes 0700. A symlink swap is
	// followed by chmod; the recheck then refuses and no database file is created.
	if ((existing.mode & 0o077) === 0 || (existing.mode & 0o1000) !== 0) return;
	try {
		fs.chmodSync(dir, 0o700);
	} catch (error) {
		if (historyErrno(error) === "ELOOP") throw new Error("history database directory is not a real directory");
		throw error;
	}
	const after = readHistoryDirectory(dir);
	if (!after || (after.mode & 0o077) !== 0) {
		throw new Error("history database directory could not be tightened to mode 0700");
	}
}

function sameHistoryFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

function restrictHistoryFiles(dbPath: string, createMissingDb: boolean): void {
	const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
	for (const suffix of HISTORY_SUFFIXES) {
		const target = `${dbPath}${suffix}`;
		let existing = historyLeaf(dbPath, suffix);
		assertRegularHistoryLeaf(existing);
		if (!existing && suffix === "" && createMissingDb) {
			let created: number | undefined;
			try {
				created = fs.openSync(
					target,
					fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
					0o600,
				);
				fs.fchmodSync(created, 0o600);
			} catch (error) {
				if (historyErrno(error) === "ELOOP") throw new Error("history database path is not a regular file");
				if (historyErrno(error) !== "EEXIST") throw error;
			} finally {
				if (created !== undefined) fs.closeSync(created);
			}
			existing = historyLeaf(dbPath, suffix);
			assertRegularHistoryLeaf(existing);
			if (!existing) throw new Error("history database path is not a regular file");
		}
		if (!existing) continue;
		secureHistoryPath(target, "file");
		if (process.platform === "win32" || (Number(existing.mode) & 0o077) === 0) continue;
		let fd: number | undefined;
		try {
			fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
			const opened = fs.fstatSync(fd, { bigint: true });
			const again = historyLeaf(dbPath, suffix);
			if (!again || !opened.isFile() || !sameHistoryFile(existing, opened) || !sameHistoryFile(opened, again)) {
				throw new Error("history database path is not a regular file");
			}
			fs.fchmodSync(fd, 0o600);
			if ((Number(fs.fstatSync(fd, { bigint: true }).mode) & 0o777) !== 0o600) {
				throw new Error("history database path could not be tightened to mode 0600");
			}
		} catch (error) {
			if (historyErrno(error) === "ELOOP") throw new Error("history database path is not a regular file");
			throw error;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
}

class AsyncDrain<T> {
	#queue?: T[];
	#promise = Promise.resolve();

	constructor(readonly delayMs: number = 0) {}

	push(value: T, hnd: (values: T[]) => Promise<void> | void): Promise<void> {
		let queue = this.#queue;
		if (!queue) {
			this.#queue = queue = [];
			this.#promise = new Promise((resolve, reject) => {
				const exec = () => {
					try {
						if (this.#queue === queue) {
							this.#queue = undefined;
						}
						resolve(hnd(queue!));
					} catch (error) {
						reject(error);
					}
				};

				if (this.delayMs > 0) {
					setTimeout(exec, this.delayMs);
				} else {
					queueMicrotask(exec);
				}
			});
		}
		queue.push(value);
		return this.#promise;
	}
}

export class HistoryStorage {
	#db: Database;
	static #instance?: HistoryStorage;
	static #opening?: Promise<HistoryStorage>;
	#drain = new AsyncDrain<Pick<HistoryEntry, "prompt" | "cwd">>(100);

	// Prepared statements
	#insertRowStmt: Statement;
	#recentStmt: Statement;
	#recentByCwdStmt: Statement;
	#searchStmt: Statement;
	#searchByCwdStmt: Statement;
	#lastPromptStmt: Statement;
	// Cache substring-fallback prepared statements keyed by token count.
	#substringStmts = new Map<number, Statement>();
	// Cache cwd-filtered substring-fallback statements keyed by token count.
	#substringCwdStmts = new Map<number, Statement>();

	// In-memory cache of last prompt to avoid sync DB reads on add
	#lastPromptCache: string | null = null;

	private constructor(dbPath: string) {
		this.#db = new Database(dbPath);
		openingHistory = this.#db;

		const hasFts = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();

		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_cwd_created_at ON history(cwd, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
	END;
	`);

		if (this.#historySchemaUsesUnixEpoch()) {
			this.#migrateHistorySchema();
		}

		if (!hasFts) {
			try {
				this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
			} catch (error) {
				logger.warn("HistoryStorage FTS rebuild failed", { error: String(error) });
			}
		}

		this.#recentStmt = this.#db.prepare(
			"SELECT id, prompt, created_at, cwd FROM history ORDER BY created_at DESC, id DESC LIMIT ?",
		);
		this.#recentByCwdStmt = this.#db.prepare(
			"SELECT id, prompt, created_at, cwd FROM history WHERE cwd = ? ORDER BY created_at DESC, id DESC LIMIT ?",
		);
		this.#searchStmt = this.#db.prepare(
			"SELECT h.id, h.prompt, h.created_at, h.cwd FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ? ORDER BY h.created_at DESC, h.id DESC LIMIT ?",
		);
		this.#searchByCwdStmt = this.#db.prepare(
			"SELECT h.id, h.prompt, h.created_at, h.cwd FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ? AND h.cwd = ? ORDER BY h.created_at DESC, h.id DESC LIMIT ?",
		);
		this.#lastPromptStmt = this.#db.prepare("SELECT prompt FROM history ORDER BY id DESC LIMIT 1");

		this.#insertRowStmt = this.#db.prepare("INSERT INTO history (prompt, cwd) VALUES (?, ?)");

		const last = this.#lastPromptStmt.get() as { prompt?: string } | undefined;
		this.#lastPromptCache = last?.prompt ?? null;
		try {
			restrictHistoryFiles(dbPath, false);
		} catch (error) {
			this.#db.close();
			throw error;
		}
		openingHistory = undefined;
	}

	static #openNew(dbPath: string): HistoryStorage {
		openingHistory = undefined;
		assertHistoryLeaves(dbPath);
		try {
			tightenHistoryDirectory(path.dirname(dbPath));
			assertHistoryLeaves(dbPath);
			restrictHistoryFiles(dbPath, true);
			return new HistoryStorage(dbPath);
		} catch (error) {
			removeNewHistoryLeaves();
			throw error;
		}
	}

	static open(dbPath: string = getHistoryDbPath()): HistoryStorage {
		if (!HistoryStorage.#instance) {
			HistoryStorage.#instance = HistoryStorage.#openNew(dbPath);
		}
		return HistoryStorage.#instance;
	}

	static async openAsync(dbPath: string = getHistoryDbPath()): Promise<HistoryStorage> {
		if (HistoryStorage.#instance) return HistoryStorage.#instance;
		if (!HistoryStorage.#opening) {
			HistoryStorage.#opening = Promise.resolve()
				.then(() => {
					const storage = HistoryStorage.#openNew(dbPath);
					HistoryStorage.#instance ??= storage;
					return HistoryStorage.#instance;
				})
				.finally(() => {
					HistoryStorage.#opening = undefined;
				});
		}
		return HistoryStorage.#opening;
	}

	/** @internal Reset the singleton — test-only. */
	static resetInstance(): void {
		HistoryStorage.#instance = undefined;
		HistoryStorage.#opening = undefined;
	}

	#insertBatch(rows: Array<Pick<HistoryEntry, "prompt" | "cwd">>): void {
		this.#db.transaction((rows: Array<Pick<HistoryEntry, "prompt" | "cwd">>) => {
			for (const row of rows) {
				this.#insertRowStmt.run(row.prompt, row.cwd ?? null);
			}
		})(rows);
	}

	add(prompt: string, cwd?: string): Promise<void> {
		const trimmed = prompt.trim();
		if (!trimmed) return Promise.resolve();
		if (this.#lastPromptCache === trimmed) return Promise.resolve();
		this.#lastPromptCache = trimmed;
		return this.#drain.push({ prompt: trimmed, cwd: cwd ?? undefined }, rows => {
			this.#insertBatch(rows);
		});
	}

	getRecent(limit: number, cwd?: string): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		try {
			const rows = (
				cwd === undefined ? this.#recentStmt.all(safeLimit) : this.#recentByCwdStmt.all(cwd, safeLimit)
			) as HistoryRow[];
			return rows.map(row => this.#toEntry(row));
		} catch (error) {
			logger.error("HistoryStorage getRecent failed", { error: String(error) });
			return [];
		}
	}

	search(query: string, limit: number, cwd?: string): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const tokens = this.#tokenize(query);
		if (tokens.length === 0) return [];

		// 1. FTS5 prefix match (token AND, prefix-wildcard per token).
		//    Handles punctuation by tokenizing query the same way unicode61 tokenizer
		//    indexed the stored text, so "git-commit" -> "git"* "commit"*.
		const ftsQuery = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" ");
		let ftsRows: HistoryRow[] = [];
		try {
			ftsRows = (
				cwd === undefined
					? this.#searchStmt.all(ftsQuery, safeLimit)
					: this.#searchByCwdStmt.all(ftsQuery, cwd, safeLimit)
			) as HistoryRow[];
		} catch (error) {
			// Malformed FTS expression - fall through to substring path.
			logger.debug("HistoryStorage FTS query failed, using substring only", { error: String(error) });
		}

		if (ftsRows.length >= safeLimit) {
			return ftsRows.map(row => this.#toEntry(row));
		}

		// 2. Substring fallback (token-AND LIKE). Catches infix matches FTS5's
		//    prefix-only wildcard cannot reach (e.g. "mit" -> "commit"). Bounded
		//    by safeLimit, ordered by recency - no full-table load into JS.
		let subRows: HistoryRow[] = [];
		try {
			subRows = this.#searchSubstring(tokens, safeLimit, cwd);
		} catch (error) {
			logger.error("HistoryStorage substring search failed", { error: String(error) });
		}

		if (ftsRows.length === 0) {
			return subRows.map(row => this.#toEntry(row));
		}

		const seen = new Set<number>();
		const merged: HistoryEntry[] = [];
		for (const row of ftsRows) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			merged.push(this.#toEntry(row));
		}
		for (const row of subRows) {
			if (merged.length >= safeLimit) break;
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			merged.push(this.#toEntry(row));
		}
		return merged;
	}

	#historySchemaUsesUnixEpoch(): boolean {
		const row = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history'").get() as
			| { sql?: string | null }
			| undefined;
		return row?.sql?.includes("unixepoch(") ?? false;
	}

	#migrateHistorySchema(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE history RENAME TO history_legacy");
			this.#db.run("DROP INDEX IF EXISTS idx_history_created_at");
			this.#db.run("DROP TRIGGER IF EXISTS history_ai");
			this.#db.run("DROP TABLE IF EXISTS history_fts");
			this.#db.run(`
CREATE TABLE history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_cwd_created_at ON history(cwd, created_at DESC);
INSERT INTO history (id, prompt, created_at, cwd)
SELECT id, prompt, created_at, cwd
FROM history_legacy;
DROP TABLE history_legacy;
CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id');
CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
			`);
			this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
		});
		migrate();
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	/**
	 * Split on non-alphanumeric runs, mirroring FTS5's `unicode61` tokenizer so
	 * query tokens align with how stored prompts were indexed. Lowercases for
	 * stable substring matching.
	 */
	#tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(tok => tok.length > 0);
	}

	#searchSubstring(tokens: string[], limit: number, cwd?: string): HistoryRow[] {
		const stmt = this.#getSubstringStmt(tokens.length, cwd !== undefined);
		const params: unknown[] = tokens.map(tok => `%${escapeLikePattern(tok)}%`);
		if (cwd !== undefined) params.push(cwd);
		params.push(limit);
		return stmt.all(...(params as [string, ...unknown[]])) as HistoryRow[];
	}

	#getSubstringStmt(tokenCount: number, withCwd: boolean): Statement {
		const cache = withCwd ? this.#substringCwdStmts : this.#substringStmts;
		let stmt = cache.get(tokenCount);
		if (stmt) return stmt;
		const whereClause = Array(tokenCount).fill("prompt LIKE ? ESCAPE '\\' COLLATE NOCASE").join(" AND ");
		const cwdClause = withCwd ? " AND cwd = ?" : "";
		stmt = this.#db.prepare(
			`SELECT id, prompt, created_at, cwd FROM history WHERE ${whereClause}${cwdClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
		);
		cache.set(tokenCount, stmt);
		return stmt;
	}

	#toEntry(row: HistoryRow): HistoryEntry {
		return {
			id: row.id,
			prompt: row.prompt,
			created_at: row.created_at,
			cwd: row.cwd ?? undefined,
		};
	}
}
