/**
 * Tests for the run-level telemetry rollup. These tests do NOT depend on a
 * registered OpenTelemetry exporter — every fact is asserted either through
 * the `AgentRunSummary` returned to the caller, the `agent_end` event
 * payload, or a hand-rolled `RecordingTracer` that captures span/attribute
 * activity in memory.
 */

import { describe, expect, it } from "bun:test";
import { agentLoop, agentLoopDetailed } from "@gajae-code/agent-core/agent-loop";
import {
	type AgentRunSummary,
	aggregateAgentRunCoverage,
	aggregateAgentRunSummaries,
	emptyAgentRunCoverage,
	emptyAgentRunSummary,
} from "@gajae-code/agent-core/run-collector";
import { EXECUTE_TOOL_STATUS_ATTR, GenAIAttr, PiGenAIAggregateAttr } from "@gajae-code/agent-core/telemetry";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { z } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import type {
	AttributeValue,
	Context as OtelContext,
	Span,
	SpanOptions,
	SpanStatus,
	TimeInput,
	Tracer,
} from "@opentelemetry/api";
import { createUserMessage } from "./helpers";

interface RecordedSpan {
	readonly name: string;
	readonly attributes: Record<string, AttributeValue | undefined>;
	status?: SpanStatus;
	ended: boolean;
	exceptions: unknown[];
}

class RecordingTracer implements Tracer {
	readonly spans: RecordedSpan[] = [];

	startSpan(name: string, options?: SpanOptions, _ctx?: OtelContext): Span {
		const record: RecordedSpan = {
			name,
			attributes: { ...(options?.attributes ?? {}) },
			ended: false,
			exceptions: [],
		};
		this.spans.push(record);
		return makeFakeSpan(record);
	}

	startActiveSpan(): never {
		throw new Error("startActiveSpan is unused by the run collector tests");
	}

	spansByName(name: string): RecordedSpan[] {
		return this.spans.filter(s => s.name === name);
	}

	findSpan(name: string): RecordedSpan | undefined {
		return this.spans.find(s => s.name === name);
	}
}

function makeFakeSpan(record: RecordedSpan): Span {
	const span: Span = {
		spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 0 }),
		setAttribute(key: string, value: AttributeValue) {
			record.attributes[key] = value;
			return span;
		},
		setAttributes(attrs: Record<string, AttributeValue>) {
			Object.assign(record.attributes, attrs);
			return span;
		},
		addEvent: () => span,
		addLink: () => span,
		addLinks: () => span,
		setStatus(status: SpanStatus) {
			record.status = status;
			return span;
		},
		updateName(name: string) {
			(record as { -readonly [K in keyof RecordedSpan]: RecordedSpan[K] }).name = name;
			return span;
		},
		end(_end?: TimeInput) {
			record.ended = true;
		},
		isRecording: () => !record.ended,
		recordException(err: unknown) {
			record.exceptions.push(err);
		},
	};
	return span;
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeUsage(
	input: number,
	output: number,
	totalTokens = input + output,
	extras: Partial<AssistantMessage["usage"]> = {},
) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...extras,
	};
}

interface TestTool {
	readonly name: string;
	readonly behavior: "ok" | "throw" | "block";
	readonly result?: string;
}

function buildTool(spec: TestTool): AgentTool {
	if (spec.behavior === "ok" || spec.behavior === "throw") {
		return {
			name: spec.name,
			label: spec.name,
			description: `test tool ${spec.name}`,
			parameters: z.object({ value: z.string().optional() }),
			intent: "omit",
			execute: async () => {
				if (spec.behavior === "throw") throw new Error(`${spec.name} boom`);
				return { content: [{ type: "text", text: spec.result ?? "ok" }], details: {} };
			},
		} satisfies AgentTool;
	}
	// blocked tools still need an execute path; the loop short-circuits via beforeToolCall.
	return {
		name: spec.name,
		label: spec.name,
		description: `blocked tool ${spec.name}`,
		parameters: z.object({ value: z.string().optional() }),
		intent: "omit",
		execute: async () => ({ content: [{ type: "text", text: "should not run" }], details: {} }),
	} satisfies AgentTool;
}

describe("AgentRunSummary delivery", () => {
	it("populates telemetry/coverage on agent_end when telemetry: {} is supplied", async () => {
		const tracer = new RecordingTracer();
		const mock = createMockModel({
			responses: [{ content: ["ok"], usage: makeUsage(7, 3) }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { tracer },
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [] },
			config,
			undefined,
			mock.stream,
		);
		for await (const event of stream) events.push(event);
		const endEvent = events.find((e): e is Extract<AgentEvent, { type: "agent_end" }> => e.type === "agent_end");
		expect(endEvent).toBeDefined();
		expect(endEvent?.telemetry).toBeDefined();
		expect(endEvent?.coverage).toBeDefined();
		expect(endEvent?.telemetry?.stepCount).toBe(1);
		expect(endEvent?.telemetry?.chats.total).toBe(1);
		expect(endEvent?.telemetry?.usage.totalTokens).toBe(10);
	});

	it("emits no spans and no summary when telemetry is unset", async () => {
		const tracer = new RecordingTracer();
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			// telemetry intentionally unset.
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [] },
			config,
			undefined,
			mock.stream,
		);
		for await (const event of stream) events.push(event);
		expect(tracer.spans.length).toBe(0);
		const endEvent = events.find((e): e is Extract<AgentEvent, { type: "agent_end" }> => e.type === "agent_end");
		expect(endEvent?.telemetry).toBeUndefined();
		expect(endEvent?.coverage).toBeUndefined();
	});

	it("preserves agentLoop().result() backwards-compat (still resolves to AgentMessage[])", async () => {
		const tracer = new RecordingTracer();
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { tracer },
		};
		const stream = agentLoop(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [] },
			config,
			undefined,
			mock.stream,
		);
		const messages = await stream.result();
		// 1 user prompt + 1 assistant message.
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");
	});
});

describe("AgentRunSummary aggregation", () => {
	it("sums token + cost totals across multiple chats and counts stop_reasons", async () => {
		const tracer = new RecordingTracer();
		const tool = buildTool({ name: "alpha", behavior: "ok" });
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "a-1", name: "alpha", arguments: { value: "x" } }],
					usage: makeUsage(5, 2),
				},
				{ content: ["wrap"], usage: makeUsage(8, 1) },
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				telemetry: {
					tracer,
					costEstimator: () => ({ usd: 0.001 }),
				},
			},
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { telemetry, coverage } = await detailed.detailed();
		expect(telemetry).toBeDefined();
		expect(coverage).toBeDefined();
		expect(telemetry?.chats.total).toBe(2);
		expect(telemetry?.usage.inputTokens).toBe(13);
		expect(telemetry?.usage.outputTokens).toBe(3);
		expect(telemetry?.usage.totalTokens).toBe(16);
		// One toolUse chat + one stop chat.
		expect(telemetry?.chats.byStopReason.toolUse).toBe(1);
		expect(telemetry?.chats.byStopReason.stop).toBe(1);
		// Two chats × 0.001 USD each.
		expect(telemetry?.cost.estimatedUsd).toBeCloseTo(0.002, 6);
	});

	it("aggregates tool outcomes (ok / error / blocked / skipped) and key in byName", async () => {
		const tracer = new RecordingTracer();
		const tools = [
			buildTool({ name: "ok-tool", behavior: "ok" }),
			buildTool({ name: "err-tool", behavior: "throw" }),
			buildTool({ name: "blocked-tool", behavior: "block" }),
		];
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "t-1", name: "ok-tool", arguments: { value: "x" } },
						{ type: "toolCall", id: "t-2", name: "err-tool", arguments: { value: "x" } },
						{ type: "toolCall", id: "t-3", name: "blocked-tool", arguments: { value: "x" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				telemetry: { tracer },
				beforeToolCall: async ctx => {
					if (ctx.toolCall.name === "blocked-tool") return { block: true, reason: "policy" };
					return undefined;
				},
			},
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { telemetry } = await detailed.detailed();
		expect(telemetry?.tools.total).toBe(3);
		expect(telemetry?.tools.ok).toBe(1);
		expect(telemetry?.tools.error).toBe(1);
		expect(telemetry?.tools.blocked).toBe(1);
		expect(telemetry?.tools.byName["ok-tool"]?.ok).toBe(1);
		expect(telemetry?.tools.byName["err-tool"]?.error).toBe(1);
		expect(telemetry?.tools.byName["blocked-tool"]?.blocked).toBe(1);
		// Blocked-tool span should carry the explicit blocked status, not generic tool_error.
		const blockedSpan = tracer.findSpan("execute_tool blocked-tool");
		expect(blockedSpan?.attributes[EXECUTE_TOOL_STATUS_ATTR]).toBe("blocked");
		expect(blockedSpan?.attributes[GenAIAttr.ErrorType]).toBe("tool_blocked");
	});

	it("populates aggregate pi.gen_ai.agent.* attributes on the invoke_agent span", async () => {
		const tracer = new RecordingTracer();
		const tool = buildTool({ name: "alpha", behavior: "ok" });
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "a-1", name: "alpha", arguments: { value: "x" } }],
					usage: makeUsage(4, 6),
				},
				{ content: ["done"], usage: makeUsage(2, 1) },
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [tool] },
			{ model: mock.model, convertToLlm: identityConverter, telemetry: { tracer } },
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		await detailed.detailed();
		const invokeSpan = tracer.findSpan("invoke_agent");
		expect(invokeSpan).toBeDefined();
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.ChatsCount]).toBe(2);
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.ToolsCount]).toBe(1);
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.ToolsOkCount]).toBe(1);
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.UsageInputTokensTotal]).toBe(6);
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.UsageTotalTokensTotal]).toBe(13);
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.ToolsInvoked]).toEqual(["alpha"]);
	});
});

describe("AgentRunCoverage", () => {
	it("returns sorted+deduped toolsAvailable / toolsUnused over multi-step run", async () => {
		const tracer = new RecordingTracer();
		const tools = [
			buildTool({ name: "zeta", behavior: "ok" }),
			buildTool({ name: "alpha", behavior: "ok" }),
			buildTool({ name: "mu", behavior: "ok" }),
		];
		const mock = createMockModel({
			responses: [
				// Step 1 invokes alpha and mu.
				{
					content: [
						{ type: "toolCall", id: "t-1", name: "alpha", arguments: { value: "x" } },
						{ type: "toolCall", id: "t-2", name: "mu", arguments: { value: "x" } },
					],
				},
				// Step 2 wraps up with a text response — zeta is never invoked.
				{ content: ["done"] },
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools },
			{ model: mock.model, convertToLlm: identityConverter, telemetry: { tracer } },
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { coverage } = await detailed.detailed();
		expect(coverage?.toolsAvailable).toEqual(["alpha", "mu", "zeta"]);
		expect(coverage?.toolsInvoked).toEqual(["alpha", "mu"]);
		expect(coverage?.toolsUnused).toEqual(["zeta"]);
	});
});

describe("aggregateAgentRunSummaries / aggregateAgentRunCoverage", () => {
	it("is deterministic and sums element-wise across N runs", () => {
		const baseChats = {
			total: 1,
			byStopReason: { stop: 1 },
			totalLatencyMs: 100,
		};
		const a: AgentRunSummary = {
			chats: baseChats,
			tools: {
				total: 1,
				ok: 1,
				error: 0,
				skipped: 0,
				blocked: 0,
				timeout: 0,
				aborted: 0,
				totalLatencyMs: 5,
				byName: {
					foo: { total: 1, ok: 1, error: 0, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 5 },
				},
			},
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 15,
			},
			cost: { estimatedUsd: 0.005, unavailableReasons: [] },
			errors: { total: 0, byType: {} },
			stepCount: 1,
		};
		const b: AgentRunSummary = {
			chats: { total: 2, byStopReason: { stop: 1, toolUse: 1 }, totalLatencyMs: 250 },
			tools: {
				total: 2,
				ok: 1,
				error: 1,
				skipped: 0,
				blocked: 0,
				timeout: 0,
				aborted: 0,
				totalLatencyMs: 12,
				byName: {
					bar: { total: 1, ok: 1, error: 0, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 6 },
					foo: { total: 1, ok: 0, error: 1, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 6 },
				},
			},
			usage: {
				inputTokens: 20,
				outputTokens: 10,
				cachedInputTokens: 2,
				cacheWriteTokens: 1,
				reasoningOutputTokens: 0,
				totalTokens: 33,
			},
			cost: { estimatedUsd: 0.01, unavailableReasons: ["mock"] },
			errors: { total: 1, byType: { Error: 1 } },
			stepCount: 2,
		};
		const merged1 = aggregateAgentRunSummaries([a, b]);
		const merged2 = aggregateAgentRunSummaries([a, b]);
		expect(merged1).toEqual(merged2);
		expect(merged1.chats.total).toBe(3);
		expect(merged1.chats.byStopReason).toEqual({ stop: 2, toolUse: 1 });
		expect(merged1.tools.total).toBe(3);
		expect(merged1.tools.byName.foo.total).toBe(2);
		expect(merged1.tools.byName.foo.error).toBe(1);
		expect(merged1.tools.byName.bar.ok).toBe(1);
		expect(merged1.usage.totalTokens).toBe(48);
		expect(merged1.cost.estimatedUsd).toBeCloseTo(0.015, 6);
		expect(merged1.cost.unavailableReasons).toEqual(["mock"]);
		expect(merged1.errors.total).toBe(1);
		expect(merged1.stepCount).toBe(3);
	});

	it("coverage aggregation dedupes, sorts, and recomputes unused", () => {
		const c1 = {
			toolsAvailable: ["alpha", "beta"],
			toolsInvoked: ["alpha"],
			toolsUnused: ["beta"],
			modelsUsed: ["m1"],
			providersUsed: ["p1"],
		};
		const c2 = {
			toolsAvailable: ["beta", "gamma"],
			toolsInvoked: ["gamma"],
			toolsUnused: ["beta"],
			modelsUsed: ["m2"],
			providersUsed: ["p1"],
		};
		const merged = aggregateAgentRunCoverage([c1, c2]);
		expect(merged.toolsAvailable).toEqual(["alpha", "beta", "gamma"]);
		expect(merged.toolsInvoked).toEqual(["alpha", "gamma"]);
		expect(merged.toolsUnused).toEqual(["beta"]);
		expect(merged.modelsUsed).toEqual(["m1", "m2"]);
		expect(merged.providersUsed).toEqual(["p1"]);
	});

	it("returns empty constants when given no summaries", () => {
		expect(aggregateAgentRunSummaries([])).toBe(emptyAgentRunSummary());
		expect(aggregateAgentRunCoverage([])).toBe(emptyAgentRunCoverage());
	});
});

describe("onRunEnd is non-fatal", () => {
	it("swallows thrown errors and still resolves agentLoop().result() normally", async () => {
		const tracer = new RecordingTracer();
		const warnings: unknown[][] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		try {
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });
			const stream = agentLoop(
				[createUserMessage("hi")],
				{ systemPrompt: ["sys"], messages: [], tools: [] },
				{
					model: mock.model,
					convertToLlm: identityConverter,
					telemetry: {
						tracer,
						onRunEnd: () => {
							throw new Error("user code is buggy");
						},
					},
				},
				undefined,
				mock.stream,
			);
			const messages = await stream.result();
			expect(messages.length).toBe(2);
		} finally {
			console.warn = realWarn;
		}
		// The wrapper must surface the failure via console.warn, not via rejection.
		expect(warnings.length).toBeGreaterThanOrEqual(1);
		expect(String(warnings[0][0])).toContain("onRunEnd");
	});
});

describe("skipped tools without spans", () => {
	it("counts pre-run-interrupted tools toward tools.skipped without emitting an execute_tool span", async () => {
		const tracer = new RecordingTracer();
		const fastTool: AgentTool = {
			name: "fast",
			label: "fast",
			description: "fast",
			parameters: z.object({ value: z.string().optional() }),
			intent: "omit",
			execute: async () => ({ content: [{ type: "text", text: "fast-ok" }], details: {} }),
		};
		const slowTool: AgentTool = {
			name: "slow",
			label: "slow",
			description: "slow",
			parameters: z.object({ value: z.string().optional() }),
			intent: "omit",
			// concurrency: shared (default) — both run in parallel; we abort via steering.
			execute: async (_id, _args, signal) => {
				await new Promise<void>((resolve, reject) => {
					if (!signal) {
						resolve();
						return;
					}
					if (signal.aborted) {
						reject(new Error("aborted"));
						return;
					}
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
				return { content: [{ type: "text", text: "slow-ok" }], details: {} };
			},
		};
		let triggered = false;
		let getSteeringCallCount = 0;
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-fast", name: "fast", arguments: { value: "x" } },
						{ type: "toolCall", id: "tool-slow", name: "slow", arguments: { value: "x" } },
					],
				},
				{ content: ["wrap"] },
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [fastTool, slowTool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				telemetry: { tracer },
				toolInterruptPolicy: "abort_tools",
				getSteeringMessages: async () => {
					// First call is at runLoopBody startup BEFORE any chat happens —
					// suppress it so the tools actually start. Return steering on the
					// next call (inside checkSteering after fast-tool finishes).
					getSteeringCallCount += 1;
					if (getSteeringCallCount === 1) return [];
					if (triggered) return [];
					triggered = true;
					return [createUserMessage("steering")];
				},
			},
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { telemetry } = await detailed.detailed();
		// The fast tool completes; the slow tool is interrupted mid-flight (aborted) OR
		// before it ever starts (skipped). Either way, both calls show up in total and
		// exactly one of them is non-ok.
		expect(telemetry?.tools.total).toBe(2);
		expect(telemetry?.tools.ok).toBe(1);
		expect((telemetry?.tools.skipped ?? 0) + (telemetry?.tools.aborted ?? 0)).toBe(1);
	});
});

describe("regressions: agent loop telemetry/run summary", () => {
	it("counts each interrupted tool call exactly once (no double-counting via tail sweep)", async () => {
		const tracer = new RecordingTracer();
		// `concurrency: "exclusive"` serializes the batch so we can deterministically
		// reach the `interruptState.triggered` early-return inside `runTool` for
		// the second and third call. Pre-fix that path called `recordSkippedTool`
		// AND the tail sweep called it again, double-counting.
		const fastTool: AgentTool = {
			name: "fast",
			label: "fast",
			description: "fast",
			parameters: z.object({ value: z.string().optional() }),
			intent: "omit",
			concurrency: "exclusive",
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const callCount = { n: 0 };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "c-1", name: "fast", arguments: { value: "a" } },
						{ type: "toolCall", id: "c-2", name: "fast", arguments: { value: "b" } },
						{ type: "toolCall", id: "c-3", name: "fast", arguments: { value: "c" } },
					],
				},
				{ content: ["wrap"] },
				{ content: ["after-steering"] },
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [fastTool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				telemetry: { tracer },
				toolInterruptPolicy: "abort_tools",
				getSteeringMessages: async () => {
					callCount.n += 1;
					// Pre-chat poll (call 1) returns nothing so tools start;
					// the first post-tool checkSteering (call 2) injects steering
					// and flips `interruptState.triggered` for the rest of the
					// batch. Subsequent polls return nothing so the loop drains.
					if (callCount.n === 2) return [createUserMessage("stop")];
					return [];
				},
			},
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { telemetry } = await detailed.detailed();
		// Three tool calls -> exactly three rows in the run summary, never six.
		expect(telemetry?.tools.total).toBe(3);
		expect(telemetry?.tools.ok).toBe(1);
		expect(telemetry?.tools.skipped).toBe(2);
	});

	it("records aborted assistant tool calls in coverage.toolsInvoked + tools.aborted", async () => {
		const tracer = new RecordingTracer();
		const tool = buildTool({ name: "alpha", behavior: "ok" });
		// Provider yields an aborted assistant message that still contains tool
		// calls (e.g. the wire was cut after the model started emitting them).
		// The agent loop synthesizes placeholder tool results for API parity;
		// the run summary must reflect that the LLM asked for the tool.
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "a-1", name: "alpha", arguments: { value: "x" } },
						{ type: "toolCall", id: "a-2", name: "alpha", arguments: { value: "y" } },
					],
					stopReason: "aborted",
				},
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [tool] },
			{ model: mock.model, convertToLlm: identityConverter, telemetry: { tracer } },
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { telemetry, coverage } = await detailed.detailed();
		expect(telemetry?.tools.total).toBe(2);
		expect(telemetry?.tools.aborted).toBe(2);
		expect(coverage?.toolsInvoked).toEqual(["alpha"]);
	});

	it("includes cache_read + cache_write input tokens in the run summary's inputTokens", async () => {
		const tracer = new RecordingTracer();
		const mock = createMockModel({
			responses: [
				{
					content: ["ok"],
					usage: makeUsage(7, 3, 17, { cacheRead: 5, cacheWrite: 2 }),
				},
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [] },
			{ model: mock.model, convertToLlm: identityConverter, telemetry: { tracer } },
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { telemetry } = await detailed.detailed();
		// inputTokens must equal input + cacheRead + cacheWrite (7 + 5 + 2 = 14).
		expect(telemetry?.usage.inputTokens).toBe(14);
		expect(telemetry?.usage.cachedInputTokens).toBe(5);
		expect(telemetry?.usage.cacheWriteTokens).toBe(2);
		// outputTokens is unaffected.
		expect(telemetry?.usage.outputTokens).toBe(3);
	});

	it("does not throw when a tool result `details` object embeds a cyclic array under summary capture", async () => {
		const tracer = new RecordingTracer();
		// Build a self-referential array; this previously blew the stack inside
		// `summarizeTelemetryValue` because the array branch had no depth guard.
		const cyclic: unknown[] = [1, 2, 3];
		cyclic.push(cyclic);
		const tool: AgentTool = {
			name: "cyclic",
			label: "cyclic",
			description: "returns cyclic details",
			parameters: z.object({ value: z.string().optional() }),
			intent: "omit",
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
				details: { ring: cyclic },
			}),
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "c-1", name: "cyclic", arguments: { value: "x" } }] },
				{ content: ["done"] },
			],
		});
		const detailed = agentLoopDetailed(
			[createUserMessage("hi")],
			{ systemPrompt: ["sys"], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				telemetry: { tracer, captureMessageContent: "summary" },
			},
			undefined,
			mock.stream,
		);
		for await (const _ of detailed.stream) {
			// drain
		}
		const { telemetry } = await detailed.detailed();
		expect(telemetry?.tools.total).toBe(1);
		expect(telemetry?.tools.ok).toBe(1);
		// The execute_tool span must have captured a bounded summary string, not
		// crashed and not emitted nothing at all.
		const toolSpan = tracer.findSpan("execute_tool cyclic");
		expect(toolSpan).toBeDefined();
		const captured = toolSpan?.attributes[GenAIAttr.ToolCallResult];
		expect(typeof captured).toBe("string");
		// Either the cycle is short-circuited as `[Circular]` or the depth cap
		// truncates it to `{kind:"array",length:N}` — both are bounded.
		expect(/Circular|"kind":"array"/.test(String(captured))).toBe(true);
	});
});
