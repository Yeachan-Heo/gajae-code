import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model, StopReason, ToolCall } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";
import { Agent } from "../src/agent";
import {
	bindDispatchedToolIdentity,
	dispatchedToolIdentity,
	isNonDispatchedToolEvent,
} from "../src/tool-dispatch-identity";
import type { AgentEvent, AgentTool } from "../src/types";

// The dispatched tool object must reach consumers as OBJECT IDENTITY only: an event field
// would put `execute`, closures over session state, and tool metadata on every serialized
// copy of the event.

const model: Model = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistantMessage(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: Date.now(),
	};
}

function streamCalling(calls: ToolCall[]): Agent["streamFn"] {
	let turn = 0;
	return () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			if (turn++ > 0) {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
				return;
			}
			stream.push({ type: "start", partial: assistantMessage([], "stop") });
			calls.forEach((call, contentIndex) => {
				const partial = assistantMessage(calls.slice(0, contentIndex + 1), "stop");
				stream.push({ type: "toolcall_start", contentIndex, partial });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
			});
			stream.push({ type: "done", reason: "toolUse", message: assistantMessage(calls, "toolUse") });
		});
		return stream;
	};
}

/** How one scripted assistant turn ends, and the calls it carries when it does. */
interface ScriptedTurn {
	calls: ToolCall[];
	end: Extract<StopReason, "stop" | "toolUse" | "error" | "aborted">;
}

/**
 * Turn-by-turn script, so a turn can end the way a provider failure or a cancellation ends
 * one: with tool calls already on the wire and no dispatch behind them. Turns past the end
 * of the script stop plainly, so no script can hang the loop.
 */
function streamTurns(turns: ScriptedTurn[]): Agent["streamFn"] {
	let turn = 0;
	return () => {
		const stream = new AssistantMessageEventStream();
		const scripted: ScriptedTurn = turns[turn++] ?? { calls: [], end: "stop" };
		queueMicrotask(() => {
			stream.push({ type: "start", partial: assistantMessage([], "stop") });
			scripted.calls.forEach((call, contentIndex) => {
				const partial = assistantMessage(scripted.calls.slice(0, contentIndex + 1), "stop");
				stream.push({ type: "toolcall_start", contentIndex, partial });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
			});
			const message = assistantMessage(scripted.calls, scripted.end);
			if (scripted.end === "error" || scripted.end === "aborted") {
				stream.push({ type: "error", reason: scripted.end, error: message });
				return;
			}
			stream.push({ type: "done", reason: scripted.end, message });
		});
		return stream;
	};
}

function byCallId(events: AgentEvent[], toolCallId: string, type: AgentEvent["type"]): object {
	return events.find(
		event => event.type === type && (event as { toolCallId?: string }).toolCallId === toolCallId,
	) as object;
}

function createTool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
	return {
		name,
		label: name,
		description: `${name} SECRET_TOOL_DESCRIPTION`,
		parameters: z.object({ value: z.string().optional() }),
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
		...extra,
	} as AgentTool;
}

describe("dispatched tool identity", () => {
	test("binds the tool object the loop ran, even after the active tools are replaced", async () => {
		const dispatched = createTool("bash", { concurrency: "exclusive" } as Partial<AgentTool>);
		const replacement = createTool("bash", { concurrency: "exclusive" } as Partial<AgentTool>);
		const refresher = createTool("read", {
			concurrency: "exclusive",
			async execute() {
				// Replaces what the wire name `bash` resolves to, mid-run.
				agent.setTools([replacement]);
				return { content: [] };
			},
		} as Partial<AgentTool>);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [refresher, dispatched], messages: [] },
			streamFn: streamCalling([
				{ type: "toolCall", id: "call-read", name: "read", arguments: {} },
				{ type: "toolCall", id: "call-bash", name: "bash", arguments: {} },
			]),
		});

		const starts: AgentEvent[] = [];
		agent.subscribe(event => {
			if (event.type === "tool_execution_start") starts.push(event);
		});
		await agent.prompt("run both");

		const bashStart = starts.find(event => event.type === "tool_execution_start" && event.toolCallId === "call-bash");
		expect(bashStart).toBeDefined();
		expect(dispatchedToolIdentity(bashStart as object)).toBe(dispatched);
		expect(dispatchedToolIdentity(bashStart as object)).not.toBe(replacement);
	});

	test("carries identity without adding an enumerable or serializable tool to the event", async () => {
		const tool = createTool("bash");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [tool], messages: [] },
			streamFn: streamCalling([{ type: "toolCall", id: "call-bash", name: "bash", arguments: {} }]),
		});
		const starts: AgentEvent[] = [];
		agent.subscribe(event => {
			if (event.type === "tool_execution_start") starts.push(event);
		});
		await agent.prompt("run bash");

		const start = starts[0] as object;
		expect(dispatchedToolIdentity(start)).toBe(tool);
		// No own key — enumerable or not — may hold the tool, and nothing that copies or
		// serializes the event may pick it up.
		for (const key of Reflect.ownKeys(start)) {
			expect((start as Record<PropertyKey, unknown>)[key]).not.toBe(tool);
		}
		const serialized = JSON.stringify(start);
		expect(serialized).not.toContain("SECRET_TOOL_DESCRIPTION");
		expect(serialized).not.toContain("execute");
		// A structural copy is a different object, so it inherits no identity to leak.
		expect(dispatchedToolIdentity(JSON.parse(serialized) as object)).toBeUndefined();
	});

	test("binds nothing for a call name no active tool would dispatch", async () => {
		const tool = createTool("bash");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [tool], messages: [] },
			streamFn: streamCalling([{ type: "toolCall", id: "call-unknown", name: " bash ", arguments: {} }]),
		});
		const starts: AgentEvent[] = [];
		agent.subscribe(event => {
			if (event.type === "tool_execution_start") starts.push(event);
		});
		await agent.prompt("run an unknown tool");

		expect(starts.length).toBeGreaterThan(0);
		expect(dispatchedToolIdentity(starts[0] as object)).toBeUndefined();
	});
});

/**
 * A skipped or aborted call still owes the stream a start/end PAIR, because every consumer
 * downstream is built around results arriving in pairs. That pairing is a stream-shape
 * obligation and not evidence that anything ran, so both halves say so — and neither
 * carries dispatch provenance a consumer could turn into "this tool is running".
 */
describe("non-dispatched pairing events", () => {
	test("marks both halves of a pairing whose call was never dispatched, and binds no identity", async () => {
		const dispatchedTool = createTool("read", { concurrency: "exclusive" } as Partial<AgentTool>);
		let neverRunsExecuted = false;
		const neverRuns = createTool("bash", {
			concurrency: "exclusive",
			async execute() {
				neverRunsExecuted = true;
				return { content: [] };
			},
		} as Partial<AgentTool>);

		const running = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		dispatchedTool.execute = async () => {
			running.resolve();
			await release.promise;
			return { content: [] };
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [dispatchedTool, neverRuns], messages: [] },
			streamFn: streamCalling([
				{ type: "toolCall", id: "call-runs", name: "read", arguments: {} },
				{ type: "toolCall", id: "call-never", name: "bash", arguments: {} },
			]),
		});

		const toolEvents: AgentEvent[] = [];
		agent.subscribe(event => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event);
		});

		const run = agent.prompt("run both");
		await running.promise;
		// Steering interrupts the run, so every call the loop has not reached is finished
		// without ever being dispatched.
		agent.steer({ role: "user", content: "stop after this one", timestamp: Date.now() });
		release.resolve();
		await run;

		expect(neverRunsExecuted).toBe(false);
		const byCall = (id: string, type: AgentEvent["type"]) =>
			toolEvents.find(
				event => event.type === type && (event as { toolCallId?: string }).toolCallId === id,
			) as object;

		// The pairing still reaches ordinary subscribers unchanged.
		const syntheticStart = byCall("call-never", "tool_execution_start");
		const syntheticEnd = byCall("call-never", "tool_execution_end");
		expect(syntheticStart).toBeDefined();
		expect(syntheticEnd).toBeDefined();
		expect(isNonDispatchedToolEvent(syntheticStart)).toBe(true);
		expect(isNonDispatchedToolEvent(syntheticEnd)).toBe(true);
		// The tool this call WOULD have run is never bound: there is no dispatch to prove.
		expect(dispatchedToolIdentity(syntheticStart)).toBeUndefined();

		// The call that really ran is untouched by any of this.
		const realStart = byCall("call-runs", "tool_execution_start");
		expect(isNonDispatchedToolEvent(realStart)).toBe(false);
		expect(isNonDispatchedToolEvent(byCall("call-runs", "tool_execution_end"))).toBe(false);
		expect(dispatchedToolIdentity(realStart)).toBe(dispatchedTool);
	});

	/**
	 * A turn that ends in `error` or `aborted` never dispatches the tool calls it carries:
	 * the loop synthesizes one placeholder result per call purely so the API's
	 * tool_use/tool_result pairing survives. Those synthetic events are the same shape a
	 * real dispatch produces, so without the mark a consumer cannot tell them apart from
	 * a tool that is genuinely running.
	 */
	for (const reason of ["error", "aborted"] as const) {
		test(`marks the pairing a ${reason} assistant turn owes its undispatched tool calls`, async () => {
			let executed = false;
			const neverRuns = createTool("bash", {
				async execute() {
					executed = true;
					return { content: [] };
				},
			} as Partial<AgentTool>);
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [neverRuns], messages: [] },
				streamFn: streamTurns([
					{ calls: [{ type: "toolCall", id: "call-never", name: "bash", arguments: {} }], end: reason },
				]),
			});

			const toolEvents: AgentEvent[] = [];
			agent.subscribe(event => {
				if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event);
			});
			await agent.prompt("call a tool on a turn that fails");

			expect(executed).toBe(false);
			// The pairing still reaches ordinary subscribers unchanged.
			const start = byCallId(toolEvents, "call-never", "tool_execution_start");
			const end = byCallId(toolEvents, "call-never", "tool_execution_end");
			expect(start).toBeDefined();
			expect(end).toBeDefined();
			expect(isNonDispatchedToolEvent(start)).toBe(true);
			expect(isNonDispatchedToolEvent(end)).toBe(true);
			// Binding the tool this call WOULD have run is what lets a consumer resolve a
			// canonical built-in label for an `execute` that was never entered.
			expect(dispatchedToolIdentity(start)).toBeUndefined();
			expect(dispatchedToolIdentity(end)).toBeUndefined();
		});
	}

	/**
	 * Repeated malformed tool calls buy the model one recovery turn with tools disabled.
	 * A model that emits tool calls anyway gets the same placeholder pairing, and nothing
	 * about it is a dispatch either.
	 */
	test("marks the pairing emitted while tools are disabled for malformed-call recovery", async () => {
		let executed = false;
		const strict = createTool("bash", {
			parameters: z.object({ command: z.string() }),
			async execute() {
				executed = true;
				return { content: [] };
			},
		} as Partial<AgentTool>);
		const malformed = (id: string): ToolCall => ({ type: "toolCall", id, name: "bash", arguments: {} });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [strict], messages: [] },
			// Turn 1 repeats one malformed shape, which is what arms the single recovery
			// turn; turn 2 IS that recovery turn and emits a tool call regardless.
			streamFn: streamTurns([
				{ calls: [malformed("call-bad-1"), malformed("call-bad-2")], end: "toolUse" },
				{ calls: [malformed("call-recovery")], end: "toolUse" },
			]),
		});

		const toolEvents: AgentEvent[] = [];
		agent.subscribe(event => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event);
		});
		await agent.prompt("emit malformed tool calls");

		expect(executed).toBe(false);
		const start = byCallId(toolEvents, "call-recovery", "tool_execution_start");
		const end = byCallId(toolEvents, "call-recovery", "tool_execution_end");
		expect(start).toBeDefined();
		expect(end).toBeDefined();
		expect(isNonDispatchedToolEvent(start)).toBe(true);
		expect(isNonDispatchedToolEvent(end)).toBe(true);
		expect(dispatchedToolIdentity(start)).toBeUndefined();
	});
});

/**
 * `runTool` applies several gates before it can reach the selected `Tool.execute`:
 * arguments the provider truncated mid-stream, a name no active tool answers to, arguments
 * the tool's own schema rejects, and a `beforeToolCall` hook that blocks the call. None of
 * them enters a tool, so the start/end pair each still owes the stream is pairing-only and
 * carries no dispatch provenance.
 *
 * Every assertion below reads the mark AT DELIVERY, from inside the subscriber, because
 * that is the only place it can matter: a consumer that publishes "this tool is running"
 * decides when the event arrives, so a mark applied after `push` is already too late.
 */
describe("calls rejected before Tool.execute is entered", () => {
	interface ObservedToolEvent {
		type: "tool_execution_start" | "tool_execution_end";
		toolCallId: string;
		marked: boolean;
		identity: object | undefined;
	}

	function recordToolEvents(agent: Agent, into: ObservedToolEvent[], errorTexts: string[]): void {
		agent.subscribe(event => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				into.push({
					type: event.type,
					toolCallId: event.toolCallId,
					marked: isNonDispatchedToolEvent(event),
					identity: dispatchedToolIdentity(event),
				});
				return;
			}
			if (event.type !== "message_end" || event.message.role !== "toolResult" || !event.message.isError) return;
			const block = event.message.content[0];
			errorTexts.push(block?.type === "text" ? block.text : "");
		});
	}

	async function observeGate(options: {
		tools: AgentTool[];
		call: ToolCall;
		beforeToolCall?: Agent["beforeToolCall"];
		transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	}): Promise<{ observed: ObservedToolEvent[]; errorTexts: string[] }> {
		const agent = new Agent({
			getApiKey: function getApiKey() {
				return "test-key";
			},
			initialState: { model, systemPrompt: ["test"], tools: options.tools, messages: [] },
			streamFn: streamCalling([options.call]),
			...(options.beforeToolCall ? { beforeToolCall: options.beforeToolCall } : {}),
			...(options.transformToolCallArguments
				? { transformToolCallArguments: options.transformToolCallArguments }
				: {}),
		});
		const observed: ObservedToolEvent[] = [];
		const errorTexts: string[] = [];
		recordToolEvents(agent, observed, errorTexts);
		await agent.prompt("run the call");
		return { observed, errorTexts };
	}

	/** The pair still arrives, in order, and both halves say they proved nothing. */
	function expectPairingOnly(observed: ObservedToolEvent[], toolCallId: string): void {
		const pair = observed.filter(entry => entry.toolCallId === toolCallId);
		expect(pair.map(entry => entry.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(pair.map(entry => entry.marked)).toEqual([true, true]);
		expect(pair.map(entry => entry.identity)).toEqual([undefined, undefined]);
	}

	function executionTracker(
		name: string,
		extra: Partial<AgentTool> = {},
	): { tool: AgentTool; entered: () => boolean } {
		let entered = false;
		const tool = createTool(name, {
			...extra,
			async execute() {
				entered = true;
				return { content: [] };
			},
		} as Partial<AgentTool>);
		return { tool, entered: () => entered };
	}

	test("a call whose arguments were cut off mid-stream", async () => {
		const { tool, entered } = executionTracker("bash");
		const { observed, errorTexts } = await observeGate({
			tools: [tool],
			call: { type: "toolCall", id: "call-incomplete", name: "bash", arguments: {}, incompleteArguments: true },
		});

		expect(entered()).toBe(false);
		expectPairingOnly(observed, "call-incomplete");
		// The retryable error result the model needs is still delivered.
		expect(errorTexts.join("\n")).toContain("cut off before its arguments finished streaming");
	});

	test("a call naming a tool the run's snapshot never had", async () => {
		const { tool, entered } = executionTracker("bash");
		const { observed, errorTexts } = await observeGate({
			tools: [tool],
			call: { type: "toolCall", id: "call-unknown", name: "not_a_tool", arguments: {} },
		});

		expect(entered()).toBe(false);
		expectPairingOnly(observed, "call-unknown");
		expect(errorTexts.join("\n")).toContain("Tool not_a_tool not found");
	});

	test("a call the tool's own schema rejects", async () => {
		const { tool, entered } = executionTracker("bash", { parameters: z.object({ command: z.string() }) });
		const { observed, errorTexts } = await observeGate({
			tools: [tool],
			call: { type: "toolCall", id: "call-invalid", name: "bash", arguments: {} },
		});

		expect(entered()).toBe(false);
		expectPairingOnly(observed, "call-invalid");
		expect(errorTexts.length).toBeGreaterThan(0);
	});

	test("a call a beforeToolCall hook blocks", async () => {
		const { tool, entered } = executionTracker("bash");
		const { observed, errorTexts } = await observeGate({
			tools: [tool],
			call: { type: "toolCall", id: "call-blocked", name: "bash", arguments: {} },
			beforeToolCall: () => ({ block: true, reason: "blocked by policy" }),
		});

		expect(entered()).toBe(false);
		expectPairingOnly(observed, "call-blocked");
		expect(errorTexts.join("\n")).toContain("blocked by policy");
	});

	test("a call whose argument transform throws before execute", async () => {
		const { tool, entered } = executionTracker("bash");
		const { observed, errorTexts } = await observeGate({
			tools: [tool],
			call: { type: "toolCall", id: "call-transform-rejected", name: "bash", arguments: {} },
			transformToolCallArguments: () => {
				throw new Error("argument transform rejected");
			},
		});

		expect(entered()).toBe(false);
		expectPairingOnly(observed, "call-transform-rejected");
		expect(errorTexts.join("\n")).toContain("argument transform rejected");
	});

	test("keeps pairing-only semantics when start-event preparation throws", async () => {
		const { tool, entered } = executionTracker("bash");
		const { observed, errorTexts } = await observeGate({
			tools: [tool],
			call: { type: "toolCall", id: "call-start-preparation", name: "bash", arguments: {} },
			beforeToolCall: ({ toolCall }) => {
				let reads = 0;
				Object.defineProperty(toolCall, "intent", {
					configurable: true,
					get() {
						if (reads++ === 0) throw new Error("start intent getter rejected");
						return undefined;
					},
				});
			},
		});

		expect(entered()).toBe(false);
		expectPairingOnly(observed, "call-start-preparation");
		expect(errorTexts.join("\n")).toContain("start intent getter rejected");
	});

	test("does not re-read ToolCall properties after publishing the dispatch start", async () => {
		const { tool, entered } = executionTracker("bash");
		const { observed, errorTexts } = await observeGate({
			tools: [tool],
			call: { type: "toolCall", id: "call-snapshot-once", name: "bash", arguments: {} },
			beforeToolCall: ({ toolCall }) => {
				const stableId = toolCall.id;
				let reads = 0;
				Object.defineProperty(toolCall, "id", {
					configurable: true,
					get() {
						if (reads++ === 0) return stableId;
						throw new Error("toolCall.id was read after start publication");
					},
				});
			},
		});

		expect(entered()).toBe(true);
		expect(observed.map(entry => entry.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(observed.map(entry => entry.marked)).toEqual([false, false]);
		expect(observed[0]?.identity).toBe(tool);
		expect(errorTexts).toEqual([]);
	});

	test("ignores a poisoned own call property and enters the selected execute function", async () => {
		let entered = false;
		let receiver: unknown;
		const execute = async function execute(this: AgentTool) {
			entered = true;
			receiver = this;
			return { content: [] };
		};
		Object.defineProperty(execute, "call", {
			get() {
				throw new Error("poisoned execute.call");
			},
		});
		const bash = createTool("bash", { execute } as Partial<AgentTool>);
		const { observed, errorTexts } = await observeGate({
			tools: [bash],
			call: { type: "toolCall", id: "call-poisoned-call", name: "bash", arguments: {} },
		});

		expect(entered).toBe(true);
		expect(receiver).toBe(bash);
		expect(observed.map(entry => entry.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(observed.map(entry => entry.marked)).toEqual([false, false]);
		expect(observed[0]?.identity).toBe(bash);
		expect(errorTexts).toEqual([]);
	});

	/**
	 * The other half of the contract: a call that DOES enter its tool gets an unmarked,
	 * identity-bound start, and it reaches consumers WHILE that tool is still running —
	 * not once it has finished. Deferring the start until the gates are known to be clear
	 * must not defer it past the execution it announces.
	 */
	test("emits the unmarked, identity-bound start while the selected execute is still running", async () => {
		const observed: ObservedToolEvent[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const bash = createTool("bash", {
			async execute() {
				entered.resolve();
				await release.promise;
				return { content: [] };
			},
		} as Partial<AgentTool>);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [bash], messages: [] },
			streamFn: streamCalling([{ type: "toolCall", id: "call-runs", name: "bash", arguments: {} }]),
		});
		recordToolEvents(agent, observed, []);

		const run = agent.prompt("run bash");
		await entered.promise;
		for (let attempt = 0; attempt < 500 && observed.length === 0; attempt++) await Bun.sleep(1);

		// Published for a call that is provably still inside its tool.
		expect(observed.map(entry => entry.type)).toEqual(["tool_execution_start"]);
		expect(observed[0]?.marked).toBe(false);
		// The exact object from the run's immutable snapshot, not a name re-resolution.
		expect(observed[0]?.identity).toBe(bash);

		release.resolve();
		await run;
		expect(observed.map(entry => entry.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(observed.map(entry => entry.marked)).toEqual([false, false]);
	});
});

describe("external event dispatched identity", () => {
	function agentWithCurrentTools(tools: AgentTool[]): Agent {
		return new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools, messages: [] },
			streamFn: streamCalling([]),
		});
	}

	test("keeps the producer-selected tool object when a current tool claims the same wire name", () => {
		const executed = createTool("custom-exec");
		const collidingCurrent = createTool("custom-exec");
		const agent = agentWithCurrentTools([collidingCurrent]);
		const event: AgentEvent = {
			type: "tool_execution_start",
			toolCallId: "call-external",
			toolName: "custom-exec",
			args: {},
		};
		// The external producer already proved which object ran.
		bindDispatchedToolIdentity(event, executed);

		agent.emitExternalEvent(event);

		expect(dispatchedToolIdentity(event as object)).toBe(executed);
		expect(dispatchedToolIdentity(event as object)).not.toBe(collidingCurrent);
	});

	test("does not guess an identity for an external start no producer bound", () => {
		const current = createTool("bash");
		const agent = agentWithCurrentTools([current]);
		const event: AgentEvent = {
			type: "tool_execution_start",
			toolCallId: "call-unproven",
			toolName: "bash",
			args: {},
		};

		agent.emitExternalEvent(event);

		expect(dispatchedToolIdentity(event as object)).toBeUndefined();
	});
});
