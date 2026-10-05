import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	bindManagedGcSessionRetirementTarget,
	type ManagedGcProtocolScopeInput,
	type ManagedScope,
	managedGcProtocolScopeInspectorForScope,
	prepareManagedSessionScopeForWriteSync,
	publishManagedGcSessionRetirementReceipt,
	resolveManagedScopeForWrite,
} from "../src/session/internal/managed-session-scope";
import {
	acquireManagedLock,
	captureManagedFileNoFollow,
	isManagedLockQuarantineName,
	type ManagedDirectoryRoot,
	ManagedSessionDescendantStore,
	prepareManagedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	newSessionRootStore,
} from "../src/session/internal/task-artifact-owner-access";
import { FileSessionStorage, type VerifiedSessionDeleteTarget } from "../src/session/session-storage";
import {
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerAbsolutePath,
	ownerIdForSession,
	ownerRelativePath,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner-codec";
import { retireTaskArtifactOwner } from "../src/session/task-artifact-owner-retirement";

interface Fixture {
	readonly root: string;
	readonly profileAgentDir: string;
	readonly sessionsRoot: string;
	readonly cwd: string;
	readonly sessionId: string;
	readonly context: TaskArtifactOwnerStorageContext;
	readonly locator: TaskArtifactOwnerLocator;
	readonly ownerPath: string;
	readonly ownerPayloadPath: string;
	readonly transcriptPath: string;
	readonly scope: ManagedScope;
	readonly evidence: TaskArtifactOwnerDeletionEvidence;
	readonly storage: FileSessionStorage;
}

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function expectedDirectoryRoot(pathname: string): ManagedDirectoryRoot {
	const stat = fs.lstatSync(pathname, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixture_directory_invalid");
	return {
		canonicalPath: path.resolve(pathname),
		dev: BigInt.asUintN(64, stat.dev),
		ino: BigInt.asUintN(64, stat.ino),
	};
}

function makeManagedScope(fixture: Pick<Fixture, "profileAgentDir" | "sessionsRoot" | "context">, cwd: string) {
	const resolved = resolveManagedScopeForWrite({
		cwd,
		agentDir: fixture.profileAgentDir,
		sessionsRoot: fixture.sessionsRoot,
	});
	if (resolved.kind !== "resolved") throw new Error(`fixture_scope_failed:${resolved.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope, fixture.context.securityPolicy);
	if (prepared.kind !== "resolved") throw new Error(`fixture_scope_prepare_failed:${prepared.code}`);
	return resolved.scope;
}

function writeTranscript(
	pathname: string,
	id: string,
	cwd: string,
	locator: TaskArtifactOwnerLocator,
	extra = "",
): void {
	fs.writeFileSync(
		pathname,
		`${JSON.stringify({ type: "session", id, cwd, version: 4, taskArtifactOwner: locator })}\n${extra}`,
		{ mode: 0o600 },
	);
}

async function makeFixture(): Promise<Fixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-owner-storage-"));
	roots.push(root);
	const profileAgentDir = path.join(root, "profile");
	const sessionsRoot = path.join(profileAgentDir, "sessions");
	const cwd = path.join(root, "workspace-a");
	fs.mkdirSync(profileAgentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(sessionsRoot, { mode: 0o700 });
	fs.mkdirSync(cwd, { mode: 0o700 });
	const securityPolicy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
	const context: TaskArtifactOwnerStorageContext = {
		rootAuthority: prepareManagedDirectoryRoot(profileAgentDir, securityPolicy),
		sessionsRoot,
		securityPolicy,
		profileAgentDir,
	};
	const sessionId = `owner-storage-${crypto.randomUUID()}`;
	const locator: TaskArtifactOwnerLocator = {
		schemaVersion: OWNER_SCHEMA_VERSION,
		ownerId: ownerIdForSession(sessionId),
		directoryDev: "0",
		directoryIno: "0",
	};
	const rootStore = newSessionRootStore(context);
	let ownerStore: ManagedSessionDescendantStore | undefined;
	let ownerPath = ownerAbsolutePath(context, locator.ownerId);
	try {
		rootStore.verifyRootSecurity();
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const ownerRoot = rootStore.ensureDirectory(ownerRelativePath(locator.ownerId));
		Object.assign(locator, { directoryDev: ownerRoot.dev.toString(), directoryIno: ownerRoot.ino.toString() });
		ownerPath = ownerAbsolutePath(context, locator.ownerId);
		ownerStore = new ManagedSessionDescendantStore(
			context.rootAuthority,
			ownerPath,
			undefined,
			securityPolicy,
			profileAgentDir,
			ownerRoot,
		);
		await ownerStore.publishNoReplace(
			OWNER_MANIFEST,
			Buffer.from(`${JSON.stringify({ ...locator, sessionId })}\n`, "utf8"),
		);
		await ownerStore.publishNoReplace("payload.bin", Buffer.from("owner-payload", "utf8"));
	} finally {
		ownerStore?.close();
		rootStore.close();
	}
	const scope = makeManagedScope({ profileAgentDir, sessionsRoot, context }, cwd);
	const sessionDir = scope.directoryPath;
	const transcriptPath = path.join(sessionDir, `${sessionId}.jsonl`);
	writeTranscript(transcriptPath, sessionId, cwd, locator);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(context, sessionId, locator);
	if (!evidence) throw new Error("fixture_owner_evidence_missing");
	return {
		root,
		profileAgentDir,
		sessionsRoot,
		cwd,
		sessionId,
		context,
		locator,
		ownerPath,
		ownerPayloadPath: path.join(ownerPath, "payload.bin"),
		transcriptPath,
		scope,
		evidence,
		storage: new FileSessionStorage(),
	};
}

function targetFor(fixture: Fixture, updates: Partial<VerifiedSessionDeleteTarget> = {}): VerifiedSessionDeleteTarget {
	const snapshot = fixture.storage.readSnapshotSync(fixture.transcriptPath);
	const parent = fs.lstatSync(path.dirname(fixture.transcriptPath), { bigint: true });
	return {
		sessionsRoot: fixture.sessionsRoot,
		transcriptPath: fixture.transcriptPath,
		sessionId: fixture.sessionId,
		cwd: fixture.cwd,
		transcriptIdentity: {
			dev: snapshot.stat.dev,
			ino: snapshot.stat.ino,
			nlink: snapshot.stat.nlink,
			size: snapshot.stat.size,
			mtimeNs: snapshot.stat.mtimeNs,
			sha256: crypto.createHash("sha256").update(snapshot.bytes).digest("hex"),
		},
		transcriptParentIdentity: { dev: parent.dev, ino: parent.ino },
		artifactsAbsentAtAuthorization: true,
		plannedArtifactsPath: path.join(
			path.dirname(fixture.transcriptPath),
			`.gjc-delete-artifacts-${crypto.randomUUID()}`,
		),
		plannedTranscriptPath: path.join(
			path.dirname(fixture.transcriptPath),
			`.gjc-delete-transcript-${crypto.randomUUID()}`,
		),
		taskArtifactOwnerStorageContext: fixture.context,
		taskArtifactOwnerDeletionEvidence: fixture.evidence,
		...updates,
	};
}

function protocolInputFor(scope: ManagedScope): ManagedGcProtocolScopeInput {
	const scopeStat = fs.lstatSync(scope.directoryPath, { bigint: true });
	const bindingPath = path.join(scope.directoryPath, ".gjc-managed-session-scope.v2.json");
	const binding = captureManagedFileNoFollow(bindingPath);
	const bindingStat = fs.lstatSync(bindingPath, { bigint: true });
	const protocolPath = path.join(scope.directoryPath, ".gjc-managed-session-internal");
	const protocolStat = fs.lstatSync(protocolPath, { bigint: true });
	return {
		scopePath: scope.directoryPath,
		scopeIdentity: {
			path: scope.directoryPath,
			dev: scopeStat.dev.toString(),
			ino: scopeStat.ino.toString(),
		},
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

function filesystemSnapshot(root: string): unknown[] {
	const entries: unknown[] = [];
	const visit = (pathname: string, relative: string): void => {
		const stat = fs.lstatSync(pathname, { bigint: true });
		const kind = stat.isSymbolicLink()
			? "symlink"
			: stat.isDirectory()
				? "directory"
				: stat.isFile()
					? "file"
					: "other";
		entries.push({
			path: relative,
			kind,
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			nlink: stat.nlink.toString(),
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			mode: Number(stat.mode & 0o777n),
			...(kind === "file" ? { bytes: fs.readFileSync(pathname) } : {}),
			...(kind === "symlink" ? { link: fs.readlinkSync(pathname) } : {}),
		});
		if (kind === "directory")
			for (const name of fs.readdirSync(pathname).sort())
				visit(path.join(pathname, name), relative ? path.join(relative, name) : name);
	};
	visit(root, "");
	return entries;
}

function deleteVerified(fixture: Fixture, target: VerifiedSessionDeleteTarget) {
	return fixture.storage.deleteSessionVerified(target, managedGcProtocolScopeInspectorForScope(fixture.scope));
}

function fieldsForOutcome(outcome: TaskArtifactOwnerRetirementOutcome) {
	return {
		taskArtifactOwnerRetirementOutcome: outcome,
		...(outcome.kind === "completed" ? { taskArtifactOwnerRetired: true as const } : {}),
		...(outcome.kind === "payload_retired"
			? { taskArtifactOwnerPayloadRetired: true as const, taskArtifactOwnerNamespaceRetained: true as const }
			: {}),
		...(outcome.kind !== "completed" ? { taskArtifactOwnerRetirementContinuation: outcome.continuation } : {}),
	};
}

function recordActualOwnerRemoval() {
	const remove = native.exactRemoveDirectoryTree;
	const calls: native.NativeExactUnlinkResult[] = [];
	const spy = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation((...args) => {
		const result = remove(...args);
		calls.push(result);
		return result;
	});
	return { calls, spy };
}

describe("verified storage consumes task artifact owners", () => {
	it("authenticates a real prepared GC journal and exact protocol roles without mutation", async () => {
		const fixture = await makeFixture();
		const target = bindManagedGcSessionRetirementTarget(fixture.scope, fixture.transcriptPath);
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...target,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		});
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		const lock = await acquireManagedLock(
			path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "locks"),
			`gc-retirement-${crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath)).digest("hex")}`,
			fixture.context.rootAuthority,
		);
		try {
			const before = filesystemSnapshot(fixture.root);
			const [snapshot] = await inspect([protocolInputFor(fixture.scope)]);
			expect(snapshot?.scope.path).toBe(fixture.scope.directoryPath);
			expect(snapshot?.directories.map(directory => directory.role)).toEqual(["locks", "receipts", "tombstones"]);
			const lockFiles = snapshot?.directories.find(directory => directory.role === "locks")?.files ?? [];
			const lockQuarantines = lockFiles.filter(file => isManagedLockQuarantineName(file.name));
			expect(lockFiles.filter(file => !isManagedLockQuarantineName(file.name))).toHaveLength(1);
			if (process.platform !== "win32") expect(lockQuarantines.length).toBeGreaterThan(0);
			for (const quarantine of lockQuarantines) {
				expect(quarantine.size).toBe(0);
				expect(quarantine.sha256).toBe(crypto.createHash("sha256").digest("hex"));
			}
			expect(snapshot?.directories.find(directory => directory.role === "receipts")?.files).toHaveLength(1);
			expect(filesystemSnapshot(fixture.root)).toEqual(before);
		} finally {
			await lock.release();
		}
	});

	it("fails closed on unknown, symlinked, replaced, and foreign protocol authority without mutation", async () => {
		const fixture = await makeFixture();
		const bound = bindManagedGcSessionRetirementTarget(fixture.scope, fixture.transcriptPath);
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...bound,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		});
		const inspect = managedGcProtocolScopeInspectorForScope(fixture.scope);
		const nativeRemoval = recordActualOwnerRemoval();
		const artifactPath = fixture.transcriptPath.slice(0, -".jsonl".length);
		fs.mkdirSync(artifactPath, { mode: 0o700 });
		fs.writeFileSync(path.join(artifactPath, "keep.bin"), "artifact", { mode: 0o600 });
		const protocolPath = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal");
		const locksPath = path.join(protocolPath, "locks");
		const malformedQuarantinePath = path.join(locksPath, `.gjc-lock-${crypto.randomUUID()}.stale`);
		fs.writeFileSync(malformedQuarantinePath, "not-scrubbed", { mode: 0o600 });
		let before = filesystemSnapshot(fixture.root);
		await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow(
			`managed_gc_protocol_lock_quarantine_invalid [locks/${path.basename(malformedQuarantinePath)}]`,
		);
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		const malformed = await fixture.storage.deleteSessionVerified(targetFor(fixture), inspect);
		expect(malformed.kind).toBe("cleanup_pending");
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
		fs.unlinkSync(malformedQuarantinePath);

		const unknownPath = path.join(protocolPath, "unexpected-role");
		fs.mkdirSync(unknownPath, { mode: 0o700 });
		before = filesystemSnapshot(fixture.root);
		await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow("managed_gc_protocol_roles_invalid");
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		const unknown = await fixture.storage.deleteSessionVerified(targetFor(fixture), inspect);
		expect(unknown.kind).toBe("cleanup_pending");
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
		fs.rmdirSync(unknownPath);

		const savedLocksPath = path.join(protocolPath, "locks.saved");
		fs.renameSync(locksPath, savedLocksPath);
		fs.symlinkSync(savedLocksPath, locksPath);
		before = filesystemSnapshot(fixture.root);
		await expect(inspect([protocolInputFor(fixture.scope)])).rejects.toThrow();
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		const symlinked = await fixture.storage.deleteSessionVerified(targetFor(fixture), inspect);
		expect(symlinked.kind).toBe("cleanup_pending");
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
		fs.unlinkSync(locksPath);
		fs.renameSync(savedLocksPath, locksPath);

		const staleInput = protocolInputFor(fixture.scope);
		const savedProtocolPath = `${protocolPath}.saved`;
		fs.renameSync(protocolPath, savedProtocolPath);
		fs.mkdirSync(protocolPath, { mode: 0o700 });
		for (const role of ["locks", "receipts", "tombstones"])
			fs.mkdirSync(path.join(protocolPath, role), { mode: 0o700 });
		before = filesystemSnapshot(fixture.root);
		await expect(inspect([staleInput])).rejects.toThrow("managed_gc_protocol_root_identity_mismatch");
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		const replaced = await fixture.storage.deleteSessionVerified(targetFor(fixture), inspect);
		expect(replaced.kind).toBe("cleanup_pending");
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		expect(nativeRemoval.spy).not.toHaveBeenCalled();

		const foreign = await makeFixture();
		const foreignInspect = managedGcProtocolScopeInspectorForScope(foreign.scope);
		const sourceBefore = filesystemSnapshot(fixture.root);
		const foreignBefore = filesystemSnapshot(foreign.root);
		const foreignTarget = await fixture.storage.deleteSessionVerified(targetFor(fixture), foreignInspect);
		expect(foreignTarget.kind).toBe("cleanup_pending");
		expect(filesystemSnapshot(fixture.root)).toEqual(sourceBefore);
		expect(filesystemSnapshot(foreign.root)).toEqual(foreignBefore);
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
	});

	it("keeps direct owner retirement available without a protocol subtree or inspector", async () => {
		const fixture = await makeFixture();
		fs.rmSync(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal"), {
			recursive: true,
			force: false,
		});
		const nativeRemoval = recordActualOwnerRemoval();
		const result = await fixture.storage.deleteSessionVerified(targetFor(fixture));
		expect(["artifacts_removed", "cleanup_pending"]).toContain(result.kind);
		expect(nativeRemoval.spy).toHaveBeenCalled();
	});

	it("refuses protocol-bearing direct owner retirement without a Scope inspector before mutation", async () => {
		const fixture = await makeFixture();
		const gcTarget = bindManagedGcSessionRetirementTarget(fixture.scope, fixture.transcriptPath);
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...gcTarget,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		});
		const artifactPath = fixture.transcriptPath.slice(0, -".jsonl".length);
		fs.mkdirSync(artifactPath, { mode: 0o700 });
		fs.writeFileSync(path.join(artifactPath, "keep.bin"), "artifact", { mode: 0o600 });
		const nativeRemoval = recordActualOwnerRemoval();
		const target = targetFor(fixture);
		const recoveryOpen = vi.spyOn(native, "openRecoveryFsRoot");
		const retain = vi.spyOn(native.RecoveryFsRoot.prototype, "retainManagedDirectory");
		const before = filesystemSnapshot(fixture.root);
		const result = await fixture.storage.deleteSessionVerified(target);
		expect(recoveryOpen).not.toHaveBeenCalled();
		expect(retain).not.toHaveBeenCalled();
		expect(result.kind).toBe("cleanup_pending");
		expect(result).toMatchObject({ kind: "cleanup_pending", phase: "task_artifact_owner", artifactsRemoved: false });
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
		expect(fs.readFileSync(fixture.ownerPayloadPath, "utf8")).toBe("owner-payload");
		expect(fs.readFileSync(fixture.transcriptPath).byteLength).toBeGreaterThan(0);
	});

	it("retires a valid prepared-GC owner with the actual native outcome and replay evidence", async () => {
		const fixture = await makeFixture();
		const gcTarget = bindManagedGcSessionRetirementTarget(fixture.scope, fixture.transcriptPath);
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...gcTarget,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		});
		const nativeRemoval = recordActualOwnerRemoval();
		const artifactPhase = await deleteVerified(fixture, targetFor(fixture));
		if (artifactPhase.kind === "cleanup_pending") {
			expect(artifactPhase).toMatchObject({ phase: "task_artifact_owner", artifactsRemoved: true });
			expect(artifactPhase.taskArtifactOwnerRetired).toBeUndefined();
			expect(artifactPhase.taskArtifactOwnerRetirementOutcome?.nativeOutcome).toEqual(nativeRemoval.calls[0]);
			expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
			return;
		}
		expect(artifactPhase.kind).toBe("artifacts_removed");
		if (artifactPhase.taskArtifactOwnerRetirementOutcome?.kind === "completed") {
			expect(nativeRemoval.spy).toHaveBeenCalledTimes(1);
			expect(artifactPhase.taskArtifactOwnerRetirementOutcome.nativeOutcome).toEqual(nativeRemoval.calls[0]);
			expect(artifactPhase.taskArtifactOwnerRetired).toBe(true);
			expect(fs.existsSync(fixture.ownerPath)).toBe(false);
		}
		const ownerFields = {
			taskArtifactOwnerDeletionEvidence: artifactPhase.taskArtifactOwnerDeletionEvidence,
			...(artifactPhase.taskArtifactOwnerRetirementOutcome
				? { taskArtifactOwnerRetirementOutcome: artifactPhase.taskArtifactOwnerRetirementOutcome }
				: {}),
			...(artifactPhase.taskArtifactOwnerRetired ? { taskArtifactOwnerRetired: true as const } : {}),
			...(artifactPhase.taskArtifactOwnerRetirementContinuation
				? { taskArtifactOwnerRetirementContinuation: artifactPhase.taskArtifactOwnerRetirementContinuation }
				: {}),
			...(artifactPhase.taskArtifactOwnerPayloadRetired ? { taskArtifactOwnerPayloadRetired: true as const } : {}),
			...(artifactPhase.taskArtifactOwnerNamespaceRetained
				? { taskArtifactOwnerNamespaceRetained: true as const }
				: {}),
		};
		const deleted = await deleteVerified(fixture, targetFor(fixture, { ...ownerFields, artifactsRemoved: true }));
		expect(deleted.kind).toBe("deleted");
		expect(deleted.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
		expect(deleted.taskArtifactOwnerRetirementOutcome).toEqual(artifactPhase.taskArtifactOwnerRetirementOutcome);
		expect(deleted.taskArtifactOwnerRetired).toBe(true);
		expect(deleted.taskArtifactOwnerTranscriptDeleted).toBe(true);
		expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
	});

	it("resolves a valid owner header patch bound to the expected session", async () => {
		const fixture = await makeFixture();
		const patch = `${JSON.stringify({ type: "header_patch", patch: { taskArtifactOwner: fixture.locator } })}\n`;
		fs.writeFileSync(
			fixture.transcriptPath,
			`${JSON.stringify({ type: "session", id: fixture.sessionId, cwd: fixture.cwd, version: 4 })}\n${patch}`,
			{ mode: 0o600 },
		);
		const result = await deleteVerified(fixture, targetFor(fixture));
		expect(["artifacts_removed", "cleanup_pending"]).toContain(result.kind);
		expect(result.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
		expect(result.taskArtifactOwnerRetirementOutcome).toBeDefined();
		if (result.kind === "artifacts_removed") {
			expect(result.taskArtifactOwnerRetired).toBe(true);
			expect(fs.existsSync(fixture.ownerPath)).toBe(false);
		} else {
			if (result.kind !== "cleanup_pending") throw new Error(`Unexpected owner result: ${result.kind}`);
			expect(result.phase).toBe("task_artifact_owner");
			expect(result.taskArtifactOwnerRetired).toBeUndefined();
		}
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
	});

	it("does not provision an owner when a legacy transcript has no valid locator", async () => {
		const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-owner-legacy-storage-"));
		roots.push(sessionsRoot);
		const cwd = path.join(sessionsRoot, "workspace");
		fs.mkdirSync(cwd);
		const sessionId = `legacy-${crypto.randomUUID()}`;
		const transcriptPath = path.join(sessionsRoot, `${sessionId}.jsonl`);
		fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "session", id: sessionId, cwd, version: 3 })}\n`);
		const storage = new FileSessionStorage();
		const snapshot = storage.readSnapshotSync(transcriptPath);
		const parent = fs.lstatSync(sessionsRoot, { bigint: true });
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot,
			transcriptPath,
			sessionId,
			cwd,
			transcriptIdentity: {
				dev: snapshot.stat.dev,
				ino: snapshot.stat.ino,
				nlink: snapshot.stat.nlink,
				size: snapshot.stat.size,
				mtimeNs: snapshot.stat.mtimeNs,
				sha256: crypto.createHash("sha256").update(snapshot.bytes).digest("hex"),
			},
			transcriptParentIdentity: { dev: parent.dev, ino: parent.ino },
			artifactsAbsentAtAuthorization: true,
			plannedArtifactsPath: path.join(sessionsRoot, ".gjc-delete-legacy-artifacts"),
			plannedTranscriptPath: path.join(sessionsRoot, ".gjc-delete-legacy-transcript"),
		};
		const first = await storage.deleteSessionVerified(target);
		expect(first.kind).toBe("artifacts_removed");
		expect(first.taskArtifactOwnerDeletionEvidence).toBeUndefined();
		const deleted = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true });
		expect(deleted.kind).toBe("deleted");
		expect(deleted.taskArtifactOwnerRetirementOutcome).toBeUndefined();
		expect(fs.existsSync(path.join(sessionsRoot, OWNER_DIRECTORY))).toBe(false);
	});

	it("defers before owner payload retirement, then honors the coordinator's actual outcome", async () => {
		const fixture = await makeFixture();
		const nativeRemoval = recordActualOwnerRemoval();
		const target = targetFor(fixture, { deferTaskArtifactOwnerRetirement: true });
		const transcriptBefore = fs.readFileSync(fixture.transcriptPath);
		const payloadBefore = fs.readFileSync(fixture.ownerPayloadPath);
		const untrusted = await fixture.storage.deleteSessionVerified(target);
		expect(untrusted).toMatchObject({ kind: "cleanup_pending", phase: "task_artifact_owner" });
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(transcriptBefore);
		expect(fs.readFileSync(fixture.ownerPayloadPath)).toEqual(payloadBefore);
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
		const inspectProtocol = managedGcProtocolScopeInspectorForScope(fixture.scope);
		const before = await fixture.storage.deleteSessionVerified(target, inspectProtocol);
		expect(before.kind).toBe("artifacts_removed");
		expect(before.taskArtifactOwnerRetirementOutcome).toBeUndefined();
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
		expect(fs.existsSync(fixture.ownerPayloadPath)).toBe(true);
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);

		const outcome = retireTaskArtifactOwner(fixture.context, fixture.evidence);
		expect(nativeRemoval.spy).toHaveBeenCalled();
		const after = await fixture.storage.deleteSessionVerified(
			targetFor(fixture, {
				...fieldsForOutcome(outcome),
				artifactsRemoved: true,
				deferTaskArtifactOwnerRetirement: true,
			}),
			inspectProtocol,
		);
		expect(after.taskArtifactOwnerRetirementOutcome).toEqual(outcome);
		if (outcome.kind === "completed") {
			expect(after.kind).toBe("deleted");
			expect(after.taskArtifactOwnerRetired).toBe(true);
			expect(after.taskArtifactOwnerTranscriptDeleted).toBe(true);
			expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
		} else if (outcome.kind === "payload_retired") {
			expect(after.kind).toBe("deleted");
			expect(after.taskArtifactOwnerRetired).toBeUndefined();
			expect(after.taskArtifactOwnerPayloadRetired).toBe(true);
			expect(after.taskArtifactOwnerNamespaceRetained).toBe(true);
			expect(after.taskArtifactOwnerRetirementContinuation).toEqual(outcome.continuation);
		} else {
			expect(after.kind).toBe("artifacts_removed");
			expect(after.taskArtifactOwnerRetired).toBeUndefined();
			expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		}
	});

	it("refuses deferred retirement with an unauthenticated protocol alias before artifact effects", async () => {
		const fixture = await makeFixture();
		const artifacts = fixture.transcriptPath.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { mode: 0o700 });
		await Bun.write(path.join(artifacts, "retained-output.txt"), "retained-artifact", { mode: 0o600 });
		fs.mkdirSync(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal.saved"), { mode: 0o700 });
		const before = filesystemSnapshot(fixture.root);
		const nativeRemoval = recordActualOwnerRemoval();
		const result = await fixture.storage.deleteSessionVerified(
			targetFor(fixture, { deferTaskArtifactOwnerRetirement: true }),
			managedGcProtocolScopeInspectorForScope(fixture.scope),
		);
		expect(result).toMatchObject({ kind: "cleanup_pending", phase: "task_artifact_owner", artifactsRemoved: false });
		expect(nativeRemoval.spy).not.toHaveBeenCalled();
		expect(filesystemSnapshot(fixture.root)).toEqual(before);
	});

	it("rejects malformed owner patches, foreign locators, forged flags, and expanded evidence before mutation", async () => {
		const fixture = await makeFixture();
		const malformedPatch = `${JSON.stringify({
			type: "header_patch",
			patch: { taskArtifactOwner: fixture.locator, unrecognized: true },
		})}\n`;
		writeTranscript(fixture.transcriptPath, fixture.sessionId, fixture.cwd, fixture.locator, malformedPatch);
		const malformedBytes = fs.readFileSync(fixture.transcriptPath);
		await expect(fixture.storage.deleteSessionVerified(targetFor(fixture))).rejects.toThrow(
			"task_artifact_owner_patch_invalid",
		);
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(malformedBytes);
		expect(fs.readFileSync(fixture.ownerPayloadPath, "utf8")).toBe("owner-payload");

		const foreignId = `${fixture.locator.ownerId[0] === "a" ? "b" : "a"}${fixture.locator.ownerId.slice(1)}`;
		const foreignLocator = { ...fixture.locator, ownerId: foreignId };
		writeTranscript(fixture.transcriptPath, fixture.sessionId, fixture.cwd, foreignLocator);
		const foreignBytes = fs.readFileSync(fixture.transcriptPath);
		await expect(fixture.storage.deleteSessionVerified(targetFor(fixture))).rejects.toThrow(
			"task_artifact_owner_locator_mismatch",
		);
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(foreignBytes);

		writeTranscript(fixture.transcriptPath, fixture.sessionId, fixture.cwd, fixture.locator);
		const forgedTarget = targetFor(fixture, { taskArtifactOwnerRetired: true });
		const forgedBytes = fs.readFileSync(fixture.transcriptPath);
		await expect(fixture.storage.deleteSessionVerified(forgedTarget)).rejects.toThrow(
			"task_artifact_owner_retirement_outcome_mismatch",
		);
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(forgedBytes);
		await expect(
			fixture.storage.deleteSessionVerified(targetFor(fixture, { taskArtifactOwnerTranscriptDeleted: true })),
		).rejects.toThrow("task_artifact_owner_transcript_deleted_mismatch");
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(forgedBytes);

		const expandedEvidence = {
			...fixture.evidence,
			unrecognized: true,
		} as unknown as TaskArtifactOwnerDeletionEvidence;
		await expect(
			fixture.storage.deleteSessionVerified(
				targetFor(fixture, { taskArtifactOwnerDeletionEvidence: expandedEvidence }),
			),
		).rejects.toThrow("task_artifact_owner_evidence_invalid");
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(forgedBytes);
		expect(fs.readFileSync(fixture.ownerPayloadPath, "utf8")).toBe("owner-payload");
	});

	it("rejects an expanded retirement DTO after preserving the transcript", async () => {
		const fixture = await makeFixture();
		const outcome = retireTaskArtifactOwner(fixture.context, fixture.evidence);
		const expanded = { ...outcome, futureField: true } as unknown as TaskArtifactOwnerRetirementOutcome;
		const bytes = fs.readFileSync(fixture.transcriptPath);
		const target = targetFor(fixture, {
			...fieldsForOutcome(outcome),
			taskArtifactOwnerRetirementOutcome: expanded,
			deferTaskArtifactOwnerRetirement: true,
		});
		await expect(fixture.storage.deleteSessionVerified(target)).rejects.toThrow(
			"task_artifact_owner_retirement_outcome_invalid",
		);
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(bytes);
	});

	it("guards cross-cwd siblings and staged retained destination publications", async () => {
		const fixture = await makeFixture();
		const siblingCwd = path.join(fixture.root, "workspace-b");
		fs.mkdirSync(siblingCwd, { mode: 0o700 });
		const siblingScope = makeManagedScope(fixture, siblingCwd);
		const siblingId = `sibling-${crypto.randomUUID()}`;
		const siblingPath = path.join(siblingScope.directoryPath, `${siblingId}.jsonl`);
		writeTranscript(siblingPath, siblingId, siblingCwd, fixture.locator);

		const before = await deleteVerified(fixture, targetFor(fixture));
		expect(before.kind).toBe("cleanup_pending");
		if (before.kind !== "cleanup_pending") throw new Error("sibling_guard_did_not_block");
		expect(before.phase).toBe("task_artifact_owner");
		expect(fs.readFileSync(fixture.transcriptPath).byteLength).toBeGreaterThan(0);
		expect(fs.readFileSync(siblingPath).byteLength).toBeGreaterThan(0);
		expect(fs.readFileSync(fixture.ownerPayloadPath, "utf8")).toBe("owner-payload");
		fs.unlinkSync(siblingPath);

		const stageStore = new ManagedSessionDescendantStore(
			fixture.context.rootAuthority,
			siblingScope.directoryPath,
			undefined,
			fixture.context.securityPolicy,
			fixture.profileAgentDir,
			expectedDirectoryRoot(siblingScope.directoryPath),
		);
		let stagingPath: string;
		try {
			stageStore.ensureDirectory(".staging");
			stagingPath = path.join(siblingScope.directoryPath, ".staging", `${crypto.randomUUID()}.jsonl`);
		} finally {
			stageStore.close();
		}
		const stagedId = `staged-${crypto.randomUUID()}`;
		writeTranscript(stagingPath!, stagedId, siblingCwd, fixture.locator);
		const staged = await deleteVerified(fixture, targetFor(fixture));
		expect(staged.kind).toBe("cleanup_pending");
		expect(fs.readFileSync(stagingPath!).byteLength).toBeGreaterThan(0);
		expect(fs.readFileSync(fixture.ownerPayloadPath, "utf8")).toBe("owner-payload");
	});

	it("fails closed without repairing foreign modes or accepting descriptor replacement", async () => {
		const fixture = await makeFixture();
		const foreignCwd = path.join(fixture.root, "workspace-foreign");
		fs.mkdirSync(foreignCwd, { mode: 0o700 });
		const foreignScope = makeManagedScope(fixture, foreignCwd);
		const foreignStat = fs.lstatSync(foreignScope.directoryPath, { bigint: true });
		if (process.platform !== "win32") {
			fs.chmodSync(foreignScope.directoryPath, 0o777);
			const foreignMode = fs.statSync(foreignScope.directoryPath).mode & 0o777;
			const result = await deleteVerified(fixture, targetFor(fixture));
			expect(result.kind).toBe("cleanup_pending");
			expect(fs.statSync(foreignScope.directoryPath).mode & 0o777).toBe(foreignMode);
			expect(fs.lstatSync(foreignScope.directoryPath, { bigint: true }).ino).toBe(foreignStat.ino);
			expect(fs.readFileSync(fixture.transcriptPath).byteLength).toBeGreaterThan(0);
			expect(fs.readFileSync(fixture.ownerPayloadPath, "utf8")).toBe("owner-payload");
			fs.chmodSync(foreignScope.directoryPath, 0o700);
		}

		const siblingId = `replacement-${crypto.randomUUID()}`;
		const siblingPath = path.join(foreignScope.directoryPath, `${siblingId}.jsonl`);
		const siblingBytes = Buffer.from(
			`${JSON.stringify({ type: "session", id: siblingId, cwd: foreignCwd, version: 4 })}\n`,
			"utf8",
		);
		fs.writeFileSync(siblingPath, siblingBytes, { mode: 0o600 });
		const read = fixture.storage.readSnapshotSync.bind(fixture.storage);
		let replaced = false;
		vi.spyOn(fixture.storage, "readSnapshotSync").mockImplementation(pathname => {
			const snapshot = read(pathname);
			if (path.resolve(pathname) === path.resolve(siblingPath) && !replaced) {
				replaced = true;
				const replacement = `${siblingPath}.replacement`;
				fs.writeFileSync(replacement, siblingBytes, { mode: 0o600 });
				fs.renameSync(replacement, siblingPath);
			}
			return snapshot;
		});
		const result = await deleteVerified(fixture, targetFor(fixture));
		expect(replaced).toBe(true);
		expect(result.kind).toBe("cleanup_pending");
		expect(fs.readFileSync(siblingPath)).toEqual(siblingBytes);
		expect(fs.readFileSync(fixture.transcriptPath).byteLength).toBeGreaterThan(0);
		expect(fs.readFileSync(fixture.ownerPayloadPath, "utf8")).toBe("owner-payload");
	});
});
