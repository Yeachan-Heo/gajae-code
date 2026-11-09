import { beforeAll, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { commitModelAssignments } from "@gajae-code/coding-agent/config/model-profile-activation";
import {
	commitDurableModelProfileOwnership,
	type DurableModelProfileOwnership,
	ModelProfileOwnershipConflictError,
	readDurableModelProfileOwnership,
	readDurableModelProfileOwnershipFromRaw,
} from "@gajae-code/coding-agent/config/model-profile-ownership";
import type { GjcModelAssignmentTargetId } from "@gajae-code/coding-agent/config/model-registry";
import {
	formatModelSelectorValue,
	resolveAgentModelPatterns,
	resolveModelOverride,
	resolveModelRoleValue,
} from "@gajae-code/coding-agent/config/model-resolver";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { TempDir } from "@gajae-code/utils";
import type { AgentSessionProfileInstalledOverrideState } from "../src/session/agent-session";
import { DefaultModelSelectionRecoveryError } from "../src/session/default-model-selection";

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const selectedModel = model("provider-a", "selected");

function createControllerContext() {
	const settings = Settings.isolated();
	settings.set("modelRoles", { default: "provider-a/original-default:medium" });
	settings.set("task.agentModelOverrides", { executor: "provider-a/original-executor:low" });
	settings.unset("modelProfile.default");
	const setModelCalls: Array<{
		model: Model;
		role: string;
		options?: {
			cause?: "user-selection";
			observedOwnership?: DurableModelProfileOwnership;
			assignments?: ReadonlyMap<GjcModelAssignmentTargetId, string>;
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			onMutationStarted?: () => void;
			recordUsage?: boolean;
		};
	}> = [];
	const setModelTemporary = vi.fn(
		async (_model: Model, _thinkingLevel?: ThinkingLevel, options?: { onMutationStarted?: () => void }) => {
			options?.onMutationStarted?.();
		},
	);
	const markUserModelSelection = vi.fn();
	const setDefaultFallbackRuntimeModel = vi.fn();
	let activeModelProfile: string | undefined;
	let profileInstalledOverrideState: AgentSessionProfileInstalledOverrideState = {
		modelRoles: new Map(),
		agentModelOverrides: new Map(),
		installedModelRoles: new Map(),
		installedAgentModelOverrides: new Map(),
		manualModelRoles: new Set(),
		manualAgentModelOverrides: new Set(),
		configuredAgentModelOverrides: new Set(),
		preProfileModel: undefined,
	};

	const session = {
		model: model("provider-a", "current") as Model | undefined,
		thinkingLevel: ThinkingLevel.Medium as ThinkingLevel | undefined,
		sessionId: "session-1",
		dispose: vi.fn(async () => {}),
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [selectedModel],
			refresh: vi.fn(async () => {}),
			getAll: () => [selectedModel],
			hasConfiguredProviderAuth: () => false,
			getError: () => undefined,
			getCanonicalModels: () => [],
			getCanonicalModelSelections: () => [],
			getDiscoverableProviders: () => [],
			getAvailableModelProfileNames: () => [],
			getModelProfiles: () => new Map(),
			getModelProfile: () => undefined,
			resolveCanonicalModel: () => undefined,
			getApiKey: vi.fn(async (_model?: Model, _sessionId?: string): Promise<string | undefined> => "key"),
			getSessionCanonicalVariant: () => undefined,
			restoreSessionCanonicalVariant: vi.fn(),
			clearCanonicalVariant: vi.fn(),
		},
		async setModel(
			nextModel: Model,
			role: string,
			options?: {
				cause?: "user-selection";
				observedOwnership?: DurableModelProfileOwnership;
				assignments?: ReadonlyMap<GjcModelAssignmentTargetId, string>;
				selector?: string;
				thinkingLevel?: ThinkingLevel;
				onMutationStarted?: () => void;
				recordUsage?: boolean;
			},
		) {
			setModelCalls.push({ model: nextModel, role, options });
			options?.onMutationStarted?.();
			const assignments = new Map(options?.assignments);
			assignments.set(
				"default",
				formatModelSelectorValue(
					options?.selector ?? `${nextModel.provider}/${nextModel.id}`,
					options?.thinkingLevel,
				),
			);
			await commitModelAssignments(settings, assignments, options?.observedOwnership);
			this.model = nextModel;
			if (options?.thinkingLevel) this.thinkingLevel = options.thinkingLevel;
			this.markProfileRoleOverrideManual("modelRoles", role);
		},
		markUserModelSelection,
		setModelTemporary,
		recordModelSelectionUsage: vi.fn(),
		beginModelSelectionUsage: () => 1,
		setDefaultFallbackRuntimeModel,
		async restoreModelSelectionForRollback(nextModel: Model | undefined, thinkingLevel: ThinkingLevel | undefined) {
			this.model = nextModel;
			this.thinkingLevel = thinkingLevel;
		},
		getConfiguredModelChainState: () => undefined,
		setConfiguredModelChain: vi.fn(),
		getDefaultFallbackRuntimeState: () => ({
			chain: {
				role: "default",
				entries: ["provider-a/original-default:medium"],
				origin: "runtime",
				explicitHead: true,
			},
			controller: {
				activeIndex: 0,
				attemptsUsed: 0,
				totalAttemptsUsed: 0,
				attemptStarted: false,
				restoredEntryIndices: [],
				tried: [],
				skips: [],
				exhaustedForTurn: false,
			},
			exhaustedLastTurn: false,
		}),
		restoreDefaultFallbackRuntimeState: vi.fn(),
		setActiveModelProfile(name: string | undefined) {
			if (name !== activeModelProfile) {
				profileInstalledOverrideState = {
					...profileInstalledOverrideState,
					manualModelRoles: new Set(),
					manualAgentModelOverrides: new Set(),
				};
			}
			activeModelProfile = name;
		},
		recordResumeDefaultModel: vi.fn(),
		getProfileInstalledOverrideState: () => profileInstalledOverrideState,
		restoreProfileInstalledOverrideState: (state: AgentSessionProfileInstalledOverrideState) => {
			profileInstalledOverrideState = state;
		},
		markProfileRoleOverrideManual(path: "modelRoles" | "task.agentModelOverrides", role: string) {
			if (activeModelProfile === undefined) return;
			profileInstalledOverrideState = {
				...profileInstalledOverrideState,
				...(path === "modelRoles"
					? { manualModelRoles: new Set([...profileInstalledOverrideState.manualModelRoles, role]) }
					: {
							manualAgentModelOverrides: new Set([
								...profileInstalledOverrideState.manualAgentModelOverrides,
								role,
							]),
						}),
			};
		},
		sessionManager: {
			buildSessionContext: (): { models: { default: string | undefined } } => ({
				models: { default: "provider-a/original-default:medium" },
			}),
			appendModelChange: vi.fn(),
		},

		setThinkingLevel(thinkingLevel: ThinkingLevel) {
			this.thinkingLevel = thinkingLevel;
		},
		getActiveModelProfile: () => activeModelProfile,
		isFastForProvider: () => false,
		isFastForSubagentProvider: () => false,
		isFastModeActive: () => false,
	};
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn(), requestLayoutRender: vi.fn() },
		editorContainer: { clear: vi.fn(), detachChild: vi.fn(), addChild: vi.fn() },
		editor: {},
		settings,
		session,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		notifyConfigChanged: vi.fn(async () => {}),
		restoreComposer: vi.fn(),
	};
	return {
		ctx,
		settings,
		session,
		setModelCalls,
		setModelTemporary,

		setDefaultFallbackRuntimeModel,
	};
}

async function openSelector(ctx: ReturnType<typeof createControllerContext>["ctx"]): Promise<ModelSelectorComponent> {
	new SelectorController(ctx as never).showModelSelector();
	return ctx.editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
}
async function settleSelectorInput(): Promise<void> {
	await Bun.sleep(0);
	await Promise.resolve();
}

async function openReadySelector(ctx: Parameters<typeof openSelector>[0]): Promise<ModelSelectorComponent> {
	const selector = await openSelector(ctx);
	await settleSelectorInput();
	return selector;
}

function selectMenuAction(selector: ModelSelectorComponent, actionIndex: number): void {
	selector.handleInput("\n");
	for (let index = 0; index < actionIndex; index += 1) selector.handleInput("\x1b[B");
	selector.handleInput("\n");
}

describe("SelectorController model batch assignments", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		installTestTheme();
	});
	test("all role agents selection writes every role-agent override and leaves DEFAULT unchanged", async () => {
		const { ctx, settings, setModelCalls } = createControllerContext();
		settings.override("task.agentModelOverrides", {
			executor: "provider-a/profile-executor:medium",
			architect: "provider-a/profile-architect:low",
		});
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 6);
		await settleSelectorInput();

		expect(setModelCalls).toEqual([]);
		expect(settings.getModelRole("default")).toBe("provider-a/original-default:medium");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/selected",
			architect: "provider-a/selected",
			planner: "provider-a/selected",
			critic: "provider-a/selected",
		});

		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/selected",
			architect: "provider-a/selected",
			planner: "provider-a/selected",
			critic: "provider-a/selected",
		});
		expect(ctx.showStatus).toHaveBeenCalledWith(
			"Role-agent models set to provider-a/selected for EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		);
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
	});

	test("all targets selection writes DEFAULT plus every role-agent override", async () => {
		const { ctx, settings, setModelCalls } = createControllerContext();
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 7);
		await settleSelectorInput();

		expect(setModelCalls).toEqual([
			{
				model: selectedModel,
				role: "default",
				options: {
					cause: "user-selection",
					observedOwnership: { schemaVersion: 1, version: 0, marker: { kind: "inherit" } },
					onMutationStarted: expect.any(Function),
					recordUsage: false,
					selector: "provider-a/selected",
					thinkingLevel: ThinkingLevel.Inherit,
					assignments: new Map([
						["default", "provider-a/selected"],
						["executor", "provider-a/selected"],
						["architect", "provider-a/selected"],
						["planner", "provider-a/selected"],
						["critic", "provider-a/selected"],
						["image", "provider-a/selected"],
					]),
				},
			},
		]);
		expect(settings.getModelRole("default")).toBe("provider-a/selected");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/selected",
			architect: "provider-a/selected",
			planner: "provider-a/selected",
			critic: "provider-a/selected",
		});
		expect(ctx.showStatus).toHaveBeenCalledWith(
			"All model targets set to provider-a/selected for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC, IMAGE.",
		);
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
	});

	for (const disposition of ["unknown", "partial"] as const) {
		for (const bulk of [false, true]) {
			test(`${bulk ? "bulk" : "single"} DEFAULT ${disposition} with matching old Settings never compensates an uncertain selection`, async () => {
				const { ctx, settings, session } = createControllerContext();
				const selectorValue = "provider-a/selected";
				settings.set("modelRoles", { default: selectorValue });
				const winnerModel = model("provider-b", "newer-winner");
				const original = new DefaultModelSelectionRecoveryError("selection failed", {
					message: "selection failed",
					rollback: {
						disposition,
						failures: [{ stage: "session", message: "Session replacement recovery could not be completed." }],
					},
				});
				const durableCommit = vi.spyOn(settings, "commitAtomicBatchWithCurrent");
				const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
				const restoreProfile = vi.spyOn(session, "restoreProfileInstalledOverrideState");
				session.setActiveModelProfile("profile-a");
				const selector = await openReadySelector(ctx);
				session.setModel = async (_nextModel, _role, options) => {
					options?.onMutationStarted?.();
					session.model = winnerModel;
					session.setActiveModelProfile("profile-b");
					throw original;
				};
				const assignment = {
					model: selectedModel,
					role: "default" as const,
					thinkingLevel: ThinkingLevel.Inherit,
					selector: selectorValue,
					...(bulk ? { roles: ["default", "executor"] as GjcModelAssignmentTargetId[] } : {}),
				};
				if (bulk) await selector.__testSelectAssignment(assignment);
				else await expect(selector.__testSelectAssignment(assignment)).rejects.toBe(original);
				expect(ctx.showError).toHaveBeenCalledWith(original.message);
				expect(durableCommit).not.toHaveBeenCalled();
				expect(settings.getGlobal("modelRoles")).toEqual({ default: selectorValue });
				expect(session.model).toBe(winnerModel);
				expect(session.getActiveModelProfile()).toBe("profile-b");
				expect(session.setConfiguredModelChain).not.toHaveBeenCalled();
				expect(session.recordResumeDefaultModel).not.toHaveBeenCalled();
				expect(session.restoreDefaultFallbackRuntimeState).not.toHaveBeenCalled();
				expect(session.modelRegistry.restoreSessionCanonicalVariant).not.toHaveBeenCalled();
				expect(restoreProfile).not.toHaveBeenCalled();
				expect(restoreModel).not.toHaveBeenCalled();
				expect(session.recordModelSelectionUsage).not.toHaveBeenCalled();
				expect(ctx.showStatus).not.toHaveBeenCalled();
			});
		}
	}

	for (const restored of [false, true]) {
		test(`${restored ? "legacy restored" : "generic"} failed DEFAULT restores caller-owned profile/manual/runtime state`, async () => {
			const { ctx, session } = createControllerContext();
			const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
			const restoreProfile = vi.spyOn(session, "restoreProfileInstalledOverrideState");
			session.setModel = async (nextModel, role, options) => {
				options?.onMutationStarted?.();
				session.model = nextModel;
				session.markProfileRoleOverrideManual("modelRoles", role);
				throw restored
					? new DefaultModelSelectionRecoveryError("post-selection synchronization failed", {
							message: "post-selection synchronization failed",
							rollback: { disposition: "restored", failures: [] },
						})
					: new Error("post-selection synchronization failed");
			};
			const selector = await openReadySelector(ctx);
			session.setActiveModelProfile("profile-a");

			selectMenuAction(selector, 0);
			await settleSelectorInput();

			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining(
					restored ? "Default model selection could not be completed" : "post-selection synchronization failed",
				),
			);
			expect(session.getActiveModelProfile()).toBe("profile-a");
			expect(session.getProfileInstalledOverrideState().manualModelRoles).toEqual(new Set());
			expect(restoreProfile).toHaveBeenCalledTimes(1);
			expect(restoreModel).toHaveBeenCalledTimes(1);
			expect(session.restoreDefaultFallbackRuntimeState).toHaveBeenCalledTimes(1);
		});
	}

	test("failed assignment never restores a stale projection over a newer committed owner", async () => {
		const { ctx, settings, session } = createControllerContext();
		await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "profile-a" });
		session.setActiveModelProfile("profile-a");
		const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
		session.setModel = async (_nextModel, _role, options) => {
			options?.onMutationStarted?.();
			await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "profile-b" }, [
				{ path: "modelRoles", op: "set", value: { default: "provider-b/winner" } },
			]);
			throw new Error("selection superseded after durable publication");
		};
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 0);
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(
			expect.stringContaining("selection superseded after durable publication"),
		);
		expect(readDurableModelProfileOwnership(settings)).toMatchObject({
			version: 2,
			marker: { kind: "profile", profile: "profile-b" },
		});
		expect(settings.getGlobal("modelProfile.default")).toBe("profile-b");
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider-b/winner" });
		expect(restoreModel).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	test("credential preflight cannot consume or restore a newer profile owner's state", async () => {
		const { ctx, settings, session } = createControllerContext();
		const owner = await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "profile-a" });
		session.setActiveModelProfile("profile-a");
		const started = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string>();
		session.modelRegistry.getApiKey.mockImplementationOnce(() => {
			started.resolve();
			return credential.promise;
		});
		const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
		session.setModel = async (_nextModel, _role, options) => {
			expect(options?.observedOwnership).toEqual(owner);
			options?.onMutationStarted?.();
			const winner = readDurableModelProfileOwnership(settings);
			throw new ModelProfileOwnershipConflictError(owner.version, winner.version, winner.marker);
		};
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 0);
		await started.promise;
		await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "profile-b" }, [
			{ path: "modelRoles", op: "set", value: { default: "provider-b/winner" } },
		]);
		session.setActiveModelProfile("profile-b");
		const winnerModel = model("provider-b", "winner");
		session.model = winnerModel;
		credential.resolve("key");
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("changed concurrently"));
		expect(readDurableModelProfileOwnership(settings)).toMatchObject({
			version: 2,
			marker: { kind: "profile", profile: "profile-b" },
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider-b/winner" });
		expect(session.model).toBe(winnerModel);
		expect(session.getActiveModelProfile()).toBe("profile-b");
		expect(restoreModel).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	test("role-only preflight cannot overwrite a new owner in an initially unprofiled session", async () => {
		const { ctx, settings, session } = createControllerContext();
		const started = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string>();
		session.modelRegistry.getApiKey.mockImplementationOnce(() => {
			started.resolve();
			return credential.promise;
		});
		const selector = await openReadySelector(ctx);
		selectMenuAction(selector, 1);
		await started.promise;
		const winner = await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "profile-b" }, [
			{ path: "task.agentModelOverrides", op: "set", value: { architect: "provider-b/winner" } },
		]);
		credential.resolve("key");
		await settleSelectorInput();
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("changed concurrently"));
		expect(readDurableModelProfileOwnership(settings)).toEqual(winner);
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ architect: "provider-b/winner" });
	});

	test("rollback checks the disk owner even when its Settings snapshot is stale", async () => {
		const temp = TempDir.createSync("profile-selector-rollback-");
		const agentDir = path.join(temp.path(), "agent");
		const settings = await Settings.loadForScope({ cwd: temp.path(), agentDir });
		await commitDurableModelProfileOwnership(settings, { kind: "profile", profile: "profile-a" });
		const writer = await Settings.loadForScope({ cwd: temp.path(), agentDir });
		try {
			const { ctx, session } = createControllerContext();
			ctx.settings = settings;
			session.setActiveModelProfile("profile-a");
			const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
			const reported = Promise.withResolvers<void>();
			ctx.showError.mockImplementation(() => reported.resolve());
			session.setModel = async (_nextModel, _role, options) => {
				options?.onMutationStarted?.();
				await commitDurableModelProfileOwnership(writer, { kind: "profile", profile: "profile-b" }, [
					{ path: "modelRoles", op: "set", value: { default: "provider-b/winner" } },
				]);
				expect(readDurableModelProfileOwnership(settings).marker).toEqual({
					kind: "profile",
					profile: "profile-a",
				});
				throw new Error("another process committed profile-b");
			};
			const selector = await openReadySelector(ctx);
			selectMenuAction(selector, 0);
			await reported.promise;

			const raw = Bun.YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as Record<
				string,
				unknown
			>;
			expect(readDurableModelProfileOwnershipFromRaw(raw)).toMatchObject({
				version: 2,
				marker: { kind: "profile", profile: "profile-b" },
			});
			expect((raw.modelRoles as Record<string, unknown>).default).toBe("provider-b/winner");
			expect(restoreModel).not.toHaveBeenCalled();
			expect(session.dispose).toHaveBeenCalledTimes(1);
		} finally {
			await writer.close();
			await settings.close();
			temp.removeSync();
		}
	});

	test("rolls back all targets when a later role setting write fails", async () => {
		const { ctx, settings, session } = createControllerContext();
		const originalModel = session.model;
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("role write failed"));
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 7);
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("role write failed"));
		expect(session.model).toBe(originalModel);
		expect(settings.get("modelRoles")).toEqual({ default: "provider-a/original-default:medium" });
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/original-executor:low",
		});
	});

	test("restores a model-less session when all-target assignment fails", async () => {
		const { ctx, settings, session } = createControllerContext();
		session.model = undefined;
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("role write failed"));
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 7);
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("role write failed"));
		expect(session.model).toBeUndefined();
	});

	test("role-only assignment failure restores profile-owned default state without rewriting the live model", async () => {
		const { ctx, settings, session } = createControllerContext();
		const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("role write failed"));
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 6);
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("role write failed"));
		expect(restoreModel).not.toHaveBeenCalled();
		expect(session.setConfiguredModelChain).toHaveBeenCalledTimes(1);
		expect(session.restoreDefaultFallbackRuntimeState).toHaveBeenCalledTimes(1);
		expect(session.recordResumeDefaultModel).not.toHaveBeenCalled();
	});

	test("default API-key preflight failure bypasses rollback side effects", async () => {
		const { ctx, session } = createControllerContext();
		const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
		session.modelRegistry.getApiKey.mockResolvedValue(undefined);
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 0);
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("No API key"));
		expect(restoreModel).not.toHaveBeenCalled();
		expect(session.sessionManager.appendModelChange).not.toHaveBeenCalled();
	});
	test("second credential check failure preserves the original auth error without compensation", async () => {
		const { ctx, session } = createControllerContext();
		const restoreModel = vi.spyOn(session, "restoreModelSelectionForRollback");
		session.modelRegistry.getApiKey.mockResolvedValueOnce("key").mockResolvedValueOnce(undefined);
		session.setModel = async nextModel => {
			const apiKey = await session.modelRegistry.getApiKey(nextModel, session.sessionId);
			if (!apiKey) throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		};
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 0);
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("No API key"));
		expect(restoreModel).not.toHaveBeenCalled();
		expect(session.setConfiguredModelChain).not.toHaveBeenCalled();
		expect(session.recordResumeDefaultModel).not.toHaveBeenCalled();
	});
	test("post-mutation default failure restores an absent resume selector explicitly", async () => {
		const { ctx, session } = createControllerContext();
		const previousModel = session.model;
		session.sessionManager.buildSessionContext = () => ({ models: { default: undefined } });
		session.setModel = async (nextModel, _role, options) => {
			options?.onMutationStarted?.();
			session.model = nextModel;
			throw new Error("post-mutation failure");
		};
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 0);
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("post-mutation failure"));
		expect(session.recordResumeDefaultModel).toHaveBeenCalledWith(undefined);
		expect(session.model).toBe(previousModel);
	});
	test("individual DEFAULT assignment stays open until cancel", async () => {
		const { ctx, settings } = createControllerContext();
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 0);
		await settleSelectorInput();

		expect(settings.getModelRole("default")).toBe("provider-a/selected");
		expect(ctx.restoreComposer).not.toHaveBeenCalled();

		selector.handleInput("\x1b");
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
	});
	test("serializes consecutive named role assignments on the mounted selector", async () => {
		const { ctx, settings, session } = createControllerContext();
		const firstGate = Promise.withResolvers<string>();
		const secondGate = Promise.withResolvers<string>();
		session.modelRegistry.getApiKey
			.mockImplementationOnce(async () => await firstGate.promise)
			.mockImplementationOnce(async () => await secondGate.promise);
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 1);
		expect(session.modelRegistry.getApiKey).toHaveBeenCalledTimes(1);
		firstGate.resolve("key");
		await settleSelectorInput();

		selectMenuAction(selector, 2);
		expect(session.modelRegistry.getApiKey).toHaveBeenCalledTimes(2);
		secondGate.resolve("key");
		await settleSelectorInput();

		expect(settings.get("task.agentModelOverrides")).toMatchObject({
			executor: "provider-a/selected",
			architect: "provider-a/selected",
		});
		expect(ctx.restoreComposer).not.toHaveBeenCalled();
	});
	test("suppresses pending menu input and defers repeated cancel once through successful assignment", async () => {
		const { ctx, settings, session } = createControllerContext();
		const gate = Promise.withResolvers<string>();
		session.modelRegistry.getApiKey.mockImplementation(async () => await gate.promise);
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 1);
		selector.handleInput("\n");
		selector.handleInput("\x1b");
		selector.handleInput("\x1b");
		expect(session.modelRegistry.getApiKey).toHaveBeenCalledTimes(1);

		gate.resolve("key");
		await settleSelectorInput();

		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: "provider-a/selected" });
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
	});
	test("reports rejected and missing-key tracked assignments before one deferred restore", async () => {
		for (const apiKeyResult of [
			async (): Promise<string | undefined> => {
				throw new Error("credential rejected");
			},
			async (): Promise<string | undefined> => undefined,
		]) {
			const { ctx, session } = createControllerContext();
			const order: string[] = [];
			ctx.showError.mockImplementation(() => order.push("error"));
			ctx.ui.requestRender.mockImplementation(() => order.push("render"));
			ctx.restoreComposer.mockImplementation(() => order.push("restore"));
			session.modelRegistry.getApiKey.mockImplementation(async () => await apiKeyResult());
			const selector = await openReadySelector(ctx);
			const refreshRoleAssignments = selector.refreshRoleAssignments.bind(selector);
			vi.spyOn(selector, "refreshRoleAssignments").mockImplementation(options => {
				order.push("refresh");
				refreshRoleAssignments(options);
			});
			order.length = 0;

			selectMenuAction(selector, 1);
			selector.handleInput("\x1b");
			selector.handleInput("\x1b");
			await settleSelectorInput();

			expect(ctx.showError).toHaveBeenCalledTimes(1);
			expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
			const errorIndex = order.indexOf("error");
			const refreshIndex = order.indexOf("refresh");
			const restoreIndex = order.indexOf("restore");
			const refreshRenderIndex = order.indexOf("render", refreshIndex);
			expect(errorIndex).toBeLessThan(refreshIndex);
			expect(refreshIndex).toBeLessThan(refreshRenderIndex);
			expect(refreshRenderIndex).toBeLessThan(restoreIndex);
		}
	});
	test("refreshes tracked assignment truth after failure and permits retry", async () => {
		const { ctx, settings, session } = createControllerContext();
		const failure = Promise.withResolvers<string>();
		const success = Promise.withResolvers<string>();
		session.modelRegistry.getApiKey
			.mockImplementationOnce(async () => await failure.promise)
			.mockImplementationOnce(async () => await success.promise);
		const selector = await openReadySelector(ctx);

		selectMenuAction(selector, 1);
		failure.reject(new Error("credential rejected"));
		await settleSelectorInput();
		expect(ctx.showError).toHaveBeenCalledTimes(1);
		expect(session.markUserModelSelection).not.toHaveBeenCalled();
		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: "provider-a/original-executor:low" });

		selectMenuAction(selector, 1);
		success.resolve("key");
		await settleSelectorInput();

		expect(session.modelRegistry.getApiKey).toHaveBeenCalledTimes(2);
		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: "provider-a/selected" });
	});

	test("does not fence a temporary selection rejected before mutation", async () => {
		const { ctx, session, setModelTemporary } = createControllerContext();
		setModelTemporary.mockRejectedValueOnce(new Error("No API key for provider-a/selected"));
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: null,
			thinkingLevel: ThinkingLevel.Low,
			selector: "provider-a/selected:low",
		});
		await settleSelectorInput();

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("No API key"));
		expect(session.markUserModelSelection).not.toHaveBeenCalled();
	});

	test("temporary selection replaces the live fallback chain with the selected model", async () => {
		const { ctx, settings, session, setModelTemporary, setDefaultFallbackRuntimeModel } = createControllerContext();
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: null,
			thinkingLevel: ThinkingLevel.Low,
			selector: "provider-a/selected:low",
		});

		expect(setModelTemporary).toHaveBeenCalledWith(selectedModel, ThinkingLevel.Low, {
			cause: "temporary-operation",
			onMutationStarted: expect.any(Function),
			reason: "other",
		});
		expect(session.markUserModelSelection).toHaveBeenCalledTimes(1);
		expect(setDefaultFallbackRuntimeModel).toHaveBeenCalledWith("provider-a/selected:low");
		expect(settings.getModelRole("default")).toBe("provider-a/original-default:medium");
	});

	test("DEFAULT assignment persists its explicit effort for session restart resolution", async () => {
		const { ctx, settings, setModelCalls } = createControllerContext();
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "default",
			thinkingLevel: ThinkingLevel.High,
			selector: "provider-a/selected",
		});

		expect(setModelCalls).toEqual([
			{
				model: selectedModel,
				role: "default",
				options: {
					cause: "user-selection",
					observedOwnership: { schemaVersion: 1, version: 0, marker: { kind: "inherit" } },
					onMutationStarted: expect.any(Function),
					recordUsage: false,
					selector: "provider-a/selected",
					thinkingLevel: ThinkingLevel.High,
				},
			},
		]);
		expect(settings.getModelRole("default")).toBe("provider-a/selected:high");
		const restarted = resolveModelRoleValue(settings.getModelRole("default"), [selectedModel]);
		expect(restarted.model).toBe(selectedModel);
		expect(restarted.thinkingLevel).toBe(ThinkingLevel.High);
		expect(restarted.explicitThinkingLevel).toBe(true);
	});

	test("relies on AgentSession to replace the prior temporary provider-session scope", async () => {
		const { ctx, setModelTemporary } = createControllerContext();
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: null,
			thinkingLevel: ThinkingLevel.Low,
			selector: "provider-a/selected:low",
		});
		await selector.__testSelectAssignment({
			model: model("provider-a", "replacement"),
			role: null,
			thinkingLevel: ThinkingLevel.High,
			selector: "provider-a/replacement:high",
		});

		expect(setModelTemporary).toHaveBeenCalledTimes(2);
	});
	test("role assignment replaces active profile override immediately and persists the explicit selection", async () => {
		const { ctx, settings, session } = createControllerContext();
		let marksAtCredentialProbe = 0;
		session.modelRegistry.getApiKey.mockImplementation(async () => {
			marksAtCredentialProbe = session.markUserModelSelection.mock.calls.length;
			return "key";
		});
		settings.override("task.agentModelOverrides", {
			executor: "provider-a/profile-executor:medium",
			architect: "provider-a/profile-architect:low",
		});
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "architect",
			thinkingLevel: ThinkingLevel.High,
			selector: "provider-a/selected:high",
		});

		expect(session.markUserModelSelection).toHaveBeenCalledTimes(1);
		expect(marksAtCredentialProbe).toBe(0);
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/profile-executor:medium",
			architect: "provider-a/selected:high",
		});

		const modelPatterns = resolveAgentModelPatterns({
			settingsOverride: settings.get("task.agentModelOverrides").architect,
			agentModel: "provider-a/profile-architect:low",
			settings,
		});
		const resolved = resolveModelOverride(modelPatterns, ctx.session.modelRegistry, settings);
		expect(resolved.model).toBe(selectedModel);
		expect(resolved.thinkingLevel).toBe(ThinkingLevel.High);
		expect(resolved.explicitThinkingLevel).toBe(true);

		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/original-executor:low",
			architect: "provider-a/selected:high",
		});
	});
});
