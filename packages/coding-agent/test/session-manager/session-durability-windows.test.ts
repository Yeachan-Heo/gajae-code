import { afterEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import * as native from "@gajae-code/natives";
import {
	canonicalBindingOpenFlags,
	cleanupAuthorityMatches,
	detachArtifactRootForMigration,
	fsyncCanonicalBinding,
	listManagedCandidates,
	matchesMigrationArtifactRoot,
	openManagedCandidateForWrite,
	resolveManagedScope,
	restorePreparedArtifactRoot,
} from "../../src/session/internal/managed-session-scope";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function temporaryDirectory(prefix: string): string {
	return syncFs.mkdtempSync(path.join(syncFs.realpathSync(os.tmpdir()), prefix));
}

function legacyDirectory(sessionsRoot: string, cwd: string): string {
	return path.join(
		sessionsRoot,
		`--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
}

function transcript(id: string, cwd: string): string {
	return `${JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
}

async function fixture() {
	const root = temporaryDirectory("gjc-session-durability-");
	temporaryDirectories.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	await fs.mkdir(cwd, { recursive: true });
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	return { cwd, agentDir, sessionsRoot, scope: resolved.scope };
}

async function interruptedArtifactMigration(
	id: string,
	detachOutcome: "clean" | "cleanup_pending" = "cleanup_pending",
) {
	const { cwd, agentDir, sessionsRoot, scope } = await fixture();
	const legacy = legacyDirectory(sessionsRoot, cwd);
	const source = path.join(legacy, `${id}.jsonl`);
	const artifacts = source.slice(0, -6);
	await fs.mkdir(artifacts, { recursive: true });
	await fs.writeFile(path.join(artifacts, "payload.txt"), "authoritative");
	await fs.writeFile(source, transcript(id, cwd));
	const listed = listManagedCandidates(scope);
	if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");
	const artifactSnapshot = native.snapshotDirectoryTree(artifacts);
	if (!artifactSnapshot.ok || !artifactSnapshot.snapshot) throw new Error("Native snapshot unavailable");
	let detachedPath: string | undefined;
	const snapshotDirectoryTree = native.snapshotDirectoryTree;
	vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname =>
		pathname === detachedPath ? { ok: true, snapshot: artifactSnapshot.snapshot } : snapshotDirectoryTree(pathname),
	);
	const exactUnlink = native.exactUnlink;
	vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
		if (pathname !== artifacts || !identity.directory || !identity.detachOnly || !identity.quarantineName)
			return exactUnlink(pathname, identity);
		detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
		syncFs.renameSync(pathname, detachedPath);
		if (detachOutcome === "clean") return { ok: true, detachedPath };
		syncFs.mkdirSync(pathname);
		return { ok: false, code: "cleanup_pending", detachedPath, retainedPlaceholderPath: pathname };
	});
	vi.spyOn(native, "exactRestore").mockReturnValue({ ok: false, code: "io_error" });
	expect(await openManagedCandidateForWrite(scope, listed.owned[0])).toMatchObject({
		kind: "error",
		code: "durability_failed",
	});
	const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
	const name = (await fs.readdir(receipts)).find(entry => entry.endsWith(".detached.json"));
	if (!name) throw new Error("Missing detached receipt");
	return {
		cwd,
		agentDir,
		sessionsRoot,
		source,
		artifacts,
		candidate: listed.owned[0],
		receipt: path.join(receipts, name),
	};
}

async function restartedLegacy(interrupted: Awaited<ReturnType<typeof interruptedArtifactMigration>>) {
	const resolved = resolveManagedScope({
		cwd: interrupted.cwd,
		agentDir: interrupted.agentDir,
		sessionsRoot: interrupted.sessionsRoot,
	});
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const restarted = listManagedCandidates(resolved.scope);
	if (restarted.kind !== "complete") throw new Error("Could not list restarted candidates");
	const legacy = restarted.owned.find(candidate => candidate.provenance === "legacy");
	if (!legacy) throw new Error("Missing restarted legacy candidate");
	return { scope: resolved.scope, legacy };
}

describe("managed session Windows durability", () => {
	it("selects writable no-follow binding flags only on win32", () => {
		expect(canonicalBindingOpenFlags("win32")).toBe(syncFs.constants.O_RDWR | syncFs.constants.O_NOFOLLOW);
		for (const platform of ["darwin", "linux", "freebsd"] as const)
			expect(canonicalBindingOpenFlags(platform)).toBe(syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW);
	});

	it("fsyncs a Windows canonical binding through a writable handle without changing its bytes", async () => {
		const root = temporaryDirectory("gjc-binding-fsync-");
		temporaryDirectories.push(root);
		const binding = path.join(root, "binding.json");
		const expected = '{"version":2}\n';
		await fs.writeFile(binding, expected);
		const openSync = syncFs.openSync.bind(syncFs);
		const fsyncSync = syncFs.fsyncSync.bind(syncFs);
		const flags: number[] = [];
		vi.spyOn(syncFs, "openSync").mockImplementation((pathname, flag, mode) => {
			flags.push(flag as number);
			return openSync(pathname, flag, mode);
		});
		vi.spyOn(syncFs, "fsyncSync").mockImplementation(descriptor => {
			if (flags.at(-1) === (syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW)) {
				const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
				throw error;
			}
			return fsyncSync(descriptor);
		});
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			expect(() => fsyncCanonicalBinding(binding, expected)).not.toThrow();
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		expect(flags).toContain(syncFs.constants.O_RDWR | syncFs.constants.O_NOFOLLOW);
		expect(await fs.readFile(binding, "utf8")).toBe(expected);
	});

	it("uses native Windows root metadata, tolerates pi-iso directory metadata drift, and rejects same-size content drift", async () => {
		const root = temporaryDirectory("gjc-native-root-authority-");
		temporaryDirectories.push(root);
		const artifacts = path.join(root, "artifacts");
		const nested = path.join(artifacts, "nested");
		await fs.mkdir(nested, { recursive: true });
		const payload = path.join(nested, "payload.txt");
		await fs.writeFile(payload, "original");
		const stat = syncFs.lstatSync(artifacts, { bigint: true });
		const snapshot = native.snapshotDirectoryTree(artifacts);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error("Native snapshot unavailable");
		const nativeRoot = snapshot.snapshot.entries.find(
			entry => entry.relativePath === "" && entry.kind === "directory",
		);
		if (!nativeRoot) throw new Error("Native root missing");
		const authoritativeSize = (BigInt(nativeRoot.size) + 1n).toString();
		const expectedTree = {
			...snapshot.snapshot,
			entries: snapshot.snapshot.entries.map(entry =>
				entry.relativePath === "" ? { ...entry, size: authoritativeSize } : entry,
			),
		};
		const snapshotDirectoryTree = native.snapshotDirectoryTree;
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname => {
			const observed = snapshotDirectoryTree(pathname);
			if (!observed.ok || !observed.snapshot) return observed;
			return {
				...observed,
				snapshot: {
					...observed.snapshot,
					entries: observed.snapshot.entries.map(entry => {
						if (entry.relativePath === "")
							return { ...entry, size: authoritativeSize, mtimeNs: nativeRoot.mtimeNs };
						if (entry.relativePath === "nested" && entry.kind === "directory")
							return { ...entry, size: "0", mtimeNs: "0", ctimeNs: "0" };
						return entry;
					}),
				},
			};
		});
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: BigInt(authoritativeSize),
			mtimeNs: BigInt(nativeRoot.mtimeNs),
		};
		expect(matchesMigrationArtifactRoot(artifacts, identity, expectedTree, "win32")).toBe(true);
		await fs.writeFile(payload, "modified");
		expect(matchesMigrationArtifactRoot(artifacts, identity, expectedTree, "win32")).toBe(false);
	});

	it("uses native root metadata for cleanup authority on Windows without changing non-Windows checks", async () => {
		const root = temporaryDirectory("gjc-cleanup-authority-root-");
		temporaryDirectories.push(root);
		const retainedPath = path.join(root, "retained");
		await fs.mkdir(retainedPath);
		const originalSnapshotDirectoryTree = native.snapshotDirectoryTree;
		const observed = originalSnapshotDirectoryTree(retainedPath);
		if (!observed.ok || !observed.snapshot) throw new Error("Native snapshot unavailable");
		const nativeRoot = observed.snapshot.entries.find(
			entry => entry.relativePath === "" && entry.kind === "directory",
		);
		if (!nativeRoot) throw new Error("Native root missing");
		const expectedTree: NativeDirectoryTreeSnapshot = {
			...observed.snapshot,
			entries: observed.snapshot.entries.map(entry =>
				entry.relativePath === "" && entry.kind === "directory" ? { ...entry, size: "4096" } : entry,
			),
		};
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname =>
			pathname === retainedPath ? { ok: true, snapshot: expectedTree } : originalSnapshotDirectoryTree(pathname),
		);
		const stat = syncFs.lstatSync(retainedPath, { bigint: true });
		stat.dev = BigInt(nativeRoot.dev);
		stat.ino = BigInt(nativeRoot.ino);
		stat.size = 0n;
		stat.mtimeNs = BigInt(nativeRoot.mtimeNs);
		vi.spyOn(syncFs, "lstatSync").mockReturnValue(stat);
		const parentStat = syncFs.lstatSync(path.dirname(retainedPath), { bigint: true });
		const cleanup = {
			state: "cleanup_pending" as const,
			role: "exchange_placeholder" as const,
			retainedPath,
			identity: {
				dev: BigInt(nativeRoot.dev),
				ino: BigInt(nativeRoot.ino),
				size: 4096n,
				mtimeNs: BigInt(nativeRoot.mtimeNs),
				parentDev: parentStat.dev,
				parentIno: parentStat.ino,
			},
			tree: expectedTree,
		};
		const parent = path.dirname(retainedPath);

		expect(cleanupAuthorityMatches(cleanup, parent, "win32")).toBe(true);
		expect(
			cleanupAuthorityMatches({ ...cleanup, identity: { ...cleanup.identity, size: 4097n } }, parent, "win32"),
		).toBe(false);
		expect(
			cleanupAuthorityMatches(
				{ ...cleanup, identity: { ...cleanup.identity, mtimeNs: cleanup.identity.mtimeNs + 1n } },
				parent,
				"win32",
			),
		).toBe(false);
		expect(
			cleanupAuthorityMatches(
				{ ...cleanup, identity: { ...cleanup.identity, dev: cleanup.identity.dev + 1n } },
				parent,
				"win32",
			),
		).toBe(false);
		expect(cleanupAuthorityMatches(cleanup, path.join(root, "other"), "win32")).toBe(false);
		expect(
			cleanupAuthorityMatches({ ...cleanup, identity: { ...cleanup.identity, size: 0n } }, parent, "darwin"),
		).toBe(true);
	});

	it("forces the win32 producer branch so cleanup identity comes from the native root", async () => {
		const root = temporaryDirectory("gjc-cleanup-producer-");
		temporaryDirectories.push(root);
		const originalPath = path.join(root, "artifacts");
		await fs.mkdir(originalPath);
		await fs.writeFile(path.join(originalPath, "kept.txt"), "kept");

		const tree = native.snapshotDirectoryTree(originalPath);
		if (!tree.ok || !tree.snapshot) throw new Error("Native snapshot unavailable");
		const treeRoot = tree.snapshot.entries.find(entry => entry.relativePath === "" && entry.kind === "directory");
		if (!treeRoot) throw new Error("Native root missing");
		const stat = syncFs.lstatSync(originalPath, { bigint: true });

		// On this host Bun's directory size and the native root size often agree,
		// so a plain run cannot tell the two authorities apart. Inject a size that
		// is guaranteed to differ from the real native root so the assertion below
		// can only pass if the producer reads the mocked native root. Hardcoding
		// 4096 is not hermetic: Linux directory sizes can already be 4096.
		// Reverting the win32 branch makes this test fail.
		const originalSnapshot = native.snapshotDirectoryTree;
		const divergentSize = (BigInt(treeRoot.size) + 1n).toString();
		expect(divergentSize).not.toBe(treeRoot.size);
		// Scope the divergence to the retained placeholder only; the detached
		// original is validated by a separate upstream check that must see real
		// values.
		const placeholderPrefix = ".gjc-exact-unlink-placeholder-";
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname => {
			const actual = originalSnapshot(pathname);
			if (!path.basename(String(pathname)).startsWith(placeholderPrefix)) return actual;
			if (!actual.ok || !actual.snapshot) return actual;
			return {
				...actual,
				snapshot: {
					...actual.snapshot,
					entries: actual.snapshot.entries.map(entry =>
						entry.relativePath === "" && entry.kind === "directory" ? { ...entry, size: divergentSize } : entry,
					),
				},
			};
		});

		const detached = detachArtifactRootForMigration(
			{
				originalPath,
				detachedPath: path.join(root, ".gjc-migrate-fork-artifacts"),
				identity: {
					dev: stat.dev,
					ino: stat.ino,
					size: BigInt(treeRoot.size),
					mtimeNs: BigInt(treeRoot.mtimeNs),
					parentDev: syncFs.lstatSync(path.dirname(originalPath), { bigint: true }).dev,
					parentIno: syncFs.lstatSync(path.dirname(originalPath), { bigint: true }).ino,
				},
				tree: tree.snapshot,
			},
			"win32",
		);

		expect(detached.detachOutcome === "clean" || detached.detachOutcome === "cleanup_pending").toBe(true);
		if (detached.detachOutcome === "cleanup_pending") {
			// Only a native-root read yields the injected divergent size; a
			// Bun-sourced capture would carry the real directory size instead.
			expect(detached.cleanup.identity.size).toBe(BigInt(divergentSize));
			expect(detached.cleanup.identity.size).not.toBe(stat.size);
			expect(cleanupAuthorityMatches(detached.cleanup, root, "win32")).toBe(true);
		}
	});

	it("tolerates a POSIX root ctime change caused by detaching artifacts", async () => {
		const root = temporaryDirectory("gjc-posix-root-ctime-");
		temporaryDirectories.push(root);
		const artifacts = path.join(root, "artifacts");
		await fs.mkdir(artifacts);
		const stat = syncFs.lstatSync(artifacts, { bigint: true });
		const snapshot = native.snapshotDirectoryTree(artifacts);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error("Native snapshot unavailable");
		const snapshotDirectoryTree = native.snapshotDirectoryTree;
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname => {
			const observed = snapshotDirectoryTree(pathname);
			if (!observed.ok || !observed.snapshot) return observed;
			return {
				...observed,
				snapshot: {
					...observed.snapshot,
					entries: observed.snapshot.entries.map(entry =>
						entry.relativePath === "" && entry.kind === "directory"
							? { ...entry, ctimeNs: (BigInt(entry.ctimeNs) + 1n).toString() }
							: entry,
					),
				},
			};
		});
		expect(
			matchesMigrationArtifactRoot(
				artifacts,
				{ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs },
				snapshot.snapshot,
				"darwin",
			),
		).toBe(true);
	});
	it("rejects POSIX nested-directory ctime drift", async () => {
		const root = temporaryDirectory("gjc-posix-directory-ctime-");
		temporaryDirectories.push(root);
		const artifacts = path.join(root, "artifacts");
		await fs.mkdir(path.join(artifacts, "nested"), { recursive: true });
		const stat = syncFs.lstatSync(artifacts, { bigint: true });
		const snapshot = native.snapshotDirectoryTree(artifacts);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error("Native snapshot unavailable");
		const snapshotDirectoryTree = native.snapshotDirectoryTree;
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname => {
			const observed = snapshotDirectoryTree(pathname);
			if (!observed.ok || !observed.snapshot) return observed;
			return {
				...observed,
				snapshot: {
					...observed.snapshot,
					entries: observed.snapshot.entries.map(entry =>
						entry.relativePath === "nested" && entry.kind === "directory"
							? { ...entry, ctimeNs: (BigInt(entry.ctimeNs) + 1n).toString() }
							: entry,
					),
				},
			};
		});
		expect(
			matchesMigrationArtifactRoot(
				artifacts,
				{ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs },
				snapshot.snapshot,
				"darwin",
			),
		).toBe(false);
	});

	it("replays a genuinely clean detached receipt", async () => {
		const interrupted = await interruptedArtifactMigration("clean-detached", "clean");
		const record = JSON.parse(await fs.readFile(interrupted.receipt, "utf8")) as {
			detachOutcome?: unknown;
			sourceArtifactQuarantine?: { detachedPath?: string; tree?: NativeDirectoryTreeSnapshot };
			sourceArtifactCleanup?: unknown;
		};
		expect(record.detachOutcome).toBe("clean");
		expect(record.sourceArtifactCleanup).toBeUndefined();
		vi.restoreAllMocks();
		const detachedPath = record.sourceArtifactQuarantine?.detachedPath;
		const tree = record.sourceArtifactQuarantine?.tree;
		if (!detachedPath || !tree) throw new Error("Missing detached artifact authority");
		const snapshotDirectoryTree = native.snapshotDirectoryTree;
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname =>
			pathname === detachedPath ? { ok: true, snapshot: tree } : snapshotDirectoryTree(pathname),
		);
		const resolved = resolveManagedScope({
			cwd: interrupted.cwd,
			agentDir: interrupted.agentDir,
			sessionsRoot: interrupted.sessionsRoot,
		});
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		const restarted = listManagedCandidates(resolved.scope);
		if (restarted.kind !== "complete") throw new Error("Could not list restarted candidates");
		const legacy = restarted.owned.find(candidate => candidate.provenance === "legacy");
		if (!legacy) throw new Error("Missing restarted legacy candidate");
		expect(() => restorePreparedArtifactRoot(resolved.scope, legacy)).not.toThrow();
		expect((await fs.stat(interrupted.artifacts)).isDirectory()).toBe(true);
	});

	it("reconciles a clean receipt left after restoration before a second restart", async () => {
		const interrupted = await interruptedArtifactMigration("clean-restored-stale-receipt", "clean");
		const record = JSON.parse(await fs.readFile(interrupted.receipt, "utf8")) as {
			sourceArtifactQuarantine?: { detachedPath?: string; tree?: NativeDirectoryTreeSnapshot };
		};
		const detachedPath = record.sourceArtifactQuarantine?.detachedPath;
		const tree = record.sourceArtifactQuarantine?.tree;
		if (!detachedPath || !tree) throw new Error("Missing detached artifact authority");
		vi.restoreAllMocks();
		const snapshotDirectoryTree = native.snapshotDirectoryTree;
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname =>
			pathname === detachedPath || pathname === interrupted.artifacts
				? { ok: true, snapshot: tree }
				: snapshotDirectoryTree(pathname),
		);
		const first = await restartedLegacy(interrupted);
		let restored = false;
		const exactRestore = native.exactRestore;
		vi.spyOn(native, "exactRestore").mockImplementation((...args) => {
			restored = true;
			return exactRestore(...args);
		});
		const unlinkOriginal = syncFs.promises.unlink.bind(syncFs.promises);
		const unlink = vi.spyOn(syncFs.promises, "unlink").mockImplementation(pathname => {
			if (restored) return Promise.reject(new Error("injected unlink failure"));
			return unlinkOriginal(pathname);
		});
		expect(await openManagedCandidateForWrite(first.scope, first.legacy)).toMatchObject({
			kind: "error",
			code: "durability_failed",
		});
		unlink.mockRestore();
		expect((await fs.stat(interrupted.artifacts)).isDirectory()).toBe(true);
		const stale = JSON.parse(await fs.readFile(interrupted.receipt, "utf8")) as {
			detachOutcome?: unknown;
			sourceArtifactQuarantine?: { detachedPath?: string };
		};
		expect(stale.detachOutcome).toBe("clean");
		expect(stale.sourceArtifactQuarantine?.detachedPath).toBeDefined();
		if (stale.sourceArtifactQuarantine?.detachedPath)
			await expect(fs.access(stale.sourceArtifactQuarantine.detachedPath)).rejects.toMatchObject({ code: "ENOENT" });

		const second = await restartedLegacy(interrupted);
		expect(await openManagedCandidateForWrite(second.scope, second.legacy)).toMatchObject({ kind: "opened" });
	});

	it("fails closed when a clean receipt's original artifact root was replaced", async () => {
		const interrupted = await interruptedArtifactMigration("clean-replaced-root", "clean");
		vi.restoreAllMocks();
		await fs.mkdir(interrupted.artifacts);
		await fs.writeFile(path.join(interrupted.artifacts, "foreign.txt"), "foreign");
		const restarted = await restartedLegacy(interrupted);
		expect(() => restorePreparedArtifactRoot(restarted.scope, restarted.legacy)).toThrow("durability_failed");
	});

	it("fails closed when clean or cleanup-pending receipts omit detachOutcome", async () => {
		for (const detachOutcome of ["clean", "cleanup_pending"] as const) {
			const interrupted = await interruptedArtifactMigration(
				`missing-detach-outcome-${detachOutcome}`,
				detachOutcome,
			);
			const record = JSON.parse(await fs.readFile(interrupted.receipt, "utf8")) as Record<string, unknown>;
			delete record.detachOutcome;
			await fs.writeFile(interrupted.receipt, `${JSON.stringify(record)}\n`);
			vi.restoreAllMocks();
			const restarted = await restartedLegacy(interrupted);
			expect(() => restorePreparedArtifactRoot(restarted.scope, restarted.legacy)).toThrow("durability_failed");
		}
	});

	it("fails closed when cleanup authority is deleted from a cleanup-pending receipt", async () => {
		const interrupted = await interruptedArtifactMigration("deleted-cleanup-authority", "cleanup_pending");
		const record = JSON.parse(await fs.readFile(interrupted.receipt, "utf8")) as Record<string, unknown>;
		expect(record.detachOutcome).toBe("cleanup_pending");
		delete record.sourceArtifactCleanup;
		await fs.writeFile(interrupted.receipt, `${JSON.stringify(record)}\n`);
		vi.restoreAllMocks();
		const resolved = resolveManagedScope({
			cwd: interrupted.cwd,
			agentDir: interrupted.agentDir,
			sessionsRoot: interrupted.sessionsRoot,
		});
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		const restarted = listManagedCandidates(resolved.scope);
		if (restarted.kind !== "complete") throw new Error("Could not list restarted candidates");
		const legacy = restarted.owned.find(candidate => candidate.provenance === "legacy");
		if (!legacy) throw new Error("Missing restarted legacy candidate");
		expect(() => restorePreparedArtifactRoot(resolved.scope, legacy)).toThrow("durability_failed");
	});
});
