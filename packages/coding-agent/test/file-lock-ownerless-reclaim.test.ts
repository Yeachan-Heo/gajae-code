import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock, FileLockTestHooks } from "@gajae-code/coding-agent/config/file-lock";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";

const tempDirs: { path: string; forget: () => void }[] = [];
const origEnv = process.env.GJC_CODING_AGENT_DIR;

beforeEach(() => {
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => fs.rm(stagingPath, { recursive: true, force: true });
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

async function withClockAdvanced<T>(milliseconds: number, operation: () => Promise<T>): Promise<T> {
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + milliseconds);
	try {
		return await operation();
	} finally {
		clock.mockRestore();
	}
}

test("does not reclaim an ownerless empty lock directory, even if aged", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "1-aged-empty", "index.jsonl");
	const lockPath = `${filePath}.lock`;

	// Create an empty lock directory and let it age beyond the grace period
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });

	// Attempt to acquire the lock after simulating time passing
	// Without age-based reclamation, this should fail because the lock is ambiguously owned
	await withClockAdvanced(120_000, async () => {
		try {
			await acquireFileLock(filePath, { retries: 1, retryDelayMs: 10 });
			expect.unreachable("Should have failed to acquire ownerless lock");
		} catch (error) {
			// Expected: should fail because the lock is ownerless and we don't assume the owner is dead
			expect(String(error)).toContain("Failed to acquire lock");
		}
	});

	// The lock directory should still exist (not reclaimed)
	const stat = await fs.lstat(lockPath);
	expect(stat.isDirectory()).toBe(true);
});

test("does not reclaim an ownerless empty lock (fresh or aged)", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "2-fresh", "index.jsonl");
	const lockPath = `${filePath}.lock`;

	// Create the empty lock directory structure
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });

	// Attempt to acquire the lock - should fail with timeout
	try {
		await acquireFileLock(filePath, { retries: 1, retryDelayMs: 10 });
		expect.unreachable("Should have failed to acquire fresh ownerless lock");
	} catch (error) {
		// Expected: should fail because lock is held by ownerless empty dir
		expect(String(error)).toContain("Failed to acquire lock");
	}

	// The lock directory should still exist
	const stat = await fs.lstat(lockPath);
	expect(stat.isDirectory()).toBe(true);
});

test("never steals a lock held by a live owner", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "3-owned", "index.jsonl");
	const lockPath = `${filePath}.lock`;

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
		{ mode: 0o600 },
	);

	// Attempt to acquire the lock - should fail because lock is held by live owner
	await withClockAdvanced(120_000, async () => {
		try {
			await acquireFileLock(filePath, { retries: 1, retryDelayMs: 10 });
			expect.unreachable("Should have failed to acquire owned lock");
		} catch (error) {
			expect(String(error)).toContain("Failed to acquire lock");
		}
	});
});

test("fails closed when a legacy writer hasn't yet written to an aged empty lock directory", async () => {
	// This test demonstrates that WITHOUT the fix (age-based reclamation),
	// a race condition exists where a legacy publisher can write to a lock
	// directory after it's been removed by a new acquirer.
	// WITH the fix, age-based reclamation is removed entirely, preventing this race.

	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "4-legacy-race", "index.jsonl");
	const lockPath = `${filePath}.lock`;
	const originalIdentity = { dev: 0n, ino: 0n };

	// Create an empty lock directory
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });

	// Capture the original inode
	const originalStat = await fs.stat(lockPath, { bigint: true });
	originalIdentity.dev = originalStat.dev;
	originalIdentity.ino = originalStat.ino;

	// Attempt to acquire the lock after simulating the aging of the empty directory
	await withClockAdvanced(120_000, async () => {
		try {
			await acquireFileLock(filePath, { retries: 1, retryDelayMs: 10 });
			expect.unreachable("Should have failed to acquire ownerless lock");
		} catch (error) {
			expect(String(error)).toContain("Failed to acquire lock");
		}
	});

	// Verify the lock directory still exists with the same inode (no reclamation occurred)
	const currentStat = await fs.stat(lockPath, { bigint: true });
	expect(currentStat.dev).toBe(originalIdentity.dev);
	expect(currentStat.ino).toBe(originalIdentity.ino);
});
