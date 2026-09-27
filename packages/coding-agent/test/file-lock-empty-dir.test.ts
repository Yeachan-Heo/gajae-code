import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireError, FileLockTestHooks, withFileLock } from "@gajae-code/coding-agent/config/file-lock";

// On POSIX, empty lock directories are legacy holders and are not automatically removed.
// These tests are Windows-specific because empty directory removal only happens on Windows.
const skipOnNonWindows = process.platform !== "win32";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-empty-dir-"));
	tempDirs.push(dir);
	return dir;
}

describe("empty lock directory (issue #6008, Windows only)", () => {
	test.skipIf(skipOnNonWindows)("empty lock directory within grace period fails closed", async () => {
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

	test.skipIf(skipOnNonWindows)("empty lock directory past grace period is reclaimed", async () => {
		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir);
		// Create an empty lock directory with no info file

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
		// After successful acquire, the lock should have been cleaned up or replaced
		const finalStat = await fs.stat(lockDir).catch(() => null);
		// The directory should either be removed or have an info file now
		if (finalStat) {
			const info = await fs.stat(path.join(lockDir, "info")).catch(() => null);
			expect(info).not.toBeNull();
		}
	});

	test.skipIf(skipOnNonWindows)(
		"concurrent acquire prevents stale-empty-dir removal from deleting successor lock (race test)",
		async () => {
			const filePath = path.join(await makeTemp(), "index.jsonl");
			const lockDir = `${filePath}.lock`;
			await fs.mkdir(lockDir);
			// Create an empty lock directory with no info file

			// Set the directory's mtime to be old enough to be considered stale
			const pastTime = new Date(Date.now() - 15_000); // 15 seconds ago
			await fs.utimes(lockDir, pastTime, pastTime);

			// Track whether both acquisitions succeeded
			const results: { name: string; acquired: boolean }[] = [];

			// Start two concurrent acquisitions on the same file.
			// One will detect the empty directory as stale and try to remove it.
			// The other will succeed in creating a new lock directory with an info file.
			// The fix ensures that non-recursive rmdir fails safely if a successor
			// is created after the identity check, allowing proper synchronization.
			const acquire1 = withFileLock(
				filePath,
				async () => {
					results.push({ name: "acquire1", acquired: true });
				},
				{
					retries: 3,
					retryDelayMs: 20,
					staleMs: 10_000,
				},
			);

			const acquire2 = withFileLock(
				filePath,
				async () => {
					results.push({ name: "acquire2", acquired: true });
				},
				{
					retries: 3,
					retryDelayMs: 20,
					staleMs: 10_000,
				},
			);

			// Run both acquisitions concurrently
			await Promise.all([acquire1, acquire2]);

			// Both acquisitions should succeed
			// (The second one waits for the first to complete the critical section)
			expect(results.length).toBe(2);
			expect(results.every(r => r.acquired)).toBe(true);

			// After both acquisitions have released, the lock directory may be removed.
			// The important thing is that the concurrent acquisitions both succeeded.

			// Verify no stale `.removing-*` artifacts are left behind
			// (these would only appear if rename-based approach was used)
			const parentDir = path.dirname(lockDir);
			const entries = await fs.readdir(parentDir);
			const tombstones = entries.filter(e => e.match(/\.removing-/));
			expect(tombstones).toEqual([]);
		},
	);

	test.skipIf(skipOnNonWindows)(
		"empty lock directory removal is safe when successor is created (race handling)",
		async () => {
			const filePath = path.join(await makeTemp(), "index.jsonl");
			const lockDir = `${filePath}.lock`;
			await fs.mkdir(lockDir);
			// Create an empty lock directory with no info file

			// Set the directory's mtime to be old enough to be considered stale
			const pastTime = new Date(Date.now() - 15_000); // 15 seconds ago
			await fs.utimes(lockDir, pastTime, pastTime);

			// Use the test hook to verify that rmdir handles non-empty directories safely.
			// This tests the core safety property: rmdir will fail if the directory
			// becomes non-empty after our identity check, and we handle that failure.
			let hookCalled = false;
			FileLockTestHooks.beforeEmptyLockDirRmdir = async (checkDir: string) => {
				if (!hookCalled) {
					// Simulate a concurrent process creating a successor by adding content
					hookCalled = true;
					await fs.writeFile(path.join(checkDir, "successor-marker"), "busy");
				}
			};

			try {
				// Start an acquisition of the stale empty lock.
				// This should detect the stale empty directory and try to remove it.
				// The test hook will make the directory non-empty before rmdir.
				// rmdir will fail, but the error handling should be correct.
				// Eventually, the acquisition should succeed or timeout gracefully.
				try {
					let lockAcquired = false;
					await withFileLock(
						filePath,
						async () => {
							lockAcquired = true;
						},
						{
							retries: 3,
							retryDelayMs: 5,
							staleMs: 10_000,
						},
					);
					// If we succeed, that's good
					expect(lockAcquired).toBe(true);
				} catch (error) {
					// If we timeout, that's expected when the race creates a marker that keeps
					// the directory non-empty. The important thing is that we don't delete the
					// directory or corrupt it, and the hook was called to verify our logic.
					expect(error).toBeInstanceOf(FileLockAcquireError);
				}

				// Verify that the hook was called (meaning we did attempt rmdir logic)
				expect(hookCalled).toBe(true);

				// Verify the lock directory still exists (not deleted by removal)
				const lockDirStat = await fs.stat(lockDir).catch(() => null);
				expect(lockDirStat?.isDirectory()).toBe(true);
			} finally {
				FileLockTestHooks.beforeEmptyLockDirRmdir = undefined;
			}
		},
	);
});
