/**
 * Repro for #887 — OpenCode Go: Minimax M2.7 (and Qwen3.5/3.6 Plus) return 404
 * because the resolver routes them to anthropic-messages /v1/messages while
 * the OpenCode Go gateway only serves them at /v1/chat/completions.
 *
 * models.dev declares these ids with `provider.npm = "@ai-sdk/anthropic"`,
 * which by default would resolve to anthropic-messages on opencode-go. The
 * descriptor must override these specific ids to openai-completions so that
 * regenerated models.json keeps the correct routing.
 */
import { describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	type ModelsDevModel,
	mapModelsDevToModels,
} from "../src/provider-models/openai-compat";

const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";

describe("opencode-go resolver routes 404-ing ids to openai-completions (issue #887)", () => {
	const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "opencode-go");

	// Per upstream models.dev (verified 2026-05-02 against
	// https://models.dev/api.json["opencode-go"].models), these three ids carry
	// `provider.npm = "@ai-sdk/anthropic"`. The naive @ai-sdk/anthropic rule
	// would route them to /v1/messages on opencode.ai/zen/go which 404s.
	const npmAnthropic: ModelsDevModel = { provider: { npm: "@ai-sdk/anthropic" }, tool_call: true };

	test.each([
		["minimax-m2.5"],
		["minimax-m2.7"],
		["minimax-m3"],
		["qwen3.5-plus"],
		["qwen3.6-plus"],
		["qwen3.7-max"],
		["qwen3.7-plus"],
	])("%s resolves to openai-completions on /v1/chat/completions", modelId => {
		const resolved = descriptor?.resolveApi?.(modelId, npmAnthropic);
		expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_GO_BASE });
	});

	test("minimax-m2.5 (control: works empirically) also resolves to openai-completions", () => {
		// models.dev currently lists minimax-m2.5 without an explicit provider.npm,
		// so it falls through to the default openai-completions resolution.
		const m25: ModelsDevModel = { tool_call: true };
		const resolved = descriptor?.resolveApi?.("minimax-m2.5", m25);
		expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_GO_BASE });
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

		expect(qwen?.api).toBe("openai-completions");
		expect(qwen?.baseUrl).toBe(OPENCODE_GO_BASE);
		expect(qwen?.contextWindow).toBe(1_000_000);
		expect(qwen?.maxTokens).toBe(65_536);
		expect(qwen?.input).toEqual(["text", "image"]);
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
		expect(models.find(model => model.id === "qwen3.7-plus")?.maxTokens).toBe(64_000);
		expect(models.find(model => model.id === "hy3-preview")?.contextWindow).toBe(256_000);
	});
});
