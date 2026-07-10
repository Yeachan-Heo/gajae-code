import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

/**
 * Contract: when `task.maxRuntimeMs` is set, a subagent whose inference call
 * never resolves (provider stream hang the watchdog couldn't catch) MUST be
 * aborted within ~maxRuntimeMs and surface a clear "runtime limit exceeded"
 * reason — not a generic "Cancelled by caller" — so on-call engineers don't
 * mistake it for a user cancellation.
 *
 * Without this defense, the executor's `await session.waitForIdle()` waits
 * indefinitely (see session 019e2b4d-fa25-7000-a725-955278e9b293, subagent 7,
 * which stayed silent for ~2 hours).
 */

interface HangingSessionHandle {
	session: AgentSession;
	abortCalls: () => number;
}

function createHangingSession(): HangingSessionHandle {
	let abortCount = 0;
	const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		extensionRunner: undefined as never,
		sessionManager: {
			appendSessionInit: () => {},
		} as never,
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_names: string[]) => {},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		prompt: async (_text: string, _options?: PromptOptions) => {
			await hang;
		},
		waitForIdle: async () => {
			await hang;
		},
		getLastAssistantMessage: () => undefined,
		abort: async () => {
			abortCount += 1;
			releaseHang();
		},
		dispose: async () => {},
	};
	return {
		session: session as AgentSession,
		abortCalls: () => abortCount,
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}

function createUsageSession(usages: unknown | readonly unknown[]): AgentSession {
	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			queueMicrotask(() => {
				for (const usage of Array.isArray(usages) ? usages : [usages]) {
					listener({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							usage,
						},
					} as unknown as AgentSessionEvent);
				}
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-ok",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				} as AgentSessionEvent);
			});
			return () => {};
		},
		prompt: async () => {},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as AgentSession;
}

const completeRawCost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 };

type RawCostBucket = keyof typeof completeRawCost;

function usageWithRawCost(cost: Record<string, unknown>, usage: Partial<Record<string, number>> = {}) {
	return {
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 19,
		...usage,
		cost,
	};
}

const invalidRawCostCases: ReadonlyArray<{
	label: string;
	bucket: RawCostBucket;
	value?: number;
}> = [
	...(["input", "output", "cacheRead", "cacheWrite", "total"] as const).map(bucket => ({
		label: `missing ${bucket}`,
		bucket,
	})),
	...(["input", "output", "cacheRead", "cacheWrite", "total"] as const).flatMap(bucket => [
		{ label: `negative ${bucket}`, bucket, value: -1 },
		{ label: `NaN ${bucket}`, bucket, value: Number.NaN },
		{ label: `infinite ${bucket}`, bucket, value: Number.POSITIVE_INFINITY },
	]),
];

describe("runSubprocess wall clock (task.maxRuntimeMs)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-walltime",
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	};

	it("aborts a stalled subagent and surfaces a runtime-limit reason", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 50 });
		const handle = createHangingSession();
		mockCreateAgentSession(handle.session);

		const startedAt = Date.now();
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-timeout",
			settings,
		});
		const elapsedMs = Date.now() - startedAt;

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		expect(result.abortReason).toContain("task.maxRuntimeMs=50");
		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		// Sanity: must finish in roughly the configured window (allow generous slack
		// for CI; the contract is "doesn't hang for hours", not "exactly 50 ms").
		expect(elapsedMs).toBeLessThan(10_000);
	});

	it("does not abort early when the runtime budget is unlimited", async () => {
		// Stub session resolves immediately to a no-op yield so we don't actually
		// hang; we only need to assert that NO timeout fires when maxRuntimeMs=0.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		const fastSession: Partial<AgentSession> = {
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				// Fire a synthetic yield on the next tick to drive runSubprocess to
				// completion without depending on the real agent loop.
				queueMicrotask(() => {
					listener({
						type: "tool_execution_end",
						toolCallId: "tool-fast",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { ok: true } },
						},
						isError: false,
					} as AgentSessionEvent);
				});
				return () => {};
			},
			prompt: async () => {},
			waitForIdle: async () => {},
			getLastAssistantMessage: () => undefined,
			abort: async () => {},
			dispose: async () => {},
		};
		mockCreateAgentSession(fastSession as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-no-limit",
			settings,
		});

		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
	});

	it("aborts before prompting when the timer fires during session setup", async () => {
		// Delay createAgentSession longer than maxRuntimeMs so the wall-clock
		// timer fires while the executor is still doing async setup, well before
		// it ever calls session.prompt(). The fix must observe abortSignal
		// immediately before prompting and return the runtime-limit result.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 30 });
		const handle = createHangingSession();
		let promptCalls = 0;
		const originalPrompt = handle.session.prompt;
		handle.session.prompt = async (text, options) => {
			promptCalls += 1;
			return originalPrompt.call(handle.session, text, options);
		};
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
			return {
				session: handle.session,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-setup-timeout",
			settings,
		});

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		expect(result.abortReason).toContain("task.maxRuntimeMs=30");
		// The whole point: we never reached session.prompt(), because the abort
		// was observed before issuing the model call.
		expect(promptCalls).toBe(0);
	});

	it("a late successful yield does not flip a timed-out run to success", async () => {
		// A hung subagent emits a successful `yield` event during teardown (after
		// the timer has already aborted). Without the fix, `hasYield=true` would
		// make finalizeSubprocessOutput zero the exit code and `wasAborted`
		// would resolve to false — silently masking the runtime-limit breach.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 30 });
		const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let abortCount = 0;
		const session: Partial<AgentSession> = {
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			prompt: async (_text: string, _options?: PromptOptions) => {
				await hang;
			},
			waitForIdle: async () => {
				await hang;
			},
			getLastAssistantMessage: () => undefined,
			abort: async () => {
				abortCount += 1;
				// Simulate a late yield arriving while the executor is tearing
				// the session down in response to the wall-clock abort.
				listenerRef?.({
					type: "tool_execution_end",
					toolCallId: "tool-late-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { lateButLanded: true } },
					},
					isError: false,
				} as AgentSessionEvent);
				releaseHang();
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-late-yield",
			settings,
		});

		expect(abortCount).toBeGreaterThanOrEqual(1);
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		// Yield data is preserved for inspection — the regression was only in
		// the exit status / abort flag, not in the captured payload.
		expect(result.extractedToolData?.yield).toBeDefined();
	});

	it("propagates per-turn context tokens onto the SingleResult", async () => {
		// Async task consumers (index.ts) copy `singleResult.contextTokens` and
		// `singleResult.contextWindow` onto AgentProgress. This test pins the
		// upstream contract: when an assistant message_end carries totalTokens,
		// executor must surface it on SingleResult.contextTokens.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		const fastSession: Partial<AgentSession> = {
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				queueMicrotask(() => {
					listener({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 12345 },
						},
					} as unknown as AgentSessionEvent);
					listener({
						type: "tool_execution_end",
						toolCallId: "tool-ok",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { ok: true } },
						},
						isError: false,
					} as AgentSessionEvent);
				});
				return () => {};
			},
			prompt: async () => {},
			waitForIdle: async () => {},
			getLastAssistantMessage: () => undefined,
			abort: async () => {},
			dispose: async () => {},
		};
		mockCreateAgentSession(fastSession as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-context-tokens",
			settings,
		});

		expect(result.aborted).toBe(false);
		expect(result.contextTokens).toBe(12345);
		// contextWindow is only populated when the model registry resolves one;
		// here we mock createAgentSession so it stays undefined. The async-task
		// consumer's assignment is a straight copy, so undefined is acceptable.
		expect(result.contextWindow).toBeUndefined();
	});

	it("marks complete raw assistant cost provenance before canonical coercion", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		mockCreateAgentSession(createUsageSession(usageWithRawCost({ ...completeRawCost, input: 0 })));

		const result = await runSubprocess({ ...baseOptions, id: "subagent-complete-cost", settings });

		expect(result.usageCostBreakdownComplete).toBe(true);
		expect(result.usage?.cost.input).toBe(0);
	});

	for (const { label, bucket, value } of invalidRawCostCases) {
		it(`fails closed for ${label} raw assistant cost`, async () => {
			const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
			const cost: Record<string, unknown> = { ...completeRawCost };
			if (value === undefined) {
				delete cost[bucket];
			} else {
				cost[bucket] = value;
			}
			mockCreateAgentSession(createUsageSession(usageWithRawCost(cost)));

			const result = await runSubprocess({ ...baseOptions, id: `subagent-${label}`, settings });

			expect(result.usageCostBreakdownComplete).toBeUndefined();
		});
	}

	for (const { label, cost } of [
		{
			label: "missing",
			cost: { output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		},
		{
			label: "invalid",
			cost: { ...completeRawCost, cacheWrite: Number.NaN },
		},
	]) {
		it(`fails closed when a ${label} contributor precedes a valid contributor`, async () => {
			const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
			mockCreateAgentSession(createUsageSession([usageWithRawCost(cost), usageWithRawCost({ ...completeRawCost })]));

			const result = await runSubprocess({ ...baseOptions, id: `subagent-${label}-then-valid-cost`, settings });

			expect(result.usageCostBreakdownComplete).toBeUndefined();
		});
	}

	it("fails closed for a legacy contributing assistant without raw cost", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		mockCreateAgentSession(
			createUsageSession({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 }),
		);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-legacy-cost", settings });

		expect(result.usageCostBreakdownComplete).toBeUndefined();
		expect(result.usage?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	for (const [label, usages] of [
		[
			"legacy then valid",
			[
				{ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 },
				usageWithRawCost({ ...completeRawCost }),
			],
		],
		[
			"valid then legacy",
			[
				usageWithRawCost({ ...completeRawCost }),
				{ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 },
			],
		],
	] as const) {
		it(`fails closed when a ${label} contributor has no raw cost`, async () => {
			const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
			mockCreateAgentSession(createUsageSession(usages));

			const result = await runSubprocess({ ...baseOptions, id: `subagent-${label}-cost`, settings });

			expect(result.usageCostBreakdownComplete).toBeUndefined();
		});
	}

	it("preserves canonical aggregated usage and costs for valid contributors", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		mockCreateAgentSession(
			createUsageSession([
				usageWithRawCost(
					{ input: 0, output: 2, cacheRead: 3, cacheWrite: 4, total: 9 },
					{ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 },
				),
				usageWithRawCost(
					{ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
					{ input: 11, output: 5, cacheRead: 7, cacheWrite: 13, totalTokens: 36 },
				),
			]),
		);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-aggregate-valid-cost", settings });

		expect(result.usageCostBreakdownComplete).toBe(true);
		expect(result.usage).toEqual({
			input: 21,
			output: 7,
			cacheRead: 10,
			cacheWrite: 17,
			totalTokens: 55,
			cost: { input: 10, output: 22, cacheRead: 33, cacheWrite: 44, total: 109 },
		});
	});
});
