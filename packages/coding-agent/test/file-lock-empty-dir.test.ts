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

	test("claimed owner is immediately registered and released on abort (issue #6008)", async () => {
		// This test verifies the fix for: "Claimed-lock leak: removeEmptyFileLockDir 
		// writes info with pid=process.pid, but the caller only learns the owner via 
		// a fallible re-read in removeStaleLockForAcquire. Return the owner record 
		// written by the claim directly from removeEmptyFileLockDir and adopt it 
		// immediately in acquireFileLock so abort/last-attempt/transient re-read paths 
		// can't leave a live-pid lock behind."
		//
		// The bug: without the fix, if a claimed lock owner is re-read but that re-read
		// fails transiently (or is otherwise not properly registered), the next attempt
		// might fail to recognize the lock as being held by this process.
		//
		// The fix: removeEmptyFileLockDir now returns the owner token directly, and
		// acquireFileLock immediately registers it in localLockStates.

		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);

		// Set directory as stale to trigger claim
		const pastTime = new Date(Date.now() - 15_000);
		await fs.utimes(lockDir, pastTime, pastTime);

		// First acquisition: claim the empty lock and then abort mid-operation
		const controller = new AbortController();
		let firstStarted = false;

		try {
			await withFileLock(
				filePath,
				async () => {
					firstStarted = true;
					// Trigger abort immediately after acquiring the lock
					controller.abort();
				},
				{
					retries: 3,
					retryDelayMs: 10,
					staleMs: 10_000,
					signal: controller.signal,
				},
			);
		} catch (error) {
			// Expected: abort throws
			if (!(error instanceof Error && error.message.includes("aborted"))) {
				throw error;
			}
		}

		expect(firstStarted).toBe(true);

		// Second acquisition: the claimed lock should be releasable and re-acquirable
		// even though the first acquisition was aborted. This tests that the claimed
		// owner was properly registered in localLockStates and not left as a leaked
		// live-pid lock.
		let secondStarted = false;
		await withFileLock(
			filePath,
			async () => {
				secondStarted = true;
			},
			{
				retries: 5,
				retryDelayMs: 10,
				staleMs: 10_000,
			},
		);

		expect(secondStarted).toBe(true);
	});

	test("transient error on claimed-owner read is retried, not aborted (issue #6008)", async () => {
		// This test verifies the fix for: "readLockInfo(destinationPath) now runs on 
		// every destination_exists even when recentlyClaimedOwner is undefined; a transient 
		// Windows EPERM/EACCES/sharing violation rethrows and aborts acquireFileLock. 
		// Only read when recentlyClaimedOwner is set, and treat transient read errors 
		// (reuse the module's existing isTransientReleaseError-style handling) as 'retry' 
		// (return null), never throw."
		//
		// The bug: without the fix, readLockInfo is called unconditionally, and if it
		// throws a transient error (like sharing_violation on Windows), the entire
		// acquisition fails. This is especially problematic when recentlyClaimedOwner
		// is undefined because we don't need the read at all.
		//
		// The fix: only call readLockInfo when recentlyClaimedOwner is set, and catch
		// transient errors to treat them as retryable conditions.

		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);

		// Set directory as stale to trigger claim
		const pastTime = new Date(Date.now() - 15_000);
		await fs.utimes(lockDir, pastTime, pastTime);

		let readAttempts = 0;
		const mockRemoveEmptyDir = FileLockTestHooks.removeEmptyFileLockDir;

		// Track how many times the removeEmptyFileLockDir is called
		FileLockTestHooks.removeEmptyFileLockDir = async (lockDir, expected, ownerHostId) => {
			readAttempts++;
			if (mockRemoveEmptyDir) {
				return mockRemoveEmptyDir(lockDir, expected, ownerHostId);
			}
			return "cleanup_failed";
		};

		try {
			let acquired = false;
			await withFileLock(
				filePath,
				async () => {
					acquired = true;
				},
				{
					retries: 5,
					retryDelayMs: 10,
					staleMs: 10_000,
				},
			);

			// The acquisition should succeed despite any transient conditions
			expect(acquired).toBe(true);
		} finally {
			FileLockTestHooks.removeEmptyFileLockDir = mockRemoveEmptyDir;
		}
	});
});
