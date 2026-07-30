import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import { sweepResidentCacheRoot } from "@gajae-code/coding-agent/session/blob-store";
import { SessionManager, SessionManagerTestHooks } from "@gajae-code/coding-agent/session/session-manager";
import * as native from "@gajae-code/natives";
import { getAgentDir, getResidentCacheRootDir, setAgentDir } from "@gajae-code/utils";

const MiB = 1024 * 1024;
const originalAgentDir = getAgentDir();
const originalAgentDirOverride = process.env.GJC_CODING_AGENT_DIR;
const originalMaterializedCacheMaxBytesOverride = SessionManagerTestHooks.materializedCacheMaxBytesOverride;
const originalAfterForkSnapshot = SessionManagerTestHooks.afterForkSnapshot;
const temporaryDirectories: string[] = [];

beforeEach(() => {
	setAgentDir(path.join(makeTempDir("gjc-redteam-agent-"), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	SessionManagerTestHooks.materializedCacheMaxBytesOverride = originalMaterializedCacheMaxBytesOverride;
	setAgentDir(originalAgentDir);
	SessionManagerTestHooks.afterForkSnapshot = originalAfterForkSnapshot;
	if (originalAgentDirOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = originalAgentDirOverride;
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })),
	);
});

function makeTempDir(prefix = "gjc-redteam-resident-"): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function ensureOwnerOnlyDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
}

function installVerifiedNativeCleanup(): void {
	vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
		const parent = fs.lstatSync(path.dirname(pathname), { bigint: true });
		if (
			identity.parentDev === undefined ||
			identity.parentIno === undefined ||
			parent.dev !== identity.parentDev ||
			parent.ino !== identity.parentIno
		)
			throw new Error("resident cleanup parent authority mismatch");
		const stat = fs.lstatSync(pathname, { bigint: true });
		if (
			stat.dev !== identity.dev ||
			stat.ino !== identity.ino ||
			stat.nlink !== identity.nlink ||
			stat.size !== identity.size ||
			stat.mtimeNs !== identity.mtimeNs
		)
			throw new Error("resident cleanup file identity mismatch");
		if (identity.sha256) {
			const digest = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
			if (digest !== identity.sha256) throw new Error("resident cleanup file digest mismatch");
		}
		if (identity.directory && identity.quarantineName) {
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			fs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		}
		fs.rmSync(pathname, { force: true });
		return { ok: true };
	});
	vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation((pathname, snapshot, parentIdentity) => {
		const parent = fs.lstatSync(path.dirname(pathname), { bigint: true });
		if (!parentIdentity) throw new Error("resident tree cleanup parent authority missing");
		if (parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino)
			throw new Error("resident tree cleanup parent authority mismatch");
		const current = native.snapshotDirectoryTree(pathname);
		if (!current.ok || !current.snapshot || current.snapshot.entries.length !== snapshot.entries.length)
			throw new Error("resident tree cleanup snapshot mismatch");
		const expected = new Map(snapshot.entries.map(entry => [entry.relativePath, entry]));
		for (const entry of current.snapshot.entries) {
			const authorized = expected.get(entry.relativePath);
			if (!authorized) throw new Error("resident tree cleanup snapshot mismatch");
			if (entry.relativePath === "") {
				if (entry.kind !== "directory" || entry.dev !== authorized.dev || entry.ino !== authorized.ino)
					throw new Error("resident tree cleanup root identity mismatch");
			} else if (JSON.stringify(entry) !== JSON.stringify(authorized)) {
				throw new Error("resident tree cleanup child identity mismatch");
			}
		}
		fs.rmSync(pathname, { recursive: true, force: true });
		return { ok: true };
	});
}

function createWorkspace(label: string): { root: string; cwd: string } {
	const root = makeTempDir(`gjc-redteam-${label}-`);
	const cwd = path.join(root, "workspace");
	ensureOwnerOnlyDirectory(cwd);
	ensureOwnerOnlyDirectory(getAgentDir());
	return { root, cwd };
}

function createManager(
	label: string,
	destination: "managed" | "explicit" = "managed",
): {
	root: string;
	cwd: string;
	manager: SessionManager;
} {
	const { root, cwd } = createWorkspace(label);
	const sessionDestination = destination === "managed" ? undefined : path.join(root, "explicit-sessions");
	return { root, cwd, manager: SessionManager.create(cwd, sessionDestination) };
}

function residentCacheRoot(): string {
	return getResidentCacheRootDir(getAgentDir());
}

function residentInstanceDirs(root = residentCacheRoot()): string[] {
	try {
		const rootStat = fs.lstatSync(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
		return fs
			.readdirSync(root)
			.map(name => path.join(root, name))
			.filter(directory => {
				const stat = fs.lstatSync(directory);
				return path.basename(directory).startsWith("i-") && stat.isDirectory() && !stat.isSymbolicLink();
			})
			.sort();
	} catch {
		return [];
	}
}

function residentBlobFiles(instanceDir: string): string[] {
	return fs
		.readdirSync(instanceDir)
		.filter(name => /^[a-f0-9]{64}$/.test(name))
		.sort();
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function makeFsError(code: "EACCES" | "EPERM" | "EROFS"): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function appendUserText(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function messageText(manager: SessionManager, entryId: string): string {
	const entry = manager.getEntry(entryId);
	if (entry?.type !== "message") throw new Error("Expected a message entry.");
	if (entry.message.role !== "user" || typeof entry.message.content !== "string") {
		throw new Error("Expected a user string message.");
	}
	return entry.message.content;
}

function expectReadable(manager: SessionManager, text: string): void {
	expect(JSON.stringify(manager.getEntries())).toContain(text);
	expect(JSON.stringify(manager.buildSessionContext())).toContain(text);
}

function expectNoResidentLeak(value: string): void {
	expect(value).not.toContain("blob:sha256:");
	expect(value).not.toContain("__gjcResidentBlob");
	expect(value).not.toContain("Session resident text blob missing");
	expect(value).not.toContain("original content unavailable");
}

function exportedSessionData(html: string): string {
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	if (!encoded) throw new Error("Expected exported session data.");
	return Buffer.from(encoded, "base64").toString("utf8");
}

async function persist(manager: SessionManager): Promise<string> {
	await manager.ensureOnDisk();
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file.");
	return sessionFile;
}

function poisonResidentCacheRootAsFile(): string {
	const root = residentCacheRoot();
	ensureOwnerOnlyDirectory(path.dirname(root));
	fs.writeFileSync(root, "hostile resident-cache root", { mode: 0o600 });
	return root;
}

async function forceCollection(): Promise<void> {
	await Bun.sleep(0);
	Bun.gc(true);
	await Bun.sleep(0);
	Bun.gc(true);
}

describe.skipIf(process.platform === "win32")("ultragoal resident-cache adversarial QA", () => {
	it("C1 externalizes the 1 KiB boundary for managed and explicit sessions without export or JSONL leaks", async () => {
		for (const destination of ["managed", "explicit"] as const) {
			const { root, manager } = createManager(`c1-${destination}`, destination);
			const below = `C1-${destination}-below-${"a".repeat(1023 - `C1-${destination}-below-`.length)}`;
			const at = `C1-${destination}-at-${"b".repeat(1024 - `C1-${destination}-at-`.length)}`;
			const above = `C1-${destination}-above-${"c".repeat(1025 - `C1-${destination}-above-`.length)}`;
			try {
				const belowId = appendUserText(manager, below);
				const atId = appendUserText(manager, at);
				const aboveId = appendUserText(manager, above);
				const sessionFile = await persist(manager);
				const instances = residentInstanceDirs();
				expect(instances).toHaveLength(1);
				expect(residentBlobFiles(instances[0]!)).toHaveLength(2);
				expect(messageText(manager, belowId)).toBe(below);
				expect(messageText(manager, atId)).toBe(at);
				expect(messageText(manager, aboveId)).toBe(above);
				expectReadable(manager, at);
				expectReadable(manager, above);

				const htmlPath = path.join(root, `${destination}.html`);
				await exportSessionToHtml(manager, undefined, { outputPath: htmlPath });
				const exported = exportedSessionData(await Bun.file(htmlPath).text());
				expect(exported).toContain(at);
				expect(exported).toContain(above);
				expectNoResidentLeak(exported);

				await manager.rewriteEntries();
				const rewritten = await Bun.file(sessionFile).text();
				expect(rewritten).toContain(at);
				expect(rewritten).toContain(above);
				expectNoResidentLeak(rewritten);
			} finally {
				await manager.close().catch(() => {});
			}
			expect(residentInstanceDirs()).toEqual([]);
		}
	});

	it("C2 retains a predecessor on candidate failure and degrades to memory for EACCES, EPERM, and EROFS", async () => {
		const target = createManager("c2-target");
		const targetText = `C2-target-${"t".repeat(4096)}`;
		appendUserText(target.manager, targetText);
		const targetFile = await persist(target.manager);
		await target.manager.close();

		const predecessor = createManager("c2-predecessor");
		const predecessorText = `C2-predecessor-${"p".repeat(4096)}`;
		appendUserText(predecessor.manager, predecessorText);
		const predecessorFile = await persist(predecessor.manager);
		try {
			const root = residentCacheRoot();
			const originalMode = fs.statSync(root).mode & 0o777;
			fs.chmodSync(root, 0o777);
			try {
				await expect(predecessor.manager.setSessionFile(targetFile)).rejects.toThrow(
					"Resident cache trust validation failed",
				);
			} finally {
				fs.chmodSync(root, originalMode);
			}
			expect(predecessor.manager.getSessionFile()).toBe(predecessorFile);
			expectReadable(predecessor.manager, predecessorText);

			for (const code of ["EACCES", "EPERM", "EROFS"] as const) {
				const readonlyTarget = createManager(`c2-${code}`);
				const readonlyText = `C2-${code}-${"r".repeat(4096)}`;
				appendUserText(readonlyTarget.manager, readonlyText);
				const readonlyFile = await persist(readonlyTarget.manager);
				await readonlyTarget.manager.close();

				const realMkdtempSync = fs.mkdtempSync as (prefix: string) => string;
				const injectReadOnlyRoot = vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
					const pathname = String(prefix);
					if (isWithin(root, pathname)) throw makeFsError(code);
					return realMkdtempSync(pathname);
				}) as unknown as typeof fs.mkdtempSync);
				try {
					await expect(predecessor.manager.setSessionFile(readonlyFile)).resolves.toBeUndefined();
				} finally {
					injectReadOnlyRoot.mockRestore();
				}
				expect(predecessor.manager.getSessionFile()).toBe(readonlyFile);
				expectReadable(predecessor.manager, readonlyText);
				expect(
					predecessor.manager.getObservabilityStatsForTests().residentCacheAdoptFallbackCount,
				).toBeGreaterThanOrEqual(1);
			}
		} finally {
			await predecessor.manager.close().catch(() => {});
		}
	});

	it("C3 preserves the linearized predecessor append, filters legacy cache artifacts, and cleans fork/branch/move/drop lifecycles", async () => {
		const { root, manager } = createManager("c3");
		const rootText = `C3-root-${"r".repeat(2048)}`;
		const branchText = `C3-branch-${"b".repeat(2048)}`;
		const interleavedText = `C3-interleaved-${"i".repeat(2048)}`;
		const rootEntryId = appendUserText(manager, rootText);
		appendUserText(manager, `C3-abandoned-${"a".repeat(2048)}`);
		manager.branch(rootEntryId);
		appendUserText(manager, branchText);
		const sourceFile = await persist(manager);
		const sourceArtifacts = manager.getArtifactsDir();
		if (!sourceArtifacts) throw new Error("Expected source artifacts directory.");
		ensureOwnerOnlyDirectory(sourceArtifacts);
		fs.writeFileSync(path.join(sourceArtifacts, "kept.txt"), "keep", { mode: 0o600 });
		ensureOwnerOnlyDirectory(path.join(sourceArtifacts, "resident-cache"));
		fs.writeFileSync(path.join(sourceArtifacts, "resident-cache", "legacy.txt"), "never copy", { mode: 0o600 });

		const collisionFile = path.join(path.dirname(sourceFile), "collision.jsonl");
		const collisionArtifacts = collisionFile.slice(0, -6);
		ensureOwnerOnlyDirectory(collisionArtifacts);
		fs.writeFileSync(path.join(collisionArtifacts, "foreign.txt"), "foreign", { mode: 0o600 });
		try {
			await expect(manager.copyArtifactsForFork(sourceFile, collisionFile)).rejects.toThrow("destination_conflict");
			expect(await Bun.file(path.join(collisionArtifacts, "foreign.txt")).text()).toBe("foreign");
			expectReadable(manager, branchText);

			const forkSnapshotEntered = Promise.withResolvers<void>();
			const releaseForkSnapshot = Promise.withResolvers<void>();
			SessionManagerTestHooks.afterForkSnapshot = () => {
				forkSnapshotEntered.resolve();
				return releaseForkSnapshot.promise;
			};
			const forkPromise = manager.fork();
			let forked: { oldSessionFile: string; newSessionFile: string } | undefined;
			try {
				await forkSnapshotEntered.promise;
				appendUserText(manager, interleavedText);
				releaseForkSnapshot.resolve();
				forked = await forkPromise;
			} finally {
				releaseForkSnapshot.resolve();
				SessionManagerTestHooks.afterForkSnapshot = originalAfterForkSnapshot;
				await forkPromise.catch(() => undefined);
			}
			if (!forked) throw new Error("Expected a forked session.");
			const persistedSuccessor = await SessionManager.open(forked.newSessionFile);
			try {
				expectReadable(persistedSuccessor, rootText);
				expectReadable(persistedSuccessor, branchText);
				expect(JSON.stringify(persistedSuccessor.getEntries())).not.toContain(interleavedText);
			} finally {
				await persistedSuccessor.close();
			}
			await manager.flush();
			expect(forked.oldSessionFile).toBe(sourceFile);
			expect(manager.getSessionFile()).toBe(forked.newSessionFile);
			expectReadable(manager, rootText);
			expectReadable(manager, branchText);
			expect(JSON.stringify(manager.getEntries())).not.toContain(interleavedText);

			const oldManager = await SessionManager.open(forked.oldSessionFile);
			try {
				expectReadable(oldManager, rootText);
				expectReadable(oldManager, branchText);
				expectReadable(oldManager, interleavedText);
			} finally {
				await oldManager.close();
			}
			const forkedArtifacts = forked.newSessionFile.slice(0, -6);
			expect(await Bun.file(path.join(forkedArtifacts, "kept.txt")).text()).toBe("keep");
			expect(fs.existsSync(path.join(forkedArtifacts, "resident-cache"))).toBe(false);
			expect(await Bun.file(path.join(sourceArtifacts, "kept.txt")).text()).toBe("keep");
			expect(await Bun.file(path.join(sourceArtifacts, "resident-cache", "legacy.txt")).text()).toBe("never copy");

			installVerifiedNativeCleanup();
			await manager.dropSession(forked.oldSessionFile);
			expect(fs.existsSync(forked.oldSessionFile)).toBe(false);
			expect(fs.existsSync(forked.oldSessionFile.slice(0, -6))).toBe(false);
			expectReadable(manager, branchText);

			const movedCwd = path.join(root, "moved-workspace");
			ensureOwnerOnlyDirectory(movedCwd);
			await manager.moveTo(movedCwd);
			expect(manager.getCwd()).toBe(movedCwd);
			expectReadable(manager, branchText);
		} finally {
			await manager.close().catch(() => {});
			await manager.close().catch(() => {});
		}
		expect(residentInstanceDirs()).toEqual([]);
	});

	it("C3 rejects a duplicate prepared commit without releasing the committed successor", async () => {
		const { manager } = createManager("c3-double-commit");
		const successorText = `C3-successor-${"s".repeat(4096)}`;
		try {
			await persist(manager);
			const prepared = await manager.prepareNewSession();
			manager.appendPreparedCustomMessageEntry(prepared, "redteam", successorText, true);
			manager.commitPreparedNewSession(prepared);
			expectReadable(manager, successorText);
			expect(() => manager.commitPreparedNewSession(prepared)).toThrow("Prepared session is no longer available.");
			await manager.discardPreparedNewSession(prepared);
			await manager.discardPreparedNewSession(prepared);
			expectReadable(manager, successorText);
		} finally {
			await manager.close().catch(() => {});
			await manager.close().catch(() => {});
		}
		expect(residentInstanceDirs()).toEqual([]);
	});

	it("C4 fails closed to a canonical memory store for symlinked and permissive roots without writing hostile paths", async () => {
		for (const hostileKind of ["symlink", "permissive"] as const) {
			const { root, cwd } = createWorkspace(`c4-${hostileKind}`);
			const cacheRoot = residentCacheRoot();
			const attacker = path.join(root, "attacker-cache");
			ensureOwnerOnlyDirectory(path.dirname(cacheRoot));
			if (hostileKind === "symlink") {
				ensureOwnerOnlyDirectory(attacker);
				fs.symlinkSync(attacker, cacheRoot, "dir");
			} else {
				fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o777 });
				fs.chmodSync(cacheRoot, 0o777);
			}
			const manager = SessionManager.create(cwd);
			const text = `C4-${hostileKind}-${"h".repeat(4096)}`;
			try {
				const id = appendUserText(manager, text);
				await persist(manager);
				expect(messageText(manager, id)).toBe(text);
				expectReadable(manager, text);
				expect(manager.getObservabilityStatsForTests()).toMatchObject({
					residentCacheTrustRejectCount: 1,
					residentCacheAdoptFallbackCount: 1,
				});
				expect(residentInstanceDirs(cacheRoot)).toEqual([]);
				if (hostileKind === "symlink") expect(fs.readdirSync(attacker)).toEqual([]);
			} finally {
				await manager.close().catch(() => {});
			}
		}
	});

	it("C5 retains all 4,097 degraded canonical blobs and 63/64/65 MiB payloads", async () => {
		poisonResidentCacheRootAsFile();
		const countCase = createManager("c5-count");
		try {
			const ids: string[] = [];
			for (let index = 0; index < 4097; index++) {
				const text = `C5-count-${index.toString().padStart(4, "0")}-${"c".repeat(1024)}`;
				ids.push(appendUserText(countCase.manager, text));
			}
			for (const index of [4094, 4095, 4096]) {
				expect(messageText(countCase.manager, ids[index]!)).toBe(
					`C5-count-${index.toString().padStart(4, "0")}-${"c".repeat(1024)}`,
				);
			}
			expect(countCase.manager.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 1,
				residentCacheAdoptFallbackCount: 1,
			});
		} finally {
			await countCase.manager.close();
		}

		for (const sizeMiB of [63, 64, 65]) {
			const sizeCase = createManager(`c5-${sizeMiB}mib`);
			try {
				const prefix = `C5-${sizeMiB}MiB-`;
				let text = `${prefix}${"m".repeat(sizeMiB * MiB - Buffer.byteLength(prefix))}`;
				const id = appendUserText(sizeCase.manager, text);
				expect(Buffer.byteLength(text)).toBe(sizeMiB * MiB);
				expect(messageText(sizeCase.manager, id)).toBe(text);
				expect(sizeCase.manager.getObservabilityStatsForTests()).toMatchObject({
					residentCacheTrustRejectCount: 1,
					residentCacheAdoptFallbackCount: 1,
				});
				text = "";
			} finally {
				await sizeCase.manager.close();
			}
			await forceCollection();
		}
	}, 120_000);

	it("C6 simulates the win32 gate and proves no cache-root mkdir or mkdtemp occurs", async () => {
		const { root, cwd } = createWorkspace("c6");
		const cacheRoot = residentCacheRoot();
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const mkdirSync = vi.spyOn(fs, "mkdirSync");
		const mkdtempSync = vi.spyOn(fs, "mkdtempSync");
		let manager: SessionManager | undefined;
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			manager = SessionManager.create(cwd, path.join(root, "explicit-sessions"));
			appendUserText(manager, `C6-win32-${"w".repeat(4096)}`);
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
		try {
			expect(manager).toBeDefined();
			expectReadable(manager!, "C6-win32-");
			expect(manager!.getObservabilityStatsForTests().residentCacheWin32FallbackCount).toBe(1);
			expect(fs.existsSync(cacheRoot)).toBe(false);
			expect(mkdirSync.mock.calls.some(([directory]) => isWithin(cacheRoot, String(directory)))).toBe(false);
			expect(mkdtempSync.mock.calls.some(([prefix]) => isWithin(cacheRoot, String(prefix)))).toBe(false);
		} finally {
			await manager?.close().catch(() => {});
		}
	});

	it("C7 races bounded GC with live writes and preserves the leased active instance", async () => {
		const { manager } = createManager("c7");
		const root = residentCacheRoot();
		const seed = `C7-seed-${"s".repeat(4096)}`;
		appendUserText(manager, seed);
		await persist(manager);
		const active = residentInstanceDirs(root);
		expect(active).toHaveLength(1);
		const stale = path.join(root, "i-redteam-dead");
		ensureOwnerOnlyDirectory(stale);
		fs.writeFileSync(
			path.join(stale, "owner.json"),
			JSON.stringify({ pid: 2_147_483_647, startTimeMs: 0, nonce: "redteam-dead" }),
			{ mode: 0o600 },
		);
		try {
			const appendRace = (async () => {
				for (let index = 0; index < 4; index++) {
					appendUserText(manager, `C7-race-${index}-${"r".repeat(2048)}`);
					await Bun.sleep(0);
				}
			})();
			await Promise.all([sweepResidentCacheRoot(root, { maxDirectories: 64, maxDurationMs: 250 }), appendRace]);
			expect(fs.existsSync(active[0]!)).toBe(true);
			expect(fs.existsSync(stale)).toBe(false);
			expectReadable(manager, seed);
			expectReadable(manager, "C7-race-3-");
		} finally {
			await manager.close();
		}
		expect(residentInstanceDirs(root)).toEqual([]);
	});

	it("C8 keeps below-cap snapshots strong and rebuilds above-cap snapshots without content loss", async () => {
		const belowCap = SessionManager.inMemory();
		try {
			SessionManagerTestHooks.materializedCacheMaxBytesOverride = MiB;
			const belowText = `C8-below-${"b".repeat(32 * 1024)}`;
			appendUserText(belowCap, belowText);
			expectReadable(belowCap, belowText);
			const warmed = belowCap.getObservabilityStatsForTests();
			for (let cycle = 0; cycle < 3; cycle++) {
				await forceCollection();
				expectReadable(belowCap, belowText);
			}
			expect(belowCap.getObservabilityStatsForTests()).toMatchObject({
				materializedEntriesCachePopulateCount: warmed.materializedEntriesCachePopulateCount,
				pathOnlyContextBuildCount: warmed.pathOnlyContextBuildCount,
			});
		} finally {
			await belowCap.close();
		}

		const aboveCap = SessionManager.inMemory();
		try {
			SessionManagerTestHooks.materializedCacheMaxBytesOverride = 1024;
			const aboveText = `C8-above-${"a".repeat(128 * 1024)}`;
			appendUserText(aboveCap, aboveText);
			expectReadable(aboveCap, aboveText);
			const warmed = aboveCap.getObservabilityStatsForTests();
			let observedRebuild = false;
			for (let cycle = 0; cycle < 30; cycle++) {
				await forceCollection();
				expectReadable(aboveCap, aboveText);
				const current = aboveCap.getObservabilityStatsForTests();
				if (
					current.materializedEntriesCachePopulateCount > warmed.materializedEntriesCachePopulateCount &&
					current.pathOnlyContextBuildCount > warmed.pathOnlyContextBuildCount
				) {
					observedRebuild = true;
					break;
				}
			}
			expect(aboveCap.getObservabilityStatsForTests().materializedCacheDemotedCount).toBe(1);
			expect(observedRebuild).toBe(true);
		} finally {
			await aboveCap.close();
		}
	});
});
