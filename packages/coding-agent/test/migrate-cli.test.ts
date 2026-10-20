import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { MigrateArgsError, resolveSources, runMigrate } from "../src/cli/migrate-cli";
import { renderHuman } from "../src/migrate/report";

let home: string;
let cwd: string;

async function write(rel: string, content: string): Promise<void> {
	const full = path.join(home, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-home-"));
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-cwd-"));
	await write(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "bin" } } }));
	await write(".claude/skills/alpha/SKILL.md", "---\ndescription: a\n---\nbody");
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("resolveSources", () => {
	test("expands all", () => {
		expect(resolveSources(["all"])).toEqual(["claude-code", "codex", "opencode"]);
	});
	test("dedupes and returns canonical order regardless of input order", () => {
		expect(resolveSources(["opencode", "claude-code", "opencode"])).toEqual(["claude-code", "opencode"]);
	});
	test("rejects unknown source", () => {
		expect(() => resolveSources(["bogus"])).toThrow(MigrateArgsError);
	});
	test("rejects empty selection", () => {
		expect(() => resolveSources([])).toThrow(MigrateArgsError);
	});
});

describe("runMigrate", () => {
	test("--dry-run writes nothing", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.", "utf-8");
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "review.md"), "Review the patch.", "utf-8");
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.dryRun).toBe(true);
		expect(report.actions.length).toBeGreaterThan(0);
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "instruction", name: "CLAUDE.md", status: "imported" }),
		);
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "command", name: "claude-code:review", status: "imported" }),
		);
		expect(renderHuman(report)).toContain("[claude-code] /claude-code:review: imported");
		expect(renderHuman(report)).toContain("[claude-code] CLAUDE.md: imported");
	});

	test("dry-run reports settings that need manual action", async () => {
		await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".claude", "settings.json"),
			JSON.stringify({
				model: "claude-sonnet-4-5",
				permissions: { deny: ["Read(./.env)"] },
				hooks: {
					PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npm test" }] }],
					Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
				},
			}),
			"utf-8",
		);
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		// Manual actions are advisory: they never turn a migration into a failure.
		expect(report.ok).toBe(true);
		expect(report.manualActions.map(action => action.area).sort()).toEqual([
			"settings.json: hooks.Notification",
			"settings.json: model",
			"settings.json: permissions",
		]);
		const hookActions = report.actions.filter(action => action.type === "hook");
		expect(hookActions.some(action => action.name === "Notification" && action.status === "skipped_unmappable")).toBe(
			true,
		);
		const hookAction = hookActions.find(action => action.status === "imported");
		expect(hookAction).toMatchObject({ name: "migrated-claude-code.ts", status: "imported" });
		expect(hookAction?.destination).toBe(path.join(report.destinations.hooksDir, "migrated-claude-code.ts"));
		expect(report.summary.byType.hook.imported).toBe(1);
		const rendered = renderHuman(report);
		expect(rendered).toContain("Manual actions:");
		expect(rendered).toContain("[claude-code] migrated-claude-code.ts: imported");
		expect(rendered).toContain("[claude-code] settings.json: hooks.Notification:");
		expect(await exists(path.join(cwd, ".gjc", "mcp.json"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "skills"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "AGENTS.md"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "commands", "claude-code", "review.md"))).toBe(false);
	});

	test("--json report carries taxonomy counts by total/type/source", async () => {
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.summary.total).toHaveProperty("imported");
		expect(report.summary.byType).toHaveProperty("mcp");
		expect(report.summary.byType).toHaveProperty("skill");
		expect(report.summary.byType).toHaveProperty("command");
		expect(report.summary.byType).toHaveProperty("instruction");
		expect(report.summary.bySource).toHaveProperty("claude-code");
	});

	test("--project writes under cwd/.gjc", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.", "utf-8");
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "ship.md"), "Ship the project.", "utf-8");
		await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: false,
			json: false,
			homeDir: home,
			cwd,
		});
		expect(await exists(path.join(cwd, ".gjc", "mcp.json"))).toBe(true);
		expect(await exists(path.join(cwd, ".gjc", "skills", "alpha", "SKILL.md"))).toBe(true);
		expect(await fs.readFile(path.join(cwd, ".gjc", "AGENTS.md"), "utf-8")).toBe("Project instructions.");
		expect(await fs.readFile(path.join(cwd, ".gjc", "commands", "claude-code", "ship.md"), "utf-8")).toBe(
			"Ship the project.",
		);
	});

	test("user scope writes under the agent dir", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-agent-"));
		await write(".claude/CLAUDE.md", "User instructions.");
		await write(".claude/commands/summarize.md", "Summarize $ARGUMENTS.");
		setAgentDir(agentDir);
		try {
			await runMigrate({
				from: ["claude-code"],
				project: false,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			expect(await exists(path.join(agentDir, "mcp.json"))).toBe(true);
			expect(await exists(path.join(agentDir, "skills", "alpha", "SKILL.md"))).toBe(true);
			expect(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("User instructions.");
			expect(await fs.readFile(path.join(agentDir, "commands", "claude-code", "summarize.md"), "utf-8")).toBe(
				"Summarize $ARGUMENTS.",
			);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("failure status makes report.ok false (malformed source)", async () => {
		await write(".claude.json", "{ not json");
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.ok).toBe(false);
	});

	test("does not follow a symlinked project .gjc while migrating mcp", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-mcp-outside-"));
		try {
			await fs.symlink(outside, path.join(cwd, ".gjc"), "dir");
			const report = await runMigrate({
				from: ["claude-code"],
				project: true,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			const mcp = report.actions.find(action => action.type === "mcp" && action.name === "srv");
			expect(mcp).toMatchObject({ operation: "fail", status: "failed_io" });
			expect(await exists(path.join(outside, "mcp.json"))).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("still allows a user-scope agent dir that is a symlink named .gjc", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-user-outside-"));
		const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-user-link-"));
		const previous = process.env.GJC_CODING_AGENT_DIR;
		const agentDir = path.join(linkParent, ".gjc");
		await fs.symlink(outside, agentDir, "dir");
		setAgentDir(agentDir);
		try {
			const report = await runMigrate({
				from: ["claude-code"],
				project: false,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			const mcp = report.actions.find(action => action.type === "mcp" && action.name === "srv");
			expect(mcp).toMatchObject({ operation: "create", status: "imported" });
			expect(await exists(path.join(outside, "mcp.json"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous;
			resetAgentDirFromEnvironment();
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(linkParent, { recursive: true, force: true });
		}
	});

	test("still allows a user-scope agent dir whose parents do not exist yet", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-user-missing-"));
		const previous = process.env.GJC_CODING_AGENT_DIR;
		const agentDir = path.join(root, "missing", "profile", ".gjc");
		setAgentDir(agentDir);
		try {
			const report = await runMigrate({
				from: ["claude-code"],
				project: false,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			const mcp = report.actions.find(action => action.type === "mcp" && action.name === "srv");
			expect(mcp).toMatchObject({ operation: "create", status: "imported" });
			expect(await exists(path.join(agentDir, "mcp.json"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous;
			resetAgentDirFromEnvironment();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("--from all and repeated --from load every selected source once", async () => {
		const report = await runMigrate({
			from: ["opencode", "claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.sources).toEqual(["claude-code", "opencode"]);
	});
});
