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
	const dir = path.join(canonicalTempRoot, `file-lock-gc-prefix-${crypto.randomUUID()}`);
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

async function setMtimeToAge(filePath: string, ageMs: number): Promise<void> {
	const now = Date.now();
	const pastTime = now - ageMs;
	await fs.utimes(filePath, pastTime / 1000, pastTime / 1000);
}

test("acquiring a lock leaves unrelated quarantine directories untouched", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "index.jsonl");
	const lockDir = path.dirname(filePath);

	await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });

	const lockBasename = path.basename(`${filePath}.lock`);
	const quarantinePath = path.join(
		lockDir,
		`${lockBasename}.quarantine-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`,
	);
	await fs.mkdir(quarantinePath, { mode: 0o700 });

	await setMtimeToAge(quarantinePath, 86_400_000 + 10_000);

	const release = await acquireFileLock(filePath, { retries: 1 });

	const quarantineStillExists = await fs
		.lstat(quarantinePath)
		.then(() => true)
		.catch(() => false);
	expect(quarantineStillExists).toBe(true);

	await release();
});

test("GC retains an old foreign-host removal owner record", async () => {
	const tempRoot = await createTempDir();
	const filePath = path.join(tempRoot, "index.jsonl");
	const lockDir = path.dirname(`${filePath}.lock`);

	await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });

	const release = await acquireFileLock(filePath, { retries: 1 });
	await release();

	const lockBasename = path.basename(`${filePath}.lock`);
	const removalOwnerPath = path.join(lockDir, `${lockBasename}.removing.owner.${crypto.randomUUID()}`);
	await fs.writeFile(
		removalOwnerPath,
		JSON.stringify({
			owner: {
				pid: 9999,
				owner_host_id: "foreign-host",
				owner_token: crypto.randomUUID(),
				timestamp: Date.now(),
			},
			rootDev: "1",
			rootIno: "2",
		}),
		{ mode: 0o600 },
	);

	await setMtimeToAge(removalOwnerPath, 86_400_000 + 10_000);

	const releaseAgain = await acquireFileLock(filePath, { retries: 1 });

	await expect(fs.lstat(removalOwnerPath)).resolves.toBeTruthy();

	await releaseAgain();
});
