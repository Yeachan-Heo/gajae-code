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
	FileLockTestHooks.beforeOwnerlessLockRmdir = undefined;
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

test("reclaims an ownerless empty lock older than grace period at broker startup", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "1-reclaim", "index.jsonl");
	const lockPath = `${filePath}.lock`;

	// Create the empty lock directory structure
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });

	const release = await withClockAdvanced(120_000, () => acquireFileLock(filePath, { retries: 1 }));

	// Lock should be acquired successfully (reclaimed the old empty lock)
	expect(release).toBeTruthy();
	expect(typeof release).toBe("function");

	await release();
});

test("does not reclaim a fresh ownerless empty lock within grace period", async () => {
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
		// Expected: should fail because lock is held by ownerless empty dir but not old enough
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

test("rmdir preserves a legacy holder that writes after the ownerless age check", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "4-race", "index.jsonl");
	const lockPath = `${filePath}.lock`;
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });
	let injected = false;
	const info = JSON.stringify({
		pid: process.pid,
		owner_token: crypto.randomUUID(),
		timestamp: Date.now(),
	});
	FileLockTestHooks.beforeOwnerlessLockRmdir = async pathBeingRemoved => {
		expect(pathBeingRemoved).toBe(lockPath);
		injected = true;
		await fs.writeFile(path.join(lockPath, "info"), info, { mode: 0o600 });
	};

	await withClockAdvanced(120_000, async () => {
		try {
			await acquireFileLock(filePath, { retries: 1, retryDelayMs: 10 });
			expect.unreachable("Should have contended with the legacy holder");
		} catch (error) {
			expect(String(error)).toContain("Failed to acquire lock");
		}
	});

	expect(injected).toBe(true);
	expect(await fs.readFile(path.join(lockPath, "info"), "utf8")).toBe(info);
	expect(await fs.readdir(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
});
