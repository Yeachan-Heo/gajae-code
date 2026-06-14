import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeFileLockDirForGc } from "@gajae-code/coding-agent/config/file-lock";
import { fileLocksGcAdapter } from "@gajae-code/coding-agent/config/file-lock-gc";
import type { GcContext, GcPidProbe, GcRecord } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";

const DEAD_PID = 525_252;
const LIVE_PID = 636_363;

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-toctou-"));
	tempDirs.push(dir);
	return dir;
}

async function writeInfo(lockDir: string, info: { pid: number; timestamp: number }): Promise<void> {
	await fs.mkdir(lockDir, { recursive: true });
	await fs.writeFile(path.join(lockDir, "info"), JSON.stringify(info), "utf8");
}

function ctxWith(spoolDir: string, probe: GcPidProbe): GcContext {
	return {
		probe,
		force: false,
		env: { ...process.env, GJC_RECEIPT_SPOOL_DIR: spoolDir },
		cwd: spoolDir,
	};
}

function deadLockRecord(lockDir: string): GcRecord {
	return {
		store: "file_locks",
		id: lockDir,
		path: lockDir,
		pid: DEAD_PID,
		pid_status: "dead",
		status: "dead",
		stale: true,
		removable: true,
		action: "none",
		reason: "file_lock_owner_pid_dead",
	};
}

describe("removeFileLockDirForGc owner-token guard (#606)", () => {
	test("removes the dir when the on-disk token matches the expected owner", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "match.lock");
		const token = { pid: DEAD_PID, timestamp: 1000 };
		await writeInfo(lockDir, token);

		const outcome = await removeFileLockDirForGc(lockDir, token);

		expect(outcome).toBe("removed");
		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("refuses (owner_changed) when a live owner has reclaimed the same path", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "reclaimed.lock");
		// On disk: a fresh live owner (different pid + timestamp).
		await writeInfo(lockDir, { pid: LIVE_PID, timestamp: 2000 });

		// Expected: the dead owner the GC observed earlier.
		const outcome = await removeFileLockDirForGc(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		expect(outcome).toBe("owner_changed");
		expect(await fs.exists(lockDir)).toBe(true);
		const onDisk = JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8"));
		expect(onDisk.pid).toBe(LIVE_PID);
	});

	test("refuses (owner_changed) when only the timestamp differs (same pid reused)", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "ts.lock");
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: 9999 });

		const outcome = await removeFileLockDirForGc(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		expect(outcome).toBe("owner_changed");
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("refuses (missing) when the info file is absent (fresh acquirer mid-mkdir)", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "noinfo.lock");
		await fs.mkdir(lockDir, { recursive: true });

		const outcome = await removeFileLockDirForGc(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		expect(outcome).toBe("missing");
		expect(await fs.exists(lockDir)).toBe(true);
	});
});

describe("fileLocksGcAdapter.prune TOCTOU (#606)", () => {
	test("prunes a genuinely dead lock (happy path still works)", async () => {
		const base = await makeTemp();
		const spoolDir = path.join(base, "spool");
		const lockDir = path.join(spoolDir, "dead.lock");
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: 1000 });
		const probe: GcPidProbe = pid => (pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: "alive" });

		const outcome = await fileLocksGcAdapter.prune(deadLockRecord(lockDir), ctxWith(spoolDir, probe));

		expect(outcome.removed).toBe(true);
		expect(outcome.skipped).toBeUndefined();
		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("fails closed when a live owner reclaims the stale lock between probe and unlink", async () => {
		const base = await makeTemp();
		const spoolDir = path.join(base, "spool");
		const lockDir = path.join(spoolDir, "race.lock");
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		// The probe reports DEAD (so prune proceeds toward deletion) but, as a
		// side effect, simulates a live owner reclaiming the stale dir at the same
		// path with a fresh identity — exactly the probe -> unlink TOCTOU window.
		let reclaimed = false;
		const racingProbe: GcPidProbe = pid => {
			if (pid === DEAD_PID && !reclaimed) {
				reclaimed = true;
				writeFileSync(path.join(lockDir, "info"), JSON.stringify({ pid: LIVE_PID, timestamp: 2000 }));
			}
			return pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: "alive" };
		};

		const outcome = await fileLocksGcAdapter.prune(deadLockRecord(lockDir), ctxWith(spoolDir, racingProbe));

		expect(outcome.removed).toBe(false);
		expect(outcome.skipped).toBe("file_lock_owner_changed_before_delete");
		// The freshly recreated LIVE lock must survive untouched.
		expect(await fs.exists(lockDir)).toBe(true);
		const onDisk = JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8"));
		expect(onDisk.pid).toBe(LIVE_PID);
		expect(onDisk.timestamp).toBe(2000);
	});
});
