import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockTestHooks } from "@gajae-code/coding-agent/config/file-lock";

const tempDirs: string[] = [];

afterEach(async () => {
	FileLockTestHooks.beforeEmptyLockDirRename = undefined;
	FileLockTestHooks.afterEmptyLockDirRename = undefined;
	FileLockTestHooks.removeEmptyFileLockDir = undefined;
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-empty-dir-race-"));
	tempDirs.push(dir);
	return dir;
}

describe("empty lock directory successor race condition (issue #6008, platform-neutral)", () => {
	test("successor lock is restored when created between identity check and rename", async () => {
		const tempDir = await makeTemp();
		const filePath = path.join(tempDir, "index.jsonl");
		const lockDir = `${filePath}.lock`;

		// Create an empty lock directory
		await fs.mkdir(lockDir);

		// Capture the directory identity
		const stat = await fs.stat(lockDir, { bigint: true });
		const expectedIdentity = {
			rootDev: String(stat.dev),
			rootIno: String(stat.ino),
			infoDev: "-1", // No info file for empty directory
			infoIno: "-1",
			infoNlink: "-1",
			infoSize: "-1",
			infoMtimeNs: "-1",
			infoCtimeNs: "-1",
			infoBirthtimeNs: "-1",
			infoSha256: "",
		};

		let successorCreated = false;
		let successorIdentity: { dev: string; ino: string } | null = null;
		let restoreAttempted = false;

		// Use the test hook to inject a successor BEFORE the rename.
		// This simulates the race where:
		// 1. The original lockDir is deleted by another process
		// 2. A new successor directory is created at lockDir with a new inode
		// 3. We then rename lockDir (which is now the successor)
		// 4. The identity re-check detects the mismatch (successor's inode != original's inode)
		// 5. The fix: restore the tombstone back to lockDir to preserve the successor
		FileLockTestHooks.beforeEmptyLockDirRename = async (checkLockDir: string) => {
			if (!successorCreated && checkLockDir === lockDir) {
				successorCreated = true;
				// Delete the original empty directory
				await fs.rm(checkLockDir, { recursive: true, force: true });
				// Create a new successor at the same path
				await fs.mkdir(checkLockDir, { recursive: true });
				// Create an info file to mark it as a live lock
				await fs.writeFile(
					path.join(checkLockDir, "info"),
					JSON.stringify({
						pid: 999_999, // Dead PID
						timestamp: Date.now(),
						start_time: "test-successor-start",
					}),
				);
				// Capture the successor's identity
				const successorStat = await fs.stat(checkLockDir, { bigint: true });
				successorIdentity = {
					dev: String(successorStat.dev),
					ino: String(successorStat.ino),
				};
			}
		};

		// Use the after hook to detect if restore happened
		FileLockTestHooks.afterEmptyLockDirRename = async (_tombstonePath: string) => {
			if (successorCreated && !restoreAttempted) {
				restoreAttempted = true;
				// After the rename, check if the tombstone was restored
				// The restore should have moved it back from tombstone to lockDir
				const lockDirExists = await fs.stat(lockDir).catch(() => null);
				if (lockDirExists) {
					// Verify it has the successor's identity
					if (successorIdentity) {
						expect(String(lockDirExists.dev)).toBe(successorIdentity.dev);
						expect(String(lockDirExists.ino)).toBe(successorIdentity.ino);
					}
				}
			}
		};

		try {
			// Get the removeEmptyFileLockDir function from test hooks
			const removeEmptyFileLockDir = FileLockTestHooks.removeEmptyFileLockDir;
			if (!removeEmptyFileLockDir) {
				throw new Error("removeEmptyFileLockDir not available in test hooks");
			}

			// Call the function with the ORIGINAL identity
			// After the race, the directory at lockDir will have a different identity (successor)
			// The remove function should:
			// 1. Detect the identity mismatch after rename
			// 2. Restore the tombstone back to lockDir
			// 3. Return "owner_changed"
			const result = await removeEmptyFileLockDir(lockDir, expectedIdentity);

			// The result should be owner_changed because identity mismatch was detected
			expect(result).toBe("owner_changed");
			expect(successorCreated).toBe(true);

			// Verify the lock directory still exists at the original path
			const lockDirStat = await fs.stat(lockDir).catch(() => null);
			expect(lockDirStat).not.toBeNull();
			expect(lockDirStat?.isDirectory()).toBe(true);

			// Verify the identity is now the successor's identity (because the successor was restored)
			if (successorIdentity) {
				const currentStat = await fs.stat(lockDir, { bigint: true });
				const id = successorIdentity as { dev: string; ino: string };
				expect(String(currentStat.dev)).toBe(id.dev);
				expect(String(currentStat.ino)).toBe(id.ino);
			}

			// Verify the info file still exists
			const infoStat = await fs.stat(path.join(lockDir, "info")).catch(() => null);
			expect(infoStat).not.toBeNull();

			// Verify no stale `.removing-*` tombstones are left behind
			// This ensures the race-condition fix actually restored the lock directory
			const parentDir = path.dirname(lockDir);
			const entries = await fs.readdir(parentDir);
			const tombstones = entries.filter(e => e.match(/\.removing-/));
			expect(tombstones).toEqual([]);
		} finally {
			FileLockTestHooks.beforeEmptyLockDirRename = undefined;
			FileLockTestHooks.afterEmptyLockDirRename = undefined;
		}
	});
});
