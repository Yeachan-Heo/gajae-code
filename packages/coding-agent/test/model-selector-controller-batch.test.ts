import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { resolveAgentModelPatterns, resolveModelOverride } from "@gajae-code/coding-agent/config/model-resolver";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";

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
		options?: { cause?: "user-selection"; selector?: string; thinkingLevel?: ThinkingLevel };
	}> = [];
	const setModelTemporary = vi.fn(async () => {});
	const setDefaultFallbackRuntimeModel = vi.fn();

	const session = {
		model: model("provider-a", "current") as Model | undefined,
		thinkingLevel: ThinkingLevel.Medium as ThinkingLevel | undefined,
		sessionId: "session-1",
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [selectedModel],
			refresh: vi.fn(async () => {}),
			getAll: () => [selectedModel],
			getError: () => undefined,
			getCanonicalModels: () => [],
			getDiscoverableProviders: () => [],
			getAvailableModelProfileNames: () => [],
			getModelProfiles: () => new Map(),
			resolveCanonicalModel: () => undefined,
			getApiKey: vi.fn(async (): Promise<string | undefined> => "key"),
		},
		async setModel(
			nextModel: Model,
			role: string,
			options?: { cause?: "user-selection"; selector?: string; thinkingLevel?: ThinkingLevel },
		) {
			setModelCalls.push({ model: nextModel, role, options });
			this.model = nextModel;
			if (options?.thinkingLevel) this.thinkingLevel = options.thinkingLevel;
		},
		setModelTemporary,
		setDefaultFallbackRuntimeModel,

		setThinkingLevel(thinkingLevel: ThinkingLevel) {
			this.thinkingLevel = thinkingLevel;
		},
		getActiveModelProfile: () => undefined,
		isFastForProvider: () => false,
		isFastForSubagentProvider: () => false,
		isFastModeActive: () => false,
	};
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
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
	await Promise.resolve();
	await Promise.resolve();
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

		selectMenuAction(selector, 5);
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

		selectMenuAction(selector, 6);
		await settleSelectorInput();

		expect(setModelCalls).toEqual([
			{
				model: selectedModel,
				role: "default",
				options: { cause: "user-selection", selector: "provider-a/selected", thinkingLevel: ThinkingLevel.Inherit },
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
			"All model targets set to provider-a/selected for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		);
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
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
		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: "provider-a/original-executor:low" });

		selectMenuAction(selector, 1);
		success.resolve("key");
		await settleSelectorInput();

		expect(session.modelRegistry.getApiKey).toHaveBeenCalledTimes(2);
		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: "provider-a/selected" });
	});

	test("temporary selection replaces the live fallback chain with the selected model", async () => {
		const { ctx, settings, setModelTemporary, setDefaultFallbackRuntimeModel } = createControllerContext();
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: null,
			thinkingLevel: ThinkingLevel.Low,
			selector: "provider-a/selected:low",
		});

		expect(setModelTemporary).toHaveBeenCalledWith(selectedModel, ThinkingLevel.Low, {
			cause: "temporary-operation",
			reason: "other",
		});
		expect(setDefaultFallbackRuntimeModel).toHaveBeenCalledWith("provider-a/selected:low");
		expect(settings.getModelRole("default")).toBe("provider-a/original-default:medium");
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
		const { ctx, settings } = createControllerContext();
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
