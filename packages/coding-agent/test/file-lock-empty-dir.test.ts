import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireError, FileLockTestHooks, withFileLock } from "@gajae-code/coding-agent/config/file-lock";

const tempDirs: string[] = [];

beforeEach(() => {
	// Enable empty lock directory removal on all platforms for testing
	FileLockTestHooks.forceEnableEmptyLockDirRemoval = true;
});

afterEach(async () => {
	// Disable the test hook
	FileLockTestHooks.forceEnableEmptyLockDirRemoval = false;
	FileLockTestHooks.beforeEmptyLockDirClaim = undefined;

	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-empty-dir-"));
	tempDirs.push(dir);
	return dir;
}

describe("empty lock directory (issue #6008, claim-based ownership)", () => {
	test("empty lock directory within grace period fails closed", async () => {
		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);
		// Create an empty lock directory with no info file

		const attempt = withFileLock(filePath, async () => {}, {
			retries: 2,
			retryDelayMs: 1,
			staleMs: 10_000, // 10 second grace period
		});
		await expect(attempt).rejects.toBeInstanceOf(FileLockAcquireError);
		await expect(attempt).rejects.toMatchObject({
			code: "acquire_timeout",
		});
	});

	test("empty lock directory past grace period is reclaimed by claiming ownership", async () => {
		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);

		// Manually set the directory's mtime to be older than the stale threshold
		const pastTime = new Date(Date.now() - 15_000); // 15 seconds ago (past 10 second grace)
		await fs.utimes(lockDir, pastTime, pastTime);

		// Verify the directory is actually old
		const stat = await fs.stat(lockDir);
		const ageMs = Date.now() - stat.mtime.getTime();
		expect(ageMs).toBeGreaterThan(10_000); // Should be more than 10 seconds old

		// This should succeed now because the empty directory is old enough
		let acquired = false;
		await withFileLock(
			filePath,
			async () => {
				acquired = true;
			},
			{
				retries: 5,
				retryDelayMs: 10,
				staleMs: 10_000, // 10 second grace period
			},
		);

		expect(acquired).toBe(true);
		// After successful acquire and release, the lock directory may be
		// cleaned up by the release logic. The important thing is that
		// the acquisition succeeded.
	});

	test("deterministic race: stale-dir claim detects replacement and backs off safely", async () => {
		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);

		// Set the directory's mtime to be old enough to be considered stale
		const pastTime = new Date(Date.now() - 15_000); // 15 seconds ago
		await fs.utimes(lockDir, pastTime, pastTime);

		// Use the hook to simulate a concurrent removal and recreation (ABA race)
		// between the identity check and the exclusive-create claim
		let hookCalled = false;
		FileLockTestHooks.beforeEmptyLockDirClaim = async (checkDir: string) => {
			if (!hookCalled) {
				hookCalled = true;
				// Simulate a concurrent process:
				// 1. Remove the stale directory
				// 2. Create a fresh empty directory (ABA race)
				try {
					await fs.rmdir(checkDir);
					await fs.mkdir(checkDir);
				} catch {
					// Ignore if directory disappears between rmdir and mkdir
				}
			}
		};

		// Attempt to acquire the stale lock
		// The hook will remove and recreate the directory during our claim attempt
		// The claim logic should detect identity mismatch and back off safely
		try {
			await withFileLock(filePath, async () => {}, {
				retries: 5,
				retryDelayMs: 10,
				staleMs: 10_000,
			});
		} catch (error) {
			// Timeout is acceptable if the race causes contention
			if (error instanceof FileLockAcquireError) {
				expect(error.code).toBe("acquire_timeout");
			}
		}

		// The hook should have been called
		expect(hookCalled).toBe(true);

		// Most importantly: no info file should be left behind from a failed claim
		// that was only partially created before identity mismatch was detected
		const lockDirStat = await fs.stat(lockDir).catch(() => null);
		if (lockDirStat?.isDirectory()) {
			const infoPath = path.join(lockDir, "info");
			const infoStat = await fs.stat(infoPath).catch(() => null);

			// If info exists, verify it's valid (not a partially written file)
			if (infoStat?.isFile()) {
				const content = await fs.readFile(infoPath, "utf-8");
				expect(() => JSON.parse(content)).not.toThrow();
			}
		}
	});

	test("a claim on the final attempt is adopted, not leaked as a live-pid lock", async () => {
		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);
		const pastTime = new Date(Date.now() - 15_000);
		await fs.utimes(lockDir, pastTime, pastTime);

		// With a single attempt the claim is the last thing the acquisition does. It must
		// return the claimed lock instead of exiting with acquire_timeout while `info`
		// still names this process.
		let ran = false;
		await withFileLock(
			filePath,
			async () => {
				ran = true;
				const info = JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8"));
				expect(info.pid).toBe(process.pid);
			},
			{ retries: 1, retryDelayMs: 1, staleMs: 10_000 },
		);
		expect(ran).toBe(true);
		await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("an abort after the claim still returns the claimed lock to the caller", async () => {
		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);
		const pastTime = new Date(Date.now() - 15_000);
		await fs.utimes(lockDir, pastTime, pastTime);

		const controller = new AbortController();
		const original = FileLockTestHooks.removeEmptyFileLockDir!;
		FileLockTestHooks.removeEmptyFileLockDir = async (dir, expected, ownerHostId) => {
			const outcome = await original(dir, expected, ownerHostId);
			controller.abort();
			return outcome;
		};
		try {
			let ran = false;
			await withFileLock(
				filePath,
				async () => {
					ran = true;
				},
				{ retries: 5, retryDelayMs: 1, staleMs: 10_000, signal: controller.signal },
			);
			expect(ran).toBe(true);
		} finally {
			FileLockTestHooks.removeEmptyFileLockDir = original;
		}
		await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
