import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getStatsDbPath, TempDir } from "@gajae-code/utils";
import { getDashboardStats } from "../src/aggregator";
import { closeDb, initDb } from "../src/db";
import {
	readSessionOwnershipStats,
	recordSessionOwnershipCounts,
	SESSION_OWNERSHIP_WRITE_BUSY_TIMEOUT_MS,
} from "../src/session-ownership";

const originalConfigDir = process.env.PI_CONFIG_DIR;
let tempDir: TempDir | null = null;
const meta = (timestamp: number, gjcVersion = "0.22.1") => ({ timestamp, gjcVersion });

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "gjc-stats-session-ownership-"));
	process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempDir.join("config"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	tempDir?.removeSync();
	tempDir = null;
});

async function freshDb(): Promise<string> {
	await initDb();
	closeDb();
	return getStatsDbPath();
}

/**
 * Another process that holds the database's write lock for `holdMs`. Resolves once the lock is
 * taken (a marker file, not stdout, which a child may flush only at exit) to the child's exit.
 */
async function holdWriteLock(dbPath: string, holdMs: number): Promise<{ readonly exited: Promise<number> }> {
	const marker = `${dbPath}.locked`;
	const script = `const { Database } = require("bun:sqlite");
const fs = require("node:fs");
const db = new Database(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
fs.writeFileSync(process.argv[3], "");
Bun.sleepSync(Number(process.argv[2]));
db.exec("COMMIT");
db.close();`;
	const child = Bun.spawn([process.execPath, "-e", script, dbPath, String(holdMs), marker], {
		env: { PATH: process.env.PATH, HOME: tempDir?.path() ?? os.tmpdir() },
		stdout: "ignore",
		stderr: "pipe",
	});
	for (let attempt = 0; !(await Bun.file(marker).exists()); attempt++) {
		if (attempt > 500) throw new Error("lock holder did not start");
		await Bun.sleep(10);
	}
	// Wrapped: an async function returning the bare promise would wait for the exit itself.
	return { exited: child.exited };
}

/** Whether another connection holds the write lock now (a zero-timeout attempt to take it fails). */
function writeLocked(dbPath: string): boolean {
	const probe = new Database(dbPath);
	try {
		probe.exec("BEGIN IMMEDIATE");
		probe.exec("ROLLBACK");
		return false;
	} catch {
		return true;
	} finally {
		probe.close();
	}
}

function read(dbPath: string) {
	const db = new Database(dbPath, { readonly: true });
	try {
		return readSessionOwnershipStats(db);
	} finally {
		db.close();
	}
}

describe("session ownership counters in the stats database", () => {
	it("gjc stats waits for an exiting process's write instead of failing", async () => {
		const dbPath = await freshDb();
		const holder = await holdWriteLock(dbPath, 1_500);
		expect(writeLocked(dbPath)).toBe(true);
		const stats = await getDashboardStats();
		expect(stats.overall.totalRequests).toBe(0);
		expect(await holder.exited).toBe(0);
	});

	it("an exit write waits for a short lock, and never creates a directory", async () => {
		const dbPath = await freshDb();
		expect(SESSION_OWNERSHIP_WRITE_BUSY_TIMEOUT_MS).toBeGreaterThan(700);
		const holder = await holdWriteLock(dbPath, 700);
		expect(writeLocked(dbPath)).toBe(true);
		recordSessionOwnershipCounts(dbPath, { claim_taken: 1 }, meta(1_000));
		expect(await holder.exited).toBe(0);
		expect(read(dbPath)?.counters).toEqual({ claim_taken: 1 });

		const missing = path.join(tempDir?.path() ?? "", "absent", "stats.db");
		expect(() => recordSessionOwnershipCounts(missing, { claim_taken: 1 }, meta(1_000))).toThrow();
		await expect(fs.lstat(path.dirname(missing))).rejects.toThrow();
	});

	it("reports totals per version with the number of process reports", async () => {
		const dbPath = await freshDb();
		recordSessionOwnershipCounts(dbPath, { claim_taken: 2, held_at_exit: 1 }, meta(1_000, "0.22.1"));
		recordSessionOwnershipCounts(dbPath, { claim_taken: 3 }, meta(2_000, "0.22.1"));
		recordSessionOwnershipCounts(dbPath, { claim_taken: 1, claim_released: 1 }, meta(3_000, "0.23.0"));
		expect(read(dbPath)).toEqual({
			counters: { claim_released: 1, claim_taken: 6, held_at_exit: 1 },
			firstAt: 1_000,
			lastAt: 3_000,
			reports: 3,
			byVersion: {
				"0.22.1": { reports: 2, counters: { claim_taken: 5, held_at_exit: 1 } },
				"0.23.0": { reports: 1, counters: { claim_released: 1, claim_taken: 1 } },
			},
		});
	});

	it("skips invalid rows, and a table of another shape, instead of failing", async () => {
		const dbPath = await freshDb();
		recordSessionOwnershipCounts(dbPath, { claim_taken: 1 }, meta(1_000));
		const db = new Database(dbPath);
		const insert = db.prepare(
			"INSERT INTO session_ownership_events (timestamp, name, count, gjc_version) VALUES (?, ?, ?, ?)",
		);
		insert.run(1e20, "claim_taken", 5, "0.22.1");
		insert.run(2_000, "claim\u001b[31m", 5, "0.22.1");
		insert.run(2_000, "claim_taken", 5, "0.22\u001b[2J");
		insert.run(2_000, "claim_taken", "five", "0.22.1");
		insert.run(2_000, "claim_taken", -5, "0.22.1");
		insert.run(2_000, "claim_taken", 9e15, "0.22.1");
		db.close();
		expect(read(dbPath)).toMatchObject({ counters: { claim_taken: 1 }, reports: 1, lastAt: 1_000 });

		const other = new Database(dbPath);
		other.exec("DROP TABLE session_ownership_events");
		other.exec("CREATE TABLE session_ownership_events (id INTEGER PRIMARY KEY, label TEXT)");
		other.exec("INSERT INTO session_ownership_events (label) VALUES ('x')");
		other.close();
		expect(read(dbPath)).toBeUndefined();
		expect((await getDashboardStats()).sessionOwnership).toBeUndefined();
	});
});
