import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { parseSetupArgs } from "../src/cli/setup-cli";
import {
	addApiCompatibleProvider,
	formatProviderSetupResult,
	parseModelList,
	parseProviderCompatibility,
	redactSecret,
} from "../src/setup/provider-onboarding";

let tempRoot: string | undefined;

async function tempModelsPath(): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-onboarding-"));
	return path.join(tempRoot, "models.yml");
}

afterEach(async () => {
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

	it("validates compatibility, models, urls, and redacts short secrets", () => {
		expect(parseProviderCompatibility("oai")).toBe("openai");
		expect(parseProviderCompatibility("claude")).toBe("anthropic");
		expect(parseModelList(["a,b", "a", " c "])).toEqual(["a", "b", "c"]);
		expect(redactSecret("short")).toBe("***");
		expect(redactSecret("sk-1234567890")).toBe("sk-1…7890");
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
