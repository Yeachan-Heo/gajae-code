import { afterEach, beforeEach, expect, test } from "bun:test";
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
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => fs.rm(stagingPath, { recursive: true, force: true });
});

afterEach(async () => {
	FileLockTestHooks.cleanupPendingStaging = undefined;
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

test("preserves an aged empty ownerless lock directory and reports manual cleanup", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-empty-dir-"));
	tempDirs.push(tempDir);
	const filePath = path.join(tempDir, "index.jsonl");
	const lockDir = `${filePath}.lock`;
	await fs.mkdir(lockDir);
	const pastTime = new Date(Date.now() - 60_000);
	await fs.utimes(lockDir, pastTime, pastTime);

	const failure = await withFileLock(filePath, async () => "entered", {
		retries: 2,
		retryDelayMs: 1,
		staleMs: 0,
	}).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(FileLockAcquireError);
	expect((failure as Error).message).toContain(`Remove-Item -LiteralPath '${lockDir}' -Recurse -Force`);
	expect(await fs.readdir(lockDir)).toEqual([]);
});

test("does not reclaim an aged ownerless lock directory that contains entries", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-empty-dir-"));
	tempDirs.push(tempDir);
	const filePath = path.join(tempDir, "index.jsonl");
	const lockDir = `${filePath}.lock`;
	await fs.mkdir(lockDir);
	await Bun.write(path.join(lockDir, "unexpected"), "preserve");
	const pastTime = new Date(Date.now() - 60_000);
	await fs.utimes(lockDir, pastTime, pastTime);

	await expect(
		withFileLock(filePath, async () => "entered", { retries: 2, retryDelayMs: 1, staleMs: 0 }),
	).rejects.toMatchObject({ code: "acquire_timeout" });
	expect(await Bun.file(path.join(lockDir, "unexpected")).text()).toBe("preserve");
});
