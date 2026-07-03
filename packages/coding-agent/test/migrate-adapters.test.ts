import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "../src/migrate/adapters/index";

let home: string;

async function writeFile(rel: string, content: string): Promise<void> {
	const full = path.join(home, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-adapters-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
});

describe("claude-code adapter", () => {
	test("absent config yields skipped_absent_source diagnostics, no candidates", async () => {
		const result = await getAdapter("claude-code").collect({ homeDir: home });
		expect(result.mcpCandidates).toHaveLength(0);
		expect(result.skillCandidates).toHaveLength(0);
		expect(result.diagnostics.every(d => d.status === "skipped_absent_source")).toBe(true);
	});

	test("reads mcpServers and skills", async () => {
		await writeFile(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "bin" } } }));
		await writeFile(".claude/skills/My Skill/SKILL.md", "---\nname: My Skill\ndescription: does things\n---\nBody");
		const result = await getAdapter("claude-code").collect({ homeDir: home });
		expect(result.mcpCandidates).toEqual([{ source: "claude-code", name: "srv", raw: { command: "bin" } }]);
		expect(result.skillCandidates).toHaveLength(1);
		expect(result.skillCandidates[0].slug).toBe("my-skill");
		expect(result.skillCandidates[0].content).toContain("description: does things");
		// `name` is dropped so the loaded name comes from the slug directory.
		expect(result.skillCandidates[0].content).not.toContain("name: My Skill");
	});

	test("malformed mcp config yields failed_invalid_source", async () => {
		await writeFile(".claude.json", "{ not json");
		const result = await getAdapter("claude-code").collect({ homeDir: home });
		expect(result.diagnostics.some(d => d.status === "failed_invalid_source")).toBe(true);
	});
});

describe("codex adapter", () => {
	test("reads TOML mcp_servers and prompt skills", async () => {
		await writeFile(".codex/config.toml", '[mcp_servers.srv]\ncommand = "bin"\nargs = ["--x"]\n');
		await writeFile(".codex/prompts/review.md", "Review the code carefully.");
		const result = await getAdapter("codex").collect({ homeDir: home });
		expect(result.mcpCandidates).toHaveLength(1);
		expect(result.mcpCandidates[0]).toMatchObject({ source: "codex", name: "srv" });
		expect(result.skillCandidates).toHaveLength(1);
		expect(result.skillCandidates[0].slug).toBe("review");
		// Description synthesized from the body.
		expect(result.skillCandidates[0].content).toContain("description:");
	});

	test("malformed TOML yields failed_invalid_source", async () => {
		await writeFile(".codex/config.toml", "this is = = not toml ][");
		const result = await getAdapter("codex").collect({ homeDir: home });
		expect(result.diagnostics.some(d => d.status === "failed_invalid_source")).toBe(true);
	});
});

describe("cursor adapter", () => {
	test("absent config yields skipped_absent_source diagnostics, no candidates", async () => {
		const result = await getAdapter("cursor").collect({ homeDir: home });
		expect(result.mcpCandidates).toHaveLength(0);
		expect(result.skillCandidates).toHaveLength(0);
		expect(result.diagnostics.every(d => d.status === "skipped_absent_source")).toBe(true);
	});

	test("reads mcpServers from ~/.cursor/mcp.json", async () => {
		await writeFile(
			".cursor/mcp.json",
			JSON.stringify({ mcpServers: { srv: { command: "bin", args: ["--x"] }, docs: { url: "https://d.test/mcp" } } }),
		);
		const result = await getAdapter("cursor").collect({ homeDir: home });
		expect(result.mcpCandidates).toEqual([
			{ source: "cursor", name: "srv", raw: { command: "bin", args: ["--x"] } },
			{ source: "cursor", name: "docs", raw: { url: "https://d.test/mcp" } },
		]);
		expect(result.skillCandidates).toHaveLength(0);
	});

	test("malformed mcp config yields failed_invalid_source", async () => {
		await writeFile(".cursor/mcp.json", "{ not json");
		const result = await getAdapter("cursor").collect({ homeDir: home });
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
		const result = await getAdapter("opencode").collect({ homeDir: home });
		expect(result.mcpCandidates).toHaveLength(1);
		expect(result.skillCandidates.map(c => c.slug).sort()).toEqual(["deploy", "helper"]);
	});

	test("discovers nested skills/**/SKILL.md recursively", async () => {
		await writeFile(".config/opencode/opencode.json", JSON.stringify({ mcp: {} }));
		await writeFile(".config/opencode/skills/group/nested/SKILL.md", "---\ndescription: deep\n---\nbody");
		const result = await getAdapter("opencode").collect({ homeDir: home });
		expect(result.skillCandidates.map(c => c.slug)).toContain("nested");
	});
});
