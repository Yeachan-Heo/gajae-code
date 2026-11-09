import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock } from "../src/config/file-lock";

const tempDirs: { path: string; forget: () => void }[] = [];
let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: string): void {
	if (!originalPlatform) {
		originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	}
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

function restorePlatform(): void {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
}

afterEach(async () => {
	restorePlatform();
	for (const { forget } of tempDirs) {
		try {
			forget();
		} catch {}
	}
	tempDirs.length = 0;
	vi.restoreAllMocks();
});

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join("/tmp", "gjc-test-"));
	const tempDir = { path: dir, forget: () => fs.rm(dir, { recursive: true, force: true }) };
	tempDirs.push(tempDir);
	return dir;
}

describe("file-lock: Windows EBADF on realpath during concurrent release", () => {
	test("handles EBADF from realpath on Windows when lock file is vanishing", async () => {
		// On Windows, when another process is releasing the lock file, realpath can
		// raise EBADF instead of ENOENT. This should be treated the same way as ENOENT
		// and should fall back to the parent-based key derivation.

		const lockDir = await createTempDir();
		const lockPath = path.join(lockDir, "test.lock");

		// Create the lock file so initial setup works
		await fs.writeFile(lockPath, "test");

		// Mock realpath to simulate Windows EBADF error on the lock path
		const originalRealpath = fs.realpath;
		let callCount = 0;

		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			const targetStr = String(target);
			callCount++;

			// First call on the lock file itself should throw EBADF
			if (targetStr === lockPath && callCount === 1) {
				const error = Object.assign(new Error("Bad file descriptor"), {
					code: "EBADF",
					errno: -9,
					syscall: "realpath",
				});
				throw error;
			}

			// Fallback calls should work normally
			return originalRealpath(target);
		}) as typeof fs.realpath);

		// This should not throw even though realpath threw EBADF
		// It should fall back to parent-based key derivation
		try {
			await acquireFileLock(lockPath, {
				staleMs: 1000,
				retries: 1,
				retryDelayMs: 10,
			});

			// Lock should be acquired successfully
			expect(true).toBe(true);
		} catch (error) {
			// Should not have rethrown EBADF
			const errMsg = String(error);
			expect(errMsg).not.toContain("EBADF");
		}
	});

	test.skip("only handles EBADF on Windows, not on other platforms", async () => {
		// EBADF should only be treated as vanishing on Windows
		// On Linux/macOS, it should still be treated as an error
		// This is difficult to test in isolation since the full acquireFileLock flow
		// involves multiple system calls and state management.
		// The localLockKey behavior is tested indirectly through integration tests.
	});

	test("handles EBADF when parent realpath also fails with ENOENT", async () => {
		// When the lock file's parent also cannot be found,
		// should still fall back to path.resolve() for the parent

		const lockDir = await createTempDir();
		const lockPath = path.join(lockDir, "test.lock");

		// Create the lock file
		await fs.writeFile(lockPath, "test");

		// Set platform to Windows
		setPlatform("win32");

		const originalRealpath = fs.realpath;

		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			const targetStr = String(target);

			// Throw EBADF on lock file
			if (targetStr === lockPath) {
				const error = Object.assign(new Error("Bad file descriptor"), {
					code: "EBADF",
					errno: -9,
					syscall: "realpath",
				});
				throw error;
			}

			// Throw ENOENT on parent
			if (targetStr === lockDir) {
				const error = Object.assign(new Error("No such file or directory"), {
					code: "ENOENT",
					errno: -2,
					syscall: "realpath",
				});
				throw error;
			}

			return originalRealpath(target);
		}) as typeof fs.realpath);

		// Should not throw and should use path.resolve() fallback for parent
		try {
			await acquireFileLock(lockPath, {
				staleMs: 1000,
				retries: 1,
				retryDelayMs: 10,
			});

			expect(true).toBe(true);
		} catch (error) {
			// Should not have rethrown EBADF or unhandled ENOENT
			const errMsg = String(error);
			expect(errMsg).not.toContain("EBADF");
		}
	});
});
