import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@gajae-code/ai/utils/schema";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import type { runSubprocess } from "../src/task/executor";
import { buildTaskReceipt } from "../src/task/receipt";
import type { SingleResult, TaskRoutingEvidence } from "../src/task/types";
import type { ToolSession } from "../src/tools";

const agents = [
	{
		name: "task",
		description: "General task agent",
		systemPrompt: "task",
		source: "bundled" as const,
		model: ["manual/frontmatter"],
	},
];

function session(settingsOverrides: Record<string, unknown> = {}, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(settingsOverrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry: { getAvailable: () => [] } as never,
		...overrides,
	} as unknown as ToolSession;
}

describe("TaskTool autorouting integration surfaces", () => {
	const model = (provider: string, id: string) =>
		({
			provider,
			id,
			name: id,
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			contextWindow: 128000,
			maxTokens: 4096,
			input: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			headers: {},
			compat: {},
		}) as never;
	const manual = ["manual/one", "manual/two"];
	const registryModels = [
		model("anthropic", "claude-haiku-4-5"),
		model("anthropic", "claude-opus-5"),
		model("anthropic", "claude-sonnet-5"),
	];
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
	});

	it("exposes an additive tier parameter while disabled and omits routing guidance", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const tool = await TaskTool.create(session());
		expect(tool.description).not.toContain("<autorouting-guidance>");
		expect(toolWireSchema(tool)).toBeDefined();
	});

	it("activates guidance and accepts mixed tier task inputs", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const tool = await TaskTool.create(
			session({
				"task.autorouting.enabled": true,
				"task.autorouting.tiers": { fast: ["anthropic/claude-haiku-4-5"], strong: ["anthropic/claude-opus-5"] },
			}),
		);
		expect(tool.description).toContain("<autorouting-guidance>");
		expect(tool.description).toContain("fast");
		expect(tool.description).toContain("strong");
		const result = await tool.execute("integration-empty", {
			agent: "task",
			tasks: [
				{ id: "Fast", description: "fast", assignment: "lookup", tier: "fast" },
				{ id: "Strong", description: "strong", assignment: "design", tier: "strong" },
				{ id: "Default", description: "default", assignment: "implement" },
			],
		} as never);
		expect(result.content[0]?.type).toBe("text");
	});

	it("runtime overrides activate and clear autorouting without reload", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const settings = Settings.isolated({ "task.autorouting.enabled": true });
		const tool = await TaskTool.create(session({}, { settings }));
		expect(tool.description).not.toContain("<autorouting-guidance>");
		settings.override("task.autorouting.tiers", { balanced: ["vllm/local"] });
		expect(tool.description).toContain("<autorouting-guidance>");
		settings.clearOverride("task.autorouting.tiers");
		expect(tool.description).not.toContain("<autorouting-guidance>");
	});

	it("captures mixed-tier routed model overrides and exact normal note format", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const captured: Array<{ index?: number; modelOverride?: string | string[]; routing?: unknown }> = [];

		const stub = async (options: Parameters<typeof runSubprocess>[0]) => {
			captured.push({ index: options.index, modelOverride: options.modelOverride, routing: options.routing });
			return {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				description: options.description,
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 1,
				modelOverride: options.modelOverride,
				routing: options.routing,
			} as SingleResult;
		};
		const settings = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": {
				fast: ["anthropic/claude-haiku-4-5"],
				balanced: ["anthropic/claude-sonnet-5"],
				strong: ["anthropic/claude-opus-5"],
			},
			"task.agentModelOverrides": { task: ["manual/one", "manual/two"] },
		});
		const tool = await TaskTool.create(
			session({}, { settings, modelRegistry: { getAvailable: () => registryModels } as never }),
			{ runSubprocess: stub },
		);
		await tool.execute("mixed", {
			agent: "task",
			tasks: [
				{ id: "Fast", description: "fast", assignment: "a", tier: "fast" },
				{ id: "Strong", description: "strong", assignment: "b", tier: "strong" },
				{ id: "Default", description: "default", assignment: "c" },
			],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		expect(captured.some(item => (item.routing as { note?: string } | undefined)?.note === "fast")).toBe(true);
		expect(captured.some(item => (item.routing as { note?: string } | undefined)?.note === "strong")).toBe(true);
		expect(
			captured.some(item => (item.routing as { note?: string } | undefined)?.note === "balanced (default)"),
		).toBe(true);
	});

	it("keeps an unresolvable sibling on the manual chain with fallback evidence and note", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const captured: Array<{ index?: number; modelOverride?: string | string[]; routing?: unknown }> = [];

		const stub = async (options: Parameters<typeof runSubprocess>[0]) => {
			captured.push({ index: options.index, modelOverride: options.modelOverride, routing: options.routing });
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
				routing: options.routing,
			} as SingleResult;
		};
		const settings = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: ["missing/model"], balanced: ["anthropic/claude-sonnet-5"] },
			"task.agentModelOverrides": { task: manual },
		});
		const tool = await TaskTool.create(
			session({}, { settings, modelRegistry: { getAvailable: () => registryModels } as never }),
			{ runSubprocess: stub },
		);
		await tool.execute("fallback", {
			agent: "task",
			tasks: [
				{ id: "Bad", description: "bad", assignment: "a", tier: "fast" },
				{ id: "Good", description: "good", assignment: "b", tier: "balanced" },
			],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		const fallbackRouting = captured.find(
			item => (item.routing as { manualFallbackReason?: string } | undefined)?.manualFallbackReason,
		)?.routing as { note?: string } | undefined;
		expect(fallbackRouting?.note).toBe("fast; tier_unmatched");
	});

	it("bounds manual-fallback skip evidence before dispatch", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const captured: Array<{ routing?: TaskRoutingEvidence }> = [];
		const stub = async (options: Parameters<typeof runSubprocess>[0]) => {
			captured.push({ routing: options.routing });
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
				routing: options.routing,
			} as SingleResult;
		};
		const unavailable = Array.from({ length: 20 }, (_, index) => `missing/model-${index}`);
		AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
		const settings = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: unavailable },
			"task.agentModelOverrides": { task: manual },
		});
		const tool = await TaskTool.create(
			session({}, { settings, modelRegistry: { getAvailable: () => registryModels } as never }),
			{ runSubprocess: stub },
		);
		await tool.execute("bounded-fallback", {
			agent: "task",
			tasks: [{ id: "Fallback", description: "fallback", assignment: "a", tier: "fast" }],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		const routing = captured[0]?.routing;
		expect(routing?.manualFallbackReason).toBe("tier_unmatched");
		expect(routing?.skips).toHaveLength(16);
		expect(routing?.skips?.every(skip => skip.selector.length <= 256)).toBe(true);
		expect(routing?.omittedSkipCount).toBe(4);
		expect(routing?.omittedByCode).toEqual({ snapshot_missing: 4 });
	});
	it("disabled capture matches manual patterns and emits no routing", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const captured: Array<{ index?: number; modelOverride?: string | string[]; routing?: unknown }> = [];

		const stub = async (options: Parameters<typeof runSubprocess>[0]) => {
			captured.push({ index: options.index, modelOverride: options.modelOverride, routing: options.routing });
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
		const settings = Settings.isolated({ "task.agentModelOverrides": { task: manual } });
		const tool = await TaskTool.create(
			session({}, { settings, modelRegistry: { getAvailable: () => registryModels } as never }),
			{ runSubprocess: stub },
		);
		const result = await tool.execute("disabled", {
			agent: "task",
			tasks: [{ id: "One", description: "one", assignment: "a" }],
		} as never);
		expect(captured.length).toBeGreaterThanOrEqual(0);
		await AsyncJobManager.instance()!.waitForAll();
		expect(captured.find(item => item.index === 0)?.routing).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('"routing"');
	});
	it("disabled execution preserves the manual path and does not emit routing evidence", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const tool = await TaskTool.create(session());
		const result = await tool.execute("integration-no-tasks", { agent: "task", tasks: [] } as never);
		expect(result.content[0]?.type).toBe("text");
		expect(JSON.stringify(result)).not.toContain('"routing"');
	});
	it("registered resume runner recomputes a fresh route and marks freshOnResume", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const settings = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: ["anthropic/claude-haiku-4-5"] },
		});
		const captured: Array<{ runMode?: string; routing?: unknown; modelOverride?: string | string[] }> = [];
		const stub = async (options: Parameters<typeof runSubprocess>[0]) => {
			captured.push({ runMode: options.runMode, routing: options.routing, modelOverride: options.modelOverride });
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
				routing: options.routing,
			} as SingleResult;
		};
		const tool = await TaskTool.create(
			session({}, { settings, modelRegistry: { getAvailable: () => registryModels } as never }),
			{ runSubprocess: stub },
		);
		await tool.execute("resume-seed", {
			agent: "task",
			tasks: [{ id: "Resume", description: "resume", assignment: "run", tier: "fast" }],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		settings.override("task.autorouting.tiers", { fast: ["anthropic/claude-opus-5"] });
		const record = AsyncJobManager.instance()!.getSubagentRecords()[0];
		expect(record).toBeDefined();
		if (!record) return;
		expect(AsyncJobManager.instance()!.resumeSubagent(record.subagentId).ok).toBe(true);
		await AsyncJobManager.instance()!.waitForAll();
		expect(captured.at(-1)?.runMode).toBe("resume");
		expect(captured.at(-1)?.routing).toMatchObject({
			freshOnResume: true,
			effectiveModel: "anthropic/claude-opus-5",
		});
	});

	it("cancelled placeholders preserve routed synthetic evidence", () => {
		const synthetic = {
			tier: "fast",
			requestedSelector: "anthropic/claude-haiku-4-5",
			effectiveModel: undefined,
			notExecuted: true,
			substitutions: [],
			note: "fast; not-executed",
		};
		expect(synthetic.notExecuted).toBe(true);
		expect(synthetic.requestedSelector).not.toBe("manual-model-chain");
		expect(synthetic.tier).toBe("fast");
	});
});

describe("autorouting evidence receipt extensions", () => {
	it("retains bounded skip overflow accounting and terminal preflight evidence", () => {
		const raw = {
			index: 0,
			id: "Evidence",
			agent: "task",
			agentSource: "bundled" as const,
			task: "task",
			exitCode: 1,
			output: "",
			stderr: "preflight exhausted",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			routing: {
				tier: "balanced" as const,
				requestedSelector: "anthropic/model",
				notExecuted: true as const,
				substitutions: [],
				terminal: "preflight_exhausted" as const,
				skips: Array.from({ length: 16 }, (_, index) => ({
					selector: `provider/${index}`,
					code: "snapshot_missing" as const,
				})),
				omittedSkipCount: 2,
				omittedByCode: { snapshot_missing: 1, credential_unavailable: 1 },
			},
		} as SingleResult;
		const receipt = buildTaskReceipt(raw);
		expect(receipt.routing?.terminal).toBe("preflight_exhausted");
		expect(receipt.routing?.skips).toHaveLength(16);
		expect(receipt.routing?.omittedSkipCount).toBe(2);
	});
});
