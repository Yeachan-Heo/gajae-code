import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";

describe("createAgentSession deferred model pattern resolution", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-model-selection-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "runtime-reasoning-model",
					name: "Runtime Reasoning Model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	function buildSessionOptions(modelPattern: string) {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelPattern,
		};
	}

	test("resolves explicit modelPattern after extension providers register", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			buildSessionOptions("runtime-provider/runtime-model"),
		);

		expect(session.model).toBeDefined();
		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-model");
		expect(modelFallbackMessage).toBeUndefined();
	});

	test("does not silently fallback when explicit modelPattern is unresolved", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			buildSessionOptions("missing-provider/missing-model"),
		);

		expect(session.model).toBeUndefined();
		expect(modelFallbackMessage).toBe('Model "missing-provider/missing-model" not found');
	});

	test("does not apply default role thinking override when modelPattern is explicit", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "off" });
		settings.setModelRole("default", "runtime-provider/runtime-reasoning-model:high");

		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-reasoning-model"),
			settings,
		});

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		expect(session.thinkingLevel).toBe("off");
	});

	test("selects the settings default model without synchronously validating auth", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated();
		settings.setModelRole("default", `${defaultModel.provider}/${defaultModel.id}`);

		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("settings default model should not validate auth during startup"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			try {
				expect(session.model?.provider).toBe(defaultModel.provider);
				expect(session.model?.id).toBe(defaultModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
			authStorage.close();
		}
	});

	test("persists model substitution metadata on new session model_change", async () => {
		const effectiveModel: Model = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			thinking: { minLevel: Effort.Minimal, maxLevel: Effort.XHigh, mode: "effort" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 8192,
		};
		const requestedModel: Model = {
			...effectiveModel,
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			contextWindow: 272000,
		};
		const sessionManager = SessionManager.inMemory(tempDir);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model: effectiveModel,
			thinkingLevel: Effort.High,
			modelSubstitution: { requestedModel, reason: "auth_unavailable" },
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const modelChanges = sessionManager.getEntries().filter(entry => entry.type === "model_change");
			expect(modelChanges).toHaveLength(1);
			expect(modelChanges[0]).toMatchObject({
				type: "model_change",
				model: "openai-codex/gpt-5.5",
				previousModel: "openai-codex/gpt-5.3-codex",
				reason: "auth_unavailable",
				thinkingLevel: Effort.High,
			});
		} finally {
			await session.dispose();
		}
	});
});
