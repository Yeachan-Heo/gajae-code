import { describe, expect, test } from "bun:test";
import { Effort, getSupportedEfforts } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import models from "../src/models.json" with { type: "json" };
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	type ModelsDevModel,
	mapModelsDevToModels,
} from "../src/provider-models/openai-compat";

const LIVE_OPENCODE_GO_MODEL_IDS = [
	"minimax-m3",
	"minimax-m2.7",
	"minimax-m2.5",
	"kimi-k3",
	"kimi-k2.7-code",
	"kimi-k2.6",
	"longcat-2.0",
	"longcat-2.5-preview-free",
	"kimi-k2.5",
	"glm-5.2",
	"glm-5.3-flash",
	"glm-5.3",
	"glm-5.1",
	"glm-5",
	"deepseek-v4-pro",
	"deepseek-v4.1-flash",
	"deepseek-v4-flash",
	"deepseek-v4-flash-vision-exp",
	"qwen3.7-max",
	"qwen3.8-max",
	"qwen3.8-flash",
	"qwen3.7-plus",
	"qwen3.6-plus",
	"qwen3.5-plus",
	"mimo-v2-pro",
	"mimo-v2-omni",
	"mimo-v2.5-pro",
	"mimo-v2.5",
	"mimo-v2.6-flash",
	"mimo-v2.6-pro",
	"hy4-preview",
	"hy3",
	"hy3-preview",
	"gpt-5.6-luna",
	"gpt-6-luna",
	"grok-4.5",
	"grok-4.6",
	"grok-4.7",
	"muse-spark-1.2-contributor",
	"muse-spark-1.3-contributor",
	"space-bunny-free",
	"union-alpha",
] as const;

const catalog = models["opencode-go"];

describe("OpenCode Go catalog parity", () => {
	test("bundles the provisional Muse 1.3 contract without advertising unsupported modalities", () => {
		const model = getBundledModel("opencode-go", "muse-spark-1.3-contributor");
		expect(model).toMatchObject({
			id: "muse-spark-1.3-contributor",
			name: "Muse Spark 1.3 Contributor",
			api: "openai-responses",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		});
		expect(model.input).toEqual(["text", "image"]);
		expect(getSupportedEfforts(model)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
	});

	test("routes only the exact Go Contributor id through the curated Responses override", () => {
		const ids = ["muse-spark-1.3-contributor", "muse-spark-1.3", "muse-spark-1.4-contributor"];
		const entries = Object.fromEntries(ids.map(id => [id, { name: id, tool_call: true }]));
		const mapped = mapModelsDevToModels({ "opencode-go": { models: entries } }, MODELS_DEV_PROVIDER_DESCRIPTORS);
		for (const id of ids) {
			expect(mapped.find(model => model.provider === "opencode-go" && model.id === id)?.api).toBe(
				id === "muse-spark-1.3-contributor" ? "openai-responses" : "openai-completions",
			);
		}
	});

	test("represents every id in the live provider fixture", () => {
		expect(Object.keys(catalog).sort()).toEqual([...LIVE_OPENCODE_GO_MODEL_IDS].sort());
	});

	test.each([
		[
			"deepseek-v4-flash-vision-exp",
			"openai-completions",
			"https://opencode.ai/zen/go/v1",
			["text", "image"],
			1_000_000,
			384_000,
		],
		["glm-5.3-flash", "openai-completions", "https://opencode.ai/zen/go/v1", ["text", "image"], 1_000_000, 131_072],
		["grok-4.6", "openai-responses", "https://opencode.ai/zen/go/v1", ["text", "image"], 500_000, 500_000],
		["hy4-preview", "openai-completions", "https://opencode.ai/zen/go/v1", ["text"], 1_024_000, 64_000],
		["longcat-2.0", "openai-completions", "https://opencode.ai/zen/go/v1", ["text"], 1_000_000, 131_072],
		[
			"muse-spark-1.2-contributor",
			"openai-responses",
			"https://opencode.ai/zen/go/v1",
			["text", "image"],
			1_048_576,
			131_072,
		],
		["qwen3.8-flash", "anthropic-messages", "https://opencode.ai/zen/go", ["text", "image"], 1_000_000, 131_072],
	] as const)("keeps authoritative metadata for %s", (id, api, baseUrl, input, contextWindow, maxTokens) => {
		const model = catalog[id];
		expect(model).toMatchObject({
			id,
			api,
			provider: "opencode-go",
			baseUrl,
			reasoning: true,
			input,
			contextWindow,
			maxTokens,
		});
		expect(model.cost).toEqual(
			expect.objectContaining({
				input: expect.any(Number),
				output: expect.any(Number),
				cacheRead: expect.any(Number),
			}),
		);
	});
});

/**
 * OpenCode Go contract guard.
 *
 * https://opencode.ai/docs/go/#endpoints is the source of truth for Go routing:
 * GLM/Kimi/DeepSeek/MiMo rows use /v1/chat/completions, while MiniMax and
 * current Qwen Plus/Max rows use /v1/messages. The data pages remain the
 * source of truth for context/output/modalities when a row is missing or stale
 * in models.dev.
 */
// #887
describe("opencode-go resolver follows the official Go endpoint and metadata contract", () => {
	const OPENCODE_GO_CHAT_BASE = "https://opencode.ai/zen/go/v1";
	const OPENCODE_GO_MESSAGES_BASE = "https://opencode.ai/zen/go";
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

	test.each([["minimax-m2.5"], ["minimax-m2.7"], ["minimax-m3"], ["qwen3.6-plus"], ["qwen3.7-max"], ["qwen3.7-plus"]])(
		"%s resolves to anthropic-messages on /v1/messages",
		modelId => {
			const resolved = descriptor?.resolveApi?.(modelId, { tool_call: true });
			expect(resolved).toEqual({ api: "anthropic-messages", baseUrl: OPENCODE_GO_MESSAGES_BASE });
		},
	);

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
