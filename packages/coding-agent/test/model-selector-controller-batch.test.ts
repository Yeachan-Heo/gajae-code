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
			getApiKey: vi.fn(async () => "key"),
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
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "default",
			roles: ["executor", "architect", "planner", "critic"],
			thinkingLevel: ThinkingLevel.Low,
			selector: "provider-a/selected:low",
		});

		expect(setModelCalls).toEqual([]);
		expect(settings.getModelRole("default")).toBe("provider-a/original-default:medium");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/selected:low",
			architect: "provider-a/selected:low",
			planner: "provider-a/selected:low",
			critic: "provider-a/selected:low",
		});

		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/selected:low",
			architect: "provider-a/selected:low",
			planner: "provider-a/selected:low",
			critic: "provider-a/selected:low",
		});
		expect(ctx.showStatus).toHaveBeenCalledWith(
			"Role-agent models set to provider-a/selected:low for EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		);
	});

	test("all targets selection writes DEFAULT plus every role-agent override", async () => {
		const { ctx, settings, setModelCalls } = createControllerContext();
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "default",
			roles: ["default", "executor", "architect", "planner", "critic"],
			thinkingLevel: ThinkingLevel.High,
			selector: "provider-a/selected:high",
		});

		expect(setModelCalls).toEqual([
			{
				model: selectedModel,
				role: "default",
				options: { cause: "user-selection", selector: "provider-a/selected", thinkingLevel: ThinkingLevel.High },
			},
		]);
		expect(settings.getModelRole("default")).toBe("provider-a/selected:high");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "provider-a/selected:high",
			architect: "provider-a/selected:high",
			planner: "provider-a/selected:high",
			critic: "provider-a/selected:high",
		});
		expect(ctx.showStatus).toHaveBeenCalledWith(
			"All model targets set to provider-a/selected:high for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		);
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
