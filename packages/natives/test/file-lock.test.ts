import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileLockAcquireStatus,
	FileLockFailure,
	FileLockProbeState,
	probeFileLock,
	tryAcquireFileLock,
} from "../native/index.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-file-lock-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("native file lock on an unsupported platform", () => {
	it("reports unavailable instead of locking", async () => {
		const lockPath = path.join(await tempDir(), "s.session-owner");
		const acquired = await tryAcquireFileLock(lockPath);
		expect(acquired.status).toBe(FileLockAcquireStatus.Unavailable);
		expect(acquired.code).toBe("unsupported_platform");
		const probed = await probeFileLock(lockPath);
		expect(probed.state).toBe(FileLockProbeState.Unknown);
		expect(probed.reason).toBe(FileLockFailure.Unavailable);
	});
});
