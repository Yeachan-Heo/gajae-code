import { afterEach, beforeEach, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock, FileLockTestHooks } from "@gajae-code/coding-agent/config/file-lock";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";

const tempDirs: { path: string; forget: () => void }[] = [];
const origEnv = process.env.GJC_CODING_AGENT_DIR;

beforeEach(() => {
	FileLockTestHooks.cleanupPendingStaging = async stagingPath =>
		fs.rm(stagingPath, { recursive: true, force: true });
});

afterEach(async () => {
	FileLockTestHooks.cleanupPendingStaging = undefined;
	if (origEnv) process.env.GJC_CODING_AGENT_DIR = origEnv;
	else delete process.env.GJC_CODING_AGENT_DIR;

	for (const { path: dir, forget } of tempDirs.splice(0)) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} finally {
			forget();
		}
	}
});

async function createTempDir(): Promise<string> {
	const canonicalTempRoot = await fs.realpath(os.tmpdir());
	const dir = path.join(canonicalTempRoot, `file-lock-ownerless-${crypto.randomUUID()}`);
	const forgetRoots: (() => void)[] = [];
	const forget = () => {
		for (const forgetRoot of forgetRoots) forgetRoot();
	};
	try {
		forgetRoots.push(registerOwnedDeletionRoot(dir));
		await fs.mkdir(dir, { mode: 0o700 });
	} catch (error) {
		forget();
		throw error;
	}
	tempDirs.push({ path: dir, forget });
	return dir;
}

async function setMtimeToAge(filePath: string, ageMs: number): Promise<void> {
	const now = Date.now();
	const pastTime = now - ageMs;
	const stats = await fs.stat(filePath);
	await fs.utimes(filePath, pastTime / 1000, pastTime / 1000);
}

test("reclaims an ownerless empty lock older than grace period at broker startup", async () => {
	const tempRoot = await createTempDir();
	const lockPath = path.join(tempRoot, "sdk", "sessions", "index.jsonl.lock");

	// Create the empty lock directory structure
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });

	// Age it beyond the grace period (90 seconds)
	await setMtimeToAge(lockPath, 120_000);

	// Attempt to acquire the lock
	const release = await acquireFileLock(lockPath, { retries: 1 });

	// Lock should be acquired successfully (reclaimed the old empty lock)
	expect(release).toBeTruthy();
	expect(typeof release).toBe("function");

	// The old lock directory should be quarantined/removed
	const entries = await fs.readdir(path.dirname(lockPath));
	const lockDirExists = entries.some(entry => entry === path.basename(lockPath));
	expect(lockDirExists).toBe(false); // Old empty lock should be gone

	await release();
});

test("does not reclaim a fresh ownerless empty lock within grace period", async () => {
	const tempRoot = await createTempDir();
	const lockPath = path.join(tempRoot, "sdk", "sessions", "index.jsonl.lock");

	// Create the empty lock directory structure
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });

	// Keep it fresh (within grace period)
	// Default is 90 seconds, so we age it only 5 seconds
	await setMtimeToAge(lockPath, 5_000);

	// Attempt to acquire the lock - should fail with timeout
	try {
		await acquireFileLock(lockPath, { retries: 1, retryDelayMs: 10 });
		expect.unreachable("Should have failed to acquire fresh ownerless lock");
	} catch (error) {
		// Expected: should fail because lock is held by ownerless empty dir but not old enough
		expect(String(error)).toContain("Failed to acquire lock");
	}

	// The lock directory should still exist
	const stat = await fs.lstat(lockPath);
	expect(stat.isDirectory()).toBe(true);
});

test("never steals a lock held by a live owner", async () => {
	const tempRoot = await createTempDir();
	const lockPath = path.join(tempRoot, "sdk", "sessions", "index.jsonl.lock");

	// Create the lock directory with an info file (simulating a live owner)
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });
	await fs.writeFile(
		path.join(lockPath, "info"),
		JSON.stringify({
			pid: process.pid,
			owner_host_id: undefined,
			owner_token: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
		}),
		{ mode: 0o600 }
	);

	// Age it beyond the grace period
	await setMtimeToAge(lockPath, 120_000);

	// Attempt to acquire the lock - should fail because lock is held by live owner
	try {
		await acquireFileLock(lockPath, { retries: 1, retryDelayMs: 10 });
		expect.unreachable("Should have failed to acquire owned lock");
	} catch (error) {
		// Expected: should fail because lock has an owner
		expect(String(error)).toContain("Failed to acquire lock");
	}
});

test("garbage collects stale lock debris when acquiring lock", async () => {
	const tempRoot = await createTempDir();
	const lockPath = path.join(tempRoot, "sdk", "sessions", "index.jsonl.lock");
	const lockDir = path.dirname(lockPath);

	// Create the lock directory parent
	await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });

	// Create some stale debris files (older than 24 hours)
	const debris = [
		path.join(lockDir, `${path.basename(lockPath)}.pending.${process.pid}.old1`),
		path.join(lockDir, `${path.basename(lockPath)}.removing.owner.${crypto.randomUUID()}`),
		path.join(lockDir, `${path.basename(lockPath)}.stale-${Date.now()}`),
	];

	for (const debrisPath of debris) {
		await fs.writeFile(debrisPath, "stale");
	}

	// Age all debris beyond 24 hours
	for (const debrisPath of debris) {
		await setMtimeToAge(debrisPath, 86_400_000 + 10_000); // 24h + 10s
	}

	// Create a fresh lock directory to acquire
	await fs.mkdir(lockPath, { mode: 0o700 });

	// Acquire the lock - this should GC the stale debris
	const release = await acquireFileLock(lockPath, { retries: 1 });

	// Verify stale debris is gone
	const entries = await fs.readdir(lockDir);
	for (const entry of entries) {
		// Only the lock directory should remain
		expect(entry).toBe(path.basename(lockPath));
	}

	await release();
});
