import { afterEach, beforeEach, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockTestHooks, withFileLock } from "@gajae-code/coding-agent/config/file-lock";
import {
	exactRemoveDirectoryTree,
	renameDirectoryNoReplacePathAsync,
	renameNoReplacePathAsync,
	snapshotDirectoryTree,
} from "@gajae-code/natives";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";

const tempDirs: { path: string; forget: () => void }[] = [];
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
	originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process.platform descriptor is not configurable");
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => fs.rm(stagingPath, { recursive: true, force: true });
});

afterEach(async () => {
	FileLockTestHooks.cleanupPendingStaging = undefined;
	FileLockTestHooks.beforeDetachedLockCleanup = undefined;
	FileLockTestHooks.beforeRemovalRecordUnlink = undefined;
	FileLockTestHooks.beforeRemovalOwnerPublish = undefined;
	FileLockTestHooks.nativePublicationBindings = undefined;
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	FileLockTestHooks.nativeExactRemovalProbe = undefined;
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
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
	const dir = path.join(canonicalTempRoot, `file-lock-empty-dir-${crypto.randomUUID()}`);
	const forgetRoots: (() => void)[] = [];
	const forget = () => {
		for (const forgetRoot of forgetRoots) forgetRoot();
	};
	try {
		forgetRoots.push(registerOwnedDeletionRoot(dir));
		// Native Windows cleanup may use an extended-length spelling while
		// realpath(os.tmpdir()) is unprefixed; authorize only this fixture in both.
		const namespacedDir = path.toNamespacedPath(dir);
		if (namespacedDir !== dir) forgetRoots.push(registerOwnedDeletionRoot(namespacedDir));
		await fs.mkdir(dir, { mode: 0o700 });
	} catch (error) {
		forget();
		throw error;
	}
	tempDirs.push({ path: dir, forget });
	return dir;
}

async function writeRemovalOwnerRecord(
	transitionPath: string,
	owner: { pid: number; timestamp: number; owner_token: string },
): Promise<void> {
	const captured = snapshotDirectoryTree(transitionPath);
	if (!captured.ok || !captured.snapshot) throw new Error("Could not snapshot the test retirement");
	await fs.writeFile(
		`${transitionPath}.owner`,
		JSON.stringify({ owner, rootDev: captured.snapshot.rootDev, rootIno: captured.snapshot.rootIno }),
	);
}

test("fails closed on an aged empty ownerless Windows lock directory", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "index.jsonl");
	const lockDir = `${filePath}.lock`;
	await fs.mkdir(lockDir);
	const pastTime = new Date(Date.now() - 60_000);
	await fs.utimes(lockDir, pastTime, pastTime);
	const originalIdentity = await fs.stat(lockDir, { bigint: true });

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
	const remainingIdentity = await fs.stat(lockDir, { bigint: true });
	expect(remainingIdentity.dev).toBe(originalIdentity.dev);
	expect(remainingIdentity.ino).toBe(originalIdentity.ino);
});

test("does not reclaim an aged ownerless lock directory that contains entries", async () => {
	const tempDir = await createTempDir();
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

test("does not steal an aged empty session-index lock while a legacy writer is paused", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	await fs.mkdir(lockDir, { recursive: true });
	const pastTime = new Date(Date.now() - 60_000);
	await fs.utimes(lockDir, pastTime, pastTime);
	const originalIdentity = await fs.stat(lockDir, { bigint: true });
	const infoPath = path.join(lockDir, "info");
	const ownerBytes = JSON.stringify({ pid: process.pid, timestamp: pastTime.getTime() });
	let resumeLegacyWriter!: () => void;
	const writerMayPublish = new Promise<void>(resolve => {
		resumeLegacyWriter = resolve;
	});
	const legacyWrite = (async () => {
		await writerMayPublish;
		await fs.writeFile(infoPath, ownerBytes);
	})().then(
		() => null,
		(error: unknown) => error,
	);

	let callbackEntered = false;
	try {
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
		const identityWhileLegacyWriterIsPaused = await fs.stat(lockDir, { bigint: true });
		expect(identityWhileLegacyWriterIsPaused.dev).toBe(originalIdentity.dev);
		expect(identityWhileLegacyWriterIsPaused.ino).toBe(originalIdentity.ino);
	} finally {
		resumeLegacyWriter();
	}
	expect(await legacyWrite).toBeNull();

	expect(callbackEntered).toBe(false);
	expect(await fs.readFile(infoPath, "utf8")).toBe(ownerBytes);
	const identityAfterLegacyWrite = await fs.stat(lockDir, { bigint: true });
	expect(identityAfterLegacyWrite.dev).toBe(originalIdentity.dev);
	expect(identityAfterLegacyWrite.ino).toBe(originalIdentity.ino);
	await fs.utimes(lockDir, pastTime, pastTime);

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
	expect(await fs.readFile(infoPath, "utf8")).toBe(ownerBytes);
	const finalIdentity = await fs.stat(lockDir, { bigint: true });
	expect(finalIdentity.dev).toBe(originalIdentity.dev);
	expect(finalIdentity.ino).toBe(originalIdentity.ino);
});

test("publishes a Windows retirement owner record before native detach", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	let ownerRecordPublishedBeforeDetach = false;
	FileLockTestHooks.nativeExactRemovalProbe = () => true;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: (target, snapshot, parentIdentity, detachOnly) => {
			if (target === lockDir && detachOnly) {
				ownerRecordPublishedBeforeDetach = fsSync.existsSync(`${lockDir}.removing.owner`);
				fsSync.renameSync(target, transitionPath);
				return { ok: true, detachedPath: transitionPath };
			}
			if (target === transitionPath) {
				fsSync.rmSync(target, { recursive: true, force: true });
				return { ok: true };
			}
			return exactRemoveDirectoryTree(target, snapshot, parentIdentity, detachOnly);
		},
	});

	const acquisitionError = await withFileLock(filePath, async () => undefined, {
		retries: 2,
		retryDelayMs: 1,
		staleMs: 0,
	}).then(
		() => null,
		error => error,
	);

	expect(acquisitionError).toBeNull();
	expect(ownerRecordPublishedBeforeDetach).toBe(true);
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${lockDir}.removing.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("does not reclaim a fresh ownerless lock directory", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	await fs.mkdir(lockDir, { recursive: true });

	await expect(
		withFileLock(filePath, async () => undefined, { retries: 2, retryDelayMs: 1, staleMs: 0 }),
	).rejects.toMatchObject({ code: "acquire_timeout" });
	expect(await fs.readdir(lockDir)).toEqual([]);
});

test("adopts a detached Windows retirement before publishing a successor", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	await fs.mkdir(transitionPath, { recursive: true });
	await fs.writeFile(path.join(transitionPath, "info.retired"), "partially scrubbed owner data");
	await writeRemovalOwnerRecord(transitionPath, {
		pid: 4_194_303,
		timestamp: Date.now(),
		owner_token: "dead-remover-generation",
	});

	let callbackEntered = false;
	const acquisitionError = await withFileLock(
		filePath,
		async () => {
			callbackEntered = true;
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		},
		{ retries: 2, retryDelayMs: 1, staleMs: 0 },
	).then(
		() => null,
		error => error,
	);

	expect(acquisitionError).toBeNull();
	expect(callbackEntered).toBe(true);
	await expect(fs.lstat(transitionPath)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${transitionPath}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("does not publish while a live Windows retirement remains", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	await fs.mkdir(transitionPath, { recursive: true });
	await fs.writeFile(path.join(transitionPath, "info.retired"), "live owner data");
	await writeRemovalOwnerRecord(transitionPath, {
		pid: process.pid,
		timestamp: Date.now(),
		owner_token: "live-remover-generation",
	});

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
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readFile(path.join(transitionPath, "info.retired"), "utf8")).toBe("live owner data");
	await fs.lstat(`${transitionPath}.owner`);
});

test("clears a completed Windows retirement record before a successor", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	await fs.mkdir(transitionPath, { recursive: true });
	await fs.writeFile(path.join(transitionPath, "info.retired"), "already removed");
	await writeRemovalOwnerRecord(transitionPath, {
		pid: 4_194_303,
		timestamp: Date.now(),
		owner_token: "completed-remover-generation",
	});
	await fs.rm(transitionPath, { recursive: true });

	let callbackEntered = false;
	const acquisitionError = await withFileLock(
		filePath,
		async () => {
			callbackEntered = true;
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		},
		{ retries: 2, retryDelayMs: 1, staleMs: 0 },
	).then(
		() => null,
		error => error,
	);

	expect(acquisitionError).toBeNull();
	expect(callbackEntered).toBe(true);
	await expect(fs.lstat(`${transitionPath}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("retries a completed local retirement record before same-process reacquisition", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	let refuseUnlink = true;
	FileLockTestHooks.nativeExactRemovalProbe = () => true;
	FileLockTestHooks.beforeRemovalRecordUnlink = () => {
		if (!refuseUnlink) return true;
		refuseUnlink = false;
		return false;
	};
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: (target, snapshot, parentIdentity, detachOnly) => {
			if (target === lockDir && detachOnly) {
				fsSync.renameSync(target, transitionPath);
				return { ok: true, detachedPath: transitionPath };
			}
			if (target === transitionPath) {
				fsSync.rmSync(target, { recursive: true, force: true });
				return { ok: true };
			}
			return exactRemoveDirectoryTree(target, snapshot, parentIdentity, detachOnly);
		},
	});

	await withFileLock(filePath, async () => undefined, {
		retries: 2,
		retryDelayMs: 1,
		staleMs: 0,
		ownerHostId: "previous-local-host",
	});
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	await fs.lstat(`${lockDir}.removing.owner`);

	let successorEntered = false;
	await withFileLock(
		filePath,
		async () => {
			successorEntered = true;
		},
		{ retries: 2, retryDelayMs: 1, staleMs: 0 },
	);

	expect(successorEntered).toBe(true);
	await expect(fs.lstat(`${lockDir}.removing.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("resumes an ownerless detached cleanup after a transient cleanup refusal", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	await fs.mkdir(transitionPath, { recursive: true });
	const pastTime = new Date(Date.now() - 60_000);
	await fs.utimes(transitionPath, pastTime, pastTime);
	let refuseCleanup = true;
	let transitionRemovalAttempts = 0;
	FileLockTestHooks.nativeExactRemovalProbe = () => true;
	FileLockTestHooks.beforeDetachedLockCleanup = () => {
		if (!refuseCleanup) return true;
		refuseCleanup = false;
		throw Object.assign(new Error("simulated sharing violation"), { code: "EPERM" });
	};
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree: (target, snapshot, parentIdentity, detachOnly) => {
			if (target === transitionPath) {
				transitionRemovalAttempts++;
				if (transitionRemovalAttempts === 1) {
					return {
						ok: false,
						code: "cleanup_pending",
						payloadDurable: true,
						detachedPath: transitionPath,
					};
				}
				fsSync.rmSync(target, { recursive: true, force: true });
				return { ok: true };
			}
			return exactRemoveDirectoryTree(target, snapshot, parentIdentity, detachOnly);
		},
	});

	let callbackEntered = false;
	await withFileLock(
		filePath,
		async () => {
			// Count adoption before successor release can replay its own retirement.
			expect(transitionRemovalAttempts).toBe(2);
			callbackEntered = true;
		},
		{ retries: 4, retryDelayMs: 1, staleMs: 0 },
	);

	expect(refuseCleanup).toBe(false);
	expect(callbackEntered).toBe(true);
	await expect(fs.lstat(transitionPath)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${transitionPath}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
	"cleanup_pending",
	"sharing_violation",
	"thrown_sharing_violation",
	"thrown_replay",
] as const)("retries stale-owner Windows detached cleanup after transient %s on a later same-process acquisition", async transientRefusal => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	await fs.mkdir(lockDir, { recursive: true });
	await fs.writeFile(
		path.join(lockDir, "info"),
		JSON.stringify({ pid: 4_194_303, timestamp: Date.now(), owner_token: crypto.randomUUID() }),
	);

	const attemptsBeforeCallback = transientRefusal === "thrown_replay" ? 2 : 3;
	let transitionRemovalAttempts = 0;
	FileLockTestHooks.nativeExactRemovalProbe = () => true;
	FileLockTestHooks.nativeQuarantineBindings = () => ({
		snapshotDirectoryTree,
		exactRemoveDirectoryTree(target, snapshot, parentIdentity, detachOnly) {
			if (target === lockDir && detachOnly) {
				fsSync.renameSync(target, transitionPath);
				return { ok: true, detachedPath: transitionPath };
			}
			if (target === transitionPath) {
				transitionRemovalAttempts++;
				if (transitionRemovalAttempts === 1 && transientRefusal === "thrown_replay") {
					throw Object.assign(new Error("simulated Windows replay denial"), { code: "EPERM" });
				}
				if (transitionRemovalAttempts === 2 && transientRefusal === "sharing_violation") {
					return { ok: false, code: "sharing_violation", detachedPath: transitionPath };
				}
				if (transitionRemovalAttempts === 2 && transientRefusal === "thrown_sharing_violation") {
					throw Object.assign(new Error("simulated Windows sharing denial"), { code: "EPERM" });
				}
				if (transitionRemovalAttempts <= 2) {
					return {
						ok: false,
						code: "cleanup_pending",
						payloadDurable: true,
						detachedPath: transitionPath,
					};
				}
				fsSync.rmSync(target, { recursive: true, force: true });
				return { ok: true };
			}
			return exactRemoveDirectoryTree(target, snapshot, parentIdentity, detachOnly);
		},
	});

	let firstCallbackEntered = false;
	await expect(
		withFileLock(
			filePath,
			async () => {
				firstCallbackEntered = true;
			},
			{ retries: 1, retryDelayMs: 1, staleMs: 0 },
		),
	).rejects.toMatchObject({ code: "orphan_transition" });
	expect(firstCallbackEntered).toBe(false);
	expect(transitionRemovalAttempts).toBe(transientRefusal === "thrown_replay" ? 1 : 2);
	await fs.lstat(transitionPath);
	await fs.lstat(`${transitionPath}.owner`);

	let recoveredCallbackEntered = false;
	await withFileLock(
		filePath,
		async () => {
			expect(transitionRemovalAttempts).toBe(attemptsBeforeCallback);
			recoveredCallbackEntered = true;
		},
		{ retries: 2, retryDelayMs: 1, staleMs: 0 },
	);

	expect(recoveredCallbackEntered).toBe(true);
	expect(transitionRemovalAttempts).toBe(attemptsBeforeCallback + 1);
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(transitionPath)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${transitionPath}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rolls back a Windows publication when retirement appears before owner registration", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	let transitionPublished = false;
	FileLockTestHooks.nativePublicationBindings = () => ({
		renameNoReplacePathAsync: async (source, destination) => {
			const result = await renameNoReplacePathAsync(source, destination);
			if (result.ok && !transitionPublished) {
				transitionPublished = true;
				await fs.mkdir(transitionPath);
			}
			return result;
		},
		renameDirectoryNoReplacePathAsync,
	});

	await expect(
		withFileLock(filePath, async () => undefined, { retries: 1, retryDelayMs: 1, staleMs: 0 }),
	).rejects.toMatchObject({ code: "orphan_transition" });

	expect(transitionPublished).toBe(true);
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(path.dirname(lockDir))).toEqual([path.basename(transitionPath)]);
});

test("fails closed on an oversized Windows retirement owner sidecar", async () => {
	const tempDir = await createTempDir();
	const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
	const recordPath = `${filePath}.lock.removing.owner`;
	await fs.mkdir(path.dirname(recordPath), { recursive: true });
	await fs.writeFile(recordPath, "");
	await fs.truncate(recordPath, 2 * 1024 * 1024);

	await expect(
		withFileLock(filePath, async () => undefined, { retries: 1, retryDelayMs: 1, staleMs: 0 }),
	).rejects.toMatchObject({ code: "acquire_timeout" });
	expect((await fs.stat(recordPath)).size).toBe(2 * 1024 * 1024);
});

test.skipIf(process.platform === "win32")(
	"fails closed on an aged empty ownerless lock directory on POSIX",
	async () => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "sdk", "sessions", "index.jsonl");
		const lockDir = `${filePath}.lock`;
		await fs.mkdir(lockDir, { recursive: true });
		const pastTime = new Date(Date.now() - 60_000);
		await fs.utimes(lockDir, pastTime, pastTime);

		await expect(
			withFileLock(filePath, async () => undefined, { retries: 2, retryDelayMs: 1, staleMs: 0 }),
		).rejects.toMatchObject({ code: "acquire_timeout" });
		expect(await fs.readdir(lockDir)).toEqual([]);
	},
);
