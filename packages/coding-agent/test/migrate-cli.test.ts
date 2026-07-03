import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@gajae-code/utils";
import { MigrateArgsError, resolveSources, runMigrate } from "../src/cli/migrate-cli";

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
		expect(resolveSources(["all"])).toEqual(["claude-code", "codex", "opencode", "cursor"]);
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
		expect(await exists(path.join(cwd, ".gjc", "mcp.json"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "skills"))).toBe(false);
	});

	test("only: 'mcp' plans MCP imports and drops skill candidates entirely", async () => {
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			only: "mcp",
			homeDir: home,
			cwd,
		});
		expect(report.actions.some(a => a.type === "mcp" && a.status === "imported")).toBe(true);
		expect(report.actions.some(a => a.type === "skill")).toBe(false);
		expect(report.warnings.every(w => w.type !== "skill")).toBe(true);
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
		expect(report.summary.bySource).toHaveProperty("claude-code");
	});

	test("--project writes under cwd/.gjc", async () => {
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
	});

	test("user scope writes under the agent dir", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-agent-"));
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
