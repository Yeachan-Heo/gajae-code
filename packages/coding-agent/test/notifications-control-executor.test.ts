import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { executeNotificationControlCommand } from "../src/notifications";

function fakeCtx(overrides: Record<string, unknown> = {}) {
	const compactCalls: Array<string | undefined> = [];
	return {
		ctx: {
			getContextUsage: () => ({ tokens: 25_000, contextWindow: 272_000, percent: 9.191 }),
			compact: async (instructions?: string) => {
				compactCalls.push(instructions);
			},
			sessionManager: {
				getUsageStatistics: () => ({
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					premiumRequests: 2,
					cost: 0.012345,
				}),
			},
			...overrides,
		},
		compactCalls,
	};
}

function fakeApi(initial: ThinkingLevel | undefined = ThinkingLevel.Off) {
	let level = initial;
	return {
		api: {
			getThinkingLevel: () => level,
			setThinkingLevel: (next: ThinkingLevel) => {
				level = next;
			},
		},
		get level() {
			return level;
		},
	};
}

describe("executeNotificationControlCommand", () => {
	test("reports context and usage without sending a user message", async () => {
		const { ctx } = fakeCtx();
		const { api } = fakeApi();
		expect(await executeNotificationControlCommand({ name: "context" }, ctx as any, api as any)).toEqual({
			status: "ok",
			message: "Context: 25k/272k 9.2%",
		});
		const usage = await executeNotificationControlCommand({ name: "usage" }, ctx as any, api as any);
		expect(usage.status).toBe("ok");
		expect(usage.message).toContain("Input tokens: 10");
		expect("sendUserMessage" in api).toBe(false);
	});

	test("sets reasoning and compacts with exact instructions", async () => {
		const { ctx, compactCalls } = fakeCtx();
		const apiState = fakeApi(ThinkingLevel.Off);
		const reasoning = await executeNotificationControlCommand(
			{ name: "reasoning", action: "set", level: "high" },
			ctx as any,
			apiState.api as any,
		);
		expect(reasoning).toEqual({ status: "ok", message: "Reasoning effort set to high." });
		expect(apiState.level).toBe(ThinkingLevel.High);

		const inherit = await executeNotificationControlCommand(
			{ name: "reasoning", action: "set", level: "inherit" },
			ctx as any,
			apiState.api as any,
		);
		expect(inherit).toEqual({ status: "ok", message: "Reasoning effort set to inherit." });
		expect(apiState.level).toBe(ThinkingLevel.Inherit);

		const compact = await executeNotificationControlCommand(
			{ name: "compact", instructions: "preserve API notes" },
			ctx as any,
			apiState.api as any,
		);
		expect(compact.status).toBe("ok");
		expect(compactCalls).toEqual(["preserve API notes"]);
	});

	test("compaction failures return deterministic errors", async () => {
		const { ctx } = fakeCtx({
			compact: async () => {
				throw new Error("too small");
			},
		});
		const { api } = fakeApi();
		expect(await executeNotificationControlCommand({ name: "compact" }, ctx as any, api as any)).toEqual({
			status: "error",
			message: "Compaction failed: too small",
		});
	});
});
