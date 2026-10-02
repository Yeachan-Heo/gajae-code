import { expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeRm } from "../../../scripts/safe-cleanup";
import { Broker, type BrokerCleanupEvidence, type BrokerResponse } from "../src/sdk/broker/broker";
import { managedRootForScope, resolveManagedScope } from "../src/session/internal/managed-session-scope";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";
import * as taskArtifactOwner from "../src/session/task-artifact-owner";
import {
	ensureManagedTaskArtifactOwner,
	type TaskArtifactOwnerRetirementContinuation,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner";

type FileSnapshot = {
	relativePath: string;
	dev: bigint;
	ino: bigint;
	bytes: Buffer<ArrayBuffer>;
};

type OwnerFixture = {
	root: string;
	cwd: string;
	agentDir: string;
	sessionId: string;
	transcript: string;
	ownerDirectory: string;
	ownerIdentity: { dev: bigint; ino: bigint };
	ownerParentIdentity: { dev: bigint; ino: bigint };
	ownerFiles: FileSnapshot[];
	newerTranscript: string;
	newerTranscriptIdentity: { dev: bigint; ino: bigint };
	newerTranscriptBytes: Buffer<ArrayBuffer>;
	newerOwnerDirectory: string;
	newerOwnerIdentity: { dev: bigint; ino: bigint };
	newerOwnerFiles: FileSnapshot[];
};

async function regularFiles(root: string): Promise<FileSnapshot[]> {
	const files: FileSnapshot[] = [];
	const visit = async (directory: string, prefix: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const pathname = path.join(directory, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error("Task-artifact owner fixture unexpectedly contains a symlink");
			if (entry.isDirectory()) {
				await visit(pathname, relativePath);
				continue;
			}
			if (!entry.isFile()) throw new Error("Task-artifact owner fixture contains a non-regular entry");
			const stat = await fs.lstat(pathname, { bigint: true });
			files.push({ relativePath, dev: stat.dev, ino: stat.ino, bytes: await fs.readFile(pathname) });
		}
	};
	await visit(root, "");
	return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function createFixture(): Promise<OwnerFixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-sdk-delete-")));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "profile");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir);
	const saved = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	const owner = await saved.ensureArtifactManager();
	if (!owner) throw new Error("Expected managed task-artifact owner");
	await saved.saveArtifact("original task output", "probe");
	const sessionId = saved.getSessionId();
	const transcript = saved.getSessionFile()!;
	const ownerStat = await fs.stat(owner.dir, { bigint: true });
	const ownerParentStat = await fs.stat(path.dirname(owner.dir), { bigint: true });
	const ownerFiles = await regularFiles(owner.dir);
	if (ownerFiles.length === 0) throw new Error("Expected owner payload files");
	await saved.close();

	const newer = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	const newerOwner = await newer.ensureArtifactManager();
	if (!newerOwner) throw new Error("Expected newer managed task-artifact owner");
	await newer.saveArtifact("newer output stays", "probe");
	const newerTranscript = newer.getSessionFile()!;
	const newerTranscriptBytes = await fs.readFile(newerTranscript);
	const newerTranscriptStat = await fs.stat(newerTranscript, { bigint: true });
	const newerOwnerStat = await fs.stat(newerOwner.dir, { bigint: true });
	const newerOwnerFiles = await regularFiles(newerOwner.dir);
	await newer.close();

	return {
		root,
		cwd,
		agentDir,
		sessionId,
		transcript,
		ownerDirectory: owner.dir,
		ownerIdentity: { dev: ownerStat.dev, ino: ownerStat.ino },
		ownerParentIdentity: { dev: ownerParentStat.dev, ino: ownerParentStat.ino },
		ownerFiles,
		newerTranscript,
		newerTranscriptIdentity: { dev: newerTranscriptStat.dev, ino: newerTranscriptStat.ino },
		newerTranscriptBytes,
		newerOwnerDirectory: newerOwner.dir,
		newerOwnerIdentity: { dev: newerOwnerStat.dev, ino: newerOwnerStat.ino },
		newerOwnerFiles,
	};
}

function cleanupOf(response: BrokerResponse): BrokerCleanupEvidence {
	if (response.ok || !response.error.cleanup) throw new Error("Expected a durable cleanup response");
	return response.error.cleanup;
}

function expectPayloadRetired(response: BrokerResponse, sessionId: string): BrokerCleanupEvidence {
	expect(response.ok).toBe(false);
	if (response.ok) throw new Error("Expected retained namespace cleanup to remain pending");
	expect(response.error.code).toBe("cleanup_pending");
	const cleanup = cleanupOf(response);
	expect(cleanup).toMatchObject({
		phase: "artifacts",
		artifactsRemoved: true,
		sessionId,
		taskArtifactOwnerPayloadRetired: true,
		taskArtifactOwnerNamespaceRetained: true,
		taskArtifactOwnerTranscriptDeleted: true,
	});
	expect(cleanup.taskArtifactOwnerDeletionEvidence).toMatchObject({ schemaVersion: 2, sessionId });
	expect(cleanup.taskArtifactOwnerRetirementContinuation).toMatchObject({ schemaVersion: 1 });
	expect(cleanup.taskArtifactOwnerRetirementOutcome).toMatchObject({
		kind: "payload_retired",
		namespace: "retained",
		nativeOutcome: { ok: false, code: "cleanup_pending", payloadDurable: true },
	});
	return cleanup;
}

async function verifyRetainedOwner(fixture: OwnerFixture, cleanup: BrokerCleanupEvidence): Promise<void> {
	const evidence = cleanup.taskArtifactOwnerDeletionEvidence;
	const continuation = cleanup.taskArtifactOwnerRetirementContinuation;
	if (!evidence || !continuation) throw new Error("Retained owner receipt lacks immutable evidence or continuation");
	const retainedRoot = continuation.retainedRootPath;
	const retainedStat = await fs.lstat(retainedRoot, { bigint: true });
	const parentStat = await fs.stat(path.dirname(fixture.ownerDirectory), { bigint: true });
	expect({ dev: retainedStat.dev, ino: retainedStat.ino }).toEqual(fixture.ownerIdentity);
	expect({ dev: parentStat.dev, ino: parentStat.ino }).toEqual(fixture.ownerParentIdentity);
	expect(evidence.parentIdentity).toEqual({
		dev: fixture.ownerParentIdentity.dev.toString(),
		ino: fixture.ownerParentIdentity.ino.toString(),
	});
	expect({ rootDev: evidence.treeSnapshot.rootDev, rootIno: evidence.treeSnapshot.rootIno }).toEqual({
		rootDev: fixture.ownerIdentity.dev.toString(),
		rootIno: fixture.ownerIdentity.ino.toString(),
	});
	expect({
		rootDev: continuation.retainedTreeSnapshot.rootDev,
		rootIno: continuation.retainedTreeSnapshot.rootIno,
	}).toEqual({ rootDev: fixture.ownerIdentity.dev.toString(), rootIno: fixture.ownerIdentity.ino.toString() });
	expect(retainedRoot).toBe(`${fixture.ownerDirectory}.removing`);
	await expect(fs.lstat(fixture.ownerDirectory)).rejects.toMatchObject({ code: "ENOENT" });

	const originalByPath = new Map(fixture.ownerFiles.map(file => [file.relativePath, file]));
	const retainedFiles = await regularFiles(retainedRoot);
	expect(retainedFiles.length).toBeGreaterThan(0);
	for (const file of retainedFiles) {
		const original = originalByPath.get(file.relativePath);
		if (!original) throw new Error(`Unexpected retained owner payload path: ${file.relativePath}`);
		expect({ dev: file.dev, ino: file.ino }).toEqual({ dev: original.dev, ino: original.ino });
		expect(file.bytes.byteLength).toBe(0);
	}
	const emptyHash = createHash("sha256").update("").digest("hex");
	expect(
		continuation.retainedTreeSnapshot.entries.every(
			entry => entry.kind === "directory" || (entry.size === "0" && entry.sha256 === emptyHash),
		),
	).toBe(true);
}

async function rejectOwnerReadoption(fixture: OwnerFixture, cleanup: BrokerCleanupEvidence): Promise<void> {
	const evidence = cleanup.taskArtifactOwnerDeletionEvidence;
	if (!evidence || !cleanup.sessionsRoot)
		throw new Error("Expected immutable owner evidence and managed sessions root");
	const resolved = resolveManagedScope({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		sessionsRoot: cleanup.sessionsRoot,
	});
	if (resolved.kind !== "resolved") throw new Error("Expected the original verified managed scope");
	const scope = resolved.scope;
	const context: TaskArtifactOwnerStorageContext = {
		rootAuthority: managedRootForScope(scope),
		sessionsRoot: scope.sessionsRoot,
		securityPolicy: scope.platform === "win32" ? "windows-existing-verify-first" : "default",
		profileAgentDir: scope.agentDir,
	};
	await expect(ensureManagedTaskArtifactOwner(context, fixture.sessionId, evidence.locator)).rejects.toThrow();
	await expect(fs.lstat(fixture.ownerDirectory)).rejects.toMatchObject({ code: "ENOENT" });
}

async function preserveNewerSession(fixture: OwnerFixture): Promise<void> {
	const newerStat = await fs.stat(fixture.newerOwnerDirectory, { bigint: true });
	expect({ dev: newerStat.dev, ino: newerStat.ino }).toEqual(fixture.newerOwnerIdentity);
	const newerTranscriptStat = await fs.stat(fixture.newerTranscript, { bigint: true });
	expect({ dev: newerTranscriptStat.dev, ino: newerTranscriptStat.ino }).toEqual(fixture.newerTranscriptIdentity);
	expect(await fs.readFile(fixture.newerTranscript)).toEqual(fixture.newerTranscriptBytes);
	const newerFiles = await regularFiles(fixture.newerOwnerDirectory);
	expect(newerFiles.map(file => [file.relativePath, file.dev, file.ino, file.bytes])).toEqual(
		fixture.newerOwnerFiles.map(file => [file.relativePath, file.dev, file.ino, file.bytes]),
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

it("saved-session deletion retains the exact payload-retired owner journal across broker restart", async () => {
	const fixture = await createFixture();
	let broker = new Broker({ agentDir: fixture.agentDir });
	try {
		await broker.start();
		const request = {
			cwd: fixture.cwd,
			stateRoot: path.join(fixture.cwd, ".gjc", "state"),
			sessionId: fixture.sessionId,
			sessionPath: fixture.transcript,
		};
		const response = await broker.handleRequest("session.delete", request, "owned-session-delete");
		const cleanup = expectPayloadRetired(response, fixture.sessionId);
		expect(await Bun.file(fixture.transcript).exists()).toBe(false);
		await verifyRetainedOwner(fixture, cleanup);
		await rejectOwnerReadoption(fixture, cleanup);
		await preserveNewerSession(fixture);

		await broker.stop();
		broker = new Broker({ agentDir: fixture.agentDir });
		await broker.start();
		const replay = await broker.handleRequest("session.delete", request, "owned-session-delete");
		expect(await Bun.file(fixture.transcript).exists()).toBe(false);
		const replayCleanup = expectPayloadRetired(replay, fixture.sessionId);
		expect(replayCleanup.taskArtifactOwnerDeletionEvidence).toEqual(cleanup.taskArtifactOwnerDeletionEvidence);
		expect(replayCleanup.taskArtifactOwnerRetirementContinuation?.retainedRootPath).toBe(
			cleanup.taskArtifactOwnerRetirementContinuation?.retainedRootPath,
		);
		await verifyRetainedOwner(fixture, replayCleanup);
		await rejectOwnerReadoption(fixture, replayCleanup);
		await preserveNewerSession(fixture);
	} finally {
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it("rejects corrupted owner continuation before another saved-session cleanup effect", async () => {
	const fixture = await createFixture();
	const broker = new Broker({ agentDir: fixture.agentDir });
	const deleteSpy = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
	try {
		await broker.start();
		const request = {
			cwd: fixture.cwd,
			stateRoot: path.join(fixture.cwd, ".gjc", "state"),
			sessionId: fixture.sessionId,
			sessionPath: fixture.transcript,
		};
		const response = await broker.handleRequest("session.delete", request, "corrupt-owner-delete");
		const cleanup = expectPayloadRetired(response, fixture.sessionId);
		const entry = broker.ledger.findCleanupPendingByDeleteTarget(
			{
				sessionId: fixture.sessionId,
				sessionsRoot: cleanup.sessionsRoot,
				transcriptPath: fixture.transcript,
				cwd: fixture.cwd,
			},
			"exclude-no-entry",
		);
		if (!entry) throw new Error("Expected the owner residual journal in the lifecycle ledger");
		const corrupted: unknown = JSON.parse(JSON.stringify(response));
		const responseRecord = record(corrupted);
		const errorRecord = record(responseRecord?.error);
		const cleanupRecord = record(errorRecord?.cleanup);
		const continuationRecord = record(cleanupRecord?.taskArtifactOwnerRetirementContinuation);
		if (!continuationRecord) throw new Error("Expected a persisted owner continuation to corrupt");
		continuationRecord.unrecognizedAuthority = true;
		await broker.ledger.transition(entry.identity, "effect_started", { response: corrupted });
		deleteSpy.mockClear();

		const replay = await broker.handleRequest("session.delete", request, "corrupt-owner-delete");
		expect(replay).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(deleteSpy).not.toHaveBeenCalled();
		const retainedPath = cleanup.taskArtifactOwnerRetirementContinuation?.retainedRootPath;
		if (!retainedPath) throw new Error("Expected a retained owner root");
		await verifyRetainedOwner(fixture, cleanup);
		const retainedStat = await fs.lstat(retainedPath);
		expect(retainedStat.isDirectory()).toBe(true);
	} finally {
		deleteSpy.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it("leaves a replaced retained owner remnant untouched during broker replay", async () => {
	const fixture = await createFixture();
	let broker = new Broker({ agentDir: fixture.agentDir });
	const deleteSpy = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
	try {
		await broker.start();
		const request = {
			cwd: fixture.cwd,
			stateRoot: path.join(fixture.cwd, ".gjc", "state"),
			sessionId: fixture.sessionId,
			sessionPath: fixture.transcript,
		};
		const response = await broker.handleRequest("session.delete", request, "replaced-owner-delete");
		const cleanup = expectPayloadRetired(response, fixture.sessionId);
		const retainedPath = cleanup.taskArtifactOwnerRetirementContinuation?.retainedRootPath;
		if (!retainedPath) throw new Error("Expected a retained owner root");
		const retainedStat = await fs.lstat(retainedPath, { bigint: true });
		const movedOriginal = `${retainedPath}.test-original`;
		await fs.rename(retainedPath, movedOriginal);
		await fs.mkdir(retainedPath);
		const replacementFile = path.join(retainedPath, "replacement-marker");
		await fs.writeFile(replacementFile, "new remnant identity");
		const replacementStat = await fs.lstat(retainedPath, { bigint: true });
		const replacementBytes = await fs.readFile(replacementFile);
		deleteSpy.mockClear();

		await broker.stop();
		broker = new Broker({ agentDir: fixture.agentDir });
		await broker.start();
		const replay = await broker.handleRequest("session.delete", request, "replaced-owner-delete");
		expect(replay).toMatchObject({
			ok: false,
			error: { code: "cleanup_pending", cleanup: { phase: "artifacts", taskArtifactOwnerTranscriptDeleted: true } },
		});
		expect(deleteSpy).not.toHaveBeenCalled();
		const afterReplacement = await fs.lstat(retainedPath, { bigint: true });
		expect({ dev: afterReplacement.dev, ino: afterReplacement.ino }).toEqual({
			dev: replacementStat.dev,
			ino: replacementStat.ino,
		});
		expect(await fs.readFile(replacementFile)).toEqual(replacementBytes);
		const originalAfterMove = await fs.lstat(movedOriginal, { bigint: true });
		expect({ dev: originalAfterMove.dev, ino: originalAfterMove.ino }).toEqual({
			dev: retainedStat.dev,
			ino: retainedStat.ino,
		});
		await preserveNewerSession(fixture);
	} finally {
		deleteSpy.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it("does not advance transcript retirement after an owner-native cleanup failure", async () => {
	const fixture = await createFixture();
	const broker = new Broker({ agentDir: fixture.agentDir });
	const realRetire = taskArtifactOwner.retireTaskArtifactOwner;
	const retireSpy = vi.spyOn(taskArtifactOwner, "retireTaskArtifactOwner");
	try {
		retireSpy.mockImplementation((context, evidence, continuation) => {
			const outcome = realRetire(context, evidence, continuation);
			if (outcome.kind !== "payload_retired") return outcome;
			const nativeCode = "native_io_error";
			const failedContinuation: TaskArtifactOwnerRetirementContinuation = {
				...outcome.continuation,
				nativeCodes: [...new Set([...(outcome.continuation.nativeCodes ?? []), nativeCode])],
			};
			return {
				kind: "uncertain",
				reason: `task_artifact_owner_native_removal_${nativeCode}`,
				evidence: outcome.evidence,
				continuation: failedContinuation,
				nativeOutcome: { ok: false, code: nativeCode },
			};
		});
		await broker.start();
		const request = {
			cwd: fixture.cwd,
			stateRoot: path.join(fixture.cwd, ".gjc", "state"),
			sessionId: fixture.sessionId,
			sessionPath: fixture.transcript,
		};
		const response = await broker.handleRequest("session.delete", request, "native-owner-failure");
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: "cleanup_pending",
				cleanup: {
					phase: "artifacts",
					taskArtifactOwnerRetirementOutcome: {
						kind: "uncertain",
						nativeOutcome: { ok: false, code: "native_io_error" },
					},
				},
			},
		});
		expect(await Bun.file(fixture.transcript).exists()).toBe(true);
		const cleanup = cleanupOf(response);
		expect(cleanup.taskArtifactOwnerPayloadRetired).toBeUndefined();
		expect(cleanup.taskArtifactOwnerNamespaceRetained).toBeUndefined();
		expect(retireSpy).toHaveBeenCalledTimes(1);
		await preserveNewerSession(fixture);
	} finally {
		retireSpy.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);
