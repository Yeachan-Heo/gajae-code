import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { ModelProfileConfig } from "@gajae-code/coding-agent/config/models-config-schema";
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

const currentModel = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const snapshot: ModelProfileConfig = {
	required_providers: ["my-oai"],
	model_mapping: { default: "my-oai/gpt-custom:low" },
};

const placeholderProfile: ModelProfileDefinition = {
	name: "placeholder",
	displayName: "Placeholder",
	requiredProviders: ["my-oai"],
	modelMapping: { default: "my-oai/gpt-custom" },
	source: "user",
};

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

interface TestRegistryOptions {
	readonly models?: readonly Model[];
	readonly resolveCanonicalModel?: (canonicalId: string) => Model | undefined;
}

function createRegistry(profiles: Iterable<[string, ModelProfileDefinition]> = [], options: TestRegistryOptions = {}) {
	const profileMap = new Map(profiles);
	const models = [...(options.models ?? [currentModel("my-oai", "gpt-custom"), currentModel("anthropic", "claude")])];
	return {
		refresh: async () => {},
		getError: () => undefined,
		getAvailable: () => [...models],
		getAll: () => [...models],
		getProviders: () => [],
		getCanonicalModels: () => [],
		getDiscoverableProviders: () => [],
		findCanonicalModel: () => undefined,
		resolveCanonicalModel: options.resolveCanonicalModel ?? (() => undefined),
		getModelProfiles: () => new Map(profileMap),
		getModelProfile: (name: string) => profileMap.get(name),
		getApiKeyForProvider: async () => "key",
	} as unknown as ModelRegistry;
}

describe("custom model preset creation", () => {
	it("validates the one-name wizard and never asks for secrets", () => {
		const submitted: unknown[] = [];
		const wizard = new CustomModelPresetWizardComponent(
			snapshot,
			input => submitted.push(input),
			() => {},
			() => {},
		);

		typeText(wizard, "Bad Name");
		const text = normalizeRenderedText(wizard.render(120).join("\n"));
		expect(text).toContain("Preset id must use lowercase letters, numbers, dots, underscores, or hyphens.");
		expect(text).not.toContain("Display name");
		expect(text).not.toContain("Provider");
		expect(text).not.toContain("Model");
		expect(text).not.toContain("API key");
		expect(text).not.toContain("secret");
		expect(submitted).toEqual([]);

		typeText(wizard, "my-fast");
		expect(submitted).toEqual([
			{
				name: "my-fast",
				profile: {
					display_name: "my-fast",
					required_providers: ["my-oai"],
					model_mapping: { default: "my-oai/gpt-custom:low" },
				},
			},
		]);
	});

	it("persists a custom preset and includes it in later registry sessions", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);

		const profile = await registry.saveCustomModelProfile("my-fast", {
			display_name: "my-fast",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});

		expect(profile.displayName).toBe("my-fast");
		expect(registry.getModelProfile("my-fast")?.modelMapping.default).toBe("my-oai/gpt-custom:low");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<
				string,
				{ display_name?: string; required_providers: string[]; model_mapping: Record<string, string> }
			>;
		};
		expect(parsed.profiles["my-fast"]?.display_name).toBe("my-fast");
		expect(parsed.profiles["my-fast"]?.required_providers).toEqual(["my-oai"]);
		expect(parsed.profiles["my-fast"]?.model_mapping.default).toBe("my-oai/gpt-custom:low");

		const laterRegistry = new ModelRegistry(authStorage, modelsPath);
		expect(laterRegistry.getAvailableModelProfileNames()).toContain("my-fast");
		expect(laterRegistry.getModelProfile("my-fast")?.displayName).toBe("my-fast");
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
				display_name: "my-fast",
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

	it("surfaces create custom preset with the generated current model snapshot", async () => {
		const settings = Settings.isolated({
			"task.agentModelOverrides": {
				executor: "anthropic/claude:high",
				architect: "pi/default",
				planner: "pi/default:high",
				critic: "my-oai/gpt-custom",
			},
		});
		const otherProfile: ModelProfileDefinition = {
			name: "other",
			displayName: "Other",
			requiredProviders: ["other-provider"],
			modelMapping: { default: "other-provider/model" },
			source: "user",
		};
		const selections: ModelSelectorSelection[] = [];
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			currentModel("my-oai", "gpt-custom"),
			settings,
			createRegistry([[otherProfile.name, otherProfile]]),
			[],
			selection => {
				selections.push(selection);
			},
			() => {},
			{ currentThinkingLevel: ThinkingLevel.Low },
		);
		await Bun.sleep(0);

		const text = normalizeRenderedText(selector.render(180).join("\n"));
		expect(text).toContain("Create custom preset");
		expect(text).toContain("Browse all models");

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selections).toEqual([
			{
				kind: "createProfile",
				profile: {
					required_providers: ["anthropic", "my-oai"],
					model_mapping: {
						default: "my-oai/gpt-custom:low",
						executor: "anthropic/claude:high",
						planner: "my-oai/gpt-custom:high",
						critic: "my-oai/gpt-custom",
					},
				},
			},
		]);
	});

	it("keeps create custom preset visible when raw required provider order differs", async () => {
		const orderMismatchProfile: ModelProfileDefinition = {
			name: "order-mismatch",
			displayName: "Order Mismatch",
			requiredProviders: ["my-oai", "anthropic"],
			modelMapping: {
				default: "my-oai/gpt-custom:low",
				executor: "anthropic/claude:high",
			},
			source: "user",
		};
		const selections: ModelSelectorSelection[] = [];
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			currentModel("my-oai", "gpt-custom"),
			Settings.isolated({ "task.agentModelOverrides": { executor: "anthropic/claude:high" } }),
			createRegistry([[orderMismatchProfile.name, orderMismatchProfile]]),
			[],
			selection => {
				selections.push(selection);
			},
			() => {},
			{ currentThinkingLevel: ThinkingLevel.Low },
		);
		await Bun.sleep(0);

		const text = normalizeRenderedText(selector.render(180).join("\n"));
		expect(text).toContain("Create custom preset");
		expect(text).not.toContain("Already saved as order-mismatch");

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selections[0]?.kind).toBe("createProfile");
	});

	it("resolves canonical ids and role aliases before creating the snapshot", async () => {
		const canonicalModel = currentModel("my-oai", "gpt-custom");
		const settings = Settings.isolated({
			modelRoles: { default: "best-coder" },
			"task.agentModelOverrides": {
				executor: "pi/default:low",
				critic: "anthropic/claude:max",
			},
		});
		const selections: ModelSelectorSelection[] = [];
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			undefined,
			settings,
			createRegistry([[placeholderProfile.name, placeholderProfile]], {
				resolveCanonicalModel: canonicalId => (canonicalId === "best-coder" ? canonicalModel : undefined),
			}),
			[],
			selection => {
				selections.push(selection);
			},
			() => {},
		);
		await Bun.sleep(0);

		const text = normalizeRenderedText(selector.render(180).join("\n"));
		expect(text).toContain("Create custom preset");

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selections).toEqual([
			{
				kind: "createProfile",
				profile: {
					required_providers: ["anthropic", "my-oai"],
					model_mapping: {
						default: "my-oai/gpt-custom",
						executor: "my-oai/gpt-custom:low",
						critic: "anthropic/claude:max",
					},
				},
			},
		]);
	});

	it("disables custom preset creation when no concrete snapshot can be generated", async () => {
		const selections: ModelSelectorSelection[] = [];
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			undefined,
			Settings.isolated({}),
			createRegistry([[placeholderProfile.name, placeholderProfile]]),
			[],
			selection => {
				selections.push(selection);
			},
			() => {},
		);
		await Bun.sleep(0);

		const text = normalizeRenderedText(selector.render(180).join("\n"));
		expect(text).toContain("Select a model before creating a custom preset");
		expect(text).not.toContain("Create custom preset");

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selections).toEqual([]);
	});

	it("replaces create custom preset with a disabled already-saved row for duplicate raw payloads", async () => {
		const duplicateProfile: ModelProfileDefinition = {
			name: "saved-current",
			displayName: "Saved Current",
			requiredProviders: ["my-oai"],
			modelMapping: { default: "my-oai/gpt-custom:low" },
			source: "user",
		};
		const selections: ModelSelectorSelection[] = [];
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			currentModel("my-oai", "gpt-custom"),
			Settings.isolated({}),
			createRegistry([[duplicateProfile.name, duplicateProfile]]),
			[],
			selection => {
				selections.push(selection);
			},
			() => {},
			{ currentThinkingLevel: ThinkingLevel.Low },
		);
		await Bun.sleep(0);

		const text = normalizeRenderedText(selector.render(180).join("\n"));
		expect(text).toContain("Already saved as saved-current");
		expect(text).not.toContain("Create custom preset");
		expect(text).toContain("Browse all models");

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selections).toEqual([]);
	});
});
