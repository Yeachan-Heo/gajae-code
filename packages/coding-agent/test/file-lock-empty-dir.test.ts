import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "@gajae-code/coding-agent/config/file-lock";

const tempDirs: string[] = [];
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
	originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process.platform descriptor is not configurable");
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
});

afterEach(async () => {
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

test("does not reclaim an aged ownerless lock directory without generation proof", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-empty-dir-"));
	tempDirs.push(tempDir);
	const filePath = path.join(tempDir, "index.jsonl");
	const lockDir = `${filePath}.lock`;
	await fs.mkdir(lockDir);
	const pastTime = new Date(Date.now() - 60_000);
	await fs.utimes(lockDir, pastTime, pastTime);

	let callbackEntered = false;
	await expect(
		withFileLock(
			filePath,
			async () => {
				callbackEntered = true;
			},
			{ retries: 2, retryDelayMs: 1, staleMs: 0 },
		),
	).rejects.toMatchObject({ code: "acquire_timeout" });

	expect(callbackEntered).toBe(false);
	expect(await fs.readdir(lockDir)).toEqual([]);
});
