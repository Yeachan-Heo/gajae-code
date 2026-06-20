import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { parseSetupArgs, runSetupCommand } from "../src/cli/setup-cli";
import { addApiCompatibleProvider } from "../src/setup/provider-onboarding";

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

	it("rejects provider flags unless provider setup is explicit", async () => {
		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				"-e",
				`import { parseSetupArgs } from "./src/cli/setup-cli";
				const errors = [];
				const realExit = process.exit;
				console.error = (...args) => errors.push(args.join(" "));
				process.exit = code => { throw new Error("exit " + code); };
				try {
					parseSetupArgs(["setup", "--provider", "proxy", "--compat", "openai"]);
					process.exit(2);
				} catch (error) {
					if (String(error?.message ?? error) === "exit 1" && errors.some(error => error.includes("Provider setup flags require the explicit"))) {
						process.stdout.write("ok");
						realExit(0);
					}
					process.stderr.write(String(error?.stack ?? error));
					realExit(1);
				}`,
			],
			cwd: path.join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
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
					"--worktree-name",
					"hermes-gajae-code",
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
					worktreeName: "hermes-gajae-code",
					mutation: ["sessions,reports"],
					json: true,
				},
			});
		});

		it("renders Hermes setup with a model-agnostic usable GJC session command", async () => {
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
			expect(configPreview).toContain("GJC_COORDINATOR_MCP_SESSION_COMMAND: gjc --worktree");
			expect(output).toContain("owns worktree creation and resume identity");
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
			expect(parsed.mcp_servers.gjc_coordinator?.env?.GJC_COORDINATOR_MCP_SESSION_COMMAND).toBe("gjc --worktree");
		});

		it("renders named Hermes worktree commands and allows explicit opt-out", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const named = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runSetupCommand({
				component: "hermes",
				flags: {
					json: true,
					root: [tempRoot],
					worktreeName: "hermes-gajae-code",
				},
			});

			const namedOutput = named.mock.calls.map(call => String(call[0])).join("");
			expect(namedOutput).toContain("GJC_COORDINATOR_MCP_SESSION_COMMAND: gjc --worktree hermes-gajae-code");
			named.mockRestore();
			const noWorktree = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runSetupCommand({
				component: "hermes",
				flags: {
					json: true,
					root: [tempRoot],
					noWorktree: true,
				},
			});

			const noWorktreeOutput = noWorktree.mock.calls.map(call => String(call[0])).join("");
			expect(noWorktreeOutput).toContain("GJC_COORDINATOR_MCP_SESSION_COMMAND: gjc");
			expect(noWorktreeOutput).not.toContain("GJC_COORDINATOR_MCP_SESSION_COMMAND: gjc --worktree");
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
			const proc = Bun.spawn({
				cmd: [
					process.execPath,
					"-e",
					`import { runHermesSetup } from "./src/setup/hermes-setup";
					try {
						await runHermesSetup({ json: true, install: true, root: [${JSON.stringify(tempRoot)}], target: ${JSON.stringify(configPath)} });
						process.exit(1);
					} catch (error) {
						const message = String(error?.message ?? error);
						if (error?.name === "HermesSetupError" && message.includes("already exists and is not managed by GJC")) {
							process.stdout.write("ok");
							process.exit(0);
						}
						process.stderr.write(String(error?.stack ?? error));
						process.exit(1);
					}`,
				],
				cwd: path.join(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);

			expect(exitCode).toBe(0);
			expect(stdout).toBe("ok");
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
					stateRoot: path.join(tempRoot, "state"),
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
