import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { YAML } from "bun";

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-preset-edit-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
});

afterEach(async () => {
	authStorage.close();
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("editCustomModelProfile", () => {
	it("edits a custom model profile in place preserving identity and display name", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("my-fast", {
			display_name: "My Fast",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});

		const { profile, snapshot } = await registry.editCustomModelProfile("my-fast", {
			display_name: "should-be-ignored",
			required_providers: ["stale-provider"],
			model_mapping: { default: "anthropic/claude:high", executor: "my-oai/gpt-custom" },
		});

		expect(profile.name).toBe("my-fast");
		expect(profile.displayName).toBe("My Fast");
		expect(profile.modelMapping.default).toBe("anthropic/claude:high");
		expect(profile.modelMapping.executor).toBe("my-oai/gpt-custom");
		expect(profile.requiredProviders).toEqual(["anthropic", "my-oai"]);

		const fresh = registry.getModelProfile("my-fast");
		expect(fresh?.displayName).toBe("My Fast");
		expect(fresh?.modelMapping.default).toBe("anthropic/claude:high");
		expect(fresh?.modelMapping.executor).toBe("my-oai/gpt-custom");
		expect(fresh?.requiredProviders).toEqual(["anthropic", "my-oai"]);
		expect(registry.getModelProfile("should-be-ignored")).toBeUndefined();

		expect(snapshot.profileName).toBe("my-fast");
		expect(snapshot.previousProfile.model_mapping.default).toBe("my-oai/gpt-custom:low");
		expect(snapshot.previousProfile.display_name).toBe("My Fast");
		expect(snapshot.previousModelsConfigText.length).toBeGreaterThan(0);

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<
				string,
				{ display_name?: string; required_providers: string[]; model_mapping: Record<string, string> }
			>;
		};
		expect(parsed.profiles["my-fast"].display_name).toBe("My Fast");
		expect(parsed.profiles["my-fast"].model_mapping.default).toBe("anthropic/claude:high");
		expect(parsed.profiles["my-fast"].required_providers).toEqual(["anthropic", "my-oai"]);
	});

	it("getModelProfiles is fresh immediately after custom profile edit", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("p", {
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});
		await registry.editCustomModelProfile("p", {
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude:high" },
		});
		const profiles = registry.getModelProfiles();
		expect(profiles.get("p")?.modelMapping.default).toBe("anthropic/claude:high");
		expect(profiles.get("p")?.requiredProviders).toEqual(["anthropic"]);
	});

	it("rejects editing a profile that does not exist", async () => {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		await expect(
			registry.editCustomModelProfile("ghost", {
				required_providers: ["my-oai"],
				model_mapping: { default: "my-oai/gpt-custom" },
			}),
		).rejects.toThrow("Custom model profile does not exist: ghost.");
	});
});

describe("restoreCustomModelProfileEdit", () => {
	it("restores custom profile edit snapshot to exact previous models config bytes", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("my-fast", {
			display_name: "My Fast",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});
		const before = await Bun.file(modelsPath).text();

		const { snapshot } = await registry.editCustomModelProfile("my-fast", {
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude:high" },
		});
		const afterEdit = await Bun.file(modelsPath).text();
		expect(afterEdit).not.toBe(before);
		expect(snapshot.previousModelsConfigText).toBe(before);

		await registry.restoreCustomModelProfileEdit(snapshot);
		const afterRestore = await Bun.file(modelsPath).text();
		expect(afterRestore).toBe(before);

		const restored = registry.getModelProfile("my-fast");
		expect(restored?.displayName).toBe("My Fast");
		expect(restored?.modelMapping.default).toBe("my-oai/gpt-custom:low");
		expect(restored?.requiredProviders).toEqual(["my-oai"]);
	});
});
