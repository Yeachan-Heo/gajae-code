import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { CustomTool } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import type { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions";
import { writePendingGoalModeRequest } from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import { GoalTool } from "@gajae-code/coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

type GoalHarness = {
	tempDir: TempDir;
	authStorage: AuthStorage;
	settings: Settings;
	session: AgentSession;
	mode: InteractiveMode;
	toolSession: ToolSession;
	cleanup: () => Promise<void>;
};

function createMCPTool(name: string, mcpToolName: string): CustomTool {
	return {
		name,
		label: `demo/${mcpToolName}`,
		description: `MCP tool ${mcpToolName}`,
		mcpServerName: "demo",
		mcpToolName,
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text", text: `${mcpToolName} executed` }] };
		},
	} as CustomTool;
}

async function createGoalHarness(
	options: {
		extensionRunner?: ExtensionRunner;
		mcpDiscoveryEnabled?: boolean;
		rebuildSystemPrompt?: (toolNames: string[]) => Promise<{ systemPrompt: string[] }>;
	} = {},
): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-mode-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
		"mcp.discoveryMode": options.mcpDiscoveryEnabled === true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		...(options.mcpDiscoveryEnabled === true ? { mcpDiscoveryEnabled: true } : {}),
		rebuildSystemPrompt: options.rebuildSystemPrompt ?? (async () => ({ systemPrompt: ["Test"] })),
		extensionRunner: options.extensionRunner,
	});
	const mode = new InteractiveMode(session, "test");
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
	});
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		authStorage,
		settings,
		session,
		mode,
		toolSession,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

async function toolNamesFor(harness: GoalHarness): Promise<string[]> {
	return (await createTools(harness.toolSession, harness.session.getActiveToolNames())).map(tool => tool.name);
}

describe("InteractiveMode goal mode integration", () => {
	let harness: GoalHarness;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		harness = await createGoalHarness();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it("keeps the unified goal tool exposed across inactive, active, and paused states", async () => {
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);

		await harness.mode.goalModeController.handleCommand("Ship the release");

		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");

		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.goalModeController.handleCommand();

		expect(harness.mode.goalModeController.enabled).toBe(false);
		expect(harness.mode.goalModeController.paused).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);
	});

	it("keeps internal goal and plan tool swaps outside MCP selection authority", async () => {
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);

		await harness.mode.goalModeController.handleCommand("Ship the release");
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);
		await harness.mode.goalModeController.exit();
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);

		await harness.mode.planModeController.enter();
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);
		await harness.mode.planModeController.exit();
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);
	});

	it("preserves MCP selection changes made while goal and plan modes are active", async () => {
		await harness.cleanup();
		harness = await createGoalHarness({ mcpDiscoveryEnabled: true });
		const initialMcpTool = "mcp__demo_before";
		const addedMcpTool = "mcp__demo_during";
		await harness.session.replaceNamedCustomTools(
			[],
			[createMCPTool(initialMcpTool, "before"), createMCPTool(addedMcpTool, "during")],
			{ activateNewTools: false },
		);
		await harness.session.setActiveToolsByName(["read", initialMcpTool]);

		await harness.mode.planModeController.enter();
		await harness.session.activateDiscoveredTools([addedMcpTool]);
		await harness.mode.planModeController.exit();
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", initialMcpTool, addedMcpTool]),
		);
		expect(harness.session.getSelectedMCPToolNames()).toEqual([initialMcpTool, addedMcpTool]);
		expect(harness.session.buildDisplaySessionContext().selectedMCPToolNames).toEqual([initialMcpTool, addedMcpTool]);

		await harness.session.setActiveToolsByName(["read", initialMcpTool]);
		await harness.mode.goalModeController.handleCommand("Ship the release");
		await harness.session.activateDiscoveredTools([addedMcpTool]);
		await harness.mode.goalModeController.exit();
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", initialMcpTool, addedMcpTool]),
		);
		expect(harness.session.getSelectedMCPToolNames()).toEqual([initialMcpTool, addedMcpTool]);
		expect(harness.session.buildDisplaySessionContext().selectedMCPToolNames).toEqual([initialMcpTool, addedMcpTool]);
	});

	it("retains live MCP selections through a temporary catalog removal", async () => {
		await harness.cleanup();
		harness = await createGoalHarness({ mcpDiscoveryEnabled: true });
		const selectedTool = "mcp__demo_selected";
		const discoveredTool = "mcp__demo_discovered";
		const selectedCustomTool = createMCPTool(selectedTool, "selected");
		const discoveredCustomTool = createMCPTool(discoveredTool, "discovered");
		await harness.session.replaceNamedCustomTools([], [selectedCustomTool, discoveredCustomTool], {
			activateNewTools: false,
		});
		await harness.session.setActiveToolsByName(["read", selectedTool], { persistMCPSelection: false });
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(true);
		expect(harness.session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
		await harness.session.activateDiscoveredTools([discoveredTool]);
		expect(harness.session.getSelectedMCPToolNames()).toEqual([selectedTool, discoveredTool]);

		await harness.session.replaceNamedCustomTools([discoveredTool], [selectedCustomTool], {
			persistMCPSelection: false,
		});
		expect(harness.session.getActiveMCPToolNames()).toEqual([selectedTool]);
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(true);

		await harness.session.replaceNamedCustomTools([selectedTool], [selectedCustomTool, discoveredCustomTool], {
			activateNewTools: false,
			inactiveNewToolNames: [discoveredTool],
			persistMCPSelection: false,
		});
		expect(harness.session.getActiveMCPToolNames()).toEqual([selectedTool, discoveredTool]);
		expect(harness.session.getSelectedMCPToolNames()).toEqual([selectedTool, discoveredTool]);
		expect(harness.session.buildDisplaySessionContext().selectedMCPToolNames).toEqual([selectedTool, discoveredTool]);
	});

	it("keeps late default MCP tools active when goal creation is pending", async () => {
		await harness.cleanup();
		harness = await createGoalHarness({ mcpDiscoveryEnabled: true });
		const defaultTool = "mcp__demo_default";
		await harness.session.replaceNamedCustomTools([], [createMCPTool(defaultTool, "default")], {
			activateNewTools: false,
		});
		const createGoalStarted = Promise.withResolvers<void>();
		const finishGoalCreation = Promise.withResolvers<void>();
		const originalCreateGoal = harness.session.goalRuntime.createGoal.bind(harness.session.goalRuntime);
		vi.spyOn(harness.session.goalRuntime, "createGoal").mockImplementation(async (...args) => {
			const state = await originalCreateGoal(...args);
			createGoalStarted.resolve();
			await finishGoalCreation.promise;
			return state;
		});

		const entering = harness.mode.goalModeController.handleCommand("Ship the release");
		await createGoalStarted.promise;
		await harness.session.activateDiscoveredTools([defaultTool], { persistMCPSelection: false });
		finishGoalCreation.resolve();
		await entering;

		expect(harness.session.getActiveMCPToolNames()).toEqual([defaultTool]);
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);
		expect(harness.session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
		await harness.mode.goalModeController.exit();
		expect(harness.session.getActiveMCPToolNames()).toEqual([defaultTool]);
	});

	it("retries goal entry after an MCP catalog change during its prompt rebuild", async () => {
		await harness.cleanup();
		const goalRebuildStarted = Promise.withResolvers<void>();
		const releaseGoalRebuild = Promise.withResolvers<void>();
		let blockGoalRebuild = true;
		harness = await createGoalHarness({
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (blockGoalRebuild && toolNames.includes("goal")) {
					blockGoalRebuild = false;
					goalRebuildStarted.resolve();
					await releaseGoalRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});

		const entering = harness.mode.goalModeController.handleCommand("Ship the release");
		await goalRebuildStarted.promise;
		const defaultTool = "mcp__demo_default";
		await harness.session.replaceNamedCustomTools([], [createMCPTool(defaultTool, "default")], {
			activateNewTools: false,
		});
		await harness.session.activateDiscoveredTools([defaultTool], { persistMCPSelection: false });
		releaseGoalRebuild.resolve();
		await entering;

		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.session.getActiveMCPToolNames()).toEqual([defaultTool]);
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);
		expect(harness.session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
	});

	it("drops a newly created goal and releases the mode gate when tool activation fails", async () => {
		await harness.cleanup();
		harness = await createGoalHarness({ mcpDiscoveryEnabled: true });
		const originalSetActiveToolsByName = harness.session.setActiveToolsByName.bind(harness.session);
		const setActiveToolsByName = vi.spyOn(harness.session, "setActiveToolsByName");
		setActiveToolsByName.mockImplementation(async (toolNames, options) => {
			if (toolNames.includes("goal")) throw new Error("goal selection failed");
			await originalSetActiveToolsByName(toolNames, options);
		});

		await expect(harness.mode.goalModeController.enter({ objective: "Ship the release" })).rejects.toThrow(
			"goal selection failed",
		);
		setActiveToolsByName.mockRestore();

		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.mode.goalModeController.enabled).toBe(false);
		expect(harness.mode.goalModeController.paused).toBe(false);
		await harness.mode.planModeController.enter();
		expect(harness.mode.planModeController.enabled).toBe(true);
	});

	it("restores a paused goal when resume tool activation fails", async () => {
		await harness.cleanup();
		harness = await createGoalHarness({ mcpDiscoveryEnabled: true });
		const originalState = await harness.session.goalRuntime.createGoal({ objective: "Ship the release" });
		await harness.session.goalRuntime.pauseGoal();
		const originalSetActiveToolsByName = harness.session.setActiveToolsByName.bind(harness.session);
		const setActiveToolsByName = vi.spyOn(harness.session, "setActiveToolsByName");
		setActiveToolsByName.mockImplementation(async (toolNames, options) => {
			if (toolNames.includes("goal")) throw new Error("goal selection failed");
			await originalSetActiveToolsByName(toolNames, options);
		});

		await expect(harness.mode.goalModeController.enter({ resume: true })).rejects.toThrow("goal selection failed");
		setActiveToolsByName.mockRestore();

		expect(harness.session.getGoalModeState()).toMatchObject({
			enabled: false,
			goal: { id: originalState.goal.id, status: "paused" },
		});
		expect(harness.mode.goalModeController.enabled).toBe(false);
		expect(harness.mode.goalModeController.paused).toBe(true);
		await harness.session.goalRuntime.dropGoal();
		await harness.mode.goalModeController.exit({ reason: "dropped" });
		expect(harness.session.getGoalModeState()).toBeUndefined();
		await harness.mode.planModeController.enter();
		expect(harness.mode.planModeController.enabled).toBe(true);
	});

	it("keeps pending goal activation outside MCP selection authority", async () => {
		await harness.cleanup();
		harness = await createGoalHarness({ mcpDiscoveryEnabled: true });
		const defaultTool = "mcp__demo_default";
		await harness.session.replaceNamedCustomTools([], [createMCPTool(defaultTool, "default")], {
			activateNewTools: false,
		});
		const sessionManager = harness.session.sessionManager;
		await writePendingGoalModeRequest({
			cwd: sessionManager.getCwd(),
			objective: "Ship the release",
			goalsPath: "goals.json",
			sessionId: sessionManager.getSessionId(),
		});
		const setActiveToolsByName = vi.spyOn(harness.session, "setActiveToolsByName");
		const createGoalStarted = Promise.withResolvers<void>();
		const finishGoalCreation = Promise.withResolvers<void>();
		const originalCreateGoal = harness.session.goalRuntime.createGoal.bind(harness.session.goalRuntime);
		vi.spyOn(harness.session.goalRuntime, "createGoal").mockImplementation(async (...args) => {
			const state = await originalCreateGoal(...args);
			createGoalStarted.resolve();
			await finishGoalCreation.promise;
			return state;
		});
		harness.session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "call-bash-success",
			toolName: "bash",
			isError: false,
			result: { content: [] },
		} as never);
		await createGoalStarted.promise;
		await harness.session.activateDiscoveredTools([defaultTool], { persistMCPSelection: false });
		finishGoalCreation.resolve();
		const deadline = Date.now() + 5_000;
		while (setActiveToolsByName.mock.calls.length === 0) {
			if (Date.now() >= deadline) throw new Error("pending goal activation did not finish");
			await Bun.sleep(10);
		}

		expect(setActiveToolsByName).toHaveBeenCalledWith(expect.arrayContaining(["goal"]), {
			explicit: false,
			persistMCPSelection: false,
			retryOnMcpCatalogChange: true,
		});
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);
		expect(harness.session.getActiveMCPToolNames()).toEqual([defaultTool]);
		expect(harness.session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
	});

	it("drops a pending goal and releases the mode gate when tool selection supersedes activation", async () => {
		await harness.cleanup();
		const goalRebuildStarted = Promise.withResolvers<void>();
		const releaseGoalRebuild = Promise.withResolvers<void>();
		let blockGoalRebuild = true;
		harness = await createGoalHarness({
			rebuildSystemPrompt: async toolNames => {
				if (blockGoalRebuild && toolNames.includes("goal")) {
					blockGoalRebuild = false;
					goalRebuildStarted.resolve();
					await releaseGoalRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		const sessionManager = harness.session.sessionManager;
		await writePendingGoalModeRequest({
			cwd: sessionManager.getCwd(),
			objective: "Ship the release",
			goalsPath: "goals.json",
			sessionId: sessionManager.getSessionId(),
		});
		const activationFailure = Promise.withResolvers<unknown>();
		const originalSetActiveToolsByName = harness.session.setActiveToolsByName.bind(harness.session);
		const setActiveToolsByName = vi.spyOn(harness.session, "setActiveToolsByName");
		setActiveToolsByName.mockImplementation(async (toolNames, options) => {
			try {
				await originalSetActiveToolsByName(toolNames, options);
			} catch (error) {
				if (toolNames.includes("goal")) activationFailure.resolve(error);
				throw error;
			}
		});
		const goalDropFinished = Promise.withResolvers<void>();
		const originalDropGoal = harness.session.goalRuntime.dropGoal.bind(harness.session.goalRuntime);
		vi.spyOn(harness.session.goalRuntime, "dropGoal").mockImplementation(async () => {
			const state = await originalDropGoal();
			goalDropFinished.resolve();
			return state;
		});

		harness.session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "call-bash-success",
			toolName: "bash",
			isError: false,
			result: { content: [] },
		} as never);
		try {
			await goalRebuildStarted.promise;
			// Re-selecting the current tool list still fences the pending implicit swap.
			const explicitSelection = harness.session.setActiveToolsByName(["read"]);
			releaseGoalRebuild.resolve();
			await explicitSelection;
			expect(await activationFailure.promise).toBeInstanceOf(Error);
			await goalDropFinished.promise;
		} finally {
			releaseGoalRebuild.resolve();
		}

		setActiveToolsByName.mockRestore();
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.mode.goalModeController.enabled).toBe(false);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		await harness.mode.planModeController.enter();
		expect(harness.mode.planModeController.enabled).toBe(true);
	});

	it("retries pending goal activation after an MCP catalog change during its prompt rebuild", async () => {
		await harness.cleanup();
		const goalRebuildStarted = Promise.withResolvers<void>();
		const releaseGoalRebuild = Promise.withResolvers<void>();
		let blockGoalRebuild = true;
		harness = await createGoalHarness({
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (blockGoalRebuild && toolNames.includes("goal")) {
					blockGoalRebuild = false;
					goalRebuildStarted.resolve();
					await releaseGoalRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		const sessionManager = harness.session.sessionManager;
		await writePendingGoalModeRequest({
			cwd: sessionManager.getCwd(),
			objective: "Ship the release",
			goalsPath: "goals.json",
			sessionId: sessionManager.getSessionId(),
		});
		const goalActivationFinished = Promise.withResolvers<void>();
		const originalSetActiveToolsByName = harness.session.setActiveToolsByName.bind(harness.session);
		const setActiveToolsByName = vi.spyOn(harness.session, "setActiveToolsByName");
		setActiveToolsByName.mockImplementation(async (toolNames, options) => {
			await originalSetActiveToolsByName(toolNames, options);
			if (toolNames.includes("goal")) goalActivationFinished.resolve();
		});

		harness.session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "call-bash-success",
			toolName: "bash",
			isError: false,
			result: { content: [] },
		} as never);
		await goalRebuildStarted.promise;
		const defaultTool = "mcp__demo_default";
		await harness.session.replaceNamedCustomTools([], [createMCPTool(defaultTool, "default")], {
			activateNewTools: false,
		});
		await harness.session.activateDiscoveredTools([defaultTool], { persistMCPSelection: false });
		releaseGoalRebuild.resolve();
		await goalActivationFinished.promise;

		expect(setActiveToolsByName).toHaveBeenCalledWith(expect.arrayContaining(["goal"]), {
			explicit: false,
			persistMCPSelection: false,
			retryOnMcpCatalogChange: true,
		});
		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.session.getActiveMCPToolNames()).toEqual([defaultTool]);
		expect(harness.session.hasMCPToolSelectionAuthority()).toBe(false);
		expect(harness.session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
	});

	it("replaces the active goal via /goal set", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		const originalGoal = harness.session.getGoalModeState()?.goal;
		if (!originalGoal) throw new Error("expected active goal");

		await harness.mode.goalModeController.handleCommand("set Replace the objective");

		const state = harness.session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.objective).toBe("Replace the objective");
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.id).not.toBe(originalGoal.id);
		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("refuses /goal while plan mode is active", async () => {
		const showWarning = vi.spyOn(harness.mode, "showWarning");
		harness.mode.planModeController.setEnabledForCompatibility(true);

		await harness.mode.goalModeController.handleCommand("Ship the release");

		expect(showWarning).toHaveBeenCalledWith("Exit plan mode first.");
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	it("refuses /plan while goal mode is active", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.planModeController.handleCommand();

		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeController.enabled).toBe(false);
	});

	it("refuses /plan after a goal tool creates an active goal", async () => {
		await harness.mode.init();
		harness.mode.ui.stop();
		const goalTool = new GoalTool(harness.toolSession);
		await goalTool.execute("call-create", { op: "create", objective: "Tool-created goal" });
		await harness.session.waitForIdle();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.planModeController.handleCommand();

		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeController.enabled).toBe(false);
	});

	it("rejects a new /goal objective while paused", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.goalModeController.handleCommand();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.goalModeController.handleCommand("Replace the objective");

		expect(showWarning).toHaveBeenCalledWith(
			"Resume the current goal first, or drop it before setting a new objective.",
		);
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("resumes the paused goal via the bare /goal menu", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.goalModeController.handleCommand();
		expect(harness.mode.goalModeController.paused).toBe(true);
		selector.mockResolvedValueOnce("Resume");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.goalModeController.handleCommand();

		expect(showStatus).toHaveBeenCalledWith("Goal mode resumed.");
		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(harness.mode.goalModeController.paused).toBe(false);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("arms the active goal tool after gjc ultragoal create-goals succeeds", async () => {
		const cliPath = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
		const result = await harness.session.executeBash(
			`bun ${JSON.stringify(cliPath)} ultragoal create-goals --brief "Complete ultragoal regression"`,
		);

		expect(result.exitCode).toBe(0);
		expect(harness.session.getGoalModeState()?.goal.objective).toContain(".gjc/ultragoal/goals.json");
		expect(harness.session.getActiveToolNames()).toContain("goal");
	}, 15_000);

	it("treats budget as objective text instead of a goal budget command", async () => {
		await harness.mode.goalModeController.handleCommand("budget 123");

		const goal = harness.session.getGoalModeState()?.goal;
		expect(goal?.objective).toBe("budget 123");
		expect("tokenBudget" in (goal ?? {})).toBe(false);
	});

	it("keeps the goal tool in the active set after goal({op:drop})", async () => {
		await harness.mode.goalModeController.handleCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const goalTool = harness.session.getToolByName("goal");
		if (!goalTool) throw new Error("goal tool not registered");
		await goalTool.execute("call-id", { op: "drop" });

		// Runtime drop wipes host state and emits a goal_updated event. The mode
		// subscriber that handles dropped→#exitGoalMode is wired by mode.init(),
		// which the harness does not call (avoids TUI startup). AC10 below covers
		// the UI-path that bypasses the subscriber via #confirmAndDropGoal.
		// Here we verify the runtime-side invariants: state is cleared and the
		// `goal` tool remains in the raw active set (no side-effect deregistered it).
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toContain("goal");
	});

	it("keeps the goal tool in the active set when goal({op:complete}) flows through getUserInput", async () => {
		await harness.mode.goalModeController.handleCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const goalTool = harness.session.getToolByName("goal");
		if (!goalTool) throw new Error("goal tool not registered");
		await goalTool.execute("call-id", { op: "complete" });

		// completeGoalFromTool sets state.mode="exiting". The deferred completed-exit
		// runs at the next getUserInput() (interactive-mode.ts:623-625) BEFORE the
		// promise awaits the input callback, so we drain state, then resolve the
		// input callback to release the promise.
		const nextTurn = harness.mode.getUserInput();
		for (let i = 0; i < 100 && harness.session.getGoalModeState() !== undefined; i++) {
			await Bun.sleep(0);
		}
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
		await nextTurn;

		expect(harness.session.getActiveToolNames()).toContain("goal");
	});

	it("supports create A → drop → create B → get in one session", async () => {
		await harness.mode.goalModeController.handleCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const goalTool = harness.session.getToolByName("goal");
		if (!goalTool) throw new Error("goal tool not registered");

		await goalTool.execute("call-1", { op: "drop" });
		// Runtime drop wipes host state and emits goal_updated. The session
		// subscriber that would route this to mode is wired by mode.init().
		// For the round-trip we verify what the runtime guarantees: drop clears
		// state, create after dropped succeeds, and the goal tool remains
		// callable throughout (the bug being fixed was a side-effect on the
		// active tool set; in this harness setup the set is only mutated by
		// #enterGoalMode, so seeing "goal" still present is the AC).
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toContain("goal");

		await goalTool.execute("call-2", { op: "create", objective: "objective B" });
		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("objective B");

		const getResult = await goalTool.execute("call-3", { op: "get" });
		expect((getResult as any).details?.goal?.objective).toBe("objective B");
	});

	it("keeps the goal tool armed after /goal drop (UI path)", async () => {
		await harness.mode.goalModeController.handleCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		// The UI path invokes #confirmAndDropGoal which calls #exitGoalMode
		// directly (not via the goal_updated subscriber), so the mode-side
		// invariant is observable even without mode.init().
		vi.spyOn(harness.mode, "showHookConfirm").mockResolvedValue(true);

		await harness.mode.goalModeController.handleCommand("drop");
		for (let i = 0; i < 100 && harness.mode.goalModeController.enabled; i++) {
			await Bun.sleep(0);
		}

		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.mode.goalModeController.enabled).toBe(false);
	});

	it("returns completion usage from the goal tool and exits goal mode before the next turn rebuild", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		const appendCustomEntry = vi.spyOn(harness.session.sessionManager, "appendCustomEntry");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-1", { op: "complete" });
		const completionText = JSON.stringify(result.content);

		expect(result.details).not.toHaveProperty("completionBudgetReport");
		expect(completionText.toLowerCase()).not.toContain("budget");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);

		const nextTurn = harness.mode.getUserInput();
		for (let i = 0; i < 100 && harness.session.getGoalModeState() !== undefined; i++) {
			await Bun.sleep(0);
		}
		expect(harness.mode.goalModeController.enabled).toBe(false);
		expect(harness.mode.goalModeController.paused).toBe(false);
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);
		expect(
			appendCustomEntry.mock.calls.some(call => {
				const payload = call[1];
				return typeof payload === "object" && payload !== null && "tokenBudget" in payload;
			}),
		).toBe(false);
		expect(appendCustomEntry).toHaveBeenCalledWith(
			"goal-completed",
			expect.objectContaining({
				objective: "Ship the release",
				tokensUsed: 0,
			}),
		);

		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
		await nextTurn;
	});

	it("completes goal state even when a goal_updated extension hook throws", async () => {
		await harness.cleanup();
		const extensionError = new TypeError(
			'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined',
		);
		const emit = vi.fn(
			async (event: { type: string; goal?: { status?: string } | null; state?: { mode?: string } }) => {
				if (event.type === "goal_updated") throw extensionError;
			},
		);
		harness = await createGoalHarness({
			extensionRunner: { emit, getRegisteredCommands: () => [] } as unknown as ExtensionRunner,
		});
		await harness.mode.goalModeController.handleCommand("Ship the release");

		const tool = new GoalTool(harness.toolSession);
		const result = await tool.execute("call-complete", { op: "complete" });

		expect(result.details).toMatchObject({ op: "complete" });
		expect(result.details?.goal?.status).toBe("complete");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("complete");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		const goalUpdates = emit.mock.calls.map(([event]) => event).filter(event => event.type === "goal_updated");
		expect(goalUpdates.length).toBeGreaterThan(0);
		const terminalUpdate = goalUpdates[goalUpdates.length - 1];
		expect(terminalUpdate?.goal?.status).toBe("complete");
		expect(terminalUpdate?.state?.mode).toBe("exiting");
	});

	it("does not loop AgentBusyError when a busy/orphaned session triggers goal continuation", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(harness.session.goalRuntime.buildContinuationPrompt()).toBeTruthy();

		// Simulate a wedged/orphaned turn: the interactive loop is back at
		// getUserInput() but the session still reports busy (isStreaming stuck true).
		harness.session.agent.state.isStreaming = true;

		const startPending = vi.spyOn(harness.mode, "startPendingSubmission");

		vi.useFakeTimers();
		try {
			// getUserInput() arms the 800ms goal-continuation timer.
			void harness.mode.getUserInput();

			// While the session is busy, the continuation must never fire prompt()
			// (which throws AgentBusyError and spams "Error: Agent is already
			// processing…"). Advancing past several 800ms windows must not produce a
			// single continuation submission.
			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(800);
			}
			const busyCalls = startPending.mock.calls.filter(call => call[0]?.customType === "goal-continuation");
			expect(busyCalls.length).toBe(0);

			// Once the session returns to idle, the re-armed continuation fires.
			harness.session.agent.state.isStreaming = false;
			vi.advanceTimersByTime(800);
			const idleCalls = startPending.mock.calls.filter(call => call[0]?.customType === "goal-continuation");
			expect(idleCalls.length).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it("does not loop AgentBusyError while compaction is in progress", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(harness.session.goalRuntime.buildContinuationPrompt()).toBeTruthy();

		// Compaction keeps the session busy without necessarily setting isStreaming.
		// The continuation timer can fire mid-compaction; prompt() would then throw
		// AgentBusyError and loop the same way the orphan-subagent wedge does.
		let compacting = true;
		Object.defineProperty(harness.session, "isCompacting", {
			configurable: true,
			get: () => compacting,
		});

		const startPending = vi.spyOn(harness.mode, "startPendingSubmission");

		vi.useFakeTimers();
		try {
			void harness.mode.getUserInput();

			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(800);
			}
			const compactingCalls = startPending.mock.calls.filter(call => call[0]?.customType === "goal-continuation");
			expect(compactingCalls.length).toBe(0);

			// Compaction finished: the re-armed continuation fires.
			compacting = false;
			vi.advanceTimersByTime(800);
			const afterCompactionCalls = startPending.mock.calls.filter(
				call => call[0]?.customType === "goal-continuation",
			);
			expect(afterCompactionCalls.length).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
