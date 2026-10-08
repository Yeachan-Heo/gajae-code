import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	type ManagedGcSessionRetirementReceipt,
	type ManagedGcSessionRetirementTarget,
	managedGcRetirementIdentityRecord,
} from "../src/session/internal/managed-gc-retirement-codec";
import {
	bindManagedGcSessionRetirementTarget,
	cleanupAuthorityMatches,
	computeManagedScopeDigest,
	deleteManagedSessionCandidate,
	discoverManagedGcSessionRetirementReceipts,
	listManagedCandidates,
	type ManagedGcProtocolScopeInput,
	type ManagedScope,
	ManagedSessionScopeTestHooks,
	managedDirectoryAuthorityForScope,
	managedDirectoryIdentityForScope,
	managedGcProtocolInspectorForLock,
	managedGcProtocolScopeInspectorForScope,
	prepareManagedSessionScopeForWriteSync,
	publishManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceiptReadOnly,
	reconcileManagedTombstones,
	resolveManagedGcScopeForRead,
	resolveManagedScopeForWrite,
	taskArtifactOwnerStorageContextForScope,
} from "../src/session/internal/managed-session-scope";
import {
	acquireManagedLock,
	captureManagedFileNoFollow,
	captureManagedFileNoFollowBounded,
	MANAGED_ARTIFACT_MAX_FILES,
	MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
	MANAGED_SESSION_READ_RANGE_MAX_BYTES,
	type ManagedFileIdentity,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	newSessionRootStore,
} from "../src/session/internal/task-artifact-owner-access";
import { hasSiblingTaskArtifactOwnerTranscript } from "../src/session/internal/task-artifact-owner-transcript";
import { FileSessionStorage } from "../src/session/session-storage";
import {
	immutableDeletionEvidence,
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerAbsolutePath,
	ownerIdForSession,
	ownerRelativePath,
	parseTaskArtifactOwnerLocator,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerRetirementContinuation,
} from "../src/session/task-artifact-owner-codec";
import {
	retireTaskArtifactOwner,
	verifyTaskArtifactOwnerPhysicalRetirement,
	verifyTaskArtifactOwnerRetirementContinuation,
} from "../src/session/task-artifact-owner-retirement";

interface Fixture {
	readonly temporaryRoot: string;
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly cwd: string;
	readonly scope: ManagedScope;
	readonly transcriptPath: string;
	readonly target: ManagedGcSessionRetirementTarget;
	readonly evidence: TaskArtifactOwnerDeletionEvidence;
	readonly largeOwnerTreeMarker?: string;
}

const temporaryRoots: string[] = [];
const MANAGED_GC_SCOPE_LOCK_NAME = `gc-retirement-${crypto
	.createHash("sha256")
	.update("managed-gc-retirement-scope-lock-v1", "utf8")
	.digest("hex")}`;

afterEach(() => {
	vi.restoreAllMocks();
	ManagedSessionScopeTestHooks.beforeVerifiedDelete = undefined;
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded exchange-placeholder cleanup authority", () => {
	it("rejects a foreign child without changing its bytes or inode", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-gc-empty-placeholder-"));
		temporaryRoots.push(root);
		const parent = path.join(root, "parent");
		const retainedPath = path.join(parent, ".gjc-exact-unlink-placeholder-test");
		fs.mkdirSync(parent);
		fs.mkdirSync(retainedPath);
		const issued = native.snapshotEmptyDirectory(retainedPath);
		if (!issued.ok || !issued.snapshot || issued.snapshot.entries.length !== 1)
			throw new Error("native_empty_placeholder_snapshot_missing");
		const nativeRoot = issued.snapshot.entries[0];
		if (!nativeRoot) throw new Error("native_empty_placeholder_root_missing");
		const parentStat = fs.lstatSync(parent, { bigint: true });
		const cleanup = {
			state: "cleanup_pending" as const,
			role: "exchange_placeholder" as const,
			retainedPath,
			identity: {
				dev: BigInt(nativeRoot.dev),
				ino: BigInt(nativeRoot.ino),
				size: BigInt(nativeRoot.size),
				mtimeNs: BigInt(nativeRoot.mtimeNs),
				parentDev: parentStat.dev,
				parentIno: parentStat.ino,
			},
			tree: issued.snapshot,
		};
		expect(cleanupAuthorityMatches(cleanup, parent)).toBe(true);

		const foreignPath = path.join(retainedPath, "foreign-payload");
		const foreignBytes = Buffer.alloc(256 * 1024, 0xa7);
		fs.writeFileSync(foreignPath, foreignBytes);
		const before = fs.lstatSync(foreignPath, { bigint: true });
		expect(cleanupAuthorityMatches(cleanup, parent)).toBe(false);
		expect(fs.readFileSync(foreignPath)).toEqual(foreignBytes);
		const after = fs.lstatSync(foreignPath, { bigint: true });
		expect(after.dev).toBe(before.dev);
		expect(after.ino).toBe(before.ino);
		expect(after.size).toBe(before.size);
		expect(after.mtimeNs).toBe(before.mtimeNs);
	});

	it("rejects a replaced empty path against the original native root identity", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-gc-empty-placeholder-"));
		temporaryRoots.push(root);
		const parent = path.join(root, "parent");
		const retainedPath = path.join(parent, ".gjc-exact-unlink-placeholder-test");
		const displacedPath = path.join(parent, ".displaced-placeholder");
		fs.mkdirSync(parent);
		fs.mkdirSync(retainedPath);
		const issued = native.snapshotEmptyDirectory(retainedPath);
		if (!issued.ok || !issued.snapshot || issued.snapshot.entries.length !== 1)
			throw new Error("native_empty_placeholder_snapshot_missing");
		const nativeRoot = issued.snapshot.entries[0];
		if (!nativeRoot) throw new Error("native_empty_placeholder_root_missing");
		const parentStat = fs.lstatSync(parent, { bigint: true });
		const cleanup = {
			state: "cleanup_pending" as const,
			role: "exchange_placeholder" as const,
			retainedPath,
			identity: {
				dev: BigInt(nativeRoot.dev),
				ino: BigInt(nativeRoot.ino),
				size: BigInt(nativeRoot.size),
				mtimeNs: BigInt(nativeRoot.mtimeNs),
				parentDev: parentStat.dev,
				parentIno: parentStat.ino,
			},
			tree: issued.snapshot,
		};
		const originalBefore = fs.lstatSync(retainedPath, { bigint: true });
		fs.renameSync(retainedPath, displacedPath);
		fs.mkdirSync(retainedPath);
		const replacementBefore = fs.lstatSync(retainedPath, { bigint: true });

		expect(cleanupAuthorityMatches(cleanup, parent)).toBe(false);
		const replacementAfter = fs.lstatSync(retainedPath, { bigint: true });
		expect(replacementAfter.dev).toBe(replacementBefore.dev);
		expect(replacementAfter.ino).toBe(replacementBefore.ino);
		expect(fs.readdirSync(retainedPath)).toEqual([]);
		const displaced = fs.lstatSync(displacedPath, { bigint: true });
		expect([displaced.dev, displaced.ino, displaced.size, displaced.mtimeNs]).toEqual([
			originalBefore.dev,
			originalBefore.ino,
			originalBefore.size,
			originalBefore.mtimeNs,
		]);
		expect(fs.readdirSync(displacedPath)).toEqual([]);
	});
});

describe("owner-aware data cannot bypass live consumer authority", () => {
	it("refuses a v4 owner patch with an unauthenticated reserved protocol alias before deleting artifacts", async () => {
		const fixture = makeFixture();
		const locator = fixture.evidence.locator;
		await Bun.write(
			fixture.transcriptPath,
			`${JSON.stringify({ type: "session", version: 4, id: fixture.target.sessionId, cwd: fixture.cwd })}\n${JSON.stringify({ type: "header_patch", patch: { taskArtifactOwner: locator } })}\n`,
		);
		const listed = listManagedCandidates(fixture.scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
		if (!candidate) throw new Error("owner_candidate_missing");
		const artifactRoot = fixture.transcriptPath.slice(0, -6);
		fs.mkdirSync(artifactRoot, { mode: 0o700 });
		await Bun.write(path.join(artifactRoot, "retained.txt"), "retained artifact");
		fs.mkdirSync(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal.saved"), { mode: 0o700 });
		const before = fs.readFileSync(fixture.transcriptPath);
		const artifactsBefore = protocolFilesystemSnapshot(artifactRoot);
		const ownerRoot = path.join(fixture.sessionsRoot, ownerRelativePath(fixture.evidence.locator.ownerId));
		const ownerBefore = protocolFilesystemSnapshot(ownerRoot);
		const unlink = vi.spyOn(native, "exactUnlink");
		const removal = vi.spyOn(native, "exactRemoveDirectoryTree");
		const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
		expect(result).toMatchObject({
			kind: "cleanup_pending",
			phase: "artifacts",
			message: "task_artifact_owner_shared_with_sibling_transcript",
		});
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(before);
		expect(fs.readFileSync(path.join(artifactRoot, "retained.txt"), "utf8")).toBe("retained artifact");
		expect(protocolFilesystemSnapshot(artifactRoot)).toEqual(artifactsBefore);
		expect(protocolFilesystemSnapshot(ownerRoot)).toEqual(ownerBefore);
		// Journal reads/preparation may release their own identity-fenced lease, never payloads.
		const journalLock = path.join(
			fixture.scope.directoryPath,
			".gjc-managed-session-internal/locks",
			`${MANAGED_GC_SCOPE_LOCK_NAME}.lock`,
		);
		for (const [pathname, identity] of unlink.mock.calls) {
			expect(pathname).toBe(journalLock);
			expect(identity.quarantineName).toMatch(
				/^\.gjc-lock-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.stale$/u,
			);
			expect(identity.sha256).toMatch(/^[0-9a-f]{64}$/u);
			expect(identity.dev).toBeGreaterThan(0n);
			expect(identity.ino).toBeGreaterThan(0n);
		}
		expect(removal).toHaveBeenCalledTimes(0);
	});

	it("rechecks owner header patches at the immediate deletion fence", async () => {
		const fixture = makeFixture();
		const header = `${JSON.stringify({ type: "session", version: 4, id: fixture.target.sessionId, cwd: fixture.cwd })}\n`;
		await Bun.write(fixture.transcriptPath, header);
		const listed = listManagedCandidates(fixture.scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
		if (!candidate) throw new Error("owner_candidate_missing");
		const storage = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
		ManagedSessionScopeTestHooks.beforeVerifiedDelete = async () => {
			await Bun.write(
				fixture.transcriptPath,
				`${header}${JSON.stringify({ type: "header_patch", patch: { taskArtifactOwner: fixture.evidence.locator } })}\n`,
			);
		};
		const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
		expect(result).toMatchObject({ kind: "error", message: "task_artifact_owner_locator_missing" });
		expect(storage).toHaveBeenCalledTimes(0);
		expect(fs.readFileSync(fixture.transcriptPath, "utf8")).toContain("header_patch");
	});

	it("refuses malformed owner claims instead of treating the tombstone as absent", async () => {
		for (const ownerValue of [null, { sessionId: "foreign" }]) {
			const fixture = makeFixture();
			const listed = listManagedCandidates(fixture.scope);
			if (listed.kind !== "complete") throw new Error(listed.message);
			const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
			if (!candidate) throw new Error("owner_candidate_missing");
			const tombstone = path.join(
				fixture.scope.directoryPath,
				".gjc-managed-session-internal/tombstones",
				`${"b".repeat(64)}.json`,
			);
			await Bun.write(
				tombstone,
				JSON.stringify(
					{
						schemaVersion: 2,
						state: "retired",
						scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
						targets: [{ ...candidate, taskArtifactOwnerDeletionEvidence: ownerValue }],
					},
					(_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
				),
			);
			fs.chmodSync(tombstone, 0o600);
			const before = fs.readFileSync(fixture.transcriptPath);
			const storage = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
			await expect(reconcileManagedTombstones(fixture.scope)).rejects.toThrow(
				"task_artifact_owner_legacy_scope_unsupported",
			);
			expect(storage).toHaveBeenCalledTimes(0);
			expect(fs.readFileSync(fixture.transcriptPath)).toEqual(before);
			storage.mockRestore();
		}
	});

	it("refuses owner tombstone retirement even when the canonical transcript is absent", async () => {
		const fixture = makeFixture();
		const listed = listManagedCandidates(fixture.scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
		if (!candidate) throw new Error("owner_candidate_missing");
		const store = openScopeStore(fixture.scope);
		const name = `${"a".repeat(64)}.json`;
		try {
			store.publishNoReplaceSync(
				`.gjc-managed-session-internal/tombstones/${name}`,
				Buffer.from(
					JSON.stringify(
						{
							schemaVersion: 2,
							state: "retired",
							scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
							targets: [{ ...candidate, taskArtifactOwnerDeletionEvidence: fixture.evidence }],
						},
						(_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
					),
				),
			);
		} finally {
			store.close();
		}
		fs.unlinkSync(fixture.transcriptPath);
		const ownerPayload = path.join(
			fixture.sessionsRoot,
			ownerRelativePath(fixture.evidence.locator.ownerId),
			"payload.json",
		);
		const before = fs.readFileSync(ownerPayload);
		const unlink = vi.spyOn(native, "exactUnlink");
		const removal = vi.spyOn(native, "exactRemoveDirectoryTree");
		await expect(reconcileManagedTombstones(fixture.scope)).rejects.toThrow(
			"task_artifact_owner_continuation_state_missing",
		);
		expect(fs.readFileSync(ownerPayload)).toEqual(before);
		expect(
			fs.readdirSync(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal/tombstones")),
		).toEqual([name]);
		// Journal reads/preparation may release their own identity-fenced lease, never payloads.
		const journalLock = path.join(
			fixture.scope.directoryPath,
			".gjc-managed-session-internal/locks",
			`${MANAGED_GC_SCOPE_LOCK_NAME}.lock`,
		);
		for (const [pathname, identity] of unlink.mock.calls) {
			expect(pathname).toBe(journalLock);
			expect(identity.quarantineName).toMatch(
				/^\.gjc-lock-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.stale$/u,
			);
			expect(identity.sha256).toMatch(/^[0-9a-f]{64}$/u);
			expect(identity.dev).toBeGreaterThan(0n);
			expect(identity.ino).toBeGreaterThan(0n);
		}
		expect(removal).toHaveBeenCalledTimes(0);
	});
});

function protocolInputFor(scope: ManagedScope): ManagedGcProtocolScopeInput {
	const scopeStat = fs.lstatSync(scope.directoryPath, { bigint: true });
	const bindingPath = path.join(scope.directoryPath, ".gjc-managed-session-scope.v2.json");
	const binding = captureManagedFileNoFollow(bindingPath);
	const bindingStat = fs.lstatSync(bindingPath, { bigint: true });
	const protocolPath = path.join(scope.directoryPath, ".gjc-managed-session-internal");
	const protocolStat = fs.lstatSync(protocolPath, { bigint: true });
	return {
		scopePath: scope.directoryPath,
		scopeIdentity: { path: scope.directoryPath, dev: scopeStat.dev.toString(), ino: scopeStat.ino.toString() },
		bindingIdentity: {
			name: path.basename(bindingPath),
			dev: binding.identity.dev.toString(),
			ino: binding.identity.ino.toString(),
			nlink: binding.identity.nlink.toString(),
			size: binding.identity.size,
			mtimeNs: binding.identity.mtimeNs.toString(),
			ctimeNs: binding.identity.ctimeNs.toString(),
			mode: Number(bindingStat.mode & 0o777n),
			sha256: binding.identity.sha256,
		},
		protocolIdentity: {
			path: protocolPath,
			dev: protocolStat.dev.toString(),
			ino: protocolStat.ino.toString(),
			mtimeNs: protocolStat.mtimeNs.toString(),
			ctimeNs: protocolStat.ctimeNs.toString(),
			mode: Number(protocolStat.mode & 0o777n),
		},
	};
}

function protocolFilesystemSnapshot(root: string): unknown[] {
	const entries: unknown[] = [];
	const visit = (pathname: string): void => {
		const stat = fs.lstatSync(pathname, { bigint: true });
		entries.push({
			path: pathname,
			dev: String(stat.dev),
			ino: String(stat.ino),
			mode: String(stat.mode),
			mtimeNs: String(stat.mtimeNs),
			ctimeNs: String(stat.ctimeNs),
			size: String(stat.size),
			hash: stat.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(pathname)).digest("hex") : undefined,
		});
		if (stat.isDirectory() && !stat.isSymbolicLink())
			for (const name of fs.readdirSync(pathname).sort()) visit(path.join(pathname, name));
	};
	visit(root);
	return entries;
}

describe("independent async owner sibling inventories", () => {
	it("requires a trusted inspector when managed protocol roles are present", async () => {
		const fixture = makeFixture();
		const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
		const before = protocolFilesystemSnapshot(fixture.temporaryRoot);
		expect(
			await hasSiblingTaskArtifactOwnerTranscript(
				new FileSessionStorage(),
				fixture.transcriptPath,
				fixture.evidence.locator,
				context,
			),
		).toBe(true);
		expect(
			await hasSiblingTaskArtifactOwnerTranscript(
				new FileSessionStorage(),
				fixture.transcriptPath,
				fixture.evidence.locator,
				context,
				managedGcProtocolScopeInspectorForScope(fixture.scope),
			),
		).toBe(false);
		expect(protocolFilesystemSnapshot(fixture.temporaryRoot)).toEqual(before);
	});

	it("finds a shared owner in another managed cwd's v4 header patch", async () => {
		const fixture = makeFixture();
		const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
		const otherCwd = path.join(fixture.temporaryRoot, "other-scanner-cwd");
		fs.mkdirSync(otherCwd, { mode: 0o700 });
		const other = makeScope(fixture.agentDir, fixture.sessionsRoot, otherCwd);
		await Bun.write(
			path.join(other.directoryPath, "shared.jsonl"),
			`${JSON.stringify({ type: "session", version: 4, id: fixture.target.sessionId, cwd: otherCwd })}\n${JSON.stringify({ type: "header_patch", patch: { taskArtifactOwner: fixture.evidence.locator } })}\n`,
			{ mode: 0o600 },
		);
		const before = protocolFilesystemSnapshot(fixture.temporaryRoot);
		expect(
			await hasSiblingTaskArtifactOwnerTranscript(
				new FileSessionStorage(),
				fixture.transcriptPath,
				fixture.evidence.locator,
				context,
				managedGcProtocolScopeInspectorForScope(fixture.scope),
			),
		).toBe(true);
		expect(protocolFilesystemSnapshot(fixture.temporaryRoot)).toEqual(before);
	});

	it("blocks reserved protocol aliases without filesystem effects", async () => {
		const fixture = makeFixture();
		const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
		fs.mkdirSync(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal.saved"), { mode: 0o700 });
		const before = protocolFilesystemSnapshot(fixture.temporaryRoot);
		expect(
			await hasSiblingTaskArtifactOwnerTranscript(
				new FileSessionStorage(),
				fixture.transcriptPath,
				fixture.evidence.locator,
				context,
				managedGcProtocolScopeInspectorForScope(fixture.scope),
			),
		).toBe(true);
		expect(protocolFilesystemSnapshot(fixture.temporaryRoot)).toEqual(before);
	});
});

describe("independent authenticated protocol inventories", () => {
	it("reads a real prepared journal and active lease without filesystem mutation", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
		const lock = await acquireManagedLock(
			path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal/locks"),
			crypto.createHash("sha256").update(fixture.cwd).digest("hex"),
			context.rootAuthority,
			context.securityPolicy,
		);
		const open = spyOn(native, "openRecoveryFsRoot");
		const retain = spyOn(native.RecoveryFsRoot.prototype, "retainManagedDirectory");
		try {
			const inspect = managedGcProtocolInspectorForLock(fixture.scope, lock);
			const before = protocolFilesystemSnapshot(fixture.temporaryRoot);
			const snapshots = await inspect([protocolInputFor(fixture.scope)]);
			expect(snapshots).toHaveLength(1);
			expect(
				snapshots[0]?.directories
					.find(value => value.role === "receipts")
					?.files.some(value => value.name.startsWith("gc-retirement-")),
			).toBe(true);
			expect(
				snapshots[0]?.directories
					.find(value => value.role === "locks")
					?.files.some(value => value.name.endsWith(".lock")),
			).toBe(true);
			expect(protocolFilesystemSnapshot(fixture.temporaryRoot)).toEqual(before);
			expect(open).not.toHaveBeenCalled();
			expect(retain).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			retain.mockRestore();
			await lock.release();
		}
	});

	it("refuses unknown or symlink protocol entries without repair", async () => {
		for (const symlink of [false, true]) {
			const fixture = makeFixture();
			const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
			const unknown = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal/receipts/foreign.json");
			if (symlink) fs.symlinkSync(fixture.transcriptPath, unknown);
			else {
				await Bun.write(unknown, "{}");
				fs.chmodSync(unknown, 0o600);
			}
			const before = protocolFilesystemSnapshot(fixture.temporaryRoot);
			await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow();
			expect(protocolFilesystemSnapshot(fixture.temporaryRoot)).toEqual(before);
		}
	});

	it("rejects a substituted protocol root captured after factory binding", async () => {
		const fixture = makeFixture();
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		const protocol = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal");
		fs.renameSync(protocol, `${protocol}.saved`);
		fs.mkdirSync(protocol, { mode: 0o700 });
		for (const role of ["locks", "receipts", "tombstones"]) fs.mkdirSync(path.join(protocol, role), { mode: 0o700 });
		const before = protocolFilesystemSnapshot(fixture.temporaryRoot);
		await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow();
		expect(protocolFilesystemSnapshot(fixture.temporaryRoot)).toEqual(before);
	});
});

function makeScope(agentDir: string, sessionsRoot: string, cwd: string): ManagedScope {
	const result = resolveManagedScopeForWrite({ agentDir, sessionsRoot, cwd });
	if (result.kind !== "resolved") throw new Error(`fixture_scope_resolution_failed:${result.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(result.scope);
	if (prepared.kind !== "resolved") throw new Error(`fixture_scope_prepare_failed:${prepared.code}`);
	return prepared.scope;
}

function openScopeStore(scope: ManagedScope): ManagedSessionDescendantStore {
	const context = taskArtifactOwnerStorageContextForScope(scope);
	const identity = managedDirectoryIdentityForScope(scope);
	return new ManagedSessionDescendantStore(
		context.rootAuthority,
		scope.directoryPath,
		undefined,
		context.securityPolicy,
		context.profileAgentDir,
		{
			canonicalPath: scope.directoryPath,
			dev: BigInt.asUintN(64, identity.dev),
			ino: BigInt.asUintN(64, identity.ino),
		},
	);
}

const LARGE_OWNER_TREE_DIRECTORY_NAME = "d".repeat(200);
const LARGE_OWNER_TREE_FILLER_FILE_COUNT = 49_996;

function largeOwnerTreeFileName(index: number): string {
	return `${String(index).padStart(5, "0")}${"a".repeat(250)}`;
}

function makeFixture(
	sessionId = "managed-gc-journal-fixture",
	transcriptFileName = "fixture.jsonl",
	expandOwnerTree = false,
): Fixture {
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-gc-retirement-journal-"));
	temporaryRoots.push(temporaryRoot);
	const agentDir = path.join(temporaryRoot, "profile");
	const sessionsRoot = path.join(agentDir, "sessions");
	const cwd = path.join(temporaryRoot, "cwd");
	fs.mkdirSync(sessionsRoot, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	const scope = makeScope(agentDir, sessionsRoot, cwd);
	const ownerContext = taskArtifactOwnerStorageContextForScope(scope);
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = newSessionRootStore(ownerContext);
	let locator: TaskArtifactOwnerLocator | undefined;
	try {
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const ownerDirectory = rootStore.ensureDirectory(ownerRelativePath(ownerId));
		locator = parseTaskArtifactOwnerLocator({
			schemaVersion: OWNER_SCHEMA_VERSION,
			ownerId,
			directoryDev: ownerDirectory.dev.toString(),
			directoryIno: ownerDirectory.ino.toString(),
		});
		if (!locator) throw new Error("fixture_owner_locator_missing");
		const ownerStore = rootStore.deriveSubtree(ownerRelativePath(ownerId));
		try {
			ownerStore.publishNoReplaceSync(
				OWNER_MANIFEST,
				Buffer.from(
					JSON.stringify({
						schemaVersion: OWNER_SCHEMA_VERSION,
						ownerId,
						directoryDev: locator.directoryDev,
						directoryIno: locator.directoryIno,
						sessionId,
					}),
					"utf8",
				),
			);
			ownerStore.publishNoReplaceSync("payload.json", Buffer.from("fixture payload", "utf8"));
		} finally {
			ownerStore.close();
		}
	} finally {
		rootStore.close();
	}
	if (!locator) throw new Error("fixture_owner_locator_missing");
	const largeOwnerTreeMarker = expandOwnerTree
		? `${LARGE_OWNER_TREE_DIRECTORY_NAME}/${largeOwnerTreeFileName(LARGE_OWNER_TREE_FILLER_FILE_COUNT - 1)}`
		: undefined;
	if (expandOwnerTree) {
		const ownerDirectory = ownerAbsolutePath(ownerContext, ownerId);
		const fillerDirectory = path.join(ownerDirectory, LARGE_OWNER_TREE_DIRECTORY_NAME);
		fs.mkdirSync(fillerDirectory, { mode: 0o700 });
		for (let index = 0; index < LARGE_OWNER_TREE_FILLER_FILE_COUNT; index++)
			fs.writeFileSync(path.join(fillerDirectory, largeOwnerTreeFileName(index)), "", { flag: "wx", mode: 0o600 });
	}
	const transcriptPath = path.join(scope.directoryPath, transcriptFileName);
	const transcriptStore = openScopeStore(scope);
	try {
		transcriptStore.publishNoReplaceSync(
			transcriptFileName,
			Buffer.from(
				`${JSON.stringify({
					type: "session",
					id: sessionId,
					cwd,
					version: 3,
					taskArtifactOwner: locator,
				})}\n`,
				"utf8",
			),
		);
	} finally {
		transcriptStore.close();
	}
	const target = bindManagedGcSessionRetirementTarget(scope, transcriptPath);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(ownerContext, sessionId, locator);
	if (!evidence) throw new Error("fixture_owner_evidence_missing");
	return {
		temporaryRoot,
		agentDir,
		sessionsRoot,
		cwd,
		scope,
		transcriptPath,
		target,
		evidence,
		...(largeOwnerTreeMarker ? { largeOwnerTreeMarker } : {}),
	};
}

function makeSiblingFixture(parent: Fixture, sessionId: string): Fixture {
	const cwd = path.join(parent.temporaryRoot, `${sessionId}-cwd`);
	fs.mkdirSync(cwd, { mode: 0o700 });
	const scope = makeScope(parent.agentDir, parent.sessionsRoot, cwd);
	const ownerContext = taskArtifactOwnerStorageContextForScope(scope);
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = newSessionRootStore(ownerContext);
	let locator: TaskArtifactOwnerLocator | undefined;
	try {
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const directory = rootStore.ensureDirectory(ownerRelativePath(ownerId));
		locator = parseTaskArtifactOwnerLocator({
			schemaVersion: OWNER_SCHEMA_VERSION,
			ownerId,
			directoryDev: directory.dev.toString(),
			directoryIno: directory.ino.toString(),
		});
		if (!locator) throw new Error("fixture_sibling_owner_locator_missing");
		const ownerStore = rootStore.deriveSubtree(ownerRelativePath(ownerId));
		try {
			ownerStore.publishNoReplaceSync(
				OWNER_MANIFEST,
				Buffer.from(
					JSON.stringify({
						schemaVersion: OWNER_SCHEMA_VERSION,
						ownerId,
						directoryDev: locator.directoryDev,
						directoryIno: locator.directoryIno,
						sessionId,
					}),
					"utf8",
				),
			);
			ownerStore.publishNoReplaceSync("payload.json", Buffer.from("sibling payload", "utf8"));
		} finally {
			ownerStore.close();
		}
	} finally {
		rootStore.close();
	}
	if (!locator) throw new Error("fixture_sibling_owner_locator_missing");
	const transcriptPath = path.join(scope.directoryPath, "sibling.jsonl");
	const transcriptStore = openScopeStore(scope);
	try {
		transcriptStore.publishNoReplaceSync(
			"sibling.jsonl",
			Buffer.from(
				`${JSON.stringify({ type: "session", id: sessionId, cwd, version: 3, taskArtifactOwner: locator })}\n`,
			),
		);
	} finally {
		transcriptStore.close();
	}
	const target = bindManagedGcSessionRetirementTarget(scope, transcriptPath);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(ownerContext, sessionId, locator);
	if (!evidence) throw new Error("fixture_sibling_owner_evidence_missing");
	return {
		temporaryRoot: parent.temporaryRoot,
		agentDir: parent.agentDir,
		sessionsRoot: parent.sessionsRoot,
		cwd,
		scope,
		transcriptPath,
		target,
		evidence,
	};
}

function makeTargetFixtureInScope(parent: Fixture, scope: ManagedScope, sessionId: string, filename: string): Fixture {
	const cwd = scope.canonicalCwd;
	const ownerContext = taskArtifactOwnerStorageContextForScope(scope);
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = newSessionRootStore(ownerContext);
	let locator: TaskArtifactOwnerLocator | undefined;
	try {
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const directory = rootStore.ensureDirectory(ownerRelativePath(ownerId));
		locator = parseTaskArtifactOwnerLocator({
			schemaVersion: OWNER_SCHEMA_VERSION,
			ownerId,
			directoryDev: directory.dev.toString(),
			directoryIno: directory.ino.toString(),
		});
		if (!locator) throw new Error("fixture_late_owner_locator_missing");
		const ownerStore = rootStore.deriveSubtree(ownerRelativePath(ownerId));
		try {
			ownerStore.publishNoReplaceSync(
				OWNER_MANIFEST,
				Buffer.from(
					JSON.stringify({
						schemaVersion: OWNER_SCHEMA_VERSION,
						ownerId,
						directoryDev: locator.directoryDev,
						directoryIno: locator.directoryIno,
						sessionId,
					}),
					"utf8",
				),
			);
			ownerStore.publishNoReplaceSync("payload.json", Buffer.from("late owner payload", "utf8"));
		} finally {
			ownerStore.close();
		}
	} finally {
		rootStore.close();
	}
	if (!locator) throw new Error("fixture_late_owner_locator_missing");
	const transcriptPath = path.join(scope.directoryPath, filename);
	const transcriptStore = openScopeStore(scope);
	try {
		transcriptStore.publishNoReplaceSync(
			filename,
			Buffer.from(
				`${JSON.stringify({ type: "session", id: sessionId, cwd, version: 3, taskArtifactOwner: locator })}\n`,
			),
		);
	} finally {
		transcriptStore.close();
	}
	const target = bindManagedGcSessionRetirementTarget(scope, transcriptPath);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(ownerContext, sessionId, locator);
	if (!evidence) throw new Error("fixture_late_owner_evidence_missing");
	return {
		temporaryRoot: parent.temporaryRoot,
		agentDir: parent.agentDir,
		sessionsRoot: parent.sessionsRoot,
		cwd,
		scope,
		transcriptPath,
		target,
		evidence,
	};
}

function preparedReceipt(fixture: Fixture): ManagedGcSessionRetirementReceipt {
	return {
		...fixture.target,
		state: "prepared",
		taskArtifactOwnerDeletionEvidence: fixture.evidence,
	};
}

function preparedReceiptRecordForMeasurement(fixture: Fixture): Record<string, unknown> {
	return {
		schemaVersion: 1,
		state: "prepared",
		scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
		transcriptPath: fixture.target.transcriptPath,
		sessionId: fixture.target.sessionId,
		cwd: fixture.target.cwd,
		transcriptIdentity: managedGcRetirementIdentityRecord(fixture.target.transcriptIdentity),
		taskArtifactOwnerDeletionEvidence: fixture.evidence,
	};
}

function preparedReceiptLineByteLength(fixture: Fixture): number {
	return Buffer.byteLength(
		`${JSON.stringify(preparedReceiptRecordForMeasurement(fixture), (_key, value: unknown) =>
			typeof value === "bigint" ? value.toString() : value,
		)}\n`,
		"utf8",
	);
}

function exactLimitSessionId(
	fixture: Fixture,
	transcriptFileName: string,
	recordBytes = preparedReceiptLineByteLength(fixture),
): string | undefined {
	const pathByteDelta =
		Buffer.byteLength(transcriptFileName, "utf8") - Buffer.byteLength(path.basename(fixture.transcriptPath), "utf8");
	const manifest = fixture.evidence.treeSnapshot.entries.find(entry => entry.relativePath === OWNER_MANIFEST);
	if (!manifest) throw new Error("fixture_owner_manifest_snapshot_missing");
	const baseManifestSize = BigInt(manifest.size);
	const baseTranscriptSize = fixture.target.transcriptIdentity.size;
	const prefix = '\n"\\\u0001é😀\ud800';
	const encodedContentBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
	const addedPrefixBytes = encodedContentBytes(prefix) - encodedContentBytes(fixture.target.sessionId);
	const sizeForPadding = (padding: number): number => {
		const delta = addedPrefixBytes + padding;
		const transcriptSize = baseTranscriptSize + delta;
		const manifestSize = baseManifestSize + BigInt(delta);
		return (
			recordBytes +
			pathByteDelta +
			2 * delta +
			String(transcriptSize).length -
			String(baseTranscriptSize).length +
			manifestSize.toString().length -
			baseManifestSize.toString().length
		);
	};
	let low = 0;
	let high = MANAGED_SESSION_READ_RANGE_MAX_BYTES;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (sizeForPadding(middle) <= MANAGED_SESSION_READ_RANGE_MAX_BYTES) low = middle;
		else high = middle - 1;
	}
	for (let padding = Math.max(0, low - 4); padding <= low + 4; padding++) {
		if (sizeForPadding(padding) === MANAGED_SESSION_READ_RANGE_MAX_BYTES) return `${prefix}${"a".repeat(padding)}`;
	}
	return undefined;
}

function uncertainContinuation(fixture: Fixture): TaskArtifactOwnerRetirementContinuation {
	return {
		schemaVersion: 1,
		parentIdentity: fixture.evidence.parentIdentity,
		retainedRootPath: ownerAbsolutePath(
			taskArtifactOwnerStorageContextForScope(fixture.scope),
			fixture.target.taskArtifactOwnerLocator.ownerId,
		),
		retainedTreeSnapshot: fixture.evidence.treeSnapshot,
	};
}

function pendingReceipt(fixture: Fixture, reason: string): ManagedGcSessionRetirementReceipt {
	const continuation = uncertainContinuation(fixture);
	return {
		...fixture.target,
		state: "owner_pending",
		taskArtifactOwnerDeletionEvidence: fixture.evidence,
		taskArtifactOwnerRetirementOutcome: {
			kind: "uncertain",
			evidence: fixture.evidence,
			continuation,
			reason,
		},
		taskArtifactOwnerRetirementContinuation: continuation,
	};
}

function substitutedReceiptRecord(
	fixture: Fixture,
	evidence: TaskArtifactOwnerDeletionEvidence,
	state: "artifacts_removed" | "owner_pending",
): Record<string, unknown> {
	const common = {
		schemaVersion: 1,
		state,
		scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
		transcriptPath: fixture.target.transcriptPath,
		sessionId: fixture.target.sessionId,
		cwd: fixture.target.cwd,
		transcriptIdentity: managedGcRetirementIdentityRecord(fixture.target.transcriptIdentity),
		taskArtifactOwnerDeletionEvidence: evidence,
	};
	if (state === "artifacts_removed") return { ...common, artifactsRemoved: true };
	const continuation: TaskArtifactOwnerRetirementContinuation = {
		schemaVersion: 1,
		parentIdentity: evidence.parentIdentity,
		retainedRootPath: ownerAbsolutePath(
			taskArtifactOwnerStorageContextForScope(fixture.scope),
			fixture.target.taskArtifactOwnerLocator.ownerId,
		),
		retainedTreeSnapshot: evidence.treeSnapshot,
	};
	return {
		...common,
		artifactsRemoved: true,
		ownerRetirementAttempt: 1,
		taskArtifactOwnerRetirementOutcome: {
			kind: "uncertain",
			evidence,
			continuation,
			reason: "substituted_history_fixture",
		},
		taskArtifactOwnerRetirementContinuation: continuation,
	};
}

function readReceiptSuffix(fixture: Fixture, suffix: string): unknown {
	const scope = fixture.scope;
	const store = openScopeStore(scope);
	try {
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const relative = `.gjc-managed-session-internal/receipts/gc-retirement-${key}-${suffix}.json`;
		const snapshot = store.readExpected(relative);
		if (!snapshot) throw new Error("fixture_receipt_missing");
		return JSON.parse(snapshot.bytes.toString("utf8")) as unknown;
	} finally {
		store.close();
	}
}

function managedGcReceiptPath(fixture: Fixture, suffix: string): string {
	const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
	return path.join(
		fixture.scope.directoryPath,
		".gjc-managed-session-internal",
		"receipts",
		`gc-retirement-${key}-${suffix}.json`,
	);
}

function extendManagedGcReceiptWithWhitespace(pathname: string, targetSize: number): void {
	const descriptor = fs.openSync(pathname, "r+");
	try {
		const initialSize = fs.fstatSync(descriptor).size;
		if (!Number.isSafeInteger(targetSize) || initialSize > targetSize)
			throw new Error("managed_gc_receipt_padding_size_invalid");
		const spaces = Buffer.alloc(1024 * 1024, 0x20);
		for (let position = initialSize; position < targetSize; ) {
			const length = Math.min(spaces.byteLength, targetSize - position);
			const written = fs.writeSync(descriptor, spaces, 0, length, position);
			if (written !== length) throw new Error("managed_gc_receipt_padding_short_write");
			position += written;
		}
	} finally {
		fs.closeSync(descriptor);
	}
}

function padManagedGcReceiptHistoryTo512MiB(fixture: Fixture): string[] {
	const paths = [
		managedGcReceiptPath(fixture, "prepared"),
		managedGcReceiptPath(fixture, "artifacts_removed"),
		...Array.from({ length: 6 }, (_, index) =>
			managedGcReceiptPath(fixture, `owner_pending-${String(index + 1).padStart(8, "0")}`),
		),
	];
	if (paths.length * MANAGED_SESSION_READ_RANGE_MAX_BYTES !== MANAGED_ARTIFACT_MAX_TOTAL_BYTES)
		throw new Error("fixture_gc_receipt_history_limit_mismatch");
	for (const pathname of paths) extendManagedGcReceiptWithWhitespace(pathname, MANAGED_SESSION_READ_RANGE_MAX_BYTES);
	const storedBytes = paths.reduce((total, pathname) => total + fs.statSync(pathname).size, 0);
	if (storedBytes !== MANAGED_ARTIFACT_MAX_TOTAL_BYTES) throw new Error("fixture_gc_receipt_history_not_at_limit");
	return paths;
}

async function cleanupRetryCandidate(fixture: Fixture) {
	await Bun.write(
		fixture.transcriptPath,
		`${JSON.stringify({ type: "session", version: 3, id: fixture.target.sessionId, cwd: fixture.cwd })}\n`,
	);
	const listed = listManagedCandidates(fixture.scope);
	if (listed.kind !== "complete") throw new Error(listed.message);
	const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
	if (!candidate) throw new Error("cleanup_retry_candidate_missing");
	return candidate;
}

function injectPendingTranscriptDelete() {
	// This seeds replay history through the API; it is not evidence of native deletion.
	return vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(async target => {
		if (!target.plannedTranscriptPath) throw new Error("cleanup_retry_plan_missing");
		return {
			kind: "cleanup_pending",
			phase: "transcript",
			detachedTranscriptPath: target.plannedTranscriptPath,
			error: new Error("injected_cleanup_pending"),
		} as never;
	});
}

async function injectedCleanupHistory(apiCalls: number) {
	const fixture = makeFixture();
	const candidate = await cleanupRetryCandidate(fixture);
	injectPendingTranscriptDelete();
	let tombstonePath = "";
	for (let attempt = 0; attempt < apiCalls; attempt++) {
		const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
		if (result.kind !== "cleanup_pending")
			throw new Error(`cleanup_retry_injection_failed:${JSON.stringify(result)}`);
		tombstonePath = result.tombstonePath;
	}
	return { fixture, candidate, tombstonePath };
}

function snapshotTree(root: string): unknown[] {
	const entries: unknown[] = [];
	const visit = (pathname: string, relative: string): void => {
		const stat = fs.lstatSync(pathname, { bigint: true });
		entries.push({
			relative,
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			mode: stat.mode.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
		});
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			for (const name of fs.readdirSync(pathname).sort()) {
				visit(path.join(pathname, name), path.join(relative, name));
			}
		} else if (stat.isFile()) {
			entries.push({ relative: `${relative}:bytes`, bytes: fs.readFileSync(pathname).toString("base64") });
		}
	};
	visit(root, ".");
	return entries;
}

function managedReceiptInventory(scope: ManagedScope): Array<{ name: string; size: number; sha256: string }> {
	const directory = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
	if (!fs.existsSync(directory)) return [];
	return fs
		.readdirSync(directory)
		.sort()
		.map(name => {
			const bytes = fs.readFileSync(path.join(directory, name));
			return { name, size: bytes.byteLength, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
		});
}

function isNestedCandidateContinuationJsonValue(value: unknown, marker: string): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const continuation = value as Record<string, unknown>;
	const snapshot = continuation.retainedTreeSnapshot;
	if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return false;
	const entries = (snapshot as Record<string, unknown>).entries;
	return (
		Array.isArray(entries) &&
		entries.some(
			entry =>
				typeof entry === "object" &&
				entry !== null &&
				!Array.isArray(entry) &&
				(entry as Record<string, unknown>).relativePath === marker,
		)
	);
}

describe("bounded cleanup receipt replay", () => {
	it("replays at least ten persisted contiguous attempts from injected deletes while retaining plan evidence", async () => {
		const { fixture, tombstonePath } = await injectedCleanupHistory(9);
		const directory = path.dirname(tombstonePath);
		const records = fs
			.readdirSync(directory)
			.filter(name => name.includes(".cleanup-pending-") && name.endsWith(".json"))
			.map(name => ({ name, attempt: Number(/-([0-9]+)\.json$/u.exec(name)?.[1]) }))
			.sort((left, right) => left.attempt - right.attempt);
		expect(records.length).toBeGreaterThanOrEqual(10);
		expect(records.map(record => record.attempt)).toEqual(
			Array.from({ length: records.length }, (_, index) => index + 1),
		);
		const last = JSON.parse(fs.readFileSync(path.join(directory, records.at(-1)!.name), "utf8")) as Record<
			string,
			unknown
		>;
		const priorPlans = records
			.slice(0, -1)
			.map(
				({ name }) =>
					(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>)
						.plannedTranscriptPath,
			);
		expect(last.attempt).toBe(records.length);
		expect(priorPlans).toContain(last.detachedTranscriptPath);
		expect(last.target).toMatchObject({ path: fixture.transcriptPath, sessionId: fixture.target.sessionId });
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
	}, 60_000);

	it("keeps bounded protocol snapshots readable for nested cleanup receipts", async () => {
		const { fixture } = await injectedCleanupHistory(1);
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		const snapshots = await inspect([protocolInputFor(fixture.scope)]);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.directories.find(directory => directory.role === "tombstones")?.files).toContainEqual(
			expect.objectContaining({ name: expect.stringContaining(".cleanup-pending-1.json") }),
		);
	});

	it("rejects oversized noncanonical cleanup-like protocol names before opening or allocating the file", async () => {
		const { fixture, tombstonePath } = await injectedCleanupHistory(1);
		const directory = path.dirname(tombstonePath);
		const valid = fs
			.readdirSync(directory)
			.find(name => name.includes(".cleanup-pending-") && /-1\.json$/u.test(name));
		if (!valid) throw new Error("cleanup_receipt_name_missing");
		const prefix = /^(.*\.cleanup-pending-)\d+\.json$/u.exec(valid);
		if (!prefix) throw new Error("cleanup_receipt_prefix_missing");
		const malformedPath = path.join(directory, `${prefix[1]}01.json`);
		const descriptor = fs.openSync(malformedPath, "wx", 0o600);
		try {
			fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1);
		} finally {
			fs.closeSync(descriptor);
		}
		let openedMalformed = false;
		const originalOpen = fs.openSync.bind(fs);
		vi.spyOn(fs, "openSync").mockImplementation(((pathname: fs.PathLike, flags: string | number, mode?: number) => {
			if (typeof pathname === "string" && path.resolve(pathname) === malformedPath) openedMalformed = true;
			return originalOpen(pathname, flags, mode);
		}) as typeof fs.openSync);
		const allocate = vi.spyOn(Buffer, "alloc");
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow(
			"managed_gc_protocol_tombstone_role_invalid",
		);
		expect(openedMalformed).toBe(false);
		expect(allocate.mock.calls.some(([size]) => size === 64 * 1024 * 1024 + 1)).toBe(false);
	});

	it("rejects a zero-link open receipt descriptor before allocating its contents", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-gc-zero-link-"));
		temporaryRoots.push(root);
		const pathname = path.join(root, "unlinked-receipt.json");
		const size = 8 * 1024 * 1024;
		const seedDescriptor = fs.openSync(pathname, "wx", 0o600);
		try {
			fs.ftruncateSync(seedDescriptor, size);
		} finally {
			fs.closeSync(seedDescriptor);
		}
		const originalOpen = fs.openSync.bind(fs);
		vi.spyOn(fs, "openSync").mockImplementation(((openedPath: fs.PathLike, flags: string | number, mode?: number) => {
			const fd = originalOpen(openedPath, flags, mode);
			if (typeof openedPath === "string" && path.resolve(openedPath) === pathname) fs.unlinkSync(pathname);
			return fd;
		}) as typeof fs.openSync);
		const allocate = vi.spyOn(Buffer, "alloc");
		expect(() => captureManagedFileNoFollowBounded(pathname, size)).toThrow("source_changed");
		expect(fs.existsSync(pathname)).toBe(false);
		expect(allocate.mock.calls.some(([allocationSize]) => allocationSize === size)).toBe(false);
	});

	it("admits every inventory entry and refuses the 50,001st before replay reads or retains entries", async () => {
		const { fixture, tombstonePath } = await injectedCleanupHistory(1);
		const directory = path.dirname(tombstonePath);
		const originalOpen = fs.opendirSync.bind(fs);
		let entriesRead = 0;
		let closed = false;
		const open = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (pathname !== directory) return originalOpen(pathname);
			return {
				readSync: () => {
					entriesRead++;
					return { name: `unrelated-${entriesRead}` } as fs.Dirent;
				},
				closeSync: () => {
					closed = true;
				},
			} as fs.Dir;
		});
		const allocate = vi.spyOn(Buffer, "alloc");
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow("managed_gc_journal_capacity_exceeded");
		expect(entriesRead).toBe(50_001);
		expect(closed).toBe(true);
		expect(allocate.mock.calls.some(([size]) => typeof size === "number" && size >= 64 * 1024 * 1024)).toBe(false);
		open.mockRestore();
	});

	it("refuses an oversized receipt from its descriptor size before Buffer allocation", async () => {
		const { fixture, tombstonePath } = await injectedCleanupHistory(1);
		const directory = path.dirname(tombstonePath);
		const records = fs
			.readdirSync(directory)
			.filter(name => name.includes(".cleanup-pending-") && name.endsWith(".json"));
		const latestAttempt = Math.max(...records.map(name => Number(/-([0-9]+)\.json$/u.exec(name)?.[1])));
		const prefix = /^(.*\.cleanup-pending-)\d+\.json$/u.exec(records[0]!);
		if (!prefix) throw new Error("cleanup_receipt_prefix_missing");
		const oversizedPath = path.join(directory, `${prefix[1]}${latestAttempt + 1}.json`);
		const descriptor = fs.openSync(oversizedPath, "wx", 0o600);
		try {
			fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1);
		} finally {
			fs.closeSync(descriptor);
		}
		const allocate = vi.spyOn(Buffer, "alloc");
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow("managed_gc_journal_capacity_exceeded");
		expect(allocate.mock.calls.some(([size]) => size === 64 * 1024 * 1024 + 1)).toBe(false);
	});

	it("refuses the ninth actual cleanup receipt after eight real 64 MiB admissions", async () => {
		const { fixture, tombstonePath } = await injectedCleanupHistory(9);
		const directory = path.dirname(tombstonePath);
		const names = fs
			.readdirSync(directory)
			.filter(name => name.includes(".cleanup-pending-") && name.endsWith(".json"))
			.sort(
				(left, right) => Number(/-([0-9]+)\.json$/u.exec(left)?.[1]) - Number(/-([0-9]+)\.json$/u.exec(right)?.[1]),
			);
		const receiptPaths = new Set(names.map(name => path.join(directory, name)));
		for (const name of names.slice(0, 8))
			extendManagedGcReceiptWithWhitespace(path.join(directory, name), MANAGED_SESSION_READ_RANGE_MAX_BYTES);
		const actualSizes = new Map(
			[...receiptPaths].map(pathname => {
				const stat = fs.statSync(pathname, { bigint: true });
				return [
					pathname,
					{ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs },
				] as const;
			}),
		);
		const before = [...actualSizes.entries()];
		const readers: Array<{ matchingEntries: number; allocations: number; inventoryClosed: boolean }> = [];
		let activeReader: (typeof readers)[number] | undefined;
		const receiptSize = MANAGED_SESSION_READ_RANGE_MAX_BYTES;
		const originalOpendir = fs.opendirSync.bind(fs);
		const originalOpen = fs.openSync.bind(fs);
		const originalClose = fs.closeSync.bind(fs);
		const originalRead = fs.readSync.bind(fs);
		const originalAlloc = Buffer.alloc.bind(Buffer);
		const descriptorPaths = new Map<number, string>();
		const allocated = new Map<string, number>();
		const bytesRequested = new Map<string, number>();
		const bytesRead = new Map<string, number>();
		const closes = new Map<string, number>();
		const opendir = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			const handle = originalOpendir(pathname);
			if (pathname !== directory) return handle;
			const reader = { matchingEntries: 0, allocations: 0, inventoryClosed: false };
			readers.push(reader);
			activeReader = reader;
			return {
				readSync: () => {
					const entry = handle.readSync();
					if (entry?.name.includes(".cleanup-pending-") && entry.name.endsWith(".json")) reader.matchingEntries++;
					return entry;
				},
				closeSync: () => {
					handle.closeSync();
					reader.inventoryClosed = true;
				},
			} as fs.Dir;
		});
		const open = vi.spyOn(fs, "openSync").mockImplementation(((
			pathname: fs.PathLike,
			flags: string | number,
			mode?: number,
		) => {
			const fd = originalOpen(pathname, flags, mode);
			if (typeof pathname === "string" && receiptPaths.has(path.resolve(pathname)))
				descriptorPaths.set(fd, path.resolve(pathname));
			return fd;
		}) as typeof fs.openSync);
		const close = vi.spyOn(fs, "closeSync").mockImplementation(fd => {
			const pathname = descriptorPaths.get(fd);
			try {
				originalClose(fd);
			} finally {
				descriptorPaths.delete(fd);
				if (pathname) closes.set(pathname, (closes.get(pathname) ?? 0) + 1);
			}
		});
		const read = vi.spyOn(fs, "readSync").mockImplementation(((
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: number | null,
		) => {
			const pathname = descriptorPaths.get(fd);
			if (pathname) bytesRequested.set(pathname, (bytesRequested.get(pathname) ?? 0) + length);
			const count = originalRead(fd, buffer, offset, length, position);
			if (pathname) bytesRead.set(pathname, (bytesRead.get(pathname) ?? 0) + count);
			return count;
		}) as typeof fs.readSync);
		const allocate = vi.spyOn(Buffer, "alloc").mockImplementation(((
			size: number,
			fill?: string | Uint8Array | number,
			encoding?: BufferEncoding,
		) => {
			if (size !== receiptSize) return originalAlloc(size, fill as number, encoding);
			const pathname = [...descriptorPaths.values()].find(candidate => receiptPaths.has(candidate));
			if (!pathname) throw new Error("cleanup_receipt_allocation_descriptor_missing");
			allocated.set(pathname, (allocated.get(pathname) ?? 0) + 1);
			if (activeReader?.inventoryClosed) activeReader.allocations++;
			return originalAlloc(size, fill as number, encoding);
		}) as typeof Buffer.alloc);
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		try {
			await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow(
				"managed_gc_journal_capacity_exceeded",
			);
		} finally {
			allocate.mockRestore();
			read.mockRestore();
			close.mockRestore();
			open.mockRestore();
			opendir.mockRestore();
		}
		expect(names.length).toBeGreaterThan(8);
		expect(readers).toEqual([
			{ matchingEntries: names.length, allocations: 0, inventoryClosed: true },
			{ matchingEntries: names.length, allocations: 0, inventoryClosed: true },
			{ matchingEntries: names.length, allocations: 8, inventoryClosed: true },
		]);
		expect([...allocated.values()].reduce((total, count) => total + count, 0)).toBe(8);
		const openedReceiptPaths = new Set(names.slice(0, 9).map(name => path.join(directory, name)));
		for (const pathname of receiptPaths) {
			const initialSize = actualSizes.get(pathname)?.size;
			if (!openedReceiptPaths.has(pathname)) {
				expect(closes.has(pathname)).toBe(false);
				expect(allocated.has(pathname)).toBe(false);
				expect(bytesRequested.has(pathname)).toBe(false);
				expect(bytesRead.has(pathname)).toBe(false);
			} else {
				expect(closes.get(pathname)).toBe(1);
				if (initialSize === BigInt(receiptSize)) {
					expect(allocated.get(pathname)).toBe(1);
					expect(bytesRequested.get(pathname)).toBe(receiptSize);
					expect(bytesRead.get(pathname)).toBe(receiptSize);
				} else {
					expect(initialSize).toBeLessThan(BigInt(receiptSize));
					expect(allocated.has(pathname)).toBe(false);
					expect(bytesRequested.has(pathname)).toBe(false);
					expect(bytesRead.has(pathname)).toBe(false);
				}
			}
		}
		expect(
			[...receiptPaths].map(pathname => {
				const stat = fs.statSync(pathname, { bigint: true });
				return [
					pathname,
					{ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs },
				] as const;
			}),
		).toEqual(before);
	}, 60_000);

	it("rejects noncanonical suffixes, filename-record mismatches, and gaps", async () => {
		for (const defect of ["suffix", "mismatch", "gap"] as const) {
			const { fixture, candidate, tombstonePath } = await injectedCleanupHistory(1);
			const directory = path.dirname(tombstonePath);
			const names = fs
				.readdirSync(directory)
				.filter(name => name.includes(".cleanup-pending-") && name.endsWith(".json"));
			const first = names.find(name => /-1\.json$/u.test(name));
			if (!first) throw new Error("cleanup_first_attempt_missing");
			if (defect === "suffix") {
				const prefix = /^(.*\.cleanup-pending-)\d+\.json$/u.exec(first);
				if (!prefix) throw new Error("cleanup_receipt_prefix_missing");
				fs.writeFileSync(path.join(directory, `${prefix[1]}03.json`), "{}\n", { mode: 0o600 });
			} else if (defect === "mismatch") {
				const pathname = path.join(directory, first);
				const record = JSON.parse(fs.readFileSync(pathname, "utf8")) as Record<string, unknown>;
				fs.writeFileSync(pathname, `${JSON.stringify({ ...record, attempt: 2 })}\n`);
			} else {
				fs.unlinkSync(path.join(directory, first));
			}
			const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
			expect(result).toMatchObject({ kind: "error", code: "durability_failed" });
		}
	});
});

describe("managed GC receipt descriptor admission", () => {
	it("rejects an actual oversized receipt from descriptor size before allocating its contents", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const receiptPath = managedGcReceiptPath(fixture, "prepared");
		const receiptBytes = fs.readFileSync(receiptPath);
		const descriptor = fs.openSync(receiptPath, "r+");
		try {
			fs.ftruncateSync(descriptor, MANAGED_SESSION_READ_RANGE_MAX_BYTES + 1);
		} finally {
			fs.closeSync(descriptor);
		}
		const before = fs.statSync(receiptPath, { bigint: true });
		const allocations = spyOn(Buffer, "alloc");
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
		).rejects.toThrow("managed_gc_journal_capacity_exceeded");
		const after = fs.statSync(receiptPath, { bigint: true });
		expect(after.size).toBe(BigInt(MANAGED_SESSION_READ_RANGE_MAX_BYTES + 1));
		expect(after.dev).toBe(before.dev);
		expect(after.ino).toBe(before.ino);
		expect(after.nlink).toBe(1n);
		expect(allocations.mock.calls.some(([size]) => size >= MANAGED_SESSION_READ_RANGE_MAX_BYTES)).toBe(false);
		const current = Buffer.alloc(receiptBytes.byteLength);
		const readDescriptor = fs.openSync(receiptPath, "r");
		try {
			expect(fs.readSync(readDescriptor, current, 0, current.byteLength, 0)).toBe(current.byteLength);
		} finally {
			fs.closeSync(readDescriptor);
		}
		expect(current).toEqual(receiptBytes);
	});

	it("rejects a linked actual receipt before allocation under the producer's real scope lock", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const receiptPath = managedGcReceiptPath(fixture, "prepared");
		const linkedPath = path.join(fixture.temporaryRoot, "linked-prepared-receipt.json");
		const lockPath = path.join(
			fixture.scope.directoryPath,
			".gjc-managed-session-internal",
			"locks",
			`${MANAGED_GC_SCOPE_LOCK_NAME}.lock`,
		);
		const before = fs.readFileSync(receiptPath);
		const beforeStat = fs.statSync(receiptPath, { bigint: true });
		fs.linkSync(receiptPath, linkedPath);
		let openedScopeLock = false;
		let receiptOpenCount = 0;
		const originalOpen = fs.openSync.bind(fs);
		const open = vi.spyOn(fs, "openSync").mockImplementation(((
			pathname: fs.PathLike,
			flags: string | number,
			mode?: number,
		) => {
			const descriptor = originalOpen(pathname, flags, mode);
			if (typeof pathname === "string" && path.resolve(pathname) === receiptPath) receiptOpenCount++;
			if (typeof pathname === "string" && path.resolve(pathname) === lockPath) openedScopeLock = true;
			return descriptor;
		}) as typeof fs.openSync);
		const allocations = spyOn(Buffer, "alloc");
		try {
			const next: ManagedGcSessionRetirementReceipt = {
				...preparedReceipt(fixture),
				state: "artifacts_removed",
				artifactsRemoved: true,
			};
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, next)).rejects.toThrow("hard_link");
			expect(openedScopeLock).toBe(true);
			expect(receiptOpenCount).toBe(0);
			expect(allocations.mock.calls.some(([size]) => size === Number(beforeStat.size))).toBe(false);
			expect(fs.readFileSync(receiptPath)).toEqual(before);
			expect(fs.readFileSync(linkedPath)).toEqual(before);
			const afterStat = fs.statSync(receiptPath, { bigint: true });
			expect(afterStat.dev).toBe(beforeStat.dev);
			expect(afterStat.ino).toBe(beforeStat.ino);
			expect(afterStat.size).toBe(beforeStat.size);
			expect(afterStat.nlink).toBe(2n);
		} finally {
			allocations.mockRestore();
			open.mockRestore();
		}
	});

	it("closes a real receipt inventory after refusing its 50,001st physical entry", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const receiptDirectory = path.dirname(managedGcReceiptPath(fixture, "prepared"));
		for (let index = 0; index < MANAGED_ARTIFACT_MAX_FILES; index++) {
			const name = `gc-retirement-untrusted-${String(index).padStart(8, "0")}.entry`;
			fs.writeFileSync(path.join(receiptDirectory, name), "", { flag: "wx", mode: 0o600 });
		}
		expect(fs.readdirSync(receiptDirectory)).toHaveLength(MANAGED_ARTIFACT_MAX_FILES + 1);
		const originalOpendir = fs.opendirSync.bind(fs);
		let entriesRead = 0;
		let inventoryCloseCount = 0;
		const opendir = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			const directory = originalOpendir(pathname);
			if (path.resolve(String(pathname)) !== receiptDirectory) return directory;
			return {
				readSync: () => {
					const entry = directory.readSync();
					if (entry) entriesRead++;
					return entry;
				},
				closeSync: () => {
					directory.closeSync();
					inventoryCloseCount++;
				},
			} as fs.Dir;
		});
		const allocations = spyOn(Buffer, "alloc");
		try {
			await expect(
				readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			expect(entriesRead).toBe(MANAGED_ARTIFACT_MAX_FILES + 1);
			expect(inventoryCloseCount).toBe(1);
			expect(allocations.mock.calls.some(([size]) => size >= MANAGED_SESSION_READ_RANGE_MAX_BYTES)).toBe(false);
		} finally {
			allocations.mockRestore();
			opendir.mockRestore();
		}
	});

	it("admits actual receipt descriptors through 512 MiB and refuses the overflowing read before allocation", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		for (let attempt = 1; attempt <= 8; attempt++) {
			await publishManagedGcSessionRetirementReceipt(
				fixture.scope,
				pendingReceipt(fixture, `actual-byte-budget-${attempt}`),
			);
			expect(readReceiptSuffix(fixture, `owner_pending-${String(attempt).padStart(8, "0")}`)).toMatchObject({
				state: "owner_pending",
				ownerRetirementAttempt: attempt,
			});
		}
		const pendingPaths = Array.from({ length: 8 }, (_, index) =>
			managedGcReceiptPath(fixture, `owner_pending-${String(index + 1).padStart(8, "0")}`),
		);
		for (const receiptPath of pendingPaths.slice(0, 7))
			extendManagedGcReceiptWithWhitespace(receiptPath, MANAGED_SESSION_READ_RANGE_MAX_BYTES);
		const finalDescriptor = fs.openSync(pendingPaths[7]!, "r+");
		try {
			fs.ftruncateSync(finalDescriptor, MANAGED_SESSION_READ_RANGE_MAX_BYTES);
		} finally {
			fs.closeSync(finalDescriptor);
		}
		const preparedBytes = fs.statSync(managedGcReceiptPath(fixture, "prepared")).size;
		const artifactsBytes = fs.statSync(managedGcReceiptPath(fixture, "artifacts_removed")).size;
		expect(7 * MANAGED_SESSION_READ_RANGE_MAX_BYTES + preparedBytes + artifactsBytes).toBeLessThanOrEqual(
			MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
		);
		expect(8 * MANAGED_SESSION_READ_RANGE_MAX_BYTES + preparedBytes + artifactsBytes).toBeGreaterThan(
			MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
		);
		for (const receiptPath of pendingPaths) {
			const stat = fs.statSync(receiptPath, { bigint: true });
			expect(stat.size).toBe(BigInt(MANAGED_SESSION_READ_RANGE_MAX_BYTES));
			expect(stat.nlink).toBe(1n);
		}
		const allocations = spyOn(Buffer, "alloc");
		try {
			await expect(
				readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			const fullReceiptAllocations = allocations.mock.calls
				.filter(([size]) => size === MANAGED_SESSION_READ_RANGE_MAX_BYTES)
				.map(([size]) => size);
			expect(fullReceiptAllocations).toEqual(Array(7).fill(MANAGED_SESSION_READ_RANGE_MAX_BYTES));
		} finally {
			allocations.mockRestore();
		}
	});
});

describe("managed GC retirement journal", () => {
	it("publishes a canonical receipt exactly at the UTF-8 byte limit and rejects limit plus one before encoding", async () => {
		const seed = makeFixture();
		let exactChoice: { readonly transcriptFileName: string; readonly sessionId: string } | undefined;
		for (let extra = 0; extra < 16 && !exactChoice; extra++) {
			const transcriptFileName = `fixture${"x".repeat(extra)}.jsonl`;
			const sessionId = exactLimitSessionId(seed, transcriptFileName);
			if (sessionId !== undefined) exactChoice = { transcriptFileName, sessionId };
		}
		if (!exactChoice) throw new Error("fixture_exact_receipt_size_unavailable");
		let fixture: Fixture | undefined;
		let exactSessionId = exactChoice.sessionId;
		let measuredBytes: number | undefined;
		for (let measurement = 0; measurement < 2; measurement++) {
			fixture = makeFixture(exactSessionId, exactChoice.transcriptFileName);
			measuredBytes = preparedReceiptLineByteLength(fixture);
			if (measuredBytes === MANAGED_SESSION_READ_RANGE_MAX_BYTES) break;
			if (measurement === 1) throw new Error("fixture_exact_receipt_size_did_not_converge");
			const corrected = exactLimitSessionId(fixture, exactChoice.transcriptFileName, measuredBytes);
			if (!corrected) throw new Error("fixture_exact_receipt_size_unavailable");
			exactSessionId = corrected;
		}
		if (!fixture || measuredBytes !== MANAGED_SESSION_READ_RANGE_MAX_BYTES)
			throw new Error("fixture_exact_receipt_size_unavailable");
		expect(measuredBytes).toBe(MANAGED_SESSION_READ_RANGE_MAX_BYTES);
		const published = await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		expect(published.state).toBe("prepared");
		expect(published.sessionId).toBe(exactSessionId);

		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const receiptPath = path.join(
			fixture.scope.directoryPath,
			".gjc-managed-session-internal",
			"receipts",
			`gc-retirement-${key}-prepared.json`,
		);
		const exactStat = fs.statSync(receiptPath);
		expect(exactStat.size).toBe(MANAGED_SESSION_READ_RANGE_MAX_BYTES);
		const finalByte = Buffer.alloc(1);
		const receiptFd = fs.openSync(receiptPath, "r");
		try {
			expect(fs.readSync(receiptFd, finalByte, 0, 1, exactStat.size - 1)).toBe(1);
			expect(finalByte[0]).toBe(0x0a);
		} finally {
			fs.closeSync(receiptFd);
		}

		const overName = `${path.basename(exactChoice.transcriptFileName, ".jsonl")}x.jsonl`;
		const transcriptStore = openScopeStore(fixture.scope);
		let overTarget: ManagedGcSessionRetirementTarget;
		try {
			transcriptStore.publishNoReplaceSync(
				overName,
				Buffer.from(
					`${JSON.stringify({
						type: "session",
						id: exactSessionId,
						cwd: fixture.cwd,
						version: 3,
						taskArtifactOwner: fixture.target.taskArtifactOwnerLocator,
					})}\n`,
					"utf8",
				),
			);
		} finally {
			transcriptStore.close();
		}
		overTarget = bindManagedGcSessionRetirementTarget(
			fixture.scope,
			path.join(fixture.scope.directoryPath, overName),
		);
		const exactIdentityBytes = Buffer.byteLength(
			JSON.stringify(managedGcRetirementIdentityRecord(fixture.target.transcriptIdentity)),
			"utf8",
		);
		const overIdentityBytes = Buffer.byteLength(
			JSON.stringify(managedGcRetirementIdentityRecord(overTarget.transcriptIdentity)),
			"utf8",
		);
		expect(overIdentityBytes).toBe(exactIdentityBytes);
		const overReceipt: ManagedGcSessionRetirementReceipt = {
			...overTarget,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		};
		const before = managedReceiptInventory(fixture.scope);
		const stringify = spyOn(JSON, "stringify");
		const from = spyOn(Buffer, "from");
		const publish = spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		let candidateWasStringified = false;
		let candidateBufferWasCreated = false;
		let candidateWasPublished = false;
		try {
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, overReceipt)).rejects.toThrow(
				"managed_gc_receipt_capacity_exceeded",
			);
			candidateWasStringified = stringify.mock.calls.some(([value]) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
				const record = value as Record<string, unknown>;
				return record.transcriptPath === overTarget.transcriptPath && record.state === "prepared";
			});
			candidateBufferWasCreated = from.mock.calls.some(
				([value]) =>
					typeof value === "string" &&
					Buffer.byteLength(value, "utf8") > MANAGED_SESSION_READ_RANGE_MAX_BYTES - 1024,
			);
			candidateWasPublished = publish.mock.calls.some(([relativePath]) =>
				String(relativePath).includes("gc-retirement-"),
			);
		} finally {
			publish.mockRestore();
			from.mockRestore();
			stringify.mockRestore();
		}
		expect(candidateWasStringified).toBe(false);
		expect(candidateBufferWasCreated).toBe(false);
		expect(candidateWasPublished).toBe(false);
		expect(managedReceiptInventory(fixture.scope)).toEqual(before);
	}, 60_000);

	it("measures bigint JSON values without weakening strict DTO validation", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		const pending = pendingReceipt(fixture, "strict_dto_validation");
		const outcome = pending.taskArtifactOwnerRetirementOutcome;
		if (!outcome) throw new Error("fixture_pending_outcome_missing");
		const invalidOutcome = Object.assign({}, outcome, {
			unexpectedBigint: 18_446_744_073_709_551_616n,
		}) as typeof outcome;
		await expect(
			publishManagedGcSessionRetirementReceipt(fixture.scope, {
				...pending,
				taskArtifactOwnerRetirementOutcome: invalidOutcome,
			}),
		).rejects.toThrow("task_artifact_owner_retirement_outcome_invalid");
	});

	it("rejects an oversized valid pending candidate before serializing its nested continuation", async () => {
		const fixture = makeFixture("managed-gc-oversized-pending-fixture", "fixture.jsonl", true);
		const marker = fixture.largeOwnerTreeMarker;
		if (!marker) throw new Error("fixture_large_owner_tree_marker_missing");
		expect(fixture.evidence.treeSnapshot.entries).toHaveLength(50_000);
		expect(fixture.evidence.treeSnapshot.entries.some(entry => entry.relativePath === marker)).toBe(true);

		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		const candidate = pendingReceipt(fixture, "valid_large_continuation_candidate");
		const outcome = candidate.taskArtifactOwnerRetirementOutcome;
		if (outcome?.kind !== "uncertain") throw new Error("fixture_uncertain_outcome_missing");
		expect(candidate.taskArtifactOwnerRetirementContinuation).toBe(outcome.continuation);
		expect(outcome.continuation.retainedTreeSnapshot).toBe(fixture.evidence.treeSnapshot);

		const before = managedReceiptInventory(fixture.scope);
		const stringify = spyOn(JSON, "stringify");
		const from = spyOn(Buffer, "from");
		const publish = spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		let nestedCandidateWasStringified = false;
		let oversizedReceiptBufferWasCreated = false;
		let candidateReceiptWasPublished = false;
		try {
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, candidate)).rejects.toThrow(
				"managed_gc_receipt_capacity_exceeded",
			);
			nestedCandidateWasStringified = stringify.mock.calls.some(([value]) =>
				isNestedCandidateContinuationJsonValue(value, marker),
			);
			oversizedReceiptBufferWasCreated = from.mock.calls.some(([value]) => {
				if (typeof value === "string")
					return Buffer.byteLength(value, "utf8") > MANAGED_SESSION_READ_RANGE_MAX_BYTES;
				return ArrayBuffer.isView(value) && value.byteLength > MANAGED_SESSION_READ_RANGE_MAX_BYTES;
			});
			candidateReceiptWasPublished = publish.mock.calls.some(([relativePath]) =>
				String(relativePath).startsWith(".gjc-managed-session-internal/receipts/gc-retirement-"),
			);
		} finally {
			publish.mockRestore();
			from.mockRestore();
			stringify.mockRestore();
		}
		expect(nestedCandidateWasStringified).toBe(false);
		expect(oversizedReceiptBufferWasCreated).toBe(false);
		expect(candidateReceiptWasPublished).toBe(false);
		expect(managedReceiptInventory(fixture.scope)).toEqual(before);
		expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"artifacts_removed",
		);
	}, 60_000);

	it("fails public GC consumers at 50,001 streamed entries (resource-pressure simulation only)", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const receiptDirectory = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const before = managedReceiptInventory(fixture.scope);
		const protocolInput = protocolInputFor(fixture.scope);
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		const originalOpendir = fs.opendirSync.bind(fs);
		let scans = 0;
		let entriesRead = 0;
		let inventoriesClosed = 0;
		const inventory = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (path.resolve(String(pathname)) !== receiptDirectory) return originalOpendir(pathname);
			// Synthetic dirents exercise only the pre-retention guard; no fake entry reaches parsing or authority checks.
			scans++;
			let index = 0;
			return {
				readSync: () => {
					if (index === 50_001) return null;
					index++;
					entriesRead++;
					return { name: `gc-retirement-simulated-${index}` } as fs.Dirent;
				},
				closeSync: () => {
					inventoriesClosed++;
				},
			} as fs.Dir;
		});
		const allocations = spyOn(Buffer, "alloc");
		const stringifies = spyOn(JSON, "stringify");
		const publishes = spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		let largeAllocation = false;
		let encodedCandidate = false;
		let publishedCandidate = false;
		const candidate: ManagedGcSessionRetirementReceipt = {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		};
		try {
			await expect(
				readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, candidate)).rejects.toThrow(
				"managed_gc_journal_capacity_exceeded",
			);
			await expect(
				discoverManagedGcSessionRetirementReceipts({
					agentDir: fixture.agentDir,
					sessionsRoot: fixture.sessionsRoot,
				}),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			await expect(inspect([protocolInput])).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			largeAllocation = allocations.mock.calls.some(([size]) => size >= 64 * 1024 * 1024);
			encodedCandidate = stringifies.mock.calls.some(([value]) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
				const record = value as Record<string, unknown>;
				return record.state === "artifacts_removed" && record.transcriptPath === fixture.transcriptPath;
			});
			publishedCandidate = publishes.mock.calls.some(([relativePath]) =>
				String(relativePath).startsWith(".gjc-managed-session-internal/receipts/gc-retirement-"),
			);
		} finally {
			inventory.mockRestore();
			allocations.mockRestore();
			stringifies.mockRestore();
			publishes.mockRestore();
		}
		expect(scans).toBe(4);
		expect(entriesRead).toBe(scans * 50_001);
		expect(inventoriesClosed).toBe(scans);
		expect(largeAllocation).toBe(false);
		expect(encodedCandidate).toBe(false);
		expect(publishedCandidate).toBe(false);
		expect(managedReceiptInventory(fixture.scope)).toEqual(before);
	});

	it("rejects an oversized persisted GC state in reader, publisher, and discovery before allocation", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const receiptPath = path.join(
			fixture.scope.directoryPath,
			".gjc-managed-session-internal",
			"receipts",
			`gc-retirement-${key}-prepared.json`,
		);
		fs.truncateSync(receiptPath, 64 * 1024 * 1024 + 1);
		const before = fs.statSync(receiptPath, { bigint: true });
		const allocations = spyOn(Buffer, "alloc");
		const publishes = spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		let largeAllocation = false;
		let gcPublication = false;
		try {
			await expect(
				readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			await expect(
				publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture)),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			await expect(
				discoverManagedGcSessionRetirementReceipts({
					agentDir: fixture.agentDir,
					sessionsRoot: fixture.sessionsRoot,
				}),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			largeAllocation = allocations.mock.calls.some(([size]) => size === 64 * 1024 * 1024 + 1);
			gcPublication = publishes.mock.calls.some(([relativePath]) =>
				String(relativePath).startsWith(".gjc-managed-session-internal/receipts/gc-retirement-"),
			);
		} finally {
			allocations.mockRestore();
			publishes.mockRestore();
		}
		const after = fs.statSync(receiptPath, { bigint: true });
		expect(largeAllocation).toBe(false);
		expect(gcPublication).toBe(false);
		expect(after.dev).toBe(before.dev);
		expect(after.ino).toBe(before.ino);
		expect(after.size).toBe(before.size);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(after.ctimeNs).toBe(before.ctimeNs);
	});

	it("rejects the projected scan-guard entry before candidate encoding (inventory-pressure simulation only)", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const otherKey = key === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
		const simulatedEntries = Array.from({ length: 50_001 }, (_, index) => {
			const name =
				index === 0
					? `gc-retirement-${key}-prepared.json`
					: `gc-retirement-${otherKey}-owner_pending-${String(index).padStart(8, "0")}.json`;
			return {
				name,
				isFile: () => true,
				isSymbolicLink: () => false,
			} as fs.Dirent;
		});
		const receiptDirectory = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const originalOpendir = fs.opendirSync.bind(fs);
		let scans = 0;
		const inventory = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (path.resolve(String(pathname)) !== receiptDirectory) return originalOpendir(pathname);
			scans++;
			let index = 0;
			return {
				readSync: () => simulatedEntries[index++] ?? null,
				closeSync: () => undefined,
			} as fs.Dir;
		});
		const stringifies = spyOn(JSON, "stringify");
		const publishes = spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		let encodedCandidate = false;
		let publishedCandidate = false;
		try {
			await expect(
				publishManagedGcSessionRetirementReceipt(fixture.scope, {
					...preparedReceipt(fixture),
					state: "artifacts_removed",
					artifactsRemoved: true,
				}),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			encodedCandidate = stringifies.mock.calls.some(([value]) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
				const record = value as Record<string, unknown>;
				return record.state === "artifacts_removed" && record.transcriptPath === fixture.transcriptPath;
			});
			publishedCandidate = publishes.mock.calls.some(([relativePath]) =>
				String(relativePath).startsWith(".gjc-managed-session-internal/receipts/gc-retirement-"),
			);
		} finally {
			inventory.mockRestore();
			stringifies.mockRestore();
			publishes.mockRestore();
		}
		expect(scans).toBe(1);
		expect(encodedCandidate).toBe(false);
		expect(publishedCandidate).toBe(false);
	});

	it("refuses projected entry 50001 after admitting exactly 50000 existing entries before strict candidate encoding", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		await publishManagedGcSessionRetirementReceipt(fixture.scope, pendingReceipt(fixture, "existing-entry-plan"));
		const candidate = pendingReceipt(fixture, "projected-entry-50001");
		const outcome = candidate.taskArtifactOwnerRetirementOutcome;
		if (outcome?.kind !== "uncertain") throw new Error("fixture_projected_candidate_outcome_missing");
		const invalidCandidate: ManagedGcSessionRetirementReceipt = {
			...candidate,
			taskArtifactOwnerRetirementOutcome: Object.assign({}, outcome, {
				unexpectedBigint: 18_446_744_073_709_551_616n,
			}),
		};
		const before = managedReceiptInventory(fixture.scope);
		const receiptDirectory = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const genuineEntries = fs.readdirSync(receiptDirectory, { withFileTypes: true });
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const otherKey = key === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
		// Inventory pressure is a negative resource simulation, not authority for these other names.
		const entries = [
			...genuineEntries,
			...Array.from(
				{ length: 50_000 - genuineEntries.length },
				(_, index) =>
					({
						name: `gc-retirement-${otherKey}-owner_pending-${index + 1}.json`,
						isFile: () => true,
						isDirectory: () => false,
						isSymbolicLink: () => false,
						isBlockDevice: () => false,
						isCharacterDevice: () => false,
						isFIFO: () => false,
						isSocket: () => false,
					}) as fs.Dirent,
			),
		];
		expect(entries).toHaveLength(50_000);
		const scanned: number[] = [];
		const originalOpendir = fs.opendirSync.bind(fs);
		const inventory = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (path.resolve(String(pathname)) !== receiptDirectory) return originalOpendir(pathname);
			const scan = scanned.length;
			scanned.push(0);
			let index = 0;
			return {
				readSync: () => {
					const entry = entries[index++];
					if (entry) scanned[scan] = (scanned[scan] ?? 0) + 1;
					return entry ?? null;
				},
				closeSync: () => undefined,
			} as fs.Dir;
		});
		const stringifies = spyOn(JSON, "stringify");
		const from = spyOn(Buffer, "from");
		const publishes = spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		let encodedCandidate = false;
		let allocatedCandidate = false;
		let publishedCandidate = false;
		try {
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, invalidCandidate)).rejects.toThrow(
				"managed_gc_journal_capacity_exceeded",
			);
			encodedCandidate = stringifies.mock.calls.some(([value]) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
				const record = value as Record<string, unknown>;
				const candidateOutcome = record.taskArtifactOwnerRetirementOutcome as { reason?: unknown } | undefined;
				return (
					record.transcriptPath === fixture.transcriptPath && candidateOutcome?.reason === "projected-entry-50001"
				);
			});
			allocatedCandidate = from.mock.calls.some(
				([value]) => typeof value === "string" && value.includes("projected-entry-50001"),
			);
			publishedCandidate = publishes.mock.calls.some(([relativePath]) =>
				String(relativePath).startsWith(".gjc-managed-session-internal/receipts/gc-retirement-"),
			);
		} finally {
			inventory.mockRestore();
			stringifies.mockRestore();
			from.mockRestore();
			publishes.mockRestore();
		}
		expect(scanned.length).toBeGreaterThanOrEqual(2);
		expect(scanned.every(count => count === 50_000)).toBe(true);
		expect(encodedCandidate).toBe(false);
		expect(allocatedCandidate).toBe(false);
		expect(publishedCandidate).toBe(false);
		expect(managedReceiptInventory(fixture.scope)).toEqual(before);
		await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, invalidCandidate)).rejects.toThrow(
			"task_artifact_owner_retirement_outcome_invalid",
		);
		expect(managedReceiptInventory(fixture.scope)).toEqual(before);
	});

	it("rejects a genuine authenticated sibling scope inserted after discovery's initial root inventory", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const sibling = makeSiblingFixture(fixture, "managed-gc-discovery-sibling");
		await publishManagedGcSessionRetirementReceipt(sibling.scope, preparedReceipt(sibling));
		const parentJournalBefore = managedReceiptInventory(fixture.scope);
		const siblingJournalBefore = managedReceiptInventory(sibling.scope);
		const originalRoot = snapshotTree(fixture.sessionsRoot);
		const lateCwd = path.join(fixture.temporaryRoot, "late-scope-cwd");
		fs.mkdirSync(lateCwd, { mode: 0o700 });
		let inserted = false;
		let postInsertionRoot: unknown[] | undefined;
		const originalOpendirSync = fs.opendirSync.bind(fs);
		const inventoryInterleave = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (
				!inserted &&
				[fixture.scope.directoryPath, sibling.scope.directoryPath].some(
					scopePath =>
						path.resolve(String(pathname)) === path.join(scopePath, ".gjc-managed-session-internal", "receipts"),
				)
			) {
				inserted = true;
				const lateScope = makeScope(fixture.agentDir, fixture.sessionsRoot, lateCwd);
				postInsertionRoot = snapshotTree(fixture.sessionsRoot);
				if (
					lateScope.directoryPath === fixture.scope.directoryPath ||
					lateScope.directoryPath === sibling.scope.directoryPath
				)
					throw new Error("fixture_late_scope_collision");
			}
			return originalOpendirSync(pathname);
		});
		try {
			await expect(
				discoverManagedGcSessionRetirementReceipts({
					agentDir: fixture.agentDir,
					sessionsRoot: fixture.sessionsRoot,
				}),
			).rejects.toThrow("managed_gc_scope_authority_mismatch");
		} finally {
			inventoryInterleave.mockRestore();
		}
		expect(inserted).toBe(true);
		if (!postInsertionRoot) throw new Error("fixture_scope_inventory_insertion_missing");
		expect(snapshotTree(fixture.sessionsRoot)).toEqual(postInsertionRoot);
		expect(managedReceiptInventory(fixture.scope)).toEqual(parentJournalBefore);
		expect(managedReceiptInventory(sibling.scope)).toEqual(siblingJournalBefore);
		expect(originalRoot).not.toEqual(postInsertionRoot);
	});

	it("rejects a late authenticated populated scope without adopting its prepared journal", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const sibling = makeSiblingFixture(fixture, "managed-gc-populated-existing-sibling");
		await publishManagedGcSessionRetirementReceipt(sibling.scope, preparedReceipt(sibling));
		const late = makeSiblingFixture(fixture, "managed-gc-populated-late-sibling");
		await publishManagedGcSessionRetirementReceipt(late.scope, preparedReceipt(late));
		const lateKey = crypto.createHash("sha256").update(path.resolve(late.transcriptPath), "utf8").digest("hex");
		const lateReceiptPath = path.join(
			late.scope.directoryPath,
			".gjc-managed-session-internal",
			"receipts",
			`gc-retirement-${lateKey}-prepared.json`,
		);
		const preparedHash = crypto
			.createHash("sha256")
			.update(await Bun.file(lateReceiptPath).bytes())
			.digest("hex");
		const preparedIdentity = fs.statSync(lateReceiptPath, { bigint: true });
		const stagingPath = path.join(fixture.temporaryRoot, "staged-populated-scope");
		fs.renameSync(late.scope.directoryPath, stagingPath);
		const originalRoot = snapshotTree(fixture.sessionsRoot);
		const parentJournalBefore = managedReceiptInventory(fixture.scope);
		const siblingJournalBefore = managedReceiptInventory(sibling.scope);
		let inserted = false;
		let postInsertionRoot: unknown[] | undefined;
		const originalOpendirSync = fs.opendirSync.bind(fs);
		const interleave = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (
				!inserted &&
				[fixture.scope.directoryPath, sibling.scope.directoryPath].some(
					scopePath =>
						path.resolve(String(pathname)) === path.join(scopePath, ".gjc-managed-session-internal", "receipts"),
				)
			) {
				inserted = true;
				fs.renameSync(stagingPath, late.scope.directoryPath);
				postInsertionRoot = snapshotTree(fixture.sessionsRoot);
			}
			return originalOpendirSync(pathname);
		});
		try {
			await expect(
				discoverManagedGcSessionRetirementReceipts({
					agentDir: fixture.agentDir,
					sessionsRoot: fixture.sessionsRoot,
				}),
			).rejects.toThrow("managed_gc_scope_authority_mismatch");
		} finally {
			interleave.mockRestore();
		}
		expect(inserted).toBe(true);
		if (!postInsertionRoot) throw new Error("fixture_populated_scope_insertion_missing");
		expect(snapshotTree(fixture.sessionsRoot)).toEqual(postInsertionRoot);
		expect(originalRoot).not.toEqual(postInsertionRoot);
		expect(managedReceiptInventory(fixture.scope)).toEqual(parentJournalBefore);
		expect(managedReceiptInventory(sibling.scope)).toEqual(siblingJournalBefore);
		const preparedAfter = fs.statSync(lateReceiptPath, { bigint: true });
		expect(preparedAfter.dev).toBe(preparedIdentity.dev);
		expect(preparedAfter.ino).toBe(preparedIdentity.ino);
		expect(
			crypto
				.createHash("sha256")
				.update(await Bun.file(lateReceiptPath).bytes())
				.digest("hex"),
		).toBe(preparedHash);
		const lateRecord = (await Bun.file(lateReceiptPath).json()) as Record<string, unknown>;
		expect(lateRecord.state).toBe("prepared");
		expect(lateRecord.transcriptPath).toBe(late.transcriptPath);
		expect(lateRecord.taskArtifactOwnerDeletionEvidence).toEqual(late.evidence);
	});

	it("rejects a genuine prepared journal inserted into an already-inventoried scope, including prior absence", async () => {
		for (const initialState of ["prepared", "absent"] as const) {
			const fixture = makeFixture(`managed-gc-existing-scope-${initialState}`);
			const sibling = makeSiblingFixture(fixture, `managed-gc-existing-scope-later-${initialState}`);
			const [first, second] = [fixture, sibling].sort((left, right) =>
				left.scope.directoryName.localeCompare(right.scope.directoryName),
			);
			if (initialState === "prepared")
				await publishManagedGcSessionRetirementReceipt(first.scope, preparedReceipt(first));
			await publishManagedGcSessionRetirementReceipt(second.scope, preparedReceipt(second));
			const firstReceiptDir = path.join(first.scope.directoryPath, ".gjc-managed-session-internal", "receipts");
			const expectedFirstInventory = managedReceiptInventory(first.scope);
			const expectedSecondInventory = managedReceiptInventory(second.scope);
			const postExistingSnapshot = snapshotTree(fixture.sessionsRoot);
			let insertedTarget: Fixture | undefined;
			let postInsertionSnapshot: unknown[] | undefined;
			let intercepted = false;
			const originalOpendirSync = fs.opendirSync.bind(fs);
			const inventoryInterleave = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
				if (
					!intercepted &&
					path.resolve(String(pathname)) ===
						path.join(second.scope.directoryPath, ".gjc-managed-session-internal", "receipts")
				) {
					intercepted = true;
					insertedTarget = makeTargetFixtureInScope(
						fixture,
						first.scope,
						`late-managed-gc-target-${initialState}`,
						`late-${initialState}.jsonl`,
					);
					const lateKey = crypto
						.createHash("sha256")
						.update(path.resolve(insertedTarget.transcriptPath), "utf8")
						.digest("hex");
					const lateStore = openScopeStore(first.scope);
					try {
						lateStore.ensureDirectory(".gjc-managed-session-internal/receipts");
						lateStore.publishNoReplaceSync(
							`.gjc-managed-session-internal/receipts/gc-retirement-${lateKey}-prepared.json`,
							Buffer.from(
								`${JSON.stringify(
									preparedReceiptRecordForMeasurement(insertedTarget),
									(_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
								)}\n`,
								"utf8",
							),
						);
					} finally {
						lateStore.close();
					}
					postInsertionSnapshot = snapshotTree(fixture.sessionsRoot);
				}
				return originalOpendirSync(pathname);
			});
			try {
				await expect(
					discoverManagedGcSessionRetirementReceipts({
						agentDir: fixture.agentDir,
						sessionsRoot: fixture.sessionsRoot,
					}),
				).rejects.toThrow("task_artifact_owner_continuation_authority_mismatch");
			} finally {
				inventoryInterleave.mockRestore();
			}
			expect(intercepted).toBe(true);
			if (!insertedTarget || !postInsertionSnapshot)
				throw new Error("fixture_existing_scope_journal_insertion_missing");
			expect(snapshotTree(fixture.sessionsRoot)).toEqual(postInsertionSnapshot);
			expect(managedReceiptInventory(first.scope)).toHaveLength(expectedFirstInventory.length + 1);
			expect(managedReceiptInventory(second.scope)).toEqual(expectedSecondInventory);
			const lateKey = crypto
				.createHash("sha256")
				.update(path.resolve(insertedTarget.transcriptPath), "utf8")
				.digest("hex");
			const lateReceiptPath = path.join(firstReceiptDir, `gc-retirement-${lateKey}-prepared.json`);
			const lateRecord = JSON.parse(fs.readFileSync(lateReceiptPath, "utf8")) as Record<string, unknown>;
			expect(lateRecord.state).toBe("prepared");
			expect(lateRecord.transcriptPath).toBe(insertedTarget.transcriptPath);
			expect(lateRecord.taskArtifactOwnerDeletionEvidence).toEqual(insertedTarget.evidence);
			if (initialState === "absent") expect(postExistingSnapshot).not.toEqual(postInsertionSnapshot);
		}
	});

	it("admits actual 512 MiB receipt histories for sibling discovery", async () => {
		const fixture = makeFixture();
		const sibling = makeSiblingFixture(fixture, "managed-gc-budget-sibling");
		for (const current of [fixture, sibling]) {
			await publishManagedGcSessionRetirementReceipt(current.scope, preparedReceipt(current));
			await publishManagedGcSessionRetirementReceipt(current.scope, {
				...preparedReceipt(current),
				state: "artifacts_removed",
				artifactsRemoved: true,
			});
			for (let attempt = 1; attempt <= 6; attempt++)
				await publishManagedGcSessionRetirementReceipt(
					current.scope,
					pendingReceipt(current, `sibling-actual-boundary-${attempt}`),
				);
		}
		const paddedPaths = [
			...padManagedGcReceiptHistoryTo512MiB(fixture),
			...padManagedGcReceiptHistoryTo512MiB(sibling),
		];
		for (const pathname of paddedPaths) {
			const stat = fs.statSync(pathname, { bigint: true });
			expect(stat.size).toBe(BigInt(MANAGED_SESSION_READ_RANGE_MAX_BYTES));
			expect(stat.nlink).toBe(1n);
		}
		const targetKeys = [fixture, sibling].map(current =>
			crypto.createHash("sha256").update(path.resolve(current.transcriptPath), "utf8").digest("hex"),
		);
		const actualReads = new Map<string, number>();
		const actualBytesByTarget = new Map<string, number>();
		const originalReadExpectedBounded = ManagedSessionDescendantStore.prototype.readExpectedBounded;
		const boundedRead = spyOn(ManagedSessionDescendantStore.prototype, "readExpectedBounded").mockImplementation(
			function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				maxBytes: number,
				admitSize?: (size: number, descriptor: ManagedFileIdentity) => void,
			) {
				return originalReadExpectedBounded.call(this, relativePath, maxBytes, (size, descriptor) => {
					const key = /^\.gjc-managed-session-internal\/receipts\/gc-retirement-([a-f0-9]{64})-/u.exec(
						relativePath,
					)?.[1];
					if (key && targetKeys.includes(key)) {
						actualReads.set(key, (actualReads.get(key) ?? 0) + 1);
						expect(descriptor.size).toBe(size);
						expect(size).toBe(MANAGED_SESSION_READ_RANGE_MAX_BYTES);
						actualBytesByTarget.set(key, (actualBytesByTarget.get(key) ?? 0) + size);
					}
					admitSize?.(size, descriptor);
				});
			},
		);
		const discoveryAllocations = spyOn(Buffer, "alloc");
		try {
			const discovered = await discoverManagedGcSessionRetirementReceipts({
				agentDir: fixture.agentDir,
				sessionsRoot: fixture.sessionsRoot,
			});
			expect(discovered).toHaveLength(2);
			expect([...actualReads.values()].sort((left, right) => left - right)).toEqual([8, 8]);
			expect([...actualBytesByTarget.values()].sort((left, right) => left - right)).toEqual([
				MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
				MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
			]);
			expect(
				discoveryAllocations.mock.calls.filter(([size]) => size === MANAGED_SESSION_READ_RANGE_MAX_BYTES),
			).toHaveLength(16);
		} finally {
			boundedRead.mockRestore();
			discoveryAllocations.mockRestore();
		}
	}, 60_000);

	it("admits eight actual 64 MiB sibling states and rejects the ninth actual state before allocation", async () => {
		const fixture = makeFixture();
		const sibling = makeSiblingFixture(fixture, "managed-gc-ninth-sibling");
		for (const current of [fixture, sibling]) {
			await publishManagedGcSessionRetirementReceipt(current.scope, preparedReceipt(current));
			await publishManagedGcSessionRetirementReceipt(current.scope, {
				...preparedReceipt(current),
				state: "artifacts_removed",
				artifactsRemoved: true,
			});
			for (let attempt = 1; attempt <= 6; attempt++)
				await publishManagedGcSessionRetirementReceipt(
					current.scope,
					pendingReceipt(current, `sibling-ninth-${attempt}`),
				);
		}
		const target = fixture.scope.directoryName.localeCompare(sibling.scope.directoryName) > 0 ? fixture : sibling;
		const unaffected = target === fixture ? sibling : fixture;
		const targetKey = crypto.createHash("sha256").update(path.resolve(target.transcriptPath), "utf8").digest("hex");
		const unaffectedKey = crypto
			.createHash("sha256")
			.update(path.resolve(unaffected.transcriptPath), "utf8")
			.digest("hex");
		await publishManagedGcSessionRetirementReceipt(target.scope, pendingReceipt(target, "target_ninth_state"));
		const paddedHistoryPaths = [
			...padManagedGcReceiptHistoryTo512MiB(target),
			...padManagedGcReceiptHistoryTo512MiB(unaffected),
		];
		for (const pathname of paddedHistoryPaths)
			expect(fs.statSync(pathname, { bigint: true }).size).toBe(BigInt(MANAGED_SESSION_READ_RANGE_MAX_BYTES));
		const before = [managedReceiptInventory(fixture.scope), managedReceiptInventory(sibling.scope)];
		const keys = [target, unaffected].map(current =>
			crypto.createHash("sha256").update(path.resolve(current.transcriptPath), "utf8").digest("hex"),
		);
		const attempts = new Map<string, number>();
		const actualAdmissions = new Map<string, { count: number; bytes: number }>();
		const allocatedReceipts = new Map<string, number>();
		let activeReceiptPath: string | undefined;
		const originalReadExpectedBounded = ManagedSessionDescendantStore.prototype.readExpectedBounded;
		const originalAlloc = Buffer.alloc.bind(Buffer);
		const boundedRead = spyOn(ManagedSessionDescendantStore.prototype, "readExpectedBounded").mockImplementation(
			function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				maxBytes: number,
				admitSize?: (size: number, descriptor: ManagedFileIdentity) => void,
			) {
				activeReceiptPath = relativePath;
				try {
					return originalReadExpectedBounded.call(this, relativePath, maxBytes, (size, descriptor) => {
						const key = /^\.gjc-managed-session-internal\/receipts\/gc-retirement-([a-f0-9]{64})-/u.exec(
							relativePath,
						)?.[1];
						if (key && keys.includes(key)) {
							attempts.set(key, (attempts.get(key) ?? 0) + 1);
							expect(descriptor.size).toBe(size);
							expect(descriptor.nlink).toBe(1n);
							const entryKey = `${key}:${relativePath}`;
							const entry = actualAdmissions.get(entryKey) ?? { count: 0, bytes: 0 };
							entry.count++;
							entry.bytes += size;
							actualAdmissions.set(entryKey, entry);
						}
						admitSize?.(size, descriptor);
					});
				} finally {
					activeReceiptPath = undefined;
				}
			},
		);
		const allocations = spyOn(Buffer, "alloc").mockImplementation(((
			size: number,
			fill?: string | Uint8Array | number,
			encoding?: BufferEncoding,
		) => {
			if (activeReceiptPath && size === MANAGED_SESSION_READ_RANGE_MAX_BYTES) {
				const key = /^\.gjc-managed-session-internal\/receipts\/gc-retirement-([a-f0-9]{64})-/u.exec(
					activeReceiptPath,
				)?.[1];
				const allocationKey = `${key}:${activeReceiptPath}`;
				allocatedReceipts.set(allocationKey, (allocatedReceipts.get(allocationKey) ?? 0) + 1);
			}
			return originalAlloc(size, fill, encoding);
		}) as typeof Buffer.alloc);
		try {
			await expect(
				discoverManagedGcSessionRetirementReceipts({
					agentDir: fixture.agentDir,
					sessionsRoot: fixture.sessionsRoot,
				}),
			).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			expect([...attempts.values()].sort((left, right) => left - right)).toEqual([8, 9]);
			expect([...actualAdmissions.entries()].filter(([entry]) => entry.startsWith(`${targetKey}:`))).toHaveLength(9);
			expect(
				[...actualAdmissions.entries()].filter(([entry]) => entry.startsWith(`${unaffectedKey}:`)),
			).toHaveLength(8);
			for (const [entryKey, admission] of actualAdmissions) {
				const refused = entryKey.endsWith("owner_pending-00000007.json");
				expect(admission.count).toBe(1);
				if (refused) expect(admission.bytes).toBeLessThan(MANAGED_SESSION_READ_RANGE_MAX_BYTES);
				else expect(admission.bytes).toBe(MANAGED_SESSION_READ_RANGE_MAX_BYTES);
			}
			expect([...allocatedReceipts.values()].reduce((total, count) => total + count, 0)).toBe(16);
			expect(
				[...allocatedReceipts.keys()].some(
					entryKey =>
						entryKey ===
						`${targetKey}:.gjc-managed-session-internal/receipts/gc-retirement-${targetKey}-owner_pending-00000007.json`,
				),
			).toBe(false);
			expect([managedReceiptInventory(fixture.scope), managedReceiptInventory(sibling.scope)]).toEqual(before);
		} finally {
			boundedRead.mockRestore();
			allocations.mockRestore();
		}
	}, 60_000);

	it("keeps genuine receipt rereads healthy under the default descriptor-size cap", async () => {
		const fixture = makeFixture();
		const sibling = makeSiblingFixture(fixture, "managed-gc-independent-phase-sibling");
		const target = fixture.scope.directoryName.localeCompare(sibling.scope.directoryName) > 0 ? fixture : sibling;
		const unaffected = target === fixture ? sibling : fixture;
		for (const current of [target, unaffected]) {
			await publishManagedGcSessionRetirementReceipt(current.scope, preparedReceipt(current));
			await publishManagedGcSessionRetirementReceipt(current.scope, {
				...preparedReceipt(current),
				state: "artifacts_removed",
				artifactsRemoved: true,
			});
			for (let attempt = 1; attempt <= 6; attempt++)
				await publishManagedGcSessionRetirementReceipt(
					current.scope,
					pendingReceipt(current, `phase-seed-${attempt}`),
				);
		}
		const targetKey = crypto.createHash("sha256").update(path.resolve(target.transcriptPath), "utf8").digest("hex");
		const unaffectedKey = crypto
			.createHash("sha256")
			.update(path.resolve(unaffected.transcriptPath), "utf8")
			.digest("hex");
		const before = [managedReceiptInventory(target.scope), managedReceiptInventory(unaffected.scope)];
		const expectedPaths = new Map<string, Set<string>>([
			[targetKey, new Set(before[0]!.map(entry => `.gjc-managed-session-internal/receipts/${entry.name}`))],
			[unaffectedKey, new Set(before[1]!.map(entry => `.gjc-managed-session-internal/receipts/${entry.name}`))],
		]);
		const readsByTarget = new Map<string, string[]>();
		const capsByTarget = new Map<string, number[]>();
		const originalRead = ManagedSessionDescendantStore.prototype.readExpectedBounded;
		const read = spyOn(ManagedSessionDescendantStore.prototype, "readExpectedBounded").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath: string,
			maxBytes: number,
			admitSize?: (size: number, descriptor: ManagedFileIdentity) => void,
		) {
			const key = /^\.gjc-managed-session-internal\/receipts\/gc-retirement-([a-f0-9]{64})-/u.exec(
				relativePath,
			)?.[1];
			if (key === targetKey || key === unaffectedKey) {
				const caps = capsByTarget.get(key) ?? [];
				caps.push(maxBytes);
				capsByTarget.set(key, caps);
			}
			return originalRead.call(this, relativePath, maxBytes, (size, descriptor) => {
				if (key === targetKey || key === unaffectedKey) {
					const scope = key === targetKey ? target.scope : unaffected.scope;
					const actualSize = Number(
						fs.statSync(path.join(scope.directoryPath, relativePath), { bigint: true }).size,
					);
					expect(size).toBe(actualSize);
					expect(descriptor.size).toBe(size);
					expect(descriptor.nlink).toBe(1n);
					expect(expectedPaths.get(key)?.has(relativePath)).toBe(true);
					const reads = readsByTarget.get(key) ?? [];
					reads.push(relativePath);
					readsByTarget.set(key, reads);
				}
				admitSize?.(size, descriptor);
			});
		});
		try {
			const snapshots = await managedGcProtocolScopeInspectorForScope(fixture.scope)([
				protocolInputFor(target.scope),
				protocolInputFor(unaffected.scope),
			]);
			expect(snapshots).toHaveLength(2);
		} finally {
			read.mockRestore();
		}
		for (const [key, paths] of expectedPaths) {
			const reads = readsByTarget.get(key) ?? [];
			const caps = capsByTarget.get(key) ?? [];
			const passSize = paths.size;
			expect(reads).toHaveLength(passSize * 4);
			expect(caps).toEqual(Array(passSize * 4).fill(MANAGED_SESSION_READ_RANGE_MAX_BYTES));
			for (let pass = 0; pass < 4; pass++) {
				expect(new Set(reads.slice(pass * passSize, (pass + 1) * passSize))).toEqual(paths);
			}
		}
		expect([managedReceiptInventory(target.scope), managedReceiptInventory(unaffected.scope)]).toEqual(before);
	});

	it("rejects each inspector-phase receipt under a smaller real read cap before allocation", async () => {
		for (const phase of [
			{ name: "initial", earlierReads: 9, samePathRead: 2 },
			{ name: "comparison", earlierReads: 18, samePathRead: 3 },
			{ name: "final", earlierReads: 27, samePathRead: 4 },
		] as const) {
			const fixture = makeFixture(`managed-gc-phase-${phase.name}`);
			const sibling = makeSiblingFixture(fixture, `managed-gc-phase-sibling-${phase.name}`);
			for (const current of [fixture, sibling]) {
				await publishManagedGcSessionRetirementReceipt(current.scope, preparedReceipt(current));
				await publishManagedGcSessionRetirementReceipt(current.scope, {
					...preparedReceipt(current),
					state: "artifacts_removed",
					artifactsRemoved: true,
				});
				const pendingCount = current === fixture ? 7 : 6;
				for (let attempt = 1; attempt <= pendingCount; attempt++)
					await publishManagedGcSessionRetirementReceipt(
						current.scope,
						pendingReceipt(current, `phase-${phase.name}-${attempt}`),
					);
			}

			const targetKey = crypto
				.createHash("sha256")
				.update(path.resolve(fixture.transcriptPath), "utf8")
				.digest("hex");
			const targetPrefix = `.gjc-managed-session-internal/receipts/gc-retirement-${targetKey}-`;
			const beforeTree = snapshotTree(fixture.sessionsRoot);
			const beforeReceipts = managedReceiptInventory(fixture.scope);
			const beforeSiblingReceipts = managedReceiptInventory(sibling.scope);
			const reads = new Map<string, number>();
			const descriptorPaths = new Map<number, string>();
			const triggerFstatIdentities: Array<{
				dev: bigint;
				ino: bigint;
				nlink: bigint;
				size: bigint;
				mtimeNs: bigint;
				ctimeNs: bigint;
				isFile: boolean;
			}> = [];
			const targetCloseCounts = new Map<string, number>();
			const targetReadBytes = new Map<string, number>();
			const targetReadRequests = new Map<string, number>();
			const targetAllocationCounts = new Map<string, number>();
			let triggerPath: string | undefined;
			let triggerRelativePath: string | undefined;
			let triggerDescriptor: number | undefined;
			let triggerOpenCount = 0;
			let triggerStat: fs.BigIntStats | undefined;
			let triggerRequestCap: number | undefined;
			let allocationWhileTargetOpen = 0;
			const originalRead = ManagedSessionDescendantStore.prototype.readExpectedBounded;
			const originalOpen = fs.openSync.bind(fs);
			const originalClose = fs.closeSync.bind(fs);
			const originalReadSync = fs.readSync.bind(fs);
			const originalFstat = fs.fstatSync.bind(fs);
			const originalAlloc = Buffer.alloc.bind(Buffer);
			const read = spyOn(ManagedSessionDescendantStore.prototype, "readExpectedBounded").mockImplementation(
				function (
					this: ManagedSessionDescendantStore,
					relativePath: string,
					maxBytes: number,
					admitSize?: (size: number, descriptor: ManagedFileIdentity) => void,
				) {
					if (!relativePath.startsWith(targetPrefix))
						return originalRead.call(this, relativePath, maxBytes, admitSize);
					const count = (reads.get(relativePath) ?? 0) + 1;
					reads.set(relativePath, count);
					const totalReads = [...reads.values()].reduce((sum, current) => sum + current, 0);
					if (totalReads === phase.earlierReads + 1) {
						triggerRelativePath = relativePath;
						triggerPath = path.join(fixture.scope.directoryPath, relativePath);
						triggerStat = fs.lstatSync(triggerPath, { bigint: true });
						triggerRequestCap = maxBytes;
						if (!triggerStat.isFile() || triggerStat.nlink !== 1n || triggerStat.size <= 0n)
							throw new Error(`fixture_${phase.name}_receipt_descriptor_unavailable`);
						if (typeof admitSize !== "function")
							throw new Error(`fixture_${phase.name}_admission_callback_missing`);
						if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
							throw new Error(`fixture_${phase.name}_default_read_cap_invalid`);
						return originalRead.call(this, relativePath, 0, admitSize);
					}
					return originalRead.call(this, relativePath, maxBytes, admitSize);
				},
			);
			const open = spyOn(fs, "openSync").mockImplementation(((
				pathname: fs.PathLike,
				flags: string | number,
				mode?: number,
			) => {
				const fd = originalOpen(pathname, flags, mode);
				if (typeof pathname === "string" && triggerPath && path.resolve(pathname) === triggerPath) {
					descriptorPaths.set(fd, triggerPath);
					triggerDescriptor = fd;
					triggerOpenCount++;
				}
				return fd;
			}) as typeof fs.openSync);
			const close = spyOn(fs, "closeSync").mockImplementation(fd => {
				const pathname = descriptorPaths.get(fd);
				try {
					originalClose(fd);
				} finally {
					if (pathname) {
						descriptorPaths.delete(fd);
						targetCloseCounts.set(pathname, (targetCloseCounts.get(pathname) ?? 0) + 1);
					}
				}
			});
			const readSync = spyOn(fs, "readSync").mockImplementation(((
				fd: number,
				buffer: NodeJS.ArrayBufferView,
				offset: number,
				length: number,
				position: number | null,
			) => {
				const pathname = descriptorPaths.get(fd);
				if (pathname) targetReadRequests.set(pathname, (targetReadRequests.get(pathname) ?? 0) + length);
				const bytes = originalReadSync(fd, buffer, offset, length, position);
				if (pathname) targetReadBytes.set(pathname, (targetReadBytes.get(pathname) ?? 0) + bytes);
				return bytes;
			}) as typeof fs.readSync);
			const fstat = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
				if (options?.bigint) {
					const stat = originalFstat(fd, { ...options, bigint: true });
					const pathname = descriptorPaths.get(fd);
					if (pathname) {
						if (typeof stat.mtimeNs !== "bigint" || typeof stat.ctimeNs !== "bigint")
							throw new Error(`fixture_${phase.name}_opened_descriptor_stat_invalid`);
						triggerFstatIdentities.push({
							dev: stat.dev,
							ino: stat.ino,
							nlink: stat.nlink,
							size: stat.size,
							mtimeNs: stat.mtimeNs,
							ctimeNs: stat.ctimeNs,
							isFile: stat.isFile(),
						});
					}
					return stat;
				}
				return originalFstat(fd, options ? { ...options, bigint: false } : undefined);
			}) as typeof fs.fstatSync);
			const allocate = spyOn(Buffer, "alloc").mockImplementation(((
				size: number,
				fill?: string | Uint8Array | number,
				encoding?: BufferEncoding,
			) => {
				const pathname = [...descriptorPaths.values()].find(value => value === triggerPath);
				if (pathname) {
					targetAllocationCounts.set(pathname, (targetAllocationCounts.get(pathname) ?? 0) + 1);
					allocationWhileTargetOpen++;
				}
				return originalAlloc(size, fill, encoding);
			}) as typeof Buffer.alloc);
			let caught: unknown;
			try {
				await managedGcProtocolScopeInspectorForScope(fixture.scope)([
					protocolInputFor(fixture.scope),
					protocolInputFor(sibling.scope),
				]);
			} catch (error) {
				caught = error;
			} finally {
				allocate.mockRestore();
				fstat.mockRestore();
				readSync.mockRestore();
				close.mockRestore();
				open.mockRestore();
				read.mockRestore();
			}

			expect(caught).toMatchObject({ message: "managed_gc_journal_capacity_exceeded" });
			expect(triggerPath).toBeTypeOf("string");
			expect(triggerStat).toBeDefined();
			expect(triggerRequestCap).toBe(MANAGED_SESSION_READ_RANGE_MAX_BYTES);
			expect(triggerStat!.size).toBeGreaterThan(0n);
			expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBe(phase.earlierReads + 1);
			expect(triggerRelativePath).toBeTypeOf("string");
			expect(reads.get(triggerRelativePath!)).toBe(phase.samePathRead);
			expect(triggerOpenCount).toBe(1);
			expect(targetCloseCounts.get(triggerPath!)).toBe(1);
			if (triggerDescriptor === undefined) throw new Error(`fixture_${phase.name}_descriptor_not_opened`);
			expect(triggerFstatIdentities).toEqual([
				{
					dev: triggerStat!.dev,
					ino: triggerStat!.ino,
					nlink: triggerStat!.nlink,
					size: triggerStat!.size,
					mtimeNs: triggerStat!.mtimeNs,
					ctimeNs: triggerStat!.ctimeNs,
					isFile: true,
				},
			]);
			expect(() => originalFstat(triggerDescriptor!, { bigint: true })).toThrow();
			expect(targetReadRequests.has(triggerPath!)).toBe(false);
			expect(targetReadBytes.has(triggerPath!)).toBe(false);
			expect(targetAllocationCounts.has(triggerPath!)).toBe(false);
			expect(allocationWhileTargetOpen).toBe(0);
			if (!triggerStat) throw new Error(`fixture_${phase.name}_trigger_stat_missing`);
			const afterStat = fs.lstatSync(triggerPath!, { bigint: true });
			expect({
				dev: afterStat.dev,
				ino: afterStat.ino,
				nlink: afterStat.nlink,
				size: afterStat.size,
				mtimeNs: afterStat.mtimeNs,
				ctimeNs: afterStat.ctimeNs,
			}).toEqual({
				dev: triggerStat.dev,
				ino: triggerStat.ino,
				nlink: triggerStat.nlink,
				size: triggerStat.size,
				mtimeNs: triggerStat.mtimeNs,
				ctimeNs: triggerStat.ctimeNs,
			});
			expect([managedReceiptInventory(fixture.scope), managedReceiptInventory(sibling.scope)]).toEqual([
				beforeReceipts,
				beforeSiblingReceipts,
			]);
			expect(snapshotTree(fixture.sessionsRoot)).toEqual(beforeTree);
		}
	});

	it("serializes distinct-target appends at the shared receipt-directory capacity", async () => {
		const fixture = makeFixture();
		const secondTranscriptName = "second-fixture.jsonl";
		const secondTranscriptPath = path.join(fixture.scope.directoryPath, secondTranscriptName);
		const transcriptStore = openScopeStore(fixture.scope);
		try {
			transcriptStore.publishNoReplaceSync(
				secondTranscriptName,
				Buffer.from(
					`${JSON.stringify({
						type: "session",
						id: fixture.target.sessionId,
						cwd: fixture.cwd,
						version: 3,
						taskArtifactOwner: fixture.evidence.locator,
					})}\n`,
					"utf8",
				),
			);
		} finally {
			transcriptStore.close();
		}
		const secondTarget = bindManagedGcSessionRetirementTarget(fixture.scope, secondTranscriptPath);
		const secondReceipt: ManagedGcSessionRetirementReceipt = {
			...secondTarget,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		};
		const targetKeys = new Set(
			[fixture.transcriptPath, secondTranscriptPath].map(transcriptPath =>
				crypto.createHash("sha256").update(path.resolve(transcriptPath), "utf8").digest("hex"),
			),
		);
		const syntheticNames: string[] = [];
		for (let index = 0; syntheticNames.length < MANAGED_ARTIFACT_MAX_FILES - 1; index++) {
			const key = index.toString(16).padStart(64, "0");
			if (!targetKeys.has(key)) syntheticNames.push(`gc-retirement-${key}-prepared.json`);
		}
		const receiptDirectory = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const lockDirectory = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "locks");
		const openedLockPaths = new Set<string>();
		const originalOpendir = fs.opendirSync.bind(fs);
		const originalOpen = fs.openSync.bind(fs);
		const entry = (name: string): fs.Dirent =>
			({
				name,
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isDirectory: () => false,
				isFIFO: () => false,
				isFile: () => true,
				isSocket: () => false,
				isSymbolicLink: () => false,
			}) as fs.Dirent;
		const inventory = spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (path.resolve(String(pathname)) !== receiptDirectory) return originalOpendir(pathname);
			const directory = originalOpendir(pathname);
			let index = 0;
			return {
				readSync: () => (index < syntheticNames.length ? entry(syntheticNames[index++]!) : directory.readSync()),
				closeSync: () => directory.closeSync(),
			} as fs.Dir;
		});
		const open = spyOn(fs, "openSync").mockImplementation(((
			pathname: fs.PathLike,
			flags: string | number,
			mode?: number,
		) => {
			if (typeof pathname === "string" && path.dirname(path.resolve(pathname)) === lockDirectory)
				openedLockPaths.add(path.resolve(pathname));
			return originalOpen(pathname, flags, mode);
		}) as typeof fs.openSync);
		let results: PromiseSettledResult<ManagedGcSessionRetirementReceipt>[] = [];
		try {
			results = await Promise.allSettled([
				publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture)),
				publishManagedGcSessionRetirementReceipt(fixture.scope, secondReceipt),
			]);
		} finally {
			open.mockRestore();
			inventory.mockRestore();
		}
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(rejected?.reason).toMatchObject({ message: "managed_gc_journal_capacity_exceeded" });
		expect(openedLockPaths.size).toBe(1);
		expect([...openedLockPaths][0]).toBe(path.join(lockDirectory, `${MANAGED_GC_SCOPE_LOCK_NAME}.lock`));
		expect(managedReceiptInventory(fixture.scope)).toHaveLength(1);
	});

	it("rejects a candidate after actual 512 MiB history admission before candidate encoding", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		for (let attempt = 1; attempt <= 6; attempt++)
			await publishManagedGcSessionRetirementReceipt(fixture.scope, pendingReceipt(fixture, `seed-${attempt}`));
		const paddedPaths = padManagedGcReceiptHistoryTo512MiB(fixture);
		for (const pathname of paddedPaths) {
			const stat = fs.statSync(pathname, { bigint: true });
			expect(stat.size).toBe(BigInt(MANAGED_SESSION_READ_RANGE_MAX_BYTES));
			expect(stat.nlink).toBe(1n);
		}
		expect(paddedPaths.reduce((total, pathname) => total + fs.statSync(pathname).size, 0)).toBe(
			MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
		);
		expect((await readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"owner_pending",
		);
		const candidateReason = "actual_history_capacity_candidate";
		const candidate = pendingReceipt(fixture, candidateReason);
		const candidateOutcome = candidate.taskArtifactOwnerRetirementOutcome;
		if (candidateOutcome?.kind !== "uncertain") throw new Error("fixture_candidate_outcome_missing");
		const invalidCandidate: ManagedGcSessionRetirementReceipt = {
			...candidate,
			taskArtifactOwnerRetirementOutcome: Object.assign({}, candidateOutcome, {
				unexpectedBigint: 18_446_744_073_709_551_616n,
			}) as typeof candidateOutcome,
		};
		const before = managedReceiptInventory(fixture.scope);
		const originalReadExpectedBounded = ManagedSessionDescendantStore.prototype.readExpectedBounded;
		const actualAdmissions: Array<{ relativePath: string; size: number; descriptor: ManagedFileIdentity }> = [];
		const boundedRead = spyOn(ManagedSessionDescendantStore.prototype, "readExpectedBounded").mockImplementation(
			function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				maxBytes: number,
				admitSize?: (size: number, descriptor: ManagedFileIdentity) => void,
			) {
				return originalReadExpectedBounded.call(this, relativePath, maxBytes, (size, descriptor) => {
					if (relativePath.startsWith(".gjc-managed-session-internal/receipts/gc-retirement-")) {
						expect(descriptor.size).toBe(size);
						actualAdmissions.push({ relativePath, size, descriptor });
					}
					admitSize?.(size, descriptor);
				});
			},
		);
		const allocations = spyOn(Buffer, "alloc");
		const stringifies = spyOn(JSON, "stringify");
		const from = spyOn(Buffer, "from");
		const publishes = spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		let encodedCandidate = false;
		let candidateBuffer = false;
		let publishedCandidate = false;
		let receiptAllocationCount = 0;
		const candidateRelativePath = path
			.relative(fixture.scope.directoryPath, managedGcReceiptPath(fixture, "owner_pending-00000007"))
			.split(path.sep)
			.join("/");
		try {
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, invalidCandidate)).rejects.toThrow(
				"managed_gc_journal_capacity_exceeded",
			);
			encodedCandidate = stringifies.mock.calls.some(([value]) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
				const record = value as Record<string, unknown>;
				const outcome = record.taskArtifactOwnerRetirementOutcome as { reason?: unknown } | undefined;
				return record.transcriptPath === fixture.transcriptPath && outcome?.reason === candidateReason;
			});
			candidateBuffer = from.mock.calls.some(
				([value]) => typeof value === "string" && value.includes(candidateReason),
			);
			publishedCandidate = publishes.mock.calls.some(
				([relativePath]) => String(relativePath) === candidateRelativePath,
			);
			receiptAllocationCount = allocations.mock.calls.filter(
				([size]) => size === MANAGED_SESSION_READ_RANGE_MAX_BYTES,
			).length;
		} finally {
			boundedRead.mockRestore();
			allocations.mockRestore();
			stringifies.mockRestore();
			from.mockRestore();
			publishes.mockRestore();
		}
		expect(actualAdmissions).toHaveLength(8);
		expect(actualAdmissions.every(entry => entry.size === MANAGED_SESSION_READ_RANGE_MAX_BYTES)).toBe(true);
		expect(actualAdmissions.every(entry => entry.descriptor.nlink === 1n)).toBe(true);
		expect(receiptAllocationCount).toBe(8);
		expect(encodedCandidate).toBe(false);
		expect(candidateBuffer).toBe(false);
		expect(publishedCandidate).toBe(false);
		expect(managedReceiptInventory(fixture.scope)).toEqual(before);

		const controlFixture = makeFixture("managed-gc-append-candidate-control");
		await publishManagedGcSessionRetirementReceipt(controlFixture.scope, preparedReceipt(controlFixture));
		await publishManagedGcSessionRetirementReceipt(controlFixture.scope, {
			...preparedReceipt(controlFixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		for (let attempt = 1; attempt <= 6; attempt++)
			await publishManagedGcSessionRetirementReceipt(
				controlFixture.scope,
				pendingReceipt(controlFixture, `control-seed-${attempt}`),
			);
		const controlBefore = managedReceiptInventory(controlFixture.scope);
		const controlCandidate = pendingReceipt(controlFixture, "valid-history-control");
		const controlOutcome = controlCandidate.taskArtifactOwnerRetirementOutcome;
		if (controlOutcome?.kind !== "uncertain") throw new Error("fixture_control_candidate_outcome_missing");
		const invalidControlCandidate: ManagedGcSessionRetirementReceipt = {
			...controlCandidate,
			taskArtifactOwnerRetirementOutcome: Object.assign({}, controlOutcome, {
				unexpectedBigint: 18_446_744_073_709_551_616n,
			}) as typeof controlOutcome,
		};
		await expect(
			publishManagedGcSessionRetirementReceipt(controlFixture.scope, invalidControlCandidate),
		).rejects.toThrow("task_artifact_owner_retirement_outcome_invalid");
		expect(managedReceiptInventory(controlFixture.scope)).toEqual(controlBefore);
		const validControlReceipt = await publishManagedGcSessionRetirementReceipt(
			controlFixture.scope,
			controlCandidate,
		);
		expect(validControlReceipt).toMatchObject({ state: "owner_pending", ownerRetirementAttempt: 7 });
		expect(managedReceiptInventory(controlFixture.scope)).toHaveLength(controlBefore.length + 1);
	}, 60_000);

	it("uses bounded GC rereads when a receipt grows between discovery and inspector verification", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const protocolInput = protocolInputFor(fixture.scope);
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		const receiptDirectory = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const protocolDirectory = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal");
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const preparedPath = path.join(receiptDirectory, `gc-retirement-${key}-prepared.json`);
		const originalOpendirSync = fs.opendirSync.bind(fs);
		const originalLstatSync = fs.lstatSync.bind(fs);
		let inspectorStarted = false;
		let receiptDirectoryStats = 0;
		let grewReceipt = false;
		const opendir = vi.spyOn(fs, "opendirSync").mockImplementation(pathname => {
			if (path.resolve(String(pathname)) === protocolDirectory) inspectorStarted = true;
			return originalOpendirSync(pathname);
		});
		const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
			const stat = originalLstatSync(...args);
			if (inspectorStarted && path.resolve(String(args[0])) === receiptDirectory) {
				receiptDirectoryStats++;
				if (receiptDirectoryStats === 5) {
					fs.truncateSync(preparedPath, 64 * 1024 * 1024 + 1);
					grewReceipt = true;
				}
			}
			return stat;
		}) as typeof fs.lstatSync);
		const allocations = spyOn(Buffer, "alloc");
		let overLimitAllocation = false;
		try {
			await expect(inspect([protocolInput])).rejects.toThrow("managed_gc_journal_capacity_exceeded");
			overLimitAllocation = allocations.mock.calls.some(([size]) => size === 64 * 1024 * 1024 + 1);
		} finally {
			opendir.mockRestore();
			lstat.mockRestore();
			allocations.mockRestore();
		}
		expect(receiptDirectoryStats).toBeGreaterThanOrEqual(5);
		expect(grewReceipt).toBe(true);
		expect(fs.statSync(preparedPath).size).toBe(64 * 1024 * 1024 + 1);
		expect(overLimitAllocation).toBe(false);
	});

	it("persists actual native disposition and replays pending namespaces after transcript absence", async () => {
		const fixture = makeFixture();
		const prepared = await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		expect(prepared.state).toBe("prepared");
		expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"prepared",
		);

		const artifactsRemoved: ManagedGcSessionRetirementReceipt = {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		};
		expect((await publishManagedGcSessionRetirementReceipt(fixture.scope, artifactsRemoved)).state).toBe(
			"artifacts_removed",
		);
		expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"artifacts_removed",
		);

		const pending = pendingReceipt(fixture, "test_retry_required");
		expect((await publishManagedGcSessionRetirementReceipt(fixture.scope, pending)).state).toBe("owner_pending");
		expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"owner_pending",
		);

		const outcome = retireTaskArtifactOwner(
			taskArtifactOwnerStorageContextForScope(fixture.scope),
			fixture.evidence,
			uncertainContinuation(fixture),
		);
		const disposition: ManagedGcSessionRetirementReceipt =
			outcome.kind === "completed"
				? {
						...fixture.target,
						state: "owner_retired",
						taskArtifactOwnerDeletionEvidence: fixture.evidence,
						artifactsRemoved: true,
						taskArtifactOwnerRetirementOutcome: outcome,
						taskArtifactOwnerRetired: true,
					}
				: {
						...fixture.target,
						state: "owner_pending",
						taskArtifactOwnerDeletionEvidence: fixture.evidence,
						artifactsRemoved: true,
						taskArtifactOwnerRetirementOutcome: outcome,
						taskArtifactOwnerRetirementContinuation: outcome.continuation,
						...(outcome.kind === "payload_retired"
							? {
									taskArtifactOwnerPayloadRetired: true as const,
									taskArtifactOwnerNamespaceRetained: true as const,
								}
							: {}),
					};
		const published = await publishManagedGcSessionRetirementReceipt(fixture.scope, disposition);
		expect(published.state).toBe(outcome.kind === "completed" ? "owner_retired" : "owner_pending");
		if (outcome.kind === "completed") {
			const openRecoveryFsRoot = spyOn(native, "openRecoveryFsRoot").mockImplementation(() => {
				throw new Error("readonly_recovery_open_called");
			});
			try {
				verifyTaskArtifactOwnerPhysicalRetirement(
					taskArtifactOwnerStorageContextForScope(fixture.scope),
					fixture.evidence,
					outcome,
				);
				expect(openRecoveryFsRoot).not.toHaveBeenCalled();
			} finally {
				openRecoveryFsRoot.mockRestore();
			}
		}
		if (outcome.kind === "payload_retired") {
			expect(outcome.nativeOutcome.payloadDurable).toBe(true);
			expect(outcome.nativeOutcome.ok).toBe(false);
			expect(outcome.nativeOutcome.code).toBe("cleanup_pending");
			expect(published.taskArtifactOwnerRetired).toBeUndefined();
			await expect(
				publishManagedGcSessionRetirementReceipt(fixture.scope, {
					...disposition,
					state: "owner_retired",
					taskArtifactOwnerRetired: true,
				}),
			).rejects.toThrow();
		}
		expect(
			(await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))
				?.taskArtifactOwnerRetirementOutcome,
		).toEqual(outcome);

		const store = openScopeStore(fixture.scope);
		try {
			store.removeIfExistsDescriptor("fixture.jsonl");
		} finally {
			store.close();
		}
		const reopenedScope = makeScope(fixture.agentDir, fixture.sessionsRoot, fixture.cwd);
		const replayed = await readManagedGcSessionRetirementReceipt(reopenedScope, fixture.transcriptPath);
		expect(replayed?.state).toBe(disposition.state);
		expect(replayed?.taskArtifactOwnerRetirementOutcome).toEqual(outcome);
		expect(replayed?.taskArtifactOwnerRetired).toBe(outcome.kind === "completed" ? true : undefined);
	});

	it("rejects substituted later evidence and changed transcript identity", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const substitutedEvidence = immutableDeletionEvidence(
			fixture.evidence.sessionId,
			fixture.evidence.locator,
			{ ...fixture.evidence.parentIdentity, ino: String(BigInt(fixture.evidence.parentIdentity.ino) + 1n) },
			fixture.evidence.treeSnapshot,
		);
		await expect(
			publishManagedGcSessionRetirementReceipt(fixture.scope, {
				...fixture.target,
				state: "artifacts_removed",
				artifactsRemoved: true,
				taskArtifactOwnerDeletionEvidence: substitutedEvidence,
			}),
		).rejects.toThrow();

		const store = openScopeStore(fixture.scope);
		try {
			const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
			store.publishNoReplaceSync(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-artifacts_removed.json`,
				Buffer.from(
					`${JSON.stringify(substitutedReceiptRecord(fixture, substitutedEvidence, "artifacts_removed"))}\n`,
				),
			);
			store.publishNoReplaceSync(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-00000001.json`,
				Buffer.from(`${JSON.stringify(substitutedReceiptRecord(fixture, substitutedEvidence, "owner_pending"))}\n`),
			);
		} finally {
			store.close();
		}
		await expect(readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath)).rejects.toThrow();
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
		).rejects.toThrow();

		const replacedTranscript = makeFixture();
		await publishManagedGcSessionRetirementReceipt(replacedTranscript.scope, preparedReceipt(replacedTranscript));
		const replacementStore = openScopeStore(replacedTranscript.scope);
		try {
			const old = replacementStore.readExpected("fixture.jsonl");
			if (!old) throw new Error("fixture_transcript_missing");
			replacementStore.replaceExpected(
				"fixture.jsonl",
				Buffer.concat([old.bytes, Buffer.from('{"extra":true}\n')]),
				old,
			);
		} finally {
			replacementStore.close();
		}
		await expect(
			readManagedGcSessionRetirementReceipt(replacedTranscript.scope, replacedTranscript.transcriptPath),
		).rejects.toThrow();
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(replacedTranscript.scope, replacedTranscript.transcriptPath),
		).rejects.toThrow();
	});

	it("rejects wrong profile/root scope and transcripts outside the trusted scope parent", () => {
		const fixture = makeFixture();
		const originalAgentDir = fixture.scope.agentDir;
		fixture.scope.agentDir = path.join(fixture.temporaryRoot, "other-profile");
		expect(() => taskArtifactOwnerStorageContextForScope(fixture.scope)).toThrow();
		fixture.scope.agentDir = originalAgentDir;
		const originalSessionsRoot = fixture.scope.sessionsRoot;
		fixture.scope.sessionsRoot = path.join(fixture.temporaryRoot, "other-sessions");
		expect(() => taskArtifactOwnerStorageContextForScope(fixture.scope)).toThrow();
		fixture.scope.sessionsRoot = originalSessionsRoot;
		expect(() =>
			bindManagedGcSessionRetirementTarget(fixture.scope, path.join(fixture.temporaryRoot, "outside.jsonl")),
		).toThrow();
	});

	it("reads owner journals without recovery effects or changes to managed bytes, modes, ctimes, or private directories", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const before = snapshotTree(fixture.temporaryRoot);
		const openRecoveryFsRoot = spyOn(native, "openRecoveryFsRoot").mockImplementation(() => {
			throw new Error("readonly_recovery_open_called");
		});
		const retainedAuthority = managedDirectoryAuthorityForScope(fixture.scope);
		const retainManagedDirectory = retainedAuthority
			? spyOn(retainedAuthority, "retainManagedDirectory").mockImplementation(() => {
					throw new Error("readonly_recovery_retain_called");
				})
			: undefined;
		try {
			expect(
				(await readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath))?.state,
			).toBe("prepared");
			const resolved = resolveManagedGcScopeForRead({
				cwd: fixture.cwd,
				agentDir: fixture.agentDir,
				sessionsRoot: fixture.sessionsRoot,
			});
			expect(resolved.kind).toBe("resolved");
			if (resolved.kind !== "resolved") throw new Error(`readonly_scope_resolution_failed:${resolved.code}`);
			expect(
				(await readManagedGcSessionRetirementReceiptReadOnly(resolved.scope, fixture.transcriptPath))?.state,
			).toBe("prepared");
			const discovered = await discoverManagedGcSessionRetirementReceipts({
				agentDir: fixture.agentDir,
				sessionsRoot: fixture.sessionsRoot,
			});
			expect(discovered.map(item => item.receipt.transcriptPath)).toContain(fixture.transcriptPath);

			const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
			const continuation = uncertainContinuation(fixture);
			expect(verifyTaskArtifactOwnerRetirementContinuation(context, fixture.evidence, continuation)).toEqual(
				continuation,
			);
			const identity = managedDirectoryIdentityForScope(fixture.scope);
			const unboundReaderPath = path.join(fixture.scope.directoryPath, "must-not-be-initialized");
			expect(
				() =>
					new ManagedSessionDescendantStore(
						context.rootAuthority,
						unboundReaderPath,
						undefined,
						context.securityPolicy,
						context.profileAgentDir,
						undefined,
						"read-only",
					),
			).toThrow("managed_read_store_requires_existing_identity");
			expect(fs.existsSync(unboundReaderPath)).toBe(false);
			const reader = new ManagedSessionDescendantStore(
				context.rootAuthority,
				fixture.scope.directoryPath,
				undefined,
				context.securityPolicy,
				context.profileAgentDir,
				{
					canonicalPath: fixture.scope.directoryPath,
					dev: BigInt.asUintN(64, identity.dev),
					ino: BigInt.asUintN(64, identity.ino),
				},
				"read-only",
			);
			try {
				expect(() => reader.ensureDirectory("must-not-be-created")).toThrow("managed_store_read_only");
				expect(() => reader.moveFileNoReplace("source", "destination", undefined as never)).toThrow(
					"managed_store_read_only",
				);
				expect(() => reader.retainAuthority()).toThrow("managed_store_read_only");
			} finally {
				reader.close();
			}
			expect(openRecoveryFsRoot).not.toHaveBeenCalled();
			if (retainManagedDirectory) expect(retainManagedDirectory).not.toHaveBeenCalled();
			expect(snapshotTree(fixture.temporaryRoot)).toEqual(before);
		} finally {
			retainManagedDirectory?.mockRestore();
			openRecoveryFsRoot.mockRestore();
		}
	});

	it("discovers original prepared authority in a fresh process after transcript absence", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const store = openScopeStore(fixture.scope);
		try {
			store.removeIfExistsDescriptor(path.basename(fixture.transcriptPath));
		} finally {
			store.close();
		}
		const moduleUrl = new URL("../src/session/internal/managed-session-scope.ts", import.meta.url).href;
		const script =
			`import { discoverManagedGcSessionRetirementReceipts } from ${JSON.stringify(moduleUrl)};
` +
			`  const records = await discoverManagedGcSessionRetirementReceipts({
` +
			`    agentDir: ${JSON.stringify(fixture.agentDir)},
` +
			`    sessionsRoot: ${JSON.stringify(fixture.sessionsRoot)},
` +
			`  });
` +
			`  process.stdout.write(JSON.stringify(records.map(({ receipt }) => ({
` +
			`    transcriptPath: receipt.transcriptPath, state: receipt.state,
` +
			`  }))));
`;
		const child = Bun.spawnSync({
			cmd: [process.execPath, "-e", script],
			cwd: fixture.temporaryRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		expect(JSON.parse(Buffer.from(child.stdout).toString("utf8"))).toContainEqual({
			transcriptPath: fixture.transcriptPath,
			state: "prepared",
		});
		expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
	});

	it("rejects forged prepared target identity and transcript-key substitution", async () => {
		const fixture = makeFixture();
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const forged = {
			schemaVersion: 1,
			state: "prepared",
			scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
			transcriptPath: fixture.transcriptPath,
			sessionId: fixture.target.sessionId,
			cwd: fixture.cwd,
			taskArtifactOwnerLocator: fixture.target.taskArtifactOwnerLocator,
			transcriptIdentity: {
				...managedGcRetirementIdentityRecord(fixture.target.transcriptIdentity),
				ino: (fixture.target.transcriptIdentity.ino + 1n).toString(),
			},
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		};
		const substitutedPath = path.join(fixture.scope.directoryPath, "substituted.jsonl");
		const substitutedKey = crypto.createHash("sha256").update(path.resolve(substitutedPath), "utf8").digest("hex");
		const store = openScopeStore(fixture.scope);
		try {
			for (const receiptKey of [key, substitutedKey]) {
				store.publishNoReplaceSync(
					`.gjc-managed-session-internal/receipts/gc-retirement-${receiptKey}-prepared.json`,
					Buffer.from(`${JSON.stringify(forged)}\n`, "utf8"),
				);
			}
		} finally {
			store.close();
		}
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
		).rejects.toThrow();
		await expect(readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, substitutedPath)).rejects.toThrow();
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		expect(
			fs.readFileSync(
				path.join(
					ownerAbsolutePath(
						taskArtifactOwnerStorageContextForScope(fixture.scope),
						fixture.target.taskArtifactOwnerLocator.ownerId,
					),
					"payload.json",
				),
				"utf8",
			),
		).toBe("fixture payload");
	});

	it("accepts canonical attempt ten and rejects malformed and filename-mismatched attempts", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		for (let attempt = 1; attempt <= 10; attempt++)
			await publishManagedGcSessionRetirementReceipt(fixture.scope, pendingReceipt(fixture, `attempt-${attempt}`));
		expect(
			(await readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath))
				?.ownerRetirementAttempt,
		).toBe(10);

		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const relativePath = `.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-00000010.json`;
		const record = readReceiptSuffix(fixture, "owner_pending-00000010") as Record<string, unknown>;
		const store = openScopeStore(fixture.scope);
		try {
			store.publishNoReplaceSync(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-000000010.json`,
				Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
			);
		} finally {
			store.close();
		}
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
		).rejects.toThrow("task_artifact_owner_continuation_corrupt");

		const replacementStore = openScopeStore(fixture.scope);
		try {
			replacementStore.removeIfExistsDescriptor(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-000000010.json`,
			);
			const existing = replacementStore.readExpected(relativePath);
			if (!existing) throw new Error("fixture_attempt_ten_missing");
			replacementStore.replaceExpected(
				relativePath,
				Buffer.from(`${JSON.stringify({ ...record, ownerRetirementAttempt: 11 })}\n`, "utf8"),
				existing,
			);
		} finally {
			replacementStore.close();
		}
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
		).rejects.toThrow("task_artifact_owner_continuation_state_missing");
	});

	it("rejects a genuine payload shrink followed by reintroduction in persisted pending history", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
		const ownerPath = ownerAbsolutePath(context, fixture.target.taskArtifactOwnerLocator.ownerId);
		const payloadPath = path.join(ownerPath, "payload.json");
		const originalPayload = fs.readFileSync(payloadPath);
		const rootStore = newSessionRootStore(context);
		const captureTree = () =>
			rootStore.captureTree(ownerRelativePath(fixture.target.taskArtifactOwnerLocator.ownerId));
		const replacePayloadInPlace = (bytes: Buffer): void => {
			const before = fs.lstatSync(payloadPath, { bigint: true });
			if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
				throw new Error("fixture_payload_identity_invalid");
			const descriptor = fs.openSync(payloadPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
			try {
				const opened = fs.fstatSync(descriptor, { bigint: true });
				if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("fixture_payload_replaced");
				fs.ftruncateSync(descriptor, 0);
				if (bytes.byteLength > 0) fs.writeSync(descriptor, bytes, 0, bytes.byteLength, 0);
				fs.fsyncSync(descriptor);
			} finally {
				fs.closeSync(descriptor);
			}
			const after = fs.lstatSync(payloadPath, { bigint: true });
			if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1n)
				throw new Error("fixture_payload_identity_changed");
		};
		try {
			const initialContinuation = uncertainContinuation(fixture);
			expect(captureTree()).toEqual(fixture.evidence.treeSnapshot);
			const first: ManagedGcSessionRetirementReceipt = {
				...fixture.target,
				state: "owner_pending",
				taskArtifactOwnerDeletionEvidence: fixture.evidence,
				taskArtifactOwnerRetirementOutcome: {
					kind: "uncertain",
					evidence: fixture.evidence,
					continuation: initialContinuation,
					reason: "genuine_initial_tree",
				},
				taskArtifactOwnerRetirementContinuation: initialContinuation,
			};
			await publishManagedGcSessionRetirementReceipt(fixture.scope, first);

			const expansionStore = rootStore.deriveSubtree(
				ownerRelativePath(fixture.target.taskArtifactOwnerLocator.ownerId),
			);
			let expandedContinuation: TaskArtifactOwnerRetirementContinuation | undefined;
			try {
				expansionStore.publishNoReplaceSync("temporary-expansion.txt", Buffer.from("new retained path", "utf8"));
				expandedContinuation = {
					...initialContinuation,
					retainedTreeSnapshot: captureTree(),
				};
			} finally {
				expansionStore.removeIfExistsDescriptor("temporary-expansion.txt");
				expansionStore.close();
			}
			if (!expandedContinuation) throw new Error("fixture_expanded_continuation_missing");
			const expanded: ManagedGcSessionRetirementReceipt = {
				...first,
				taskArtifactOwnerRetirementOutcome: {
					kind: "uncertain",
					evidence: fixture.evidence,
					continuation: expandedContinuation,
					reason: "genuine_tree_expansion",
				},
				taskArtifactOwnerRetirementContinuation: expandedContinuation,
			};
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, expanded)).rejects.toThrow(
				"task_artifact_owner_continuation_authority_mismatch",
			);

			replacePayloadInPlace(Buffer.alloc(0));
			const shrunkContinuation: TaskArtifactOwnerRetirementContinuation = {
				...initialContinuation,
				retainedTreeSnapshot: captureTree(),
			};
			const shrunk: ManagedGcSessionRetirementReceipt = {
				...first,
				taskArtifactOwnerRetirementOutcome: {
					kind: "uncertain",
					evidence: fixture.evidence,
					continuation: shrunkContinuation,
					reason: "genuine_payload_shrink",
				},
				taskArtifactOwnerRetirementContinuation: shrunkContinuation,
			};
			await publishManagedGcSessionRetirementReceipt(fixture.scope, shrunk);

			replacePayloadInPlace(originalPayload);
			const reintroducedContinuation: TaskArtifactOwnerRetirementContinuation = {
				...initialContinuation,
				retainedTreeSnapshot: captureTree(),
			};
			const reintroducedOutcome = {
				kind: "uncertain" as const,
				evidence: fixture.evidence,
				continuation: reintroducedContinuation,
				reason: "genuine_payload_reintroduction",
			};
			const reintroduced: ManagedGcSessionRetirementReceipt = {
				...first,
				taskArtifactOwnerRetirementOutcome: reintroducedOutcome,
				taskArtifactOwnerRetirementContinuation: reintroducedContinuation,
			};
			const beforeRejectedAppend = managedReceiptInventory(fixture.scope);
			await expect(publishManagedGcSessionRetirementReceipt(fixture.scope, reintroduced)).rejects.toThrow(
				"task_artifact_owner_continuation_authority_mismatch",
			);
			expect(managedReceiptInventory(fixture.scope)).toEqual(beforeRejectedAppend);

			const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
			const forgedRecord = {
				schemaVersion: 1,
				state: "owner_pending",
				scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
				transcriptPath: fixture.transcriptPath,
				sessionId: fixture.target.sessionId,
				cwd: fixture.target.cwd,
				transcriptIdentity: managedGcRetirementIdentityRecord(fixture.target.transcriptIdentity),
				taskArtifactOwnerDeletionEvidence: fixture.evidence,
				ownerRetirementAttempt: 3,
				artifactsRemoved: true,
				taskArtifactOwnerRetirementOutcome: reintroducedOutcome,
				taskArtifactOwnerRetirementContinuation: reintroducedContinuation,
			};
			const journalStore = openScopeStore(fixture.scope);
			try {
				journalStore.publishNoReplaceSync(
					`.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-00000003.json`,
					Buffer.from(`${JSON.stringify(forgedRecord)}\n`, "utf8"),
				);
			} finally {
				journalStore.close();
			}
			await expect(
				readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
			).rejects.toThrow("task_artifact_owner_continuation_authority_mismatch");
		} finally {
			rootStore.close();
		}
	});

	it("rejects a numbered-attempt gap and later states without prepared authority", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		await publishManagedGcSessionRetirementReceipt(fixture.scope, pendingReceipt(fixture, "first_attempt"));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, pendingReceipt(fixture, "second_attempt"));
		const store = openScopeStore(fixture.scope);
		try {
			const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
			store.removeIfExistsDescriptor(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-00000001.json`,
			);
		} finally {
			store.close();
		}
		await expect(readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath)).rejects.toThrow();

		const noPrepared = makeFixture();
		const malformedJournal = openScopeStore(noPrepared.scope);
		try {
			const key = crypto.createHash("sha256").update(path.resolve(noPrepared.transcriptPath), "utf8").digest("hex");
			malformedJournal.publishNoReplaceSync(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-artifacts_removed.json`,
				Buffer.from("{}\n", "utf8"),
			);
		} finally {
			malformedJournal.close();
		}
		await expect(
			readManagedGcSessionRetirementReceipt(noPrepared.scope, noPrepared.transcriptPath),
		).rejects.toThrow();
	});

	it("discovers prepared authority after transcript absence instead of rebinding from a later receipt", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const store = openScopeStore(fixture.scope);
		try {
			store.removeIfExistsDescriptor("fixture.jsonl");
		} finally {
			store.close();
		}
		const reopenedScope = makeScope(fixture.agentDir, fixture.sessionsRoot, fixture.cwd);
		const recovered = await readManagedGcSessionRetirementReceipt(reopenedScope, fixture.transcriptPath);
		expect(recovered?.state).toBe("prepared");
		expect(recovered?.sessionId).toBe(fixture.target.sessionId);
		const laterReceipt = readReceiptSuffix(fixture, "prepared");
		expect((laterReceipt as Record<string, unknown>).state).toBe("prepared");
	});
});
