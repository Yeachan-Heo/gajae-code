import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@gajae-code/utils";

// Rows shaped like a gateway catalog: none of these IDs has bundled reference
// metadata, so the endpoint is the only source for image support.
const CATALOG = {
	data: [
		{ id: "gateway/vision-top-level", input_modalities: ["text", "image"] },
		{ id: "gateway/vision-capabilities", capabilities: { input_modalities: ["text", "image"] } },
		{ id: "gateway/text-capabilities", capabilities: { input_modalities: ["text"] } },
		{ id: "gateway/unadvertised" },
		{ id: "gateway/empty-list", capabilities: { input_modalities: [] } },
		{ id: "gateway/malformed", capabilities: { input_modalities: ["text", 7] } },
		// These leaf IDs do have bundled reference metadata with image input.
		{ id: "gpt-4o", capabilities: { input_modalities: ["text"] } },
		{ id: "gpt-4o-mini" },
		{ id: "empty/gpt-4o-mini", capabilities: { input_modalities: [] } },
		{ id: "malformed/gpt-4o-mini", capabilities: { input_modalities: ["text", 7] } },
	],
};

describe("openai-models-list discovery input modalities", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let previousPresetRegistryDisabled: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		previousPresetRegistryDisabled = Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "true";
		tempDir = path.join(os.tmpdir(), `gjc-test-input-modalities-${Snowflake.next()}`);
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

	async function discoverInputs(): Promise<Record<string, string[]>> {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"plain-proxy": {
						baseUrl: "https://catalog.test.example/v1",
						apiKey: "test-key",
						api: "openai-completions",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url === "https://catalog.test.example/v1/models") {
				return new Response(JSON.stringify(CATALOG), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();
		return Object.fromEntries(
			registry
				.getAll()
				.filter(model => model.provider === "plain-proxy")
				.map(model => [model.id, [...model.input]]),
		);
	}

	test("rows that advertise image input are discovered as image-capable", async () => {
		const inputs = await discoverInputs();

		expect(inputs["gateway/vision-top-level"]).toEqual(["text", "image"]);
		expect(inputs["gateway/vision-capabilities"]).toEqual(["text", "image"]);
	});

	test("rows that advertise text only, nothing, or an unusable list stay text-only", async () => {
		const inputs = await discoverInputs();

		expect(inputs["gateway/text-capabilities"]).toEqual(["text"]);
		expect(inputs["gateway/unadvertised"]).toEqual(["text"]);
		expect(inputs["gateway/empty-list"]).toEqual(["text"]);
		expect(inputs["gateway/malformed"]).toEqual(["text"]);
	});

	test("an advertised list wins over reference metadata, which still fills unadvertised rows", async () => {
		const inputs = await discoverInputs();

		expect(inputs["gpt-4o"]).toEqual(["text"]);
		expect(inputs["gpt-4o-mini"]).toEqual(["text", "image"]);
	});

	test("an empty or malformed advertised list is ignored in favour of reference metadata", async () => {
		const inputs = await discoverInputs();

		expect(inputs["empty/gpt-4o-mini"]).toEqual(["text", "image"]);
		expect(inputs["malformed/gpt-4o-mini"]).toEqual(["text", "image"]);
	});
});
