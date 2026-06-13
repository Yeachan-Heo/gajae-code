/**
 * Repro for #490 — SQLiteError: database is locked on Windows startup.
 *
 * `PRAGMA journal_mode=WAL` needs a brief exclusive lock. On Windows file
 * locks are mandatory, so if a concurrent process holds the database while
 * the WAL switch runs and no `busy_timeout` is active yet, SQLite fails
 * immediately with SQLITE_BUSY ("database is locked").
 *
 * SqliteAuthCredentialStore#initializeSchema must therefore set
 * `PRAGMA busy_timeout` BEFORE switching journal_mode (or running any other
 * lock-taking PRAGMA/operation). This test pins that ordering and confirms
 * WAL + synchronous=NORMAL are still applied.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "../src/auth-storage";

describe("issue #490 - SqliteAuthCredentialStore startup lock ordering", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-490-busy-timeout-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("applies busy_timeout before journal_mode=WAL during initialization", () => {
		const dbPath = path.join(tempDir, "agent.db");
		const db = new Database(dbPath);
		const ranSql: string[] = [];
		const originalRun = db.run.bind(db);
		db.run = ((sql: string) => {
			ranSql.push(String(sql));
			return originalRun(sql);
		}) as typeof db.run;

		const store = new SqliteAuthCredentialStore(db);
		try {
			const busyIdx = ranSql.findIndex(sql => /busy_timeout/i.test(sql));
			const walIdx = ranSql.findIndex(sql => /journal_mode\s*=\s*WAL/i.test(sql));

			expect(busyIdx).toBeGreaterThanOrEqual(0);
			expect(walIdx).toBeGreaterThanOrEqual(0);
			expect(busyIdx).toBeLessThan(walIdx);
		} finally {
			store.close();
		}
	});

	it("still enables WAL after initialization (behavior preserved)", async () => {
		const dbPath = path.join(tempDir, "agent2.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const probe = new Database(dbPath, { readonly: true });
			try {
				const journalMode = probe.query("PRAGMA journal_mode").get() as { journal_mode?: string };
				expect(journalMode.journal_mode?.toLowerCase()).toBe("wal");
			} finally {
				probe.close();
			}
		} finally {
			store.close();
		}
	});
});
