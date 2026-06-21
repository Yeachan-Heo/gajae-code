import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runMigrate } from "../src/cli/migrate-cli";
import { readMCPConfigFile } from "../src/runtime-mcp/config-writer";

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
	test("claude-code imports MCP + skill", async () => {
		await write(".claude.json", JSON.stringify({ mcpServers: { claudeSrv: { command: "cbin" } } }));
		await write(".claude/skills/alpha/SKILL.md", "---\ndescription: a\n---\nbody");
		const report = await runMigrate(opts({ from: ["claude-code"] }));
		const config = await readMCPConfigFile(path.join(cwd, ".gjc", "mcp.json"));
		expect(config.mcpServers?.claudeSrv).toMatchObject({ command: "cbin" });
		expect(await fs.readFile(path.join(cwd, ".gjc", "skills", "alpha", "SKILL.md"), "utf-8")).toContain(
			"description: a",
		);
		expect(report.ok).toBe(true);
	});

	test("codex imports TOML MCP + converted prompt", async () => {
		await write(".codex/config.toml", '[mcp_servers.codexSrv]\ncommand = "cdx"\n');
		await write(".codex/prompts/review.md", "Review carefully.");
		await runMigrate(opts({ from: ["codex"] }));
		const config = await readMCPConfigFile(path.join(cwd, ".gjc", "mcp.json"));
		expect(config.mcpServers?.codexSrv).toMatchObject({ type: "stdio", command: "cdx" });
		expect(await fs.readFile(path.join(cwd, ".gjc", "skills", "review", "SKILL.md"), "utf-8")).toContain(
			"description:",
		);
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
});
