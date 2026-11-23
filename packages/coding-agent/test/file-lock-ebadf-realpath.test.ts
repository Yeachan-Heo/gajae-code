import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-test-"));
	const tempDir = { path: dir, forget: () => fs.rm(dir, { recursive: true, force: true }) };
	tempDirs.push(tempDir);
	return dir;
}

describe("file-lock: Windows EBADF on realpath during concurrent release", () => {
	test("handles EBADF from realpath on Windows when lock file is vanishing", async () => {
		// On Windows, when another process is releasing the lock file, realpath can
		// raise EBADF instead of ENOENT. This should be treated the same way as ENOENT
		// and should fall back to the parent-based key derivation.
		// The lock path is derived as ${filePath}.lock, so we mock realpath to throw
		// EBADF on that lock path specifically.

		const lockDir = await createTempDir();
		const filePath = path.join(lockDir, "test-config");
		const lockPath = `${filePath}.lock`; // This is what acquireFileLock actually calls realpath on

		// Set platform to Windows
		setPlatform("win32");

		// Mock realpath to throw EBADF on the lock path
		const originalRealpath = fs.realpath;
		let callCount = 0;

		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			const targetStr = String(target);
			callCount++;

			// Throw EBADF on the lock file path on first call
			if (targetStr === lockPath && callCount === 1) {
				const error = Object.assign(new Error("Bad file descriptor"), {
					code: "EBADF",
					errno: -9,
					syscall: "realpath",
				});
				throw error;
			}

			// Fallback calls (e.g., on parent path) should work normally
			return originalRealpath(target);
		}) as typeof fs.realpath);

		// Lock should be acquired successfully despite EBADF on the initial path
		const release = await acquireFileLock(filePath, {
			staleMs: 1000,
			retries: 1,
			retryDelayMs: 10,
		});

		// Verify the lock was acquired by releasing it
		await release();

		// Verify the mock was called and triggered the fallback path
		expect(callCount).toBeGreaterThanOrEqual(1);
	});

	test("propagates EBADF on non-Windows platforms instead of falling back", async () => {
		// EBADF should only be treated as vanishing on Windows.
		// On other platforms (Linux, macOS), EBADF should still be treated as a fatal error.

		const lockDir = await createTempDir();
		const filePath = path.join(lockDir, "test-config");
		const lockPath = `${filePath}.lock`;

		// Explicitly set platform to Linux (non-Windows)
		setPlatform("linux");

		const originalRealpath = fs.realpath;

		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			const targetStr = String(target);

			// Throw EBADF on the lock file path
			if (targetStr === lockPath) {
				const error = Object.assign(new Error("Bad file descriptor"), {
					code: "EBADF",
					errno: -9,
					syscall: "realpath",
				});
				throw error;
			}

			return originalRealpath(target);
		}) as typeof fs.realpath);

		// On Linux, EBADF should propagate and cause acquisition to fail
		let error: unknown;
		try {
			await acquireFileLock(filePath, {
				staleMs: 1000,
				retries: 1,
				retryDelayMs: 10,
			});
		} catch (e) {
			error = e;
		}

		// Error should exist and contain EBADF info
		expect(error).toBeDefined();
		// The error code should be in the error object even if toString doesn't include it
		expect((error as NodeJS.ErrnoException)?.code).toBe("EBADF");
	});

	test("falls back to parent-resolved path when lock file realpath fails with EBADF on Windows", async () => {
		// When the lock file's realpath fails with EBADF on Windows, but parent path
		// realpath succeeds, the fallback should use the parent's canonical path.

		const lockDir = await createTempDir();
		const filePath = path.join(lockDir, "test-config");
		const lockPath = `${filePath}.lock`;

		// Set platform to Windows
		setPlatform("win32");

		const originalRealpath = fs.realpath;
		const mockCallLog: string[] = [];

		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			const targetStr = String(target);
			mockCallLog.push(targetStr);

			// Throw EBADF on lock file
			if (targetStr === lockPath) {
				const error = Object.assign(new Error("Bad file descriptor"), {
					code: "EBADF",
					errno: -9,
					syscall: "realpath",
				});
				throw error;
			}

			// Parent path should resolve successfully
			return originalRealpath(target);
		}) as typeof fs.realpath);

		// Should succeed by falling back to parent-based derivation
		const release = await acquireFileLock(filePath, {
			staleMs: 1000,
			retries: 1,
			retryDelayMs: 10,
		});

		await release();

		// Verify that the lock path was attempted (should trigger EBADF path)
		expect(mockCallLog.some(call => call === lockPath)).toBe(true);
		// Verify that parent realpath was called as a fallback
		expect(mockCallLog.some(call => call === lockDir)).toBe(true);
	});
});
