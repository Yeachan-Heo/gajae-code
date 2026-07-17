import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type ToolResultMessage, type Usage } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession, type SessionStats } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

function cost(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): Usage["cost"] {
	return { input, output, cacheRead, cacheWrite, total };
}

const completeCost = (amount: number): Usage["cost"] => cost(amount, amount, amount, amount, amount);

function usage(cost: unknown, input = 1, output = 2, cacheRead = 3, cacheWrite = 4): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: cost as Usage["cost"],
	};
}

function assistant(cost: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: usage(cost),
		stopReason: "stop",
		timestamp: 1,
	};
}

function task(cost: unknown, marked = true): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "task-call",
		toolName: "task",
		content: [],
		isError: false,
		timestamp: 2,
		details: {
			usage: usage(cost, 10, 20, 30, 40),
			...(marked ? { usageCostBreakdownComplete: true as const } : {}),
		},
	};
}

async function createSession(messages: AgentMessage[]): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const authStorage = await AuthStorage.create(":memory:");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, messages, tools: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return { session, authStorage };
}

async function getStats(messages: AgentMessage[]) {
	const { session, authStorage } = await createSession(messages);
	try {
		return session.getSessionStats();
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

describe("AgentSession cache economics provenance", () => {
	it("aggregates each persisted cost bucket from parent and marked task usage", async () => {
		const parentCost = cost(0.125, 0.25, 0.5, 0.75, 1.625);
		const taskCost = cost(1, 2, 4, 8, 15);
		const stats = await getStats([assistant(parentCost), task(taskCost)]);

		expect(stats.costBreakdown).toEqual(cost(1.125, 2.25, 4.5, 8.75, 16.625));
		expect(stats.tokens).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 });
		expect(stats.cost).toBe(16.625);
	});

	it("omits the breakdown when finite persisted buckets overflow in aggregate", async () => {
		const stats = await getStats([
			assistant(completeCost(Number.MAX_VALUE)),
			assistant(completeCost(Number.MAX_VALUE)),
		]);

		expect(stats.costBreakdown).toBeUndefined();
		expect(stats.tokens).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 });
		expect(stats.cost).toBe(Number.POSITIVE_INFINITY);
	});

	it("retains an explicit all-zero persisted cost breakdown", async () => {
		const stats = await getStats([assistant(completeCost(0)), task(completeCost(0))]);

		expect(stats.costBreakdown).toEqual(completeCost(0));
		expect(stats.cost).toBe(0);
	});

	it("reports factual zero buckets for empty and parent-only sessions", async () => {
		const emptyStats = await getStats([]);
		expect(emptyStats.costBreakdown).toEqual(completeCost(0));
		expect(emptyStats.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(emptyStats.cost).toBe(0);

		const parentStats = await getStats([assistant(completeCost(0.02))]);
		expect(parentStats.costBreakdown).toEqual(completeCost(0.02));
		expect(parentStats.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
		expect(parentStats.cost).toBe(0.02);
	});

	it("does not suppress persisted parent facts for task results without usage", async () => {
		const taskWithoutUsage: ToolResultMessage = {
			...task(completeCost(0.5)),
			details: {},
		};
		const stats = await getStats([assistant(completeCost(0.02)), taskWithoutUsage]);

		expect(stats.costBreakdown).toEqual(completeCost(0.02));
		expect(stats.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
		expect(stats.cost).toBe(0.02);
	});

	it("omits only the breakdown for malformed or legacy task provenance", async () => {
		const taskWithFalseMarker = task(completeCost(0.5));
		(taskWithFalseMarker.details as Record<string, unknown>).usageCostBreakdownComplete = false;
		const cases: Array<{
			name: string;
			messages: AgentMessage[];
			expectedTokens: SessionStats["tokens"];
			expectedCost: number;
		}> = [
			{
				name: "a negative parent cost bucket",
				messages: [assistant({ ...completeCost(0.02), input: -1 })],
				expectedTokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				expectedCost: 0.02,
			},
			{
				name: "a parent cost bucket missing from persisted usage",
				messages: [assistant({ output: 0.02, cacheRead: 0.02, cacheWrite: 0.02, total: 0.02 })],
				expectedTokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				expectedCost: 0.02,
			},
			{
				name: "a non-finite parent cost bucket",
				messages: [assistant({ ...completeCost(0.02), cacheRead: Number.POSITIVE_INFINITY })],
				expectedTokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				expectedCost: 0.02,
			},
			{
				name: "a NaN parent cost bucket",
				messages: [assistant({ ...completeCost(0.02), cacheWrite: Number.NaN })],
				expectedTokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				expectedCost: 0.02,
			},
			{
				name: "a negative marked task cost bucket",
				messages: [assistant(completeCost(0.02)), task({ ...completeCost(0.5), cacheWrite: -1 })],
				expectedTokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
				expectedCost: 0.52,
			},
			{
				name: "a marked task with a NaN total",
				messages: [assistant(completeCost(0.02)), task({ ...completeCost(0.5), total: Number.NaN })],
				expectedTokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
				expectedCost: Number.NaN,
			},
			{
				name: "a task marker other than exactly true",
				messages: [assistant(completeCost(0.02)), taskWithFalseMarker],
				expectedTokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
				expectedCost: 0.52,
			},
			{
				name: "an unmarked legacy task usage",
				messages: [assistant(completeCost(0.02)), task(completeCost(0.5), false)],
				expectedTokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
				expectedCost: 0.52,
			},
		];

		for (const testCase of cases) {
			const stats = await getStats(testCase.messages);
			expect(stats.costBreakdown, testCase.name).toBeUndefined();
			expect(stats.tokens, testCase.name).toEqual(testCase.expectedTokens);
			if (Number.isNaN(testCase.expectedCost)) {
				expect(Number.isNaN(stats.cost), testCase.name).toBe(true);
			} else {
				expect(stats.cost, testCase.name).toBe(testCase.expectedCost);
			}
		}
	});
});
