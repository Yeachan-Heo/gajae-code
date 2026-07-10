import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import {
	activateModelProfile,
	materializeModelProfileForDeletion,
	restoreMaterializedModelProfileForDeletion,
} from "@gajae-code/coding-agent/config/model-profile-activation";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type ModelProfileConfig, ModelsConfigSchema } from "@gajae-code/coding-agent/config/models-config-schema";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { CustomModelPresetWizardComponent } from "@gajae-code/coding-agent/modes/components/custom-model-preset-wizard";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
} from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";
import { getProjectAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";

let tempDir: string;
let authStorage: AuthStorage;

const currentModel = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const snapshot: ModelProfileConfig = {
	required_providers: ["my-oai"],
	model_mapping: { default: "my-oai/gpt-custom:low" },
};
const archivedProfilePrefix = "__gjc_archived_profile__:v1:";

function archivedProfileEnvelope(name: string, profile: unknown): string {
	return `${archivedProfilePrefix}${Buffer.from(name, "utf8").toString("base64url")}:${Buffer.from(JSON.stringify(profile), "utf8").toString("base64url")}`;
}

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

function createDeletionSession() {
	let activeProfile: string | undefined;
	let sessionDefault = "my-oai/baseline";
	return {
		model: currentModel("my-oai", "baseline") as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "deletion-session",
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			this.model = next;
			this.thinkingLevel = thinkingLevel;
		},
		setActiveModelProfile(profileName: string | undefined) {
			activeProfile = profileName;
		},
		getActiveModelProfile() {
			return activeProfile;
		},
		getSessionDefaultModelSelector() {
			return sessionDefault;
		},
		recordResumeDefaultModel(selector: string) {
			sessionDefault = selector;
		},
	};
}

async function createDeletionControllerHarness(
	settings: Settings,
	profiles: Map<string, ModelProfileDefinition>,
	initialActiveProfile?: string,
) {
	let selector: ModelSelectorComponent | undefined;
	let deleteCalls = 0;
	const errors: string[] = [];
	const statuses: string[] = [];
	const archivedProfiles = new Map<string, ModelProfileDefinition>();
	const registry = {
		...createRegistry(profiles),
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getModelProfileForReference: (name: string) => profiles.get(name) ?? archivedProfiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		deleteCustomModelProfile: async (name: string) => {
			deleteCalls++;
			const profile = profiles.get(name);
			if (!profile) throw new Error("missing profile");
			profiles.delete(name);
			archivedProfiles.set(name, profile);
			return {
				display_name: profile.displayName,
				required_providers: [...profile.requiredProviders],
				model_mapping: { ...profile.modelMapping },
			};
		},
		saveCustomModelProfile: async (name: string, config: ModelProfileConfig) => {
			archivedProfiles.delete(name);
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
	const session = {
		...createDeletionSession(),
		scopedModels: [],
		modelRegistry: registry,
		isFastForProvider: () => false,
		isFastForSubagentProvider: () => false,
		isFastModeActive: () => false,
	};
	session.setActiveModelProfile(initialActiveProfile);
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
		session,
		statusLine: { invalidate: () => {} },
		updateEditorBorderColor: () => {},
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => errors.push(message),
		showHookConfirm: async () => true,
		notifyConfigChanged: async () => {},
	};
	new SelectorController(ctx as never).showModelSelector();
	await Bun.sleep(0);
	if (!selector) throw new Error("Model selector did not open");
	return {
		selector,
		errors,
		statuses,
		getDeleteCalls: () => deleteCalls,
		getArchivedProfile: (name: string) => archivedProfiles.get(name),
	};
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

		expect(registry.getModelProfiles().has("first")).toBe(false);
		expect(registry.getAvailableModelProfileNames()).not.toContain("first");
		expect(registry.getModelProfile("first")).toBeUndefined();
		expect(registry.getModelProfileForReference("first")?.displayName).toBe("first");
		expect(registry.getModelProfile("second")?.displayName).toBe("second");
		const parsed: unknown = YAML.parse(await Bun.file(modelsPath).text());
		expect(ModelsConfigSchema.safeParse(parsed).success).toBe(true);
		const config = parsed as {
			profiles: Record<string, { display_name?: string }>;
			equivalence?: { exclude?: string[] };
		};
		expect(config.profiles.first).toBeUndefined();
		expect(config.profiles.second?.display_name).toBe("second");
		expect(config.equivalence?.exclude?.some(value => value.startsWith(archivedProfilePrefix))).toBe(true);
	});

	it("quarantines a malformed hidden archive without invalidating active config", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			Bun.YAML.stringify({
				equivalence: {
					exclude: ["anthropic/excluded", "__gjc_archived_profile__:v1:not-json"],
				},
				profiles: {
					active: {
						required_providers: ["anthropic"],
						model_mapping: { default: "anthropic/active" },
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getError()).toBeUndefined();
		expect(registry.getModelProfile("active")).toBeDefined();
		expect(registry.getModelProfileForReference("not-json")).toBeUndefined();
	});
	it("isolates malformed archives, uses the last duplicate, and preserves quarantine bytes", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const encodedName = (name: string) => Buffer.from(name, "utf8").toString("base64url");
		const encodedPayload = (payload: Uint8Array | string) =>
			(typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload)).toString("base64url");
		const validFirst = archivedProfileEnvelope("archived", {
			display_name: "First",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/first" },
		});
		const validLast = archivedProfileEnvelope("archived", {
			display_name: "Last",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/last" },
		});
		const malformedForRecreatedName = `${archivedProfilePrefix}${encodedName("recreate-me")}:${encodedPayload("{}")}`;
		const quarantined = [
			"__gjc_archived_profile__:v1:only-name",
			`__gjc_archived_profile__:v2:${encodedName("future")}:${encodedPayload("{}")}`,
			`__gjc_archived_profile__:v1:abc=:${encodedPayload("{}")}`,
			`__gjc_archived_profile__:v1:${Buffer.from([0xff]).toString("base64url")}:${encodedPayload("{}")}`,
			`__gjc_archived_profile__:v1:${encodedName("Invalid")}:${encodedPayload("{}")}`,
			`__gjc_archived_profile__:v1:${encodedName("bad-base64")}:***`,
			`__gjc_archived_profile__:v1:${encodedName("bad-utf8")}:${Buffer.from([0xff]).toString("base64url")}`,
			`__gjc_archived_profile__:v1:${encodedName("oversized")}:${Buffer.alloc(64 * 1024 + 1, "x").toString("base64url")}`,
			`__gjc_archived_profile__:v1:${encodedName("bad-json")}:${encodedPayload("{")}`,
			`__gjc_archived_profile__:v1:${encodedName("bad-schema")}:${encodedPayload("{}")}`,
			malformedForRecreatedName,
		];
		const exclusions = ["anthropic/excluded", ...quarantined, validFirst, validLast];
		await Bun.write(
			modelsPath,
			Bun.YAML.stringify({
				equivalence: { exclude: exclusions },
				profiles: {
					active: {
						required_providers: ["anthropic"],
						model_mapping: { default: "anthropic/active" },
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getError()).toBeUndefined();
		expect(registry.getModelProfile("active")).toBeDefined();
		expect(registry.getModelProfileForReference("archived")?.displayName).toBe("Last");
		expect(registry.getAvailableModelProfileNames()).not.toContain("archived");

		await registry.saveCustomModelProfile("recreate-me", {
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/recreated" },
		});
		const saved = YAML.parse(await Bun.file(modelsPath).text()) as {
			equivalence?: { exclude?: string[] };
			profiles?: Record<string, ModelProfileConfig>;
		};
		expect(ModelsConfigSchema.safeParse(saved).success).toBe(true);
		expect(saved.profiles?.["recreate-me"]?.model_mapping.default).toBe("my-oai/recreated");
		expect(saved.equivalence?.exclude).toEqual(["anthropic/excluded", ...quarantined, validFirst, validLast]);
	});

	it("rejects invalid profile ids before first persistence", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);

		await expect(registry.saveCustomModelProfile("Bad Name", snapshot)).rejects.toThrow(
			'Invalid custom model profile id "Bad Name"',
		);
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("round-trips the archive payload limit and rejects an oversized archive before deletion", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const profileWithSerializedBytes = (targetBytes: number): ModelProfileConfig => {
			const createProfile = (displayName: string): ModelProfileConfig => ({
				required_providers: ["my-oai"],
				display_name: displayName,
				model_mapping: { default: "my-oai/model" },
			});
			const overhead = Buffer.byteLength(JSON.stringify(createProfile("")), "utf8");
			const profile = createProfile("x".repeat(targetBytes - overhead));
			expect(Buffer.byteLength(JSON.stringify(profile), "utf8")).toBe(targetBytes);
			return profile;
		};

		await registry.saveCustomModelProfile("boundary", profileWithSerializedBytes(64 * 1024));
		await registry.deleteCustomModelProfile("boundary");
		const reopened = new ModelRegistry(authStorage, modelsPath);
		expect(reopened.getModelProfileForReference("boundary")?.displayName).toHaveLength(
			profileWithSerializedBytes(64 * 1024).display_name?.length ?? 0,
		);

		await registry.saveCustomModelProfile("oversized", profileWithSerializedBytes(64 * 1024 + 1));
		await expect(registry.deleteCustomModelProfile("oversized")).rejects.toThrow(
			"serialized profile exceeds 65536 bytes",
		);
		const afterRejectedDelete = new ModelRegistry(authStorage, modelsPath);
		expect(afterRejectedDelete.getModelProfile("oversized")).toBeDefined();
		expect(afterRejectedDelete.getModelProfileForReference("boundary")).toBeDefined();
	});
	it("serializes concurrent profile saves without losing either update", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registryA = new ModelRegistry(authStorage, modelsPath);
		const registryB = new ModelRegistry(authStorage, modelsPath);

		await Promise.all([
			registryA.saveCustomModelProfile("profile-a", {
				display_name: "Profile A",
				required_providers: ["my-oai"],
				model_mapping: { default: "my-oai/model-a" },
			}),
			registryB.saveCustomModelProfile("profile-b", {
				display_name: "Profile B",
				required_providers: ["anthropic"],
				model_mapping: { default: "anthropic/model-b" },
			}),
		]);

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<string, { display_name?: string }>;
		};
		expect(parsed.profiles["profile-a"]?.display_name).toBe("Profile A");
		expect(parsed.profiles["profile-b"]?.display_name).toBe("Profile B");
	});

	it("rejects profile mutation through hard-linked models config aliases", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const aliasPath = path.join(tempDir, "models-alias.yml");
		const seedRegistry = new ModelRegistry(authStorage, modelsPath);
		await seedRegistry.saveCustomModelProfile("seed", {
			display_name: "Seed",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/seed" },
		});
		await fs.link(modelsPath, aliasPath);

		const [first, second] = await Promise.allSettled([
			new ModelRegistry(authStorage, modelsPath).saveCustomModelProfile("profile-a", {
				display_name: "Profile A",
				required_providers: ["my-oai"],
				model_mapping: { default: "my-oai/model-a" },
			}),
			new ModelRegistry(authStorage, aliasPath).saveCustomModelProfile("profile-b", {
				display_name: "Profile B",
				required_providers: ["anthropic"],
				model_mapping: { default: "anthropic/model-b" },
			}),
		]);

		expect(first.status).toBe("rejected");
		expect(second.status).toBe("rejected");
		expect(String(first.status === "rejected" ? first.reason : "")).toContain(
			"Refusing to replace hard-linked models config",
		);
		expect(String(second.status === "rejected" ? second.reason : "")).toContain(
			"Refusing to replace hard-linked models config",
		);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as { profiles: Record<string, unknown> };
		expect(Object.keys(parsed.profiles)).toEqual(["seed"]);
		expect(await Bun.file(aliasPath).text()).toBe(await Bun.file(modelsPath).text());
	});
	it("keeps the canonical path present across atomic existing-file replacement", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const canonicalModelsPath = syncFs.realpathSync(modelsPath);

		const originalRename = syncFs.renameSync;
		let observedAtomicReplacement = false;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			if (String(source).endsWith(".tmp") && String(destination) === canonicalModelsPath) {
				expect(syncFs.existsSync(destination)).toBe(true);
				const result = originalRename(source, destination);
				expect(syncFs.existsSync(destination)).toBe(true);
				observedAtomicReplacement = true;
				return result;
			}
			return originalRename(source, destination);
		});
		try {
			await registry.saveCustomModelProfile("profile-a", snapshot);
		} finally {
			renameSpy.mockRestore();
		}

		expect(observedAtomicReplacement).toBe(true);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as { profiles: Record<string, unknown> };
		expect(parsed.profiles["profile-a"]).toBeDefined();
	});

	it("retains the rollback when durable recovery rotation fails", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalText = await Bun.file(modelsPath).text();
		const originalRename = syncFs.renameSync;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			if (String(source).endsWith(".rollback") && String(destination).endsWith(".recovery")) {
				throw new Error("forced recovery rotation failure");
			}
			return originalRename(source, destination);
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			renameSpy.mockRestore();
		}

		const rollbackName = (await fs.readdir(tempDir)).find(name => name.endsWith(".rollback"));
		expect(rollbackName).toBeDefined();
		expect(await Bun.file(path.join(tempDir, rollbackName ?? "")).text()).toBe(originalText);
	});

	it("retains durable recovery when its rotation parent fsync fails", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalText = await Bun.file(modelsPath).text();
		const originalRename = syncFs.renameSync;
		const originalFsync = syncFs.fsyncSync;
		let recoveryRotated = false;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			const result = originalRename(source, destination);
			if (String(source).endsWith(".rollback") && String(destination).endsWith(".recovery")) {
				recoveryRotated = true;
			}
			return result;
		});
		const fsyncSpy = spyOn(syncFs, "fsyncSync").mockImplementation(fd => {
			if (recoveryRotated && syncFs.fstatSync(fd).isDirectory()) {
				throw new Error("forced recovery parent fsync failure");
			}
			return originalFsync(fd);
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			fsyncSpy.mockRestore();
			renameSpy.mockRestore();
		}

		const recoveryPath = `${syncFs.realpathSync(path.dirname(modelsPath))}/${path.basename(modelsPath)}.recovery`;
		expect(await Bun.file(recoveryPath).text()).toBe(originalText);
	});
	it("rejects a same-inode byte change before atomic replacement", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const canonicalModelsPath = syncFs.realpathSync(modelsPath);
		const competingText = Bun.YAML.stringify({
			profiles: {
				competing: {
					required_providers: ["my-oai"],
					model_mapping: { default: "my-oai/competing" },
				},
			},
		});
		const originalStat = syncFs.statSync;
		let injected = false;
		const statSpy = spyOn(syncFs, "statSync").mockImplementation(((target: Parameters<typeof syncFs.statSync>[0]) => {
			const stat = originalStat(target);
			if (!injected && String(target) === canonicalModelsPath && stat.nlink === 2) {
				syncFs.writeFileSync(target, competingText);
				syncFs.utimesSync(target, stat.atime, stat.mtime);
				injected = true;
			}
			return originalStat(target);
		}) as typeof syncFs.statSync);
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Refusing to replace models config changed during mutation",
			);
		} finally {
			statSpy.mockRestore();
		}
		expect(injected).toBe(true);
		expect(await Bun.file(modelsPath).text()).toBe(competingText);
	});
	it("preserves same-inode bytes changed at the atomic rename boundary", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const canonicalModelsPath = syncFs.realpathSync(modelsPath);
		const competingText = Bun.YAML.stringify({
			profiles: {
				competing: {
					required_providers: ["my-oai"],
					model_mapping: { default: "my-oai/competing" },
				},
			},
		});
		const originalRename = syncFs.renameSync;
		let injected = false;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			if (!injected && String(source).endsWith(".tmp") && String(destination) === canonicalModelsPath) {
				const before = syncFs.statSync(destination);
				syncFs.writeFileSync(destination, competingText);
				syncFs.utimesSync(destination, before.atime, before.mtime);
				injected = true;
			}
			return originalRename(source, destination);
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			renameSpy.mockRestore();
		}

		expect(injected).toBe(true);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as { profiles: Record<string, unknown> };
		expect(parsed.profiles["profile-a"]).toBeDefined();
		const recoveryName = (await fs.readdir(tempDir)).find(name => name.endsWith(".recovery"));
		expect(recoveryName).toBeDefined();
		expect(await Bun.file(path.join(tempDir, recoveryName ?? "")).text()).toBe(competingText);
	});

	it("preserves a competing first-file creation at the exclusive commit boundary", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const competingText = Bun.YAML.stringify({
			profiles: {
				competing: {
					required_providers: ["my-oai"],
					model_mapping: { default: "my-oai/competing" },
				},
			},
		});
		const originalLink = syncFs.linkSync;
		let injected = false;
		const linkSpy = spyOn(syncFs, "linkSync").mockImplementation((source, destination) => {
			if (!injected && String(source).endsWith(".tmp") && String(destination).endsWith("models.yml")) {
				syncFs.writeFileSync(destination, competingText, { flag: "wx" });
				injected = true;
			}
			return originalLink(source, destination);
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"exclusive commit boundary",
			);
		} finally {
			linkSpy.mockRestore();
		}
		expect(injected).toBe(true);
		expect(await Bun.file(modelsPath).text()).toBe(competingText);
	});
	it("reports post-commit verification failure and preserves rollback evidence", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalRename = syncFs.renameSync;
		const originalStat = syncFs.statSync;
		let committed = false;
		let failedVerification = false;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			const result = originalRename(source, destination);
			if (String(source).endsWith(".tmp") && String(destination).endsWith("models.yml")) committed = true;
			return result;
		});
		const statSpy = spyOn(syncFs, "statSync").mockImplementation(((target: Parameters<typeof syncFs.statSync>[0]) => {
			if (committed && !failedVerification && String(target).endsWith("models.yml")) {
				failedVerification = true;
				throw Object.assign(new Error("forced verification EIO"), { code: "EIO" });
			}
			return originalStat(target);
		}) as typeof syncFs.statSync);
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			statSpy.mockRestore();
			renameSpy.mockRestore();
		}
		expect(failedVerification).toBe(true);
		expect((await fs.readdir(tempDir)).some(name => name.endsWith(".rollback"))).toBe(true);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as { profiles?: Record<string, unknown> };
		expect(parsed.profiles?.["profile-a"]).toBeDefined();
	});

	it("keeps original recovery bytes through final pathname verification", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalText = await Bun.file(modelsPath).text();
		const originalRename = syncFs.renameSync;
		const originalStat = syncFs.statSync;
		let committed = false;
		let committedStatCalls = 0;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			const result = originalRename(source, destination);
			if (String(source).endsWith(".tmp") && String(destination).endsWith("models.yml")) committed = true;
			return result;
		});
		const statSpy = spyOn(syncFs, "statSync").mockImplementation(((target: Parameters<typeof syncFs.statSync>[0]) => {
			if (committed && String(target).endsWith("models.yml") && ++committedStatCalls === 2) {
				throw Object.assign(new Error("forced final verification EIO"), { code: "EIO" });
			}
			return originalStat(target);
		}) as typeof syncFs.statSync);
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			statSpy.mockRestore();
			renameSpy.mockRestore();
		}

		expect(committedStatCalls).toBe(2);
		const recoveryName = (await fs.readdir(tempDir)).find(name => name.endsWith(".recovery"));
		expect(recoveryName).toBeDefined();
		expect(await Bun.file(path.join(tempDir, recoveryName ?? "")).text()).toBe(originalText);
	});
	it("preserves models config mode and ownership across atomic replacement", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("profile-a", {
			display_name: "Profile A",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/model-a" },
		});
		await fs.chmod(modelsPath, 0o600);
		const before = await fs.stat(modelsPath);

		await registry.saveCustomModelProfile("profile-b", {
			display_name: "Profile B",
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/model-b" },
		});

		const after = await fs.stat(modelsPath);
		expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
		expect(after.uid).toBe(before.uid);
		expect(after.gid).toBe(before.gid);
	});

	it("refreshes profile maps after a same-mtime config replacement", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			Bun.YAML.stringify({
				profiles: {
					"old-profile": {
						required_providers: ["anthropic"],
						model_mapping: { default: "anthropic/old-model" },
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getModelProfile("old-profile")).toBeDefined();
		const originalStat = await fs.stat(modelsPath);

		await Bun.write(
			modelsPath,
			Bun.YAML.stringify({
				profiles: {
					"new-profile": {
						required_providers: ["anthropic"],
						model_mapping: { default: "anthropic/new-model" },
					},
				},
			}),
		);
		await fs.utimes(modelsPath, originalStat.atime, originalStat.mtime);
		await registry.refresh("offline");

		expect(registry.getModelProfile("old-profile")).toBeUndefined();
		expect(registry.getModelProfile("new-profile")).toBeDefined();
	});

	it("keeps the prior models config intact when an atomic profile write fails", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const canonicalModelsPath = path.join(await fs.realpath(tempDir), "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("profile-a", {
			display_name: "Profile A",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/model-a" },
		});
		const before = await Bun.file(modelsPath).text();
		const originalOpen = syncFs.openSync;
		const openSpy = spyOn(syncFs, "openSync").mockImplementation((...args) => {
			if (typeof args[0] === "string" && args[0].startsWith(`${canonicalModelsPath}.`) && args[0].endsWith(".tmp")) {
				throw new Error("forced models write failure");
			}
			return originalOpen(...args);
		});
		try {
			await expect(
				registry.saveCustomModelProfile("profile-b", {
					display_name: "Profile B",
					required_providers: ["anthropic"],
					model_mapping: { default: "anthropic/model-b" },
				}),
			).rejects.toThrow("forced models write failure");
		} finally {
			openSpy.mockRestore();
		}

		expect(await Bun.file(modelsPath).text()).toBe(before);
		const reopened = new ModelRegistry(authStorage, modelsPath);
		expect(reopened.getModelProfile("profile-a")?.displayName).toBe("Profile A");
		expect(reopened.getModelProfile("profile-b")).toBeUndefined();
	});

	it("keeps a renamed models config committed when parent directory fsync fails", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const originalFsync = syncFs.fsyncSync;
		const fsyncSpy = spyOn(syncFs, "fsyncSync").mockImplementation(fd => {
			if (syncFs.fstatSync(fd).isDirectory()) {
				throw new Error("simulated models parent fsync failure");
			}
			return originalFsync(fd);
		});
		try {
			await expect(
				registry.saveCustomModelProfile("profile-a", {
					display_name: "Profile A",
					required_providers: ["my-oai"],
					model_mapping: { default: "my-oai/model-a" },
				}),
			).resolves.toMatchObject({ displayName: "Profile A" });
		} finally {
			fsyncSpy.mockRestore();
		}

		const reopened = new ModelRegistry(authStorage, modelsPath);
		expect(reopened.getModelProfile("profile-a")?.displayName).toBe("Profile A");
	});

	it("keeps an archived fallback across repeated deletion and clears it on recreation", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registryA = new ModelRegistry(authStorage, modelsPath);
		const registryB = new ModelRegistry(authStorage, modelsPath);
		await registryA.saveCustomModelProfile("profile-a", {
			display_name: "Original A",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/model-a" },
		});
		await registryA.deleteCustomModelProfile("profile-a");

		await expect(registryB.deleteCustomModelProfile("profile-a")).rejects.toThrow(
			"Custom model profile is already deleted: profile-a.",
		);
		const archivedRegistry = new ModelRegistry(authStorage, modelsPath);
		expect(archivedRegistry.getModelProfile("profile-a")).toBeUndefined();
		expect(archivedRegistry.getModelProfileForReference("profile-a")?.displayName).toBe("Original A");
		expect(archivedRegistry.getAvailableModelProfileNames()).not.toContain("profile-a");

		await registryB.saveCustomModelProfile("profile-a", {
			display_name: "Recreated A",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/model-a-v2" },
		});
		const recreatedConfig = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<string, { display_name?: string }>;
			equivalence?: { exclude?: string[] };
		};
		expect(recreatedConfig.profiles["profile-a"]?.display_name).toBe("Recreated A");
		expect(
			recreatedConfig.equivalence?.exclude?.some(value => value.startsWith(archivedProfilePrefix)) ?? false,
		).toBe(false);

		const recreatedRegistry = new ModelRegistry(authStorage, modelsPath);
		expect(recreatedRegistry.getModelProfile("profile-a")?.displayName).toBe("Recreated A");
		await recreatedRegistry.deleteCustomModelProfile("profile-a");
		const rearchivedRegistry = new ModelRegistry(authStorage, modelsPath);
		expect(rearchivedRegistry.getModelProfile("profile-a")).toBeUndefined();
		expect(rearchivedRegistry.getModelProfileForReference("profile-a")?.displayName).toBe("Recreated A");
		const rearchivedConfig = YAML.parse(await Bun.file(modelsPath).text()) as {
			equivalence?: { exclude?: string[] };
		};
		expect(
			rearchivedConfig.equivalence?.exclude?.filter(value => value.startsWith(archivedProfilePrefix)),
		).toHaveLength(1);
	});

	it("keeps stale global and cross-project references resolvable after archival", async () => {
		const agentDir = path.join(tempDir, "archived-reference-agent");
		const modelsPath = path.join(agentDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("profile-a", {
			display_name: "Profile A",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/model-a" },
		});
		const projectX = path.join(tempDir, "project-x");
		await fs.mkdir(getProjectAgentDir(projectX), { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(projectX), "config.yml"),
			YAML.stringify({ modelProfile: { default: "profile-a" } }),
		);

		resetSettingsForTest();
		try {
			const settingsA = await Settings.init({ agentDir, cwd: tempDir });
			const settingsB = await settingsA.cloneForCwd(tempDir);
			settingsB.set("modelProfile.default", "profile-a");

			await settingsA.deleteModelProfileIfUnreferenced("profile-a", () =>
				registry.deleteCustomModelProfile("profile-a"),
			);
			const projectY = path.join(tempDir, "project-y");
			await fs.mkdir(getProjectAgentDir(projectY), { recursive: true });
			await Bun.write(
				path.join(getProjectAgentDir(projectY), "config.yml"),
				YAML.stringify({ modelProfile: { default: "profile-a" } }),
			);
			await settingsB.flushOrThrow();

			resetSettingsForTest();
			const projectSettings = await Settings.init({ agentDir, cwd: projectX });
			const reopenedRegistry = new ModelRegistry(authStorage, modelsPath);
			expect(projectSettings.getGlobal("modelProfile.default")).toBe("profile-a");
			expect(projectSettings.getProject("modelProfile.default")).toBe("profile-a");
			const lateProjectSettings = await projectSettings.cloneForCwd(projectY);
			expect(lateProjectSettings.getProject("modelProfile.default")).toBe("profile-a");
			expect(reopenedRegistry.getModelProfileForReference("profile-a")?.displayName).toBe("Profile A");
			expect(reopenedRegistry.getAvailableModelProfileNames()).not.toContain("profile-a");
		} finally {
			resetSettingsForTest();
		}
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
		const flushSpy = spyOn(settings, "flushOrThrow").mockRejectedValueOnce(new Error("flush failed"));

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
	it("rejects profile deletion materialization when config persistence fails", async () => {
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
		const agentDir = path.join(tempDir, "failed-materialization-settings");
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir, cwd: tempDir });
			const configPath = path.join(await fs.realpath(settings.getAgentDir()), "config.yml");
			settings.set("modelProfile.default", customProfile.name);
			settings.setModelRole("default", "old/default");
			await settings.flushOrThrow();
			const session = createDeletionSession();
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (
					typeof args[0] === "string" &&
					args[0].startsWith(`${configPath}.`) &&
					args[0].endsWith(".tmp") &&
					!args[0].startsWith(`${configPath}.revisions.json.`)
				) {
					throw new Error("forced config write failure");
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				await expect(
					materializeModelProfileForDeletion({
						session,
						settings,
						modelRegistry: createRegistry([[customProfile.name, customProfile]]),
						profileName: customProfile.name,
					}),
				).rejects.toThrow("forced config write failure");
			} finally {
				writeSpy.mockRestore();
			}

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir, cwd: tempDir });
			expect(reopened.getGlobal("modelProfile.default")).toBe(customProfile.name);
		} finally {
			resetSettingsForTest();
		}
	});
	it("preserves later durable choices while materializing a profile for deletion", async () => {
		const customProfile: ModelProfileDefinition = {
			name: "custom-default",
			displayName: "Custom Default",
			requiredProviders: ["my-oai"],
			modelMapping: {
				default: "my-oai/gpt-custom:low",
				executor: "my-oai/gpt-custom",
				architect: "my-oai/gpt-custom",
			},
			source: "user",
		};
		const agentDir = path.join(tempDir, "forward-settings");
		resetSettingsForTest();
		const { promise: releaseLookup, resolve: resolveLookup } = Promise.withResolvers<void>();
		const { promise: lookupStarted, resolve: resolveLookupStarted } = Promise.withResolvers<void>();
		try {
			const settingsA = await Settings.init({ agentDir, cwd: tempDir });
			settingsA.setModelRole("default", "old/default");
			settingsA.setAgentModelOverride("critic", "old/critic");
			settingsA.setAgentModelOverride("architect", "my-oai/gpt-custom");
			settingsA.set("modelProfile.default", customProfile.name);
			await settingsA.flushOrThrow();
			const settingsB = await settingsA.cloneForCwd(tempDir);
			const session = createDeletionSession();
			const baseRegistry = createRegistry([[customProfile.name, customProfile]]);
			await activateModelProfile({
				session,
				settings: settingsA,
				modelRegistry: baseRegistry,
				profileName: customProfile.name,
			});
			const originalGetApiKey = baseRegistry.getApiKeyForProvider.bind(baseRegistry);
			const gatedRegistry = {
				...baseRegistry,
				getApiKeyForProvider: async (...args: Parameters<ModelRegistry["getApiKeyForProvider"]>) => {
					resolveLookupStarted();
					await releaseLookup;
					return originalGetApiKey(...args);
				},
			} as ModelRegistry;

			const materializing = materializeModelProfileForDeletion({
				session,
				settings: settingsA,
				modelRegistry: gatedRegistry,
				profileName: customProfile.name,
			});
			await lookupStarted;
			settingsB.setModelRole("default", "external/default");
			settingsB.setAgentModelOverride("architect", "external/architect");
			settingsB.set("modelProfile.default", "profile-b");
			await settingsB.flushOrThrow();
			resolveLookup();
			await materializing;

			expect(settingsA.get("modelRoles")).toEqual({ default: "external/default" });
			expect(settingsA.get("task.agentModelOverrides")).toEqual({
				architect: "external/architect",
				critic: "old/critic",
				executor: "my-oai/gpt-custom",
			});
			expect(settingsA.get("modelProfile.default")).toBe("profile-b");

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir, cwd: tempDir });
			expect(reopened.getGlobal("modelRoles")).toEqual({ default: "external/default" });
			expect(reopened.getGlobal("task.agentModelOverrides")).toEqual({
				architect: "external/architect",
				critic: "old/critic",
				executor: "my-oai/gpt-custom",
			});
			expect(reopened.getGlobal("modelProfile.default")).toBe("profile-b");
		} finally {
			resolveLookup();
			resetSettingsForTest();
		}
	});
	it("rolls back only deletion leaves that no later writer changed", async () => {
		const customProfile: ModelProfileDefinition = {
			name: "custom-default",
			displayName: "Custom Default",
			requiredProviders: ["my-oai"],
			modelMapping: {
				default: "my-oai/gpt-custom:low",
				executor: "my-oai/gpt-custom",
				architect: "my-oai/gpt-custom",
			},
			source: "user",
		};
		const agentDir = path.join(tempDir, "rollback-settings");
		resetSettingsForTest();
		try {
			const settingsA = await Settings.init({ agentDir, cwd: tempDir });
			settingsA.setModelRole("default", "old/default");
			settingsA.setAgentModelOverride("critic", "old/critic");
			settingsA.set("modelProfile.default", customProfile.name);
			await settingsA.flushOrThrow();
			const session = createDeletionSession();
			const registry = createRegistry([[customProfile.name, customProfile]]);
			await activateModelProfile({
				session,
				settings: settingsA,
				modelRegistry: registry,
				profileName: customProfile.name,
			});
			const snapshot = await materializeModelProfileForDeletion({
				session,
				settings: settingsA,
				modelRegistry: registry,
				profileName: customProfile.name,
			});
			expect(snapshot.previousPersistedModelRoles).toEqual({ default: "old/default" });
			expect(snapshot.previousPersistedAgentModelOverrides).toEqual({ critic: "old/critic" });
			const settingsB = await settingsA.cloneForCwd(tempDir);
			settingsB.setModelRole("default", "external/default");
			settingsB.setAgentModelOverride("architect", "external/architect");
			settingsB.setAgentModelOverride("executor", "my-oai/gpt-custom");
			settingsB.set("modelProfile.default", "profile-b");
			await settingsB.flushOrThrow();

			await restoreMaterializedModelProfileForDeletion({ settings: settingsA, session, snapshot });

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir, cwd: tempDir });
			expect(reopened.getGlobal("modelRoles")).toEqual({ default: "external/default" });
			expect(reopened.getGlobal("task.agentModelOverrides")).toEqual({
				architect: "external/architect",
				critic: "old/critic",
				executor: "my-oai/gpt-custom",
			});
			expect(reopened.getGlobal("modelProfile.default")).toBe("profile-b");
		} finally {
			resetSettingsForTest();
		}
	});
	it("refuses controller deletion when the same profile is selected after materialization", async () => {
		const profileName = "custom-default";
		const profile: ModelProfileDefinition = {
			name: profileName,
			displayName: "Custom Default",
			requiredProviders: ["my-oai"],
			modelMapping: { default: "my-oai/gpt-custom:low" },
			source: "user",
		};
		const agentDir = path.join(tempDir, "concurrent-delete-agent");
		resetSettingsForTest();
		try {
			const settingsA = await Settings.init({ agentDir, cwd: tempDir });
			settingsA.set("modelProfile.default", profileName);
			await settingsA.flushOrThrow();
			const settingsB = await settingsA.cloneForCwd(tempDir);
			const profiles = new Map([[profileName, profile]]);
			const harness = await createDeletionControllerHarness(settingsA, profiles, profileName);
			const deleteModelProfileIfUnreferenced = settingsA.deleteModelProfileIfUnreferenced.bind(settingsA);
			const deletionSpy = spyOn(settingsA, "deleteModelProfileIfUnreferenced").mockImplementation(
				async (name, deleteProfile) => {
					settingsB.set("modelProfile.default", profileName);
					await settingsB.flushOrThrow();
					return deleteModelProfileIfUnreferenced(name, deleteProfile);
				},
			);
			try {
				await harness.selector.__testSelectPresetAction(profileName, "delete");
				await Bun.sleep(0);
			} finally {
				deletionSpy.mockRestore();
			}

			expect(harness.getDeleteCalls()).toBe(0);
			expect(profiles.has(profileName)).toBe(true);
			expect(harness.statuses.some(message => message.includes("Custom model preset deleted"))).toBe(false);
			expect(harness.errors).toContain(
				`Preset delete failed: Model profile became the default while deletion was in progress: ${profileName}`,
			);

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir, cwd: tempDir });
			expect(reopened.getGlobal("modelProfile.default")).toBe(profileName);
		} finally {
			resetSettingsForTest();
		}
	});

	it("archives a deleted preset so current-project references remain resolvable", async () => {
		const profileName = "custom-project";
		const profile: ModelProfileDefinition = {
			name: profileName,
			displayName: "Custom Project",
			requiredProviders: ["my-oai"],
			modelMapping: { default: "my-oai/gpt-custom:low" },
			source: "user",
		};
		const agentDir = path.join(tempDir, "project-reference-agent");
		const projectDir = path.join(tempDir, "referencing-project");
		await fs.mkdir(getProjectAgentDir(projectDir), { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			YAML.stringify({ modelProfile: { default: profileName } }),
		);
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir, cwd: projectDir });
			const profiles = new Map([[profileName, profile]]);
			const harness = await createDeletionControllerHarness(settings, profiles);
			await harness.selector.__testSelectPresetAction(profileName, "delete");
			await Bun.sleep(0);

			expect(harness.getDeleteCalls()).toBe(1);
			expect(profiles.has(profileName)).toBe(false);
			expect(harness.getArchivedProfile(profileName)?.displayName).toBe("Custom Project");
			expect(harness.statuses).toContain("Custom model preset deleted: Custom Project");
			expect(harness.errors).toEqual([]);
			expect(settings.getProject("modelProfile.default")).toBe(profileName);
		} finally {
			resetSettingsForTest();
		}
	});
	it("keeps a deleted custom preset committed when post-delete notification fails", async () => {
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
				expect(message).toBe("Configuration was updated, but change notification failed: notify failed");
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
		await Bun.sleep(0);

		expect(confirmTitle).toBe("Delete custom model preset: Custom Default Restored");
		expect(restoredProfile).toBeUndefined();
		expect(profiles.has("custom-default")).toBe(false);
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(settings.get("modelRoles")).toEqual({ default: "my-oai/gpt-custom:low" });
		expect(settings.get("task.agentModelOverrides")).toEqual({ critic: "old/critic" });
		expect(activeProfiles.at(-1)).toBeUndefined();
	});
	it("does not rename when the durable rollback directory barrier fails", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalFsync = syncFs.fsyncSync;
		const originalRename = syncFs.renameSync;
		let rollbackBarrier = false;
		let renamed = false;
		const fsyncSpy = spyOn(syncFs, "fsyncSync").mockImplementation(fd => {
			if (syncFs.fstatSync(fd).isDirectory() && !rollbackBarrier) {
				rollbackBarrier = true;
				throw new Error("forced rollback barrier failure");
			}
			return originalFsync(fd);
		});
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			renamed = true;
			return originalRename(source, destination);
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"forced rollback barrier failure",
			);
		} finally {
			renameSpy.mockRestore();
			fsyncSpy.mockRestore();
		}
		expect(rollbackBarrier).toBe(true);
		expect(renamed).toBe(false);
	});
	it("keeps retained-descriptor bytes through recovery rotation", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalText = await Bun.file(modelsPath).text();
		const competingText = `${originalText}\n# retained mutation\n`;
		const retained = syncFs.openSync(modelsPath, "r+");
		const originalRename = syncFs.renameSync;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			const result = originalRename(source, destination);
			if (String(source).endsWith(".rollback") && String(destination).endsWith(".recovery")) {
				syncFs.writeSync(retained, competingText, 0, "utf8");
			}
			return result;
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			renameSpy.mockRestore();
			syncFs.closeSync(retained);
		}
		expect(await Bun.file(`${modelsPath}.recovery`).text()).toBe(competingText);
	});
	it("keeps retained-descriptor bytes written before final post-commit stat", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalText = await Bun.file(modelsPath).text();
		const competingText = `${originalText}\n# final stat mutation\n`;
		const retained = syncFs.openSync(modelsPath, "r+");
		const originalRename = syncFs.renameSync;
		const originalStat = syncFs.statSync;
		let committed = false;
		let postCommitStats = 0;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			const result = originalRename(source, destination);
			if (String(source).endsWith(".tmp") && String(destination).endsWith("models.yml")) committed = true;
			return result;
		});
		const statSpy = spyOn(syncFs, "statSync").mockImplementation(((target: Parameters<typeof syncFs.statSync>[0]) => {
			if (committed && String(target).endsWith("models.yml") && ++postCommitStats === 2) {
				syncFs.writeSync(retained, competingText, 0, "utf8");
			}
			return originalStat(target);
		}) as typeof syncFs.statSync);
		try {
			await registry.saveCustomModelProfile("profile-a", snapshot);
		} finally {
			statSpy.mockRestore();
			renameSpy.mockRestore();
			syncFs.closeSync(retained);
		}
		expect(postCommitStats).toBe(2);
		expect(await Bun.file(`${modelsPath}.recovery`).text()).toBe(competingText);
	});
	it("rejects fixed recovery displacement during rollback rotation", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const originalText = await Bun.file(modelsPath).text();
		const aliasPath = path.join(tempDir, "retained-alias");
		const originalRename = syncFs.renameSync;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			const result = originalRename(source, destination);
			if (String(source).endsWith(".rollback") && String(destination).endsWith(".recovery")) {
				originalRename(destination, aliasPath);
			}
			return result;
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			renameSpy.mockRestore();
		}
		expect(await Bun.file(aliasPath).text()).toBe(originalText);
	});
	it("preserves evidence when rename-boundary metadata changes", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		await fs.chmod(modelsPath, 0o644);
		const originalRename = syncFs.renameSync;
		const renameSpy = spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			if (String(source).endsWith(".tmp") && String(destination).endsWith("models.yml"))
				syncFs.chmodSync(destination, 0o600);
			return originalRename(source, destination);
		});
		try {
			await expect(registry.saveCustomModelProfile("profile-a", snapshot)).rejects.toThrow(
				"Models config was committed, but verification failed",
			);
		} finally {
			renameSpy.mockRestore();
		}
		expect((await fs.readdir(tempDir)).some(name => name.endsWith(".recovery"))).toBe(true);
	});
	it("keeps one bounded previous-generation recovery across successful replacements", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("seed", snapshot);
		const firstGeneration = await Bun.file(modelsPath).text();
		await registry.saveCustomModelProfile("profile-a", snapshot);

		const recoveryPath = `${modelsPath}.recovery`;
		expect(await Bun.file(recoveryPath).text()).toBe(firstGeneration);
		expect((await fs.readdir(tempDir)).filter(name => name.endsWith(".recovery"))).toEqual(["models.yml.recovery"]);

		const secondGeneration = await Bun.file(modelsPath).text();
		await registry.saveCustomModelProfile("profile-b", snapshot);
		expect(await Bun.file(recoveryPath).text()).toBe(secondGeneration);
		expect((await fs.readdir(tempDir)).filter(name => name.endsWith(".recovery"))).toEqual(["models.yml.recovery"]);
	});
});
