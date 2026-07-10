import { beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";

let testTheme = await getThemeByName("red-claw");
function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

const model = (provider: string, id: string, thinking?: Model["thinking"]): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
		thinking,
		reasoning: thinking !== undefined,
	}) as Model;
const selectedModel = model("provider-a", "selected", {
	mode: "effort",
	minLevel: ThinkingLevel.Low,
	maxLevel: ThinkingLevel.High,
});
const nonReasoningModel = model("provider-a", "plain");

function createControllerContext(settings = Settings.isolated()) {
	settings.set("modelRoles", { default: "provider-a/original-default:medium" });
	settings.set("task.agentModelOverrides", { executor: "provider-a/original-executor:low" });
	settings.set("modelProfile.default", undefined);
	const setModelCalls: Array<{
		model: Model;
		role: string;
		options?: { selector?: string; thinkingLevel?: ThinkingLevel };
	}> = [];
	const session = {
		model: model("provider-a", "current") as Model | undefined,
		thinkingLevel: ThinkingLevel.Medium as ThinkingLevel | undefined,
		sessionId: "session-1",
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [selectedModel, nonReasoningModel],
			refresh: vi.fn(async () => {}),
			getAll: () => [selectedModel, nonReasoningModel],
			getError: () => undefined,
			getCanonicalModels: () => [],
			getDiscoverableProviders: () => [],
			getAvailableModelProfileNames: () => [],
			getModelProfiles: () => new Map(),
			resolveCanonicalModel: () => undefined,
			getApiKey: vi.fn(async () => "key"),
		},
		async setModel(nextModel: Model, role: string, options?: { selector?: string; thinkingLevel?: ThinkingLevel }) {
			setModelCalls.push({ model: nextModel, role, options });
			this.model = nextModel;
			if (options?.thinkingLevel) this.thinkingLevel = options.thinkingLevel;
			const selector = options?.selector ?? `${nextModel.provider}/${nextModel.id}`;
			settings.setModelRole(
				role,
				options?.thinkingLevel && options.thinkingLevel !== ThinkingLevel.Inherit
					? `${selector}:${options.thinkingLevel}`
					: selector,
			);
		},
		async setModelTemporary() {},
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
	return { ctx, settings, session, setModelCalls };
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
		expect(ctx.showStatus).toHaveBeenCalledWith(
			"Role-agent models set to provider-a/selected:low for EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		);
		expect(ctx.notifyConfigChanged).toHaveBeenCalledTimes(1);
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
				options: { selector: "provider-a/selected", thinkingLevel: ThinkingLevel.High },
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
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("DEFAULT (high)");
		expect(rendered).toContain("EXECUTOR (high)");
		expect(rendered).toContain("ARCHITECT (high)");
		expect(rendered).toContain("PLANNER (high)");
		expect(rendered).toContain("CRITIC (high)");
		expect(ctx.notifyConfigChanged).toHaveBeenCalledTimes(1);
	});

	test("all targets replace live role overrides with the selected model's clamped effort", async () => {
		const { ctx, settings } = createControllerContext();
		settings.override("task.agentModelOverrides", {
			executor: "provider-a/profile-executor:medium",
			architect: "provider-a/profile-architect:high",
			planner: "provider-a/profile-planner:medium",
			critic: "provider-a/profile-critic:high",
		});
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "default",
			roles: ["default", "executor", "architect", "planner", "critic"],
			thinkingLevel: ThinkingLevel.XHigh,
			selector: "provider-a/selected:xhigh",
		});

		const expectedRoleOverrides = {
			executor: "provider-a/selected:high",
			architect: "provider-a/selected:high",
			planner: "provider-a/selected:high",
			critic: "provider-a/selected:high",
		};
		expect(settings.get("task.agentModelOverrides")).toEqual(expectedRoleOverrides);

		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual(expectedRoleOverrides);
	});

	test("single role assignments clamp stale effort for a non-reasoning model", async () => {
		const { ctx, settings } = createControllerContext();
		settings.setAgentModelOverride("executor", "provider-a/selected:high");
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: nonReasoningModel,
			role: "executor",
			thinkingLevel: ThinkingLevel.High,
			selector: "provider-a/plain:high",
		});

		expect(settings.get("task.agentModelOverrides").executor).toBe("provider-a/plain");
		settings.clearOverride("task.agentModelOverrides");
		expect(settings.getGlobal("task.agentModelOverrides")).toMatchObject({
			executor: "provider-a/plain",
		});
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("EXECUTOR (inherit)");
		expect(rendered).not.toContain("EXECUTOR (high)");
	});
	test("single role status reports project settings that resume on restart", async () => {
		const { ctx, settings } = createControllerContext();
		settings.getProject = ((path: string) =>
			path === "task.agentModelOverrides"
				? { executor: "project/executor" }
				: undefined) as typeof settings.getProject;
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "executor",
			thinkingLevel: ThinkingLevel.High,
			selector: "provider-a/selected:high",
		});

		expect(ctx.showStatus).toHaveBeenCalledWith(
			"executor agent model: provider-a/selected:high Project settings for EXECUTOR resume on restart.",
		);
	});
	test("single DEFAULT selection notifies configuration observers", async () => {
		const { ctx } = createControllerContext();
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "default",
			thinkingLevel: ThinkingLevel.High,
			selector: "provider-a/selected",
		});

		expect(ctx.notifyConfigChanged).toHaveBeenCalledTimes(1);
	});
	test("DEFAULT inherit persists without a suffix while applying the clamped configured effort live", async () => {
		const { ctx, settings, session, setModelCalls } = createControllerContext();
		settings.set("defaultThinkingLevel", ThinkingLevel.High);
		const selector = await openSelector(ctx);

		await selector.__testSelectAssignment({
			model: selectedModel,
			role: "default",
			thinkingLevel: ThinkingLevel.Inherit,
			selector: "provider-a/selected",
		});

		expect(setModelCalls).toEqual([
			{
				model: selectedModel,
				role: "default",
				options: { selector: "provider-a/selected", thinkingLevel: ThinkingLevel.Inherit },
			},
		]);
		expect(session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(settings.getModelRole("default")).toBe("provider-a/selected");
		expect(ctx.showStatus).toHaveBeenCalledWith(
			"Default model: provider-a/selected (effective: provider-a/selected:high)",
		);
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("DEFAULT (high)");
		expect(rendered).not.toContain("DEFAULT (inherit)");
	});

	test("nonsettling configuration notifications do not block selector completion", async () => {
		const { ctx, setModelCalls } = createControllerContext();
		const never = Promise.withResolvers<void>();
		ctx.notifyConfigChanged = vi.fn(() => never.promise);
		const selector = await openSelector(ctx);

		const completed = await Promise.race([
			selector.__testSelectAssignment({
				model: selectedModel,
				role: "default",
				thinkingLevel: ThinkingLevel.High,
				selector: "provider-a/selected:high",
			}),
			Bun.sleep(100).then(() => "timeout" as const),
		]);

		expect(completed).not.toBe("timeout");
		expect(setModelCalls).toEqual([
			{
				model: selectedModel,
				role: "default",
				options: { selector: "provider-a/selected:high", thinkingLevel: ThinkingLevel.High },
			},
		]);
	});

	test("does not report a persisted role assignment when the config write fails", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-selector-durable-model-"));
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			const { ctx } = createControllerContext(settings);
			await settings.flushOrThrow();
			const selector = await openSelector(ctx);
			const configPath = path.join(fs.realpathSync.native(tempDir), "config.yml");
			const originalWrite = Bun.write;
			const writeSpy = vi.spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (
					typeof args[0] === "string" &&
					args[0].startsWith(`${configPath}.`) &&
					args[0].endsWith(".tmp") &&
					!args[0].startsWith(`${configPath}.revisions.json.`)
				) {
					throw new Error("forced config write failure");
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);
			try {
				await selector.__testSelectAssignment({
					model: selectedModel,
					role: "executor",
					thinkingLevel: ThinkingLevel.Low,
					selector: "provider-a/selected:low",
				});
			} finally {
				writeSpy.mockRestore();
			}

			expect(ctx.showStatus).not.toHaveBeenCalled();
			expect(ctx.notifyConfigChanged).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith("forced config write failure");

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			expect(reopened.get("task.agentModelOverrides").executor).toBe("provider-a/original-executor:low");
		} finally {
			resetSettingsForTest();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
