import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EphemeralBlobStore,
	MemoryBlobStore,
	openVerifiedResidentCacheInstanceDir,
	ResidentCacheTrustError,
} from "@gajae-code/coding-agent/session/blob-store";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, getResidentCacheRootDir, setAgentDir } from "@gajae-code/utils";

const originalAgentDir = getAgentDir();
const originalAgentDirOverride = process.env.GJC_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

beforeEach(() => {
	setAgentDir(path.join(makeTempDir(), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	if (originalAgentDirOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = originalAgentDirOverride;
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })),
	);
});

function makeTempDir(prefix = "gjc-resident-root-security-"): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function residentCacheRoot(): string {
	return getResidentCacheRootDir(getAgentDir());
}

function residentInstanceDirs(root = residentCacheRoot()): string[] {
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root)
		.map(name => path.join(root, name))
		.filter(directory => {
			const stat = fs.lstatSync(directory);
			return path.basename(directory).startsWith("i-") && stat.isDirectory() && !stat.isSymbolicLink();
		});
}

function activeResidentInstanceDir(): string {
	const directories = residentInstanceDirs();
	expect(directories).toHaveLength(1);
	return directories[0]!;
}

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function userText(manager: SessionManager, entryId: string): string {
	const entry = manager.getEntry(entryId);
	if (entry?.type !== "message") throw new Error("Expected a message entry");
	const content = (entry.message as { content?: unknown }).content;
	if (typeof content !== "string") throw new Error("Expected a string message content");
	return content;
}

function appendLargeUserText(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function createManager(root: string): SessionManager {
	return SessionManager.create(root, path.join(root, "sessions"));
}

function makeFsError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function asPathname(file: fs.PathLike): string {
	return typeof file === "string" ? file : file.toString();
}

function isDirectoryOpen(flags: fs.OpenMode | undefined): boolean {
	return typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0;
}

describe.skipIf(process.platform === "win32")("resident cache root trust boundary", () => {
	it("rejects a pre-created symlinked cache root and installs a MemoryBlobStore fallback", async () => {
		const root = makeTempDir();
		const cacheRoot = residentCacheRoot();
		const attackerDirectory = path.join(root, "attacker-controlled-cache");
		fs.mkdirSync(path.dirname(cacheRoot), { recursive: true, mode: 0o700 });
		fs.mkdirSync(attackerDirectory, { mode: 0o700 });
		fs.symlinkSync(attackerDirectory, cacheRoot, "dir");

		expect(() => openVerifiedResidentCacheInstanceDir(cacheRoot)).toThrow(ResidentCacheTrustError);
		expect(fs.readdirSync(attackerDirectory)).toEqual([]);

		const manager = createManager(root);
		try {
			const entryId = appendLargeUserText(manager, `symlink fallback ${"s".repeat(4096)}`);
			await manager.ensureOnDisk();

			expect(userText(manager, entryId)).toContain("symlink fallback");
			expect(manager.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 1,
				residentCacheAdoptFallbackCount: 1,
			});
			expect(residentInstanceDirs()).toEqual([]);
			expect(fs.readdirSync(attackerDirectory)).toEqual([]);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it.each([
		["group-accessible", 0o770],
		["other-accessible", 0o707],
	] as const)("rejects a %s pre-existing cache root and falls back to memory", async (_access, mode) => {
		const root = makeTempDir();
		const cacheRoot = residentCacheRoot();
		fs.mkdirSync(cacheRoot, { recursive: true, mode });
		fs.chmodSync(cacheRoot, mode);

		expect(() => openVerifiedResidentCacheInstanceDir(cacheRoot)).toThrow(ResidentCacheTrustError);
		expect(residentInstanceDirs()).toEqual([]);

		const manager = createManager(root);
		try {
			const entryId = appendLargeUserText(manager, `permissive root ${"p".repeat(4096)}`);
			await manager.ensureOnDisk();

			expect(userText(manager, entryId)).toContain("permissive root");
			expect(manager.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 1,
				residentCacheAdoptFallbackCount: 1,
			});
			expect(residentInstanceDirs()).toEqual([]);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("rejects a foreign-owned root reported by the owner-verification seam", async () => {
		const root = makeTempDir();
		const cacheRoot = residentCacheRoot();
		fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
		fs.chmodSync(cacheRoot, 0o700);

		const realLstatSync = fs.lstatSync.bind(fs);
		vi.spyOn(fs, "lstatSync").mockImplementation(((pathname: fs.PathLike, options?: fs.StatOptions) => {
			const stat = realLstatSync(pathname, options as never);
			if (path.resolve(asPathname(pathname)) !== cacheRoot) return stat;
			const foreign = Object.create(stat) as fs.Stats;
			Object.defineProperty(foreign, "uid", { value: stat.uid + 1 });
			return foreign;
		}) as typeof fs.lstatSync);

		expect(() => openVerifiedResidentCacheInstanceDir(cacheRoot)).toThrow(ResidentCacheTrustError);

		const manager = createManager(root);
		try {
			const entryId = appendLargeUserText(manager, `foreign owner ${"f".repeat(4096)}`);
			await manager.ensureOnDisk();

			expect(userText(manager, entryId)).toContain("foreign owner");
			expect(manager.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 1,
				residentCacheAdoptFallbackCount: 1,
			});
			expect(residentInstanceDirs()).toEqual([]);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("rejects a root replaced by a symlink between lstat and no-follow open", () => {
		const root = makeTempDir();
		const cacheRoot = residentCacheRoot();
		const attackerDirectory = path.join(root, "replacement-target");
		fs.mkdirSync(attackerDirectory, { mode: 0o700 });

		const realOpenSync = fs.openSync.bind(fs);
		let replaced = false;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
			if (!replaced && path.resolve(asPathname(file)) === cacheRoot && isDirectoryOpen(flags)) {
				replaced = true;
				fs.rmdirSync(cacheRoot);
				fs.symlinkSync(attackerDirectory, cacheRoot, "dir");
			}
			return realOpenSync(file, flags as never, mode as never);
		}) as typeof fs.openSync);

		expect(() => openVerifiedResidentCacheInstanceDir(cacheRoot)).toThrow(ResidentCacheTrustError);
		expect(replaced).toBe(true);
		expect(fs.lstatSync(cacheRoot).isSymbolicLink()).toBe(true);
		expect(fs.readdirSync(attackerDirectory)).toEqual([]);
	});

	it("deduplicates duplicate >1 MiB content without demoting the resident store", async () => {
		const root = makeTempDir();
		const manager = createManager(root);
		const payload = `deduplicated payload ${"d".repeat(1024 * 1024)}`;
		try {
			const firstId = appendLargeUserText(manager, payload);
			const secondId = appendLargeUserText(manager, payload);
			const instanceDir = activeResidentInstanceDir();
			const hash = sha256(Buffer.from(payload, "utf8"));

			expect(userText(manager, firstId)).toBe(payload);
			expect(userText(manager, secondId)).toBe(payload);
			expect(fs.readdirSync(instanceDir).filter(name => /^[a-f0-9]{64}$/.test(name))).toEqual([hash]);
			expect(manager.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 0,
				residentCacheDegradedReason: undefined,
			});
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("fails closed when EEXIST resolves to a pre-planted symlink at the content hash", () => {
		const root = makeTempDir();
		const instanceDir = openVerifiedResidentCacheInstanceDir(path.join(root, "resident-cache"));
		const store = EphemeralBlobStore.adoptVerifiedDir(instanceDir);
		const payload = Buffer.from(`foreign eexist ${"e".repeat(4096)}`, "utf8");
		const target = path.join(instanceDir, sha256(payload));
		const attackerFile = path.join(root, "attacker.txt");
		fs.writeFileSync(attackerFile, "attacker bytes");
		fs.symlinkSync(attackerFile, target);

		expect(() => store.putSync(payload)).toThrow(ResidentCacheTrustError);
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
	});

	it.each([
		"symlink",
		"corrupt file",
	] as const)("fails closed when an adopted store cache miss reads a replaced %s blob", async kind => {
		const root = makeTempDir();
		const instanceDir = openVerifiedResidentCacheInstanceDir(path.join(root, "resident-cache"));
		const store = EphemeralBlobStore.adoptVerifiedDir(instanceDir);
		// Exceeds the 8 MiB buffer cache so getSync must reopen the replacement.
		const payload = Buffer.alloc(8 * 1024 * 1024 + 1, "r");
		const { hash, path: blobPath } = store.putSync(payload);
		let result: Buffer | null | undefined;
		try {
			if (kind === "symlink") {
				const attackerFile = path.join(root, "attacker-controlled.txt");
				fs.writeFileSync(attackerFile, "attacker-controlled bytes");
				fs.unlinkSync(blobPath);
				fs.symlinkSync(attackerFile, blobPath);
			} else {
				fs.writeFileSync(blobPath, "corrupt replacement", { mode: 0o600 });
			}

			expect(() => {
				result = store.getSync(hash);
			}).toThrow(ResidentCacheTrustError);
			expect(result).toBeUndefined();
			await expect(store.get(hash)).rejects.toThrow(ResidentCacheTrustError);
		} finally {
			store.dispose();
		}
	});

	// `expectedCauseCode` is the discriminator `reason` cannot provide: ELOOP and
	// ENOENT both demote as `blob_create_failed`, so a demotion that reports only
	// the reason cannot tell a hostile path from a cache directory that vanished.
	it.each([
		["foreign EEXIST symlink", "blob_untrusted", undefined],
		["injected ELOOP", "blob_create_failed", "ELOOP"],
		["injected ENOENT", "blob_create_failed", "ENOENT"],
	] as const)("demotes the whole resident store after %s, preserves old content, and retries the triggering append once", async (injection, expectedReason, expectedCauseCode) => {
		const root = makeTempDir();
		const manager = createManager(root);
		const preDemotionText = `pre-demotion ${"a".repeat(4096)}`;
		const triggeringText = `triggering append ${"b".repeat(4096)}`;
		const triggeringBytes = Buffer.from(triggeringText, "utf8");
		try {
			const preDemotionId = appendLargeUserText(manager, preDemotionText);
			const instanceDir = activeResidentInstanceDir();
			const target = path.join(instanceDir, sha256(triggeringBytes));

			const residentPut = EphemeralBlobStore.prototype.putSync;
			let residentTriggerPutCalls = 0;
			vi.spyOn(EphemeralBlobStore.prototype, "putSync").mockImplementation(function (
				this: EphemeralBlobStore,
				data: Buffer,
			) {
				if (data.equals(triggeringBytes)) residentTriggerPutCalls++;
				return residentPut.call(this, data);
			});
			const memoryPut = MemoryBlobStore.prototype.putSync;
			let memoryTriggerPutCalls = 0;
			vi.spyOn(MemoryBlobStore.prototype, "putSync").mockImplementation(function (
				this: MemoryBlobStore,
				data: Buffer,
			) {
				if (data.equals(triggeringBytes)) memoryTriggerPutCalls++;
				return memoryPut.call(this, data);
			});

			if (injection === "foreign EEXIST symlink") {
				const attackerFile = path.join(root, "pre-planted-attacker.txt");
				fs.writeFileSync(attackerFile, "attacker bytes");
				fs.symlinkSync(attackerFile, target);
			} else {
				const code = injection === "injected ELOOP" ? "ELOOP" : "ENOENT";
				const realOpenSync = fs.openSync.bind(fs);
				vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
					if (path.resolve(asPathname(file)) === target) throw makeFsError(code);
					return realOpenSync(file, flags as never, mode as never);
				}) as typeof fs.openSync);
			}

			const triggeringId = appendLargeUserText(manager, triggeringText);

			expect(residentTriggerPutCalls).toBe(1);
			expect(memoryTriggerPutCalls).toBe(1);
			expect(userText(manager, preDemotionId)).toBe(preDemotionText);
			expect(userText(manager, triggeringId)).toBe(triggeringText);
			expect(manager.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 1,
				residentCacheDegradedReason: expectedReason,
				residentCacheDegradedCauseCode: expectedCauseCode,
			});
			expect(residentInstanceDirs()).toEqual([]);
		} finally {
			await manager.close().catch(() => {});
		}
	});
});

describe("ResidentCacheTrustError cause exposure", () => {
	it("lifts the wrapped errno so a demotion names why the step failed, not just which step", () => {
		const cause = Object.assign(new Error("ENOENT: no such file or directory, open '/gone/blob'"), {
			code: "ENOENT",
		});
		const error = new ResidentCacheTrustError("blob_create_failed", "/gone/blob", { cause });

		expect(error.causeCode).toBe("ENOENT");
		expect(error.causeSummary).toBe("Error: ENOENT: no such file or directory, open '/gone/blob'");
	});

	it("reports no cause fields for a policy rejection that wrapped nothing", () => {
		const error = new ResidentCacheTrustError("blob_untrusted", "/tmp/blob");

		expect(error.causeCode).toBeUndefined();
		expect(error.causeSummary).toBeUndefined();
	});

	it("bounds and single-lines a cause so a log record cannot inherit an unbounded thrown value", () => {
		const error = new ResidentCacheTrustError("blob_write_failed", "/tmp/blob", {
			cause: new Error(`line one\n${"z".repeat(4096)}`),
		});

		expect(error.causeSummary).toHaveLength(200);
		expect(error.causeSummary?.endsWith("…")).toBe(true);
		expect(error.causeSummary).not.toContain("\n");
		expect(error.causeCode).toBeUndefined();
	});

	it("survives a cause whose own stringification throws", () => {
		const hostile = {
			toString() {
				throw new Error("nope");
			},
		};
		const error = new ResidentCacheTrustError("blob_close_failed", "/tmp/blob", { cause: hostile });

		expect(error.causeSummary).toBe("<uninspectable cause>");
	});
});

// The demotion is the salvage that runs *because* the cache already failed, so it
// reads a store that is by definition missing blobs. It used to inherit the default
// fail-closed policy and throw on the very entry it exists to rescue, which left the
// transition uncommitted — the store stayed broken and every later turn repeated the
// same throw out of the `message_end` handler, surfacing as a bare `Operation aborted`.
describe.skipIf(process.platform === "win32")("resident demotion salvages an unrecoverable blob", () => {
	it("keeps the session usable and substitutes a placeholder instead of throwing", () => {
		const root = makeTempDir();
		const manager = createManager(root);
		const lostText = `lost body ${"L".repeat(8192)}`;
		const keptText = `kept body ${"K".repeat(8192)}`;
		const triggerText = `trigger ${"T".repeat(8192)}`;
		try {
			const lostId = appendLargeUserText(manager, lostText);
			const keptId = appendLargeUserText(manager, keptText);
			const instanceDir = activeResidentInstanceDir();
			const lostHash = sha256(Buffer.from(lostText, "utf8"));

			// The externalized body is gone for good: the blob file is deleted, and neither
			// the in-process buffer nor the persisted transcript can produce it again.
			fs.rmSync(path.join(instanceDir, lostHash), { force: true });
			const realGetBuffered = EphemeralBlobStore.prototype.getBufferedSync;
			vi.spyOn(EphemeralBlobStore.prototype, "getBufferedSync").mockImplementation(function (
				this: EphemeralBlobStore,
				hash: string,
			) {
				return hash === lostHash ? null : realGetBuffered.call(this, hash);
			});

			// Force the trust rejection that drives the demotion.
			const realOpenSync = fs.openSync.bind(fs);
			const triggerTarget = path.join(instanceDir, sha256(Buffer.from(triggerText, "utf8")));
			vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
				if (path.resolve(asPathname(file)) === triggerTarget) throw makeFsError("ENOENT");
				return realOpenSync(file, flags as never, mode as never);
			}) as typeof fs.openSync);

			const triggerId = appendLargeUserText(manager, triggerText);

			// The turn survives: the append lands, unaffected entries are byte-intact, and
			// only the unrecoverable one degrades — to explanatory text, never a blob ref.
			expect(userText(manager, keptId)).toBe(keptText);
			expect(userText(manager, triggerId)).toBe(triggerText);
			const lost = userText(manager, lostId);
			expect(lost).toBe(`[Session resident text blob missing: sha256:${lostHash}; original content unavailable]`);
			expect(lost).not.toContain("blob:sha256:");

			const stats = manager.getObservabilityStatsForTests();
			expect(stats.residentCacheTrustRejectCount).toBe(1);
			expect(stats.residentCacheDegradedReason).toBe("blob_create_failed");
			expect(stats.residentBlobPlaceholderCount).toBe(1);

			// The session keeps accepting work rather than repeating the failure every turn.
			vi.restoreAllMocks();
			const afterId = appendLargeUserText(manager, "after the demotion");
			expect(userText(manager, afterId)).toBe("after the demotion");
			expect(manager.getObservabilityStatsForTests().residentCacheTrustRejectCount).toBe(1);
		} finally {
			vi.restoreAllMocks();
			manager.close().catch(() => {});
		}
	});
});
