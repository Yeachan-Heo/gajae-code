import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { normalizeTools } from "@gajae-code/agent-core";
import { validateToolArguments } from "@gajae-code/ai/core";
import { toolWireSchema } from "@gajae-code/ai/utils/schema";
import { isComputerLoadablePlatform, isComputerSupportedPlatform } from "./computer";
import {
	BUILTIN_TOOL_DESCRIPTORS,
	BUILTIN_TOOLS,
	HIDDEN_TOOL_DESCRIPTORS,
	HIDDEN_TOOLS,
	LazyAgentTool,
	resolveEffectiveDiscoveryMode,
	TOOL_DESCRIPTORS,
	type ToolAvailabilityContext,
	type ToolDescriptor,
} from "./descriptors";
import { computeEssentialBuiltinNames, createTools } from "./index";

const schema = { type: "object", properties: {} } as never;

function makeSession(overrides: Record<string, unknown> = {}): any {
	const values: Record<string, unknown> = {
		"tools.discoveryMode": "off",
		"mcp.discoveryMode": false,
		"eval.py": false,
		"eval.js": true,
		"goal.enabled": false,
		"lsp.enabled": true,
		"debug.enabled": false,
		"todo.enabled": true,
		"find.enabled": true,
		"search.enabled": true,
		"github.enabled": false,
		"astGrep.enabled": true,
		"astEdit.enabled": true,
		"renderMermaid.enabled": true,
		"web_search.enabled": true,
		"calc.enabled": true,
		"skill.enabled": true,
		"browser.enabled": true,
		"browser.backend": "native",
		"computer.enabled": true,
		"checkpoint.enabled": true,
		"irc.enabled": true,
		"recipe.enabled": true,
		"task.maxRecursionDepth": 2,
		...overrides,
	};
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => values[key],
			has: (key: string) => Object.hasOwn(values, key),
		},
		requireYieldTool: false,
		enableLsp: true,
		taskDepth: 0,
		rescopeSessionCwd: async () => ({ from: process.cwd(), to: process.cwd() }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function syntheticTool(execute: AgentTool["execute"] = async () => ({ content: [] })): AgentTool {
	return {
		name: "synthetic",
		label: "Synthetic",
		description: "synthetic description",
		parameters: schema,
		strict: true,
		summary: "synthetic summary",
		loadMode: "discoverable",
		execute,
	};
}

function availabilityContext(overrides: Partial<ToolAvailabilityContext> = {}): ToolAvailabilityContext {
	return {
		includeYield: false,
		enableLsp: true,
		goalEnabled: false,
		goalStateToolNames: [],
		allowEval: true,
		discoveryActive: false,
		...overrides,
	};
}

describe("tool descriptor compatibility gate", () => {
	test("registry preserves the legacy builtin and hidden insertion order", () => {
		const expectedBuiltin = [
			"read",
			"bash",
			"edit",
			"ast_grep",
			"ast_edit",
			"render_mermaid",
			"ask",
			"debug",
			"bisect",
			"eval",
			"python",
			"calc",
			"ssh",
			"github",
			"find",
			"search",
			"lsp",
			"browser",
			...(isComputerLoadablePlatform() ? ["computer"] : []),
			"checkpoint",
			"rewind",
			"task",
			"subagent",
			"job",
			"monitor",
			"cron",
			"recipe",
			"irc",
			"todo_write",
			"web_search",
			"search_tool_bm25",
			"skill_discovery",
			"telegram_send",
			"write",
			"skill",
			"goal",
			"move_session",
		];
		expect(Object.keys(BUILTIN_TOOLS)).toEqual(expectedBuiltin);
		expect(Object.keys(BUILTIN_TOOL_DESCRIPTORS)).toEqual(expectedBuiltin);
		expect(Object.keys(HIDDEN_TOOL_DESCRIPTORS)).toEqual(["yield", "report_finding", "resolve"]);
		expect(Object.keys(TOOL_DESCRIPTORS)).toEqual([...expectedBuiltin, "yield", "report_finding", "resolve"]);
		for (const [name, descriptor] of Object.entries(BUILTIN_TOOL_DESCRIPTORS)) {
			expect(BUILTIN_TOOLS[name]).toBe(descriptor.load);
		}
		for (const [name, descriptor] of Object.entries(HIDDEN_TOOL_DESCRIPTORS)) {
			expect(HIDDEN_TOOLS[name]).toBe(descriptor.load);
		}
	});

	test("createTools keeps legacy order and advertised schema bytes through the eager facade", async () => {
		const session = makeSession();
		const tools = await createTools(session, ["read", "write"]);
		const rawRead = await BUILTIN_TOOLS.read(session);
		const rawWrite = await BUILTIN_TOOLS.write(session);
		const rawResolve = await HIDDEN_TOOLS.resolve(session);
		const expected = [rawRead, rawWrite, rawResolve];
		expect(tools.map(tool => tool.name)).toEqual(["read", "write", "resolve"]);
		for (let index = 0; index < tools.length; index++) {
			const actual = tools[index];
			const raw = expected[index];
			if (!raw) throw new Error("expected raw tool");
			if (!(actual instanceof LazyAgentTool)) throw new Error("expected LazyAgentTool");
			expect(actual.name).toBe(raw.name);
			expect(actual.label).toBe(raw.label);
			expect(actual.description).toBe(raw.description);
			expect(JSON.stringify(actual.parameters)).toBe(JSON.stringify(raw.parameters));
		}
	});

	test("availability permutations cover discovery aliases, task depth, goal/resolve, and essential overrides", () => {
		const session = makeSession();
		const searchDescriptor = BUILTIN_TOOL_DESCRIPTORS.search_tool_bm25;
		for (const [toolsDiscoveryMode, mcpDiscoveryMode, expected] of [
			["off", false, false],
			["off", true, true],
			["mcp-only", false, true],
			["all", false, true],
		] as const) {
			const discoverySession = makeSession({
				"tools.discoveryMode": toolsDiscoveryMode,
				"mcp.discoveryMode": mcpDiscoveryMode,
			});
			expect(
				searchDescriptor.isAvailable(discoverySession, availabilityContext({ discoveryActive: expected })),
			).toBe(expected);
		}
		expect(BUILTIN_TOOL_DESCRIPTORS.goal.isAvailable(session, availabilityContext({ goalEnabled: false }))).toBe(
			false,
		);
		expect(BUILTIN_TOOL_DESCRIPTORS.goal.isAvailable(session, availabilityContext({ goalEnabled: true }))).toBe(true);
		expect(HIDDEN_TOOL_DESCRIPTORS.resolve.isAvailable(session, availabilityContext())).toBe(true);
		expect(
			BUILTIN_TOOL_DESCRIPTORS.task.isAvailable(makeSession({ "task.maxRecursionDepth": 0 }), availabilityContext()),
		).toBe(false);
		expect(
			BUILTIN_TOOL_DESCRIPTORS.task.isAvailable(
				makeSession({ "task.maxRecursionDepth": -1 }),
				availabilityContext(),
			),
		).toBe(true);
		expect(
			BUILTIN_TOOL_DESCRIPTORS.task.isAvailable(makeSession({ "task.maxRecursionDepth": 1 }), availabilityContext()),
		).toBe(true);
		expect(
			BUILTIN_TOOL_DESCRIPTORS.task.isAvailable(
				{ ...makeSession({ "task.maxRecursionDepth": 1 }), taskDepth: 1 },
				availabilityContext(),
			),
		).toBe(false);
		expect(computeEssentialBuiltinNames({ get: () => [] } as never)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"search",
			"find",
		]);
		expect(computeEssentialBuiltinNames({ get: () => ["read", "missing", "bash"] } as never)).toEqual([
			"read",
			"bash",
		]);
	});

	test("facade preserves advertised fields and delegates execution with the materialized this", async () => {
		const calls: unknown[] = [];
		const raw = syntheticTool(async function (this: AgentTool, _id, params) {
			calls.push(this.name, params);
			return { content: [] };
		});
		(raw as any).rawArgumentValidation = (args: Record<string, unknown>) => ({ outcome: "passthrough", args });
		(raw as any).customFormat = { syntax: "regex", definition: "x" };
		(raw as any).customWireName = "synthetic_wire";
		(raw as any).safeSummary = (_kind: "args" | "result", value: unknown) => String(value);
		(raw as any).safeSummaryFields = { args: ["value"], result: ["ok"] };
		(raw as any).hidden = true;
		(raw as any).deferrable = true;
		(raw as any).nonAbortable = true;
		(raw as any).concurrency = "exclusive";
		(raw as any).lenientArgValidation = true;
		(raw as any).intent = (args: { value?: number }) => String(args.value ?? 0);
		(raw as any).renderCall = () => "call";
		(raw as any).renderResult = () => "result";
		(raw as any).mergeCallAndResult = true;
		(raw as any).inline = true;
		(raw as any).mode = "hashline";
		const descriptor: ToolDescriptor = {
			metadata: { name: "synthetic", loadMode: "discoverable" },
			presentation: { label: "Synthetic", summary: "synthetic summary" },
			isAvailable: () => true,
			load: () => raw,
		};
		const facade = new LazyAgentTool(descriptor, raw);

		expect(facade.name).toBe(raw.name);
		expect(facade.label).toBe(raw.label);
		expect(facade.description).toBe(raw.description);
		expect(facade.parameters).toBe(raw.parameters);
		expect(facade.strict).toBe(raw.strict);
		expect(facade.summary).toBe(raw.summary);
		expect(facade.loadMode).toBe(raw.loadMode);
		expect(facade.customFormat).toBe(raw.customFormat);
		expect(facade.customWireName).toBe(raw.customWireName);
		expect(facade.safeSummary?.("args", 42)).toBe("42");
		expect(facade.safeSummaryFields).toBe(raw.safeSummaryFields);
		expect(facade.hidden).toBe(true);
		expect(facade.deferrable).toBe(true);
		expect(facade.nonAbortable).toBe(true);
		expect(facade.concurrency).toBe("exclusive");
		expect(facade.lenientArgValidation).toBe(true);
		expect(typeof facade.intent === "function" ? facade.intent({ value: 7 } as never) : undefined).toBe("7");
		expect(facade.renderCall?.({} as never, {} as never, {} as never)).toBe("call");
		expect(facade.renderResult?.({} as never, {} as never, {} as never)).toBe("result");
		expect(facade.mergeCallAndResult).toBe(true);
		expect(facade.inline).toBe(true);
		expect(facade.mode).toBe("hashline");
		expect(facade.descriptor).toBe(descriptor);
		await facade.execute("call", { value: 1 });
		expect(calls).toEqual(["synthetic", { value: 1 }]);
	});

	test("availability predicates retain every createTools settings branch", () => {
		const session = makeSession();
		const context = availabilityContext();
		// `ask`, `irc` and `github` need session capabilities the bare fixture never provides:
		// a UI or workflow gate, an agent registry, and an installed `gh`.
		const unavailableByDefault = new Set(["ask", "debug", "github", "irc", "search_tool_bm25", "goal"]);
		if (!isComputerSupportedPlatform()) unavailableByDefault.add("computer");
		if (process.env.CLAUDE_CODE_DISABLE_CRON === "1") unavailableByDefault.add("cron");
		for (const [name, descriptor] of Object.entries(BUILTIN_TOOL_DESCRIPTORS)) {
			expect(descriptor.isAvailable(session, context)).toBe(!unavailableByDefault.has(name));
		}

		const disabled = makeSession({
			"lsp.enabled": false,
			"find.enabled": false,
			"search.enabled": false,
			"astGrep.enabled": false,
			"astEdit.enabled": false,
			"renderMermaid.enabled": false,
			"web_search.enabled": false,
			"calc.enabled": false,
			"skill.enabled": false,
			"browser.enabled": false,
			"checkpoint.enabled": false,
			"irc.enabled": false,
			"recipe.enabled": false,
			"task.maxRecursionDepth": 0,
			"goal.enabled": true,
		});
		const disabledContext = availabilityContext({
			enableLsp: false,
			goalEnabled: true,
			discoveryActive: true,
		});
		for (const name of [
			"lsp",
			"find",
			"search",
			"ast_grep",
			"ast_edit",
			"render_mermaid",
			"web_search",
			"calc",
			"skill",
			"skill_discovery",
			"browser",
			"checkpoint",
			"rewind",
			"irc",
			"recipe",
			"task",
		])
			expect(BUILTIN_TOOL_DESCRIPTORS[name].isAvailable(disabled, disabledContext)).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.goal.isAvailable(disabled, disabledContext)).toBe(true);
		expect(BUILTIN_TOOL_DESCRIPTORS.search_tool_bm25.isAvailable(disabled, disabledContext)).toBe(true);

		const yieldContext = availabilityContext({ includeYield: true });
		expect(BUILTIN_TOOL_DESCRIPTORS.todo_write.isAvailable(session, yieldContext)).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.todo_write.isAvailable(session, context)).toBe(true);
		expect(BUILTIN_TOOL_DESCRIPTORS.eval.isAvailable(session, availabilityContext({ allowEval: false }))).toBe(false);
	});

	test("conditional descriptors mirror their factory guards", () => {
		const context = availabilityContext();
		const uiSession = makeSession();
		uiSession.hasUI = true;
		expect(BUILTIN_TOOL_DESCRIPTORS.ask.isAvailable(uiSession, context)).toBe(true);
		const gateSession = makeSession();
		gateSession.workflowGateEligible = true;
		expect(BUILTIN_TOOL_DESCRIPTORS.ask.isAvailable(gateSession, context)).toBe(true);
		const emitterSession = makeSession();
		emitterSession.getWorkflowGateEmitter = () => ({});
		expect(BUILTIN_TOOL_DESCRIPTORS.ask.isAvailable(emitterSession, context)).toBe(true);

		const ircSession = makeSession();
		ircSession.agentRegistry = {};
		ircSession.getAgentId = () => "agent";
		expect(BUILTIN_TOOL_DESCRIPTORS.irc.isAvailable(ircSession, context)).toBe(true);
		ircSession.getAgentId = undefined;
		expect(BUILTIN_TOOL_DESCRIPTORS.irc.isAvailable(ircSession, context)).toBe(false);

		const subagentSession = makeSession();
		subagentSession.taskDepth = 1;
		expect(BUILTIN_TOOL_DESCRIPTORS.checkpoint.isAvailable(subagentSession, context)).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.rewind.isAvailable(subagentSession, context)).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.checkpoint.isAvailable(makeSession(), context)).toBe(true);

		const cronSession = makeSession();
		const previous = process.env.CLAUDE_CODE_DISABLE_CRON;
		try {
			process.env.CLAUDE_CODE_DISABLE_CRON = "1";
			expect(BUILTIN_TOOL_DESCRIPTORS.cron.isAvailable(cronSession, context)).toBe(false);
			delete process.env.CLAUDE_CODE_DISABLE_CRON;
			expect(BUILTIN_TOOL_DESCRIPTORS.cron.isAvailable(cronSession, context)).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_CRON;
			else process.env.CLAUDE_CODE_DISABLE_CRON = previous;
		}
	});

	test("hides the built-in browser tool when Aside is the selected backend", () => {
		const context = availabilityContext();

		expect(BUILTIN_TOOL_DESCRIPTORS.browser.isAvailable(makeSession({ "browser.backend": "aside" }), context)).toBe(
			false,
		);
		expect(BUILTIN_TOOL_DESCRIPTORS.browser.isAvailable(makeSession({ "browser.backend": "native" }), context)).toBe(
			true,
		);
		expect(BUILTIN_TOOL_DESCRIPTORS.browser.isAvailable(makeSession({ "browser.backend": undefined }), context)).toBe(
			true,
		);
	});

	test("descriptor creation is side-effect free; materialization registers cleanup exactly once", () => {
		const cleanupCalls: Array<() => void> = [];
		let constructed = 0;
		const session = makeSession();
		session.registerSessionCleanup = (cleanup: () => void) => {
			cleanupCalls.push(cleanup);
			return cleanup;
		};
		const raw = syntheticTool();
		const descriptor: ToolDescriptor = {
			metadata: { name: "synthetic" },
			presentation: { label: "Synthetic" },
			isAvailable: () => true,
			load: loadedSession => {
				constructed++;
				loadedSession.registerSessionCleanup!(() => undefined);
				return raw;
			},
		};
		expect(constructed).toBe(0);
		expect(cleanupCalls).toHaveLength(0);
		const loaded = descriptor.load(session);
		expect(constructed).toBe(1);
		expect(cleanupCalls).toHaveLength(1);
		new LazyAgentTool(descriptor, loaded as AgentTool);
		expect(constructed).toBe(1);
		expect(cleanupCalls).toHaveLength(1);
	});

	test("load preserves throwing constructor error identity", () => {
		const expected = new Error("constructor failed");
		const descriptor: ToolDescriptor = {
			metadata: { name: "throwing" },
			presentation: { label: "Throwing" },
			isAvailable: () => true,
			load: () => {
				throw expected;
			},
		};
		let received: unknown;
		try {
			descriptor.load(makeSession());
		} catch (error) {
			received = error;
		}
		expect(received).toBe(expected);
		expect(received).toBeInstanceOf(Error);
		expect((received as Error).message).toBe(expected.message);
	});

	test("lazy advertised schema matches the eager wire schema", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		const descriptor = BUILTIN_TOOL_DESCRIPTORS.write;
		const eager = await descriptor.load(session);
		if (!eager) throw new Error("expected write tool");
		const lazyTools = await createTools(session);
		const lazy = lazyTools.find(tool => tool.name === "write");
		if (!lazy) throw new Error("expected lazy write tool");
		expect(lazy.parameters).toEqual(toolWireSchema(eager));
	});

	test("explicit MCP config keeps discovery active when tools discovery is off", async () => {
		const session = makeSession({ "tools.discoveryMode": "off" });
		session.mcpConfigPath = "/tmp/mcp.json";
		expect(resolveEffectiveDiscoveryMode(session.settings, session.mcpConfigPath)).toBe("mcp-only");
		const tools = await createTools(session);
		const write = tools.find(tool => tool.name === "write");
		if (!write) throw new Error("expected write tool");
		if (!(write instanceof LazyAgentTool)) throw new Error("expected LazyAgentTool");
		expect(write.descriptor.metadata.loadMode).toBe("discoverable");
		if (!write.descriptor.metadata.parameters) throw new Error("expected discoverable wire schema");
		expect(write.parameters).toEqual(write.descriptor.metadata.parameters);
	});
	test("deferred raw argument validators run before first implementation load", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		const tools = await createTools(session);
		const ask = tools.find(tool => tool.name === "ask");
		const todo = tools.find(tool => tool.name === "todo_write");
		if (!ask || !todo) throw new Error("expected deferred ask and todo_write tools");
		expect(typeof ask.rawArgumentValidation).toBe("function");
		expect(typeof todo.rawArgumentValidation).toBe("function");
		expect(() =>
			validateToolArguments(todo, {
				id: "call-1",
				type: "toolCall",
				name: "todo_write",
				arguments: { unknown: true },
			}),
		).toThrow("raw arguments rejected before coercion");
		expect(() =>
			validateToolArguments(ask, { id: "call-2", type: "toolCall", name: "ask", arguments: { unknown: true } }),
		).toThrow('Validation failed for tool "ask"');
	});

	test("deferred todo_write validator matches the loaded tool on every payload", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		const lazy = (await createTools(session)).find(tool => tool.name === "todo_write");
		const eager = await BUILTIN_TOOL_DESCRIPTORS.todo_write.load(session);
		if (!lazy?.rawArgumentValidation || !eager?.rawArgumentValidation)
			throw new Error("expected deferred and loaded todo_write validators");
		// A deferred rejection fires before the tool can load, so any divergence
		// fails a call the loaded tool would have accepted.
		const payloads: Array<Record<string, unknown>> = [
			{ ops: [{ op: "done", content: "ship it" }] },
			{ ops: [{ op: "complete", task: "ship it" }] },
			{ ops: [{ op: "completed", task: "ship it" }] },
			{ ops: [{ op: "complete" }] },
			{ ops: [{ op: "done" }] },
			{ ops: [{ op: "drop" }] },
			{ ops: [{ op: "done", task: "x", bogus: 1 }] },
			{ ops: [{ op: "init", list: [{ phase: "P", items: ["a"], bogus: 1 }] }] },
			{ ops: [{ op: "init", list: [{ phase: "P", items: ["a"] }] }] },
			{ ops: "not-an-array" },
			{ ops: [{ op: "done", task: "x" }], stray: true },
			{ _i: "Tracking progress", ops: [{ op: "done", task: "x" }] },
			{ ops: [{ op: "retitle", task: "x", newTask: "y" }] },
			{ ops: [{ op: "add", phase: "P", items: ["a"] }] },
		];
		for (const payload of payloads) {
			expect(lazy.rawArgumentValidation(payload)).toEqual(eager.rawArgumentValidation(payload));
		}
	});

	test("deferred todo_write rejections carry the correction code", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		const todo = (await createTools(session)).find(tool => tool.name === "todo_write");
		if (!todo) throw new Error("expected deferred todo_write tool");
		// Without a code the thrown message is a bare "rejected before coercion",
		// which gives the model nothing to correct and it retries the same shape.
		expect(() =>
			validateToolArguments(todo, {
				id: "call-code",
				type: "toolCall",
				name: "todo_write",
				arguments: { ops: [{ op: "done" }] },
			}),
		).toThrow("todo_write done and drop entries require a task or phase target");
	});

	test("deferred and loaded todo_write reject a bad payload with the same message", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		const lazy = (await createTools(session)).find(tool => tool.name === "todo_write");
		const eager = await BUILTIN_TOOL_DESCRIPTORS.todo_write.load(session);
		if (!lazy || !eager) throw new Error("expected deferred and loaded todo_write tools");
		const capture = (run: () => unknown): string => {
			try {
				run();
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			throw new Error("expected a raw-argument rejection");
		};
		const call = (arguments_: Record<string, unknown>) => ({
			id: "call-parity",
			type: "toolCall" as const,
			name: "todo_write",
			arguments: arguments_,
		});
		// The observed incident: four usable entries discarded alongside one
		// invented op. Whichever path runs first must say the same thing, or the
		// caller that hit the cold registry sees none of the added guidance.
		const invalidOp = call({
			ops: [
				{ op: "append", phase: "Work", items: ["ship it"] },
				{ op: "done", task: "first" },
				{ op: "done", task: "second" },
				{ op: "done", task: "third" },
				{ op: "retitle", task: "third", newTask: "fourth" },
			],
		});
		const lazyOpMessage = capture(() => validateToolArguments(lazy, invalidOp));
		expect(lazyOpMessage).toBe(capture(() => validateToolArguments(eager, invalidOp)));
		expect(lazyOpMessage).toContain("todo_write operation entries require a known op value");
		expect(lazyOpMessage).toContain("op must be one of: init, start, done, rm, drop, append, note");
		expect(lazyOpMessage).toContain("ops[4]");

		const unknownKey = call({
			ops: [
				{ op: "done", task: "x" },
				{ op: "done", task: "y", bogusOpKey: 1 },
			],
		});
		const lazyKeyMessage = capture(() => validateToolArguments(lazy, unknownKey));
		expect(lazyKeyMessage).toBe(capture(() => validateToolArguments(eager, unknownKey)));
		expect(lazyKeyMessage).toContain('rejected key: "bogusOpKey" (ops[1])');
	});

	test("deferred ask validator recovers the canonical round-zero pair", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		session.getDeepInterviewAskStage = () => "topology";
		const [ask] = (await createTools(session)).filter(tool => tool.name === "ask");
		if (!ask) throw new Error("expected deferred ask tool");
		const arguments_ = {
			questions: [
				{
					id: "round-0",
					question: "Confirm",
					options: [{ label: "Looks right" }, { label: "Approve" }],
					deepInterview: {
						round: 0,
						component: "review-topology",
						dimension: "topology",
						ambiguity: 1,
						intent_contract: {
							items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
							confirmation_options: ["Looks right"],
						},
						intent_review: {
							observed_items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
							supporting_substitutions: [],
							approval_options: ["Approve"],
						},
					},
				},
			],
		};
		const recovered = validateToolArguments(ask, {
			id: "call-3",
			type: "toolCall",
			name: "ask",
			arguments: arguments_,
		});
		expect(recovered.questions[0].deepInterview.intent_contract).toBeDefined();
		expect(recovered.questions[0].deepInterview.intent_review).toBeUndefined();
	});

	test("deferred ask rejects an incomplete Round-0 topology object with the targeted correction (#4649)", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		session.getDeepInterviewAskStage = () => "topology";
		const [ask] = (await createTools(session)).filter(tool => tool.name === "ask");
		if (!ask) throw new Error("expected deferred ask tool");
		// The incident shape: deepInterview present with Round-0 topology identity
		// but ambiguity and intent_contract omitted. The cold registry must reject
		// it with the same targeted correction as the loaded tool, not generic
		// pre-coercion validation errors.
		const incomplete = {
			questions: [
				{
					id: "round-0-topology",
					question: "I'm reading this as 2 top-level components. Does this match your intent?",
					options: [{ label: "Looks right" }, { label: "Revise" }],
					deepInterview: {
						round: 0,
						component: "review-topology",
						dimension: "topology",
					},
				},
			],
		};
		const capture = (): string => {
			try {
				validateToolArguments(ask, {
					id: "call-4649",
					type: "toolCall",
					name: "ask",
					arguments: incomplete,
				});
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			throw new Error("expected a raw-argument rejection");
		};
		const message = capture();
		expect(message).toContain("raw arguments rejected before coercion");
		expect(message).toContain("requires every topology field");
		expect(message).toContain('rejected keys: "deepInterview.ambiguity", "deepInterview.intent_contract"');
		expect(message).not.toContain("Received arguments:");

		// A complete Round-0 contract-only payload keeps validating unchanged.
		const complete = {
			questions: [
				{
					id: "round-0-topology",
					question: "Confirm",
					options: [{ label: "Looks right" }, { label: "Approve" }],
					deepInterview: {
						round: 0,
						component: "review-topology",
						dimension: "topology",
						ambiguity: 1,
						intent_contract: {
							items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
							confirmation_options: ["Looks right"],
						},
					},
				},
			],
		};
		const recovered = validateToolArguments(ask, {
			id: "call-4649-complete",
			type: "toolCall",
			name: "ask",
			arguments: complete,
		});
		expect(recovered.questions[0].deepInterview.intent_contract).toBeDefined();
	});

	test("deferred ask recovery tolerates the injected intent field at the root", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		session.getDeepInterviewAskStage = () => "topology";
		const [ask] = (await createTools(session)).filter(tool => tool.name === "ask");
		if (!ask) throw new Error("expected deferred ask tool");
		const question = {
			id: "round-0",
			question: "Confirm",
			options: [{ label: "Looks right" }, { label: "Approve" }],
			deepInterview: {
				round: 0,
				component: "review-topology",
				dimension: "topology",
				ambiguity: 1,
				intent_contract: {
					items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
					confirmation_options: ["Looks right"],
				},
				intent_review: {
					observed_items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
					supporting_substitutions: [],
					approval_options: ["Approve"],
				},
			},
		};
		// `_i` is the harness's own injected intent field; rejecting it fails an
		// otherwise canonical payload the model has no way to repair.
		const recovered = validateToolArguments(ask, {
			id: "call-intent",
			type: "toolCall",
			name: "ask",
			arguments: { _i: "Confirming topology", questions: [question] },
		});
		expect(recovered.questions[0].deepInterview.intent_contract).toBeDefined();
		expect(recovered.questions[0].deepInterview.intent_review).toBeUndefined();

		// A genuinely unknown root key must still be rejected.
		expect(() =>
			validateToolArguments(ask, {
				id: "call-intent-stray",
				type: "toolCall",
				name: "ask",
				arguments: { _i: "Confirming topology", stray: 1, questions: [question] },
			}),
		).toThrow('Validation failed for tool "ask"');
	});
	test("deferred ask validation matches eager AskTool on adversarial contracts", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		session.hasUI = true;
		session.workflowGateEligible = true;
		session.getDeepInterviewAskStage = () => "topology";
		const eager = await BUILTIN_TOOL_DESCRIPTORS.ask.load(session);
		const lazy = (await createTools(session)).find(tool => tool.name === "ask");
		if (!eager || !lazy) throw new Error("expected eager and deferred ask tools");
		const adversarial = [
			{ questions: [] },
			{
				questions: [{ id: "q", question: "q", options: [{ label: "yes" }], deepInterview: { arbitrary: true } }],
			},
			{
				questions: [
					{
						id: "q",
						question: "q",
						options: [{ label: "yes" }],
						workflowGate: { stage: "deep-interview", kind: "question", extra: true },
					},
				],
			},
			{
				questions: [
					{
						id: "round-0",
						question: "Confirm",
						options: [{ label: "Looks right" }, { label: "Approve" }],
						deepInterview: {
							round: 0,
							component: "review-topology",
							dimension: "topology",
							ambiguity: 1,
							intent_contract: {
								items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
								confirmation_options: ["Looks right"],
							},
							intent_review: {
								observed_items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
								supporting_substitutions: [
									{ removed_id: "artifact:report", replacement_ids: [], rationale: "bad" },
								],
								approval_options: ["Approve"],
							},
						},
					},
				],
			},
		];
		const rejected = (tool: AgentTool, arguments_: Record<string, unknown>): boolean => {
			try {
				validateToolArguments(tool, { id: "call-adv", type: "toolCall", name: "ask", arguments: arguments_ });
				return false;
			} catch {
				return true;
			}
		};
		for (const arguments_ of adversarial) expect(rejected(lazy, arguments_)).toBe(rejected(eager, arguments_));
	});
	test("deferred Ask advertises and parses the same stage schema as eager Ask", async () => {
		const cases = [
			{
				stage: undefined,
				arguments_: {
					questions: [
						{
							id: "ordinary",
							question: "Choose",
							options: [{ label: "A" }],
							deepInterview: { round: 9, ignored: true },
						},
					],
				},
			},
			{
				stage: "topology" as const,
				arguments_: {
					questions: [
						{
							id: "topology",
							question: "Confirm topology",
							options: [{ label: "Approve" }],
							deepInterview: {
								round: 0,
								component: "review-topology",
								dimension: "topology",
								ambiguity: 0.5,
								intent_contract: {
									items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
									confirmation_options: ["Approve"],
								},
							},
						},
					],
				},
			},
			{
				stage: "post-topology" as const,
				arguments_: {
					questions: [
						{
							id: "round-one",
							question: "Clarify scope",
							options: [{ label: "A" }],
							deepInterview: { round: 1, component: "scope", dimension: "constraints", ambiguity: 0.25 },
						},
					],
				},
			},
		] as const;
		for (const { stage, arguments_ } of cases) {
			const session = makeSession({ "tools.discoveryMode": "all" });
			session.hasUI = true;
			session.workflowGateEligible = true;
			session.getDeepInterviewAskStage = () => stage;
			const eager = await BUILTIN_TOOL_DESCRIPTORS.ask.load(session);
			const lazy = (await createTools(session, ["ask"])).find(tool => tool.name === "ask");
			if (!eager || !lazy) throw new Error("expected eager and deferred Ask tools");
			const call = { id: "ask-parity", type: "toolCall" as const, name: "ask", arguments: arguments_ };
			expect(validateToolArguments(eager, call)).toEqual(validateToolArguments(lazy, call));
			expect(JSON.stringify(lazy.parameters)).toBe(JSON.stringify(eager.parameters));
		}
	});

	test("deferred Ask rejects directional stage mismatches exactly like eager Ask", async () => {
		const topologyPayload = {
			questions: [
				{
					id: "topology",
					question: "Confirm topology",
					options: [{ label: "Approve" }],
					deepInterview: {
						round: 0,
						component: "review-topology",
						dimension: "topology",
						ambiguity: 0.5,
						intent_contract: {
							items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
							confirmation_options: ["Approve"],
						},
					},
				},
			],
		};
		const positiveRoundPayload = {
			questions: [
				{
					id: "round-one",
					question: "Clarify scope",
					options: [{ label: "A" }],
					deepInterview: { round: 1, component: "scope", dimension: "constraints", ambiguity: 0.25 },
				},
			],
		};
		for (const [stage, arguments_] of [
			["topology", positiveRoundPayload],
			["post-topology", topologyPayload],
		] as const) {
			const session = makeSession({ "tools.discoveryMode": "all" });
			session.hasUI = true;
			session.workflowGateEligible = true;
			session.getDeepInterviewAskStage = () => stage;
			const eager = await BUILTIN_TOOL_DESCRIPTORS.ask.load(session);
			const lazy = (await createTools(session, ["ask"])).find(tool => tool.name === "ask");
			if (!eager || !lazy) throw new Error("expected eager and deferred Ask tools");
			const call = { id: "ask-mismatch", type: "toolCall" as const, name: "ask", arguments: arguments_ };
			const reject = (tool: AgentTool) => {
				try {
					validateToolArguments(tool, call);
					return false;
				} catch {
					return true;
				}
			};
			const lazyRejects = reject(lazy);
			const eagerRejects = reject(eager);
			expect(lazyRejects).toBe(true);
			expect(lazyRejects).toBe(eagerRejects);
		}
	});
	test("deferred intent metadata preserves dynamic derivation and _i schema policy", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
		const tools = await createTools(session);
		const bisect = tools.find(tool => tool.name === "bisect");
		const write = tools.find(tool => tool.name === "write");
		if (!bisect || !write) throw new Error("expected deferred bisect and write tools");
		const intent = bisect.intent;
		if (typeof intent !== "function") throw new Error("expected dynamic intent derivation");
		expect(intent({ run: "HEAD~2" } as never)).toBe("bisecting: HEAD~2");
		const normalizedBisect = (normalizeTools([bisect], true) ?? [])[0];
		const normalizedWrite = (normalizeTools([write], true) ?? [])[0];
		if (!normalizedBisect || !normalizedWrite) throw new Error("expected normalized tools");
		expect((normalizedBisect.parameters as any).properties?._i).toBeUndefined();
		expect((normalizedWrite.parameters as any).properties?._i).toBeDefined();
	});
	test("concurrent lazy first use shares one load and cleanup registration", async () => {
		let loads = 0;
		let cleanupRegistrations = 0;
		const session = makeSession();
		session.registerSessionCleanup = () => {
			cleanupRegistrations += 1;
			return () => undefined;
		};
		const descriptor: ToolDescriptor = {
			metadata: { name: "concurrent" },
			presentation: { label: "Concurrent" },
			isAvailable: () => true,
			load: async loadedSession => {
				loads += 1;
				await Promise.resolve();
				loadedSession.registerSessionCleanup!(() => undefined);
				return syntheticTool();
			},
		};
		const lazy = new LazyAgentTool(descriptor, undefined, () => descriptor.load(session));
		await Promise.all([lazy.execute("one", {}), lazy.execute("two", {})]);
		expect(loads).toBe(1);
		expect(cleanupRegistrations).toBe(1);
	});
});
