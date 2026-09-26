import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { hookFetch, Snowflake } from "@gajae-code/utils";

describe("OpenAI Models List Discovery - Reasoning Effort", () => {
	test("should extract reasoning efforts from endpoint response", () => {
		const endpointResponse = {
			reasoning_efforts: [
				{ value: "low", default: false },
				{ value: "medium", default: true },
				{ value: "high", default: false },
			],
		};

		// Verify endpoint response structure is correct
		expect(endpointResponse.reasoning_efforts).toHaveLength(3);
		expect(endpointResponse.reasoning_efforts[0].value).toBe("low");
		expect(endpointResponse.reasoning_efforts[1].value).toBe("medium");
		expect(endpointResponse.reasoning_efforts[1].default).toBe(true);
		expect(endpointResponse.reasoning_efforts[2].value).toBe("high");
	});

	test("should accept single advertised effort", () => {
		const endpointResponse = {
			reasoning_efforts: [{ value: "high", default: true }],
		};

		// Single efforts should be discoverable
		expect(endpointResponse.reasoning_efforts).toHaveLength(1);
		expect(endpointResponse.reasoning_efforts[0].value).toBe("high");
	});

	test("should handle non-canonical effort order", () => {
		const endpointResponse = {
			reasoning_efforts: [
				{ value: "high", default: false },
				{ value: "low", default: false },
				{ value: "medium", default: true },
			],
		};

		// Should be sortable to canonical order
		const sorted = endpointResponse.reasoning_efforts
			.map(e => e.value)
			.sort((a, b) => {
				const order = ["low", "medium", "high"];
				return order.indexOf(a) - order.indexOf(b);
			});

		expect(sorted).toEqual(["low", "medium", "high"]);
		expect(sorted[0]).toBe("low");
		expect(sorted[sorted.length - 1]).toBe("high");
	});

	test("should preserve aliased effort names", () => {
		const endpointResponse = {
			reasoning_efforts: [
				{ value: "low-think", default: false },
				{ value: "medium-think", default: true },
				{ value: "high-think", default: false },
			],
		};

		// Original aliases should be preserved
		const aliases = endpointResponse.reasoning_efforts.map(e => e.value);
		expect(aliases[0]).toBe("low-think");
		expect(aliases[1]).toBe("medium-think");
		expect(aliases[2]).toBe("high-think");

		// And mapped to Effort enum values
		const effortMap = {
			"low-think": Effort.Low,
			"medium-think": Effort.Medium,
			"high-think": Effort.High,
		};
		expect(Object.values(effortMap)).toContain(Effort.Low);
		expect(Object.values(effortMap)).toContain(Effort.Medium);
		expect(Object.values(effortMap)).toContain(Effort.High);
	});
});

describe("OpenAI Models List Discovery - ModelRegistry Integration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let previousPresetRegistryDisabled: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		previousPresetRegistryDisabled = Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "true";
		tempDir = path.join(os.tmpdir(), `pi-test-reasoning-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "test-auth.db"));
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (previousPresetRegistryDisabled === undefined) {
			delete Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		} else {
			Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = previousPresetRegistryDisabled;
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("ModelRegistry.refresh() extracts reasoning_efforts from OpenAI-compatible endpoint", async () => {
		// Configure a provider that supports reasoning effort discovery
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"test-provider": {
						baseUrl: "https://api.test.example.com/v1",
						apiKey: "test-key",
						api: "openai-completions",
						compat: { supportsReasoningEffort: true },
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);

		// Mock the /models endpoint to return reasoning_efforts
		using _hook = hookFetch((input) => {
			const url = String(input);
			if (url === "https://api.test.example.com/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "b-ai/deepseek-v4.1-flash",
								name: "Deepseek V4.1 Flash",
								max_output_tokens: 4096,
								contextWindow: 128000,
								reasoning_efforts: [
									{ value: "low", default: false },
									{ value: "medium", default: true },
									{ value: "high", default: false },
								],
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
			);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		const model = registry.find("test-provider", "b-ai/deepseek-v4.1-flash");
		expect(model).toBeDefined();
		if (!model) throw new Error("Model not found");

		// Verify the model has reasoning enabled and thinking config
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeDefined();
		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking?.minLevel).toBe(Effort.Low);
		expect(model.thinking?.maxLevel).toBe(Effort.High);
		expect(model.thinking?.defaultLevel).toBe(Effort.Medium);
		expect(model.thinking?.levels).toContain(Effort.Low);
		expect(model.thinking?.levels).toContain(Effort.Medium);
		expect(model.thinking?.levels).toContain(Effort.High);

		// Verify the compat field has the reasoning effort map for endpoint values
		const compat = model.compat as { reasoningEffortMap?: Record<string, string> } | undefined;
		expect(compat?.reasoningEffortMap).toBeDefined();
		expect(compat?.reasoningEffortMap?.[Effort.Low]).toBe("low");
		expect(compat?.reasoningEffortMap?.[Effort.Medium]).toBe("medium");
		expect(compat?.reasoningEffortMap?.[Effort.High]).toBe("high");

		// Verify getAll() returns the model with thinking config
		const allModels = registry.getAll();
		const modelFromAll = allModels.find(
			m => m.provider === "test-provider" && m.id === "b-ai/deepseek-v4.1-flash",
		);
		expect(modelFromAll).toBeDefined();
		expect(modelFromAll?.thinking).toBeDefined();
		expect(modelFromAll?.thinking?.mode).toBe("effort");
	});
});
