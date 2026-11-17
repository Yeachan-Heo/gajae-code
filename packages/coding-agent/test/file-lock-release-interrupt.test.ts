import { afterEach, beforeEach, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock, FileLockTestHooks } from "@gajae-code/coding-agent/config/file-lock";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";

const tempDirs: { path: string; forget: () => void }[] = [];
const origEnv = process.env.GJC_CODING_AGENT_DIR;

beforeEach(() => {
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => fs.rm(stagingPath, { recursive: true, force: true });
});

afterEach(async () => {
	FileLockTestHooks.cleanupPendingStaging = undefined;
	FileLockTestHooks.afterLockDirectoryRetired = undefined;
	if (origEnv) process.env.GJC_CODING_AGENT_DIR = origEnv;
	else delete process.env.GJC_CODING_AGENT_DIR;

	for (const { path: dir, forget } of tempDirs.splice(0)) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} finally {
			forget();
		}
	}
});

async function createTempDir(): Promise<string> {
	const canonicalTempRoot = await fs.realpath(os.tmpdir());
	const dir = path.join(canonicalTempRoot, `file-lock-release-interrupt-${crypto.randomUUID()}`);
	const forgetRoots: (() => void)[] = [];
	const forget = () => {
		for (const forgetRoot of forgetRoots) forgetRoot();
	};
	try {
		forgetRoots.push(registerOwnedDeletionRoot(dir));
		await fs.mkdir(dir, { mode: 0o700 });
	} catch (error) {
		forget();
		throw error;
	}
	tempDirs.push({ path: dir, forget });
	return dir;
}

test("acquisition resumes cleanup after release retires the published lock", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "file.dat");
	const lockPath = `${filePath}.lock`;
	const release = await acquireFileLock(filePath, { retries: 1 });
	let interrupted = false;
	FileLockTestHooks.afterLockDirectoryRetired = async (retiredPath, transitionPath) => {
		expect(retiredPath).toBe(lockPath);
		expect(transitionPath).toBe(`${lockPath}.removing`);
		interrupted = true;
		await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.lstat(transitionPath).then(stat => stat.isDirectory())).resolves.toBe(true);
		throw new Error("simulated release interruption after retirement");
	};

	let releaseError: unknown;
	try {
		await release();
	} catch (error) {
		releaseError = error;
	}
	expect(interrupted).toBe(true);
	expect(String(releaseError)).toContain("Failed to release file lock");
	FileLockTestHooks.afterLockDirectoryRetired = undefined;

	const nextRelease = await acquireFileLock(filePath, { retries: 1, retryDelayMs: 10 });
	expect(await fs.readFile(path.join(lockPath, "info"), "utf8")).toContain(`"pid":${process.pid}`);
	await nextRelease();
});
