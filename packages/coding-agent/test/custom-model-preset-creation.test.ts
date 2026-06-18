import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { CustomModelPresetWizardComponent } from "@gajae-code/coding-agent/modes/components/custom-model-preset-wizard";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
} from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";
import { YAML } from "bun";

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-custom-preset-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	setThemeInstance((await getThemeByName("red-claw"))!);
});

afterEach(async () => {
	authStorage.close();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function typeText(component: { handleInput(input: string): void }, value: string): void {
	for (const char of value) component.handleInput(char);
	component.handleInput("\n");
}

function normalizeRenderedText(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("custom model preset creation", () => {
	it("validates wizard input with human-readable errors and never asks for secrets", () => {
		const submitted: unknown[] = [];
		const wizard = new CustomModelPresetWizardComponent(
			input => submitted.push(input),
			() => {},
			() => {},
		);

		typeText(wizard, "Bad Name");
		let text = normalizeRenderedText(wizard.render(120).join("\n"));
		expect(text).toContain("Preset id must use lowercase letters, numbers, dots, underscores, or hyphens.");
		expect(text).not.toContain("API key");
		expect(text).not.toContain("secret");

		typeText(wizard, "my-fast");
		typeText(wizard, "My Fast");
		typeText(wizard, "bad provider");
		text = normalizeRenderedText(wizard.render(120).join("\n"));
		expect(text).toContain("Provider id must use lowercase letters, numbers, dots, underscores, or hyphens.");
		expect(submitted).toEqual([]);
	});

	it("persists a custom preset and includes it in later registry sessions", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);

		const profile = await registry.saveCustomModelProfile("my-fast", {
			display_name: "My Fast",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});

		expect(profile.displayName).toBe("My Fast");
		expect(registry.getModelProfile("my-fast")?.modelMapping.default).toBe("my-oai/gpt-custom:low");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<
				string,
				{ display_name?: string; required_providers: string[]; model_mapping: Record<string, string> }
			>;
		};
		expect(parsed.profiles["my-fast"]?.display_name).toBe("My Fast");
		expect(parsed.profiles["my-fast"]?.required_providers).toEqual(["my-oai"]);
		expect(parsed.profiles["my-fast"]?.model_mapping.default).toBe("my-oai/gpt-custom:low");

		const laterRegistry = new ModelRegistry(authStorage, modelsPath);
		expect(laterRegistry.getAvailableModelProfileNames()).toContain("my-fast");
		expect(laterRegistry.getModelProfile("my-fast")?.displayName).toBe("My Fast");
	});

	it("rejects creating a preset when existing models config is invalid and preserves it", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const original = [
			"providers:",
			"  my-oai:",
			"    baseUrl: https://proxy.example.com/v1",
			"    apiKeyEnv: MY_OAI_KEY",
			"profiles:",
			"  existing:",
			"    required_providers: [my-oai]",
			"    model_mapping:",
			"      default: my-oai/original",
			"unexpected_top_level: must-stay",
			"",
		].join("\n");
		await Bun.write(modelsPath, original);
		const registry = new ModelRegistry(authStorage, modelsPath);

		await expect(
			registry.saveCustomModelProfile("my-fast", {
				display_name: "My Fast",
				required_providers: ["my-oai"],
				model_mapping: { default: "my-oai/gpt-custom:low" },
			}),
		).rejects.toThrow("Cannot create custom model profile because");

		expect(await Bun.file(modelsPath).text()).toBe(original);
	});

	it("rejects duplicate custom preset ids without overwriting existing profiles or providers", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  my-oai:",
				"    baseUrl: https://proxy.example.com/v1",
				"    apiKeyEnv: MY_OAI_KEY",
				"profiles:",
				"  my-fast:",
				"    display_name: Original Fast",
				"    required_providers: [my-oai]",
				"    model_mapping:",
				"      default: my-oai/original",
				"",
			].join("\n"),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);

		await expect(
			registry.saveCustomModelProfile("my-fast", {
				display_name: "Replacement Fast",
				required_providers: ["other-provider"],
				model_mapping: { default: "other-provider/replacement" },
			}),
		).rejects.toThrow("Custom model profile already exists: my-fast");

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { apiKeyEnv?: string }>;
			profiles: Record<
				string,
				{ display_name?: string; required_providers: string[]; model_mapping: Record<string, string> }
			>;
		};
		expect(parsed.providers["my-oai"]?.apiKeyEnv).toBe("MY_OAI_KEY");
		expect(parsed.providers["other-provider"]).toBeUndefined();
		expect(parsed.profiles["my-fast"]?.display_name).toBe("Original Fast");
		expect(parsed.profiles["my-fast"]?.required_providers).toEqual(["my-oai"]);
		expect(parsed.profiles["my-fast"]?.model_mapping.default).toBe("my-oai/original");
	});

	it("rejects custom preset ids that shadow built-in presets", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);

		await expect(
			registry.saveCustomModelProfile("codex-medium", {
				display_name: "Shadow Codex",
				required_providers: ["my-oai"],
				model_mapping: { default: "my-oai/gpt-custom:low" },
			}),
		).rejects.toThrow("Custom model profile already exists: codex-medium");
		await expect(Bun.file(modelsPath).exists()).resolves.toBe(false);
	});

	it("rejects invalid persisted profile selectors with clear messages", async () => {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		await expect(
			registry.saveCustomModelProfile("broken", {
				display_name: "Broken",
				required_providers: ["my-oai"],
				model_mapping: { default: "missing-provider-slash" },
			}),
		).rejects.toThrow("Expected provider/modelId with optional :effort suffix");
	});

	it("surfaces create custom preset as a separate preset action", async () => {
		const registry = {
			refresh: async () => {},
			getError: () => undefined,
			getAll: () => [],
			getProviders: () => [],
			getCanonicalModels: () => [],
			getDiscoverableProviders: () => [],
			findCanonicalModel: () => undefined,
			resolveCanonicalModel: () => undefined,
			getModelProfiles: () =>
				new Map([
					[
						"my-fast",
						{
							name: "my-fast",
							displayName: "My Fast",
							requiredProviders: ["my-oai"],
							modelMapping: { default: "my-oai/gpt-custom" },
							source: "user" as const,
						},
					],
				]),
			getModelProfile: (name: string) => registry.getModelProfiles().get(name),
			getApiKeyForProvider: async () => "key",
		} as unknown as ModelRegistry;
		const selections: ModelSelectorSelection[] = [];
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			undefined,
			Settings.isolated({}),
			registry,
			[],
			selection => {
				selections.push(selection);
			},
			() => {},
		);
		await new Promise(resolve => setTimeout(resolve, 0));

		let text = normalizeRenderedText(selector.render(180).join("\n"));
		expect(text).toContain("CUSTOM");
		selector.handleInput("\x1b[C");
		text = normalizeRenderedText(selector.render(180).join("\n"));
		expect(text).toContain("My Fast");
		expect(text).toContain("Create custom preset");
		expect(text).toContain("Browse all models");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selections).toEqual([{ kind: "createProfile" }]);
	});
});
