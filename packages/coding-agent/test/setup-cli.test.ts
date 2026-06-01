import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { parseSetupArgs, runSetupCommand } from "../src/cli/setup-cli";

let tempRoot: string | undefined;

describe("setup CLI parsing", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
			tempRoot = undefined;
		}
	});

	it("defaults bare setup to installing workflow skills", () => {
		expect(parseSetupArgs(["setup"])).toEqual({
			component: "defaults",
			flags: {},
		});
	});

	it("allows bare setup flags for the default workflow skill install", () => {
		expect(parseSetupArgs(["setup", "--check", "--force", "--json"])).toEqual({
			component: "defaults",
			flags: { check: true, force: true, json: true },
		});
	});

	it("keeps optional setup components explicit", () => {
		expect(parseSetupArgs(["setup", "hooks", "-c"])).toEqual({
			component: "hooks",
			flags: { check: true },
		});
	});

	it("rejects provider flags unless provider setup is explicit", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as (code?: string | number | null | undefined) => never);

		expect(() => parseSetupArgs(["setup", "--provider", "proxy", "--compat", "openai"])).toThrow("exit");
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("allows provider flags for explicit provider setup", () => {
		expect(parseSetupArgs(["setup", "provider", "--provider", "proxy", "--compat", "openai"])).toEqual({
			component: "provider",
			flags: { provider: "proxy", compat: "openai" },
		});
	});

	it("rejects preset provider setup with arbitrary CLI base URL, model, or API key env", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-setup-cli-"));
		const modelsPath = path.join(tempRoot, "models.yml");
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new Error(`exit ${code}`);
		});

		await expect(
			runSetupCommand({
				component: "provider",
				flags: {
					json: true,
					preset: "minimax",
					baseUrl: "https://example.invalid/v1",
					modelsPath,
				},
			}),
		).rejects.toThrow("exit 1");
		await expect(
			runSetupCommand({
				component: "provider",
				flags: {
					json: true,
					preset: "minimax",
					model: ["custom-model"],
					modelsPath,
				},
			}),
		).rejects.toThrow("exit 1");
		await expect(
			runSetupCommand({
				component: "provider",
				flags: {
					json: true,
					preset: "minimax",
					apiKeyEnv: "CUSTOM_KEY",
					modelsPath,
				},
			}),
		).rejects.toThrow("exit 1");

		const errors = stdout.mock.calls.map(call => String(call[0])).join("\n");
		expect(errors).toContain("fixed base URL");
		expect(errors).toContain("fixed model ids");
		expect(errors).toContain("MINIMAX_CODE_API_KEY");
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("keeps generic CLI OpenAI-compatible custom provider setup working", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-setup-cli-"));
		const modelsPath = path.join(tempRoot, "models.yml");
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runSetupCommand({
			component: "provider",
			flags: {
				json: true,
				compat: "openai",
				provider: "custom-minimax",
				baseUrl: "https://example.invalid/v1",
				apiKeyEnv: "CUSTOM_KEY",
				model: ["custom-model"],
				modelsPath,
			},
		});

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { baseUrl: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["custom-minimax"]?.baseUrl).toBe("https://example.invalid/v1");
		expect(parsed.providers["custom-minimax"]?.apiKeyEnv).toBe("CUSTOM_KEY");
		expect(parsed.providers["custom-minimax"]?.models.map(model => model.id)).toEqual(["custom-model"]);
	});
});
