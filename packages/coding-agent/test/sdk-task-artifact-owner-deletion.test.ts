import { expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { safeRm } from "../../../scripts/safe-cleanup";
import {
	Broker,
	type BrokerCleanupEvidence,
	type BrokerResponse,
	normalizeBrokerInput,
} from "../src/sdk/broker/broker";
import {
	type ManagedScope,
	prepareManagedSessionScopeForWriteSync,
	resolveManagedGcScopeForRead,
	resolveManagedScopeForWrite,
	taskArtifactOwnerStorageContextForScope,
} from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { FileSessionStorage } from "../src/session/session-storage";
import { ensureManagedTaskArtifactOwner } from "../src/session/task-artifact-owner";
import {
	OWNER_DELETION_SCHEMA_VERSION,
	OWNER_SCHEMA_VERSION,
	ownerIdForSession,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner-codec";

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
	scope: ManagedScope;
	sessionsRoot: string;
	sessionId: string;
	transcript: string;
	ownerDirectory: string;
	ownerIdentity: { dev: bigint; ino: bigint };
	ownerLocator: TaskArtifactOwnerLocator;
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

function publishManagedTranscriptBytes(
	scope: ManagedScope,
	context: TaskArtifactOwnerStorageContext,
	filename: string,
	bytes: Uint8Array,
): string {
	const store = new ManagedSessionDescendantStore(context.rootAuthority, scope.directoryPath);
	try {
		store.publishNoReplaceSync(filename, bytes);
	} finally {
		store.close();
	}
	return path.join(scope.directoryPath, filename);
}

function publishManagedTranscript(
	scope: ManagedScope,
	context: TaskArtifactOwnerStorageContext,
	sessionId: string,
	cwd: string,
	locator: TaskArtifactOwnerLocator,
): string {
	const timestamp = new Date().toISOString();
	const filename = `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp,
		cwd,
		taskArtifactOwner: locator,
	};
	return publishManagedTranscriptBytes(scope, context, filename, Buffer.from(`${JSON.stringify(header)}\n`, "utf8"));
}

async function createOwnedSession(
	scope: ManagedScope,
	context: TaskArtifactOwnerStorageContext,
	cwd: string,
	payload: string,
): Promise<{
	sessionId: string;
	transcript: string;
	transcriptBytes: Buffer<ArrayBuffer>;
	transcriptIdentity: { dev: bigint; ino: bigint };
	ownerDirectory: string;
	ownerIdentity: { dev: bigint; ino: bigint };
	ownerLocator: TaskArtifactOwnerLocator;
	ownerParentIdentity: { dev: bigint; ino: bigint };
	ownerFiles: FileSnapshot[];
}> {
	const sessionId = crypto.randomUUID();
	const owner = await ensureManagedTaskArtifactOwner(context, sessionId, undefined);
	try {
		await owner.manager.save(payload, "probe");
	} finally {
		owner.manager.getManagedStore()?.close();
	}
	const transcript = publishManagedTranscript(scope, context, sessionId, cwd, owner.locator);
	const transcriptBytes = await fs.readFile(transcript);
	const transcriptStat = await fs.stat(transcript, { bigint: true });
	const ownerStat = await fs.stat(owner.manager.dir, { bigint: true });
	const ownerParentStat = await fs.stat(path.dirname(owner.manager.dir), { bigint: true });
	const ownerFiles = await regularFiles(owner.manager.dir);
	if (ownerFiles.length === 0) throw new Error("Expected owner payload files");
	return {
		sessionId,
		transcript,
		transcriptBytes,
		transcriptIdentity: { dev: transcriptStat.dev, ino: transcriptStat.ino },
		ownerDirectory: owner.manager.dir,
		ownerIdentity: { dev: ownerStat.dev, ino: ownerStat.ino },
		ownerLocator: owner.locator,
		ownerParentIdentity: { dev: ownerParentStat.dev, ino: ownerParentStat.ino },
		ownerFiles,
	};
}

async function createFixture(): Promise<OwnerFixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-sdk-delete-")));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "profile");
	const sessionsRoot = path.join(agentDir, "sessions");
	await fs.mkdir(cwd, { mode: 0o700 });
	await fs.mkdir(agentDir, { mode: 0o700 });
	const resolved = resolveManagedScopeForWrite({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(`Expected managed owner scope: ${resolved.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(`Expected prepared owner scope: ${prepared.code}`);
	const scope = prepared.scope;
	const context = taskArtifactOwnerStorageContextForScope(scope);
	const original = await createOwnedSession(scope, context, cwd, "original task output");
	const newer = await createOwnedSession(scope, context, cwd, "newer output stays");

	return {
		root,
		cwd,
		agentDir,
		sessionsRoot,
		scope,
		sessionId: original.sessionId,
		transcript: original.transcript,
		ownerDirectory: original.ownerDirectory,
		ownerIdentity: original.ownerIdentity,
		ownerLocator: original.ownerLocator,
		ownerParentIdentity: original.ownerParentIdentity,
		ownerFiles: original.ownerFiles,
		newerTranscript: newer.transcript,
		newerTranscriptIdentity: newer.transcriptIdentity,
		newerTranscriptBytes: newer.transcriptBytes,
		newerOwnerDirectory: newer.ownerDirectory,
		newerOwnerIdentity: newer.ownerIdentity,
		newerOwnerFiles: newer.ownerFiles,
	};
}

function cleanupOf(response: BrokerResponse): BrokerCleanupEvidence {
	if (response.ok || !response.error.cleanup) throw new Error("Expected a durable cleanup response");
	return response.error.cleanup;
}

function expectPayloadRetired(response: BrokerResponse, sessionId: string): BrokerCleanupEvidence {
	expect(response.ok).toBe(false);
	if (response.ok) throw new Error("Expected retained namespace cleanup to remain pending");
	expect(response.error).toMatchObject({ code: "cleanup_pending" });
	const cleanup = cleanupOf(response);
	expect(cleanup).toMatchObject({
		phase: "artifacts",
		artifactsRemoved: true,
		sessionId,
		taskArtifactOwnerPayloadRetired: true,
		taskArtifactOwnerNamespaceRetained: true,
		taskArtifactOwnerTranscriptDeleted: true,
	});
	expect(cleanup.taskArtifactOwnerDeletionEvidence).toMatchObject({
		schemaVersion: OWNER_DELETION_SCHEMA_VERSION,
		sessionId,
	});
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
	const emptyHash = crypto.createHash("sha256").update("").digest("hex");
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
	const resolved = resolveManagedGcScopeForRead({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		sessionsRoot: cleanup.sessionsRoot,
	});
	if (resolved.kind !== "resolved") throw new Error("Expected the original verified managed scope");
	const context = taskArtifactOwnerStorageContextForScope(resolved.scope);
	await expect(ensureManagedTaskArtifactOwner(context, fixture.sessionId, evidence.locator)).rejects.toThrow();
	await expect(fs.lstat(fixture.ownerDirectory)).rejects.toMatchObject({ code: "ENOENT" });
}

async function preserveNewerSession(fixture: OwnerFixture): Promise<void> {
	const newerStat = await fs.stat(fixture.newerOwnerDirectory, { bigint: true });
	expect({ dev: newerStat.dev, ino: newerStat.ino }).toEqual(fixture.newerOwnerIdentity);
	const transcriptStat = await fs.stat(fixture.newerTranscript, { bigint: true });
	expect({ dev: transcriptStat.dev, ino: transcriptStat.ino }).toEqual(fixture.newerTranscriptIdentity);
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

type PausedOwnerWriter = { release(): Promise<void> };

async function pauseOwnerWriter(fixture: OwnerFixture, phase: "staging" | "replacement"): Promise<PausedOwnerWriter> {
	const replacementTarget =
		fixture.ownerFiles.find(file => !file.relativePath.startsWith(".")) ?? fixture.ownerFiles[0]!;
	const readyPath = path.join(fixture.root, `writer-${phase}.ready`);
	const releasePath = path.join(fixture.root, `writer-${phase}.release`);
	const fixturePath = path.join(import.meta.dir, "fixtures", "task-owner-access-writer.ts");
	const child = Bun.spawn([process.execPath, fixturePath], {
		cwd: path.resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			GJC_TASK_OWNER_ACCESS_WRITER_INPUT: JSON.stringify({
				profileRoot: fixture.agentDir,
				ownerRoot: fixture.ownerDirectory,
				filename: phase === "replacement" ? path.basename(replacementTarget.relativePath) : "pending.bin",
				ready: readyPath,
				release: releasePath,
				phase,
			}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const deadline = Date.now() + 10_000;
	while (!(await Bun.file(readyPath).exists())) {
		if (Date.now() >= deadline) throw new Error(`writer ${phase} readiness timed out`);
		const exited = await Promise.race([
			child.exited.then(code => ({ done: true as const, code })),
			Bun.sleep(10).then(() => ({ done: false as const })),
		]);
		if (exited.done)
			throw new Error(`writer ${phase} exited before readiness (${exited.code}): ${await stderrPromise}`);
	}
	const release = async (): Promise<void> => {
		await Bun.write(releasePath, "release");
		const exitCode = await child.exited;
		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
		expect(exitCode, `writer ${phase} failed: ${stderr}`).toBe(0);
		expect(stdout).toContain(`"phase":"${phase}"`);
		expect(stdout).toContain('"status":"acknowledged"');
	};
	return { release };
}

async function createLegacyOnlyFixture(): Promise<
	Pick<OwnerFixture, "root" | "cwd" | "agentDir" | "sessionId" | "transcript">
> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sdk-legacy-only-delete-")));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "profile");
	await fs.mkdir(cwd, { mode: 0o700 });
	const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const legacyDirectory = path.join(agentDir, "sessions", `--${encoded}--`);
	await fs.mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
	const sessionId = crypto.randomUUID();
	const transcript = path.join(legacyDirectory, `${sessionId}.jsonl`);
	await Bun.write(
		transcript,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`,
	);
	return { root, cwd, agentDir, sessionId, transcript };
}

function deleteRequest(
	fixture: Pick<OwnerFixture, "cwd" | "sessionId" | "transcript">,
	sessionId = fixture.sessionId,
	sessionPath = fixture.transcript,
) {
	return {
		cwd: fixture.cwd,
		stateRoot: path.join(fixture.cwd, ".gjc", "state"),
		sessionId,
		sessionPath,
	};
}

it.each([
	false,
	true,
])("SDK deletes an owner-free legacy-only session without initializing v2 (restart=%s)", async restart => {
	const { root, cwd, agentDir, sessionId, transcript: sessionPath } = await createLegacyOnlyFixture();
	const sessionsRoot = path.join(agentDir, "sessions");
	let broker = new Broker({ agentDir });
	const originalUnlink = native.exactUnlink;
	const unlink = vi
		.spyOn(native, "exactUnlink")
		.mockImplementation((pathname, identity) =>
			restart && pathname === sessionPath ? { ok: false, code: "io_error" } : originalUnlink(pathname, identity),
		);
	const request = { cwd, stateRoot: path.join(cwd, ".gjc", "state"), sessionId, sessionPath };
	try {
		await broker.start();
		let response = await broker.handleRequest("session.delete", request, "legacy-only-delete");
		if (restart) {
			expect(response).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "transcript" } },
			});
			unlink.mockRestore();
			await broker.stop();
			broker = new Broker({ agentDir });
			await broker.start();
			response = await broker.handleRequest("session.delete", request, "legacy-only-delete");
		}
		expect(response).toMatchObject({ ok: true, result: { sessionId } });
		expect(await Bun.file(sessionPath).exists()).toBe(false);
		expect((await fs.readdir(sessionsRoot)).filter(name => name.startsWith("v2-"))).toEqual([]);
	} finally {
		unlink.mockRestore();
		await broker.stop();
		await safeRm(root, { recursive: true, force: true });
	}
}, 30_000);

it.each([
	false,
	true,
])("SDK retries same-Broker transcript cleanup after canonical artifact reappearance (owned=%s)", async owned => {
	const fixture = owned ? await createFixture() : await createLegacyOnlyFixture();
	const broker = new Broker({ agentDir: fixture.agentDir });
	const artifacts = fixture.transcript.slice(0, -6);
	const transcriptBefore = await fs.readFile(fixture.transcript);
	let injected = false;
	const transition = broker.ledger.transition.bind(broker.ledger);
	const publish = vi.spyOn(broker.ledger, "transition").mockImplementation(async (identity, state, fields) => {
		const result = await transition(identity, state, fields);
		const error = record(record(fields?.response)?.error);
		if (
			!injected &&
			error?.message ===
				"Saved session artifacts and owner cleanup are durably recorded; transcript cleanup is preauthorized."
		) {
			injected = true;
			await fs.mkdir(artifacts, { mode: 0o700 });
			await Bun.write(path.join(artifacts, "replacement.txt"), "unowned replacement");
		}
		return result;
	});
	try {
		await broker.start();
		const request = deleteRequest(fixture);
		const first = await broker.handleRequest("session.delete", request, "canonical-artifact-reappearance");
		expect(injected).toBe(true);
		expect(first).toMatchObject({
			ok: false,
			error: { code: "cleanup_pending", message: expect.stringContaining("canonical artifact path reappeared") },
		});
		const cleanup = cleanupOf(first);
		expect(
			Object.entries(cleanup).filter(([key, value]) => key.startsWith("taskArtifactOwner") && value === undefined),
		).toEqual([]);
		if (!owned) expect(Object.keys(cleanup).filter(key => key.startsWith("taskArtifactOwner"))).toEqual([]);
		expect(await fs.readFile(fixture.transcript)).toEqual(transcriptBefore);
		expect(await Bun.file(path.join(artifacts, "replacement.txt")).text()).toBe("unowned replacement");
		publish.mockRestore();
		await safeRm(artifacts, { recursive: true, force: true });
		const replay = await broker.handleRequest("session.delete", request, "canonical-artifact-reappearance");
		if (owned && !replay.ok) expectPayloadRetired(replay, fixture.sessionId);
		else expect(replay).toMatchObject({ ok: true, result: { sessionId: fixture.sessionId } });
		expect(await Bun.file(fixture.transcript).exists()).toBe(false);
		if (!owned)
			expect(
				(await fs.readdir(path.join(fixture.agentDir, "sessions"))).filter(name => name.startsWith("v2-")),
			).toEqual([]);
	} finally {
		publish.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it.each([
	false,
	true,
])("SDK refuses a protocol alias before artifact effects and retries after its removal (restart=%s)", async restart => {
	const fixture = await createFixture();
	let broker = new Broker({ agentDir: fixture.agentDir });
	const artifacts = fixture.transcript.slice(0, -6);
	const unlink = vi.spyOn(native, "exactUnlink");
	await fs.mkdir(artifacts, { mode: 0o700 });
	await Bun.write(path.join(artifacts, "retained.txt"), "retained artifact");
	await fs.mkdir(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal.saved"), { mode: 0o700 });
	const transcriptBefore = await fs.readFile(fixture.transcript);
	const artifactsBefore = await regularFiles(artifacts);
	const ownerBefore = await regularFiles(fixture.ownerDirectory);
	const ownerStatBefore = await fs.lstat(fixture.ownerDirectory, { bigint: true });
	const artifactsStatBefore = await fs.lstat(artifacts, { bigint: true });
	try {
		await broker.start();
		const response = await broker.handleRequest(
			"session.delete",
			deleteRequest(fixture),
			"unauthenticated-protocol-delete",
		);
		expect(response).toMatchObject({ ok: false, error: { code: "cleanup_pending" } });
		const cleanup = cleanupOf(response);
		expect(cleanup.phase).toBe("artifacts");
		expect(cleanup.artifactsRemoved).toBeUndefined();
		expect(cleanup.artifactTree?.snapshot).toBeDefined();
		expect(cleanup.taskArtifactOwnerRetired).toBeUndefined();
		expect(cleanup.taskArtifactOwnerTranscriptDeleted).toBeUndefined();
		expect(await fs.readFile(fixture.transcript)).toEqual(transcriptBefore);
		expect(await regularFiles(artifacts)).toEqual(artifactsBefore);
		expect(await regularFiles(fixture.ownerDirectory)).toEqual(ownerBefore);
		for (const [pathname, before] of [
			[artifacts, artifactsStatBefore],
			[fixture.ownerDirectory, ownerStatBefore],
		] as const) {
			const after = await fs.lstat(pathname, { bigint: true });
			expect({ dev: after.dev, ino: after.ino, mode: after.mode, ctimeNs: after.ctimeNs }).toEqual({
				dev: before.dev,
				ino: before.ino,
				mode: before.mode,
				ctimeNs: before.ctimeNs,
			});
		}
		await preserveNewerSession(fixture);
		expect(unlink.mock.calls.some(([pathname]) => pathname === artifacts)).toBe(false);
		await fs.rmdir(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal.saved"));
		if (restart) {
			await broker.stop();
			broker = new Broker({ agentDir: fixture.agentDir });
			await broker.start();
		}
		const replay = await broker.handleRequest(
			"session.delete",
			deleteRequest(fixture),
			"unauthenticated-protocol-delete",
		);
		expect(unlink.mock.calls.some(([pathname]) => pathname === artifacts)).toBe(true);
		if (!replay.ok) {
			expect(replay.error.code).toBe("cleanup_pending");
			expect(replay.error.message).not.toContain("canonical artifact path reappeared");
		}
		await preserveNewerSession(fixture);
	} finally {
		unlink.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it("rejects caller-supplied owner cleanup state on public session.delete", () => {
	for (const input of [
		{
			sessionId: "00000000-0000-4000-8000-000000000000",
			taskArtifactOwnerRetired: true,
		},
		{
			sessionId: "00000000-0000-4000-8000-000000000000",
			cleanup: { taskArtifactOwnerDeletionEvidence: {} },
		},
		{
			sessionId: "00000000-0000-4000-8000-000000000000",
			target: { taskArtifactOwnerRetirementOutcome: { kind: "completed" } },
		},
	]) {
		expect(normalizeBrokerInput("session.delete", input)).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
	}
});

it("SDK deletion keeps an orphan owner locator pending without claiming retirement", async () => {
	const fixture = await createFixture();
	const broker = new Broker({ agentDir: fixture.agentDir });
	const orphanSessionId = crypto.randomUUID();
	const orphanLocator: TaskArtifactOwnerLocator = {
		schemaVersion: OWNER_SCHEMA_VERSION,
		ownerId: ownerIdForSession(orphanSessionId),
		directoryDev: "1",
		directoryIno: "2",
	};
	const orphanTranscript = publishManagedTranscript(
		fixture.scope,
		taskArtifactOwnerStorageContextForScope(fixture.scope),
		orphanSessionId,
		fixture.cwd,
		orphanLocator,
	);
	const originalBytes = await fs.readFile(orphanTranscript);
	const deleteSpy = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
	try {
		await broker.start();
		const response = await broker.handleRequest(
			"session.delete",
			deleteRequest(fixture, orphanSessionId, orphanTranscript),
			"orphan-owner-delete",
		);
		const cleanup = cleanupOf(response);
		expect(response).toMatchObject({ ok: false, error: { code: "cleanup_pending" } });
		expect(cleanup).toMatchObject({
			phase: "artifacts",
			taskArtifactOwnerCleanupError: "task_artifact_owner_missing",
		});
		expect(cleanup.taskArtifactOwnerDeletionEvidence).toBeUndefined();
		expect(cleanup.taskArtifactOwnerRetirementOutcome).toBeUndefined();
		expect(cleanup.taskArtifactOwnerRetired).toBeUndefined();
		expect(cleanup.taskArtifactOwnerPayloadRetired).toBeUndefined();
		expect(cleanup.taskArtifactOwnerNamespaceRetained).toBeUndefined();
		expect(cleanup.taskArtifactOwnerTranscriptDeleted).toBeUndefined();
		expect(await fs.readFile(orphanTranscript)).toEqual(originalBytes);
		expect(deleteSpy).not.toHaveBeenCalled();
	} finally {
		deleteSpy.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it("SDK deletion preserves a scrubbed owner continuation across restart and keeps transcript deletion pending", async () => {
	const fixture = await createFixture();
	let broker = new Broker({ agentDir: fixture.agentDir });
	try {
		await broker.start();
		const request = deleteRequest(fixture);
		const cleanup = expectPayloadRetired(
			await broker.handleRequest("session.delete", request, "owned-session-delete"),
			fixture.sessionId,
		);
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
		await preserveNewerSession(fixture);
	} finally {
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it.each([
	"staging",
	"replacement",
] as const)("SDK delete refuses a real managed %s writer during initial and restored owner validation", async phase => {
	const fixture = await createFixture();
	let broker = new Broker({ agentDir: fixture.agentDir });
	let writer: PausedOwnerWriter | undefined;
	let restoreTransition: (() => void) | undefined;
	const originalTranscript = await fs.readFile(fixture.transcript);
	const ownerStat = await fs.lstat(fixture.ownerDirectory, { bigint: true });
	const originalOwnerFiles = new Map(fixture.ownerFiles.map(file => [file.relativePath, file]));
	const nativeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
	try {
		await broker.start();
		const transition = broker.ledger.transition.bind(broker.ledger);
		const transitionSpy = vi
			.spyOn(broker.ledger, "transition")
			.mockImplementation(async (identity, state, fields) => {
				const result = await transition(identity, state, fields);
				const response = record(fields?.response);
				const cleanup = record(record(response?.error)?.cleanup);
				if (!writer && cleanup?.taskArtifactOwnerDeletionEvidence !== undefined)
					writer = await pauseOwnerWriter(fixture, phase);
				return result;
			});
		restoreTransition = () => transitionSpy.mockRestore();
		const request = deleteRequest(fixture);
		const first = await broker.handleRequest("session.delete", request, `owner-${phase}-delete`);
		const firstCleanup = cleanupOf(first);
		expect(firstCleanup).toMatchObject({
			phase: "artifacts",
			taskArtifactOwnerDeletionEvidence: { schemaVersion: OWNER_DELETION_SCHEMA_VERSION },
			taskArtifactOwnerCleanupError: "task_artifact_owner_writer_not_quiescent",
		});
		expect(firstCleanup.taskArtifactOwnerRetirementOutcome).toBeUndefined();
		expect(firstCleanup.taskArtifactOwnerTranscriptDeleted).toBeUndefined();
		expect(await fs.readFile(fixture.transcript)).toEqual(originalTranscript);
		const ownerDuringWrite = await fs.lstat(fixture.ownerDirectory, { bigint: true });
		expect({ dev: ownerDuringWrite.dev, ino: ownerDuringWrite.ino }).toEqual({
			dev: ownerStat.dev,
			ino: ownerStat.ino,
		});
		for (const file of await regularFiles(fixture.ownerDirectory)) {
			const original = originalOwnerFiles.get(file.relativePath);
			if (!original) continue;
			expect({ dev: file.dev, ino: file.ino, bytes: file.bytes }).toEqual({
				dev: original.dev,
				ino: original.ino,
				bytes: original.bytes,
			});
		}
		expect(
			nativeSpy.mock.calls.filter(
				([pathname]) => pathname === fixture.ownerDirectory || pathname === `${fixture.ownerDirectory}.removing`,
			),
		).toHaveLength(0);
		restoreTransition();
		restoreTransition = undefined;

		await broker.stop();
		broker = new Broker({ agentDir: fixture.agentDir });
		await broker.start();
		const replay = await broker.handleRequest("session.delete", request, `owner-${phase}-delete`);
		const replayCleanup = cleanupOf(replay);
		expect(replayCleanup).toMatchObject({
			phase: "artifacts",
			taskArtifactOwnerDeletionEvidence: firstCleanup.taskArtifactOwnerDeletionEvidence,
			taskArtifactOwnerCleanupError: "task_artifact_owner_writer_not_quiescent",
		});
		expect(await fs.readFile(fixture.transcript)).toEqual(originalTranscript);
		expect(
			nativeSpy.mock.calls.filter(
				([pathname]) => pathname === fixture.ownerDirectory || pathname === `${fixture.ownerDirectory}.removing`,
			),
		).toHaveLength(0);
	} finally {
		restoreTransition?.();
		if (writer) await writer.release();
		nativeSpy.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it.each([
	{ phase: "staging", replaceTranscript: false, restart: false },
	{ phase: "replacement", replaceTranscript: false, restart: false },
	{ phase: "staging", replaceTranscript: false, restart: true },
	{ phase: "replacement", replaceTranscript: false, restart: true },
	{ phase: "staging", replaceTranscript: true, restart: true },
] as const)("SDK retries initial writer capture only for its original transcript (%j)", async ({
	phase,
	replaceTranscript,
	restart,
}) => {
	const fixture = await createFixture();
	let broker = new Broker({ agentDir: fixture.agentDir });
	let writer: PausedOwnerWriter | undefined;
	const transcriptBefore = await fs.readFile(fixture.transcript);
	try {
		writer = await pauseOwnerWriter(fixture, phase);
		await broker.start();
		const request = deleteRequest(fixture);
		const first = await broker.handleRequest("session.delete", request, `initial-${phase}-capture`);
		const firstCleanup = cleanupOf(first);
		expect(firstCleanup).toMatchObject({
			phase: "artifacts",
			taskArtifactOwnerCleanupError: "task_artifact_owner_writer_not_quiescent",
		});
		expect(firstCleanup.taskArtifactOwnerDeletionEvidence).toBeUndefined();
		expect(firstCleanup.artifactsRemoved).toBeUndefined();
		expect(await fs.readFile(fixture.transcript)).toEqual(transcriptBefore);
		if (restart) {
			await broker.stop();
			broker = new Broker({ agentDir: fixture.agentDir });
			await broker.start();
		}
		const stillWriting = await broker.handleRequest("session.delete", request, `initial-${phase}-capture`);
		expect(cleanupOf(stillWriting).taskArtifactOwnerCleanupError).toBe("task_artifact_owner_writer_not_quiescent");
		expect(cleanupOf(stillWriting).taskArtifactOwnerDeletionEvidence).toBeUndefined();
		expect(await fs.readFile(fixture.transcript)).toEqual(transcriptBefore);
		await writer.release();
		writer = undefined;
		const ownerBeforeReplay = await regularFiles(fixture.ownerDirectory);
		if (replaceTranscript) {
			await fs.rename(fixture.transcript, `${fixture.transcript}.original`);
			await Bun.write(fixture.transcript, transcriptBefore);
		}
		if (restart) {
			await broker.stop();
			broker = new Broker({ agentDir: fixture.agentDir });
			await broker.start();
		}
		const replay = await broker.handleRequest("session.delete", request, `initial-${phase}-capture`);
		if (replaceTranscript) {
			expect(cleanupOf(replay).taskArtifactOwnerCleanupError).toBe(
				"task_artifact_owner_transcript_identity_mismatch",
			);
			expect(await fs.readFile(fixture.transcript)).toEqual(transcriptBefore);
			expect(await regularFiles(fixture.ownerDirectory)).toEqual(ownerBeforeReplay);
		} else {
			if (!replay.ok) expectPayloadRetired(replay, fixture.sessionId);
			expect(await Bun.file(fixture.transcript).exists()).toBe(false);
		}
		await preserveNewerSession(fixture);
	} finally {
		if (writer) await writer.release();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it("SDK deletion refuses a shared owner when a sibling transcript carries the same locator", async () => {
	const fixture = await createFixture();
	const broker = new Broker({ agentDir: fixture.agentDir });
	const originalTranscript = await fs.readFile(fixture.transcript);
	const ownerBefore = await regularFiles(fixture.ownerDirectory);
	const nativeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
	try {
		const siblingId = crypto.randomUUID();
		publishManagedTranscriptBytes(
			fixture.scope,
			taskArtifactOwnerStorageContextForScope(fixture.scope),
			`${siblingId}.jsonl`,
			Buffer.from(
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: siblingId,
					timestamp: new Date().toISOString(),
					cwd: fixture.cwd,
					taskArtifactOwner: fixture.ownerLocator,
				})}\n`,
				"utf8",
			),
		);
		await broker.start();
		const response = await broker.handleRequest("session.delete", deleteRequest(fixture), "shared-owner-delete");
		const cleanup = cleanupOf(response);
		expect(cleanup).toMatchObject({
			phase: "artifacts",
			artifactsAbsentAtAuthorization: true,
			taskArtifactOwnerCleanupError: "task_artifact_owner_shared_with_sibling_transcript",
			taskArtifactOwnerDeletionEvidence: { schemaVersion: OWNER_DELETION_SCHEMA_VERSION },
		});
		expect(cleanup.artifactsRemoved).toBeUndefined();
		expect(await fs.readFile(fixture.transcript)).toEqual(originalTranscript);
		expect(await regularFiles(fixture.ownerDirectory)).toEqual(ownerBefore);
		expect(
			nativeSpy.mock.calls.filter(
				([pathname]) => pathname === fixture.ownerDirectory || pathname === `${fixture.ownerDirectory}.removing`,
			),
		).toHaveLength(0);
		await preserveNewerSession(fixture);
	} finally {
		nativeSpy.mockRestore();
		await broker.stop();
		await safeRm(fixture.root, { recursive: true, force: true });
	}
}, 30_000);

it("SDK owner replay leaves a replacement retained root untouched", async () => {
	const fixture = await createFixture();
	let broker = new Broker({ agentDir: fixture.agentDir });
	const deleteSpy = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
	try {
		await broker.start();
		const request = deleteRequest(fixture);
		const cleanup = expectPayloadRetired(
			await broker.handleRequest("session.delete", request, "replaced-owner-delete"),
			fixture.sessionId,
		);
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
