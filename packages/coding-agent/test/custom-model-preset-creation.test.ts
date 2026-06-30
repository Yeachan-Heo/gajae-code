import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import {
	materializeModelProfileForDeletion,
	restoreMaterializedModelProfileForDeletion,
} from "@gajae-code/coding-agent/config/model-profile-activation";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { ModelProfileConfig } from "@gajae-code/coding-agent/config/models-config-schema";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { CustomModelPresetWizardComponent } from "@gajae-code/coding-agent/modes/components/custom-model-preset-wizard";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
} from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
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
	readonly apiKeyForProvider?: (providerId: string) => string | undefined;
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
		getApiKeyForProvider: async (providerId: string) => options.apiKeyForProvider?.(providerId) ?? "key",
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

	it("renames a custom preset display name without changing profile identity", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("my-fast", {
			display_name: "my-fast",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});

		const renamed = await registry.renameCustomModelProfile("my-fast", "renamed-fast");

		expect(renamed.name).toBe("my-fast");
		expect(renamed.displayName).toBe("renamed-fast");
		expect(registry.getModelProfile("my-fast")?.displayName).toBe("renamed-fast");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<string, { display_name?: string; model_mapping: Record<string, string> }>;
		};
		expect(parsed.profiles["my-fast"]?.display_name).toBe("renamed-fast");
		expect(parsed.profiles["renamed-fast"]).toBeUndefined();
		expect(parsed.profiles["my-fast"]?.model_mapping.default).toBe("my-oai/gpt-custom:low");
	});

	it("deletes only the selected custom preset", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("first", {
			display_name: "first",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom" },
		});
		await registry.saveCustomModelProfile("second", {
			display_name: "second",
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude" },
		});

		const deleted = await registry.deleteCustomModelProfile("first");

		expect(deleted).toEqual({
			display_name: "first",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom" },
		});

		expect(registry.getModelProfile("first")).toBeUndefined();
		expect(registry.getModelProfile("second")?.displayName).toBe("second");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<string, { display_name?: string }>;
		};
		expect(parsed.profiles.first).toBeUndefined();
		expect(parsed.profiles.second?.display_name).toBe("second");
	});

	it("rejects empty rename input and built-in delete without mutating config", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("my-fast", {
			display_name: "my-fast",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom" },
		});
		const before = await Bun.file(modelsPath).text();

		await expect(registry.renameCustomModelProfile("my-fast", "   ")).rejects.toThrow(
			"Profile display name is required.",
		);
		await expect(registry.deleteCustomModelProfile("codex-medium")).rejects.toThrow(
			"Cannot delete bundled model profile",
		);
		expect(await Bun.file(modelsPath).text()).toBe(before);
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
		expect(text).toContain("Already saved as Saved Current");
		expect(text).not.toContain("Create custom preset");
		expect(text).toContain("Browse all models");

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selections).toEqual([]);
	});
	it("emits custom preset rename and delete actions from preset rows", async () => {
		const customProfile: ModelProfileDefinition = {
			name: "custom-row",
			displayName: "Custom Row",
			requiredProviders: ["my-oai"],
			modelMapping: { default: "my-oai/gpt-custom" },
			source: "user",
		};
		const selections: ModelSelectorSelection[] = [];
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			currentModel("my-oai", "gpt-custom"),
			Settings.isolated({}),
			createRegistry([[customProfile.name, customProfile]]),
			[],
			selection => {
				selections.push(selection);
			},
			() => {},
		);
		await Bun.sleep(0);

		await selector.__testSelectPresetAction("custom-row", "rename");
		await selector.__testSelectPresetAction("custom-row", "delete");

		expect(selections).toEqual([
			{ kind: "renameProfile", profileName: "custom-row" },
			{ kind: "deleteProfile", profileName: "custom-row" },
		]);
	});

	it("keeps rename and delete reachable for unauthenticated custom preset rows", async () => {
		const customProfile: ModelProfileDefinition = {
			name: "needs-login",
			displayName: "Needs Login",
			requiredProviders: ["locked-provider"],
			modelMapping: { default: "locked-provider/model" },
			source: "user",
		};
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			currentModel("my-oai", "gpt-custom"),
			Settings.isolated({}),
			createRegistry([[customProfile.name, customProfile]], { apiKeyForProvider: () => undefined }),
			[],
			() => {},
			() => {},
		);
		await Bun.sleep(0);

		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");
		const text = normalizeRenderedText(selector.render(180).join("\n"));

		expect(text).toContain("Rename");
		expect(text).toContain("Delete");
		expect(text).not.toContain("Run /login locked-provider");
		expect(selector.__testSelectedPresetRowIdentity()).toBe("profile:CUSTOM:needs-login");
		selector.refreshPresetProfiles();
		const refreshedText = normalizeRenderedText(selector.render(180).join("\n"));
		expect(refreshedText).not.toContain("Rename");
		expect(refreshedText).not.toContain("Delete");
	});

	it("keeps the cursor on a refreshed custom preset row by actual group identity", async () => {
		const customProfile: ModelProfileDefinition = {
			name: "custom-row",
			displayName: "Custom Row",
			requiredProviders: ["my-oai"],
			modelMapping: { default: "my-oai/gpt-custom" },
			source: "user",
		};
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			currentModel("my-oai", "gpt-custom"),
			Settings.isolated({}),
			createRegistry([[customProfile.name, customProfile]]),
			[],
			() => {},
			() => {},
		);
		await Bun.sleep(0);

		selector.refreshPresetProfiles("custom-row");

		expect(selector.__testSelectedPresetRowIdentity()).toBe("profile:CUSTOM:custom-row");
	});

	it("materializes and restores a default custom preset deletion snapshot", async () => {
		const customProfile: ModelProfileDefinition = {
			name: "custom-default",
			displayName: "Custom Default",
			requiredProviders: ["my-oai"],
			modelMapping: {
				default: "my-oai/gpt-custom:low",
				executor: "my-oai/gpt-custom",
			},
			source: "user",
		};
		const settings = Settings.isolated({
			"modelProfile.default": "custom-default",
			modelRoles: { default: "old/default" },
			"task.agentModelOverrides": { critic: "old/critic" },
		});
		const activeProfiles: (string | undefined)[] = ["other-session"];
		const session = {
			model: currentModel("other", "active"),
			thinkingLevel: undefined,
			sessionId: "session",
			setActiveModelProfile: (profileName: string | undefined) => {
				activeProfiles.push(profileName);
			},
			getActiveModelProfile: () => activeProfiles.at(-1),
		};

		const snapshot = await materializeModelProfileForDeletion({
			session,
			settings,
			modelRegistry: createRegistry([[customProfile.name, customProfile]]),
			profileName: "custom-default",
		});

		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(settings.get("modelRoles").default).toBe("my-oai/gpt-custom:low");
		expect(settings.get("task.agentModelOverrides").executor).toBe("my-oai/gpt-custom");
		expect(activeProfiles.at(-1)).toBeUndefined();

		await restoreMaterializedModelProfileForDeletion({ settings, session, snapshot });

		expect(settings.get("modelProfile.default")).toBe("custom-default");
		expect(settings.get("modelRoles")).toEqual({ default: "old/default" });
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "old/critic" });
		expect(activeProfiles.at(-1)).toBe("other-session");
	});
	it("rolls back deletion materialization when settings flush fails", async () => {
		const customProfile: ModelProfileDefinition = {
			name: "custom-default",
			displayName: "Custom Default",
			requiredProviders: ["my-oai"],
			modelMapping: { default: "my-oai/gpt-custom:low" },
			source: "user",
		};
		const settings = Settings.isolated({
			"modelProfile.default": "custom-default",
			modelRoles: { default: "old/default" },
			"task.agentModelOverrides": { critic: "old/critic" },
		});
		const activeProfiles: (string | undefined)[] = ["custom-default"];
		const session = {
			model: currentModel("other", "active"),
			thinkingLevel: undefined,
			sessionId: "session",
			setActiveModelProfile: (profileName: string | undefined) => {
				activeProfiles.push(profileName);
			},
			getActiveModelProfile: () => activeProfiles.at(-1),
		};
		const flushSpy = spyOn(settings, "flush").mockRejectedValueOnce(new Error("flush failed"));

		try {
			await expect(
				materializeModelProfileForDeletion({
					session,
					settings,
					modelRegistry: createRegistry([[customProfile.name, customProfile]]),
					profileName: "custom-default",
				}),
			).rejects.toThrow("flush failed");
		} finally {
			flushSpy.mockRestore();
		}

		expect(settings.get("modelProfile.default")).toBe("custom-default");
		expect(settings.get("modelRoles")).toEqual({ default: "old/default" });
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "old/critic" });
		expect(activeProfiles.at(-1)).toBe("custom-default");
	});
	it("restores a deleted custom preset when post-delete notification fails", async () => {
		const unsafeDisplayName = "Custom\x1b[31m Default\x1b[0m\nRestored";
		const profiles = new Map<string, ModelProfileDefinition>([
			[
				"custom-default",
				{
					name: "custom-default",
					displayName: unsafeDisplayName,
					requiredProviders: ["my-oai"],
					modelMapping: { default: "my-oai/gpt-custom:low" },
					source: "user",
				},
			],
		]);
		const settings = Settings.isolated({
			"modelProfile.default": "custom-default",
			modelRoles: { default: "old/default" },
			"task.agentModelOverrides": { critic: "old/critic" },
		});
		const activeProfiles: (string | undefined)[] = ["custom-default"];
		let restoredProfile:
			| {
					display_name?: string;
					required_providers: string[];
					model_mapping: Record<string, string>;
			  }
			| undefined;
		const registry = {
			...createRegistry(profiles),
			getModelProfiles: () => new Map(profiles),
			getModelProfile: (name: string) => profiles.get(name),
			getAvailableModelProfileNames: () => [...profiles.keys()],
			deleteCustomModelProfile: async (name: string) => {
				const profile = profiles.get(name);
				if (!profile) throw new Error("missing profile");
				const config = {
					display_name: profile.displayName,
					required_providers: [...profile.requiredProviders],
					model_mapping: { ...profile.modelMapping },
				};
				profiles.delete(name);
				return config;
			},
			saveCustomModelProfile: async (
				name: string,
				config: { display_name?: string; required_providers: string[]; model_mapping: Record<string, string> },
			) => {
				restoredProfile = config;
				profiles.set(name, {
					name,
					displayName: config.display_name,
					requiredProviders: [...config.required_providers],
					modelMapping: { ...config.model_mapping },
					source: "user",
				});
				return profiles.get(name);
			},
			refresh: async () => {},
		};
		let selector: ModelSelectorComponent | undefined;
		let confirmTitle: string | undefined;
		const ctx = {
			ui: { setFocus: () => {}, requestRender: () => {} },
			editorContainer: {
				clear: () => {},
				addChild: (child: unknown) => {
					if (child instanceof ModelSelectorComponent) selector = child;
				},
			},
			editor: {},
			settings,
			session: {
				model: currentModel("my-oai", "gpt-custom"),
				thinkingLevel: ThinkingLevel.Low,
				sessionId: "session",
				scopedModels: [],
				modelRegistry: registry,
				setActiveModelProfile: (profileName: string | undefined) => activeProfiles.push(profileName),
				getActiveModelProfile: () => activeProfiles.at(-1),
				isFastForProvider: () => false,
				isFastForSubagentProvider: () => false,
				isFastModeActive: () => false,
			},
			statusLine: { invalidate: () => {} },
			updateEditorBorderColor: () => {},
			showStatus: () => {},
			showError: (message: string) => {
				expect(message).toBe("Preset delete failed: notify failed");
			},
			showHookConfirm: async (title: string) => {
				confirmTitle = title;
				return true;
			},
			notifyConfigChanged: async () => {
				throw new Error("notify failed");
			},
		};

		new SelectorController(ctx as never).showModelSelector();
		await Bun.sleep(0);
		await selector?.__testSelectPresetAction("custom-default", "delete");

		expect(confirmTitle).toBe("Delete custom model preset: Custom Default Restored");
		expect(restoredProfile?.display_name).toBe(unsafeDisplayName);
		expect(profiles.get("custom-default")?.displayName).toBe(unsafeDisplayName);
		expect(settings.get("modelProfile.default")).toBe("custom-default");
		expect(settings.get("modelRoles")).toEqual({ default: "old/default" });
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "old/critic" });
		expect(activeProfiles.at(-1)).toBe("custom-default");
	});
});
