import { afterEach, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { safeRm } from "../../../scripts/safe-cleanup";
import { collectGcDiskReport, resolveGcDiskPolicy } from "../src/gjc-runtime/gc-runtime";
import {
	type ManagedGcSessionRetirementReceipt,
	type ManagedGcSessionRetirementTarget,
	type ManagedScope,
	managedRootForScope,
	publishManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceipt,
	resolveManagedScope,
} from "../src/session/internal/managed-session-scope";
import { SessionManager } from "../src/session/session-manager";
import {
	FileSessionStorage,
	retireSessionTranscript,
	taskArtifactOwnerLocatorFromTranscriptBytes,
} from "../src/session/session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	retireTaskArtifactOwner,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner";

const roots: string[] = [];

type OwnerGcFixture = {
	root: string;
	cwd: string;
	agentDir: string;
	transcript: string;
	ownerDir: string;
	context: TaskArtifactOwnerStorageContext;
	scope: ManagedScope;
	target: ManagedGcSessionRetirementTarget;
	evidence: TaskArtifactOwnerDeletionEvidence;
};

async function snapshotPath(pathname: string): Promise<unknown> {
	const stat = await fs.lstat(pathname, { bigint: true }).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!stat) return undefined;
	const base = {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
	if (stat.isSymbolicLink()) return { ...base, target: await fs.readlink(pathname) };
	if (stat.isDirectory()) {
		const names = (await fs.readdir(pathname)).sort();
		return { ...base, entries: await Promise.all(names.map(name => snapshotPath(path.join(pathname, name)))) };
	}
	return { ...base, bytes: (await fs.readFile(pathname)).toString("base64") };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => safeRm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-owner-gc-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "profile");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir);
	const destination = SessionManager.managedDestination(cwd, agentDir);
	if (destination.kind !== "managed") throw new Error("Expected managed authority");
	const context: TaskArtifactOwnerStorageContext = {
		rootAuthority: destination.securityContext.rootAuthority,
		sessionsRoot: destination.securityContext.sessionsRoot,
		profileAgentDir: destination.securityContext.profileAgentDir,
		securityPolicy: process.platform === "win32" ? "windows-existing-verify-first" : "default",
	};
	const manager = SessionManager.create(cwd, destination);
	const sessionId = manager.getSessionId();
	const owner = await manager.ensureArtifactManager();
	if (!owner) throw new Error("Expected managed owner");
	await manager.saveArtifact("owned payload", "probe");
	const transcript = manager.getSessionFile()!;
	const ownerDir = owner.dir;
	await manager.close();
	const locator = taskArtifactOwnerLocatorFromTranscriptBytes(await Bun.file(transcript).bytes(), sessionId);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(context, sessionId, locator);
	if (!evidence) throw new Error("Expected persisted owner locator");
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot: context.sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error("Expected verified managed scope");
	const scope = resolved.scope;
	const gcContext = { ...context, rootAuthority: managedRootForScope(scope) };
	const stat = await fs.stat(transcript, { bigint: true });
	const target = {
		transcriptPath: transcript,
		sessionId,
		cwd,
		transcriptIdentity: {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs,
			sha256: crypto
				.createHash("sha256")
				.update(await Bun.file(transcript).bytes())
				.digest("hex"),
		},
		taskArtifactOwnerLocator: evidence.locator,
	};
	return { root, cwd, agentDir, transcript, ownerDir, context: gcContext, scope, target, evidence };
}

async function retireThroughGcToOwnerPending(h: OwnerGcFixture) {
	const prepared: ManagedGcSessionRetirementReceipt = {
		...h.target,
		state: "prepared",
		taskArtifactOwnerDeletionEvidence: h.evidence,
	};
	await publishManagedGcSessionRetirementReceipt(h.scope, h.context, prepared, "prepared");
	const planPath = path.join(h.root, "artifact-phase-authorization.json");
	await Bun.write(
		planPath,
		JSON.stringify({
			plannedArtifactsPath: path.join(path.dirname(h.transcript), `.gjc-delete-${h.target.sessionId}-artifacts`),
			plannedTranscriptPath: path.join(path.dirname(h.transcript), `.gjc-delete-${h.target.sessionId}-transcript`),
		}),
	);
	const quarantinePlan = (await Bun.file(planPath).json()) as {
		plannedArtifactsPath: string;
		plannedTranscriptPath: string;
	};
	const artifactPhase = await new FileSessionStorage().deleteSessionVerified({
		...quarantinePlan,
		sessionsRoot: h.context.sessionsRoot,
		transcriptPath: h.transcript,
		sessionId: h.target.sessionId,
		cwd: h.cwd,
		transcriptIdentity: h.target.transcriptIdentity,
		taskArtifactOwnerStorageContext: h.context,
		taskArtifactOwnerDeletionEvidence: h.evidence,
		deferTaskArtifactOwnerRetirement: true,
	});
	if (artifactPhase.kind !== "artifacts_removed") throw new Error("Expected managed artifact phase");
	const artifactsRemoved = await publishManagedGcSessionRetirementReceipt(
		h.scope,
		h.context,
		prepared,
		"artifacts_removed",
	);
	const outcome = await retireSessionTranscript(
		new FileSessionStorage(),
		h.context.sessionsRoot,
		h.transcript,
		h.context,
		{ managedScope: h.scope },
	);
	return { outcome, artifactsRemoved, receipt: readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target) };
}

it("disk GC retains a transcript when native owner namespace cleanup is pending and protects a newer session", async () => {
	const h = await fixture();
	const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	await fs.utimes(h.transcript, old, old);
	const successor = SessionManager.create(h.cwd, SessionManager.managedDestination(h.cwd, h.agentDir));
	await successor.ensureOnDisk();
	const newer = successor.getSessionFile()!;
	await successor.close();
	const options = {
		agentDir: h.agentDir,
		env: {
			GJC_CODING_AGENT_DIR: h.agentDir,
			GJC_HARNESS_ROOT_REGISTRY_DIR: path.join(h.root, "registry"),
			TMPDIR: path.join(h.root, "tmp"),
		},
		policy: resolveGcDiskPolicy({ sessions_max_age_days: 30 }),
		prune: true,
	};
	const report = await collectGcDiskReport(options);
	expect(await Bun.file(h.transcript).exists()).toBe(true);
	await expect(fs.lstat(h.ownerDir)).rejects.toMatchObject({ code: "ENOENT" });
	expect((await fs.stat(`${h.ownerDir}.removing`, { bigint: true })).ino.toString()).toBe(
		h.evidence.locator.directoryIno,
	);
	expect(await Bun.file(newer).exists()).toBe(true);
	expect(report.surfaces.sessions.records.find(record => record.path === newer)?.action).toBe("keep");
	expect(report.surfaces.sessions.records.find(record => record.path === h.transcript)?.action).toBe("reclaim_failed");
});

it("does not retire a moved logical owner's tree while a sibling transcript still references it", async () => {
	const h = await fixture();
	const sibling = path.join(path.dirname(h.transcript), `${h.target.sessionId}-committed.jsonl`);
	await fs.copyFile(h.transcript, sibling);
	const ownerBefore = await snapshotPath(h.ownerDir);
	const originalTranscript = await Bun.file(h.transcript).bytes();
	const result = await retireSessionTranscript(
		new FileSessionStorage(),
		h.context.sessionsRoot,
		h.transcript,
		h.context,
		{ managedScope: h.scope },
	);
	expect(result).toMatchObject({ kind: "kept", reason: "task_artifact_owner_shared_with_sibling_transcript" });
	expect(await Bun.file(h.transcript).bytes()).toEqual(originalTranscript);
	expect(await Bun.file(sibling).exists()).toBe(true);
	expect(await snapshotPath(h.ownerDir)).toEqual(ownerBefore);
});

it("direct owner retirement proves durable empty payload while honestly retaining native namespace cleanup", async () => {
	const h = await fixture();
	const outcome = retireTaskArtifactOwner(h.context, h.evidence);
	expect(outcome).toMatchObject({
		kind: "payload_retired",
		namespace: "retained",
		nativeOutcome: { ok: false, code: "cleanup_pending", payloadDurable: true },
	});
	if (outcome.kind !== "payload_retired") throw new Error("Expected native payload retirement proof");
	expect(outcome.evidence).toEqual(h.evidence);
	expect(outcome.continuation.retainedTreeSnapshot.rootDev).toBe(h.evidence.locator.directoryDev);
	expect(outcome.continuation.retainedTreeSnapshot.rootIno).toBe(h.evidence.locator.directoryIno);
	const emptyDigest = crypto.createHash("sha256").update("").digest("hex");
	for (const entry of outcome.continuation.retainedTreeSnapshot.entries) {
		if (entry.kind !== "file") continue;
		expect(entry.size).toBe("0");
		expect(entry.sha256).toBe(emptyDigest);
		expect(await Bun.file(path.join(outcome.continuation.retainedRootPath, entry.relativePath)).text()).toBe("");
	}
	await expect(fs.lstat(h.ownerDir)).rejects.toMatchObject({ code: "ENOENT" });
	expect((await fs.stat(`${h.ownerDir}.removing`, { bigint: true })).ino.toString()).toBe(
		h.evidence.locator.directoryIno,
	);
	expect(await Bun.file(h.transcript).exists()).toBe(true);
});

it("persists immutable managed GC phases and replays the full native owner disposition", async () => {
	const h = await fixture();
	const removeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
	try {
		const { outcome: first, artifactsRemoved, receipt: firstReceipt } = await retireThroughGcToOwnerPending(h);
		expect(artifactsRemoved.state).toBe("artifacts_removed");
		expect(first).toMatchObject({
			kind: "cleanup_pending",
			taskArtifactOwnerPayloadRetired: true,
			taskArtifactOwnerNamespaceRetained: true,
		});
		if (first.kind !== "cleanup_pending") throw new Error("Expected GC namespace cleanup to remain pending");
		expect(first.taskArtifactOwnerRetired).toBeUndefined();
		expect(first.taskArtifactOwnerRetirementOutcome).toMatchObject({
			kind: "payload_retired",
			namespace: "retained",
			nativeOutcome: { ok: false, code: "cleanup_pending", payloadDurable: true },
		});
		expect(firstReceipt).toMatchObject({ state: "owner_pending", ownerRetirementAttempt: 1 });
		expect(firstReceipt?.taskArtifactOwnerDeletionEvidence).toEqual(h.evidence);
		expect(firstReceipt?.taskArtifactOwnerRetirementOutcome?.evidence).toEqual(h.evidence);
		const preparedPath = (
			await Array.fromAsync(
				new Bun.Glob("**/gc-retirement-*-prepared.json").scan({
					cwd: h.context.sessionsRoot,
					absolute: true,
					dot: true,
				}),
			)
		)[0];
		const removedPath = (
			await Array.fromAsync(
				new Bun.Glob("**/gc-retirement-*-artifacts_removed.json").scan({
					cwd: h.context.sessionsRoot,
					absolute: true,
					dot: true,
				}),
			)
		)[0];
		if (!preparedPath || !removedPath) throw new Error("Expected immutable prepared and artifact receipts");
		expect(JSON.parse(await Bun.file(preparedPath).text()).taskArtifactOwnerDeletionEvidence).toEqual(h.evidence);
		expect(JSON.parse(await Bun.file(removedPath).text()).taskArtifactOwnerDeletionEvidence).toEqual(h.evidence);
		expect(await Bun.file(h.transcript).exists()).toBe(true);
		await expect(fs.lstat(h.ownerDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.stat(`${h.ownerDir}.removing`, { bigint: true })).ino.toString()).toBe(
			h.evidence.locator.directoryIno,
		);

		const second = await retireSessionTranscript(
			new FileSessionStorage(),
			h.context.sessionsRoot,
			h.transcript,
			h.context,
			{ managedScope: h.scope },
		);
		expect(second).toMatchObject({
			kind: "cleanup_pending",
			taskArtifactOwnerPayloadRetired: true,
			taskArtifactOwnerNamespaceRetained: true,
		});
		if (second.kind !== "cleanup_pending") throw new Error("Expected replay to retain GC transcript");
		expect(second.taskArtifactOwnerRetired).toBeUndefined();
		expect(second.taskArtifactOwnerRetirementOutcome?.kind).toBe("payload_retired");
		const secondReceipt = readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target);
		expect(secondReceipt).toMatchObject({ state: "owner_pending", ownerRetirementAttempt: 2 });
		expect(secondReceipt?.taskArtifactOwnerDeletionEvidence).toEqual(h.evidence);
		expect(secondReceipt?.taskArtifactOwnerRetirementOutcome?.evidence).toEqual(h.evidence);
		expect(removeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(await Bun.file(h.transcript).exists()).toBe(true);
	} finally {
		removeSpy.mockRestore();
	}
});

for (const divergent of ["artifacts_removed"] as const) {
	it(`refuses a valid-shaped divergent ${divergent} owner snapshot before replay`, async () => {
		const h = await fixture();
		const prepared: ManagedGcSessionRetirementReceipt = {
			...h.target,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: h.evidence,
		};
		await publishManagedGcSessionRetirementReceipt(h.scope, h.context, prepared, "prepared");
		await publishManagedGcSessionRetirementReceipt(h.scope, h.context, prepared, "artifacts_removed");
		expect(readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target)?.state).toBe(divergent);
		const foreign = path.join(h.ownerDir, "foreign.txt");
		await Bun.write(foreign, "foreign data must survive");
		const changed = captureTaskArtifactOwnerDeletionEvidence(h.context, h.target.sessionId, h.evidence.locator)!;
		const files = await Array.fromAsync(
			new Bun.Glob(`**/gc-retirement-*-${divergent}.json`).scan({
				cwd: h.context.sessionsRoot,
				absolute: true,
				dot: true,
			}),
		);
		if (files.length !== 1) throw new Error("Expected one phase receipt");
		const record = JSON.parse(await Bun.file(files[0]!).text());
		record.taskArtifactOwnerDeletionEvidence = changed;
		await Bun.write(files[0]!, JSON.stringify(record));
		const transcriptBefore = await Bun.file(h.transcript).text();
		const inodeBefore = (await fs.stat(h.ownerDir, { bigint: true })).ino;
		const ownerBeforeReplay = await snapshotPath(h.ownerDir);
		await expect(
			retireSessionTranscript(new FileSessionStorage(), h.context.sessionsRoot, h.transcript, h.context, {
				managedScope: h.scope,
			}),
		).resolves.toMatchObject({
			kind: "kept",
			reason: expect.stringContaining("task_artifact_owner_continuation_invalid"),
		});
		expect(() => readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target)).toThrow(
			"task_artifact_owner_continuation_evidence_mismatch",
		);
		expect(await Bun.file(h.transcript).text()).toBe(transcriptBefore);
		expect(await Bun.file(foreign).text()).toBe("foreign data must survive");
		expect((await fs.stat(h.ownerDir, { bigint: true })).ino).toBe(inodeBefore);
		expect(await snapshotPath(h.ownerDir)).toEqual(ownerBeforeReplay);
	});
}

for (const corruption of ["stale-native-flag", "empty-snapshot"] as const) {
	it(`rejects a GC owner disposition with ${corruption} without promoting physical completion`, async () => {
		const h = await fixture();
		const { receipt } = await retireThroughGcToOwnerPending(h);
		if (receipt?.state !== "owner_pending") throw new Error("Expected persisted native owner disposition");
		const files = await Array.fromAsync(
			new Bun.Glob("**/gc-retirement-*-owner_pending-*.json").scan({
				cwd: h.context.sessionsRoot,
				absolute: true,
				dot: true,
			}),
		);
		if (files.length !== 1) throw new Error("Expected one native owner disposition receipt");
		const record = JSON.parse(await Bun.file(files[0]!).text());
		const outcome = record.taskArtifactOwnerRetirementOutcome as Record<string, unknown>;
		const continuation = outcome.continuation as Record<string, unknown>;
		if (corruption === "stale-native-flag") {
			const nativeOutcome = outcome.nativeOutcome as Record<string, unknown>;
			nativeOutcome.payloadDurable = false;
		} else {
			const tree = continuation.retainedTreeSnapshot as Record<string, unknown>;
			tree.entries = [];
			const receiptContinuation = record.taskArtifactOwnerRetirementContinuation as Record<string, unknown>;
			(receiptContinuation.retainedTreeSnapshot as Record<string, unknown>).entries = [];
		}
		await Bun.write(files[0]!, JSON.stringify(record));
		const persistedOutcome = receipt.taskArtifactOwnerRetirementOutcome;
		if (!persistedOutcome || persistedOutcome.kind === "completed")
			throw new Error("Expected recorded native remnant");
		const retainedRoot = persistedOutcome.continuation.retainedRootPath;
		const transcriptBefore = await Bun.file(h.transcript).bytes();
		const remnantBefore = await snapshotPath(retainedRoot);
		await expect(
			retireSessionTranscript(new FileSessionStorage(), h.context.sessionsRoot, h.transcript, h.context, {
				managedScope: h.scope,
			}),
		).resolves.toMatchObject({
			kind: "kept",
			reason: expect.stringContaining("task_artifact_owner_continuation_invalid"),
		});
		expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
		expect(await snapshotPath(retainedRoot)).toEqual(remnantBefore);
	});
}

it("refuses a repopulated native remnant before GC replay mutates it", async () => {
	const h = await fixture();
	const { receipt } = await retireThroughGcToOwnerPending(h);
	const outcome = receipt?.taskArtifactOwnerRetirementOutcome;
	if (outcome?.kind !== "payload_retired") throw new Error("Expected durable payload retirement proof");
	const transcriptBefore = await Bun.file(h.transcript).bytes();
	const repopulated = path.join(outcome.continuation.retainedRootPath, "foreign-repopulation.txt");
	await fs.writeFile(repopulated, "untrusted remnant content");
	const remnantBefore = await snapshotPath(outcome.continuation.retainedRootPath);
	await expect(
		retireSessionTranscript(new FileSessionStorage(), h.context.sessionsRoot, h.transcript, h.context, {
			managedScope: h.scope,
		}),
	).resolves.toMatchObject({
		kind: "kept",
		reason: expect.stringContaining("task_artifact_owner_continuation_invalid"),
	});
	expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
	expect(await snapshotPath(outcome.continuation.retainedRootPath)).toEqual(remnantBefore);
	expect(await Bun.file(repopulated).text()).toBe("untrusted remnant content");
});

for (const replacement of ["missing", "symlink", "different-inode", "foreign-manifest"] as const) {
	it(`refuses ${replacement} owner authority without replacement or foreign mutation`, async () => {
		const h = await fixture();
		const before = await Bun.file(h.transcript).text();
		const retained = `${h.ownerDir}.original`;
		await fs.rename(h.ownerDir, retained);
		const foreign = path.join(h.root, "foreign");
		await fs.mkdir(foreign, { mode: 0o700 });
		await Bun.write(path.join(foreign, "payload"), "foreign bytes");
		if (replacement === "symlink") await fs.symlink(foreign, h.ownerDir, "dir");
		if (replacement === "different-inode" || replacement === "foreign-manifest") {
			await fs.mkdir(h.ownerDir, { mode: 0o755 });
			const manifest = JSON.parse(await Bun.file(path.join(retained, ".gjc-task-artifact-owner-v1.json")).text());
			if (replacement === "foreign-manifest") manifest.sessionId = "foreign-session";
			await Bun.write(path.join(h.ownerDir, ".gjc-task-artifact-owner-v1.json"), JSON.stringify(manifest));
			await Bun.write(path.join(h.ownerDir, "payload"), "replacement bytes");
		}
		const replacementStat =
			replacement === "different-inode" || replacement === "foreign-manifest"
				? await fs.stat(h.ownerDir, { bigint: true })
				: undefined;
		const originalState = await snapshotPath(retained);
		const replacementState = await snapshotPath(h.ownerDir);
		const foreignState = await snapshotPath(foreign);
		const retirement = retireTaskArtifactOwner(h.context, h.evidence);
		expect(retirement.kind).not.toBe("completed");
		expect(await snapshotPath(retained)).toEqual(originalState);
		expect(await snapshotPath(h.ownerDir)).toEqual(replacementState);
		expect(await snapshotPath(foreign)).toEqual(foreignState);
		const reopened = await SessionManager.open(h.transcript, SessionManager.managedDestination(h.cwd, h.agentDir));
		try {
			expect(() => reopened.getArtifactManager()).toThrow("task_artifact_owner_");
			await expect(reopened.ensureArtifactManager()).rejects.toThrow("task_artifact_owner_");
			expect(await Bun.file(h.transcript).text()).toBe(before);
			expect(await Bun.file(path.join(foreign, "payload")).text()).toBe("foreign bytes");
			expect(await snapshotPath(retained)).toEqual(originalState);
			expect(await snapshotPath(h.ownerDir)).toEqual(replacementState);
			expect(await snapshotPath(foreign)).toEqual(foreignState);
			if (replacement === "missing") await expect(fs.lstat(h.ownerDir)).rejects.toMatchObject({ code: "ENOENT" });
			if (replacement === "symlink") expect((await fs.lstat(h.ownerDir)).isSymbolicLink()).toBe(true);
			if (replacement === "different-inode" || replacement === "foreign-manifest") {
				expect(await Bun.file(path.join(h.ownerDir, "payload")).text()).toBe("replacement bytes");
				const after = await fs.stat(h.ownerDir, { bigint: true });
				expect({
					dev: after.dev,
					ino: after.ino,
					mode: after.mode,
					mtimeNs: after.mtimeNs,
					ctimeNs: after.ctimeNs,
				}).toEqual({
					dev: replacementStat!.dev,
					ino: replacementStat!.ino,
					mode: replacementStat!.mode,
					mtimeNs: replacementStat!.mtimeNs,
					ctimeNs: replacementStat!.ctimeNs,
				});
			}
		} finally {
			await reopened.close();
		}
	});
}
