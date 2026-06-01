import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

let tempAgentDir: string | undefined;
const originalAgentDir = getAgentDir();
const TEST_PROVIDER_KEY_ENV = "GJC_PROVIDER_SLASH_TEST_KEY";

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempAgentDir) {
		await fs.rm(tempAgentDir, { recursive: true, force: true });
		tempAgentDir = undefined;
	}
});

describe("provider slash command", () => {
	it("is advertised as a thin provider onboarding entrypoint", () => {
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "provider");
		expect(command?.description).toContain("providers");
		expect(command?.allowArgs).toBe(true);
	});

	it("reports the /provicer typo without falling through to model bootstrap", async () => {
		const errors: string[] = [];
		const result = await executeBuiltinSlashCommand("/provicer add --compat anthropic", {
			ctx: {
				showError: (text: string) => errors.push(text),
				editor: { setText: () => undefined },
			},
			handleBackgroundCommand: () => undefined,
		} as unknown as Parameters<typeof executeBuiltinSlashCommand>[1]);

		expect(result).toBe(true);
		expect(errors.join("\n")).toContain("Unknown slash command: /provicer");
		expect(errors.join("\n")).toContain("Did you mean /provider?");
	});

	it("adds API-compatible providers through the shared onboarding core", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-slash-"));
		setAgentDir(tempAgentDir);
		const outputs: string[] = [];
		let refreshedMode: string | undefined;
		let configChanged = false;
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "provider");
		expect(command?.handle).toBeTruthy();

		await command?.handle?.(
			{
				name: "provider",
				args: `add --compat anthropic --provider local-claude --base-url https://proxy.example.test --api-key-env ${TEST_PROVIDER_KEY_ENV} --model claude-proxy`,
				text: "/provider add",
			},
			{
				session: {
					modelRegistry: {
						refresh: async (mode: string) => {
							refreshedMode = mode;
						},
					},
				},
				sessionManager: {},
				settings: {},
				cwd: process.cwd(),
				output: (text: string) => outputs.push(text),
				refreshCommands: () => undefined,
				reloadPlugins: async () => undefined,
				notifyConfigChanged: () => {
					configChanged = true;
				},
			} as unknown as SlashCommandRuntime,
		);

		const parsed = YAML.parse(await Bun.file(path.join(tempAgentDir, "models.yml")).text()) as {
			providers: Record<string, { api: string; apiKey?: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["local-claude"]?.api).toBe("anthropic-messages");
		expect(parsed.providers["local-claude"]?.apiKey).toBeUndefined();
		expect(parsed.providers["local-claude"]?.apiKeyEnv).toBe(TEST_PROVIDER_KEY_ENV);
		expect(parsed.providers["local-claude"]?.models.map(model => model.id)).toEqual(["claude-proxy"]);
		expect(outputs.join("\n")).toContain("GJC_…_KEY");
		expect(refreshedMode).toBe("offline");
		expect(configChanged).toBe(true);
	});

	it("adds MiniMax and GLM provider presets through slash onboarding", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-slash-"));
		setAgentDir(tempAgentDir);
		const outputs: string[] = [];
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "provider");
		expect(command?.handle).toBeTruthy();
		const runtime = {
			session: { modelRegistry: { refresh: async () => undefined } },
			sessionManager: {},
			settings: {},
			cwd: process.cwd(),
			output: (text: string) => outputs.push(text),
			refreshCommands: () => undefined,
			reloadPlugins: async () => undefined,
			notifyConfigChanged: () => undefined,
		} as unknown as SlashCommandRuntime;

		await command?.handle?.({ name: "provider", args: "add --preset minimax", text: "/provider add" }, runtime);
		await command?.handle?.({ name: "provider", args: "add zai", text: "/provider add" }, runtime);

		const parsed = YAML.parse(await Bun.file(path.join(tempAgentDir, "models.yml")).text()) as {
			providers: Record<
				string,
				{
					api: string;
					baseUrl: string;
					apiKeyEnv?: string;
					compat?: { thinkingFormat?: string };
					models: Array<{ id: string }>;
				}
			>;
		};
		expect(parsed.providers["minimax-code"]?.api).toBe("openai-completions");
		expect(parsed.providers["minimax-code"]?.baseUrl).toBe("https://api.minimax.io/v1");
		expect(parsed.providers["minimax-code"]?.apiKeyEnv).toBe("MINIMAX_CODE_API_KEY");
		expect(parsed.providers["minimax-code"]?.models.map(model => model.id)).toEqual(["MiniMax-M2.5"]);
		expect(parsed.providers["glm-proxy"]?.api).toBe("openai-completions");
		expect(parsed.providers["glm-proxy"]?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
		expect(parsed.providers["glm-proxy"]?.apiKeyEnv).toBe("ZAI_API_KEY");
		expect(parsed.providers["glm-proxy"]?.compat?.thinkingFormat).toBe("zai");
		expect(parsed.providers["glm-proxy"]?.models.map(model => model.id)).toEqual(["glm-4.6"]);
		expect(outputs.join("\n")).toContain("MiniMax Coding Plan");
		expect(outputs.join("\n")).toContain("GLM / zAI");
	});

	it("rejects raw API keys in public provider onboarding", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-slash-"));
		setAgentDir(tempAgentDir);
		const outputs: string[] = [];
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "provider");

		await command?.handle?.(
			{
				name: "provider",
				args: "add --compat openai --provider raw-key --base-url https://proxy.example.test --api-key sk-secret --model gpt",
				text: "/provider add",
			},
			{
				session: { modelRegistry: { refresh: async () => undefined } },
				sessionManager: {},
				settings: {},
				cwd: process.cwd(),
				output: (text: string) => outputs.push(text),
				refreshCommands: () => undefined,
				reloadPlugins: async () => undefined,
				notifyConfigChanged: () => undefined,
			} as unknown as SlashCommandRuntime,
		);

		expect(outputs.join("\n")).toContain("rejects raw --api-key values");
		expect(await Bun.file(path.join(tempAgentDir, "models.yml")).exists()).toBe(false);
	});

	it("rejects preset overrides through slash provider onboarding", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-slash-"));
		setAgentDir(tempAgentDir);
		const outputs: string[] = [];
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "provider");
		const runtime = {
			session: { modelRegistry: { refresh: async () => undefined } },
			sessionManager: {},
			settings: {},
			cwd: process.cwd(),
			output: (text: string) => outputs.push(text),
			refreshCommands: () => undefined,
			reloadPlugins: async () => undefined,
			notifyConfigChanged: () => undefined,
		} as unknown as SlashCommandRuntime;

		await command?.handle?.(
			{
				name: "provider",
				args: "add --preset minimax --base-url https://example.invalid/v1",
				text: "/provider add",
			},
			runtime,
		);
		await command?.handle?.(
			{
				name: "provider",
				args: "add --preset minimax --model custom-model",
				text: "/provider add",
			},
			runtime,
		);
		await command?.handle?.(
			{
				name: "provider",
				args: "add --preset minimax --api-key-env CUSTOM_KEY",
				text: "/provider add",
			},
			runtime,
		);

		const output = outputs.join("\n");
		expect(output).toContain("fixed base URL");
		expect(output).toContain("fixed model ids");
		expect(output).toContain("MINIMAX_CODE_API_KEY");
		expect(await Bun.file(path.join(tempAgentDir, "models.yml")).exists()).toBe(false);
	});

	it("honors trailing --force for replacement", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-slash-"));
		setAgentDir(tempAgentDir);
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "provider");
		const runtime = {
			session: { modelRegistry: { refresh: async () => undefined } },
			sessionManager: {},
			settings: {},
			cwd: process.cwd(),
			output: () => undefined,
			refreshCommands: () => undefined,
			reloadPlugins: async () => undefined,
			notifyConfigChanged: () => undefined,
		} as unknown as SlashCommandRuntime;

		await command?.handle?.(
			{
				name: "provider",
				args: `add --compat openai --provider replace-me --base-url https://proxy.example.test --api-key-env ${TEST_PROVIDER_KEY_ENV} --model old`,
				text: "/provider add",
			},
			runtime,
		);
		await command?.handle?.(
			{
				name: "provider",
				args: `add --compat openai --provider replace-me --base-url https://proxy.example.test --api-key-env ${TEST_PROVIDER_KEY_ENV} --model new --force`,
				text: "/provider add",
			},
			runtime,
		);

		const parsed = YAML.parse(await Bun.file(path.join(tempAgentDir, "models.yml")).text()) as {
			providers: Record<string, { models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["replace-me"]?.models.map(model => model.id)).toEqual(["new"]);
	});
});
