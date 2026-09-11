import { describe, expect, test } from "bun:test";
import { Effort, getSupportedEfforts } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import models from "../src/models.json" with { type: "json" };
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "../src/provider-models/openai-compat";

const LIVE_OPENCODE_GO_MODEL_IDS = [
	"minimax-m3",
	"minimax-m2.7",
	"minimax-m2.5",
	"kimi-k3",
	"kimi-k2.7-code",
	"kimi-k2.6",
	"longcat-2.0",
	"kimi-k2.5",
	"glm-5.2",
	"glm-5.3-flash",
	"glm-5.3",
	"glm-5.1",
	"glm-5",
	"deepseek-v4-pro",
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
	"hy4-preview",
	"hy3",
	"hy3-preview",
	"gpt-5.6-luna",
	"grok-4.5",
	"grok-4.6",
	"muse-spark-1.2-contributor",
	"muse-spark-1.3-contributor",
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
