import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "../src/migrate/adapters/index";

let home: string;
let cwd: string;

async function writeFile(rel: string, content: string): Promise<void> {
	const full = path.join(home, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-adapters-"));
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-adapters-cwd-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
});

const adapterOptions = (scope: "project" | "user" = "user") => ({ homeDir: home, cwd, scope });

describe("claude-code adapter", () => {
	test("absent config yields skipped_absent_source diagnostics, no candidates", async () => {
		const result = await getAdapter("claude-code").collect(adapterOptions());
		expect(result.mcpCandidates).toHaveLength(0);
		expect(result.skillCandidates).toHaveLength(0);
		expect(result.slashCommandCandidates).toHaveLength(0);
		expect(result.instructionCandidates).toHaveLength(0);
		expect(result.manualActions).toHaveLength(0);
		expect(result.diagnostics.every(d => d.status === "skipped_absent_source")).toBe(true);
	});

	test("imports supported hook events and reports only the ones it cannot translate", async () => {
		await writeFile(
			".claude/settings.json",
			JSON.stringify({
				model: "claude-sonnet-4-5",
				env: { ANTHROPIC_API_KEY: "sk-secret-value", DEBUG: "1" },
				permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./.env)"] },
				hooks: {
					PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
					PostToolUse: [
						{
							hooks: [
								{ type: "command", command: "echo a" },
								{ type: "command", command: "echo b" },
							],
						},
					],
					Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
				},
			}),
		);
		const result = await getAdapter("claude-code").collect(adapterOptions());
		// Supported events become import candidates, with their matcher preserved.
		expect(result.hookCandidates).toEqual([
			{ source: "claude-code", event: "PreToolUse", matcher: "Bash", command: "echo pre" },
			{ source: "claude-code", event: "PostToolUse", command: "echo a" },
			{ source: "claude-code", event: "PostToolUse", command: "echo b" },
			{ source: "claude-code", event: "Notification", command: "say done" },
		]);
		const byArea = new Map(result.manualActions.map(action => [action.area, action.detail]));
		expect(byArea.has("settings.json: hooks.PreToolUse")).toBe(false);
		expect(byArea.has("settings.json: hooks.PostToolUse")).toBe(false);
		expect(byArea.get("settings.json: hooks.Notification")).toContain("no faithful gjc equivalent");
		expect(byArea.get("settings.json: model")).toContain("claude-sonnet-4-5");
		expect(byArea.get("settings.json: permissions")).toContain("1 allow, 1 deny, 0 ask");
		expect(byArea.get("settings.json: permissions")).toContain("Deny rules are the security-relevant ones");
		expect(byArea.get("settings.json: env")).toContain("ANTHROPIC_API_KEY, DEBUG");
		// Values must never appear in the report.
		const serialized = JSON.stringify(result.manualActions);
		expect(serialized).not.toContain("sk-secret-value");
	});

	test("reports project settings.local.json separately and ignores malformed settings", async () => {
		const projectDir = path.join(cwd, ".claude");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(path.join(projectDir, "settings.json"), "{ not json", "utf-8");
		await fs.writeFile(
			path.join(projectDir, "settings.local.json"),
			JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
			"utf-8",
		);
		const result = await getAdapter("claude-code").collect(adapterOptions("project"));
		expect(result.diagnostics.some(d => d.status === "failed_invalid_source")).toBe(true);
		const areas = result.manualActions.map(action => action.area);
		expect(areas).toContain("settings.local.json: permissions");
		expect(areas.some(area => area.startsWith("settings.json:"))).toBe(false);
	});

	test("reads mcpServers and skills", async () => {
		await writeFile(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "bin" } } }));
		await writeFile(".claude/skills/My Skill/SKILL.md", "---\nname: My Skill\ndescription: does things\n---\nBody");
		await writeFile(".claude/commands/review.md", "---\ndescription: Review code.\n---\nReview $ARGUMENTS.");
		await writeFile(
			".claude/commands/security/audit.md",
			"---\ndescription: Audit security.\n---\nAudit $ARGUMENTS.",
		);
		await writeFile(".claude/CLAUDE.md", "User-level Claude instructions.");
		const result = await getAdapter("claude-code").collect(adapterOptions());
		expect(result.mcpCandidates).toEqual([{ source: "claude-code", name: "srv", raw: { command: "bin" } }]);
		expect(result.skillCandidates).toHaveLength(1);
		expect(result.skillCandidates[0].slug).toBe("my-skill");
		expect(result.skillCandidates[0].content).toContain("description: does things");
		expect(result.slashCommandCandidates).toEqual([
			{
				source: "claude-code",
				name: "review",
				content: "---\ndescription: Review code.\n---\nReview $ARGUMENTS.",
			},
			{
				source: "claude-code",
				name: "security:audit",
				content: "---\ndescription: Audit security.\n---\nAudit $ARGUMENTS.",
			},
		]);
		expect(result.instructionCandidates).toEqual([
			{ source: "claude-code", name: "CLAUDE.md", content: "User-level Claude instructions." },
		]);
		// `name` is dropped so the loaded name comes from the slug directory.
		expect(result.skillCandidates[0].content).not.toContain("name: My Skill");
	});

	test("project scope reads the project CLAUDE.md instead of the user file", async () => {
		await writeFile(".claude/CLAUDE.md", "User instructions.");
		await writeFile(".claude/commands/user-only.md", "User command.");
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.", "utf-8");
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "ship.md"), "Project command.", "utf-8");
		const result = await getAdapter("claude-code").collect(adapterOptions("project"));
		expect(result.instructionCandidates).toEqual([
			{ source: "claude-code", name: "CLAUDE.md", content: "Project instructions." },
		]);
		expect(result.slashCommandCandidates).toEqual([
			{ source: "claude-code", name: "ship", content: "Project command." },
		]);
	});

	test("maps Claude agent tools, drops unsupported ones, and rejects unusable agent files", async () => {
		await writeFile(
			".claude/agents/auditor.md",
			"---\nname: auditor\ndescription: Reviews diffs.\ntools: Read, Grep, Bash, NotebookEdit\n---\n\nAudit the diff.\n",
		);
		await writeFile(".claude/agents/no-description.md", "---\nname: nodesc\n---\nBody only.\n");
		await writeFile(".claude/agents/bad name.md", "---\nname: bad name\ndescription: x\n---\nBody.\n");

		const result = await getAdapter("claude-code").collect(adapterOptions());
		const auditor = result.agentCandidates.find(candidate => candidate.name === "auditor");
		expect(auditor).toBeDefined();
		expect(auditor?.content).toContain("Audit the diff.");
		expect(auditor?.content).toContain("read");
		expect(auditor?.content).toContain("grep");
		expect(auditor?.content).toContain("bash");
		expect(auditor?.content).not.toContain("notebookedit");
		expect(auditor?.warnings).toEqual([expect.stringContaining('dropped agent tool "NotebookEdit"')]);

		expect(result.agentCandidates.some(candidate => candidate.name === "nodesc")).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "agent",
				status: "failed_invalid_source",
				message: expect.stringContaining("no-description.md"),
			}),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "agent",
				status: "failed_invalid_source",
				message: expect.stringContaining("bad name"),
			}),
		);
	});

	test("malformed mcp config yields failed_invalid_source", async () => {
		await writeFile(".claude.json", "{ not json");
		const result = await getAdapter("claude-code").collect(adapterOptions());
		expect(result.diagnostics.some(d => d.status === "failed_invalid_source")).toBe(true);
	});
});

describe("codex adapter", () => {
	test("reads TOML mcp_servers and converts Markdown prompts to slash commands", async () => {
		await writeFile(".codex/config.toml", '[mcp_servers.srv]\ncommand = "bin"\nargs = ["--x"]\n');
		await writeFile(".codex/prompts/review.md", "---\ndescription: Review code.\n---\nReview $ARGUMENTS.");
		await writeFile(".codex/prompts/help.md", "---\ndescription: Codex help prompt.\n---\nHelp $ARGUMENTS.");
		await writeFile(".codex/AGENTS.md", "User-level Codex instructions.");
		const result = await getAdapter("codex").collect(adapterOptions());
		expect(result.mcpCandidates).toHaveLength(1);
		expect(result.mcpCandidates[0]).toMatchObject({ source: "codex", name: "srv" });
		expect(result.skillCandidates).toHaveLength(0);
		expect(result.slashCommandCandidates.map(candidate => candidate.name).sort()).toEqual([
			"prompts:help",
			"prompts:review",
		]);
		expect(result.slashCommandCandidates.find(candidate => candidate.name === "prompts:review")?.content).toBe(
			"---\ndescription: Review code.\n---\nReview $ARGUMENTS.",
		);
		expect(result.instructionCandidates).toEqual([
			{ source: "codex", name: "AGENTS.md", content: "User-level Codex instructions." },
		]);
	});

	test("project scope leaves AGENTS.md native to GJC and does not import the user file", async () => {
		await writeFile(".codex/AGENTS.md", "User instructions.");
		await fs.writeFile(path.join(cwd, "AGENTS.md"), "Project instructions.", "utf-8");
		const result = await getAdapter("codex").collect(adapterOptions("project"));
		expect(result.instructionCandidates).toHaveLength(0);
		expect(result.diagnostics.some(d => d.type === "instruction")).toBe(false);
	});

	test("malformed TOML yields failed_invalid_source", async () => {
		await writeFile(".codex/config.toml", "this is = = not toml ][");
		const result = await getAdapter("codex").collect(adapterOptions());
		expect(result.diagnostics.some(d => d.status === "failed_invalid_source")).toBe(true);
	});
});

describe("opencode adapter", () => {
	test("reads mcp, skills, and command conversions", async () => {
		await writeFile(
			".config/opencode/opencode.json",
			JSON.stringify({ mcp: { srv: { type: "local", command: "bin" } } }),
		);
		await writeFile(".config/opencode/skills/helper/SKILL.md", "---\ndescription: helps\n---\nHelp body");
		await writeFile(".config/opencode/commands/deploy.md", "Deploy the service.");
		const result = await getAdapter("opencode").collect(adapterOptions());
		expect(result.mcpCandidates).toHaveLength(1);
		expect(result.skillCandidates.map(c => c.slug).sort()).toEqual(["deploy", "helper"]);
		expect(result.instructionCandidates).toHaveLength(0);
	});

	test("reports codex approval, sandbox and shell environment settings by name", async () => {
		await writeFile(
			".codex/config.toml",
			[
				'model = "gpt-5-codex"',
				'approval_policy = "never"',
				'sandbox_mode = "danger-full-access"',
				"",
				"[shell_environment_policy]",
				'unset = ["AWS_SECRET_ACCESS_KEY"]',
				"",
				"[shell_environment_policy.set]",
				'TOKEN = "secret-token-value"',
			].join("\n"),
		);
		const result = await getAdapter("codex").collect(adapterOptions());
		const byArea = new Map(result.manualActions.map(action => [action.area, action.detail]));
		expect(byArea.get("config.toml: model")).toContain("gpt-5-codex");
		expect(byArea.get("config.toml: approval_policy")).toContain("never");
		expect(byArea.get("config.toml: sandbox_mode")).toContain("danger-full-access");
		expect(byArea.get("config.toml: shell_environment_policy")).toContain("sets TOKEN");
		expect(byArea.get("config.toml: shell_environment_policy")).toContain("unsets AWS_SECRET_ACCESS_KEY");
		expect(JSON.stringify(result.manualActions)).not.toContain("secret-token-value");
	});

	test("discovers nested skills/**/SKILL.md recursively", async () => {
		await writeFile(".config/opencode/opencode.json", JSON.stringify({ mcp: {} }));
		await writeFile(".config/opencode/skills/group/nested/SKILL.md", "---\ndescription: deep\n---\nbody");
		const result = await getAdapter("opencode").collect(adapterOptions());
		expect(result.skillCandidates.map(c => c.slug)).toContain("nested");
	});
});
