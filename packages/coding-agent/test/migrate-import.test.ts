import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { type Context, getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { runMigrate } from "../src/cli/migrate-cli";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadSkillsFromDir } from "../src/extensibility/skills";
import { expandSlashCommand, loadSlashCommands } from "../src/extensibility/slash-commands";
import { readMCPConfigFile } from "../src/runtime-mcp/config-writer";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { type BuiltinSlashCommandRuntime, executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

let home: string;
let cwd: string;

async function write(rel: string, content: string): Promise<void> {
	const full = path.join(home, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-import-home-"));
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-import-cwd-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
});

const opts = (over: Partial<Parameters<typeof runMigrate>[0]>) => ({
	from: ["all"] as string[],
	project: true,
	force: false,
	dryRun: false,
	json: true,
	homeDir: home,
	cwd,
	...over,
});

describe("end-to-end import", () => {
	test("instructions import even when no MCP config or skills are present", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Instructions only.", "utf-8");
		const report = await runMigrate(opts({ from: ["claude-code"] }));
		expect(await fs.readFile(path.join(cwd, ".gjc", "AGENTS.md"), "utf-8")).toBe("Instructions only.");
		expect(report.actions).toContainEqual(expect.objectContaining({ type: "instruction", status: "imported" }));
	});

	test("user instructions import one selected source and report the later collision", async () => {
		await write(".claude/CLAUDE.md", "Claude user instructions.");
		await write(".codex/AGENTS.md", "Codex user instructions.");
		const agentDir = path.join(home, "agent");
		const previous = process.env.GJC_CODING_AGENT_DIR;
		setAgentDir(agentDir);
		try {
			const report = await runMigrate(opts({ project: false, from: ["all"] }));
			const claude = report.actions.find(action => action.type === "instruction" && action.source === "claude-code");
			const codex = report.actions.find(action => action.type === "instruction" && action.source === "codex");
			expect(claude).toMatchObject({ status: "imported", destination: path.join(agentDir, "AGENTS.md") });
			expect(codex).toMatchObject({
				status: "skipped_exists",
				reason: "another selected source already targets this file; import one source at a time",
			});
			expect(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("Claude user instructions.");

			const codexOnly = await runMigrate(opts({ project: false, from: ["codex"], force: true }));
			expect(codexOnly.actions).toContainEqual(
				expect.objectContaining({ source: "codex", type: "instruction", status: "updated" }),
			);
			expect(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("Codex user instructions.");
		} finally {
			if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous;
			resetAgentDirFromEnvironment();
		}
	});

	test("user instruction import refuses a symlinked configuration root", async () => {
		await write(".claude/CLAUDE.md", "Do not write through this link.");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-import-user-outside-"));
		const configRoot = path.join(home, ".gjc");
		await fs.symlink(outside, configRoot, "dir");
		const agentDir = path.join(configRoot, "agent");
		const previous = process.env.GJC_CODING_AGENT_DIR;
		setAgentDir(agentDir);
		try {
			const report = await runMigrate(opts({ project: false, from: ["claude-code"] }));
			const instruction = report.actions.find(action => action.type === "instruction");
			expect(instruction).toMatchObject({ status: "failed_io", operation: "fail" });
			expect(
				await fs.access(path.join(outside, "agent", "AGENTS.md")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous;
			resetAgentDirFromEnvironment();
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("claude-code imports MCP + skill", async () => {
		await write(".claude.json", JSON.stringify({ mcpServers: { claudeSrv: { command: "cbin" } } }));
		await write(".claude/skills/alpha/SKILL.md", "---\ndescription: a\n---\nbody");
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Use the project conventions.", "utf-8");
		const report = await runMigrate(opts({ from: ["claude-code"] }));
		const config = await readMCPConfigFile(path.join(cwd, ".gjc", "mcp.json"));
		expect(config.mcpServers?.claudeSrv).toMatchObject({ command: "cbin" });
		expect(await fs.readFile(path.join(cwd, ".gjc", "skills", "alpha", "SKILL.md"), "utf-8")).toContain(
			"description: a",
		);
		expect(await fs.readFile(path.join(cwd, ".gjc", "AGENTS.md"), "utf-8")).toBe("Use the project conventions.");
		expect(report.actions).toContainEqual(
			expect.objectContaining({
				type: "instruction",
				status: "imported",
				destination: path.join(cwd, ".gjc", "AGENTS.md"),
			}),
		);
		expect(report.ok).toBe(true);
	});

	test("Claude Code commands import as native slash commands, including nested names", async () => {
		const source = "---\ndescription: Review security.\n---\nReview $ARGUMENTS.";
		const markdownDirectorySource = "---\ndescription: Check release.\n---\nCheck $ARGUMENTS.";
		await fs.mkdir(path.join(cwd, ".claude", "commands", "review"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "review", "security.md"), source, "utf-8");
		await fs.mkdir(path.join(cwd, ".claude", "commands", "release.md"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".claude", "commands", "release.md", "check.md"),
			markdownDirectorySource,
			"utf-8",
		);

		const destination = path.join(cwd, ".gjc", "commands", "claude-code", "review", "security.md");
		const markdownDirectoryDestination = path.join(cwd, ".gjc", "commands", "claude-code", "release.md", "check.md");
		const dryRun = await runMigrate(opts({ from: ["claude-code"], dryRun: true }));
		expect(dryRun.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:review:security",
				status: "imported",
				destination,
			}),
		);
		expect(dryRun.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:release.md:check",
				status: "imported",
				destination: markdownDirectoryDestination,
			}),
		);
		expect(dryRun.summary.byType.command.imported).toBe(2);
		expect(
			await fs.access(destination).then(
				() => true,
				() => false,
			),
		).toBe(false);

		const imported = await runMigrate(opts({ from: ["claude-code"] }));
		expect(imported.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:review:security",
				status: "imported",
				destination,
			}),
		);
		expect(imported.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:release.md:check",
				status: "imported",
				destination: markdownDirectoryDestination,
			}),
		);
		expect(await fs.readFile(destination, "utf-8")).toBe(source);
		expect(await fs.readFile(markdownDirectoryDestination, "utf-8")).toBe(markdownDirectorySource);

		const commands = await loadSlashCommands({ cwd });
		expect(commands).toContainEqual(
			expect.objectContaining({ name: "claude-code:review:security", description: "Review security." }),
		);
		expect(commands).toContainEqual(
			expect.objectContaining({ name: "claude-code:release.md:check", description: "Check release." }),
		);
		expect(expandSlashCommand("/claude-code:review:security src/auth.ts", commands)).toContain("Review src/auth.ts.");
	});

	test("Claude Code subagents import with mapped tools and never shadow a bundled role", async () => {
		await fs.mkdir(path.join(cwd, ".claude", "agents"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".claude", "agents", "auditor.md"),
			"---\nname: auditor\ndescription: Reviews diffs.\ntools: Read, Bash, WebFetch, TodoWrite\nmodel: sonnet\n---\n\nYou audit diffs.\n",
			"utf-8",
		);
		await fs.writeFile(
			path.join(cwd, ".claude", "agents", "executor.md"),
			"---\nname: executor\ndescription: Shadow attempt.\n---\n\nDo not shadow.\n",
			"utf-8",
		);

		const report = await runMigrate(opts({ from: ["claude-code"] }));
		const imported = path.join(cwd, ".gjc", "agents", "auditor.md");
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "agent", name: "auditor", destination: imported, status: "imported" }),
		);
		const content = await fs.readFile(imported, "utf-8");
		expect(content).toContain("You audit diffs.");
		expect(content).toContain("read");
		expect(content).toContain("bash");
		expect(content).toContain("web_search");
		// Tools without a GJC equivalent are dropped and reported, never written.
		expect(content).not.toContain("todo");
		expect(content).not.toContain("sonnet");

		const namespaced = path.join(cwd, ".gjc", "agents", "claude-code-executor.md");
		expect(report.actions).toContainEqual(
			expect.objectContaining({
				type: "agent",
				name: "claude-code-executor",
				destination: namespaced,
				status: "imported",
				warnings: expect.arrayContaining([expect.stringContaining("bundled executor role")]),
			}),
		);
		// The bundled executor role keeps its name: no file claims it.
		await expect(fs.stat(path.join(cwd, ".gjc", "agents", "executor.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});

		const rerun = await runMigrate(opts({ from: ["claude-code"] }));
		expect(rerun.actions).toContainEqual(
			expect.objectContaining({ type: "agent", name: "auditor", status: "skipped_exists" }),
		);
	});

	test("Claude commands colliding with built-ins are namespaced", async () => {
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "help.md"), "Help $ARGUMENTS.", "utf-8");
		const destination = path.join(cwd, ".gjc", "commands", "claude-code", "help.md");

		const report = await runMigrate(opts({ from: ["claude-code"] }));
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "command", name: "claude-code:help", destination, status: "imported" }),
		);
		const commands = await loadSlashCommands({ cwd });
		expect(commands).toContainEqual(expect.objectContaining({ name: "claude-code:help" }));
		expect(expandSlashCommand("/claude-code:help project", commands)).toContain("Help project.");
	});

	test("migrated commands under skill and builtin prefixes dispatch as file commands", async () => {
		const skillContent = "---\ndescription: Skill-only content.\n---\nSKILL-ONLY: this is the skill body.";
		const commandContent = "COMMAND PAYLOAD: $ARGUMENTS.";
		const providerCommandContent = "PROVIDER PAYLOAD: $ARGUMENTS.";
		await write(".claude/skills/foo/SKILL.md", skillContent);
		await fs.mkdir(path.join(cwd, ".claude", "commands", "skill"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "skill", "foo.md"), commandContent, "utf-8");
		await fs.mkdir(path.join(cwd, ".claude", "commands", "provider"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".claude", "commands", "provider", "login.md"),
			providerCommandContent,
			"utf-8",
		);

		const report = await runMigrate(opts({ from: ["claude-code"] }));
		const commandPath = path.join(cwd, ".gjc", "commands", "claude-code", "skill", "foo.md");
		const providerCommandPath = path.join(cwd, ".gjc", "commands", "claude-code", "provider", "login.md");
		expect(report.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:skill:foo",
				status: "imported",
				destination: commandPath,
			}),
		);
		expect(report.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:provider:login",
				status: "imported",
				destination: providerCommandPath,
			}),
		);
		expect(report.summary.byType.skill.imported).toBe(1);

		const loadedSkills = await loadSkillsFromDir({ dir: path.join(cwd, ".gjc", "skills"), source: "native:project" });
		const slashCommands = await loadSlashCommands({ cwd });
		expect(loadedSkills.skills).toContainEqual(expect.objectContaining({ name: "foo" }));
		expect(slashCommands).toContainEqual(expect.objectContaining({ name: "claude-code:skill:foo" }));
		expect(slashCommands).toContainEqual(expect.objectContaining({ name: "claude-code:provider:login" }));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const authStorage = await AuthStorage.create(path.join(home, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const mockModel = createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (streamModel, context, streamOptions) => {
				contexts.push(structuredClone(context));
				return mockModel.stream(streamModel, context, streamOptions);
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			skills: loadedSkills.skills,
			slashCommands,
		});

		try {
			const builtinRuntime = {
				ctx: {} as BuiltinSlashCommandRuntime["ctx"],
				handleBackgroundCommand: () => {},
			};
			expect(await executeBuiltinSlashCommand("/claude-code:skill:foo src/private.ts", builtinRuntime)).toBe(false);
			await session.prompt("/claude-code:skill:foo src/private.ts");
			expect(await executeBuiltinSlashCommand("/claude-code:provider:login src/private.ts", builtinRuntime)).toBe(
				false,
			);
			await session.prompt("/claude-code:provider:login src/private.ts");

			const userTexts = contexts.flatMap(context =>
				context.messages.flatMap(message => {
					if (message.role !== "user") return [];
					if (typeof message.content === "string") return [message.content];
					return message.content.filter(block => block.type === "text").map(block => block.text);
				}),
			);
			expect(userTexts.join("\n")).toContain("COMMAND PAYLOAD: src/private.ts.");
			expect(userTexts.join("\n")).toContain("PROVIDER PAYLOAD: src/private.ts.");
			expect(userTexts.join("\n")).not.toContain("SKILL-ONLY:");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("Codex prompts import as native slash commands, not skills", async () => {
		await write(".codex/config.toml", '[mcp_servers.codexSrv]\ncommand = "cdx"\n');
		const prompt = "---\ndescription: Codex help prompt.\n---\nHelp $ARGUMENTS.";
		await write(".codex/prompts/help.md", prompt);
		await fs.writeFile(path.join(cwd, "AGENTS.md"), "Follow the Codex project instructions.", "utf-8");
		const report = await runMigrate(opts({ from: ["codex"] }));
		const config = await readMCPConfigFile(path.join(cwd, ".gjc", "mcp.json"));
		expect(config.mcpServers?.codexSrv).toMatchObject({ type: "stdio", command: "cdx" });
		const commandPath = path.join(cwd, ".gjc", "commands", "codex", "prompts", "help.md");
		expect(await fs.readFile(commandPath, "utf-8")).toBe(prompt);
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "command", source: "codex", name: "codex:prompts:help", status: "imported" }),
		);
		expect(report.summary.byType.skill.imported).toBe(0);
		expect(
			await fs.access(path.join(cwd, ".gjc", "skills", "help", "SKILL.md")).then(
				() => true,
				() => false,
			),
		).toBe(false);
		const commands = await loadSlashCommands({ cwd });
		expect(commands).toContainEqual(
			expect.objectContaining({ name: "codex:prompts:help", description: "Codex help prompt." }),
		);
		expect(expandSlashCommand("/codex:prompts:help the project", commands)).toContain("Help the project.");
		expect(await fs.readFile(path.join(cwd, "AGENTS.md"), "utf-8")).toBe("Follow the Codex project instructions.");
		expect(
			await fs.access(path.join(cwd, ".gjc", "AGENTS.md")).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	test.skipIf(process.platform === "win32")("flat colon command files collide with nested imports", async () => {
		await fs.mkdir(path.join(cwd, ".claude", "commands", "review"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".claude", "commands", "review", "security.md"),
			"Imported $ARGUMENTS.",
			"utf-8",
		);
		const destination = path.join(cwd, ".gjc", "commands", "claude-code", "review:security.md");
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, "Existing flat command.", "utf-8");

		const skipped = await runMigrate(opts({ from: ["claude-code"] }));
		expect(skipped.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:review:security",
				destination,
				status: "skipped_exists",
			}),
		);
		const forced = await runMigrate(opts({ from: ["claude-code"], force: true }));
		expect(forced.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:review:security",
				destination,
				status: "updated",
			}),
		);
		const commands = await loadSlashCommands({ cwd });
		expect(expandSlashCommand("/claude-code:review:security this", commands)).toContain("Imported this.");
	});

	test("command collisions skip by default and require force to replace", async () => {
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "review.md"), "Imported command.", "utf-8");
		const destination = path.join(cwd, ".gjc", "commands", "claude-code", "review.md");
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, "Keep the current command.", "utf-8");

		const skipped = await runMigrate(opts({ from: ["claude-code"] }));
		expect(skipped.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:review",
				operation: "skip",
				status: "skipped_exists",
			}),
		);
		expect(await fs.readFile(destination, "utf-8")).toBe("Keep the current command.");

		const forced = await runMigrate(opts({ from: ["claude-code"], force: true }));
		expect(forced.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:review",
				operation: "update",
				status: "updated",
			}),
		);
		expect(await fs.readFile(destination, "utf-8")).toBe("Imported command.");
	});

	test("opencode imports MCP + skill + command", async () => {
		await write(
			".config/opencode/opencode.json",
			JSON.stringify({ mcp: { ocSrv: { type: "local", command: "ocb" } } }),
		);
		await write(".config/opencode/commands/deploy.md", "Deploy it.");
		await runMigrate(opts({ from: ["opencode"] }));
		const config = await readMCPConfigFile(path.join(cwd, ".gjc", "mcp.json"));
		expect(config.mcpServers?.ocSrv).toMatchObject({ type: "stdio", command: "ocb" });
		expect(await fs.readFile(path.join(cwd, ".gjc", "skills", "deploy", "SKILL.md"), "utf-8")).toContain(
			"description:",
		);
	});

	test("default rerun is idempotent (all skipped)", async () => {
		await write(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "bin" } } }));
		await write(".claude/skills/alpha/SKILL.md", "---\ndescription: a\n---\nbody");
		await runMigrate(opts({ from: ["claude-code"] }));
		const second = await runMigrate(opts({ from: ["claude-code"] }));
		const statuses = second.actions.filter(a => a.type !== "source").map(a => a.status);
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses.every(s => s === "skipped_exists")).toBe(true);
		expect(second.ok).toBe(true);
	});

	test("pre-existing skill destination symlink is reported as a conflict and not followed", async () => {
		await write(".claude/skills/alpha/SKILL.md", "---\ndescription: a\n---\nbody");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-import-outside-"));
		try {
			await fs.mkdir(path.join(cwd, ".gjc", "skills"), { recursive: true });
			await fs.symlink(outside, path.join(cwd, ".gjc", "skills", "alpha"), "dir");

			const report = await runMigrate(opts({ from: ["claude-code"] }));
			const alphaAction = report.actions.find(action => action.type === "skill" && action.name === "alpha");

			expect(alphaAction).toMatchObject({ operation: "skip", status: "skipped_exists" });
			expect(report.ok).toBe(true);
			expect(
				await fs.access(path.join(outside, "SKILL.md")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("force overwrites existing MCP server", async () => {
		await write(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "v1" } } }));
		await runMigrate(opts({ from: ["claude-code"] }));
		await write(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "v2" } } }));
		await runMigrate(opts({ from: ["claude-code"], force: true }));
		const config = await readMCPConfigFile(path.join(cwd, ".gjc", "mcp.json"));
		expect(config.mcpServers?.srv).toMatchObject({ command: "v2" });
	});

	test("instructions skip existing files unless force is explicit", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Imported instructions.", "utf-8");
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		const destination = path.join(cwd, ".gjc", "AGENTS.md");
		await fs.writeFile(destination, "Keep these existing instructions.", "utf-8");

		const skipped = await runMigrate(opts({ from: ["claude-code"] }));
		expect(skipped.actions).toContainEqual(
			expect.objectContaining({ type: "instruction", operation: "skip", status: "skipped_exists" }),
		);
		expect(await fs.readFile(destination, "utf-8")).toBe("Keep these existing instructions.");

		const overwritten = await runMigrate(opts({ from: ["claude-code"], force: true }));
		expect(overwritten.actions).toContainEqual(
			expect.objectContaining({ type: "instruction", operation: "update", status: "updated" }),
		);
		expect(await fs.readFile(destination, "utf-8")).toBe("Imported instructions.");
	});

	test("forced case-equivalent command updates report the loaded command name", async () => {
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "review.md"), "Imported $ARGUMENTS.", "utf-8");
		const destination = path.join(cwd, ".gjc", "commands", "claude-code", "Review.md");
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, "Existing command.", "utf-8");

		const report = await runMigrate(opts({ from: ["claude-code"], force: true }));
		expect(report.actions).toContainEqual(
			expect.objectContaining({
				type: "command",
				name: "claude-code:Review",
				destination,
				status: "updated",
			}),
		);
		const commands = await loadSlashCommands({ cwd });
		expect(commands).toContainEqual(expect.objectContaining({ name: "claude-code:Review" }));
		expect(expandSlashCommand("/claude-code:Review this", commands)).toContain("Imported this.");
	});

	test("imports Claude Code hooks as a runnable module that blocks on exit 2", async () => {
		await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "bash",
							hooks: [
								{
									type: "command",
									command:
										"read -r payload; printf '%s' \"$payload\" > \"$GJC_TEST_PAYLOAD\"; echo 'no bash here' >&2; exit 2",
								},
							],
						},
					],
					Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
				},
			}),
			"utf-8",
		);
		const payloadPath = path.join(home, "payload.json");
		process.env.GJC_TEST_PAYLOAD = payloadPath;
		try {
			const report = await runMigrate(opts({ from: ["claude-code"] }));
			const hookAction = report.actions.find(action => action.type === "hook" && action.status === "imported");
			expect(hookAction?.destination).toBe(path.join(cwd, ".gjc", "hooks", "migrated-claude-code.ts"));
			// The unsupported event is reported instead of silently dropped.
			expect(report.actions).toContainEqual(
				expect.objectContaining({ type: "hook", name: "Notification", status: "skipped_unmappable" }),
			);

			const modulePath = String(hookAction?.destination);
			const module = (await import(modulePath)) as {
				default: (api: {
					on: (event: string, handler: (payload: unknown, ctx: { cwd?: string }) => unknown) => void;
				}) => void;
			};
			const handlers = new Map<string, (payload: unknown, ctx: { cwd?: string }) => unknown>();
			module.default({ on: (event, handler) => handlers.set(event, handler) });
			expect([...handlers.keys()]).toEqual(["tool_call"]);

			const handler = handlers.get("tool_call");
			if (!handler) throw new Error("no tool_call handler");
			const decision = (await handler({ toolName: "bash", input: { command: "ls" } }, { cwd })) as {
				block?: boolean;
				reason?: string;
			};
			expect(decision.block).toBe(true);
			expect(decision.reason).toBe("no bash here");
			// The command received the origin-shaped payload on stdin.
			const received = JSON.parse(await Bun.file(payloadPath).text()) as Record<string, unknown>;
			expect(received.hook_event_name).toBe("PreToolUse");
			expect(received.tool_name).toBe("bash");
			expect(received.tool_input).toEqual({ command: "ls" });

			// A non-matching tool never runs the command.
			const skipped = await handler({ toolName: "read", input: {} }, { cwd });
			expect(skipped).toBeUndefined();
		} finally {
			delete process.env.GJC_TEST_PAYLOAD;
		}
	}, 60_000);
});
