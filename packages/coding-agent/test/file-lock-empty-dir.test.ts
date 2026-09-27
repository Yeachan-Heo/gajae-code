import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireError, withFileLock } from "@gajae-code/coding-agent/config/file-lock";

// This test only applies to Windows; on POSIX, empty lock directories are legacy holders
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
			// The fix ensures that the atomic rename + re-verification prevents
			// the removal from deleting the successor's lock.
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

			// Verify the lock directory exists with a valid info file
			const finalStat = await fs.stat(lockDir).catch(() => null);
			expect(finalStat).not.toBeNull();
			expect(finalStat?.isDirectory()).toBe(true);

			const infoStat = await fs.stat(path.join(lockDir, "info")).catch(() => null);
			expect(infoStat).not.toBeNull();

			// Verify no stale `.removing-*` tombstones are left behind
			const parentDir = path.dirname(lockDir);
			const entries = await fs.readdir(parentDir);
			const tombstones = entries.filter(e => e.match(/\.removing-/));
			expect(tombstones).toEqual([]);
		},
	);

	test.skipIf(skipOnNonWindows)(
		"successor lock survives race where successor is created after rename (issue #6008 fix)",
		async () => {
			const filePath = path.join(await makeTemp(), "index.jsonl");
			const lockDir = `${filePath}.lock`;
			await fs.mkdir(lockDir);
			// Create an empty lock directory with no info file

			// Set the directory's mtime to be old enough to be considered stale
			const pastTime = new Date(Date.now() - 15_000); // 15 seconds ago
			await fs.utimes(lockDir, pastTime, pastTime);

			// Use the test hook to inject a successor between the rename and re-verify.
			// This simulates the race condition where:
			// 1. removeEmptyFileLockDir checks and renames to tombstone
			// 2. After the rename, lockDir is free
			// 3. A concurrent process creates a new lock at lockDir
			// 4. removeEmptyFileLockDir re-verifies and detects identity mismatch
			// 5. The fix: restore the tombstone back to lockDir
			const { FileLockTestHooks } = await import("@gajae-code/coding-agent/config/file-lock");
			let successorCreated = false;
			FileLockTestHooks.afterEmptyLockDirRename = async (tombstonePath: string) => {
				if (!successorCreated) {
					// Simulate a successor creating a new lock at lockDir
					successorCreated = true;
					const successorLockDir = tombstonePath.replace(/\.removing-[a-f0-9-]+$/, ".lock");
					if (successorLockDir !== tombstonePath) {
						await fs.mkdir(successorLockDir, { recursive: true });
						// Create an info file to mark it as a live lock
						await fs.writeFile(
							path.join(successorLockDir, "info"),
							JSON.stringify({
								pid: process.pid,
								timestamp: Date.now(),
								start_time: "test-start",
							}),
						);
					}
				}
			};

			try {
				// Start the removal of the old lock via withFileLock.
				// This should detect stale empty directory and try to remove it.
				// The test hook will inject a successor, and the fix should restore it.
				let lockAcquired = false;
				await withFileLock(
					filePath,
					async () => {
						lockAcquired = true;
					},
					{
						retries: 5,
						retryDelayMs: 10,
						staleMs: 10_000,
					},
				);

				// The acquisition should succeed after removing the stale lock
				expect(lockAcquired).toBe(true);

				// Verify the lock directory still exists
				const lockDirStat = await fs.stat(lockDir).catch(() => null);
				expect(lockDirStat).not.toBeNull();
				expect(lockDirStat?.isDirectory()).toBe(true);

				// Verify the info file exists (either from the injected successor or from the acquisition)
				const infoStat = await fs.stat(path.join(lockDir, "info")).catch(() => null);
				expect(infoStat).not.toBeNull();

				// Verify no stale `.removing-*` tombstones are left behind
				// This ensures the race-condition fix actually restored the lock
				const parentDir = path.dirname(lockDir);
				const entries = await fs.readdir(parentDir);
				const tombstones = entries.filter(e => e.match(/\.removing-/));
				expect(tombstones).toEqual([]);
			} finally {
				FileLockTestHooks.afterEmptyLockDirRename = undefined;
			}
		},
	);
});
