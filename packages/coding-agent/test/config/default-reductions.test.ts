import { describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import { resolveForkContextMaxTokens } from "../../src/task";

const MODEL_WITH_200K_WINDOW: Model = {
	api: "openai-responses",
	provider: "openai",
	id: "test-200k",
	name: "test-200k",
	input: ["text"],
	baseUrl: "https://example.invalid",
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("PR10 default reductions", () => {
	test("task concurrency default remains mechanically tied to the applied reduction ledger", () => {
		expect(SETTINGS_SCHEMA["task.maxConcurrency"].default).toBe(8);
	});

	test("full fork-context token cap uses 15% with a 15k unknown-window fallback", () => {
		expect(resolveForkContextMaxTokens(0, MODEL_WITH_200K_WINDOW)).toBe(30_000);
		expect(resolveForkContextMaxTokens(0, undefined)).toBe(15_000);
	});
});
