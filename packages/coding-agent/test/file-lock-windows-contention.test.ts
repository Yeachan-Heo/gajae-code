import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireFileLock,
	FILE_LOCK_RELEASE_RETRY_ATTEMPTS,
	FILE_LOCK_ROLLBACK_RETRY_ATTEMPTS,
	FileLockAcquireError,
	FileLockTestHooks,
	withFileLock,
} from "@gajae-code/coding-agent/config/file-lock";
import { collectFileLocksForGc } from "@gajae-code/coding-agent/config/file-lock-gc";
import type { GcContext } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import {
	exactRemoveDirectoryTree,
	exactRestore,
	type NativeDirectoryTreeResult,
	type NativeDirectoryTreeSnapshot,
	type NativeExactUnlinkResult,
	renameDirectoryNoReplacePathAsync,
	renameNoReplacePathAsync,
	snapshotDirectoryTree,
} from "@gajae-code/natives";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";

// Regression coverage for Windows lock self-contention: NTFS refuses to rename a lock
// directory while any process holds a handle inside it (STATUS_ACCESS_DENIED), and a
// record being retired is refused to readers (EPERM on open, EBADF from Bun's lstat).
// Native refusals are injected through the lock's binding hooks so the Windows code
// paths run deterministically on every host.

const hostPlatform = process.platform;
const tempDirs: { path: string; forget: () => void }[] = [];
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
	originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!originalPlatform?.configurable) throw new Error("process.platform descriptor is not configurable");
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
	FileLockTestHooks.cleanupPendingStaging = async stagingPath => fs.rm(stagingPath, { recursive: true, force: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	FileLockTestHooks.cleanupPendingStaging = undefined;
	FileLockTestHooks.beforeRemovalOwnerPublish = undefined;
	FileLockTestHooks.nativePublicationBindings = undefined;
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	FileLockTestHooks.nativeExactRemovalProbe = undefined;
	FileLockTestHooks.nativeRestoreBinding = undefined;
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
	const dir = path.join(canonicalTempRoot, `file-lock-win-contention-${crypto.randomUUID()}`);
	const forgetRoots: (() => void)[] = [];
	const forget = () => {
		for (const forgetRoot of forgetRoots) forgetRoot();
	};
	try {
		forgetRoots.push(registerOwnedDeletionRoot(dir));
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

function samePath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const resolved = path.resolve(value.replace(/^\\\\\?\\/, ""));
		return hostPlatform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}

/**
 * Model the Windows two-phase release on any host: the detach renames the populated lock
 * to `<lock>.removing`, then the transition is removed. `detach` may refuse first.
 */
function detachingBindings(
	lockDir: string,
	options: {
		snapshot?: (target: string) => NativeDirectoryTreeResult;
		detach?: () => NativeExactUnlinkResult | undefined;
	} = {},
) {
	const transitionPath = `${lockDir}.removing`;
	return {
		snapshotDirectoryTree: options.snapshot ?? snapshotDirectoryTree,
		exactRemoveDirectoryTree(
			target: string,
			snapshot: NativeDirectoryTreeSnapshot,
			parentIdentity?: { dev: bigint; ino: bigint },
			detachOnly?: boolean,
		): NativeExactUnlinkResult {
			if (detachOnly && samePath(target, lockDir)) {
				const refused = options.detach?.();
				if (refused) return refused;
				fsSync.renameSync(target, `${target}.removing`);
				return { ok: true, detachedPath: `${target}.removing` };
			}
			if (samePath(target, transitionPath)) {
				fsSync.rmSync(target, { recursive: true, force: true });
				return { ok: true };
			}
			return exactRemoveDirectoryTree(target, snapshot, parentIdentity, detachOnly);
		},
	};
}

test("release retries a native access_denied lock snapshot and removes the lock", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const lockDir = `${filePath}.lock`;
	let deny = false;
	let denials = 0;
	FileLockTestHooks.nativeExactRemovalProbe = () => true;
	FileLockTestHooks.nativeQuarantineBindings = () =>
		detachingBindings(lockDir, {
			snapshot: target => {
				if (deny && denials < 2 && samePath(target, lockDir)) {
					denials++;
					return { ok: false, code: "access_denied" };
				}
				return snapshotDirectoryTree(target);
			},
		});

	const release = await acquireFileLock(filePath, { retries: 2, retryDelayMs: 1 });
	deny = true;
	await release();

	expect(denials).toBe(2);
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${lockDir}.removing`)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${lockDir}.removing.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("release exhaustion under persistent access_denied names access_denied, never owner_changed", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const lockDir = `${filePath}.lock`;
	let deny = false;
	let denials = 0;
	FileLockTestHooks.nativeExactRemovalProbe = () => true;
	FileLockTestHooks.nativeQuarantineBindings = () =>
		detachingBindings(lockDir, {
			snapshot: target => {
				if (deny && samePath(target, lockDir)) {
					denials++;
					return { ok: false, code: "access_denied" };
				}
				return snapshotDirectoryTree(target);
			},
		});

	const release = await acquireFileLock(filePath, { retries: 2, retryDelayMs: 1 });
	deny = true;
	const failure = await release().then(
		() => null,
		(error: unknown) => error,
	);

	expect(failure).toBeInstanceOf(Error);
	expect(failure).toMatchObject({ code: "access_denied" });
	expect((failure as Error).message).toContain("access_denied");
	expect((failure as Error).message).not.toContain("owner_changed");
	// Every bounded release attempt plus the final quarantine fallback observed the denial.
	expect(denials).toBe(FILE_LOCK_RELEASE_RETRY_ATTEMPTS + 1);
	expect(JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8")).pid).toBe(process.pid);

	// The owner generation stays releasable once the peer handle is gone.
	deny = false;
	await release();
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("release retries a refused Windows detach rename as access_denied contention", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const lockDir = `${filePath}.lock`;
	let detachAttempts = 0;
	FileLockTestHooks.nativeExactRemovalProbe = () => true;
	FileLockTestHooks.nativeQuarantineBindings = () =>
		detachingBindings(lockDir, {
			detach: () => {
				detachAttempts++;
				return detachAttempts <= 2 ? { ok: false, code: "access_denied" } : undefined;
			},
		});

	await withFileLock(filePath, async () => undefined, { retries: 2, retryDelayMs: 1 });

	expect(detachAttempts).toBe(3);
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.lstat(`${lockDir}.removing.owner`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a contender whose owner-record reads hit EBADF and EPERM keeps polling and acquires", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const infoPath = path.join(`${filePath}.lock`, "info");
	const release = await acquireFileLock(filePath, { retries: 2, retryDelayMs: 1 });

	let lstatRefusals = 0;
	let openRefusals = 0;
	// Resolved by the injected refusals themselves; release waits for that signal.
	const allRefused = Promise.withResolvers<void>();
	const noteRefusal = (): void => {
		if (lstatRefusals === 2 && openRefusals === 2) allRefused.resolve();
	};
	const realLstat = fs.lstat;
	vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
		if (lstatRefusals < 2 && samePath(String(target), infoPath)) {
			lstatRefusals++;
			noteRefusal();
			throw Object.assign(new Error(`EBADF: bad file descriptor, lstat '${String(target)}'`), { code: "EBADF" });
		}
		return realLstat(target, options);
	}) as typeof fs.lstat);
	const realOpenSync = fsSync.openSync;
	vi.spyOn(fsSync, "openSync").mockImplementation(((target, flags, mode) => {
		if (openRefusals < 2 && samePath(String(target), infoPath)) {
			openRefusals++;
			noteRefusal();
			throw Object.assign(new Error(`EPERM: operation not permitted, open '${String(target)}'`), {
				code: "EPERM",
			});
		}
		return realOpenSync(target, flags, mode);
	}) as typeof fsSync.openSync);

	let entered = false;
	const contender = withFileLock(
		filePath,
		async () => {
			entered = true;
		},
		{ retries: 500, retryDelayMs: 2 },
	);
	// A contender that wrongly gives up surfaces its own error here instead of a timeout.
	await Promise.race([allRefused.promise, contender]);
	expect(lstatRefusals).toBe(2);
	expect(openRefusals).toBe(2);
	expect(entered).toBe(false);

	await release();
	await contender;
	expect(entered).toBe(true);
});

test("a contender whose removal-transition probe hits EBADF and EPERM keeps polling and acquires", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const transitionPath = `${filePath}.lock.removing`;
	const release = await acquireFileLock(filePath, { retries: 2, retryDelayMs: 1 });

	const codes = ["EBADF", "EPERM"];
	let refusals = 0;
	const allRefused = Promise.withResolvers<void>();
	const realLstat = fs.lstat;
	vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
		if (refusals < codes.length && samePath(String(target), transitionPath)) {
			const code = codes[refusals++];
			if (refusals === codes.length) allRefused.resolve();
			throw Object.assign(new Error(`${code}: lstat '${String(target)}'`), { code });
		}
		return realLstat(target, options);
	}) as typeof fs.lstat);

	let entered = false;
	const contender = withFileLock(
		filePath,
		async () => {
			entered = true;
		},
		{ retries: 500, retryDelayMs: 2 },
	);
	// A contender that wrongly gives up surfaces its own error here instead of a timeout.
	await Promise.race([allRefused.promise, contender]);
	expect(refusals).toBe(codes.length);
	expect(entered).toBe(false);

	await release();
	await contender;
	expect(entered).toBe(true);
});

test("a retiring transition whose owner record refuses open is contention, not an acquire crash", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const transitionPath = `${filePath}.lock.removing`;
	const transitionInfo = path.join(transitionPath, "info");
	await fs.mkdir(transitionPath);
	const ownerBytes = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
	await fs.writeFile(transitionInfo, ownerBytes);
	let refusals = 0;
	const realOpenSync = fsSync.openSync;
	vi.spyOn(fsSync, "openSync").mockImplementation(((target, flags, mode) => {
		if (samePath(String(target), transitionInfo)) {
			refusals++;
			throw Object.assign(new Error(`EPERM: operation not permitted, open '${String(target)}'`), {
				code: "EPERM",
			});
		}
		return realOpenSync(target, flags, mode);
	}) as typeof fsSync.openSync);

	const attempt = withFileLock(filePath, async () => undefined, { retries: 2, retryDelayMs: 1, staleMs: 0 });
	await expect(attempt).rejects.toBeInstanceOf(FileLockAcquireError);
	await expect(attempt).rejects.toMatchObject({ code: "acquire_timeout" });

	expect(refusals).toBeGreaterThan(0);
	expect(await fs.readFile(transitionInfo, "utf8")).toBe(ownerBytes);
});

test("an acquire timeout against an owner record that stays refused describes the lock as changing", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const infoPath = path.join(`${filePath}.lock`, "info");
	const release = await acquireFileLock(filePath, { retries: 2, retryDelayMs: 1 });
	const realOpenSync = fsSync.openSync;
	vi.spyOn(fsSync, "openSync").mockImplementation(((target, flags, mode) => {
		if (samePath(String(target), infoPath)) {
			throw Object.assign(new Error(`EPERM: operation not permitted, open '${String(target)}'`), {
				code: "EPERM",
			});
		}
		return realOpenSync(target, flags, mode);
	}) as typeof fsSync.openSync);

	const attempt = withFileLock(filePath, async () => undefined, { retries: 2, retryDelayMs: 1 });
	await expect(attempt).rejects.toBeInstanceOf(FileLockAcquireError);
	await expect(attempt).rejects.toMatchObject({ code: "acquire_timeout" });
	await expect(attempt).rejects.toThrow("record is being replaced or removed");

	vi.restoreAllMocks();
	await release();
});

test("a dead-owner reclaim whose identity re-capture hits EBADF keeps polling and reclaims", async () => {
	const filePath = path.join(await createTempDir(), "state.json");
	const lockDir = `${filePath}.lock`;
	await fs.mkdir(lockDir);
	await fs.writeFile(path.join(lockDir, "info"), JSON.stringify({ pid: 2147483646, timestamp: Date.now() }));

	let refusals = 0;
	const realLstat = fs.lstat;
	vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
		// Only the stale verdict's identity re-capture (captureFileLockDirIdentity) is refused,
		// once, the way Windows refuses a stat of an entry another contender is deleting.
		if (
			refusals === 0 &&
			samePath(String(target), lockDir) &&
			new Error().stack?.includes("captureFileLockDirIdentity")
		) {
			refusals++;
			throw Object.assign(new Error(`EBADF: bad file descriptor, lstat '${String(target)}'`), { code: "EBADF" });
		}
		return realLstat(target, options);
	}) as typeof fs.lstat);

	let entered = false;
	await withFileLock(
		filePath,
		async () => {
			entered = true;
		},
		{ retries: 20, retryDelayMs: 1 },
	);
	expect(refusals).toBe(1);
	expect(entered).toBe(true);
});

test("on POSIX an unreadable owner record is not reported as changing", async () => {
	if (!originalPlatform) throw new Error("missing platform descriptor");
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
	const filePath = path.join(await createTempDir(), "state.json");
	const infoPath = path.join(`${filePath}.lock`, "info");
	const release = await acquireFileLock(filePath, { retries: 2, retryDelayMs: 1 });
	const realOpenSync = fsSync.openSync;
	vi.spyOn(fsSync, "openSync").mockImplementation(((target, flags, mode) => {
		if (samePath(String(target), infoPath)) {
			throw Object.assign(new Error(`EACCES: permission denied, open '${String(target)}'`), { code: "EACCES" });
		}
		return realOpenSync(target, flags, mode);
	}) as typeof fsSync.openSync);

	const attempt = withFileLock(filePath, async () => undefined, { retries: 2, retryDelayMs: 1 });
	await expect(attempt).rejects.toMatchObject({ code: "acquire_timeout" });
	await expect(attempt).rejects.toThrow("held by an unreadable owner (EACCES");
	await expect(attempt).rejects.not.toThrow("being replaced or removed");

	vi.restoreAllMocks();
	await release();
});

function publishThenRetire(transitionPath: string) {
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
	return () => transitionPublished;
}

test("publication rollback retries a pre-mutation access_denied restore", async () => {
	const filePath = path.join(await createTempDir(), "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const transitionPath = `${lockDir}.removing`;
	const published = publishThenRetire(transitionPath);
	let restoreAttempts = 0;
	FileLockTestHooks.nativeRestoreBinding = () => (detachedPath, originalPath, identity) => {
		restoreAttempts++;
		if (restoreAttempts <= 2) return { ok: false, code: "access_denied" };
		return exactRestore(detachedPath, originalPath, identity);
	};

	await expect(
		withFileLock(filePath, async () => undefined, { retries: 1, retryDelayMs: 1, staleMs: 0 }),
	).rejects.toMatchObject({ code: "orphan_transition" });

	expect(published()).toBe(true);
	expect(restoreAttempts).toBe(3);
	await expect(fs.lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readdir(path.dirname(lockDir))).toEqual([path.basename(transitionPath)]);
});

test("publication rollback exhaustion under persistent access_denied reports access_denied", async () => {
	const filePath = path.join(await createTempDir(), "sdk", "sessions", "index.jsonl");
	const lockDir = `${filePath}.lock`;
	const published = publishThenRetire(`${lockDir}.removing`);
	let restoreAttempts = 0;
	FileLockTestHooks.nativeRestoreBinding = () => () => {
		restoreAttempts++;
		return { ok: false, code: "access_denied" };
	};

	await expect(
		withFileLock(filePath, async () => undefined, { retries: 1, retryDelayMs: 1, staleMs: 0 }),
	).rejects.toThrow("Failed to roll back file lock published during removal transition: access_denied.");

	expect(published()).toBe(true);
	expect(restoreAttempts).toBe(FILE_LOCK_ROLLBACK_RETRY_ATTEMPTS);
	// Fail closed: the published generation is kept, never deleted by path.
	expect(JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8")).pid).toBe(process.pid);
});

// GC never classifies a refused `info` read as lock motion: a reader-side refusal was not
// observed under real multi-process churn, and an ACL-denied record refuses every pass.
// Treating it as "changing" kept the lock and let `gjc gc` exit successfully.
function gcContext(cwd: string): GcContext {
	return { cwd, env: {}, force: false, probe: () => ({ status: "keep" }) };
}

test("gc reports a refused owner record as a collection error", async () => {
	const tempDir = await createTempDir();
	const lockDir = path.join(tempDir, "state.json.lock");
	const infoPath = path.join(lockDir, "info");
	await fs.mkdir(lockDir);
	await fs.writeFile(infoPath, JSON.stringify({ pid: 12345, timestamp: Date.now() }));
	const realOpenSync = fsSync.openSync;
	vi.spyOn(fsSync, "openSync").mockImplementation(((target, flags, mode) => {
		if (samePath(String(target), infoPath))
			throw Object.assign(new Error(`EPERM: operation not permitted, open '${String(target)}'`), { code: "EPERM" });
		return realOpenSync(target, flags, mode);
	}) as typeof fsSync.openSync);

	const collected = await collectFileLocksForGc(gcContext(tempDir), { roots: [tempDir] });

	expect(collected.errors.map(error => error.message)).toEqual([expect.stringContaining("EPERM")]);
	expect(collected.records).toEqual([]);
});

test.skipIf(hostPlatform !== "win32")("gc reports an ACL-denied owner record as an error on every pass", async () => {
	const tempDir = await createTempDir();
	const lockDir = path.join(tempDir, "state.json.lock");
	const infoPath = path.join(lockDir, "info");
	await fs.mkdir(lockDir);
	await fs.writeFile(infoPath, JSON.stringify({ pid: 12345, timestamp: Date.now() }));
	const user = os.userInfo().username;
	await Bun.$`icacls ${infoPath} /deny ${`${user}:(R)`}`.quiet();
	try {
		for (let pass = 0; pass < 2; pass++) {
			const collected = await collectFileLocksForGc(gcContext(tempDir), { roots: [tempDir] });
			expect(collected.errors.map(error => error.message)).toEqual([expect.stringContaining("EPERM")]);
			expect(collected.records).toEqual([]);
		}
	} finally {
		await Bun.$`icacls ${infoPath} /remove:d ${user}`.quiet();
	}
});
