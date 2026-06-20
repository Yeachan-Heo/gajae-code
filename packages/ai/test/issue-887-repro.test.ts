/**
 * OpenCode Go contract guard.
 *
 * https://opencode.ai/docs/go/#endpoints is the source of truth for Go routing:
 * GLM/Kimi/DeepSeek/MiMo rows use /v1/chat/completions, while MiniMax and
 * current Qwen Plus/Max rows use /v1/messages. The data pages remain the
 * source of truth for context/output/modalities when a row is missing or stale
 * in models.dev.
 */
import { describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	type ModelsDevModel,
	mapModelsDevToModels,
} from "../src/provider-models/openai-compat";

const OPENCODE_GO_CHAT_BASE = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_MESSAGES_BASE = "https://opencode.ai/zen/go";

describe("opencode-go resolver follows the official Go endpoint and metadata contract", () => {
	const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "opencode-go");
	const npmAnthropic: ModelsDevModel = { provider: { npm: "@ai-sdk/anthropic" }, tool_call: true };

	test.each([
		["deepseek-v4-flash"],
		["deepseek-v4-pro"],
		["glm-5.1"],
		["glm-5.2"],
		["kimi-k2.6"],
		["kimi-k2.7-code"],
		["mimo-v2.5"],
		["mimo-v2.5-pro"],
	])("%s resolves to openai-completions on /v1/chat/completions", modelId => {
		const resolved = descriptor?.resolveApi?.(modelId, npmAnthropic);
		expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_GO_CHAT_BASE });
	});

	test.each([
		["minimax-m2.5"],
		["minimax-m2.7"],
		["minimax-m3"],
		["qwen3.6-plus"],
		["qwen3.7-max"],
		["qwen3.7-plus"],
	])("%s resolves to anthropic-messages on /v1/messages", modelId => {
		const resolved = descriptor?.resolveApi?.(modelId, { tool_call: true });
		expect(resolved).toEqual({ api: "anthropic-messages", baseUrl: OPENCODE_GO_MESSAGES_BASE });
	});

	test("models.dev rows are corrected to official OpenCode Go context/output metadata", () => {
		const models = mapModelsDevToModels(
			{
				"opencode-go": {
					models: {
						"qwen3.5-plus": {
							name: "Qwen3.5 Plus",
							tool_call: true,
							reasoning: true,
							provider: { npm: "@ai-sdk/anthropic" },
							limit: { context: 262144, output: 65536 },
							modalities: { input: ["text", "image", "video"] },
						},
					},
				},
			},
			descriptor ? [descriptor] : [],
		);
		const qwen = models.find(model => model.id === "qwen3.5-plus");

		expect(qwen?.contextWindow).toBe(1_000_000);
		expect(qwen?.maxTokens).toBe(65_536);
		expect(qwen?.input).toEqual(["text", "image"]);
	});

	test("official Go prices override generic data-page prices for current Go rows", () => {
		const models = mapModelsDevToModels(
			{
				"opencode-go": {
					models: {},
				},
			},
			descriptor ? [descriptor] : [],
		);

		expect(models.find(model => model.id === "glm-5.1")?.cost).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
		});
		expect(models.find(model => model.id === "deepseek-v4-pro")?.cost).toEqual({
			input: 1.74,
			output: 3.48,
			cacheRead: 0.0145,
			cacheWrite: 0,
		});
		expect(models.find(model => model.id === "minimax-m3")?.cost).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0,
		});
		expect(models.find(model => model.id === "mimo-v2.5-pro")?.cost).toEqual({
			input: 1.74,
			output: 3.48,
			cacheRead: 0.0145,
			cacheWrite: 0,
		});
		expect(models.find(model => model.id === "qwen3.7-plus")?.cost).toEqual({
			input: 1.2,
			output: 4.8,
			cacheRead: 0.12,
			cacheWrite: 1.5,
		});
	});

	test("official OpenCode Go rows absent from models.dev are appended for generation", () => {
		const models = mapModelsDevToModels(
			{
				"opencode-go": {
					models: {},
				},
			},
			descriptor ? [descriptor] : [],
		);

		expect(models.find(model => model.id === "glm-5.2")?.contextWindow).toBe(1_000_000);
		expect(models.find(model => model.id === "glm-5.2")?.maxTokens).toBe(131_072);
		expect(models.find(model => model.id === "kimi-k2.7-code")?.maxTokens).toBe(262_144);
		expect(models.find(model => model.id === "minimax-m3")?.maxTokens).toBe(128_000);
		expect(models.find(model => model.id === "minimax-m3")?.api).toBe("anthropic-messages");
		expect(models.find(model => model.id === "minimax-m3")?.baseUrl).toBe(OPENCODE_GO_MESSAGES_BASE);
		expect(models.find(model => model.id === "qwen3.7-plus")?.maxTokens).toBe(64_000);
		expect(models.find(model => model.id === "qwen3.7-plus")?.api).toBe("anthropic-messages");
		expect(models.find(model => model.id === "qwen3.7-plus")?.baseUrl).toBe(OPENCODE_GO_MESSAGES_BASE);
		expect(models.find(model => model.id === "hy3-preview")?.contextWindow).toBe(256_000);
	});
});
