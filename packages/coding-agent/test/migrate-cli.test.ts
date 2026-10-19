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
		expect(renderHuman(report)).toContain("[claude-code] CLAUDE.md: imported");
		expect(await exists(path.join(cwd, ".gjc", "mcp.json"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "skills"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "AGENTS.md"))).toBe(false);
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
		expect(report.summary.byType).toHaveProperty("instruction");
		expect(report.summary.bySource).toHaveProperty("claude-code");
	});

	test("--project writes under cwd/.gjc", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.", "utf-8");
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
	});

	test("user scope writes under the agent dir", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-agent-"));
		await write(".claude/CLAUDE.md", "User instructions.");
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
