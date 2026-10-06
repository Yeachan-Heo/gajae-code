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
	MANAGED_SESSION_READ_RANGE_MAX_BYTES,
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
}

const temporaryRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	ManagedSessionScopeTestHooks.beforeVerifiedDelete = undefined;
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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
			`gc-retirement-${crypto.createHash("sha256").update(fixture.transcriptPath).digest("hex")}.lock`,
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
			`gc-retirement-${crypto.createHash("sha256").update(fixture.transcriptPath).digest("hex")}.lock`,
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

function makeFixture(sessionId = "managed-gc-journal-fixture", transcriptFileName = "fixture.jsonl"): Fixture {
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
	return { temporaryRoot, agentDir, sessionsRoot, cwd, scope, transcriptPath, target, evidence };
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

function exactLimitSessionId(fixture: Fixture, transcriptFileName: string): string | undefined {
	const recordBytes = preparedReceiptLineByteLength(fixture);
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
		const fixture = makeFixture(exactChoice.sessionId, exactChoice.transcriptFileName);
		const published = await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		expect(published.state).toBe("prepared");
		expect(published.sessionId).toBe(exactChoice.sessionId);

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
						id: exactChoice.sessionId,
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
	});

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
