import { beforeAll, describe, expect, it } from "bun:test";
import {
	applyExecutionPreset,
	type ExecutionPresetApplyReceipt,
	type ExecutionPresetScope,
	ExecutionPresetStore,
	previewExecutionPreset,
} from "../src/config/execution-preset";
import type {
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationRequest,
	ScopedConfigurationMutationService,
	ScopedConfigurationReceiptPatch,
	ScopedConfigurationRuntimeContext,
	ScopedConfigurationRuntimeResult,
	ScopedConfigurationSnapshot,
} from "../src/config/scoped-configuration-mutation";
import {
	ExecutionPresetSelectorComponent,
	type ExecutionPresetSelectorSource,
} from "../src/modes/components/execution-preset-selector";
import { initTheme } from "../src/modes/theme/theme";
import { DEFAULT_TASK_EXECUTION_POLICY, TaskExecutionPolicyController } from "../src/task/execution-policy";

type PersistentScope = "project" | "user";
const PERSISTENT_SCOPES: readonly PersistentScope[] = ["project", "user"];
type WriterMode = "committed" | "degraded" | "degraded-runtime-active" | "conflict";

interface SelectorHarness {
	readonly component: ExecutionPresetSelectorComponent;
	readonly controller: TaskExecutionPolicyController;
	readonly stores: ReadonlyMap<string, ExecutionPresetStore>;
	readonly requests: ScopedConfigurationMutationRequest[];
	readonly applied: ExecutionPresetApplyReceipt[];
	readonly statuses: string[];
	readonly scopeChanges: string[];
	readonly cancelCount: () => number;
}

function runtimeContext(
	scope: PersistentScope,
	request: ScopedConfigurationMutationRequest,
	phase: "before_commit" | "after_commit" = "after_commit",
): ScopedConfigurationRuntimeContext {
	const safePath = `/safe/${scope}/config.yml`;
	return {
		scope,
		phase,
		target: safePath,
		path: safePath,
		safePath,
		patches: request.patches,
		before: {
			scope,
			path: safePath,
			safePath,
			exists: true,
			ownerIdentity: "execution-preset-selector-test",
			revision: "revision-0",
			digest: "digest-0",
			data: {},
		},
	};
}

function receiptPatches(request: ScopedConfigurationMutationRequest): readonly ScopedConfigurationReceiptPatch[] {
	return request.patches.map(patch =>
		patch.op === "set" ? { op: "set", path: patch.path } : { op: "clear", path: patch.path },
	);
}

function writerFor(
	scope: PersistentScope,
	mode: WriterMode,
	requests: ScopedConfigurationMutationRequest[],
): Pick<ScopedConfigurationMutationService, "read" | "mutate"> {
	return {
		read: async scope => ({
			scope,
			path: `/safe/${scope}/config.yml`,
			safePath: `/safe/${scope}/config.yml`,
			exists: false,
			ownerIdentity: `missing:${scope}`,
			revision: "missing",
			digest: "missing",
			data: {},
		}),
		mutate: async request => {
			requests.push(request);
			if (mode === "committed" || mode === "degraded-runtime-active") {
				const runtime = request.runtime;
				if (runtime) await runtime.apply(runtimeContext(scope, request, runtime.phase));
			}
			const durable =
				mode === "conflict"
					? "none"
					: mode === "degraded" || mode === "degraded-runtime-active"
						? "committed_unconfirmed"
						: "committed";
			const confirmation =
				mode === "degraded" || mode === "degraded-runtime-active"
					? "unconfirmed"
					: mode === "conflict"
						? "not_applicable"
						: "confirmed";
			return {
				status: mode === "degraded-runtime-active" ? "degraded" : mode,
				reason:
					mode === "conflict"
						? "scope_conflict"
						: mode === "degraded" || mode === "degraded-runtime-active"
							? "persistent_reload_mismatch"
							: null,
				scope,
				safePath: `/safe/${scope}/config.yml`,
				beforeRevision: "revision-0",
				afterRevision: mode === "conflict" ? "revision-0" : "revision-1",
				beforeDigest: "digest-0",
				afterDigest: mode === "conflict" ? "digest-0" : "digest-1",
				timing: "current_runtime",
				confirmation,
				durability: durable,
				patches: receiptPatches(request),
			} satisfies ScopedConfigurationMutationReceipt;
		},
	};
}

function createHarness(mode: WriterMode = "committed"): SelectorHarness {
	const requests: ScopedConfigurationMutationRequest[] = [];
	const controller = new TaskExecutionPolicyController();
	const sessionStore = new ExecutionPresetStore({ scope: "session" });
	const projectStore = new ExecutionPresetStore({
		scope: "project",
		scopedMutationService: writerFor("project", mode, requests),
	});
	const userStore = new ExecutionPresetStore({
		scope: "user",
		scopedMutationService: writerFor("user", mode, requests),
	});
	const stores = new Map<string, ExecutionPresetStore>([
		["session", sessionStore],
		["project", projectStore],
		["user", userStore],
	]);
	let selectedScope: ExecutionPresetScope = "session";
	let cancelCount = 0;
	const applied: ExecutionPresetApplyReceipt[] = [];
	const statuses: string[] = [];
	const scopeChanges: string[] = [];
	const source: ExecutionPresetSelectorSource = {
		store: sessionStore,
		controller,
		scopes: ["session", "project", "user"],
		getScope: () => selectedScope,
		setScope: scope => {
			selectedScope = scope;
			scopeChanges.push(scope);
		},
		getStoreForScope: scope => {
			const store = stores.get(scope);
			if (!store) throw new Error(`Missing store for ${scope}`);
			return store;
		},
	};
	const component = new ExecutionPresetSelectorComponent(source, {
		onApplied: receipt => applied.push(receipt),
		onCancel: () => {
			cancelCount += 1;
		},
		onStatus: status => statuses.push(status),
	});
	return {
		component,
		controller,
		stores,
		requests,
		applied,
		statuses,
		scopeChanges,
		cancelCount: () => cancelCount,
	};
}

function selectScope(component: ExecutionPresetSelectorComponent, scope: PersistentScope): void {
	if (scope === "project") component.handleInput("s");
	else {
		component.handleInput("s");
		component.handleInput("s");
	}
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

function renderText(component: ExecutionPresetSelectorComponent, width: number): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("ExecutionPresetSelectorComponent", () => {
	it("walks the real list, detail, scope cycle, back, Escape cancel, and idempotent dispose", () => {
		const harness = createHarness();
		const list = renderText(harness.component, 100);

		expect(harness.component.getView()).toBe("list");
		expect(harness.component.getScope()).toBe("session");
		expect(list).toContain("Execution presets");
		expect(list).toContain("Scope: Session");
		expect(list).toContain("secure-review");
		expect(harness.component.getSelectList().getSelectedItem()?.value).toBe("secure-review");

		harness.component.handleInput("\n");
		expect(harness.component.getView()).toBe("preview");
		const preview = harness.component.getPreview();
		expect(preview?.preset.id).toBe("secure-review");
		expect(renderText(harness.component, 100)).toContain("Preview: Secure Review");
		expect(renderText(harness.component, 100)).toContain("Work Mode: unchanged");
		expect(renderText(harness.component, 100)).not.toContain("workMode");

		harness.component.handleInput("\x1b");
		expect(harness.component.getView()).toBe("list");
		harness.component.handleInput("s");
		harness.component.handleInput("s");
		expect(harness.component.getScope()).toBe("user");
		expect(harness.scopeChanges).toEqual(["project", "user"]);
		harness.component.handleInput("s");
		expect(harness.component.getScope()).toBe("session");
		expect(harness.scopeChanges).toEqual(["project", "user", "session"]);

		harness.component.handleInput("\x1b");
		expect(harness.cancelCount()).toBe(1);
		harness.component.dispose();
		expect(() => harness.component.dispose()).not.toThrow();
	});

	it("applies a session preset through the actual controller and preserves Work Mode", async () => {
		const harness = createHarness();
		const before = harness.controller.getSnapshot();

		harness.component.handleInput("\n");
		const preview = harness.component.getPreview();
		if (!preview) throw new Error("Session preview did not open");
		harness.component.handleInput("\n");
		await settle();

		const receipt = harness.applied[0];
		if (!receipt) throw new Error("Session apply receipt was not delivered");
		expect(receipt).toMatchObject({
			ok: true,
			presetId: "secure-review",
			scope: "session",
			status: "applied",
			timing: "current_runtime",
			durability: "none",
		});
		expect(harness.controller.getSnapshot().revision).toBe(before.revision + 1);
		expect(harness.controller.getSnapshot().policy).toEqual(preview.preset.policy);
		expect(harness.controller.getSnapshot().revision).toBe(preview.after.revision);
		expect(harness.component.getPreview()?.derivedWorkMode).toBeNull();
		expect(renderText(harness.component, 100)).toContain(
			"Status: Applied for Session; timing current_runtime; durability none.",
		);
		expect(renderText(harness.component, 100)).toContain("Work Mode: unchanged");
		expect(harness.statuses).toContain("Applied for Session; timing current_runtime; durability none.");

		harness.component.handleInput("\x1b");
		expect(harness.component.getView()).toBe("list");
	});
	it("aborts a deferred apply on disposal before runtime mutation or callbacks", async () => {
		const store = new ExecutionPresetStore({ scope: "session" });
		const controller = new TaskExecutionPolicyController();
		const before = controller.getSnapshot();
		const preview = previewExecutionPreset(store, "secure-review", controller, "session");
		let signal: AbortSignal | undefined;
		let resolveDeferred: (() => void) | undefined;
		const deferred = new Promise<ExecutionPresetApplyReceipt>((resolve, reject) => {
			resolveDeferred = () => {
				const captured = signal;
				if (!captured) {
					reject(new Error("Apply signal was not captured"));
					return;
				}
				void applyExecutionPreset(store, preview, controller, {
					scope: "session",
					preview,
					signal: captured,
				}).then(resolve, reject);
			};
		});
		const applied: ExecutionPresetApplyReceipt[] = [];
		const statuses: string[] = [];
		let requestRenderCount = 0;
		const component = new ExecutionPresetSelectorComponent(
			{
				store,
				controller,
				scopes: ["session"],
				applyPreset: (_store, _preview, _controller, _scope, applySignal) => {
					signal = applySignal;
					return deferred;
				},
			},
			{
				onApplied: receipt => applied.push(receipt),
				onStatus: status => statuses.push(status),
				requestRender: () => {
					requestRenderCount += 1;
				},
			},
		);

		component.handleInput("\n");
		expect(component.getView()).toBe("preview");
		component.handleInput("\n");
		const capturedSignal = signal;
		const resolve = resolveDeferred;
		if (!capturedSignal || !resolve) throw new Error("Deferred apply did not start");
		const beforeDisposal = {
			applied: applied.length,
			statuses: statuses.length,
			requestRenderCount,
		};

		component.dispose();
		expect(capturedSignal.aborted).toBe(true);
		resolve();
		await settle();

		expect(controller.getSnapshot().revision).toBe(before.revision);
		expect(controller.getSnapshot().fingerprint).toBe(before.fingerprint);
		expect(applied).toHaveLength(beforeDisposal.applied);
		expect(statuses).toHaveLength(beforeDisposal.statuses);
		expect(requestRenderCount).toBe(beforeDisposal.requestRenderCount);
	});
	it("aborts deferred project and user applies on disposal before durable commit or callbacks", async () => {
		for (const scope of PERSISTENT_SCOPES) {
			const snapshot: ScopedConfigurationSnapshot = {
				scope,
				path: `/safe/${scope}/config.yml`,
				safePath: `/safe/${scope}/config.yml`,
				exists: true,
				ownerIdentity: `execution-preset-selector-${scope}`,
				revision: "revision-0",
				digest: "digest-0",
				data: { execution: { presets: { active: `existing-${scope}` } } },
			};
			const requestCaptured = Promise.withResolvers<void>();
			const releaseMutation = Promise.withResolvers<void>();
			const mutationFinished = Promise.withResolvers<void>();
			const requests: ScopedConfigurationMutationRequest[] = [];
			let runtimeGateResult: ScopedConfigurationRuntimeResult | undefined;
			let mutationReceipt: ScopedConfigurationMutationReceipt | undefined;
			let durableActive = `existing-${scope}`;
			const beforeDurableActive = durableActive;
			const writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
				read: async () => snapshot,
				mutate: async request => {
					requests.push(request);
					requestCaptured.resolve();
					await releaseMutation.promise;
					const runtime = request.runtime;
					if (!runtime) {
						mutationFinished.resolve();
						throw new Error(`${scope} apply runtime gate was not provided`);
					}
					runtimeGateResult = await runtime.apply(runtimeContext(scope, request, "before_commit"));
					if (runtimeGateResult !== false) durableActive = "fast-build";
					const receipt = {
						status: runtimeGateResult === false ? "rejected" : "committed",
						reason: runtimeGateResult === false ? "runtime_precommit_failed" : null,
						scope,
						safePath: snapshot.safePath,
						beforeRevision: snapshot.revision,
						afterRevision: runtimeGateResult === false ? snapshot.revision : "revision-1",
						beforeDigest: snapshot.digest,
						afterDigest: runtimeGateResult === false ? snapshot.digest : "digest-1",
						timing: "next_session",
						confirmation: runtimeGateResult === false ? "not_applicable" : "confirmed",
						durability: runtimeGateResult === false ? "none" : "committed",
						patches: receiptPatches(request),
					} satisfies ScopedConfigurationMutationReceipt;
					mutationReceipt = receipt;
					mutationFinished.resolve();
					return receipt;
				},
			};
			const store = new ExecutionPresetStore({ scope, scopedMutationService: writer });
			const controller = new TaskExecutionPolicyController();
			const beforeController = controller.getSnapshot();
			const applied: ExecutionPresetApplyReceipt[] = [];
			const statuses: string[] = [];
			let requestRenderCount = 0;
			const component = new ExecutionPresetSelectorComponent(
				{ store, controller, scopes: [scope] },
				{
					onApplied: receipt => applied.push(receipt),
					onStatus: status => statuses.push(status),
					requestRender: () => {
						requestRenderCount += 1;
					},
				},
			);

			expect(component.getScope()).toBe(scope);
			component.handleInput("\n");
			expect(component.getView()).toBe("preview");
			if (!component.getPreview()) throw new Error(`${scope} preview did not open`);
			component.handleInput("\n");
			await requestCaptured.promise;
			const beforeDisposal = {
				applied: applied.length,
				statuses: statuses.length,
				requestRenderCount,
			};

			component.dispose();
			releaseMutation.resolve();
			await mutationFinished.promise;
			await settle();

			expect(runtimeGateResult).toBe(false);
			expect(mutationReceipt).toMatchObject({
				status: "rejected",
				reason: "runtime_precommit_failed",
				durability: "none",
			});
			expect(durableActive).toBe(beforeDurableActive);
			expect(controller.getSnapshot()).toEqual(beforeController);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.runtime?.phase).toBe("before_commit");
			expect(applied).toHaveLength(beforeDisposal.applied);
			expect(statuses).toHaveLength(beforeDisposal.statuses);
			expect(requestRenderCount).toBe(beforeDisposal.requestRenderCount);
		}
	});
	it("aborts a deferred project delete on disposal before durable commit or callbacks", async () => {
		const snapshot: ScopedConfigurationSnapshot = {
			scope: "project",
			path: "/safe/project/config.yml",
			safePath: "/safe/project/config.yml",
			exists: true,
			ownerIdentity: "execution-preset-selector-test",
			revision: "revision-0",
			digest: "digest-0",
			data: { execution: { presets: { active: "project-delete" } } },
		};
		const requestCaptured = Promise.withResolvers<void>();
		const releaseMutation = Promise.withResolvers<void>();
		const mutationFinished = Promise.withResolvers<void>();
		const requests: ScopedConfigurationMutationRequest[] = [];
		let runtimeGateResult: ScopedConfigurationRuntimeResult | undefined;
		let mutationReceipt: ScopedConfigurationMutationReceipt | undefined;
		let durableDataChanged = false;
		const writer: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
			read: async () => snapshot,
			mutate: async request => {
				requests.push(request);
				requestCaptured.resolve();
				await releaseMutation.promise;
				const runtime = request.runtime;
				if (!runtime) {
					mutationFinished.resolve();
					throw new Error("Project delete runtime gate was not provided");
				}
				runtimeGateResult = await runtime.apply(runtimeContext("project", request, "before_commit"));
				if (runtimeGateResult !== false) durableDataChanged = true;
				const receipt = {
					status: runtimeGateResult === false ? "rejected" : "committed",
					reason: runtimeGateResult === false ? "runtime_precommit_failed" : null,
					scope: "project",
					safePath: snapshot.safePath,
					beforeRevision: snapshot.revision,
					afterRevision: runtimeGateResult === false ? snapshot.revision : "revision-1",
					beforeDigest: snapshot.digest,
					afterDigest: runtimeGateResult === false ? snapshot.digest : "digest-1",
					timing: "next_session",
					confirmation: runtimeGateResult === false ? "not_applicable" : "confirmed",
					durability: runtimeGateResult === false ? "none" : "committed",
					patches: receiptPatches(request),
				} satisfies ScopedConfigurationMutationReceipt;
				mutationReceipt = receipt;
				mutationFinished.resolve();
				return receipt;
			},
		};
		const store = new ExecutionPresetStore({
			scope: "project",
			scopedMutationService: writer,
			customPresets: [
				{
					id: "project-delete",
					label: "Project Delete",
					description: "Project delete fixture.",
					policy: DEFAULT_TASK_EXECUTION_POLICY,
				},
			],
		});
		const before = store.get("project-delete");
		if (!before) throw new Error("Project delete fixture did not create a custom preset");
		const controller = new TaskExecutionPolicyController();
		const deleted: string[] = [];
		const statuses: string[] = [];
		let requestRenderCount = 0;
		const component = new ExecutionPresetSelectorComponent(
			{ store, controller, scopes: ["project"] },
			{
				onDeleted: presetId => deleted.push(presetId),
				onStatus: status => statuses.push(status),
				requestRender: () => {
					requestRenderCount += 1;
				},
			},
		);
		expect(component.getScope()).toBe("project");
		component.getSelectList().setSelectedIndex(3);
		expect(component.getSelectList().getSelectedItem()?.value).toBe("project-delete");
		component.handleInput("d");
		expect(component.getView()).toBe("delete");
		component.handleInput("\n");
		await requestCaptured.promise;
		const beforeDisposal = {
			deleted: deleted.length,
			statuses: statuses.length,
			requestRenderCount,
		};

		component.dispose();
		releaseMutation.resolve();
		await mutationFinished.promise;
		await settle();

		expect(mutationReceipt).toMatchObject({ status: "rejected", reason: "runtime_precommit_failed" });
		expect(runtimeGateResult).toBe(false);
		expect(durableDataChanged).toBe(false);
		expect(store.get("project-delete")).toEqual(before);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.patches).toEqual([
			{ op: "clear", path: "execution.presets.definitions.project-delete" },
			{ op: "clear", path: "execution.presets.active" },
		]);
		expect(requests[0]?.runtime?.phase).toBe("before_commit");
		expect(deleted).toHaveLength(beforeDisposal.deleted);
		expect(statuses).toHaveLength(beforeDisposal.statuses);
		expect(requestRenderCount).toBe(beforeDisposal.requestRenderCount);
	});
	it("labels runtime-active degraded receipts with their computed scope", async () => {
		const degraded = await applyPersistent("project", "degraded-runtime-active");
		const receipt = degraded.applied[0];
		if (!receipt) throw new Error("Runtime-active degraded receipt was not delivered");
		expect(receipt).toMatchObject({
			ok: true,
			status: "degraded",
			reason: "persistent_reload_mismatch",
			controllerRevision: 1,
		});
		expect(renderText(degraded.component, 100)).toContain(
			"Status: Saved for Project; runtime active, verification degraded.",
		);
		expect(renderText(degraded.component, 100)).not.toContain("Status: Saved for User;");
	});

	it("reports committed project and user applications with the real component receipt", async () => {
		await assertPersistentStatus("project", "committed", {
			ok: true,
			status: "committed",
			durability: "committed",
		});
		await assertPersistentStatus("user", "committed", {
			ok: true,
			status: "committed",
			durability: "committed",
		});
	});

	it("keeps degraded and conflict persistence honest with postcommit runtime activation", async () => {
		const degraded = await applyPersistent("project", "degraded");
		const degradedReceipt = degraded.applied[0];
		if (!degradedReceipt) throw new Error("Degraded receipt was not delivered");
		expect(degradedReceipt).toMatchObject({
			ok: true,
			status: "degraded",
			reason: "persistent_reload_mismatch",
			controllerRevision: 1,
		});
		expect(degraded.controller.getSnapshot().revision).toBe(1);
		expect(renderText(degraded.component, 100)).toContain(
			"Status: Saved for Project; runtime active, verification degraded.",
		);
		expect(degraded.component.getView()).toBe("preview");

		const conflict = await applyPersistent("user", "conflict");
		const conflictReceipt = conflict.applied[0];
		if (!conflictReceipt) throw new Error("Conflict receipt was not delivered");
		expect(conflictReceipt).toMatchObject({ ok: false, status: "conflict", reason: "scope_conflict" });
		expect(conflict.controller.getSnapshot().revision).toBe(0);
		expect(renderText(conflict.component, 100)).toContain(
			"The user preset changed elsewhere; no change was applied.",
		);
		expect(conflict.component.getView()).toBe("preview");
	});

	it("rejects a stale preview safely after an actual controller revision change", async () => {
		const harness = createHarness();
		harness.component.handleInput("\n");
		const preview = harness.component.getPreview();
		if (!preview) throw new Error("Stale-preview fixture did not open");
		const changed = harness.controller.apply(DEFAULT_TASK_EXECUTION_POLICY);
		expect(changed.revision).toBe(preview.beforeRevision + 1);

		harness.component.handleInput("\n");
		await settle();
		const receipt = harness.applied[0];
		if (!receipt) throw new Error("Stale receipt was not delivered");
		expect(receipt).toMatchObject({
			ok: false,
			status: "rejected",
			reason: "preview_stale",
			mutationReceipt: null,
		});
		expect(harness.controller.getSnapshot().revision).toBe(changed.revision);
		expect(harness.component.getView()).toBe("preview");
		expect(renderText(harness.component, 100)).toContain("The preset could not be applied; no change was applied.");
	});

	it("sanitizes CJK, tabs, ANSI, URLs, paths, and credential-shaped preview text at narrow widths", () => {
		const store = new ExecutionPresetStore({
			scope: "session",
			customPresets: [
				{
					id: "sensitive",
					label: "研究者 Preset",
					description:
						"説明 URL=https://user:pass@example.test/private?token=top-secret#fragment path /Users/private/credential.txt apiKey=sk-test-secret-123",
					policy: DEFAULT_TASK_EXECUTION_POLICY,
				},
			],
		});
		const controller = new TaskExecutionPolicyController();
		const source: ExecutionPresetSelectorSource = {
			store,
			controller,
			previewPreset: (previewStore, id, previewController, scope) => {
				const preview = previewExecutionPreset(previewStore, id, previewController, scope);
				return {
					...preview,
					preset: {
						...preview.preset,
						label: "\x1b[31m研究者\tPreset\x1b[0m",
						description:
							"説明\tURL=https://user:pass@example.test/private?token=top-secret#fragment path=/Users/private/credential.txt apiKey=sk-test-secret-123",
					},
				};
			},
		};
		const component = new ExecutionPresetSelectorComponent(source);
		component.getSelectList().setSelectedIndex(3);
		const list = renderText(component, 120);
		expect(list).toContain("研究者 Preset");
		expect(list).not.toContain("https://user:pass@example.test/private?token=top-secret#fragment");
		expect(list).not.toContain("/Users/private/credential.txt");
		expect(list).not.toContain("sk-test-secret-123");
		expect(list).toContain("<redacted>");

		component.handleInput("\n");

		const wide = renderText(component, 120);
		expect(wide).toContain("研究者 Preset");
		expect(wide).not.toContain("https://user:pass@example.test/private?token=top-secret#fragment");
		expect(wide).not.toContain("/Users/private/credential.txt");
		expect(wide).not.toContain("sk-test-secret-123");
		expect(wide).not.toContain("\t");

		const narrow = component.render(18);
		for (const line of narrow) {
			const plain = Bun.stripANSI(line);
			expect(plain).not.toContain("\t");
			expect(Bun.stringWidth(plain)).toBeLessThanOrEqual(18);
		}
		component.dispose();
	});

	it("does not claim mouse selection when the shared SelectList has no mouse contract", () => {
		const harness = createHarness();
		const selectList = harness.component.getSelectList();
		expect(typeof selectList.handleInput).toBe("function");
		expect("handleMouse" in selectList).toBe(false);
		harness.component.dispose();
	});
});

async function applyPersistent(scope: PersistentScope, mode: WriterMode): Promise<SelectorHarness> {
	const harness = createHarness(mode);
	selectScope(harness.component, scope);
	harness.component.handleInput("\n");
	expect(harness.component.getScope()).toBe(scope);
	harness.component.handleInput("\n");
	await settle();
	return harness;
}

async function assertPersistentStatus(
	scope: PersistentScope,
	mode: WriterMode,
	expected: { readonly ok: boolean; readonly status: string; readonly durability: string },
): Promise<void> {
	const harness = await applyPersistent(scope, mode);
	const receipt = harness.applied[0];
	if (!receipt) throw new Error(`No ${scope} receipt was delivered`);
	expect(receipt).toMatchObject(expected);
	expect(harness.requests).toHaveLength(1);
	expect(harness.requests[0]?.runtime?.phase).toBe("before_commit");
	expect(renderText(harness.component, 100)).toContain(
		receipt.status === "committed"
			? `Applied for ${scope === "project" ? "Project" : "User"}; timing current_runtime; durability committed.`
			: "",
	);
}
