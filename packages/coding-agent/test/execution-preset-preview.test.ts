import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "../src/capability/types";
import {
	applyExecutionPreset,
	clearExecutionPreset,
	type ExecutionPreset,
	type ExecutionPresetPreview,
	ExecutionPresetStore,
	previewExecutionPreset,
} from "../src/config/execution-preset";
import {
	type ScopedConfigurationMutationReceipt,
	type ScopedConfigurationMutationRequest,
	ScopedConfigurationMutationService,
	type ScopedConfigurationRuntimeContext,
	type ScopedConfigurationRuntimeResult,
	type ScopedConfigurationSnapshot,
} from "../src/config/scoped-configuration-mutation";
import { DEFAULT_TASK_EXECUTION_POLICY, TaskExecutionPolicyController } from "../src/task/execution-policy";

const temporaryRoots: string[] = [];
const PERSISTENT_SCOPES: readonly ("project" | "user")[] = ["project", "user"];

async function makeRoot(): Promise<string> {
	const temporaryDirectory = await fs.realpath(os.tmpdir());
	const root = await fs.mkdtemp(path.join(temporaryDirectory, "gjc-execution-preset-preview-"));
	temporaryRoots.push(root);
	return root;
}

function loadContext(root: string): LoadContext {
	return {
		cwd: path.join(root, "repo", "nested"),
		home: path.join(root, "home"),
		repoRoot: path.join(root, "repo"),
	};
}

function targetPath(root: string, scope: "project" | "user"): string {
	return scope === "project" ? path.join(root, "repo", ".gjc", "config.yml") : path.join(root, "agent", "config.yml");
}

function createScopedWriter(
	root: string,
	reloadAndVerify: () => boolean = () => true,
): {
	readonly writer: Pick<ScopedConfigurationMutationService, "read" | "mutate">;

	readonly requests: ScopedConfigurationMutationRequest[];
} {
	const service = new ScopedConfigurationMutationService({
		loadContext: loadContext(root),
		agentDir: path.join(root, "agent"),
		reloadAndVerify,
	});
	const requests: ScopedConfigurationMutationRequest[] = [];
	const writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
		read: scope => service.read(scope),
		mutate: request => {
			requests.push(request);
			return service.mutate(request);
		},
	};
	return { writer, requests };
}

function serializedPreset(preset: ExecutionPreset): Record<string, unknown> {
	return {
		id: preset.id,
		label: preset.label,
		description: preset.description,
		policy: {
			isolation: preset.policy.isolation,
			toolAccess: {
				allow: [...preset.policy.toolAccess.allow],
				deny: [...preset.policy.toolAccess.deny],
			},
			mcpDiscovery: preset.policy.mcpDiscovery,
			maxDurationMs: preset.policy.maxDurationMs,
			simpleMode: preset.policy.simpleMode,
		},
	};
}

function expectedPresetFingerprint(preset: ExecutionPreset): string {
	return createHash("sha256")
		.update(JSON.stringify(serializedPreset(preset)), "utf8")
		.digest("hex");
}

function expectedPreviewFingerprint(preview: ExecutionPresetPreview): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				schema: "execution-preset-preview.v1",
				presetId: preview.preset.id,
				presetFingerprint: expectedPresetFingerprint(preview.preset),
				beforeRevision: preview.beforeRevision,
				beforeFingerprint: preview.beforeFingerprint,
				afterFingerprint: preview.after.fingerprint,
				scope: preview.scope,
			}),
			"utf8",
		)
		.digest("hex");
}

function publicJson(value: unknown): string {
	return JSON.stringify(value);
}

function digestBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function applyAtScope(
	root: string,
	scope: "project" | "user",
	reloadAndVerify: () => boolean = () => true,
): Promise<{
	readonly controller: TaskExecutionPolicyController;
	readonly preview: ExecutionPresetPreview;
	readonly applied: Awaited<ReturnType<typeof applyExecutionPreset>>;
	readonly requests: ScopedConfigurationMutationRequest[];
	readonly store: ExecutionPresetStore;
}> {
	const fixture = createScopedWriter(root, reloadAndVerify);
	const store = new ExecutionPresetStore({ scope, scopedMutationService: fixture.writer });
	const controller = new TaskExecutionPolicyController();
	const preview = previewExecutionPreset(store, "fast-build", controller, scope);
	const applied = await applyExecutionPreset(store, preview, controller, scope);
	return { controller, preview, applied, requests: fixture.requests, store };
}

afterEach(async () => {
	while (temporaryRoots.length > 0) {
		const root = temporaryRoots.pop();
		if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("execution preset preview, apply, and clear", () => {
	it("previews without mutation and reports the exact secure-review receipt", () => {
		const store = new ExecutionPresetStore();
		const controller = new TaskExecutionPolicyController();
		const before = controller.getSnapshot();
		const storeRevision = store.revision;
		const preview = previewExecutionPreset(store, "secure-review", controller, "session");

		expect(controller.getSnapshot()).toBe(before);
		expect(store.revision).toBe(storeRevision);
		expect(preview.schema).toBe("execution-preset-preview.v1");
		expect(preview.presetId).toBe("secure-review");
		expect(preview.scope).toBe("session");
		expect(preview.before).toBe(before);
		expect(preview.beforeRevision).toBe(0);
		expect(preview.revision).toBe(0);
		expect(preview.beforeFingerprint).toBe(before.fingerprint);
		expect(preview.after.revision).toBe(1);
		expect(preview.after.fingerprint).not.toBe(before.fingerprint);
		expect(preview.presetFingerprint).toBe(expectedPresetFingerprint(preview.preset));
		expect(preview.fingerprint).toBe(expectedPreviewFingerprint(preview));
		expect(preview.changedFields).toEqual(["isolation", "toolAccess", "mcpDiscovery", "maxDurationMs", "simpleMode"]);
		expect(preview.changedLaunchEnforcedFields).toEqual(preview.changedFields);
		expect(preview.scope).toBe(preview.expectation.scope);
		expect(preview.timing).toBe("current_runtime");
		expect(preview.timingExpectation).toBe("current_runtime");
		expect(preview.durability).toBe("none");
		expect(preview.durabilityExpectation).toBe("none");
		expect(preview.expectation).toEqual({ scope: "session", timing: "current_runtime", durability: "none" });
		expect(preview.warnings).toEqual([
			"Worktree isolation requires an owned workspace.",
			"MCP discovery is disabled for this preset.",
			"Denied tools: edit, write, bash.",
			"Launch timeout: 30 minutes.",
		]);
		expect(preview.derivedWorkMode).toBeNull();
		expect(Object.isFrozen(preview)).toBe(true);
		expect(Object.isFrozen(preview.preset)).toBe(true);
		expect(Object.isFrozen(preview.before)).toBe(true);
		expect(Object.isFrozen(preview.after)).toBe(true);
	});

	it("keeps public preview JSON free of model, profile, work-mode, cost, path, and error fields", () => {
		const store = new ExecutionPresetStore();
		const preview = previewExecutionPreset(store, "secure-review", new TaskExecutionPolicyController(), "session");
		const json = publicJson(preview);

		for (const forbidden of ["model", "profile", "workMode", "cost", "safePath", "config.yml", "error"]) {
			expect(json).not.toContain(forbidden);
		}
	});

	it("fails closed when a preview revision or fingerprint is stale", async () => {
		const store = new ExecutionPresetStore();
		const controller = new TaskExecutionPolicyController();
		const preview = previewExecutionPreset(store, "fast-build", controller, "session");
		const staleRevision = { ...preview, beforeRevision: preview.beforeRevision + 1 };
		const staleFingerprint = { ...preview, beforeFingerprint: `${preview.beforeFingerprint}-stale` };

		const revisionResult = await applyExecutionPreset(store, staleRevision, controller, "session");
		expect(revisionResult).toMatchObject({
			ok: false,
			status: "rejected",
			reason: "preview_stale",
			mutationReceipt: null,
			timing: "current_runtime",
			durability: "none",
		});
		expect(controller.getSnapshot()).toEqual(preview.before);

		const fingerprintResult = await applyExecutionPreset(store, staleFingerprint, controller, "session");
		expect(fingerprintResult).toMatchObject({
			ok: false,
			status: "rejected",
			reason: "preview_stale",
			mutationReceipt: null,
			timing: "current_runtime",
			durability: "none",
		});
		expect(controller.getSnapshot()).toEqual(preview.before);
	});
	it("cancels already-aborted applies before runtime or persistent mutation", async () => {
		const sessionStore = new ExecutionPresetStore();
		const sessionController = new TaskExecutionPolicyController();
		const sessionPreview = previewExecutionPreset(sessionStore, "fast-build", sessionController, "session");
		const sessionBefore = sessionController.getSnapshot();
		const sessionAbort = new AbortController();
		sessionAbort.abort();

		const sessionResult = await applyExecutionPreset(sessionStore, sessionPreview, sessionController, {
			scope: "session",
			preview: sessionPreview,
			signal: sessionAbort.signal,
		});
		expect(sessionResult).toMatchObject({
			ok: false,
			status: "rejected",
			reason: "cancelled",
			mutationReceipt: null,
		});
		expect(sessionController.getSnapshot()).toEqual(sessionBefore);

		const root = await makeRoot();
		const fixture = createScopedWriter(root);
		const projectStore = new ExecutionPresetStore({ scope: "project", scopedMutationService: fixture.writer });
		const projectController = new TaskExecutionPolicyController();
		const projectPreview = previewExecutionPreset(projectStore, "fast-build", projectController, "project");
		const projectBefore = projectController.getSnapshot();
		const projectAbort = new AbortController();
		projectAbort.abort();

		const projectResult = await applyExecutionPreset(projectStore, projectPreview, projectController, {
			scope: "project",
			preview: projectPreview,
			signal: projectAbort.signal,
		});
		expect(projectResult).toMatchObject({
			ok: false,
			status: "rejected",
			reason: "cancelled",
			mutationReceipt: null,
		});
		expect(projectController.getSnapshot()).toEqual(projectBefore);
		expect(fixture.requests).toHaveLength(0);
	});

	it("cancels an apply aborted between pre-commit and the atomic commit guard", async () => {
		const root = await makeRoot();
		const target = targetPath(root, "project");
		await fs.mkdir(path.dirname(target), { recursive: true });
		const initial = "keep:\n  value: true\n";
		await Bun.write(target, initial);
		const abort = new AbortController();
		let initialReadCompleted = false;
		let initialReadInspectionFinished = false;
		const filesystem = {
			lstat: async (component: string) => {
				const stat = await fs.lstat(component);
				if (initialReadCompleted) {
					if (!initialReadInspectionFinished && component === target) {
						initialReadInspectionFinished = true;
					} else if (initialReadInspectionFinished && !abort.signal.aborted) {
						abort.abort();
					}
				}
				return stat;
			},
			readFile: async (component: string, encoding: "utf8") => {
				const value = await fs.readFile(component, encoding);
				initialReadCompleted = true;
				return value;
			},
		};
		const service = new ScopedConfigurationMutationService({
			loadContext: loadContext(root),
			agentDir: path.join(root, "agent"),
			reloadAndVerify: () => true,
			filesystem,
		});
		const writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
			read: scope => service.read(scope),
			mutate: request => service.mutate(request),
		};
		const store = new ExecutionPresetStore({ scope: "project", scopedMutationService: writer });
		const controller = new TaskExecutionPolicyController();
		const preview = previewExecutionPreset(store, "fast-build", controller, "project");
		const beforeController = controller.getSnapshot();
		const beforeCatalog = store.catalog;
		const beforeBytes = await Bun.file(target).bytes();
		const beforeDigest = digestBytes(beforeBytes);

		const applied = await applyExecutionPreset(store, preview, controller, {
			scope: "project",
			preview,
			signal: abort.signal,
		});

		expect(abort.signal.aborted).toBe(true);
		expect(applied).toMatchObject({
			ok: false,
			status: "rejected",
			reason: "cancelled",
			mutationReceipt: null,
		});
		expect(controller.getSnapshot()).toEqual(beforeController);
		expect(store.catalog).toEqual(beforeCatalog);
		const afterBytes = await Bun.file(target).bytes();
		expect(afterBytes).toEqual(beforeBytes);
		expect(digestBytes(afterBytes)).toBe(beforeDigest);
	});
	it("reports a post-commit abort as degraded committed truth without claiming cancellation or applying the controller", async () => {
		const beforeSnapshot: ScopedConfigurationSnapshot = {
			scope: "project",
			path: "/safe/project/config.yml",
			safePath: "/safe/project/config.yml",
			exists: true,
			ownerIdentity: "execution-preset-preview-test",
			revision: "revision-0",
			digest: "digest-0",
			data: {},
		};
		const requests: ScopedConfigurationMutationRequest[] = [];
		const controllerAbort = new AbortController();
		let runtimeResult: ScopedConfigurationRuntimeResult | undefined;
		const writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
			read: async () => beforeSnapshot,
			mutate: async request => {
				requests.push(request);
				const runtime = request.runtime;
				if (!runtime) throw new Error("Persistent apply runtime gate was not provided");
				runtimeResult = await runtime.apply({
					scope: "project",
					phase: "before_commit",
					target: beforeSnapshot.safePath,
					path: beforeSnapshot.path,
					safePath: beforeSnapshot.safePath,
					patches: request.patches,
					before: beforeSnapshot,
				} satisfies ScopedConfigurationRuntimeContext);
				controllerAbort.abort();
				return {
					status: "committed",
					reason: null,
					scope: "project",
					safePath: beforeSnapshot.safePath,
					beforeRevision: beforeSnapshot.revision,
					afterRevision: "revision-1",
					beforeDigest: beforeSnapshot.digest,
					afterDigest: "digest-1",
					timing: "next_session",
					confirmation: "confirmed",
					durability: "committed",
					patches: [{ op: "set", path: "execution.presets.active" }],
				} satisfies ScopedConfigurationMutationReceipt;
			},
		};
		const store = new ExecutionPresetStore({ scope: "project", scopedMutationService: writer });
		const controller = new TaskExecutionPolicyController();
		const before = controller.getSnapshot();
		const preview = previewExecutionPreset(store, "fast-build", controller, "project");
		const applied = await applyExecutionPreset(store, preview, controller, {
			scope: "project",
			preview,
			signal: controllerAbort.signal,
		});

		expect(runtimeResult).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.runtime?.phase).toBe("before_commit");
		expect(applied).toMatchObject({
			ok: false,
			status: "degraded",
			reason: "runtime_postcommit_failed",
			durability: "committed",
			controllerRevision: before.revision,
			controllerFingerprint: before.fingerprint,
			mutationReceipt: {
				status: "committed",
				reason: null,
				durability: "committed",
			},
		});
		expect(applied.reason).not.toBe("cancelled");
		expect(controller.getSnapshot()).toEqual(before);
	});

	it("applies a session preset to future leases while isolating a second controller", async () => {
		const store = new ExecutionPresetStore();
		const first = new TaskExecutionPolicyController();
		const second = new TaskExecutionPolicyController();
		const preview = previewExecutionPreset(store, "secure-review", first, "session");
		const applied = await applyExecutionPreset(store, preview, first, "session");

		expect(applied).toMatchObject({
			ok: true,
			status: "applied",
			presetId: "secure-review",
			scope: "session",
			reason: null,
			mutationReceipt: null,
			timing: "current_runtime",
			durability: "none",
			controllerRevision: preview.after.revision,
			controllerFingerprint: preview.after.fingerprint,
		});
		const lease = first.acquireLaunchLease();
		expect(lease.snapshot.policy).toEqual(preview.after.policy);
		expect(lease.snapshot.fingerprint).toBe(preview.after.fingerprint);
		expect(second.getSnapshot().policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
		expect(second.getSnapshot().source.kind).toBe("default");
		lease.release();
		expect(first.activeLaunchCount).toBe(0);
	});

	it("uses a before-commit runtime gate for durable project and user applications and activates the controller postcommit", async () => {
		for (const scope of PERSISTENT_SCOPES) {
			const root = await makeRoot();
			const result = await applyAtScope(root, scope);
			const request = result.requests[0];
			const mutation = result.applied.mutationReceipt;

			expect(result.applied.ok).toBe(true);
			expect(result.applied.status).toBe("committed");
			expect(result.applied.scope).toBe(scope);
			expect(result.preview.timing).toBe("current_runtime");
			expect(result.preview.timingExpectation).toBe("current_runtime");
			expect(result.preview.durability).toBe("committed");
			expect(result.preview.durabilityExpectation).toBe("committed");
			expect(result.applied.timing).toBe("current_runtime");
			expect(result.applied.durability).toBe("committed");
			expect(mutation).not.toBeNull();
			expect(mutation?.status).toBe("committed");
			expect(mutation?.scope).toBe(scope);
			expect(mutation?.timing).toBe("next_session");
			expect(mutation?.durability).toBe("committed");
			expect(mutation?.patches).toEqual([{ op: "set", path: "execution.presets.active" }]);
			expect(request?.runtime?.phase).toBe("before_commit");
			expect(result.controller.getSnapshot().policy).toEqual(result.preview.after.policy);
			expect(await Bun.file(targetPath(root, scope)).exists()).toBe(true);
		}
	});

	it("keeps pre-commit failures unchanged and distinguishes committed from degraded persistence", async () => {
		const root = await makeRoot();
		const service = new ScopedConfigurationMutationService({
			loadContext: loadContext(root),
			agentDir: path.join(root, "agent"),
			reloadAndVerify: () => true,
		});
		const precommit = await service.mutate({
			scope: "project",
			patches: [{ op: "set", path: "execution.presets.active", value: "fast-build" }],
			runtime: { phase: "before_commit", apply: () => false },
		});
		expect(precommit).toMatchObject({
			status: "rejected",
			reason: "runtime_precommit_failed",
			timing: "next_session",
			durability: "none",
		});
		expect(await Bun.file(targetPath(root, "project")).exists()).toBe(false);

		const degradedRoot = await makeRoot();
		const degraded = await applyAtScope(degradedRoot, "project", () => false);
		expect(degraded.applied.ok).toBe(true);
		expect(degraded.applied.status).toBe("degraded");
		expect(degraded.applied.controllerRevision).toBe(degraded.preview.after.revision);
		expect(degraded.applied.controllerFingerprint).toBe(degraded.preview.after.fingerprint);
		expect(degraded.applied.reason).toBe("persistent_reload_mismatch");
		expect(degraded.applied.durability).toBe("committed_unconfirmed");
		expect(degraded.applied.mutationReceipt?.status).toBe("degraded");
		expect(degraded.applied.mutationReceipt?.durability).toBe("committed_unconfirmed");
		expect(degraded.controller.getSnapshot().policy).toEqual(degraded.preview.after.policy);
		expect(await Bun.file(targetPath(degradedRoot, "project")).exists()).toBe(true);
	});

	it("clears a session and persistent preset back to the default policy", async () => {
		const sessionStore = new ExecutionPresetStore();
		const sessionController = new TaskExecutionPolicyController();
		const sessionPreview = previewExecutionPreset(sessionStore, "fast-build", sessionController, "session");
		await applyExecutionPreset(sessionStore, sessionPreview, sessionController, "session");
		const sessionClear = await clearExecutionPreset(sessionStore, sessionController, "session", {
			expectedRevision: sessionPreview.after.revision,
			expectedFingerprint: sessionPreview.after.fingerprint,
		});
		expect(sessionClear).toMatchObject({
			ok: true,
			status: "applied",
			presetId: "",
			scope: "session",
			timing: "current_runtime",
			durability: "none",
		});
		expect(sessionController.getSnapshot().policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
		expect(sessionController.getSnapshot().source.kind).toBe("default");

		const root = await makeRoot();
		const persistent = await applyAtScope(root, "user");
		const clear = await clearExecutionPreset(persistent.store, persistent.controller, "user", {
			expectedRevision: persistent.preview.after.revision,
			expectedFingerprint: persistent.preview.after.fingerprint,
		});
		expect(clear.ok).toBe(true);
		expect(clear.status).toBe("applied");
		expect(clear.mutationReceipt?.status).toBe("applied");
		expect(clear.mutationReceipt?.patches).toEqual([{ op: "clear", path: "execution.presets.active" }]);
		expect(persistent.controller.getSnapshot().policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
		expect(persistent.controller.getSnapshot().source.kind).toBe("default");
	});
});
