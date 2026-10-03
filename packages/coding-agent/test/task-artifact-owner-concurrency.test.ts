import { afterEach, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { safeRm } from "../../../scripts/safe-cleanup";
import { managedRootForScope, resolveManagedScope } from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	FileSessionStorage,
	retireSessionTranscript,
	taskArtifactOwnerLocatorFromTranscriptBytes,
} from "../src/session/session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	ensureManagedTaskArtifactOwner,
	parseTaskArtifactOwnerRetirementOutcome,
	retireTaskArtifactOwner,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerStorageContext,
	verifyTaskArtifactOwnerRetirementContinuation,
} from "../src/session/task-artifact-owner";

import { pauseManagedStagingWriter } from "./fixtures/task-owner-staging";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map(root => safeRm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-concurrent-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const home = path.join(root, "profile");
	await fs.mkdir(cwd);
	await fs.mkdir(home);
	const destination = SessionManager.managedDestination(cwd, home);
	if (destination.kind !== "managed") throw new Error("Expected managed destination");
	const context: TaskArtifactOwnerStorageContext = {
		rootAuthority: destination.securityContext.rootAuthority,
		sessionsRoot: destination.securityContext.sessionsRoot,
		profileAgentDir: destination.securityContext.profileAgentDir,
		securityPolicy: process.platform === "win32" ? "windows-existing-verify-first" : "default",
	};
	return { root, cwd, home, context, manager: SessionManager.create(cwd, destination) };
}

it("serializes concurrent owner establishment and preserves one numeric claim space", async () => {
	const h = await fixture();
	try {
		const [first, second] = await Promise.all([h.manager.ensureArtifactManager(), h.manager.ensureArtifactManager()]);
		expect(first).not.toBeNull();
		expect(second).toBe(first);
		expect(h.manager.isArtifactManagerAuthorized(first!)).toBe(true);
		const allocations = await Promise.all([
			h.manager.allocateArtifactPath("probe"),
			h.manager.allocateArtifactPath("probe"),
		]);
		expect(allocations.every(allocation => allocation.id !== undefined)).toBe(true);
		expect(new Set(allocations.map(allocation => allocation.id)).size).toBe(2);
		const manifest = JSON.parse(await Bun.file(path.join(first!.dir, ".gjc-task-artifact-owner-v1.json")).text()) as {
			sessionId: string;
		};
		expect(manifest.sessionId).toBe(h.manager.getSessionId());
	} finally {
		await h.manager.close();
	}
});

it("serializes independent owner establishment contexts at the managed lock", async () => {
	const h = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const publish = ManagedSessionDescendantStore.prototype.publishNoReplace;
	let manifests = 0;
	let secondSettled = false;
	const spy = vi.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace").mockImplementation(async function (
		this: ManagedSessionDescendantStore,
		relative,
		bytes,
	) {
		if (relative.endsWith(".gjc-task-artifact-owner-v1.json")) {
			manifests++;
			entered.resolve();
			await release.promise;
		}
		return publish.call(this, relative, bytes);
	});
	try {
		const first = ensureManagedTaskArtifactOwner(h.context, h.manager.getSessionId(), undefined);
		await entered.promise;
		const second = ensureManagedTaskArtifactOwner({ ...h.context }, h.manager.getSessionId(), undefined).finally(
			() => {
				secondSettled = true;
			},
		);
		await Bun.sleep(20);
		expect(secondSettled).toBe(false);
		release.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(manifests).toBe(1);
		expect(a.manager).not.toBe(b.manager);
		expect(a.locator).toEqual(b.locator);
		const claims = await Promise.all([a.manager.allocatePath("probe"), b.manager.allocatePath("probe")]);
		expect(new Set(claims.map(claim => claim.id)).size).toBe(2);
		const owner = await h.manager.ensureArtifactManager();
		expect(owner?.dir).toBe(a.manager.dir);
		const transcript = h.manager.getSessionFile()!;
		await h.manager.close();
		const reopened = await SessionManager.open(transcript, SessionManager.managedDestination(h.cwd, h.home));
		try {
			expect(reopened.getArtifactManager()?.dir).toBe(a.manager.dir);
		} finally {
			await reopened.close();
		}
	} finally {
		release.resolve();
		spy.mockRestore();
		await h.manager.close();
	}
});

for (const boundary of ["before-manifest", "after-manifest"] as const) {
	it(`preserves legacy bytes and fails safely or restores exact ownership after ${boundary} interruption`, async () => {
		const h = await fixture();
		await h.manager.ensureOnDisk();
		const id = await h.manager.saveArtifact("legacy payload must survive", "probe");
		if (!id) throw new Error("Expected legacy artifact id");
		const transcript = h.manager.getSessionFile()!;
		const sessionId = h.manager.getSessionId();
		const ownerDir = path.join(
			h.home,
			"sessions",
			".task-artifact-owners",
			crypto.createHash("sha256").update(sessionId).digest("hex"),
		);
		const original = ManagedSessionDescendantStore.prototype.publishNoReplace;
		const publish = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				bytes: Uint8Array,
			) {
				if (boundary === "before-manifest" && relativePath.endsWith(".gjc-task-artifact-owner-v1.json"))
					throw new Error("injected owner provisioning interruption");
				return original.call(this, relativePath, bytes);
			});
		const sync = vi.spyOn(ManagedSessionDescendantStore.prototype, "fsyncTree");
		if (boundary === "after-manifest")
			sync.mockImplementation(() => {
				throw new Error("injected owner provisioning interruption");
			});
		await expect(h.manager.ensureArtifactManager()).rejects.toThrow("injected owner provisioning interruption");
		publish.mockRestore();
		sync.mockRestore();
		await h.manager.close();
		const reopened = await SessionManager.open(transcript, SessionManager.managedDestination(h.cwd, h.home));
		try {
			const legacy = await reopened.getArtifactPath(id);
			if (!legacy) throw new Error("Expected preserved legacy artifact");
			expect(await Bun.file(legacy).text()).toBe("legacy payload must survive");
			const before = (await fs.readdir(ownerDir)).sort();
			if (boundary === "before-manifest") {
				await expect(reopened.ensureArtifactManager()).rejects.toThrow("task_artifact_owner_manifest_missing");
				expect(await Bun.file(path.join(ownerDir, ".gjc-task-artifact-owner-v1.json")).exists()).toBe(false);
				expect((await fs.readdir(ownerDir)).sort()).toEqual(before);
			} else {
				const restored = await reopened.ensureArtifactManager();
				expect(restored?.dir).toBe(ownerDir);
				const restoredPath = await reopened.getArtifactPath(id);
				if (!restoredPath) throw new Error("Expected restored copied artifact");
				expect(await Bun.file(restoredPath).text()).toBe("legacy payload must survive");
				await reopened.close();
				const again = await SessionManager.open(transcript, SessionManager.managedDestination(h.cwd, h.home));
				try {
					expect(again.getArtifactManager()?.dir).toBe(ownerDir);
				} finally {
					await again.close();
				}
			}
		} finally {
			await reopened.close();
		}
	});
}

it.skipIf(process.platform !== "darwin")(
	"decodes actual durable scrub evidence without promoting stale flags or false native success",
	async () => {
		const h = await fixture();
		try {
			const owner = await h.manager.ensureArtifactManager();
			if (!owner) throw new Error("Expected managed owner");
			await h.manager.saveArtifact("payload requiring actual native durable scrub", "probe");
			const locator = taskArtifactOwnerLocatorFromTranscriptBytes(
				await Bun.file(h.manager.getSessionFile()!).bytes(),
				h.manager.getSessionId(),
			);
			const evidence = captureTaskArtifactOwnerDeletionEvidence(h.context, h.manager.getSessionId(), locator);
			if (!evidence) throw new Error("Expected exact owner authority");
			await h.manager.close();
			const outcome = retireTaskArtifactOwner(h.context, evidence);
			expect(outcome.kind).toBe("payload_retired");
			if (outcome.kind !== "payload_retired")
				throw new Error("Expected native retained namespace with payload proof");
			const restored = parseTaskArtifactOwnerRetirementOutcome(
				h.context,
				evidence,
				JSON.parse(JSON.stringify(outcome)),
			);
			expect(restored).toEqual(outcome);
			expect(verifyTaskArtifactOwnerRetirementContinuation(h.context, evidence, outcome.continuation)).toEqual(
				outcome.continuation,
			);
			expect(() =>
				parseTaskArtifactOwnerRetirementOutcome(h.context, evidence, {
					...outcome,
					nativeOutcome: { ...outcome.nativeOutcome, payloadDurable: false },
				}),
			).toThrow("task_artifact_owner_retirement_outcome_invalid");
			expect(() =>
				parseTaskArtifactOwnerRetirementOutcome(h.context, evidence, {
					kind: "completed",
					evidence,
					nativeOutcome: outcome.nativeOutcome,
				}),
			).toThrow("task_artifact_owner_retirement_outcome_invalid");
			expect(() =>
				parseTaskArtifactOwnerRetirementOutcome(h.context, evidence, { ...outcome, nativeOutcome: undefined }),
			).toThrow("task_artifact_owner_retirement_outcome_invalid");
			const retained = await fs.stat(outcome.continuation.retainedRootPath, { bigint: true });
			expect({ dev: retained.dev.toString(), ino: retained.ino.toString() }).toEqual({
				dev: evidence.locator.directoryDev,
				ino: evidence.locator.directoryIno,
			});
		} finally {
			await h.manager.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"keeps a previously admitted artifact writer closed after native payload retirement",
	async () => {
		const h = await fixture();
		try {
			const owner = await h.manager.ensureArtifactManager();
			if (!owner) throw new Error("Expected managed owner");
			await owner.save("writer payload before quiescence", "probe");
			const locator = taskArtifactOwnerLocatorFromTranscriptBytes(
				await Bun.file(h.manager.getSessionFile()!).bytes(),
				h.manager.getSessionId(),
			);
			const evidence = captureTaskArtifactOwnerDeletionEvidence(h.context, h.manager.getSessionId(), locator);
			if (!evidence) throw new Error("Expected exact owner authority");
			await h.manager.close();
			const outcome = retireTaskArtifactOwner(h.context, evidence);
			expect(outcome.kind).toBe("payload_retired");
			if (outcome.kind !== "payload_retired") throw new Error("Expected actual native retained namespace");
			const before = (await fs.readdir(outcome.continuation.retainedRootPath)).sort();
			await expect(owner.save("must not repopulate retired payload", "probe")).rejects.toThrow();
			expect((await fs.readdir(outcome.continuation.retainedRootPath)).sort()).toEqual(before);
			expect(verifyTaskArtifactOwnerRetirementContinuation(h.context, evidence, outcome.continuation)).toEqual(
				outcome.continuation,
			);
			await expect(fs.lstat(owner.dir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await h.manager.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"refuses an independent managed replacement descriptor before capture or retirement",
	async () => {
		const h = await fixture();
		const owner = await h.manager.ensureArtifactManager();
		if (!owner) throw new Error("Expected managed owner");
		const id = await owner.save("original replacement payload", "probe");
		const payload = await owner.getPath(id);
		if (!payload) throw new Error("Expected original managed payload");
		const ready = path.join(h.root, "replacement-ready.json");
		const release = path.join(h.root, "replacement-release");
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/task-owner-replacement-writer.ts")],
			{
				env: {
					...process.env,
					GJC_REPLACEMENT_WRITER_INPUT: JSON.stringify({
						cwd: h.cwd,
						agentDir: h.home,
						transcript: h.manager.getSessionFile(),
						filename: path.basename(payload),
						ready,
						release,
					}),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		const nativeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
		try {
			const deadline = Date.now() + 5000;
			while (!(await Bun.file(ready).exists())) {
				if (child.exitCode !== null || Date.now() > deadline)
					throw new Error(`Replacement descriptor fixture failed: ${await stderr}`);
				await Bun.sleep(10);
			}
			const observation = (await Bun.file(ready).json()) as {
				pid: number;
				replacement: string;
				dev: string;
				ino: string;
			};
			expect(observation.pid).not.toBe(process.pid);
			expect(observation.replacement).toMatch(/\.replacement$/);
			const locator = taskArtifactOwnerLocatorFromTranscriptBytes(
				await Bun.file(h.manager.getSessionFile()!).bytes(),
				h.manager.getSessionId(),
			);
			if (!locator) throw new Error("Expected persisted owner locator");
			let captureFailure: string | undefined;
			let captured: TaskArtifactOwnerDeletionEvidence | undefined;
			try {
				captured = captureTaskArtifactOwnerDeletionEvidence(h.context, h.manager.getSessionId(), locator);
			} catch (error) {
				captureFailure = String(error);
			}
			if (captured) {
				const retired = retireTaskArtifactOwner(h.context, captured);
				await Bun.write(release, "release");
				await child.exited;
				if (retired.kind === "payload_retired")
					expect(
						await Bun.file(path.join(retired.continuation.retainedRootPath, observation.replacement)).text(),
					).toBe("");
				throw new Error("Retirement capture admitted the active replacement descriptor");
			}
			expect(captureFailure).toContain("task_artifact_owner_writer_not_quiescent");
			const stat = await fs.stat(h.context.sessionsRoot, { bigint: true });
			const store = new ManagedSessionDescendantStore(
				h.context.rootAuthority,
				h.context.sessionsRoot,
				undefined,
				h.context.securityPolicy,
				h.context.profileAgentDir,
				{ canonicalPath: h.context.sessionsRoot, dev: stat.dev, ino: stat.ino },
			);
			const raw = {
				schemaVersion: 2 as const,
				sessionId: h.manager.getSessionId(),
				locator,
				parentIdentity: store.captureDirectoryIdentity(".task-artifact-owners"),
				treeSnapshot: store.captureTree(`.task-artifact-owners/${locator.ownerId}`),
			};
			store.close();
			expect(retireTaskArtifactOwner(h.context, raw)).toMatchObject({
				kind: "uncertain",
				reason: "task_artifact_owner_writer_not_quiescent",
			});
			const scope = resolveManagedScope({ cwd: h.cwd, agentDir: h.home, sessionsRoot: h.context.sessionsRoot });
			if (scope.kind !== "resolved") throw new Error("Expected independent writer GC scope");
			await expect(
				retireSessionTranscript(
					new FileSessionStorage(),
					h.context.sessionsRoot,
					h.manager.getSessionFile()!,
					{ ...h.context, rootAuthority: managedRootForScope(scope.scope) },
					{ managedScope: scope.scope },
				),
			).resolves.toMatchObject({
				kind: "kept",
				reason: expect.stringContaining("task_artifact_owner_writer_not_quiescent"),
			});
			expect(
				await Array.fromAsync(
					new Bun.Glob("**/gc-retirement-*-prepared.json").scan({ cwd: h.context.sessionsRoot, dot: true }),
				),
			).toHaveLength(0);
			expect(nativeSpy.mock.calls).toHaveLength(0);
			await Bun.write(release, "release");
			expect(await child.exited, await stderr).toBe(0);
			expect(JSON.parse(await stdout)).toMatchObject({ status: "acknowledged", pid: observation.pid });
			expect(await Bun.file(payload).text()).toBe("acknowledged independent replacement payload");
			expect((await fs.stat(owner.dir, { bigint: true })).ino.toString()).toBe(locator.directoryIno);
		} finally {
			await Bun.write(release, "release");
			await child.exited;
			nativeSpy.mockRestore();
			await h.manager.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"refuses retirement while an opened managed staging descriptor can still write",
	async () => {
		const h = await fixture();
		const owner = await h.manager.ensureArtifactManager();
		if (!owner) throw new Error("Expected managed owner");
		await owner.save("original payload", "probe");
		const writer = pauseManagedStagingWriter(owner.dir);
		const removeSpy = vi.spyOn(native, "exactRemoveDirectoryTree");
		const pending = owner.save("late descriptor payload", "probe").then(
			value => ({ saved: value }),
			error => ({ error: String(error) }),
		);
		try {
			await writer.entered;
			const locator = taskArtifactOwnerLocatorFromTranscriptBytes(
				await Bun.file(h.manager.getSessionFile()!).bytes(),
				h.manager.getSessionId(),
			);
			if (!locator) throw new Error("Expected persisted owner locator");
			expect(() => captureTaskArtifactOwnerDeletionEvidence(h.context, h.manager.getSessionId(), locator)).toThrow(
				"task_artifact_owner_writer_not_quiescent",
			);
			const rootStat = await fs.stat(h.context.sessionsRoot, { bigint: true });
			const store = new ManagedSessionDescendantStore(
				h.context.rootAuthority,
				h.context.sessionsRoot,
				undefined,
				h.context.securityPolicy,
				h.context.profileAgentDir,
				{
					canonicalPath: h.context.sessionsRoot,
					dev: rootStat.dev,
					ino: rootStat.ino,
				},
			);
			const evidence = {
				schemaVersion: 2 as const,
				sessionId: h.manager.getSessionId(),
				locator,
				parentIdentity: store.captureDirectoryIdentity(".task-artifact-owners"),
				treeSnapshot: store.captureTree(`.task-artifact-owners/${locator.ownerId}`),
			};
			store.close();
			const result = retireTaskArtifactOwner(h.context, evidence);
			expect(result).toMatchObject({ kind: "uncertain", reason: "task_artifact_owner_writer_not_quiescent" });
			expect(removeSpy.mock.calls).toHaveLength(0);
			writer.release();
			const written = await pending;
			if ("error" in written) throw new Error(written.error);
			const published = await owner.getPath(written.saved);
			if (!published) throw new Error("Expected acknowledged writer output to survive");
			expect(await Bun.file(published).text()).toBe("late descriptor payload");
			expect((await fs.stat(owner.dir, { bigint: true })).ino.toString()).toBe(evidence.locator.directoryIno);
		} finally {
			writer.release();
			await pending;
			writer.restore();
			removeSpy.mockRestore();
			await h.manager.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"rejects an in-flight admitted publication after actual native owner retirement",
	async () => {
		const h = await fixture();
		const owner = await h.manager.ensureArtifactManager();
		if (!owner) throw new Error("Expected managed owner");
		await owner.save("acknowledged original payload", "probe");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const publish = ManagedSessionDescendantStore.prototype.publishNoReplace;
		const writeSpy = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (this: ManagedSessionDescendantStore, relative, bytes) {
				if (this.dir === owner.dir && bytes.byteLength > 0) {
					entered.resolve();
					await release.promise;
				}
				return publish.call(this, relative, bytes);
			});
		const pendingWrite = owner.save("in-flight writer payload", "probe").then(
			value => ({ status: "saved" as const, value }),
			error => ({ status: "rejected" as const, error: String(error) }),
		);
		let nativeCalled = false;
		const remove = native.exactRemoveDirectoryTree;
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
			const locator = taskArtifactOwnerLocatorFromTranscriptBytes(
				await Bun.file(h.manager.getSessionFile()!).bytes(),
				h.manager.getSessionId(),
			);
			const evidence = captureTaskArtifactOwnerDeletionEvidence(h.context, h.manager.getSessionId(), locator);
			if (!evidence) throw new Error("Expected captured in-flight owner authority");
			const outcome = retireTaskArtifactOwner(h.context, evidence);
			expect(nativeCalled).toBe(true);
			expect(outcome.kind).toBe("payload_retired");
			expect(await pendingWrite).toMatchObject({
				status: "rejected",
				error: expect.stringMatching(/Managed root authority changed|ENOENT/),
			});
			if (outcome.kind !== "payload_retired") throw new Error("Expected actual native payload proof");
			const verified = verifyTaskArtifactOwnerRetirementContinuation(h.context, evidence, outcome.continuation);
			expect(verified.retainedTreeSnapshot).toEqual(outcome.continuation.retainedTreeSnapshot);
			for (const entry of verified.retainedTreeSnapshot.entries) {
				if (entry.kind === "file")
					expect(await Bun.file(path.join(verified.retainedRootPath, entry.relativePath)).text()).toBe("");
			}
			await expect(fs.lstat(owner.dir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			release.resolve();
			await pendingWrite;
			writeSpy.mockRestore();
			removeSpy.mockRestore();
			await h.manager.close();
		}
	},
);

it("refuses retirement when a real admitted writer advances the captured owner tree", async () => {
	const h = await fixture();
	try {
		const owner = await h.manager.ensureArtifactManager();
		if (!owner) throw new Error("Expected managed owner");
		const beforeId = await h.manager.saveArtifact("captured writer payload", "probe");
		if (!beforeId) throw new Error("Expected artifact claim");
		const context = h.context;
		const locator = taskArtifactOwnerLocatorFromTranscriptBytes(
			await Bun.file(h.manager.getSessionFile()!).bytes(),
			h.manager.getSessionId(),
		);
		const evidence = captureTaskArtifactOwnerDeletionEvidence(context, h.manager.getSessionId(), locator);
		if (!evidence) throw new Error("Expected exact owner authority");
		const lateId = await h.manager.saveArtifact("writer publication after retirement capture", "probe");
		if (!lateId) throw new Error("Expected later writer claim");
		const beforePath = await h.manager.getArtifactPath(beforeId);
		const latePath = await h.manager.getArtifactPath(lateId);
		if (!beforePath || !latePath) throw new Error("Expected live writer artifact paths");
		const identity = await fs.stat(owner.dir, { bigint: true });
		const result = retireTaskArtifactOwner(context, evidence);
		expect(result.kind).toBe("uncertain");
		if (result.kind !== "uncertain") throw new Error("Retirement widened its captured authority");
		expect(result.reason).toBe("task_artifact_owner_retained_root_not_found_or_unverified");
		expect(result.nativeOutcome).toBeUndefined();
		expect(await Bun.file(beforePath).text()).toBe("captured writer payload");
		expect(await Bun.file(latePath).text()).toBe("writer publication after retirement capture");
		const after = await fs.stat(owner.dir, { bigint: true });
		expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: identity.dev, ino: identity.ino });
		expect(await fs.readdir(path.dirname(owner.dir))).not.toContain(`${path.basename(owner.dir)}.removing`);
	} finally {
		await h.manager.close();
	}
});

it("refuses a missing persisted manifest without creating an empty replacement", async () => {
	const h = await fixture();
	const owner = await h.manager.ensureArtifactManager();
	if (!owner) throw new Error("Expected managed owner");
	await h.manager.saveArtifact("original payload", "probe");
	const transcript = h.manager.getSessionFile()!;
	await h.manager.close();
	const manifest = path.join(owner.dir, ".gjc-task-artifact-owner-v1.json");
	const retained = path.join(h.root, "original-manifest.json");
	await fs.rename(manifest, retained);
	const treeBefore = (await fs.readdir(owner.dir)).sort();
	const transcriptBefore = await Bun.file(transcript).text();
	const manifestBefore = await Bun.file(retained).text();
	const reopened = await SessionManager.open(transcript, SessionManager.managedDestination(h.cwd, h.home));
	try {
		expect(() => reopened.getArtifactManager()).toThrow("task_artifact_owner_manifest_missing");
		await expect(reopened.ensureArtifactManager()).rejects.toThrow("task_artifact_owner_manifest_missing");
		expect(await Bun.file(manifest).exists()).toBe(false);
		expect((await fs.readdir(owner.dir)).sort()).toEqual(treeBefore);
		expect(await Bun.file(retained).text()).toBe(manifestBefore);
		expect(await Bun.file(transcript).text()).toBe(transcriptBefore);
	} finally {
		await reopened.close();
	}
});
