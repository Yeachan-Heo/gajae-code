import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Message, Model } from "@gajae-code/ai";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { parseAgentFields } from "../src/discovery/helpers";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/sdk";
import * as sdkModule from "../src/sdk";
import type { AgentSession, AgentSessionEvent, ForkContextSeed } from "../src/session/agent-session";
import { TaskTool } from "../src/task";
import { getBundledAgent } from "../src/task/agents";
import * as discoveryModule from "../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../src/task/types";
import { getTaskSchema, taskSchema } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { EventBus } from "../src/utils/event-bus";

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function createAssistantStopMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as Message[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		state,
		agent: { state: { systemPrompt: ["child-system"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages.at(-1),
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSession(
	overrides: Partial<Record<string, unknown>> = {},
	buildForkContextSeed?: ToolSession["buildForkContextSeed"],
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, ...overrides }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		model: { contextWindow: 1_000 } as Model,
		buildForkContextSeed,
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		},
	} as unknown as ToolSession;
}

function mockAgents(agents: AgentDefinition[]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function createAgent(name: string, forkContext?: AgentDefinition["forkContext"]): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `${name} system prompt`,
		source: "bundled",
		tools: ["read"],
		...(forkContext ? { forkContext } : {}),
	};
}

function mockCreateAgentSession(): { getOptions: () => CreateAgentSessionOptions | undefined } {
	let capturedOptions: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedOptions = options;
		return {
			session: createYieldingSession(),
			extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	return { getOptions: () => capturedOptions };
}

async function executeDetached(tool: TaskTool, params: TaskParams): Promise<void> {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	await tool.execute("tool-call", params);
	await manager.waitForAll();
	await manager.dispose({ timeoutMs: 100 });
}

function createSeed(text = "seed"): ForkContextSeed {
	const message: Message = {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp: 1,
	};
	return {
		messages: [message],
		agentMessages: [message],
		metadata: {
			sourceSessionId: "parent-session",
			parentMessageCount: 1,
			includedMessages: 1,
			skippedMessages: 0,
			approximateTokens: 1,
			maxMessages: 50,
			maxTokens: 250,
			skippedReasons: {},
		},
		cacheIdentity: "parent-cache-id",
	};
}

describe("fork context policy surface", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
	});

	test("parses allowed forkContext frontmatter", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			forkContext: "allowed",
		});

		expect(fields).toBeDefined();
		expect(fields?.forkContext).toBe("allowed");
	});

	test("parses forbidden forkContext frontmatter", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			forkContext: "forbidden",
		});

		expect(fields).toBeDefined();
		expect(fields?.forkContext).toBe("forbidden");
	});

	test("ignores invalid forkContext frontmatter", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			forkContext: "required",
		});

		expect(fields).toBeDefined();
		expect(fields?.forkContext).toBeUndefined();
	});

	test("accepts inheritContext enum modes and rejects booleans or unknown strings", () => {
		const result = taskSchema.safeParse({
			agent: "executor",
			context: "shared context",
			tasks: [
				{
					id: "ForkSeed",
					description: "seed context",
					assignment: "Use inherited context.",
					inheritContext: "bounded",
				},
			],
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.tasks[0]?.inheritContext).toBe("bounded");
		}

		for (const mode of ["none", "receipt", "last-turn", "bounded", "full"] as const) {
			const modeResult = taskSchema.safeParse({
				agent: "executor",
				tasks: [{ id: `Fork${mode.replace("-", "")}`, description: "d", assignment: "a", inheritContext: mode }],
			});
			expect(modeResult.success).toBe(true);
		}

		expect(
			taskSchema.safeParse({
				agent: "executor",
				tasks: [{ id: "BoolFork", description: "d", assignment: "a", inheritContext: true }],
			}).success,
		).toBe(false);
		expect(
			taskSchema.safeParse({
				agent: "executor",
				tasks: [{ id: "BadFork", description: "d", assignment: "a", inheritContext: "wide" }],
			}).success,
		).toBe(false);
	});

	test("independent task schema rejects inherited parent context", () => {
		const independentSchema = getTaskSchema({ isolationEnabled: true, simpleMode: "independent" });

		expect(
			independentSchema.safeParse({
				agent: "executor",
				tasks: [{ id: "ForkSeed", description: "d", assignment: "a", inheritContext: "bounded" }],
			}).success,
		).toBe(false);
		expect(
			independentSchema.safeParse({
				agent: "executor",
				tasks: [{ id: "NoFork", description: "d", assignment: "a", inheritContext: "none" }],
			}).success,
		).toBe(true);
	});

	test("rejects inherited context before scheduling when the global gate is disabled", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": false }));
		let registered = 0;
		AsyncJobManager.setInstance({ register: () => `${++registered}` } as unknown as AsyncJobManager);

		const result = await tool.execute("tool-call", {
			agent: "executor",
			tasks: [{ id: "ForkSeed", description: "seed", assignment: "Use context.", inheritContext: "bounded" }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("task.forkContext.enabled is false");
		expect(registered).toBe(0);
	});

	test("rejects inherited context before scheduling in independent simple mode", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seedBuilder = vi.fn(async () => createSeed());
		const tool = await TaskTool.create(
			createSession({ "task.simple": "independent", "task.forkContext.enabled": true }, seedBuilder),
		);
		let registered = 0;
		AsyncJobManager.setInstance({ register: () => `${++registered}` } as unknown as AsyncJobManager);

		const result = await tool.execute("tool-call", {
			agent: "executor",
			tasks: [{ id: "ForkSeed", description: "seed", assignment: "Use context.", inheritContext: "bounded" }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("task.simple is set to independent");
		expect(getFirstText(result)).toContain("inheritContext for task(s) ForkSeed");
		expect(result.details?.results).toEqual([]);
		expect(seedBuilder).not.toHaveBeenCalled();
		expect(registered).toBe(0);
	});

	test("rejects inherited context before scheduling when the agent does not allow it", async () => {
		mockAgents([createAgent("executor")]);
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }));
		let registered = 0;
		AsyncJobManager.setInstance({ register: () => `${++registered}` } as unknown as AsyncJobManager);

		const result = await tool.execute("tool-call", {
			agent: "executor",
			tasks: [{ id: "ForkSeed", description: "seed", assignment: "Use context.", inheritContext: "bounded" }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("does not declare forkContext: allowed");
		expect(registered).toBe(0);
	});

	test("rejects runtime inheritContext boolean true before scheduling", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seedBuilder = vi.fn(async () => createSeed());
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));
		let registered = 0;
		AsyncJobManager.setInstance({ register: () => `${++registered}` } as unknown as AsyncJobManager);

		const result = await tool.execute("tool-call", {
			agent: "executor",
			tasks: [{ id: "BoolFork", description: "seed", assignment: "Use context.", inheritContext: true }],
		} as unknown as TaskParams);

		expect(getFirstText(result)).toContain("Invalid inheritContext for task(s) BoolFork");
		expect(getFirstText(result)).toContain("Allowed modes: none, receipt, last-turn, bounded, full");
		expect(result.details?.results).toEqual([]);
		expect(seedBuilder).not.toHaveBeenCalled();
		expect(registered).toBe(0);
	});

	test("rejects runtime inheritContext unknown string before scheduling", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seedBuilder = vi.fn(async () => createSeed());
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));
		let registered = 0;
		AsyncJobManager.setInstance({ register: () => `${++registered}` } as unknown as AsyncJobManager);

		const result = await tool.execute("tool-call", {
			agent: "executor",
			tasks: [{ id: "GarbageFork", description: "seed", assignment: "Use context.", inheritContext: "garbage" }],
		} as unknown as TaskParams);

		expect(getFirstText(result)).toContain("Invalid inheritContext for task(s) GarbageFork");
		expect(getFirstText(result)).toContain("Allowed modes: none, receipt, last-turn, bounded, full");
		expect(result.details?.results).toEqual([]);
		expect(seedBuilder).not.toHaveBeenCalled();
		expect(registered).toBe(0);
	});

	test("does not build or pass a seed when inheritContext is absent", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seedBuilder = vi.fn(async () => createSeed());
		const { getOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));

		await executeDetached(tool, {
			agent: "executor",
			tasks: [{ id: "NoFork", description: "seed", assignment: "Work without inherited context." }],
		});

		expect(seedBuilder).not.toHaveBeenCalled();
		expect(getOptions()?.forkContextSeed).toBeUndefined();
	});

	test("does not build or pass a seed when inheritContext is none", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seedBuilder = vi.fn(async () => createSeed());
		const { getOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));

		await executeDetached(tool, {
			agent: "executor",
			tasks: [
				{
					id: "NoFork",
					description: "seed",
					assignment: "Work without inherited context.",
					inheritContext: "none",
				},
			],
		});

		expect(seedBuilder).not.toHaveBeenCalled();
		expect(getOptions()?.forkContextSeed).toBeUndefined();
	});

	test("passes a sanitized fork seed and cache identity without sharing provider state", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seed = createSeed();
		const seedBuilder = vi.fn(async () => seed);
		const { getOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));

		await executeDetached(tool, {
			agent: "executor",
			tasks: [
				{ id: "ForkSeed", description: "seed", assignment: "Use inherited context.", inheritContext: "bounded" },
			],
		});

		expect(seedBuilder).toHaveBeenCalledWith({ maxMessages: 50, maxTokens: 250, signal: undefined });
		expect(getOptions()?.forkContextSeed).toBe(seed);
		expect(getOptions()?.providerSessionId).toBeUndefined();
		expect(getOptions()?.providerSessionState).toBeUndefined();
		expect(getOptions()?.toolNames).toEqual(["read"]);
		const systemPromptOption = getOptions()?.systemPrompt;
		const renderedPrompt =
			typeof systemPromptOption === "function" ? systemPromptOption(["base", "tail"]) : systemPromptOption;
		expect(renderedPrompt?.join("\n")).toContain("executor system prompt");
		expect(renderedPrompt?.join("\n")).toContain("forked snapshot of the parent conversation");
	});

	test("uses configured maxMessages to cap bounded fork-context seeds", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seed = createSeed();
		const seedBuilder = vi.fn(async () => seed);
		const tool = await TaskTool.create(
			createSession({ "task.forkContext.enabled": true, "task.forkContext.maxMessages": 3 }, seedBuilder),
		);

		await executeDetached(tool, {
			agent: "executor",
			tasks: [
				{
					id: "BoundedForkSeed",
					description: "seed",
					assignment: "Use bounded context.",
					inheritContext: "bounded",
				},
			],
		});

		expect(seedBuilder).toHaveBeenCalledWith({ maxMessages: 3, maxTokens: 250, signal: undefined });
	});

	test("uses reduced model-window fallback for full fork-context seeds", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seed = createSeed();
		const seedBuilder = vi.fn(async () => seed);
		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));

		await executeDetached(tool, {
			agent: "executor",
			tasks: [{ id: "FullForkSeed", description: "seed", assignment: "Use full context.", inheritContext: "full" }],
		});

		expect(seedBuilder).toHaveBeenCalledWith({ maxMessages: 500, maxTokens: 150, signal: undefined });
	});

	test("uses configured maxMessages to cap full fork-context seeds", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seed = createSeed();
		const seedBuilder = vi.fn(async () => seed);
		const tool = await TaskTool.create(
			createSession({ "task.forkContext.enabled": true, "task.forkContext.maxMessages": 7 }, seedBuilder),
		);

		await executeDetached(tool, {
			agent: "executor",
			tasks: [{ id: "FullForkSeed", description: "seed", assignment: "Use full context.", inheritContext: "full" }],
		});

		expect(seedBuilder).toHaveBeenCalledWith({ maxMessages: 7, maxTokens: 150, signal: undefined });
	});

	test("freezes inherited context seeds before detached job execution", async () => {
		mockAgents([createAgent("executor", "allowed")]);
		const seedAtDispatch = createSeed("dispatch seed");
		const laterSeed = createSeed("later seed");
		const seedBuilder = vi.fn(async () => seedAtDispatch);
		const { getOptions } = mockCreateAgentSession();
		let capturedRun:
			| ((ctx: {
					jobId: string;
					signal: AbortSignal;
					reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
			  }) => Promise<string>)
			| undefined;
		AsyncJobManager.setInstance({
			register: (_type: "bash" | "task", _label: string, run: NonNullable<typeof capturedRun>) => {
				capturedRun = run;
				return "job-frozen-seed";
			},
		} as unknown as AsyncJobManager);

		const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));
		await tool.execute("tool-call", {
			agent: "executor",
			tasks: [
				{ id: "ForkSeed", description: "seed", assignment: "Use inherited context.", inheritContext: "bounded" },
			],
		} as TaskParams);

		expect(seedBuilder).toHaveBeenCalledTimes(1);
		expect(getOptions()).toBeUndefined();
		seedBuilder.mockResolvedValue(laterSeed);
		await capturedRun?.({
			jobId: "job-frozen-seed",
			signal: new AbortController().signal,
			reportProgress: async () => {},
		});

		expect(seedBuilder).toHaveBeenCalledTimes(1);
		expect(getOptions()?.forkContextSeed).toBe(seedAtDispatch);
	});

	test("bundled executor and architect agents default to forkContext: allowed", () => {
		expect(getBundledAgent("executor")?.forkContext).toBe("allowed");
		expect(getBundledAgent("architect")?.forkContext).toBe("allowed");
	});

	test("taskSchema preserves inheritContext: undefined when omitted", () => {
		const result = taskSchema.safeParse({
			agent: "executor",
			tasks: [{ id: "NoFork", description: "d", assignment: "a" }],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.tasks[0]?.inheritContext).toBeUndefined();
		}
	});

	test("bundled executor routes inheritContext through the per-agent gate", async () => {
		const bundledExecutor = getBundledAgent("executor");
		expect(bundledExecutor).toBeDefined();
		expect(bundledExecutor!.forkContext).toBe("allowed");
		mockAgents([bundledExecutor!]);

		{
			const seedBuilder = vi.fn(async () => createSeed());
			const { getOptions } = mockCreateAgentSession();
			const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));
			await executeDetached(tool, {
				agent: "executor",
				tasks: [{ id: "NoFork", description: "d", assignment: "a" }],
			});
			expect(seedBuilder).not.toHaveBeenCalled();
			expect(getOptions()?.forkContextSeed).toBeUndefined();
		}

		{
			const seedBuilder = vi.fn(async () => createSeed());
			const { getOptions } = mockCreateAgentSession();
			const tool = await TaskTool.create(createSession({ "task.forkContext.enabled": true }, seedBuilder));
			await executeDetached(tool, {
				agent: "executor",
				tasks: [{ id: "Fork", description: "d", assignment: "a", inheritContext: "bounded" }],
			});
			expect(seedBuilder).toHaveBeenCalledTimes(1);
			expect(getOptions()?.forkContextSeed).toBeDefined();
		}
	});
});
