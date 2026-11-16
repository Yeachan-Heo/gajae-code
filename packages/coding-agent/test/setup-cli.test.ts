import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { parseSetupArgs, printSetupHelp, runSetupCommand } from "../src/cli/setup-cli";
import Setup from "../src/commands/setup";
import { buildHermesSetupSpec, runHermesSetup } from "../src/setup/hermes-setup";
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

	it("rejects Hermes-only flags outside the Hermes component in shared dispatch", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await expect(runSetupCommand({ component: "defaults", flags: { profile: "bot" } })).rejects.toThrow("exit");
		expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain(
			"--profile require the explicit `hermes` component",
		);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("allows provider flags for explicit provider setup", () => {
		expect(parseSetupArgs(["setup", "provider", "--provider", "proxy", "--compat", "openai"])).toEqual({
			component: "provider",
			flags: { provider: "proxy", compat: "openai" },
		});
	});

	it("rejects Hermes-only flags outside the Hermes component during argument parsing", async () => {
		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				"-e",
				`import { parseSetupArgs } from "./src/cli/setup-cli"; parseSetupArgs(["setup", "python", "--profile", "bot"]);`,
			],
			cwd: path.join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("--profile require the explicit `hermes` component");
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

	it("reports failure instead of JSON success when the merged models config cannot load", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-setup-cli-"));
		const modelsPath = path.join(tempRoot, "models.yml");
		const broken = [
			"providers:",
			"  broken:",
			"    baseUrl: https://broken.example/v1",
			"    api: openai-completions",
			"    auth: apiKey",
			"    models:",
			"      - id: broken-model",
			"",
		].join("\n");
		await Bun.write(modelsPath, broken);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);

		await expect(
			runSetupCommand({
				component: "provider",
				flags: {
					json: true,
					compat: "openai",
					provider: "new-provider",
					baseUrl: "https://example.invalid/v1",
					apiKeyEnv: "NEW_PROVIDER_KEY",
					model: ["new-model"],
					modelsPath,
				},
			}),
		).rejects.toThrow("exit");

		const output = stdout.mock.calls.map(call => String(call[0])).join("");
		expect(exit).toHaveBeenCalledWith(1);
		expect(output).toContain('"ok": false');
		expect(output).toContain("Provider broken: custom models need a credential source");
		expect(output).not.toContain('"providerId"');
		// The atomic rename never ran, so the pre-existing broken file is untouched.
		expect(await Bun.file(modelsPath).text()).toBe(broken);
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
		it("parses --coding-agent-dir as a Hermes-only flag", () => {
			expect(
				parseSetupArgs([
					"setup",
					"hermes",
					"--root",
					"/tmp/repo",
					"--state-root",
					"/tmp/state",
					"--coding-agent-dir",
					"/tmp/agent-home",
				]),
			).toEqual({
				component: "hermes",
				flags: {
					root: ["/tmp/repo"],
					stateRoot: "/tmp/state",
					codingAgentDir: "/tmp/agent-home",
				},
			});
		});

		it("rejects --coding-agent-dir outside the Hermes component", async () => {
			const proc = Bun.spawn({
				cmd: [
					process.execPath,
					"-e",
					`import { parseSetupArgs } from "./src/cli/setup-cli"; parseSetupArgs(["setup", "defaults", "--coding-agent-dir", "/tmp/agent"]);`,
				],
				cwd: path.join(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("--coding-agent-dir require the explicit `hermes` component");
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

		it("rejects explicit Hermes session commands outside supported lifecycle selectors", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));

			await expect(
				runHermesSetup({
					json: true,
					root: [tempRoot],
					sessionCommand: "gjc --model anthropic/claude-sonnet-4",
				}),
			).rejects.toThrow("GJC_COORDINATOR_MCP_SESSION_COMMAND supports only");
		});

		it("accepts compatible explicit Hermes lifecycle selectors", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			for (const sessionCommand of ["gjc", "gjc --worktree", "gjc --worktree hermes-gajae-code"]) {
				expect(buildHermesSetupSpec({ root: [tempRoot], sessionCommand }).sessionCommand).toBe(sessionCommand);
			}
		});

		it("rejects invalid session-command selector boundaries", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const cases: Array<{ name: string; flags: Parameters<typeof buildHermesSetupSpec>[0] }> = [
				{ name: "blank selector", flags: { root: [tempRoot], sessionCommand: "   " } },
				{ name: "non-gjc executable", flags: { root: [tempRoot], sessionCommand: "wrapper gjc --worktree" } },
				{
					name: "extra selector argument",
					flags: { root: [tempRoot], sessionCommand: "gjc --worktree hermes extra" },
				},
				{
					name: "option-shaped worktree name",
					flags: { root: [tempRoot], sessionCommand: "gjc --worktree --named" },
				},
				{
					name: "explicit selector with --no-worktree",
					flags: { root: [tempRoot], sessionCommand: "gjc", noWorktree: true },
				},
				{
					name: "explicit selector with --worktree-name",
					flags: { root: [tempRoot], sessionCommand: "gjc --worktree hermes", worktreeName: "other" },
				},
				{
					name: "--no-worktree with --worktree-name",
					flags: { root: [tempRoot], noWorktree: true, worktreeName: "other" },
				},
			];

			for (const { name, flags } of cases) {
				expect(() => buildHermesSetupSpec(flags), name).toThrow();
			}
		});

		it("keeps the Oclif session-command help aligned with typed GJC lifecycle selectors", () => {
			expect(Setup.flags["session-command"].description).toBe(
				"Typed GJC lifecycle selector: gjc | gjc --worktree [name]",
			);
		});

		it("keeps session-command help aligned with typed GJC lifecycle selectors", () => {
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			printSetupHelp();
			const output = log.mock.calls.map(call => String(call[0])).join("\n");
			const commandLines = output
				.split("\n")
				.filter(line => line.includes("setup hermes") && line.includes("--session-command"));

			expect(commandLines).toEqual([
				expect.stringContaining('--session-command "gjc --worktree hermes-custom"'),
				expect.stringContaining("--session-command gjc"),
			]);
			expect(output).toContain("Typed GJC lifecycle selector: gjc | gjc --worktree [name]");
			expect(commandLines.join("\n")).not.toContain("--model");
		});

		it("installs an operator template that persists the returned event cursor", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const profileDir = path.join(tempRoot, "profile");
			const result = await runHermesSetup({
				install: true,
				root: [tempRoot],
				profileDir,
			});
			const operatorPath = result.files_written.find(file => file.endsWith(path.join("gajae-code", "SKILL.md")));
			const renderedTemplate = result.previews.find(preview => preview.path === operatorPath)?.content;

			expect(operatorPath).toBeDefined();
			if (!operatorPath || !renderedTemplate) throw new Error("missing_operator_template");
			expect(renderedTemplate).toContain("`next_after_seq`");
			expect(renderedTemplate).not.toContain("`latest_seq`");
			expect(await Bun.file(operatorPath).text()).toBe(renderedTemplate);
		});

		it("keeps generated lifecycle selectors literal when the MCP executable is customized", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const result = await runHermesSetup({
				json: true,
				root: [tempRoot],
				gjcCommand: "/opt/gjc",
			});
			const configPreview = result.previews.find(preview => preview.path.endsWith(".yaml"))?.content ?? "";
			const parsed = YAML.parse(configPreview) as {
				mcp_servers: Record<string, { command: string; env?: Record<string, string> }>;
			};
			const server = parsed.mcp_servers.gjc_coordinator;
			expect(server.command).toBe("/opt/gjc");
			expect(server.env?.GJC_COORDINATOR_MCP_SESSION_COMMAND).toBe("gjc --worktree");
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

		it("checks installed Hermes setup signatures without writing", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const profileDir = path.join(tempRoot, "profile");
			const missing = await runHermesSetup({ check: true, root: [tempRoot], profileDir });
			expect(missing).toMatchObject({ ok: false, mode: "check", files_written: [] });
			expect(missing.check?.mismatches).toContainEqual({
				path: path.join(profileDir, "config.yaml"),
				kind: "missing",
			});

			await runHermesSetup({ install: true, root: [tempRoot], profileDir });
			const current = await runHermesSetup({ check: true, root: [tempRoot], profileDir });
			expect(current).toMatchObject({ ok: true, mode: "check", files_written: [], check: { mismatches: [] } });

			const configPath = path.join(profileDir, "config.yaml");
			await Bun.write(
				configPath,
				(await Bun.file(configPath).text()).replace("command: gjc", "command: tampered-gjc"),
			);
			const tampered = await runHermesSetup({ check: true, root: [tempRoot], profileDir });
			expect(tampered.ok).toBe(false);
			expect(tampered.check?.mismatches).toContainEqual({ path: configPath, kind: "invalid" });
		});

		it("rejects conflicting Hermes modes before reading or changing configured targets", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const profileDir = path.join(tempRoot, "profile");
			const configPath = path.join(profileDir, "config.yaml");
			const operatorPath = path.join(profileDir, "skills", "autonomous-ai-agents", "gajae-code", "SKILL.md");
			const configBefore = "preserve-config-bytes\n";
			const operatorBefore = "preserve-operator-bytes\n";
			await fs.mkdir(path.dirname(operatorPath), { recursive: true });
			await Bun.write(configPath, configBefore);
			await Bun.write(operatorPath, operatorBefore);
			const readFile = vi.spyOn(fs, "readFile");

			for (const flags of [
				{ install: true, check: true },
				{ install: true, smoke: true },
				{ check: true, smoke: true },
			]) {
				await expect(runHermesSetup({ ...flags, root: [tempRoot], profileDir })).rejects.toThrow(
					"accepts only one of --install, --check, or --smoke",
				);
			}
			expect(readFile).not.toHaveBeenCalled();
			expect(await Bun.file(configPath).text()).toBe(configBefore);
			expect(await Bun.file(operatorPath).text()).toBe(operatorBefore);
		});

		it("rolls back a committed config when the operator rename fails", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const profileDir = path.join(tempRoot, "profile");
			const configPath = path.join(profileDir, "config.yaml");
			const operatorPath = path.join(profileDir, "skills", "autonomous-ai-agents", "gajae-code", "SKILL.md");
			await runHermesSetup({ install: true, root: [tempRoot], profileDir });
			const configBefore = await fs.readFile(configPath);
			await fs.rm(operatorPath);
			const renameFile = fs.rename;
			vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
				if (newPath === operatorPath) throw new Error("injected operator rename failure");
				return renameFile(oldPath, newPath);
			});

			await expect(runHermesSetup({ install: true, root: [tempRoot], profileDir })).rejects.toThrow(
				"injected operator rename failure",
			);
			expect(await fs.readFile(configPath)).toEqual(configBefore);
			expect(await Bun.file(operatorPath).exists()).toBe(false);
		});

		it("cleans staged files when second-stage staging fails before either target exists", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const profileDir = path.join(tempRoot, "profile");
			const configPath = path.join(profileDir, "config.yaml");
			const operatorPath = path.join(profileDir, "skills", "autonomous-ai-agents", "gajae-code", "SKILL.md");
			const writeFile = fs.writeFile;
			vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
				if (String(file).startsWith(`${path.dirname(operatorPath)}${path.sep}.`)) {
					throw new Error("injected second-stage failure");
				}
				return writeFile(file, data, options);
			});

			await expect(runHermesSetup({ install: true, root: [tempRoot], profileDir })).rejects.toThrow(
				"injected second-stage failure",
			);
			expect(await Bun.file(configPath).exists()).toBe(false);
			expect(await Bun.file(operatorPath).exists()).toBe(false);
			expect((await fs.readdir(tempRoot, { recursive: true })).filter(file => file.endsWith(".tmp"))).toEqual([]);
		});

		it("cleans staged files when snapshot acquisition fails before commit", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const profileDir = path.join(tempRoot, "profile");
			const configPath = path.join(profileDir, "config.yaml");
			const operatorPath = path.join(profileDir, "skills", "autonomous-ai-agents", "gajae-code", "SKILL.md");
			await runHermesSetup({ install: true, root: [tempRoot], profileDir });
			const configBefore = await fs.readFile(configPath);
			const operatorBefore = await fs.readFile(operatorPath);
			vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("injected snapshot failure"));

			await expect(runHermesSetup({ install: true, root: [tempRoot], profileDir })).rejects.toThrow(
				"injected snapshot failure",
			);
			expect(Buffer.from(await Bun.file(configPath).arrayBuffer())).toEqual(configBefore);
			expect(Buffer.from(await Bun.file(operatorPath).arrayBuffer())).toEqual(operatorBefore);
			expect((await fs.readdir(tempRoot, { recursive: true })).filter(file => file.endsWith(".tmp"))).toEqual([]);
		});

		it("returns a nonzero setup status for failed Hermes checks", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			await runSetupCommand({
				component: "hermes",
				flags: { json: true, check: true, root: [tempRoot], profileDir: path.join(tempRoot, "profile") },
			});
			expect(JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""))).toMatchObject({
				ok: false,
				check: { mismatches: expect.any(Array) },
			});
			expect(exit).toHaveBeenCalledWith(4);
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

		it("leaves every install target byte-identical when an operator conflict is rejected", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const configPath = path.join(tempRoot, "config.yaml");
			const profileDir = path.join(tempRoot, "profile");
			const operatorPath = path.join(profileDir, "skills", "autonomous-ai-agents", "gajae-code", "SKILL.md");
			const configBefore = YAML.stringify({ mcp_servers: { other: { command: "other" } } });
			const operatorBefore = "unmanaged operator instructions";
			await Bun.write(configPath, configBefore);
			await fs.mkdir(path.dirname(operatorPath), { recursive: true });
			await Bun.write(operatorPath, operatorBefore);

			await expect(runHermesSetup({ install: true, root: [tempRoot], profileDir })).rejects.toThrow(
				"Operator instruction target already exists and is not managed by GJC",
			);
			expect(await Bun.file(configPath).text()).toBe(configBefore);
			expect(await Bun.file(operatorPath).text()).toBe(operatorBefore);
		});

		it("requires force for tampered managed Hermes config and operator instructions", async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-setup-"));
			const profileDir = path.join(tempRoot, "profile");
			const configPath = path.join(profileDir, "config.yaml");
			const operatorPath = path.join(profileDir, "skills", "autonomous-ai-agents", "gajae-code", "SKILL.md");
			await runHermesSetup({ install: true, root: [tempRoot], profileDir });
			const tamperedConfig = (await Bun.file(configPath).text()).replace("command: gjc", "command: copied-gjc");
			await Bun.write(configPath, tamperedConfig);

			await expect(runHermesSetup({ install: true, root: [tempRoot], profileDir })).rejects.toThrow(
				"has GJC managed markers but its setup signature does not match",
			);
			expect(await Bun.file(configPath).text()).toBe(tamperedConfig);

			await runHermesSetup({ install: true, force: true, root: [tempRoot], profileDir });
			const tamperedOperator = `${await Bun.file(operatorPath).text()}\nTampered.`;
			await Bun.write(operatorPath, tamperedOperator);
			await expect(runHermesSetup({ install: true, root: [tempRoot], profileDir })).rejects.toThrow(
				"Operator instruction target already exists and is not managed by GJC",
			);
			expect(await Bun.file(operatorPath).text()).toBe(tamperedOperator);
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

describe("setup CLI host plugins", () => {
	it("parses claude and codex components", () => {
		expect(parseSetupArgs(["setup", "claude", "--json"])).toEqual({ component: "claude", flags: { json: true } });
		expect(parseSetupArgs(["setup", "codex", "--json"])).toEqual({ component: "codex", flags: { json: true } });
	});

	it("renders a fail-closed Claude plugin setup with concrete workdir roots", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await runSetupCommand({ component: "claude", flags: { json: true, root: ["/tmp/example-repo"] } });
			const output = stdout.mock.calls.map(call => String(call[0])).join("");
			const parsed = JSON.parse(output) as {
				host: string;
				gated: boolean;
				coordinatorConfigPreview: { env: Record<string, string> };
			};
			expect(parsed.host).toBe("claude");
			expect(parsed.gated).toBe(false);
			expect(parsed.coordinatorConfigPreview.env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS).toBe("/tmp/example-repo");
			expect(parsed.coordinatorConfigPreview.env.GJC_COORDINATOR_MCP_MUTATIONS).toBeUndefined();
			expect("GJC_COORDINATOR_MCP_ROOTS" in parsed.coordinatorConfigPreview.env).toBe(false);
		} finally {
			stdout.mockRestore();
		}
	});

	it("renders Codex plugin setup verified on a local marketplace smoke", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await runSetupCommand({ component: "codex", flags: { json: true, root: ["/tmp/example-repo"] } });
			const output = stdout.mock.calls.map(call => String(call[0])).join("");
			const parsed = JSON.parse(output) as {
				host: string;
				gated: boolean;
				notes: string[];
				installGuidance: string[];
			};
			expect(parsed.host).toBe("codex");
			expect(parsed.gated).toBe(false);
			expect(parsed.installGuidance.join(" ")).toContain("codex plugin marketplace add");
		} finally {
			stdout.mockRestore();
		}
	});

	it("performs a real non-mutating check against the generated bundle on disk", async () => {
		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await runSetupCommand({ component: "claude", flags: { json: true, check: true, root: [repoRoot] } });
			const output = stdout.mock.calls.map(call => String(call[0])).join("");
			const parsed = JSON.parse(output) as { check?: { ok: boolean; checked: string[]; missing: string[] } };
			expect(parsed.check).toBeDefined();
			expect(parsed.check?.checked.length).toBeGreaterThan(0);
			expect(parsed.check?.ok).toBe(true);
			expect(parsed.check?.missing).toEqual([]);
		} finally {
			stdout.mockRestore();
		}
	});
});
