import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireStatus } from "@gajae-code/natives";
import { closeDb } from "@gajae-code/stats";
import { readSessionOwnershipStats, recordSessionOwnershipCounts } from "@gajae-code/stats/session-ownership";
import { getStatsDbPath } from "@gajae-code/utils";
import { runStatsCommand } from "../../src/cli/stats-cli";
import {
	claimSessionOwner,
	persistSessionOwnershipCounters,
	resetSessionOwnershipForTests,
	SessionOwnershipTestHooks,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";

const supported = process.platform === "linux" || process.platform === "darwin";
const holderScript = path.join(import.meta.dir, "session-ownership-holder-child.ts");
const TIMEOUT_MS = 60_000;

let root: string;
let preloadHome: string | undefined;
let dbPath: string;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ownership-counters-")));
	preloadHome = SessionOwnershipTestHooks.homeOverride;
	SessionOwnershipTestHooks.homeOverride = root;
	dbPath = path.join(root, "stats.db");
	SessionOwnershipTestHooks.statsDbPath = dbPath;
	resetSessionOwnershipForTests();
});

afterEach(async () => {
	try {
		resetSessionOwnershipForTests();
	} finally {
		delete SessionOwnershipTestHooks.lockBackend;
		delete SessionOwnershipTestHooks.statsDbPath;
		SessionOwnershipTestHooks.homeOverride = preloadHome;
		await fs.rm(root, { recursive: true, force: true });
	}
});

function recorded(file = dbPath): Readonly<Record<string, number>> | undefined {
	const db = new Database(file, { readonly: true });
	try {
		return readSessionOwnershipStats(db)?.counters;
	} finally {
		db.close();
	}
}

describe("session ownership counters", () => {
	it.if(supported)("count locks, conflicts and fail-open claims", async () => {
		const first = await claimSessionOwner("counted", { surface: "terminal" });
		const shared = await claimSessionOwner("counted", { surface: "terminal" });
		if (first.status !== "claimed" || shared.status !== "claimed") throw new Error("expected claims");
		expect(sessionOwnershipCounters()).toMatchObject({ claim_taken: 1, claim_released: 0 });
		shared.claim.release();
		expect(sessionOwnershipCounters().claim_released).toBe(0);
		first.claim.release();
		expect(sessionOwnershipCounters().claim_released).toBe(1);

		const answers = [FileLockAcquireStatus.Held, FileLockAcquireStatus.TimedOut, FileLockAcquireStatus.Unavailable];
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async () => ({ status: answers.shift() ?? FileLockAcquireStatus.Unavailable, code: "ENOLCK" }),
			probe: async () => {
				throw new Error("no probe");
			},
		};
		expect((await claimSessionOwner("a", { surface: "terminal" })).status).toBe("held");
		expect((await claimSessionOwner("b", { surface: "terminal" })).status).toBe("skipped");
		expect((await claimSessionOwner("c", { surface: "terminal" })).status).toBe("skipped");
		// Latched unavailable: every later claim is also a fail-open claim.
		expect((await claimSessionOwner("d", { surface: "terminal" })).status).toBe("skipped");
		expect(sessionOwnershipCounters()).toMatchObject({ claim_conflict: 1, fail_open: 3, claim_taken: 1 });
	});

	it.if(supported)("are written once each, and held locks count at exit", async () => {
		const claim = await claimSessionOwner("exit-held", { surface: "print" });
		if (claim.status !== "claimed") throw new Error("expected a claim");
		persistSessionOwnershipCounters();
		persistSessionOwnershipCounters();
		expect(recorded()).toEqual({ claim_taken: 1 });

		persistSessionOwnershipCounters({ atExit: true });
		expect(recorded()).toEqual({ claim_taken: 1, held_at_exit: 1 });
		claim.claim.release();
	});

	it("record nothing, and create no database, when nothing was counted", async () => {
		persistSessionOwnershipCounters({ atExit: true });
		recordSessionOwnershipCounts(dbPath, { claim_taken: 0, "bad name": 3 }, { timestamp: 1, gjcVersion: "1" });
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("never write the operator's stats database from a test process", async () => {
		delete SessionOwnershipTestHooks.statsDbPath;
		const statsDb = getStatsDbPath();
		// The directory exists, so only the guard can keep the write out.
		await fs.mkdir(path.dirname(statsDb), { recursive: true });
		const before = await fs.stat(statsDb).then(
			stat => stat.mtimeMs,
			() => undefined,
		);
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async () => ({ status: FileLockAcquireStatus.Held }),
			probe: async () => {
				throw new Error("no probe");
			},
		};
		await claimSessionOwner("x", { surface: "terminal" });
		persistSessionOwnershipCounters({ atExit: true });
		expect(
			await fs.stat(statsDb).then(
				stat => stat.mtimeMs,
				() => undefined,
			),
		).toBe(before);
	});
});

describe.if(supported)("a real process", () => {
	async function runHolder(sessionId: string, input: string): Promise<Readonly<Record<string, number>> | undefined> {
		const home = path.join(root, `home-${sessionId}`);
		await fs.mkdir(home, { mode: 0o700 });
		const env: Record<string, string | undefined> = { ...process.env, HOME: home };
		for (const key of Object.keys(env))
			if (key.startsWith("XDG_") || /^(GJC|PI)_(CONFIG|CODING_AGENT)_DIR$/.test(key)) delete env[key];
		const child = Bun.spawn([process.execPath, holderScript], {
			cwd: import.meta.dir,
			env: { ...env, OWNER_SESSION_ID: sessionId, OWNER_SURFACE: "terminal" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.write(input);
		await child.stdin.end();
		expect(await child.exited).toBe(0);
		return recorded(path.join(home, ".gjc", "stats.db"));
	}

	it(
		"writes its counts to the stats database when it exits",
		async () => {
			expect(await runHolder("released", "release\n")).toEqual({ claim_taken: 1, claim_released: 1 });
			expect(await runHolder("kept", "")).toEqual({ claim_taken: 1, held_at_exit: 1 });
		},
		TIMEOUT_MS,
	);
});

describe("gjc stats", () => {
	const originalConfigDir = process.env.PI_CONFIG_DIR;

	beforeEach(() => {
		process.env.PI_CONFIG_DIR = path.relative(os.homedir(), path.join(root, "config"));
	});

	afterEach(() => {
		closeDb();
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
	});

	async function stats(json: boolean): Promise<string> {
		const out: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
		const err = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await runStatsCommand({ port: 0, json, summary: !json });
		} finally {
			log.mockRestore();
			err.mockRestore();
			closeDb();
		}
		return out.join("\n");
	}

	it("shows all-time counter totals in --summary and --json, outside the default range", async () => {
		setSystemTime(new Date("2026-11-21T12:00:00Z"));
		try {
			await fs.mkdir(path.dirname(getStatsDbPath()), { recursive: true });
			const at = (iso: string) => ({ timestamp: Date.parse(iso), gjcVersion: "0.22.1" });
			// Older than the default 24 h range of the other stats: a gate reads these over a release.
			recordSessionOwnershipCounts(
				getStatsDbPath(),
				{ claim_taken: 3, held_at_exit: 1 },
				at("2026-11-02T10:00:00Z"),
			);
			recordSessionOwnershipCounts(
				getStatsDbPath(),
				{ claim_taken: 2, claim_released: 5 },
				at("2026-11-21T10:00:00Z"),
			);

			const json = JSON.parse(await stats(true));
			expect(json.sessionOwnership).toEqual({
				counters: { claim_released: 5, claim_taken: 5, held_at_exit: 1 },
				firstAt: Date.parse("2026-11-02T10:00:00Z"),
				lastAt: Date.parse("2026-11-21T10:00:00Z"),
				reports: 2,
				byVersion: { "0.22.1": { reports: 2, counters: { claim_released: 5, claim_taken: 5, held_at_exit: 1 } } },
			});
			expect(await stats(false)).toContain(
				[
					"Session Ownership (local counters, all time):",
					"  Recorded: 2026-11-02 to 2026-11-21, 2 process reports",
					"  claim_released: 5",
					"  claim_taken: 5",
					"  held_at_exit: 1",
					"  By version:",
					"    0.22.1 (2 reports): claim_released=5, claim_taken=5, held_at_exit=1",
				].join("\n"),
			);
		} finally {
			setSystemTime();
		}
	});

	it("is unchanged, and leaves the database schema alone, when nothing was recorded", async () => {
		const json = JSON.parse(await stats(true));
		expect(json).not.toHaveProperty("sessionOwnership");
		expect(await stats(false)).not.toContain("Session Ownership");
		const db = new Database(getStatsDbPath(), { readonly: true });
		try {
			expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'session_ownership%'").all()).toEqual([]);
		} finally {
			db.close();
		}
	});
});
