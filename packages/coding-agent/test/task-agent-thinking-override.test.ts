import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { AsyncJobManager } from "../src/async";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import * as repositoryBindingModule from "../src/gjc-runtime/repository-binding";
import { TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import * as executorModule from "../src/task/executor";
import type { AgentDefinition, SingleResult } from "../src/task/types";
import type { ToolSession } from "../src/tools";

function makeResult(agent: string): SingleResult {
	return {
		index: 0,
		id: "ThinkingProbe",
		agent,
		agentSource: "bundled",
		task: "Probe thinking propagation.",
		assignment: "Probe thinking propagation.",
		description: "Thinking probe",
		exitCode: 0,
		output: "OK",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
	};
}

function createSession(settings: Settings): ToolSession {
	return {
		cwd: "/repo",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "omlx/Qwen3.6-35B-A3B-4bit",
		getModelString: () => "omlx/Qwen3.6-35B-A3B-4bit",
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		} as unknown as ModelRegistry,
	} as unknown as ToolSession;
}

async function captureExecutorOptions(agent: AgentDefinition): Promise<executorModule.ExecutorOptions> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
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
	const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult(agent.name));
	const settings = Settings.isolated({
		"async.enabled": true,
		"task.isolation.mode": "off",
		"task.agentModelOverrides": {
			[agent.name]: "omlx/Qwen3.6-35B-A3B-4bit:high",
		},
	});
	const jobs = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(jobs);
	const tool = await TaskTool.create(createSession(settings));

	const started = await tool.execute("tool-call", {
		agent: agent.name,
		tasks: [{ id: "ThinkingProbe", description: "Thinking probe", assignment: "Probe thinking propagation." }],
	});
	expect(started.details?.async?.jobId).toBeDefined();
	await jobs.waitForAll();
	await jobs.dispose({ timeoutMs: 100 });

	expect(runSubprocess).toHaveBeenCalledTimes(1);
	return runSubprocess.mock.calls[0]![0];
}

describe("task agent thinking override propagation", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
	});

	it("uses the model selector effort when agent frontmatter omits thinkingLevel", async () => {
		const options = await captureExecutorOptions({
			name: "executor",
			description: "test executor",
			systemPrompt: "test",
			source: "bundled",
		});

		expect(options.modelOverride).toEqual(["omlx/Qwen3.6-35B-A3B-4bit:high"]);
		expect(options.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("keeps agent frontmatter authoritative over the model selector effort", async () => {
		const options = await captureExecutorOptions({
			name: "planner",
			description: "test planner",
			systemPrompt: "test",
			source: "bundled",
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(options.modelOverride).toEqual(["omlx/Qwen3.6-35B-A3B-4bit:high"]);
		expect(options.thinkingLevel).toBe(ThinkingLevel.Low);
	});
});
