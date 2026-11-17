import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import fc from "fast-check";
import { AsyncJobManager } from "../src/async";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import type { runSubprocess } from "../src/task/executor";
import type { SingleResult } from "../src/task/types";
import type { ToolSession } from "../src/tools";

const parentModel = "anthropic/claude-sonnet-5";
const userExecutor = "anthropic/claude-haiku-4-5";
const repositoryExecutor = "ollama/evil-model";

const executorAgent = {
	name: "executor",
	description: "executor",
	systemPrompt: "executor",
	source: "bundled" as const,
};

function session(settings: Settings): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => parentModel,
		modelRegistry: {
			getAvailable: () => [],
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		},
	} as unknown as ToolSession;
}

async function loadScope(
	globalSettings: Record<string, unknown>,
	projectSettings: Record<string, unknown>,
): Promise<{ settings: Settings; remove: () => void }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-model-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(globalSettings, null, 2));
	await Bun.write(path.join(getProjectAgentDir(projectDir), "config.yml"), YAML.stringify(projectSettings, null, 2));
	const settings = await Settings.loadForScope({ cwd: projectDir, agentDir });
	return {
		settings,
		remove: () => {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

async function captureExecutorModel(settings: Settings): Promise<string | string[] | undefined> {
	AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [executorAgent],
		projectAgentsDir: null,
	});
	const captured: Array<string | string[] | undefined> = [];
	const stub: typeof runSubprocess = async options => {
		captured.push(options.modelOverride);
		return {
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: options.task,
			assignment: options.assignment,
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 1,
			modelOverride: options.modelOverride,
		} as SingleResult;
	};
	const tool = await TaskTool.create(session(settings), { runSubprocess: stub });
	const result = await tool.execute("executor-model", {
		agent: "executor",
		tasks: [{ id: "impl", description: "implement", assignment: "implement the change" }],
	} as never);
	await AsyncJobManager.instance()?.waitForAll();
	if (captured.length === 0) {
		throw new Error(`subprocess was not called: ${JSON.stringify(result).slice(0, 800)}`);
	}
	return captured[0];
}

describe("task tool repository agent model overrides", () => {
	const cleanups: Array<() => void> = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
		for (const cleanup of cleanups.splice(0)) cleanup();
		await resetSettingsForTest();
	});

	it("ignores a repository executor model override for the task tool", async () => {
		const loaded = await loadScope(
			{},
			{ task: { agentModelOverrides: { executor: repositoryExecutor }, eager: true } },
		);
		cleanups.push(loaded.remove);
		try {
			expect(loaded.settings.get("task.agentModelOverrides").executor).toBeUndefined();
			expect(await captureExecutorModel(loaded.settings)).toEqual([parentModel]);
		} finally {
			await loaded.settings.close();
		}
	});

	it("still allows a user global executor model override", async () => {
		const loaded = await loadScope(
			{ task: { agentModelOverrides: { executor: userExecutor } } },
			{ task: { eager: true } },
		);
		cleanups.push(loaded.remove);
		try {
			expect(loaded.settings.get("task.agentModelOverrides").executor).toBe(userExecutor);
			expect(await captureExecutorModel(loaded.settings)).toEqual([userExecutor]);
		} finally {
			await loaded.settings.close();
		}
	});

	it("still allows a user global executor override surrounded by whitespace", async () => {
		const loaded = await loadScope({ task: { agentModelOverrides: { executor: `  ${userExecutor}  ` } } }, {});
		cleanups.push(loaded.remove);
		try {
			expect(await captureExecutorModel(loaded.settings)).toEqual([userExecutor]);
		} finally {
			await loaded.settings.close();
		}
	});

	it("still allows a runtime executor model override over a repository file", async () => {
		const loaded = await loadScope({}, { task: { agentModelOverrides: { executor: repositoryExecutor } } });
		cleanups.push(loaded.remove);
		try {
			loaded.settings.override("task.agentModelOverrides", { executor: userExecutor });
			expect(loaded.settings.get("task.agentModelOverrides").executor).toBe(userExecutor);
			expect(await captureExecutorModel(loaded.settings)).toEqual([userExecutor]);
		} finally {
			await loaded.settings.close();
		}
	});

	it("still allows the parent session model when agent overrides are absent", async () => {
		const loaded = await loadScope({}, { task: { eager: false } });
		cleanups.push(loaded.remove);
		try {
			expect(await captureExecutorModel(loaded.settings)).toEqual([parentModel]);
		} finally {
			await loaded.settings.close();
		}
	});

	it("property: project model records stay independent of operator selection, seed 648, 64 inputs", async () => {
		const token = fc.string({
			unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
			minLength: 1,
			maxLength: 8,
		});
		const selector = fc.tuple(token, token).map(([provider, id]) => `${provider}/${id}`);
		const maybeSelector = fc.oneof(fc.constant(undefined), selector);
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					eager: fc.boolean(),
					role: fc.constantFrom("executor", "architect", "planner", "critic"),
					projectSelector: selector,
					globalSelector: maybeSelector,
					runtimeSelector: maybeSelector,
				}),
				async ({ eager, role, projectSelector, globalSelector, runtimeSelector }) => {
					const loaded = await loadScope(
						globalSelector ? { task: { agentModelOverrides: { [role]: globalSelector } } } : {},
						{
							task: {
								eager,
								agentModelOverrides: { [role]: projectSelector, planner: projectSelector },
							},
						},
					);
					cleanups.push(loaded.remove);
					try {
						if (runtimeSelector) {
							loaded.settings.override("task.agentModelOverrides", { [role]: runtimeSelector });
						}
						const effective = loaded.settings.get("task.agentModelOverrides");
						const operatorSelector = runtimeSelector ?? globalSelector;
						expect(effective[role] as string | undefined).toBe(operatorSelector);
						expect(effective.planner as string | undefined).toBe(
							role === "planner" ? operatorSelector : undefined,
						);
						expect(loaded.settings.get("task.eager")).toBe(eager);
					} finally {
						await loaded.settings.close();
					}
				},
			),
			{ seed: 648, numRuns: 64 },
		);
	});

	it("still allows a repository task.eager flag", async () => {
		const loaded = await loadScope(
			{},
			{ task: { eager: true, agentModelOverrides: { executor: repositoryExecutor } } },
		);
		cleanups.push(loaded.remove);
		try {
			expect(loaded.settings.get("task.eager")).toBe(true);
		} finally {
			await loaded.settings.close();
		}
	});
});
