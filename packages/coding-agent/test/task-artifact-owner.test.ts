import { afterEach, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { $ } from "bun";
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
import * as managedStorage from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	FileSessionStorage,
	retireSessionTranscript,
	taskArtifactOwnerLocatorFromTranscriptBytes,
} from "../src/session/session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	restoreManagedTaskArtifactOwner,
	retireTaskArtifactOwner,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerRetirementContinuation,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner";

import { pauseManagedStagingWriter } from "./fixtures/task-owner-staging";

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

async function publishGcThroughArtifacts(h: OwnerGcFixture) {
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
	return { prepared, artifactsRemoved };
}

async function retireThroughGcToOwnerPending(h: OwnerGcFixture) {
	const { artifactsRemoved } = await publishGcThroughArtifacts(h);
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

it.skipIf(process.platform !== "darwin")(
	"GC defers live staging descriptors before publishing original retirement authority",
	async () => {
		const h = await fixture();
		const manager = await SessionManager.open(h.transcript, SessionManager.managedDestination(h.cwd, h.agentDir));
		const owner = manager.getArtifactManager();
		if (!owner) throw new Error("Expected admitted GC writer");
		const writer = pauseManagedStagingWriter(owner.dir);
		const nativeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
		const pending = owner.save("GC live descriptor payload", "probe").then(
			saved => ({ saved }),
			error => ({ error: String(error) }),
		);
		try {
			await writer.entered;
			const before = await Bun.file(h.transcript).bytes();
			await expect(
				retireSessionTranscript(new FileSessionStorage(), h.context.sessionsRoot, h.transcript, h.context, {
					managedScope: h.scope,
				}),
			).resolves.toMatchObject({
				kind: "kept",
				reason: expect.stringContaining("task_artifact_owner_writer_not_quiescent"),
			});
			expect(readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target)).toBeUndefined();
			expect(
				nativeSpy.mock.calls.filter(args => args[0] === owner.dir || args[0] === `${owner.dir}.removing`),
			).toHaveLength(0);
			expect(await Bun.file(h.transcript).bytes()).toEqual(before);
			writer.release();
			const written = await pending;
			if ("error" in written) throw new Error(written.error);
			const published = await owner.getPath(written.saved);
			if (!published) throw new Error("Expected acknowledged GC writer output");
			expect(await Bun.file(published).text()).toBe("GC live descriptor payload");
			await expect(
				retireSessionTranscript(new FileSessionStorage(), h.context.sessionsRoot, h.transcript, h.context, {
					managedScope: h.scope,
				}),
			).resolves.toMatchObject({ kind: "cleanup_pending", taskArtifactOwnerPayloadRetired: true });
			expect(await Bun.file(h.transcript).bytes()).toEqual(before);
		} finally {
			writer.release();
			await pending;
			writer.restore();
			nativeSpy.mockRestore();
			await manager.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"managed GC rejects in-flight owner publication and preserves proof on process restart",
	async () => {
		const h = await fixture();
		const manager = await SessionManager.open(h.transcript, SessionManager.managedDestination(h.cwd, h.agentDir));
		const owner = manager.getArtifactManager();
		if (!owner) throw new Error("Expected admitted GC writer");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const publish = managedStorage.ManagedSessionDescendantStore.prototype.publishNoReplace;
		const writerSpy = vi
			.spyOn(managedStorage.ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (this: managedStorage.ManagedSessionDescendantStore, relative, bytes) {
				if (this.dir === owner.dir && bytes.byteLength > 0) {
					entered.resolve();
					await release.promise;
				}
				return publish.call(this, relative, bytes);
			});
		const pendingWrite = owner.save("in-flight GC writer payload", "probe").then(
			value => ({ status: "saved" as const, value }),
			error => ({ status: "rejected" as const, error: String(error) }),
		);
		const remove = native.exactRemoveDirectoryTree;
		let nativeCalled = false;
		const removeSpy = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation((...args) => {
			const outcome = remove(...args);
			if (args[0] === owner.dir) {
				nativeCalled = true;
				release.resolve();
			}
			return outcome;
		});
		try {
			await entered.promise;
			const evidence = captureTaskArtifactOwnerDeletionEvidence(h.context, h.target.sessionId, h.evidence.locator);
			if (!evidence) throw new Error("Expected pre-retirement writer snapshot");
			h.evidence = evidence;
			const outcome = await retireSessionTranscript(
				new FileSessionStorage(),
				h.context.sessionsRoot,
				h.transcript,
				h.context,
				{ managedScope: h.scope },
			);
			expect(nativeCalled).toBe(true);
			expect(await pendingWrite).toMatchObject({
				status: "rejected",
				error: expect.stringMatching(/Managed root authority changed|ENOENT/),
			});
			expect(outcome).toMatchObject({
				kind: "cleanup_pending",
				taskArtifactOwnerPayloadRetired: true,
				taskArtifactOwnerDeletionEvidence: evidence,
			});
			const recorded = readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target);
			expect(recorded?.taskArtifactOwnerDeletionEvidence).toEqual(evidence);
			expect(await replayInFreshProcess(h)).toMatchObject({
				kind: "cleanup_pending",
				taskArtifactOwnerPayloadRetired: true,
			});
			expect(
				readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target)?.taskArtifactOwnerDeletionEvidence,
			).toEqual(evidence);
			expect(await Bun.file(h.transcript).exists()).toBe(true);
		} finally {
			release.resolve();
			await pendingWrite;
			writerSpy.mockRestore();
			removeSpy.mockRestore();
			await manager.close();
		}
	},
);

async function replayInFreshProcess(h: OwnerGcFixture) {
	const helper = path.join(import.meta.dir, "fixtures/task-owner-gc-replay.ts");
	const child = await $`${process.execPath} ${helper}`
		.env({
			...process.env,
			GJC_OWNER_REPLAY_INPUT: JSON.stringify({
				cwd: h.cwd,
				agentDir: h.agentDir,
				sessionsRoot: h.context.sessionsRoot,
				transcriptPath: h.transcript,
			}),
		})
		.quiet()
		.nothrow();
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	const report = JSON.parse(child.stdout.toString()) as {
		pid: number;
		outcome: { kind: string; taskArtifactOwnerPayloadRetired?: boolean; taskArtifactOwnerRetired?: boolean };
	};
	expect(report.pid).not.toBe(process.pid);
	return report.outcome;
}

for (const phase of ["prepared", "artifacts_removed", "owner_pending"] as const) {
	it.skipIf(process.platform !== "darwin")(`replays durable GC ${phase} in a fresh process`, async () => {
		const h = await fixture();
		if (phase === "prepared")
			await publishManagedGcSessionRetirementReceipt(
				h.scope,
				h.context,
				{
					...h.target,
					state: "prepared",
					taskArtifactOwnerDeletionEvidence: h.evidence,
				},
				"prepared",
			);
		else if (phase === "artifacts_removed") await publishGcThroughArtifacts(h);
		else await retireThroughGcToOwnerPending(h);
		const before = readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target);
		expect(before?.state).toBe(phase);
		const transcriptBefore = await Bun.file(h.transcript).bytes();
		expect(await replayInFreshProcess(h)).toMatchObject({
			kind: "cleanup_pending",
			taskArtifactOwnerPayloadRetired: true,
		});
		const after = readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target);
		expect(after).toMatchObject({
			state: "owner_pending",
			ownerRetirementAttempt: phase === "owner_pending" ? 2 : 1,
		});
		expect(after?.taskArtifactOwnerDeletionEvidence).toEqual(h.evidence);
		expect(after?.taskArtifactOwnerRetirementOutcome?.evidence).toEqual(h.evidence);
		expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
	});
}

for (const corruption of ["prepared", "missing-attempt", "expanded-next-attempt"] as const) {
	it.skipIf(process.platform !== "darwin")(
		`refuses ${corruption} GC receipt corruption in a fresh process`,
		async () => {
			const h = await fixture();
			await retireThroughGcToOwnerPending(h);
			await retireSessionTranscript(new FileSessionStorage(), h.context.sessionsRoot, h.transcript, h.context, {
				managedScope: h.scope,
			});
			const prepared = (
				await Array.fromAsync(
					new Bun.Glob("**/gc-retirement-*-prepared.json").scan({
						cwd: h.context.sessionsRoot,
						absolute: true,
						dot: true,
					}),
				)
			)[0];
			const attempts = (
				await Array.fromAsync(
					new Bun.Glob("**/gc-retirement-*-owner_pending-*.json").scan({
						cwd: h.context.sessionsRoot,
						absolute: true,
						dot: true,
					}),
				)
			).sort();
			if (!prepared || attempts.length !== 2) throw new Error("Expected prepared and two contiguous attempts");
			if (corruption === "prepared") {
				const record = JSON.parse(await Bun.file(prepared).text()) as Record<string, unknown>;
				record.schemaVersion = 99;
				await Bun.write(prepared, JSON.stringify(record));
			} else if (corruption === "missing-attempt") {
				await fs.rename(attempts[0]!, path.join(h.root, "retained-original-attempt.json"));
			} else {
				const record = JSON.parse(await Bun.file(attempts[1]!).text()) as {
					taskArtifactOwnerRetirementContinuation: TaskArtifactOwnerRetirementContinuation;
					taskArtifactOwnerRetirementOutcome: { continuation: TaskArtifactOwnerRetirementContinuation };
				};
				const original = record.taskArtifactOwnerRetirementContinuation;
				const entry = original.retainedTreeSnapshot.entries.find(item => item.kind === "file");
				if (!entry) throw new Error("Expected actual native empty-file evidence");
				const expanded = {
					...original,
					retainedTreeSnapshot: {
						...original.retainedTreeSnapshot,
						entries: [...original.retainedTreeSnapshot.entries, { ...entry, relativePath: "expanded-authority" }],
					},
				};
				record.taskArtifactOwnerRetirementContinuation = expanded;
				record.taskArtifactOwnerRetirementOutcome.continuation = expanded;
				await Bun.write(attempts[1]!, JSON.stringify(record));
			}
			const remnant = `${h.ownerDir}.removing`;
			const before = await snapshotPath(remnant);
			const transcriptBefore = await Bun.file(h.transcript).bytes();
			expect(await replayInFreshProcess(h)).toMatchObject({ kind: "kept" });
			expect(await snapshotPath(remnant)).toEqual(before);
			expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
		},
	);
}

for (const replacement of ["unchanged", "foreign-remnant"] as const) {
	it.skipIf(process.platform !== "darwin")(
		`replays original authority after failed GC disposition publication with ${replacement}`,
		async () => {
			const h = await fixture();
			await publishGcThroughArtifacts(h);
			const transcriptBefore = await Bun.file(h.transcript).bytes();
			const publish = managedStorage.publishManagedTombstone;
			let interrupted = false;
			const spy = vi
				.spyOn(managedStorage, "publishManagedTombstone")
				.mockImplementation(async (destination, record, assertOwned) => {
					if (record.state === "owner_pending") {
						interrupted = true;
						throw new Error("injected GC disposition publication failure");
					}
					return publish(destination, record, assertOwned);
				});
			try {
				const outcome = await retireSessionTranscript(
					new FileSessionStorage(),
					h.context.sessionsRoot,
					h.transcript,
					h.context,
					{ managedScope: h.scope },
				);
				expect(interrupted).toBe(true);
				expect(outcome).toMatchObject({
					kind: "cleanup_pending",
					reason: expect.stringContaining("injected GC disposition publication failure"),
				});
			} finally {
				spy.mockRestore();
			}
			await expect(fs.lstat(h.ownerDir)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await fs.stat(`${h.ownerDir}.removing`, { bigint: true })).ino.toString()).toBe(
				h.evidence.locator.directoryIno,
			);
			const predecessor = readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target);
			expect(predecessor?.state).toBe("artifacts_removed");
			expect(predecessor?.taskArtifactOwnerDeletionEvidence).toEqual(h.evidence);
			if (replacement === "foreign-remnant") {
				const remnant = `${h.ownerDir}.removing`;
				const original = `${remnant}.original`;
				await fs.rename(remnant, original);
				await fs.mkdir(remnant, { mode: 0o755 });
				await Bun.write(path.join(remnant, "foreign"), "foreign replacement bytes");
				const originalBefore = await snapshotPath(original);
				const foreignBefore = await snapshotPath(remnant);
				const outcome = await replayInFreshProcess(h);
				expect(outcome.kind).toBe("cleanup_pending");
				expect(outcome.taskArtifactOwnerPayloadRetired).toBeUndefined();
				expect(outcome.taskArtifactOwnerRetired).toBeUndefined();
				expect(await snapshotPath(original)).toEqual(originalBefore);
				expect(await snapshotPath(remnant)).toEqual(foreignBefore);
				expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
				expect(
					readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target)?.taskArtifactOwnerDeletionEvidence,
				).toEqual(h.evidence);
				return;
			}
			expect(await replayInFreshProcess(h)).toMatchObject({
				kind: "cleanup_pending",
				taskArtifactOwnerPayloadRetired: true,
			});
			const replayed = readManagedGcSessionRetirementReceipt(h.scope, h.context, h.target);
			expect(replayed).toMatchObject({ state: "owner_pending", ownerRetirementAttempt: 1 });
			expect(replayed?.taskArtifactOwnerDeletionEvidence).toEqual(h.evidence);
			expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
		},
	);
}

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
		await fs.chmod(foreign, 0o600);
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

it("refuses locator authority supplied under a foreign managed profile", async () => {
	const h = await fixture();
	const foreign = await fixture();
	const copied = path.join(foreign.context.sessionsRoot, ".task-artifact-owners", h.evidence.locator.ownerId);
	await fs.mkdir(copied, { mode: 0o700 });
	await Bun.write(
		path.join(copied, ".gjc-task-artifact-owner-v1.json"),
		await Bun.file(path.join(h.ownerDir, ".gjc-task-artifact-owner-v1.json")).bytes(),
	);
	await fs.chmod(path.join(copied, ".gjc-task-artifact-owner-v1.json"), 0o600);
	await Bun.write(path.join(copied, "foreign-payload"), "foreign profile bytes");
	await fs.chmod(path.join(copied, "foreign-payload"), 0o600);
	const sourceBefore = await snapshotPath(h.ownerDir);
	const foreignBefore = await snapshotPath(copied);
	const nativeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
	try {
		expect(() => restoreManagedTaskArtifactOwner(foreign.context, h.target.sessionId, h.evidence.locator)).toThrow(
			"task_artifact_owner_identity_mismatch",
		);
		expect(retireTaskArtifactOwner(foreign.context, h.evidence)).toMatchObject({
			kind: "uncertain",
			reason: "task_artifact_owner_parent_identity_changed",
		});
		await expect(
			retireSessionTranscript(
				new FileSessionStorage(),
				foreign.context.sessionsRoot,
				h.transcript,
				foreign.context,
				{ managedScope: foreign.scope },
			),
		).resolves.toMatchObject({ kind: "kept" });
		expect(nativeSpy.mock.calls).toHaveLength(0);
		expect(await snapshotPath(h.ownerDir)).toEqual(sourceBefore);
		expect(await snapshotPath(copied)).toEqual(foreignBefore);
	} finally {
		nativeSpy.mockRestore();
	}
});

for (const substitution of ["directory", "symlink"] as const) {
	it(`refuses captured owner parent ${substitution} substitution before retirement or replay`, async () => {
		const h = await fixture();
		const parent = path.dirname(h.ownerDir);
		const retained = `${parent}.original`;
		await fs.rename(parent, retained);
		const foreign = path.join(h.root, "foreign-parent");
		await fs.mkdir(foreign, { mode: 0o755 });
		await Bun.write(path.join(foreign, "payload"), "foreign parent bytes");
		if (substitution === "symlink") await fs.symlink(foreign, parent, "dir");
		else await fs.mkdir(parent, { mode: 0o755 });
		const originalBefore = await snapshotPath(retained);
		const namedBefore = await snapshotPath(parent);
		const foreignBefore = await snapshotPath(foreign);
		const transcriptBefore = await Bun.file(h.transcript).bytes();
		const nativeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
		try {
			expect(retireTaskArtifactOwner(h.context, h.evidence).kind).toBe("uncertain");
			await expect(
				retireSessionTranscript(new FileSessionStorage(), h.context.sessionsRoot, h.transcript, h.context, {
					managedScope: h.scope,
				}),
			).resolves.toMatchObject({ kind: "kept" });
			expect(nativeSpy.mock.calls).toHaveLength(0);
			expect(await snapshotPath(retained)).toEqual(originalBefore);
			expect(await snapshotPath(parent)).toEqual(namedBefore);
			expect(await snapshotPath(foreign)).toEqual(foreignBefore);
			expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
		} finally {
			nativeSpy.mockRestore();
		}
	});
}

it("preserves cross-scope owner references retained after managed move metadata rollback", async () => {
	const h = await fixture();
	const targetCwd = path.join(h.root, "target-workspace");
	await fs.mkdir(targetCwd);
	const destination = SessionManager.managedDestination(targetCwd, h.agentDir);
	if (destination.kind !== "managed") throw new Error("Expected managed target");
	const targetTranscript = path.join(destination.directory, path.basename(h.transcript));
	const manager = await SessionManager.open(h.transcript, SessionManager.managedDestination(h.cwd, h.agentDir));
	const append = managedStorage.ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
	let injected = false;
	const spy = vi
		.spyOn(managedStorage.ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
		.mockImplementation(function (this: managedStorage.ManagedSessionDescendantStore, relative, bytes, expected) {
			if (!injected && this.dir === destination.directory && relative === path.basename(h.transcript)) {
				injected = true;
				throw new Error("injected managed target metadata failure");
			}
			return append.call(this, relative, bytes, expected);
		});
	try {
		await expect(manager.moveTo(targetCwd)).rejects.toThrow("injected managed target metadata failure");
		expect(injected).toBe(true);
		expect(manager.getCwd()).toBe(h.cwd);
	} finally {
		spy.mockRestore();
		await manager.close();
	}
	const beforeSource = await Bun.file(h.transcript).bytes();
	const beforeTarget = await Bun.file(targetTranscript).bytes();
	expect(taskArtifactOwnerLocatorFromTranscriptBytes(beforeSource, h.target.sessionId)).toEqual(h.evidence.locator);
	expect(taskArtifactOwnerLocatorFromTranscriptBytes(beforeTarget, h.target.sessionId)).toEqual(h.evidence.locator);
	const ownerBefore = await snapshotPath(h.ownerDir);
	const storage = new FileSessionStorage();
	await expect(
		retireSessionTranscript(storage, h.context.sessionsRoot, h.transcript, h.context, { managedScope: h.scope }),
	).resolves.toMatchObject({
		kind: "kept",
		reason: "task_artifact_owner_shared_with_sibling_transcript",
	});
	const targetScope = resolveManagedScope({
		cwd: targetCwd,
		agentDir: h.agentDir,
		sessionsRoot: h.context.sessionsRoot,
	});
	if (targetScope.kind !== "resolved") throw new Error("Expected verified target scope");
	await expect(
		retireSessionTranscript(storage, h.context.sessionsRoot, targetTranscript, h.context, {
			managedScope: targetScope.scope,
		}),
	).resolves.toMatchObject({ kind: "kept" });
	expect(await Bun.file(h.transcript).bytes()).toEqual(beforeSource);
	expect(await Bun.file(targetTranscript).bytes()).toEqual(beforeTarget);
	expect(await snapshotPath(h.ownerDir)).toEqual(ownerBefore);
});

for (const boundary of ["capture", "native-security"] as const) {
	it(`refuses owner replacement at ${boundary} without security repair`, async () => {
		const h = await fixture();
		const retained = `${h.ownerDir}.original`;
		const replacement = path.join(h.root, "replacement");
		await fs.mkdir(replacement, { mode: 0o755 });
		await Bun.write(
			path.join(replacement, ".gjc-task-artifact-owner-v1.json"),
			await Bun.file(path.join(h.ownerDir, ".gjc-task-artifact-owner-v1.json")).bytes(),
		);
		await Bun.write(path.join(replacement, "payload"), "replacement bytes");
		const replacementChildren = await snapshotPath(replacement);
		const transcriptBefore = await Bun.file(h.transcript).bytes();
		let replacementStat: fsSync.BigIntStats | undefined;
		let swapped = false;
		const swap = () => {
			if (swapped) return;
			swapped = true;
			fsSync.renameSync(h.ownerDir, retained);
			fsSync.renameSync(replacement, h.ownerDir);
			replacementStat = fsSync.lstatSync(h.ownerDir, { bigint: true });
		};
		const capture = managedStorage.ManagedSessionDescendantStore.prototype.captureDirectoryIdentity;
		const verify = native.verifyOwnerOnlyPathSecurityExpected;
		const verifyPosix = native.verifyOwnerOnlyPathSecurity;
		const spy =
			boundary === "capture"
				? vi
						.spyOn(managedStorage.ManagedSessionDescendantStore.prototype, "captureDirectoryIdentity")
						.mockImplementation(function (this: managedStorage.ManagedSessionDescendantStore, relative) {
							const result = capture.call(this, relative);
							if (relative === `.task-artifact-owners/${h.evidence.locator.ownerId}`) swap();
							return result;
						})
				: process.platform === "win32"
					? vi
							.spyOn(native, "verifyOwnerOnlyPathSecurityExpected")
							.mockImplementation((pathname, kind, dev, ino) => {
								if (pathname === h.ownerDir) swap();
								return verify(pathname, kind, dev, ino);
							})
					: vi.spyOn(native, "verifyOwnerOnlyPathSecurity").mockImplementation((pathname, kind) => {
							if (pathname === h.ownerDir) swap();
							return verifyPosix(pathname, kind);
						});
		try {
			expect(() => restoreManagedTaskArtifactOwner(h.context, h.target.sessionId, h.evidence.locator)).toThrow(
				/Managed root authority changed|Owner-only security rejected/,
			);
			expect(swapped).toBe(true);
			if (!replacementStat) throw new Error("Expected the replacement boundary to execute");
			expect(fsSync.lstatSync(h.ownerDir, { bigint: true })).toEqual(replacementStat);
			expect(await Bun.file(path.join(h.ownerDir, "payload")).text()).toBe("replacement bytes");
			expect(await Bun.file(h.transcript).bytes()).toEqual(transcriptBefore);
			const after = await snapshotPath(h.ownerDir);
			expect(after).toMatchObject({ entries: (replacementChildren as { entries: unknown[] }).entries });
		} finally {
			spy.mockRestore();
		}
	});
}

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
			// Linux can refuse the deliberately unsafe 0755 replacement at its read-only
			// native security boundary before the owner-domain identity diagnostic.
			expect(() => reopened.getArtifactManager()).toThrow(/task_artifact_owner_|mode_mismatch/);
			await expect(reopened.ensureArtifactManager()).rejects.toThrow(/task_artifact_owner_|mode_mismatch/);
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
