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
		expect(result.instructionCandidates).toHaveLength(0);
		expect(result.diagnostics.every(d => d.status === "skipped_absent_source")).toBe(true);
	});

	test("reads mcpServers and skills", async () => {
		await writeFile(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "bin" } } }));
		await writeFile(".claude/skills/My Skill/SKILL.md", "---\nname: My Skill\ndescription: does things\n---\nBody");
		await writeFile(".claude/CLAUDE.md", "User-level Claude instructions.");
		const result = await getAdapter("claude-code").collect(adapterOptions());
		expect(result.mcpCandidates).toEqual([{ source: "claude-code", name: "srv", raw: { command: "bin" } }]);
		expect(result.skillCandidates).toHaveLength(1);
		expect(result.skillCandidates[0].slug).toBe("my-skill");
		expect(result.skillCandidates[0].content).toContain("description: does things");
		expect(result.instructionCandidates).toEqual([
			{ source: "claude-code", name: "CLAUDE.md", content: "User-level Claude instructions." },
		]);
		// `name` is dropped so the loaded name comes from the slug directory.
		expect(result.skillCandidates[0].content).not.toContain("name: My Skill");
	});

	test("project scope reads the project CLAUDE.md instead of the user file", async () => {
		await writeFile(".claude/CLAUDE.md", "User instructions.");
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.", "utf-8");
		const result = await getAdapter("claude-code").collect(adapterOptions("project"));
		expect(result.instructionCandidates).toEqual([
			{ source: "claude-code", name: "CLAUDE.md", content: "Project instructions." },
		]);
	});

	test("malformed mcp config yields failed_invalid_source", async () => {
		await writeFile(".claude.json", "{ not json");
		const result = await getAdapter("claude-code").collect(adapterOptions());
		expect(result.diagnostics.some(d => d.status === "failed_invalid_source")).toBe(true);
	});
});

describe("codex adapter", () => {
	test("reads TOML mcp_servers and prompt skills", async () => {
		await writeFile(".codex/config.toml", '[mcp_servers.srv]\ncommand = "bin"\nargs = ["--x"]\n');
		await writeFile(".codex/prompts/review.md", "Review the code carefully.");
		await writeFile(".codex/AGENTS.md", "User-level Codex instructions.");
		const result = await getAdapter("codex").collect(adapterOptions());
		expect(result.mcpCandidates).toHaveLength(1);
		expect(result.mcpCandidates[0]).toMatchObject({ source: "codex", name: "srv" });
		expect(result.skillCandidates).toHaveLength(1);
		expect(result.skillCandidates[0].slug).toBe("review");
		expect(result.instructionCandidates).toEqual([
			{ source: "codex", name: "AGENTS.md", content: "User-level Codex instructions." },
		]);
		// Description synthesized from the body.
		expect(result.skillCandidates[0].content).toContain("description:");
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

	test("discovers nested skills/**/SKILL.md recursively", async () => {
		await writeFile(".config/opencode/opencode.json", JSON.stringify({ mcp: {} }));
		await writeFile(".config/opencode/skills/group/nested/SKILL.md", "---\ndescription: deep\n---\nbody");
		const result = await getAdapter("opencode").collect(adapterOptions());
		expect(result.skillCandidates.map(c => c.slug)).toContain("nested");
	});
});
