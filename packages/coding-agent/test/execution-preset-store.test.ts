import { describe, expect, it } from "bun:test";
import {
	applyExecutionPreset,
	CURATED_EXECUTION_PRESETS,
	type ExecutionPreset,
	type ExecutionPresetInput,
	ExecutionPresetStore,
	type ExecutionPresetStoreErrorCode,
	previewExecutionPreset,
} from "../src/config/execution-preset";
import type {
	ScopedConfigurationExpectedOwner,
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationRequest,
	ScopedConfigurationMutationService,
	ScopedConfigurationRuntimeContext,
	ScopedConfigurationRuntimeResult,
	ScopedConfigurationScope,
	ScopedConfigurationSnapshot,
	ScopedConfigurationValue,
} from "../src/config/scoped-configuration-mutation";
import { type TaskExecutionPolicy, TaskExecutionPolicyController } from "../src/task/execution-policy";

const POLICY: TaskExecutionPolicy = {
	isolation: "current",
	toolAccess: { allow: [], deny: [] },
	mcpDiscovery: "configured",
	maxDurationMs: 15 * 60 * 1000,
	simpleMode: false,
};

function scopedPolicyValue(): ScopedConfigurationValue {
	return {
		isolation: POLICY.isolation,
		toolAccess: { allow: [...POLICY.toolAccess.allow], deny: [...POLICY.toolAccess.deny] },
		mcpDiscovery: POLICY.mcpDiscovery,
		maxDurationMs: POLICY.maxDurationMs,
		simpleMode: POLICY.simpleMode,
	};
}

const OWNER: ScopedConfigurationExpectedOwner = {
	identity: "execution-preset-test",
	revision: "revision-0",
	digest: "digest-0",
};

type PersistentScope = "project" | "user";
type WriterStatus = "committed" | "conflict";
const PERSISTENT_SCOPES: readonly PersistentScope[] = ["project", "user"];

function custom(
	id: string,
	label = id,
	description = `Preset ${label}`,
	policy: unknown = POLICY,
): ExecutionPresetInput {
	return { id, label, description, policy };
}

function requirePreset(store: ExecutionPresetStore, id: string): ExecutionPreset {
	const preset = store.get(id);
	if (!preset) throw new Error(`Missing execution preset ${id}`);
	return preset;
}

function requireListedPreset(list: readonly ExecutionPreset[], id: string): ExecutionPreset {
	const preset = list.find(candidate => candidate.id === id);
	if (!preset) throw new Error(`Missing listed execution preset ${id}`);
	return preset;
}

function committedReceipt(scope: ScopedConfigurationScope): ScopedConfigurationMutationReceipt {
	return {
		status: "committed",
		reason: null,
		scope,
		safePath: `/safe/${scope}/config.yml`,
		beforeRevision: "revision-0",
		afterRevision: "revision-1",
		beforeDigest: "digest-0",
		afterDigest: "digest-1",
		timing: "next_session",
		confirmation: "confirmed",
		durability: "committed",
		patches: [],
	};
}

function conflictReceipt(scope: ScopedConfigurationScope): ScopedConfigurationMutationReceipt {
	return {
		status: "conflict",
		reason: "scope_conflict",
		scope,
		safePath: `/safe/${scope}/config.yml`,
		beforeRevision: "revision-0",
		afterRevision: "revision-0",
		beforeDigest: "digest-0",
		afterDigest: "digest-0",
		timing: "next_session",
		confirmation: "not_applicable",
		durability: "none",
		patches: [],
	};
}

function writerFixture(
	status: WriterStatus,
	data: Readonly<Record<string, unknown>> = {},
): {
	readonly writer: Pick<ScopedConfigurationMutationService, "read" | "mutate">;

	readonly requests: ScopedConfigurationMutationRequest[];
} {
	const requests: ScopedConfigurationMutationRequest[] = [];
	const writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
		read: async scope =>
			({
				scope,
				path: `/safe/${scope}/config.yml`,
				safePath: `/safe/${scope}/config.yml`,
				exists: true,
				ownerIdentity: "execution-preset-test",
				revision: "revision-0",
				digest: "digest-0",
				data,
			}) satisfies ScopedConfigurationSnapshot,
		mutate: async request => {
			requests.push(request);
			return status === "committed" ? committedReceipt(request.scope) : conflictReceipt(request.scope);
		},
	};
	return { writer, requests };
}

describe("execution preset store", () => {
	it("exposes exact curated IDs and policies through deep-frozen detached DTOs", () => {
		const store = new ExecutionPresetStore();
		const listed = store.list();

		expect(listed.map(preset => preset.id)).toEqual(["secure-review", "fast-build", "isolated-autonomy"]);
		expect(listed.map(preset => preset.kind)).toEqual(["curated", "curated", "curated"]);
		expect(listed.map(preset => preset.policy)).toEqual([
			{
				isolation: "worktree",
				toolAccess: { allow: ["read", "search", "find", "lsp"], deny: ["edit", "write", "bash"] },
				mcpDiscovery: "disabled",
				maxDurationMs: 30 * 60 * 1000,
				simpleMode: true,
			},
			{
				isolation: "current",
				toolAccess: { allow: [], deny: [] },
				mcpDiscovery: "configured",
				maxDurationMs: 15 * 60 * 1000,
				simpleMode: false,
			},
			{
				isolation: "worktree",
				toolAccess: { allow: [], deny: [] },
				mcpDiscovery: "configured",
				maxDurationMs: 4 * 60 * 60 * 1000,
				simpleMode: false,
			},
		]);
		expect(CURATED_EXECUTION_PRESETS.map(preset => preset.id)).toEqual(listed.map(preset => preset.id));
		expect(Object.isFrozen(CURATED_EXECUTION_PRESETS)).toBe(true);
		expect(Object.isFrozen(listed)).toBe(true);

		for (const preset of listed) {
			expect(Object.isFrozen(preset)).toBe(true);
			expect(Object.isFrozen(preset.policy)).toBe(true);
			expect(Object.isFrozen(preset.policy.toolAccess)).toBe(true);
			expect(Object.isFrozen(preset.policy.toolAccess.allow)).toBe(true);
			expect(Object.isFrozen(preset.policy.toolAccess.deny)).toBe(true);
			expect(Object.hasOwn(preset, "model")).toBe(false);
			expect(Object.hasOwn(preset, "workMode")).toBe(false);
			expect(Object.hasOwn(preset.policy, "model")).toBe(false);
			expect(Object.hasOwn(preset.policy, "workMode")).toBe(false);
		}

		for (const preset of CURATED_EXECUTION_PRESETS) {
			expect(Object.isFrozen(preset)).toBe(true);
			expect(Object.isFrozen(preset.policy)).toBe(true);
			expect(Object.isFrozen(preset.policy.toolAccess)).toBe(true);
			expect(Object.isFrozen(preset.policy.toolAccess.allow)).toBe(true);
			expect(Object.isFrozen(preset.policy.toolAccess.deny)).toBe(true);
			expect(Object.hasOwn(preset, "model")).toBe(false);
			expect(Object.hasOwn(preset, "workMode")).toBe(false);
			expect(Object.hasOwn(preset.policy, "model")).toBe(false);
			expect(Object.hasOwn(preset.policy, "workMode")).toBe(false);
		}

		const first = store.get("secure-review");
		const second = store.get("secure-review");
		const listedSecure = requireListedPreset(listed, "secure-review");
		const curatedSecure = requireListedPreset(CURATED_EXECUTION_PRESETS, "secure-review");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
		expect(first).not.toBe(listedSecure);
		expect(first).not.toBe(curatedSecure);
		if (!first || !second) throw new Error("Curated preset lookup failed");
		expect(first.policy).not.toBe(second.policy);
		expect(first.policy.toolAccess).not.toBe(second.policy.toolAccess);
		expect(first.policy.toolAccess.allow).not.toBe(second.policy.toolAccess.allow);
		expect(first.policy.toolAccess.deny).not.toBe(second.policy.toolAccess.deny);
	});

	it("validates custom inputs, rejects duplicate IDs and labels, and caps the catalog at 64 entries", async () => {
		const validationCases: readonly {
			readonly input: ExecutionPresetInput;
			readonly code: ExecutionPresetStoreErrorCode;
		}[] = [
			{ input: custom("Bad ID"), code: "invalid_id" },
			{ input: custom("invalid-label", " \t"), code: "invalid_label" },
			{ input: custom("invalid-description", "Valid Label", "\n"), code: "invalid_description" },
			{
				input: custom("invalid-policy", "Invalid Policy", "Valid description", {
					isolation: "current",
					toolAccess: { allow: ["read"], deny: ["read"] },
					mcpDiscovery: "configured",
					maxDurationMs: null,
					simpleMode: false,
				}),
				code: "invalid_policy",
			},
		];
		const store = new ExecutionPresetStore();
		for (const candidate of validationCases) {
			const result = await store.createCustom(candidate.input);
			expect(result.ok).toBe(false);
			expect(result.status).toBe("rejected");
			expect(result.errorCode).toBe(candidate.code);
		}

		const duplicateId = await store.createCustom(custom("secure-review", "Different Label"));
		expect(duplicateId.ok).toBe(false);
		expect(duplicateId.errorCode).toBe("duplicate_id");
		const duplicateLabel = await store.createCustom(custom("different-id", " secure REVIEW "));
		expect(duplicateLabel.ok).toBe(false);
		expect(duplicateLabel.errorCode).toBe("duplicate_label");

		for (let index = 0; index < 61; index += 1) {
			const result = await store.createCustom(custom(`custom-${index}`, `Custom ${index}`));
			expect(result.ok).toBe(true);
		}
		expect(store.list()).toHaveLength(64);
		const full = await store.createCustom(custom("one-too-many", "One Too Many"));
		expect(full.ok).toBe(false);
		expect(full.errorCode).toBe("max_presets");
	});

	it("keeps session CRUD in memory without invoking a scoped writer", async () => {
		const fixture = writerFixture("committed");
		const store = new ExecutionPresetStore({ scope: "session", scopedMutationService: fixture.writer });
		const created = await store.createCustom(custom("memory-only", "Memory Only", "Session-only preset."));
		expect(created).toEqual({
			ok: true,
			operation: "create",
			status: "created",
			scope: "session",
			presetId: "memory-only",
			persisted: false,
			timing: "current_runtime",
			durability: "none",
			mutationStatus: null,
			mutationReason: null,
			preset: {
				id: "memory-only",
				label: "Memory Only",
				description: "Session-only preset.",
				policy: POLICY,
				kind: "custom",
			},
		});
		const renamed = await store.renameCustom("memory-only", {
			label: "Memory Renamed",
			description: "Renamed session-only preset.",
		});
		expect(renamed.ok).toBe(true);
		expect(renamed.status).toBe("renamed");
		expect(requirePreset(store, "memory-only")).toEqual({
			id: "memory-only",
			label: "Memory Renamed",
			description: "Renamed session-only preset.",
			policy: POLICY,
			kind: "custom",
		});
		const deleted = await store.deleteCustom("memory-only");
		expect(deleted).toEqual({
			ok: true,
			operation: "delete",
			status: "deleted",
			scope: "session",
			presetId: "memory-only",
			persisted: false,
			timing: "current_runtime",
			durability: "none",
			mutationStatus: null,
			mutationReason: null,
		});
		expect(store.get("memory-only")).toBeUndefined();
		expect(fixture.requests).toHaveLength(0);
	});

	for (const scope of PERSISTENT_SCOPES) {
		it(`uses exact scoped ${scope} set and clear definition patches with safe DTO values`, async () => {
			const fixture = writerFixture("committed", {
				execution: { presets: { active: "persistent-review" } },
			});
			const store = new ExecutionPresetStore({ scope, scopedMutationService: fixture.writer });
			const created = await store.createCustom(
				custom("persistent-review", "Persistent Review", "Saved review preset."),
				{ expectedOwner: OWNER },
			);
			expect(created).toEqual({
				ok: true,
				operation: "create",
				status: "created",
				scope,
				presetId: "persistent-review",
				persisted: true,
				timing: "next_session",
				durability: "committed",
				mutationStatus: "committed",
				mutationReason: null,
				preset: {
					id: "persistent-review",
					label: "Persistent Review",
					description: "Saved review preset.",
					policy: POLICY,
					kind: "custom",
				},
			});
			expect(fixture.requests[0]).toEqual({
				scope,
				patches: [
					{
						op: "set",
						path: "execution.presets.definitions.persistent-review",
						value: {
							id: "persistent-review",
							label: "Persistent Review",
							description: "Saved review preset.",
							policy: scopedPolicyValue(),
						},
					},
				],
				expectedOwner: OWNER,
			});

			const renamed = await store.renameCustom(
				"persistent-review",
				{ label: "Persistent Review 2", description: "Renamed saved review preset." },
				{ expectedOwner: OWNER },
			);
			expect(renamed.ok).toBe(true);
			expect(renamed.status).toBe("renamed");
			expect(fixture.requests[1]).toEqual({
				scope,
				patches: [
					{
						op: "set",
						path: "execution.presets.definitions.persistent-review",
						value: {
							id: "persistent-review",
							label: "Persistent Review 2",
							description: "Renamed saved review preset.",
							policy: scopedPolicyValue(),
						},
					},
				],
				expectedOwner: OWNER,
			});

			const deleted = await store.deleteCustom("persistent-review", { expectedOwner: OWNER });
			expect(deleted).toEqual({
				ok: true,
				operation: "delete",
				status: "deleted",
				scope,
				presetId: "persistent-review",
				persisted: true,
				timing: "next_session",
				durability: "committed",
				mutationStatus: "committed",
				mutationReason: null,
			});
			expect(fixture.requests[2]).toMatchObject({
				scope,
				patches: [
					{ op: "clear", path: "execution.presets.definitions.persistent-review" },
					{ op: "clear", path: "execution.presets.active" },
				],
				expectedOwner: OWNER,
				runtime: { phase: "before_commit" },
			});
			expect(typeof fixture.requests[2]?.runtime?.apply).toBe("function");

			expect(store.get("persistent-review")).toBeUndefined();
			expect(fixture.requests).toHaveLength(3);
		});
	}

	it("cancels an aborted session delete and a pre-commit persistent delete without mutating state", async () => {
		const session = new ExecutionPresetStore({ scope: "session" });
		const sessionCreated = await session.createCustom(custom("session-delete", "Session Delete"));
		expect(sessionCreated.ok).toBe(true);
		const sessionBefore = session.get("session-delete");
		if (!sessionBefore) throw new Error("Session delete fixture did not create a custom preset");
		const sessionAbort = new AbortController();
		sessionAbort.abort();
		const sessionResult = await session.deleteCustom("session-delete", { signal: sessionAbort.signal });
		expect(sessionResult).toMatchObject({
			ok: false,
			status: "rejected",
			scope: "session",
			presetId: "session-delete",
			errorCode: "cancelled",
		});
		expect(session.get("session-delete")).toEqual(sessionBefore);

		const snapshot: ScopedConfigurationSnapshot = {
			scope: "project",
			path: "/safe/project/config.yml",
			safePath: "/safe/project/config.yml",
			exists: true,
			ownerIdentity: "execution-preset-test",
			revision: "revision-0",
			digest: "digest-0",
			data: { execution: { presets: { active: "persistent-delete" } } },
		};
		const requestCaptured = Promise.withResolvers<void>();
		const releaseMutation = Promise.withResolvers<void>();
		const persistentAbort = new AbortController();
		const requests: ScopedConfigurationMutationRequest[] = [];
		let runtimeGateResult: ScopedConfigurationRuntimeResult | undefined;
		let mutationReceipt: ScopedConfigurationMutationReceipt | undefined;
		const writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
			read: async () => snapshot,
			mutate: async request => {
				requests.push(request);
				requestCaptured.resolve();
				await releaseMutation.promise;
				const runtime = request.runtime;
				if (!runtime) throw new Error("Persistent delete runtime gate was not provided");
				runtimeGateResult = await runtime.apply({
					scope: "project",
					phase: "before_commit",
					target: snapshot.safePath,
					path: snapshot.path,
					safePath: snapshot.safePath,
					patches: request.patches,
					before: snapshot,
				} satisfies ScopedConfigurationRuntimeContext);
				const receipt = {
					status: "rejected",
					reason: "runtime_precommit_failed",
					scope: "project",
					safePath: snapshot.safePath,
					beforeRevision: snapshot.revision,
					afterRevision: snapshot.revision,
					beforeDigest: snapshot.digest,
					afterDigest: snapshot.digest,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
					patches: [],
				} satisfies ScopedConfigurationMutationReceipt;
				mutationReceipt = receipt;
				return receipt;
			},
		};
		const persistent = new ExecutionPresetStore({
			scope: "project",
			scopedMutationService: writer,
			customPresets: [custom("persistent-delete", "Persistent Delete")],
		});
		const persistentBefore = persistent.get("persistent-delete");
		if (!persistentBefore) throw new Error("Persistent delete fixture did not create a custom preset");
		const deletion = persistent.deleteCustom("persistent-delete", { signal: persistentAbort.signal });
		await requestCaptured.promise;
		persistentAbort.abort();
		releaseMutation.resolve();
		const persistentResult = await deletion;

		expect(mutationReceipt).toMatchObject({ status: "rejected", reason: "runtime_precommit_failed" });
		expect(runtimeGateResult).toBe(false);
		expect(persistentResult).toMatchObject({
			ok: false,
			status: "rejected",
			scope: "project",
			presetId: "persistent-delete",
			errorCode: "cancelled",
		});
		expect(persistent.get("persistent-delete")).toEqual(persistentBefore);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.patches).toEqual([
			{ op: "clear", path: "execution.presets.definitions.persistent-delete" },
			{ op: "clear", path: "execution.presets.active" },
		]);
		expect(requests[0]?.runtime?.phase).toBe("before_commit");
	});

	it("rejects every managed mutation without writing or changing the catalog", async () => {
		const fixture = writerFixture("committed");
		const store = new ExecutionPresetStore({
			scope: "managed",
			scopedMutationService: fixture.writer,
			customPresets: [custom("managed-existing", "Managed Existing")],
		});
		const before = store.list();
		const beforeRevision = store.revision;

		const created = await store.createCustom(custom("managed-new", "Managed New"));
		const renamed = await store.renameCustom("managed-existing", "Managed Renamed");
		const deleted = await store.deleteCustom("managed-existing");
		for (const result of [created, renamed, deleted]) {
			expect(result.ok).toBe(false);
			expect(result.status).toBe("locked");
			expect(result.scope).toBe("managed");
			expect(result.errorCode).toBe("scope_locked");
			expect(result.persisted).toBe(false);
		}
		expect(store.list()).toEqual(before);
		expect(store.revision).toBe(beforeRevision);
		expect(fixture.requests).toHaveLength(0);
	});

	it("leaves the store and controller unchanged when a scoped writer returns a failed receipt", async () => {
		const fixture = writerFixture("conflict");
		const store = new ExecutionPresetStore({
			scope: "project",
			scopedMutationService: fixture.writer,
			customPresets: [custom("existing", "Existing", "Existing description.")],
		});
		const beforeCatalog = store.list();
		const beforeRevision = store.revision;

		const failedCreate = await store.createCustom(custom("failed-create", "Failed Create"));
		expect(failedCreate.ok).toBe(false);
		expect(failedCreate.status).toBe("conflict");
		expect(failedCreate.mutationStatus).toBe("conflict");
		expect(failedCreate.mutationReason).toBe("scope_conflict");
		expect(store.get("failed-create")).toBeUndefined();
		expect(store.revision).toBe(beforeRevision);
		expect(store.list()).toEqual(beforeCatalog);

		const failedRename = await store.renameCustom("existing", "Changed Existing");
		expect(failedRename.ok).toBe(false);
		expect(failedRename.status).toBe("conflict");
		expect(requirePreset(store, "existing")).toEqual(requireListedPreset(beforeCatalog, "existing"));
		expect(store.revision).toBe(beforeRevision);

		const failedDelete = await store.deleteCustom("existing");
		expect(failedDelete.ok).toBe(false);
		expect(failedDelete.status).toBe("conflict");
		expect(requirePreset(store, "existing")).toEqual(requireListedPreset(beforeCatalog, "existing"));
		expect(store.revision).toBe(beforeRevision);

		const controller = new TaskExecutionPolicyController();
		const beforeController = controller.getSnapshot();
		const preview = previewExecutionPreset(store, "fast-build", controller, "project");
		const failedApply = await applyExecutionPreset(store, preview, controller, "project");
		expect(failedApply.ok).toBe(false);
		expect(failedApply.status).toBe("conflict");
		expect(failedApply.reason).toBe("scope_conflict");
		expect(failedApply.mutationReceipt).toEqual(conflictReceipt("project"));
		expect(failedApply.controllerRevision).toBe(beforeController.revision);
		expect(failedApply.controllerFingerprint).toBe(beforeController.fingerprint);
		expect(controller.getSnapshot()).toBe(beforeController);
	});
});
