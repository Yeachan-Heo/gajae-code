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
	test.skipIf(skipOnNonWindows)(
		"empty lock directory within grace period fails closed",
		async () => {
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
		},
	);

	test.skipIf(skipOnNonWindows)(
		"empty lock directory past grace period is reclaimed",
		async () => {
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
		},
	);
});
