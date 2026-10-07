import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireError, FileLockTestHooks, withFileLock } from "@gajae-code/coding-agent/config/file-lock";

const tempDirs: string[] = [];
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
	originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process.platform descriptor is not configurable");
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
});

afterEach(async () => {
	FileLockTestHooks.beforeEmptyLockDirClaim = undefined;
	vi.restoreAllMocks();
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);

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
				// 1. Move the stale directory aside so its inode cannot be reused
				// 2. Create a fresh empty directory (ABA race)
				try {
					await fs.rename(checkDir, `${checkDir}.displaced`);
					await fs.mkdir(checkDir);
				} catch {
					// Ignore if directory disappears between rmdir and mkdir
				}
			}
		};

		// The hook replaces the directory after stale identity capture. The claim
		// must reject the replacement and must not run the protected callback.
		let callbackEntered = false;
		await expect(
			withFileLock(
				filePath,
				async () => {
					callbackEntered = true;
				},
				{
					retries: 5,
					retryDelayMs: 10,
					staleMs: 10_000,
				},
			),
		).rejects.toMatchObject({ code: "acquire_timeout" });

		expect(hookCalled).toBe(true);
		expect(callbackEntered).toBe(false);
		expect(await fs.readdir(lockDir)).toEqual([]);
	});

	test("does not claim a directory that gains an unrelated entry before claim", async () => {
		const filePath = path.join(await makeTemp(), "index.jsonl");
		const lockDir = `${filePath}.lock`;
		const childPath = path.join(lockDir, "unrelated");
		await fs.mkdir(lockDir);
		const pastTime = new Date(Date.now() - 15_000);
		await fs.utimes(lockDir, pastTime, pastTime);
		FileLockTestHooks.beforeEmptyLockDirClaim = async () => {
			await fs.writeFile(childPath, "preserve");
		};

		let callbackEntered = false;
		await expect(
			withFileLock(
				filePath,
				async () => {
					callbackEntered = true;
				},
				{ retries: 2, retryDelayMs: 1, staleMs: 10_000 },
			),
		).rejects.toMatchObject({ code: "acquire_timeout" });

		expect(callbackEntered).toBe(false);
		expect(await fs.readFile(childPath, "utf8")).toBe("preserve");
		expect(await fs.readdir(lockDir)).toEqual(["unrelated"]);
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
		let ran = false;
		await withFileLock(
			filePath,
			async () => {
				ran = true;
			},
			{
				retries: 5,
				retryDelayMs: 1,
				staleMs: 10_000,
				signal: controller.signal,
				onAcquired: () => controller.abort(),
			},
		);
		expect(ran).toBe(true);
		await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
