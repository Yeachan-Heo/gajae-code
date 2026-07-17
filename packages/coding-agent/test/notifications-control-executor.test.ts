import { describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";
import { executeNotificationControlCommand } from "../src/sdk/bus";

function fakeCtx(overrides: Record<string, unknown> = {}) {
	const compactCalls: Array<string | undefined> = [];
	return {
		ctx: {
			getContextUsage: () => ({
				tokens: 25_000,
				contextWindow: 272_000,
				percent: 9.191,
				source: "provider_anchor" as const,
			}),
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
			modelRegistry: {
				getAvailable: () => [],
			},
			...overrides,
		},
		compactCalls,
	};
}

function fakeApi(initial: ThinkingLevel | undefined = ThinkingLevel.Off) {
	let level = initial;
	let visibility: "visible" | "hidden" = "hidden";
	let scope: "session" | "global config" = "global config";
	let cycleResult: ThinkingLevel | undefined = initial;
	let usageReports: unknown = null;
	let temporaryModelAvailable = true;
	let thinkingLevelError: Error | undefined;
	let visibilityError: Error | undefined;
	let usageError: Error | undefined;
	const thinkingLevelCalls: Array<{ level: ThinkingLevel; persist: boolean }> = [];
	const visibilityCalls: Array<{ visibility: "visible" | "hidden"; persist: boolean }> = [];
	const temporaryModelCalls: unknown[] = [];
	const temporarySessionIds: Array<string | undefined> = [];
	let cycleCalls = 0;
	let usageFetchCalls = 0;
	return {
		api: {
			getThinkingLevel: () => level,
			getThinkingVisibility: () => visibility,
			getThinkingScopeForControl: () => scope,
			cycleThinkingLevel: () => {
				cycleCalls++;
				if (cycleResult === undefined) return undefined;
				level = cycleResult;
				scope = "session";
				return cycleResult;
			},
			setThinkingLevelForControl: async (next: ThinkingLevel, persist: boolean) => {
				await Promise.resolve();
				if (thinkingLevelError) throw thinkingLevelError;
				level = next;
				scope = persist || next === ThinkingLevel.Inherit ? "global config" : "session";
				thinkingLevelCalls.push({ level: next, persist });
			},
			setThinkingVisibilityForControl: async (next: "visible" | "hidden", persist: boolean) => {
				await Promise.resolve();
				if (visibilityError) throw visibilityError;
				visibility = next;
				visibilityCalls.push({ visibility: next, persist });
			},
			setModelTemporaryForControl: async (model: unknown, expectedSessionId?: string) => {
				await Promise.resolve();
				temporaryModelCalls.push(model);
				temporarySessionIds.push(expectedSessionId);
				return temporaryModelAvailable;
			},
			fetchUsageReportsForControl: async () => {
				usageFetchCalls++;
				if (usageError) throw usageError;
				return usageReports;
			},
		},
		get level() {
			return level;
		},
		get visibility() {
			return visibility;
		},
		get cycleCalls() {
			return cycleCalls;
		},
		get usageFetchCalls() {
			return usageFetchCalls;
		},
		thinkingLevelCalls,
		visibilityCalls,
		temporaryModelCalls,
		temporarySessionIds,
		setCycleResult(value: ThinkingLevel | undefined) {
			cycleResult = value;
		},
		setUsageReports(value: unknown) {
			usageReports = value;
		},
		setTemporaryModelAvailable(value: boolean) {
			temporaryModelAvailable = value;
		},
		failThinkingLevelControl(error: Error) {
			thinkingLevelError = error;
		},
		failVisibilityControl(error: Error) {
			visibilityError = error;
		},
		failUsageFetch(error: Error) {
			usageError = error;
		},
	};
}

const REASONING_USAGE =
	"Usage: /reasoning [cycle|inherit|reset|off|none|minimal|low|medium|high|xhigh|max|show|hide] [--global for set/reset/show/hide]";

function reasoningSettings(level: ThinkingLevel, scope: "session" | "global config", display: "on" | "off"): string {
	return ["🧠 Reasoning Settings", `Effort: ${level}`, `Scope: ${scope}`, `Display: ${display}`, REASONING_USAGE].join(
		"\n",
	);
}

describe("executeNotificationControlCommand", () => {
	test("reports context and local usage without sending a user message", async () => {
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

	test("reports reasoning display and persists only global mutations", async () => {
		const { ctx, compactCalls } = fakeCtx();
		const apiState = fakeApi(ThinkingLevel.Off);
		expect(
			await executeNotificationControlCommand(
				{ name: "reasoning", action: "status" },
				ctx as any,
				apiState.api as any,
			),
		).toEqual({
			status: "ok",
			message: reasoningSettings(ThinkingLevel.Off, "global config", "off"),
		});

		const reasoning = await executeNotificationControlCommand(
			{ name: "reasoning", action: "set", level: "high", global: true },
			ctx as any,
			apiState.api as any,
		);
		expect(reasoning).toEqual({
			status: "ok",
			message: reasoningSettings(ThinkingLevel.High, "global config", "off"),
		});
		expect(apiState.thinkingLevelCalls).toEqual([{ level: ThinkingLevel.High, persist: true }]);

		const show = await executeNotificationControlCommand(
			{ name: "reasoning", action: "show" },
			ctx as any,
			apiState.api as any,
		);
		expect(show).toEqual({ status: "ok", message: reasoningSettings(ThinkingLevel.High, "global config", "on") });

		const hide = await executeNotificationControlCommand(
			{ name: "reasoning", action: "hide", global: true },
			ctx as any,
			apiState.api as any,
		);
		expect(hide).toEqual({ status: "ok", message: reasoningSettings(ThinkingLevel.High, "global config", "off") });
		expect(apiState.visibilityCalls).toEqual([
			{ visibility: "visible", persist: false },
			{ visibility: "hidden", persist: true },
		]);

		const compact = await executeNotificationControlCommand(
			{ name: "compact", instructions: "preserve API notes" },
			ctx as any,
			apiState.api as any,
		);
		expect(compact.status).toBe("ok");
		expect(compactCalls).toEqual(["preserve API notes"]);
	});

	test("delegates thinking cycles to the model-aware session control", async () => {
		const { ctx } = fakeCtx();
		const apiState = fakeApi(ThinkingLevel.Off);
		apiState.setCycleResult(ThinkingLevel.XHigh);

		expect(
			await executeNotificationControlCommand(
				{ name: "reasoning", action: "cycle" },
				ctx as any,
				apiState.api as any,
			),
		).toEqual({
			status: "ok",
			message: reasoningSettings(ThinkingLevel.XHigh, "session", "off"),
		});
		expect(apiState.cycleCalls).toBe(1);

		apiState.setCycleResult(undefined);
		expect(
			await executeNotificationControlCommand(
				{ name: "reasoning", action: "cycle" },
				ctx as any,
				apiState.api as any,
			),
		).toEqual({
			status: "unavailable",
			message: "Reasoning effort unavailable for this session.",
		});
		expect(apiState.cycleCalls).toBe(2);
	});

	test("fetches canonical usage reports and projects only safe window fields", async () => {
		const secret = "credential-sentinel@example.invalid";
		const { ctx } = fakeCtx({
			modelRegistry: {
				authStorage: {
					fetchUsageReports: async () => {
						throw new Error(secret);
					},
				},
				getAvailable: () => [],
			},
		});
		const apiState = fakeApi();
		apiState.setUsageReports([
			{
				provider: secret,
				metadata: { accountId: secret, email: secret, baseUrl: secret },
				raw: { accessToken: secret },
				limits: [
					{
						id: "7d",
						scope: { accountId: secret },
						window: { id: "7d", label: secret, resetsAt: Date.UTC(2026, 0, 9, 3, 4, 5) },
						amount: { usedFraction: 0.25 },
					},
					{
						id: "other",
						scope: { accountId: secret },
						window: {
							id: "other",
							label: "5 Hour",
							durationMs: 5 * 60 * 60_000,
							resetsAt: Date.UTC(2026, 0, 2, 3, 4, 5),
						},
						amount: { usedFraction: 0.5 },
					},
					{
						id: "5h",
						window: { id: "5h", label: "Duplicate", resetsAt: Date.UTC(2027, 0, 2, 3, 4, 5) },
						amount: { usedFraction: 0.9 },
					},
				],
			},
		]);

		const usage = await executeNotificationControlCommand({ name: "usage" }, ctx as any, apiState.api as any);
		expect(usage).toEqual({
			status: "ok",
			message: [
				"Usage",
				"Input tokens: 10",
				"Output tokens: 20",
				"Cache read tokens: 30",
				"Cache write tokens: 40",
				"Premium requests: 2",
				"Cost: $0.012345",
				"",
				"Usage windows",
				"5-hour limit — 90% used — resets 2027-01-02 03:04:05 UTC",
				"Weekly limit — 25% used — resets 2026-01-09 03:04:05 UTC",
			].join("\n"),
		});
		expect(apiState.usageFetchCalls).toBe(1);
		expect(usage.message).not.toContain(secret);
		expect(usage.message).not.toContain("Duplicate");
	});

	test("keeps local usage and emits a secret-safe log when canonical usage fetch fails", async () => {
		const secret = "credential-sentinel@example.invalid";
		const { ctx } = fakeCtx();
		const apiState = fakeApi();
		apiState.failUsageFetch(new Error(secret));
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const usage = await executeNotificationControlCommand({ name: "usage" }, ctx as any, apiState.api as any);
			expect(usage).toEqual({
				status: "ok",
				message: [
					"Usage",
					"Input tokens: 10",
					"Output tokens: 20",
					"Cache read tokens: 30",
					"Cache write tokens: 40",
					"Premium requests: 2",
					"Cost: $0.012345",
				].join("\n"),
			});
			expect(apiState.usageFetchCalls).toBe(1);
			expect(warning).toHaveBeenCalledWith("notifications: usage report fetch failed");
			const logged = warning.mock.calls.map(call => call.join(" ")).join(" ");
			expect(`${usage.message}\n${logged}`).not.toContain(secret);
		} finally {
			warning.mockRestore();
		}
	});

	test("lists safe available models and uses only the session-temporary setter", async () => {
		const models = [
			{ provider: "zeta", id: "second", name: "credential-sentinel" },
			{ provider: "alpha", id: "first", name: "Friendly name" },
		];
		const { ctx } = fakeCtx({
			modelRegistry: {
				getAvailable: () => models,
			},
		});
		const apiState = fakeApi();
		expect(
			await executeNotificationControlCommand({ name: "model", action: "list" }, ctx as any, apiState.api as any),
		).toEqual({
			status: "ok",
			message: "Select a model.",
			modelChoices: [
				{ selector: "alpha/first", label: "alpha/first" },
				{ selector: "zeta/second", label: "zeta/second" },
			],
		});
		expect(
			await executeNotificationControlCommand(
				{ name: "model", action: "set", selector: "alpha/first" },
				ctx as any,
				apiState.api as any,
				"logical-session",
			),
		).toEqual({ status: "ok", message: "Model set to alpha/first." });
		expect(apiState.temporaryModelCalls).toEqual([models[1]]);
		expect(apiState.temporarySessionIds).toEqual(["logical-session"]);
		expect(
			await executeNotificationControlCommand(
				{ name: "model", action: "set", selector: "alpha/other" },
				ctx as any,
				apiState.api as any,
			),
		).toEqual({ status: "error", message: "Invalid model selection." });

		apiState.setTemporaryModelAvailable(false);
		expect(
			await executeNotificationControlCommand(
				{ name: "model", action: "set", selector: "alpha/first" },
				ctx as any,
				apiState.api as any,
			),
		).toEqual({ status: "unavailable", message: "Model unavailable for this session." });
	});

	test("bounds Telegram model choices while preserving text selection", async () => {
		const models = Array.from({ length: 45 }, (_, index) => ({ provider: "provider", id: `model-${index}` }));
		const { ctx } = fakeCtx({
			modelRegistry: {
				getAvailable: () => models,
			},
		});
		const { api } = fakeApi();
		const result = await executeNotificationControlCommand({ name: "model", action: "list" }, ctx as any, api as any);
		expect(result.status).toBe("ok");
		expect(result.modelChoices).toHaveLength(40);
		expect(result.modelChoices?.[0]?.selector).toBe("provider/model-0");
	});

	test("maps global persistence failures to a fixed public message and safe log", async () => {
		const secret = "credential-sentinel@example.invalid";
		const { ctx } = fakeCtx();
		const apiState = fakeApi();
		apiState.failThinkingLevelControl(new Error(secret));
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await executeNotificationControlCommand(
				{ name: "reasoning", action: "set", level: "high", global: true },
				ctx as any,
				apiState.api as any,
			);
			expect(result).toEqual({ status: "error", message: "Control command failed." });
			expect(apiState.thinkingLevelCalls).toEqual([]);
			expect(warning).toHaveBeenCalledWith("notifications: control command failed");
			const logged = warning.mock.calls.map(call => call.join(" ")).join(" ");
			expect(`${result.message}\n${logged}`).not.toContain(secret);
		} finally {
			warning.mockRestore();
		}
	});
	test("maps display persistence failures to the fixed control error", async () => {
		const secret = "credential-sentinel@example.invalid";
		const { ctx } = fakeCtx();
		const apiState = fakeApi();
		apiState.failVisibilityControl(new Error(secret));
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await executeNotificationControlCommand(
				{ name: "reasoning", action: "show", global: true },
				ctx as any,
				apiState.api as any,
			);
			expect(result).toEqual({ status: "error", message: "Control command failed." });
			expect(apiState.visibilityCalls).toEqual([]);
			const logged = warning.mock.calls.map(call => call.join(" ")).join(" ");
			expect(`${result.message}\n${logged}`).not.toContain(secret);
		} finally {
			warning.mockRestore();
		}
	});
	test("maps compaction failures to the fixed control error and safe log", async () => {
		const secret = "credential-sentinel@example.invalid";
		const { ctx } = fakeCtx({
			compact: async () => {
				throw new Error(secret);
			},
		});
		const { api } = fakeApi();
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await executeNotificationControlCommand({ name: "compact" }, ctx as any, api as any);
			expect(result).toEqual({ status: "error", message: "Control command failed." });
			expect(warning).toHaveBeenCalledWith("notifications: control command failed");
			const logged = warning.mock.calls.map(call => call.join(" ")).join(" ");
			expect(`${result.message}\n${logged}`).not.toContain(secret);
		} finally {
			warning.mockRestore();
		}
	});
});
