import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, setAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { parseSetupArgs } from "../src/cli/setup-cli";
import { SqliteAuthCredentialStore } from "../src/session/auth-storage";
import {
	addApiCompatibleProvider,
	findProviderPreset,
	formatProviderPresetList,
	formatProviderSetupResult,
	parseModelList,
	parseProviderCompatibility,
	redactSecret,
} from "../src/setup/provider-onboarding";

let tempRoot: string | undefined;
const originalAgentDir = getAgentDir();

async function tempModelsPath(): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-onboarding-"));
	return path.join(tempRoot, "models.yml");
}

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

describe("provider onboarding setup core", () => {
	it("adds an OpenAI-compatible provider with redacted output", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "My-OAI",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnv: "MY_OAI_KEY",
			models: ["gpt-example, gpt-second"],
			modelsPath,
		});

		expect(result.providerId).toBe("my-oai");
		expect(result.api).toBe("openai-responses");
		expect(result.modelIds).toEqual(["gpt-example", "gpt-second"]);
		expect(result.credentialSource).toBe("env");
		expect(formatProviderSetupResult(result)).not.toContain("sk-secret-value");

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { api: string; apiKey?: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["my-oai"]?.api).toBe("openai-responses");
		expect(parsed.providers["my-oai"]?.apiKey).toBeUndefined();
		expect(parsed.providers["my-oai"]?.apiKeyEnv).toBe("MY_OAI_KEY");
		expect(parsed.providers["my-oai"]?.models.map(model => model.id)).toEqual(["gpt-example", "gpt-second"]);
	});

	it("creates the models.yml parent directory on first provider add", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-onboarding-"));
		const modelsPath = path.join(tempRoot, "Users", "example", ".gjc", "agent", "models.yml");

		await addApiCompatibleProvider({
			compatibility: "anthropic",
			providerId: "minimax",
			baseUrl: "https://api.minimax.io/anthropic",
			apiKeyEnv: "MINIMAX_APIKEY",
			models: ["MiniMax-M2.7-highspeed"],
			modelsPath,
		});

		expect(await Bun.file(modelsPath).exists()).toBe(true);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { api: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers.minimax?.api).toBe("anthropic-messages");
		expect(parsed.providers.minimax?.apiKeyEnv).toBe("MINIMAX_APIKEY");
		expect(parsed.providers.minimax?.models.map(model => model.id)).toEqual(["MiniMax-M2.7-highspeed"]);
	});

	it("accepts first-class Azure OpenAI and Bedrock provider config shapes", async () => {
		const modelsPath = await tempModelsPath();
		await Bun.write(
			modelsPath,
			YAML.stringify({
				providers: {
					"azure-openai": {
						baseUrl: "https://example-resource.openai.azure.com/openai/v1",
						apiKeyEnv: "AZURE_OPENAI_API_KEY",
						api: "azure-openai-responses",
						models: [{ id: "gpt-4.1" }],
					},
					"amazon-bedrock": {
						baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
						api: "bedrock-converse-stream",
						models: [{ id: "us.anthropic.claude-opus-4-6-v1" }],
					},
				},
			}),
		);

		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "glm-proxy",
			baseUrl: "https://api.z.ai/api/paas/v4",
			apiKeyEnv: "ZAI_API_KEY",
			models: ["glm-4.6"],
			modelsPath,
		});

		expect(result.providerId).toBe("glm-proxy");
	});

	it("adds MiniMax through the provider preset with OpenAI-compatible config", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			preset: "minimax",
			modelsPath,
		});

		expect(result.providerId).toBe("minimax-code");
		expect(result.api).toBe("openai-completions");
		expect(result.preset).toBe("minimax");
		expect(result.modelIds).toEqual(["minimax-m3"]);
		expect(formatProviderSetupResult(result)).toContain("MiniMax Coding Plan");

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<
				string,
				{
					api: string;
					baseUrl: string;
					apiKeyEnv?: string;
					compat?: { supportsStore?: boolean; supportsDeveloperRole?: boolean; reasoningContentField?: string };
					models: Array<{ id: string }>;
				}
			>;
		};
		expect(parsed.providers["minimax-code"]?.api).toBe("openai-completions");
		expect(parsed.providers["minimax-code"]?.baseUrl).toBe("https://api.minimax.io/v1");
		expect(parsed.providers["minimax-code"]?.apiKeyEnv).toBe("MINIMAX_CODE_API_KEY");
		expect(parsed.providers["minimax-code"]?.compat?.supportsStore).toBe(false);
		expect(parsed.providers["minimax-code"]?.compat?.supportsDeveloperRole).toBe(false);
		expect(parsed.providers["minimax-code"]?.compat?.reasoningContentField).toBe("reasoning_content");
		expect(parsed.providers["minimax-code"]?.models.map(model => model.id)).toEqual(["minimax-m3"]);
	});

	it("adds GLM/zAI through preset aliases with OpenAI-compatible config", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			preset: "zai",
			modelsPath,
		});

		expect(result.providerId).toBe("glm-proxy");
		expect(result.api).toBe("openai-completions");
		expect(result.preset).toBe("glm");
		expect(result.modelIds).toEqual(["glm-4.6"]);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<
				string,
				{
					api: string;
					baseUrl: string;
					apiKeyEnv?: string;
					compat?: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean; thinkingFormat?: string };
					models: Array<{ id: string }>;
				}
			>;
		};
		expect(parsed.providers["glm-proxy"]?.api).toBe("openai-completions");
		expect(parsed.providers["glm-proxy"]?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
		expect(parsed.providers["glm-proxy"]?.apiKeyEnv).toBe("ZAI_API_KEY");
		expect(parsed.providers["glm-proxy"]?.compat?.supportsDeveloperRole).toBe(false);
		expect(parsed.providers["glm-proxy"]?.compat?.supportsReasoningEffort).toBe(false);
		expect(parsed.providers["glm-proxy"]?.compat?.thinkingFormat).toBe("zai");
		expect(parsed.providers["glm-proxy"]?.models.map(model => model.id)).toEqual(["glm-4.6"]);
	});

	it("adds an Anthropic-compatible provider without deleting unrelated providers", async () => {
		const modelsPath = await tempModelsPath();
		await Bun.write(
			modelsPath,
			YAML.stringify({
				providers: {
					existing: {
						baseUrl: "https://old.example/v1",
						apiKey: "old",
						api: "openai-responses",
						models: [{ id: "old-model" }],
					},
				},
			}),
		);

		await addApiCompatibleProvider({
			compatibility: "anthropic",
			providerId: "claude-proxy",
			baseUrl: "http://127.0.0.1:4000",
			apiKey: "anthropic-secret",
			models: ["claude-custom"],
			modelsPath,
		});

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { api: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers.existing?.api).toBe("openai-responses");
		expect(parsed.providers["claude-proxy"]?.api).toBe("anthropic-messages");
		expect(parsed.providers["claude-proxy"]?.models.map(model => model.id)).toEqual(["claude-custom"]);
	});

	it("stores literal keys in AuthStorage instead of models.yml", async () => {
		const modelsPath = await tempModelsPath();
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "literal-key-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "literal-secret",
			models: ["example-model"],
			modelsPath,
		});
		const text = await Bun.file(modelsPath).text();
		expect(text).not.toContain("literal-secret");
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("literal-key-provider")[0]?.credential).toEqual({
				type: "api_key",
				key: "literal-secret",
			});
		} finally {
			store.close();
		}
	});

	it("stores literal keys in the canonical agent database with a custom models path", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-onboarding-"));
		setAgentDir(path.join(tempRoot, "agent"));
		const modelsPath = path.join(tempRoot, "custom", "models.yml");
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "custom-path-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "custom-path-secret",
			models: ["example-model"],
			modelsPath,
		});

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("custom-path-provider")[0]?.credential).toEqual({
				type: "api_key",
				key: "custom-path-secret",
			});
		} finally {
			store.close();
		}
		expect(await Bun.file(path.join(path.dirname(modelsPath), "agent.db")).exists()).toBe(false);
	});

	it("rejects remote plaintext HTTP and existing providers unless forced", async () => {
		const modelsPath = await tempModelsPath();
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "remote-http",
				baseUrl: "http://api.example.test/v1",
				apiKeyEnv: "REMOTE_HTTP_KEY",
				models: ["gpt-example"],
				modelsPath,
			}),
		).rejects.toThrow("https");

		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "local-http",
			baseUrl: "http://[::1]:4000/v1",
			apiKeyEnv: "LOCAL_HTTP_KEY",
			models: ["gpt-example"],
			modelsPath,
		});
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "local-http",
				baseUrl: "http://127.0.0.1:5000/v1",
				apiKeyEnv: "LOCAL_HTTP_KEY",
				models: ["gpt-updated"],
				modelsPath,
			}),
		).rejects.toThrow("already exists");
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "local-http",
			baseUrl: "http://127.0.0.1:5000/v1",
			apiKeyEnv: "LOCAL_HTTP_KEY",
			models: ["gpt-updated"],
			modelsPath,
			force: true,
		});
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { baseUrl: string; apiKeyEnv: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["local-http"]?.baseUrl).toBe("http://127.0.0.1:5000/v1");
		expect(parsed.providers["local-http"]?.apiKeyEnv).toBe("LOCAL_HTTP_KEY");
		expect(parsed.providers["local-http"]?.models.map(model => model.id)).toEqual(["gpt-updated"]);
	});

	it("rejects conflicting compatibility when a provider preset is used", async () => {
		await expect(
			addApiCompatibleProvider({
				preset: "minimax",
				compatibility: "anthropic",
				modelsPath: await tempModelsPath(),
			}),
		).rejects.toThrow("minimax' is openai-compatible");
	});

	it("rejects provider preset attempts to override fixed base URL, model, or API key env", async () => {
		const modelsPath = await tempModelsPath();

		await expect(
			addApiCompatibleProvider({
				preset: "minimax",
				baseUrl: "https://example.invalid/v1",
				modelsPath,
			}),
		).rejects.toThrow("fixed base URL");
		await expect(
			addApiCompatibleProvider({
				preset: "minimax",
				models: ["custom-model"],
				modelsPath,
			}),
		).rejects.toThrow("fixed model ids");
		await expect(
			addApiCompatibleProvider({
				preset: "minimax",
				apiKeyEnv: "CUSTOM_KEY",
				modelsPath,
			}),
		).rejects.toThrow("MINIMAX_CODE_API_KEY");

		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("keeps generic OpenAI-compatible custom provider setup available for custom values", async () => {
		const modelsPath = await tempModelsPath();

		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "custom-minimax",
			baseUrl: "https://example.invalid/v1",
			apiKeyEnv: "CUSTOM_KEY",
			models: ["custom-model"],
			modelsPath,
		});

		expect(result.providerId).toBe("custom-minimax");
		expect(result.modelIds).toEqual(["custom-model"]);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { baseUrl: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["custom-minimax"]?.baseUrl).toBe("https://example.invalid/v1");
		expect(parsed.providers["custom-minimax"]?.apiKeyEnv).toBe("CUSTOM_KEY");
		expect(parsed.providers["custom-minimax"]?.models.map(model => model.id)).toEqual(["custom-model"]);
	});

	it("validates compatibility, models, urls, and redacts short secrets", () => {
		expect(parseProviderCompatibility("oai")).toBe("openai");
		expect(parseProviderCompatibility("claude")).toBe("anthropic");
		expect(findProviderPreset("minimax-code")?.id).toBe("minimax");
		expect(findProviderPreset("zai")?.id).toBe("glm");
		expect(formatProviderPresetList()).toContain("minimax");
		expect(formatProviderPresetList()).toContain("glm");
		expect(parseModelList(["a,b", "a", " c "])).toEqual(["a", "b", "c"]);
		expect(redactSecret("short")).toBe("***");
		expect(redactSecret("sk-1234567890")).toBe("sk-1…7890");
	});

	it("parses setup command provider preset option", () => {
		const parsed = parseSetupArgs(["setup", "provider", "--preset", "glm"]);

		expect(parsed?.component).toBe("provider");
		expect(parsed?.flags.preset).toBe("glm");
	});

	it("parses explicit setup command provider options", () => {
		const parsed = parseSetupArgs([
			"setup",
			"provider",
			"--compat",
			"openai",
			"--provider",
			"local-openai",
			"--base-url",
			"https://api.example.test/v1",
			"--api-key-env",
			"GJC_TEST_PROVIDER_KEY",
			"--model",
			"gpt-one",
			"--models",
			"gpt-two,gpt-three",
		]);

		expect(parsed?.component).toBe("provider");
		expect(parsed?.flags.compat).toBe("openai");
		expect(parsed?.flags.provider).toBe("local-openai");
		expect(parsed?.flags.apiKeyEnv).toBe("GJC_TEST_PROVIDER_KEY");
		expect(parsed?.flags.model).toEqual(["gpt-one", "gpt-two,gpt-three"]);
	});

	it("rejects raw API keys in setup provider arguments", () => {
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((code?: string | number | null | undefined): never => {
				throw new Error(`exit ${code}`);
			});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(() =>
				parseSetupArgs([
					"setup",
					"provider",
					"--compat",
					"openai",
					"--provider",
					"raw-key",
					"--base-url",
					"https://api.example.test/v1",
					"--api-key",
					"sk-secret",
					"--model",
					"gpt",
				]),
			).toThrow("exit 1");
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider setup rejects raw --api-key values"));
		} finally {
			errorSpy.mockRestore();
			exitSpy.mockRestore();
		}
	});
});
