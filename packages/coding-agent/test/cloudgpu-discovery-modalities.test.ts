import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@gajae-code/utils";
import providerPresets from "../src/setup/provider-presets.json";

// Shaped like CloudGPU's public /v1/models rows: every entry carries type,
// input_modalities, and output_modalities. Chat rows are text in and text
// out. Image and speech rows also take text in. Transcription rows emit
// text from audio in.
const CLOUDGPU_CATALOG = {
	object: "list",
	data: [
		{
			id: "auto",
			object: "model",
			owned_by: "cloudgpu",
			type: "chat",
			input_modalities: ["text"],
			output_modalities: ["text"],
		},
		{
			id: "deepseek-v4.1-flash",
			object: "model",
			owned_by: "cloudgpu",
			type: "chat",
			input_modalities: ["text"],
			output_modalities: ["text"],
			context_length: 131072,
		},
		{
			id: "glm-5.2",
			object: "model",
			owned_by: "cloudgpu",
			type: "chat",
			input_modalities: ["text"],
			output_modalities: ["text"],
			context_length: 131072,
		},
		{
			id: "kimi-k3",
			object: "model",
			owned_by: "cloudgpu",
			type: "chat",
			input_modalities: ["text"],
			output_modalities: ["text"],
			context_length: 262144,
		},
		{
			id: "minimax-m3",
			object: "model",
			owned_by: "cloudgpu",
			type: "chat",
			input_modalities: ["text"],
			output_modalities: ["text"],
			context_length: 1000000,
		},
		{
			id: "qwen3-coder-480b",
			object: "model",
			owned_by: "cloudgpu",
			type: "chat",
			input_modalities: ["text"],
			output_modalities: ["text"],
			context_length: 262144,
		},
		{
			id: "flux-1-schnell",
			object: "model",
			owned_by: "cloudgpu",
			type: "image",
			input_modalities: ["text"],
			output_modalities: ["image"],
		},
		{
			id: "flux-2-dev",
			object: "model",
			owned_by: "cloudgpu",
			type: "image",
			input_modalities: ["text"],
			output_modalities: ["image"],
		},
		{
			id: "chatterbox-tts",
			object: "model",
			owned_by: "cloudgpu",
			type: "tts",
			input_modalities: ["text"],
			output_modalities: ["audio"],
		},
		{
			id: "kokoro-tts",
			object: "model",
			owned_by: "cloudgpu",
			type: "tts",
			input_modalities: ["text"],
			output_modalities: ["audio"],
		},
		{
			id: "qwen3-asr",
			object: "model",
			owned_by: "cloudgpu",
			type: "transcription",
			input_modalities: ["audio"],
			output_modalities: ["text"],
		},
		{
			id: "whisper-v3",
			object: "model",
			owned_by: "cloudgpu",
			type: "transcription",
			input_modalities: ["audio"],
			output_modalities: ["text"],
		},
		{
			id: "whisper-v3-turbo",
			object: "model",
			owned_by: "cloudgpu",
			type: "transcription",
			input_modalities: ["audio"],
			output_modalities: ["text"],
		},
	],
};

const CHAT_IDS = ["auto", "deepseek-v4.1-flash", "glm-5.2", "kimi-k3", "minimax-m3", "qwen3-coder-480b"];

function sortedIds(ids: readonly string[]): string[] {
	return [...ids].sort((a, b) => a.localeCompare(b));
}

const cloudgpuPreset = providerPresets.find(preset => preset.id === "cloudgpu");

describe("CloudGPU openai-models-list discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let previousPresetRegistryDisabled: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		previousPresetRegistryDisabled = Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "true";
		tempDir = path.join(os.tmpdir(), `gjc-test-cloudgpu-discovery-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "test-auth.db"));
	});

	afterEach(async () => {
		resetSettingsForTest();
		authStorage.close();
		if (previousPresetRegistryDisabled === undefined) {
			delete Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		} else {
			Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = previousPresetRegistryDisabled;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function discover(
		providerId: string,
		discovery: unknown,
		catalog: unknown = CLOUDGPU_CATALOG,
	): Promise<string[]> {
		await Bun.write(
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
				return new Response(JSON.stringify(catalog), {
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

	test("the CloudGPU preset exposes only chat-capable rows from a mixed catalog", async () => {
		expect(cloudgpuPreset?.discovery).toEqual({
			type: "openai-models-list",
			outputModalities: ["text"],
			inputModalities: ["text"],
		});

		const ids = await discover("cloudgpu", cloudgpuPreset?.discovery);

		expect(ids).toEqual(CHAT_IDS);
	});

	test("outputModalities text alone still admits CloudGPU transcription rows", async () => {
		const ids = await discover("cloudgpu", { type: "openai-models-list", outputModalities: ["text"] });

		expect(ids).toEqual(sortedIds([...CHAT_IDS, "qwen3-asr", "whisper-v3", "whisper-v3-turbo"]));
	});

	test("inputModalities text alone still admits CloudGPU image and speech rows", async () => {
		const ids = await discover("cloudgpu", { type: "openai-models-list", inputModalities: ["text"] });

		expect(ids).toEqual(sortedIds([...CHAT_IDS, "chatterbox-tts", "flux-1-schnell", "flux-2-dev", "kokoro-tts"]));
	});

	test("inputModalities skips rows that omit the field or advertise another modality", async () => {
		const ids = await discover(
			"cloudgpu",
			{ type: "openai-models-list", inputModalities: ["text"], outputModalities: ["text"] },
			{
				object: "list",
				data: [
					{
						id: "text-chat",
						object: "model",
						type: "chat",
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
					{
						id: "mixed-input",
						object: "model",
						type: "chat",
						input_modalities: ["text", "audio"],
						output_modalities: ["text"],
					},
					{ id: "unclassified", object: "model", type: "chat", output_modalities: ["text"] },
				],
			},
		);

		expect(ids).toEqual(["text-chat"]);
	});
});
