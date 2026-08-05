import { describe, expect, test } from "bun:test";
import { normalizeTools } from "@gajae-code/agent-core";
import { validateToolArguments } from "@gajae-code/ai/core";
import { toolWireSchema } from "@gajae-code/ai/utils/schema";
import type { AgentTool } from "@gajae-code/agent-core";
import {
	BUILTIN_TOOL_DESCRIPTORS,
	BUILTIN_TOOLS,
	HIDDEN_TOOLS,
	HIDDEN_TOOL_DESCRIPTORS,
	LazyAgentTool,
	TOOL_DESCRIPTORS,
	resolveEffectiveDiscoveryMode,
	type ToolAvailabilityContext,
	type ToolDescriptor,
} from "./descriptors";
import { isComputerLoadablePlatform } from "./computer";
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
			const discoverySession = makeSession({ "tools.discoveryMode": toolsDiscoveryMode, "mcp.discoveryMode": mcpDiscoveryMode });
			expect(searchDescriptor.isAvailable(discoverySession, availabilityContext({ discoveryActive: expected }))).toBe(expected);
		}
		expect(BUILTIN_TOOL_DESCRIPTORS.goal.isAvailable(session, availabilityContext({ goalEnabled: false }))).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.goal.isAvailable(session, availabilityContext({ goalEnabled: true }))).toBe(true);
		expect(HIDDEN_TOOL_DESCRIPTORS.resolve.isAvailable(session, availabilityContext())).toBe(true);
		expect(BUILTIN_TOOL_DESCRIPTORS.task.isAvailable(makeSession({ "task.maxRecursionDepth": 0 }), availabilityContext())).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.task.isAvailable(makeSession({ "task.maxRecursionDepth": -1 }), availabilityContext())).toBe(true);
		expect(BUILTIN_TOOL_DESCRIPTORS.task.isAvailable(makeSession({ "task.maxRecursionDepth": 1 }), availabilityContext())).toBe(true);
		expect(BUILTIN_TOOL_DESCRIPTORS.task.isAvailable({ ...makeSession({ "task.maxRecursionDepth": 1 }), taskDepth: 1 }, availabilityContext())).toBe(false);
		expect(computeEssentialBuiltinNames({ get: () => [] } as never)).toEqual(["read", "bash", "edit", "write", "search", "find"]);
		expect(computeEssentialBuiltinNames({ get: () => ["read", "missing", "bash"] } as never)).toEqual(["read", "bash"]);
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
		const unavailableByDefault = new Set([
			"debug",
			"github",
			"search_tool_bm25",
			"goal",
		]);
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
		for (const name of ["lsp", "find", "search", "ast_grep", "ast_edit", "render_mermaid", "web_search", "calc", "skill", "skill_discovery", "browser", "checkpoint", "rewind", "irc", "recipe", "task"])
			expect(BUILTIN_TOOL_DESCRIPTORS[name].isAvailable(disabled, disabledContext)).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.goal.isAvailable(disabled, disabledContext)).toBe(true);
		expect(BUILTIN_TOOL_DESCRIPTORS.search_tool_bm25.isAvailable(disabled, disabledContext)).toBe(true);

		const yieldContext = availabilityContext({ includeYield: true });
		expect(BUILTIN_TOOL_DESCRIPTORS.todo_write.isAvailable(session, yieldContext)).toBe(false);
		expect(BUILTIN_TOOL_DESCRIPTORS.todo_write.isAvailable(session, context)).toBe(true);
		expect(BUILTIN_TOOL_DESCRIPTORS.eval.isAvailable(session, availabilityContext({ allowEval: false }))).toBe(false);
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
		const tools = await createTools(session);
		const ask = tools.find(tool => tool.name === "ask");
		const todo = tools.find(tool => tool.name === "todo_write");
		if (!ask || !todo) throw new Error("expected deferred ask and todo_write tools");
		expect(typeof ask.rawArgumentValidation).toBe("function");
		expect(typeof todo.rawArgumentValidation).toBe("function");
		expect(() =>
			validateToolArguments(todo, { id: "call-1", type: "toolCall", name: "todo_write", arguments: { unknown: true } }),
		).toThrow("raw arguments rejected before coercion");
		expect(() =>
			validateToolArguments(ask, { id: "call-2", type: "toolCall", name: "ask", arguments: { unknown: true } }),
		).toThrow("Validation failed for tool \"ask\"");
	});

	test("deferred ask validator recovers the canonical round-zero pair", async () => {
		const session = makeSession({ "tools.discoveryMode": "all" });
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
		const recovered = validateToolArguments(ask, { id: "call-3", type: "toolCall", name: "ask", arguments: arguments_ });
		expect(recovered.questions[0].deepInterview.intent_contract).toBeDefined();
		expect(recovered.questions[0].deepInterview.intent_review).toBeUndefined();
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
				questions: [{ id: "q", question: "q", options: [{ label: "yes" }], workflowGate: { stage: "deep-interview", kind: "question", extra: true } }],
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
								supporting_substitutions: [{ removed_id: "artifact:report", replacement_ids: [], rationale: "bad" }],
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