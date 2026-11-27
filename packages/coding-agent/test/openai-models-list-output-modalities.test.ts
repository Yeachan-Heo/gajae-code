import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@gajae-code/utils";
import providerPresets from "../src/setup/provider-presets.json";

// A catalog shaped like Runcrate's live /v1/models: chat rows advertise
// text-only output, the rest advertise image, audio, video or embeddings.
const MIXED_CATALOG = {
	data: [
		{ id: "deepseek-ai/DeepSeek-V3.1", context_length: 131072, output_modalities: ["text"] },
		{ id: "Qwen/Qwen3-Coder-480B", input_modalities: ["text"], output_modalities: ["text"] },
		{ id: "black-forest-labs/FLUX.1-schnell", output_modalities: ["image"] },
		{ id: "hexgrad/Kokoro-82M", output_modalities: ["audio"] },
		{ id: "Wan-AI/Wan2.2-T2V", output_modalities: ["video"] },
		{ id: "BAAI/bge-m3", output_modalities: ["embeddings"] },
		{ id: "vendor/text-and-image", output_modalities: ["text", "image"] },
		{ id: "vendor/unclassified" },
	],
};

const CHAT_IDS = ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-Coder-480B"];

const runcratePreset = providerPresets.find(preset => preset.id === "runcrate");

describe("openai-models-list discovery outputModalities", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let previousPresetRegistryDisabled: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		previousPresetRegistryDisabled = Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "true";
		tempDir = path.join(os.tmpdir(), `gjc-test-output-modalities-${Snowflake.next()}`);
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
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function discover(providerId: string, discovery: unknown): Promise<string[]> {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerId]: {
						baseUrl: "https://catalog.test.example/v1",
						apiKey: "test-key",
						api: "openai-completions",
						discovery,
					},
				},
			}),
		);
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url === "https://catalog.test.example/v1/models") {
				return new Response(JSON.stringify(MIXED_CATALOG), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();
		return registry
			.getAll()
			.filter(model => model.provider === providerId)
			.map(model => model.id)
			.sort((a, b) => a.localeCompare(b));
	}

	test("the Runcrate preset admits only text-output rows from a mixed catalog", async () => {
		expect(runcratePreset?.discovery).toEqual({ type: "openai-models-list", outputModalities: ["text"] });

		const ids = await discover("runcrate", runcratePreset?.discovery);

		expect(ids).toEqual(CHAT_IDS);
	});

	test("providers without outputModalities keep admitting every safe row", async () => {
		const ids = await discover("plain-proxy", { type: "openai-models-list" });

		expect(ids).toEqual(MIXED_CATALOG.data.map(row => row.id).sort((a, b) => a.localeCompare(b)));
	});
});
