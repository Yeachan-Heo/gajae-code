import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelsConfigFile } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";

let root: string;
let profileDir: string;
let ambientDir: string;
let originalAgentDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-session-profile-model-"));
	profileDir = path.join(root, "profile");
	ambientDir = path.join(root, "ambient");
	await Promise.all([fs.mkdir(profileDir, { recursive: true }), fs.mkdir(ambientDir, { recursive: true })]);
});

afterEach(async () => {
	resetSettingsForTest();
	setAgentDir(originalAgentDir);
	await fs.rm(root, { recursive: true, force: true });
});

describe("createAgentSession model profile authority", () => {
	test("uses the session models/config files instead of ambient registry and provider settings", async () => {
		await fs.writeFile(
			path.join(profileDir, "models.yml"),
			[
				"providers:",
				"  profile-provider:",
				"    baseUrl: http://127.0.0.1:1/v1",
				"    apiKey: profile-key",
				"    api: openai-completions",
				"    models:",
				"      - id: profile-model",
				"        name: Profile Model",
				"        contextWindow: 32768",
				"        maxTokens: 4096",
			].join("\n"),
		);
		await fs.writeFile(
			path.join(profileDir, "config.yml"),
			["disabledProviders: []", "modelRoles:", "  default: profile-provider/profile-model"].join("\n"),
		);

		await fs.writeFile(
			path.join(ambientDir, "models.yml"),
			[
				"providers:",
				"  ambient-provider:",
				"    baseUrl: http://127.0.0.1:1/v1",
				"    apiKey: ambient-key",
				"    api: openai-completions",
				"    models:",
				"      - id: ambient-model",
				"        name: Ambient Model",
				"        contextWindow: 32768",
				"        maxTokens: 4096",
			].join("\n"),
		);
		await fs.writeFile(
			path.join(ambientDir, "config.yml"),
			[
				"disabledProviders:",
				"  - profile-provider",
				"modelRoles:",
				"  default: ambient-provider/ambient-model",
			].join("\n"),
		);
		// Seed the process-global settings singleton with a hostile provider policy.
		// The session must replace this reader with its freshly loaded profile scope.
		await Settings.init({
			inMemory: true,
			agentDir: ambientDir,
			overrides: { disabledProviders: ["profile-provider"] },
		});
		setAgentDir(ambientDir);
		const defaultModelsPath = path.join(ambientDir, "models.yml");
		const originalRelocate = ModelsConfigFile.relocate.bind(ModelsConfigFile);
		const relocateSpy = vi
			.spyOn(ModelsConfigFile, "relocate")
			.mockImplementation(requestedPath =>
				requestedPath === undefined ? originalRelocate(defaultModelsPath) : originalRelocate(requestedPath),
			);

		try {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: profileDir,
				modelPattern: "profile-provider/profile-model",
				sessionManager: SessionManager.inMemory(root),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["__none__"],
			});
			try {
				expect(session.model?.provider).toBe("profile-provider");
				expect(session.model?.id).toBe("profile-model");
				expect(session.modelRegistry.getConfiguredProviderIds()).toEqual(["profile-provider"]);
				expect(session.modelRegistry.getAll().map(model => `${model.provider}/${model.id}`)).toContain(
					"profile-provider/profile-model",
				);
				expect(session.modelRegistry.getAll().map(model => `${model.provider}/${model.id}`)).not.toContain(
					"ambient-provider/ambient-model",
				);
			} finally {
				await session.dispose();
			}
		} finally {
			relocateSpy.mockRestore();
		}
	});

	test("rejects an agent directory that conflicts with supplied settings", async () => {
		const settings = await Settings.loadForScope({ cwd: root, agentDir: ambientDir });
		try {
			await expect(
				createAgentSession({
					cwd: root,
					agentDir: profileDir,
					settings,
					sessionManager: SessionManager.inMemory(root),
					disableExtensionDiscovery: true,
					extensions: [],
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					toolNames: ["__none__"],
				}),
			).rejects.toThrow("options.agentDir and options.settings must resolve to the same profile");
		} finally {
			await settings.close();
		}
	});
});
