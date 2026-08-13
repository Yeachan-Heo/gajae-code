import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import * as repositoryBindingModule from "../../src/gjc-runtime/repository-binding";
import type { MCPManager } from "../../src/runtime-mcp/manager";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const AGENT: AgentDefinition = {
	name: "planner",
	description: "test planner",
	systemPrompt: "test",
	source: "bundled",
};

function makeResult(): SingleResult {
	return {
		index: 0,
		id: "McpProbe",
		agent: "planner",
		agentSource: "bundled",
		task: "Probe MCP inheritance.",
		assignment: "Probe MCP inheritance.",
		description: "MCP probe",
		exitCode: 0,
		output: "OK",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
	};
}

function createSession(manager: MCPManager): ToolSession {
	return {
		cwd: "/repo",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "off",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getMcpManager: () => manager,
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		} as unknown as ModelRegistry,
	} as unknown as ToolSession;
}

async function runTask(manager: MCPManager): Promise<Parameters<typeof executorModule.runSubprocess>[0]> {
	const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult());
	const tool = await TaskTool.create(createSession(manager));
	const jobs = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(jobs);

	const started = await tool.execute("tool-call", {
		agent: "planner",
		tasks: [{ id: "McpProbe", description: "MCP probe", assignment: "Probe MCP inheritance." }],
	});
	expect(started.details?.async?.jobId).toBeDefined();
	await jobs.waitForAll();
	await jobs.dispose({ timeoutMs: 100 });

	expect(runSubprocess).toHaveBeenCalledTimes(1);
	return runSubprocess.mock.calls[0]![0];
}

describe("task MCP inheritance", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
	});

	it("does not pass a tools-only parent manager into a sub-session", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		vi.spyOn(repositoryBindingModule, "resolveTaskRepositoryBinding").mockResolvedValue({
			schema: "gjc.repository_binding.v1",
			worktreeRoot: "/repo",
			commonDir: null,
			displayPath: "/repo",
		});
		vi.spyOn(repositoryBindingModule, "assertExecutionRootMatchesRepositoryBinding").mockResolvedValue({
			schema: "gjc.repository_binding.v1",
			worktreeRoot: "/repo",
			commonDir: null,
			displayPath: "/repo",
		});
		const toolsOnlyManager = { isToolsOnly: () => true } as unknown as MCPManager;

		const options = await runTask(toolsOnlyManager);

		expect(options.parentMcpManager).toBeUndefined();
	});

	it("continues to pass a reusable parent manager into a sub-session", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		vi.spyOn(repositoryBindingModule, "resolveTaskRepositoryBinding").mockResolvedValue({
			schema: "gjc.repository_binding.v1",
			worktreeRoot: "/repo",
			commonDir: null,
			displayPath: "/repo",
		});
		vi.spyOn(repositoryBindingModule, "assertExecutionRootMatchesRepositoryBinding").mockResolvedValue({
			schema: "gjc.repository_binding.v1",
			worktreeRoot: "/repo",
			commonDir: null,
			displayPath: "/repo",
		});
		const reusableManager = { isToolsOnly: () => false } as unknown as MCPManager;

		const options = await runTask(reusableManager);

		expect(options.parentMcpManager).toBe(reusableManager);
	});
});
