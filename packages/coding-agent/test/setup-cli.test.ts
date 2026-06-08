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

	describe("Hermes setup", () => {
		afterEach(async () => {
			vi.restoreAllMocks();
			if (tempRoot) {
				await fs.rm(tempRoot, { recursive: true, force: true });
				tempRoot = undefined;
			}
		});

		it("parses Hermes setup flags without treating models as defaults", () => {
			expect(
				parseSetupArgs([
					"setup",
					"hermes",
					"--root",
					"/tmp/repo",
					"--profile",
					"bot",
					"--repo",
					"gajae-code",
					"--session-command",
					"gjc --model openai/gpt-5.5",
					"--mutation",
					"sessions,reports",
					"--json",
				]),
			).toEqual({
				component: "hermes",
				flags: {
					root: ["/tmp/repo"],
					profile: "bot",
					repo: "gajae-code",
					sessionCommand: "gjc --model openai/gpt-5.5",
					mutation: ["sessions,reports"],
					json: true,
				},
			});
		});

		it("renders Hermes setup without a product-default model", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runSetupCommand({
				component: "hermes",
				flags: {
					json: true,
					root: [tempRoot],
				},
			});

			const output = stdout.mock.calls.map(call => String(call[0])).join("");
			const parsed = JSON.parse(output) as { previews: Array<{ path: string; content: string }> };
			const configPreview = parsed.previews.find(preview => preview.path.endsWith(".yaml"))?.content ?? "";
			expect(configPreview).not.toContain("openai/gpt-5.5");
			expect(configPreview).not.toContain("--model");
			expect(configPreview).not.toContain("GJC_COORDINATOR_MCP_SESSION_COMMAND");
		});

		it("preserves explicit Hermes session commands exactly", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const sessionCommand = "gjc --model anthropic/claude-sonnet-4";

			await runSetupCommand({
				component: "hermes",
				flags: {
					json: true,
					root: [tempRoot],
					sessionCommand,
				},
			});

			const output = stdout.mock.calls.map(call => String(call[0])).join("");
			expect(output).toContain(sessionCommand);
		});

		it("installs Hermes config without overwriting unrelated servers", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const configPath = path.join(tempRoot, "config.yaml");
			await Bun.write(
				configPath,
				YAML.stringify({
					mcp_servers: {
						other: {
							command: "other",
						},
					},
				}),
			);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runSetupCommand({
				component: "hermes",
				flags: {
					json: true,
					install: true,
					root: [tempRoot],
					target: configPath,
					mutation: ["sessions,questions"],
				},
			});

			const parsed = YAML.parse(await Bun.file(configPath).text()) as {
				mcp_servers: Record<string, { command: string; env?: Record<string, string> }>;
			};
			expect(parsed.mcp_servers.other?.command).toBe("other");
			expect(parsed.mcp_servers.gjc_coordinator?.command).toBe("gjc");
			expect(parsed.mcp_servers.gjc_coordinator?.env?.GJC_COORDINATOR_MCP_MUTATIONS).toBe("sessions,questions");
			expect(parsed.mcp_servers.gjc_coordinator?.env?.GJC_COORDINATOR_MCP_SESSION_COMMAND).toBeUndefined();
		});

		it("rejects unmanaged Hermes server conflicts unless forced", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const configPath = path.join(tempRoot, "config.yaml");
			await Bun.write(
				configPath,
				YAML.stringify({
					mcp_servers: {
						gjc_coordinator: {
							command: "custom",
						},
					},
				}),
			);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
				throw new Error(`exit ${code}`);
			});

			await expect(
				runSetupCommand({
					component: "hermes",
					flags: {
						json: true,
						install: true,
						root: [tempRoot],
						target: configPath,
					},
				}),
			).rejects.toThrow("exit 3");
		});

		it("smoke checks the current Hermes MCP tool contract without provider credentials", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runSetupCommand({
				component: "hermes",
				flags: {
					json: true,
					smoke: true,
					root: [tempRoot],
				},
			});

			const output = stdout.mock.calls.map(call => String(call[0])).join("");
			const parsed = JSON.parse(output) as { smoke: { requiredTools: string[] } };
			expect(parsed.smoke.requiredTools).toContain("gjc_coordinator_send_prompt");
			expect(parsed.smoke.requiredTools).toContain("gjc_coordinator_submit_question_answer");
			expect(output).not.toContain("OPENAI");
			expect(output).not.toContain("ANTHROPIC");
		});
	});
});
