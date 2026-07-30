import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@gajae-code/ai/utils/schema";
import { validateToolArguments } from "@gajae-code/ai/utils/validation";
import { AsyncJobManager, type AsyncJobRegisterOptions } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import { getTaskSchema, type TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
	{
		name: "reviewer",
		description: "Reviewer task agent",
		systemPrompt: "You are a reviewer.",
		source: "bundled" as const,
		blocking: true,
	},
];
const COMPLETE_SPAWN_PLAN = {
	whyParallel: "Independent test tasks can run together.",
	whyNotLocal: "Serial local execution would waste coordination time.",
	independence: "Each task has disjoint acceptance criteria.",
	expectedReceiptShape: "Each task returns a concise receipt.",
	maxInlineTokens: 1000,
};
type CapturedRegister = {
	type: "bash" | "task";
	label: string;
	options?: AsyncJobRegisterOptions;
};

function createSession(
	settingsOverrides: Partial<Record<string, unknown>> = {},
	sessionOverrides: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(settingsOverrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...sessionOverrides,
	} as unknown as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const wire = toolWireSchema(tool) as { properties?: Record<string, unknown> };
	return wire.properties ?? {};
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task.simple", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	it("removes only the custom schema input in schema-free mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "task.simple": "schema-free" }));
		const properties = getSchemaProperties(tool);

		expect(properties.context).toBeDefined();
		expect(properties.schema).toBeUndefined();
		expect(tool.description).toContain("`context` or `assignment`");
		expect(tool.description).toContain("- `context`:");
		expect(tool.description).not.toContain("- `schema`:");
	});

	it("removes both context and schema inputs in independent mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "task.simple": "independent" }));
		const properties = getSchemaProperties(tool);

		expect(properties.context).toBeUndefined();
		expect(properties.schema).toBeUndefined();
		expect(tool.description).toContain("each `assignment`");
		expect(tool.description).not.toContain("- `context`:");
		expect(tool.description).not.toContain("- `schema`:");
	});

	it("keeps spawnPlan available in every simple mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		for (const mode of ["default", "schema-free", "independent"] as const) {
			const tool = await TaskTool.create(createSession({ "task.simple": mode }));
			const properties = getSchemaProperties(tool);
			expect(properties.spawnPlan).toBeDefined();
		}
	});
	it("documents explicit worktree requests as the durable worktree field, not PAL isolation", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "task.isolation.mode": "auto" }));

		expect(tool.description).toContain(
			'REQUIRED when the user explicitly requests a worktree (for example, "use worktree")',
		);
		expect(tool.description).toContain("real persistent git worktree, identical to what `gjc --worktree` creates");
		expect(tool.description).toContain("mutually exclusive with `isolated`");
		expect(tool.description).toContain("This is NOT a git worktree");
	});

	it("exposes the durable worktree field in every schema variant, including with isolation disabled", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		for (const mode of ["default", "schema-free", "independent"]) {
			for (const isolationMode of ["auto", "none"]) {
				const tool = await TaskTool.create(
					createSession({ "task.simple": mode, "task.isolation.mode": isolationMode }),
				);
				const properties = getSchemaProperties(tool);
				// The durable worktree path is the counterpart of `gjc --worktree`, not a PAL backend, so it
				// must stay reachable even when task isolation is disabled.
				expect(properties.worktree).toBeDefined();
				expect(Boolean(properties.isolated)).toBe(isolationMode !== "none");
			}
		}
	});

	it("rejects a durable worktree request combined with isolated before spawning any subagent", async () => {
		const discover = vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const tool = await TaskTool.create(createSession({ "task.isolation.mode": "auto" }));
		discover.mockClear();

		const result = await tool.execute("tool-worktree-isolated", {
			agent: "task",
			worktree: true,
			isolated: true,
			tasks: [{ id: "T1", description: "d", assignment: "a" }],
		} as unknown as TaskParams);

		expect(getFirstText(result)).toContain("mutually exclusive");
		expect(result.details?.results ?? []).toHaveLength(0);
	});

	it("rejects a durable worktree request with more than one task before spawning any subagent", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const tool = await TaskTool.create(createSession({ "task.isolation.mode": "none" }));

		const result = await tool.execute("tool-worktree-multitask", {
			agent: "task",
			worktree: true,
			tasks: [
				{ id: "T1", description: "d", assignment: "a" },
				{ id: "T2", description: "d", assignment: "a" },
			],
		} as unknown as TaskParams);

		expect(getFirstText(result)).toContain("requires exactly one task");
		expect(result.details?.results ?? []).toHaveLength(0);
	});

	it("rejects a blank durable worktree branch name instead of silently detaching", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const tool = await TaskTool.create(createSession({ "task.isolation.mode": "none" }));

		// A blank name must never quietly become a detached worktree: that is a different identity
		// than the caller asked for.
		const result = await tool.execute("tool-worktree-blank", {
			agent: "task",
			worktree: "   ",
			tasks: [{ id: "T1", description: "d", assignment: "a" }],
		} as unknown as TaskParams);

		expect(getFirstText(result)).toContain("blank branch name");
		expect(result.details?.results ?? []).toHaveLength(0);

		// The declared parameter schema rejects blank names too, before the tool is even reached.
		const schema = getTaskSchema({ isolationEnabled: false, simpleMode: "default" });
		const base = { agent: "task", tasks: [{ id: "T1", description: "d", assignment: "a" }] };
		expect(schema.safeParse({ ...base, worktree: "   " }).success).toBe(false);
		expect(schema.safeParse({ ...base, worktree: "" }).success).toBe(false);
		expect(schema.safeParse({ ...base, worktree: false }).success).toBe(false);
		expect(schema.safeParse({ ...base, worktree: "feature/ok" }).success).toBe(true);
		expect(schema.safeParse({ ...base, worktree: true }).success).toBe(true);
	});
	it("hides IRC guidance when the IRC tool is not available", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "irc.enabled": true }, { getToolByName: () => undefined }));

		expect(tool.description).not.toContain("Coordinate with running tasks via `irc`");
		expect(tool.description).not.toContain("via the `irc` tool");
		expect(tool.description).toContain("Use `subagent` action `inspect` or `list`");
	});

	it("shows IRC guidance when the IRC tool is available", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(
			createSession(
				{ "irc.enabled": true },
				{ getToolByName: name => (name === "irc" ? ({ name: "irc" } as never) : undefined) },
			),
		);

		expect(tool.description).toContain("Coordinate with running tasks via `irc`");
		expect(tool.description).toContain("via the `irc` tool");
		expect(tool.description).not.toContain("Use `subagent` action `inspect` or `list`");
	});

	it("omits IRC launch hints when tool lookup metadata is missing", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const captured: CapturedRegister[] = [];
		const manager = {
			register: (
				type: "bash" | "task",
				label: string,
				_run: (ctx: {
					jobId: string;
					signal: AbortSignal;
					reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
				}) => Promise<string>,
				options?: AsyncJobRegisterOptions,
			): string => {
				captured.push({ type, label, options });
				return options?.id ?? label;
			},
		};
		AsyncJobManager.setInstance(manager as unknown as AsyncJobManager);

		const tool = await TaskTool.create(createSession({ "irc.enabled": true }));
		const result = await tool.execute("tool-no-irc", {
			agent: "task",
			tasks: [{ id: "One", description: "label", assignment: "Do work." }],
		} as TaskParams);

		expect(captured).toHaveLength(1);
		const text = getFirstText(result);
		expect(text).not.toContain("DM these ids via `irc`");
		expect(text).toContain("Use `subagent` to list, inspect, or await");
	});

	it("rejects a five-task batch before scheduling without spawnPlan", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const captured: CapturedRegister[] = [];
		const manager = {
			register: (
				type: "bash" | "task",
				label: string,
				_run: (ctx: {
					jobId: string;
					signal: AbortSignal;
					reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
				}) => Promise<string>,
				options?: AsyncJobRegisterOptions,
			): string => {
				captured.push({ type, label, options });
				return options?.id ?? label;
			},
		};
		AsyncJobManager.setInstance(manager as unknown as AsyncJobManager);

		const tool = await TaskTool.create(createSession());
		const tasks = Array.from({ length: 5 }, (_, index) => ({
			id: `Task${index}`,
			description: `label ${index}`,
			assignment: `Do work ${index}.`,
		}));
		const result = await tool.execute("tool-gated", { agent: "task", tasks } as TaskParams);

		expect(captured).toHaveLength(0);
		expect(result.details?.results).toEqual([]);
		expect(getFirstText(result)).toContain("Task spawn gate rejected this batch");
	});
	it("allows a five-task batch with complete spawnPlan to schedule", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const captured: CapturedRegister[] = [];
		const manager = {
			register: (
				type: "bash" | "task",
				label: string,
				_run: (ctx: {
					jobId: string;
					signal: AbortSignal;
					reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
				}) => Promise<string>,
				options?: AsyncJobRegisterOptions,
			): string => {
				captured.push({ type, label, options });
				return options?.id ?? label;
			},
		};
		AsyncJobManager.setInstance(manager as unknown as AsyncJobManager);

		const tool = await TaskTool.create(createSession());
		const tasks = Array.from({ length: 5 }, (_, index) => ({
			id: `Task${index}`,
			description: `label ${index}`,
			assignment: `Do work ${index}.`,
		}));
		const result = await tool.execute("tool-allowed", {
			agent: "task",
			tasks,
			spawnPlan: COMPLETE_SPAWN_PLAN,
		} as TaskParams);

		expect(captured).toHaveLength(5);
		expect(getFirstText(result)).toContain("Started 5 background task jobs");
	});
	it("rejects direct schema and context fields when the mode disables them", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const schemaFreeTool = await TaskTool.create(createSession({ "task.simple": "schema-free" }));
		const schemaFreeResult = await schemaFreeTool.execute("tool-1", {
			agent: "task",
			schema: '{"properties":{"ok":{"type":"boolean"}}}',
			tasks: [{ id: "One", description: "label", assignment: "Do the thing." }],
		} as TaskParams);
		expect(getFirstText(schemaFreeResult)).toContain("does not accept `schema`");
		const validatedSchemaFreeParams = validateToolArguments(schemaFreeTool, {
			type: "toolCall",
			id: "tool-1-validated",
			name: schemaFreeTool.name,
			arguments: {
				agent: "task",
				schema: '{"properties":{"ok":{"type":"boolean"}}}',
				tasks: [{ id: "One", description: "label", assignment: "Do the thing." }],
			},
		});
		const validatedSchemaFreeResult = await schemaFreeTool.execute("tool-1-validated", validatedSchemaFreeParams);
		expect(getFirstText(validatedSchemaFreeResult)).toContain("does not accept `schema`");

		const independentTool = await TaskTool.create(createSession({ "task.simple": "independent" }));
		const independentResult = await independentTool.execute("tool-2", {
			agent: "task",
			context: "Shared background",
			tasks: [{ id: "Two", description: "label", assignment: "Do the independent thing." }],
		} as TaskParams);
		expect(getFirstText(independentResult)).toContain("does not accept `context`");
		const validatedIndependentParams = validateToolArguments(independentTool, {
			type: "toolCall",
			id: "tool-2-validated",
			name: independentTool.name,
			arguments: {
				agent: "task",
				context: "Shared background",
				tasks: [{ id: "Two", description: "label", assignment: "Do the independent thing." }],
			},
		});
		const validatedIndependentResult = await independentTool.execute("tool-2-validated", validatedIndependentParams);
		expect(getFirstText(validatedIndependentResult)).toContain("does not accept `context`");
	});

	it("launches task subagents detached even when async.enabled is false or the agent has blocking metadata", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});
		const captured: CapturedRegister[] = [];
		const manager = {
			register: (
				type: "bash" | "task",
				label: string,
				_run: (ctx: {
					jobId: string;
					signal: AbortSignal;
					reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
				}) => Promise<string>,
				options?: AsyncJobRegisterOptions,
			): string => {
				captured.push({ type, label, options });
				return options?.id ?? label;
			},
		};
		AsyncJobManager.setInstance(manager as unknown as AsyncJobManager);

		const tool = await TaskTool.create(createSession({ "async.enabled": false }));
		const result = await tool.execute("tool-detached", {
			agent: "task",
			tasks: [{ id: "One", description: "label", assignment: "Do detached work." }],
		} as TaskParams);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.type).toBe("task");
		expect(captured[0]?.options?.metadata?.subagent).toMatchObject({
			agent: "task",
			agentSource: "bundled",
			description: "label",
			assignment: "Do detached work.",
		});
		expect(result.details?.async?.state).toBe("running");
		expect(getFirstText(result)).toContain("Started 1 background task job");
		expect(getFirstText(result)).toContain("`subagent`");

		const blockingResult = await tool.execute("tool-detached-blocking", {
			agent: "reviewer",
			tasks: [{ id: "Two", description: "review label", assignment: "Review detached work." }],
		} as TaskParams);

		expect(captured).toHaveLength(2);
		expect(captured[1]?.type).toBe("task");
		expect(captured[1]?.options?.metadata?.subagent).toMatchObject({
			agent: "reviewer",
			agentSource: "bundled",
			description: "review label",
			assignment: "Review detached work.",
		});
		expect(blockingResult.details?.async?.state).toBe("running");
	});
});
