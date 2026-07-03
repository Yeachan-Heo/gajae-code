import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectImportableMcpSources, formatImportHintLine } from "../src/migrate/import-hint";

let home: string;

async function writeFile(rel: string, content: string): Promise<void> {
	const full = path.join(home, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-import-hint-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
});

describe("detectImportableMcpSources", () => {
	test("empty home yields no importable sources", async () => {
		const sources = await detectImportableMcpSources(home);
		expect(sources).toEqual([]);
	});

	test("detects sources with MCP servers, in canonical order with counts and aliases", async () => {
		await writeFile(
			".claude.json",
			JSON.stringify({ mcpServers: { a: { command: "bin" }, b: { url: "https://d.test/mcp" } } }),
		);
		await writeFile(".codex/config.toml", '[mcp_servers.codexsrv]\ncommand = "bin"\n');
		await writeFile(".cursor/mcp.json", JSON.stringify({ mcpServers: { c: { command: "bin" } } }));

		const sources = await detectImportableMcpSources(home);

		// Canonical order is claude-code, codex, opencode, cursor.
		expect(sources.map(s => s.source)).toEqual(["claude-code", "codex", "cursor"]);
		expect(sources).toEqual([
			{ source: "claude-code", importArg: "claude", displayName: "Claude Code", count: 2 },
			{ source: "codex", importArg: "codex", displayName: "Codex", count: 1 },
			{ source: "cursor", importArg: "cursor", displayName: "Cursor", count: 1 },
		]);
	});

	test("omits sources with no MCP servers", async () => {
		// Claude config present but empty; only cursor has a server.
		await writeFile(".claude.json", JSON.stringify({ mcpServers: {} }));
		await writeFile(".cursor/mcp.json", JSON.stringify({ mcpServers: { only: { command: "bin" } } }));

		const sources = await detectImportableMcpSources(home);
		expect(sources.map(s => s.source)).toEqual(["cursor"]);
	});

	test("skips malformed configs silently", async () => {
		await writeFile(".claude.json", "{ not json");
		await writeFile(".codex/config.toml", "this is = = not toml ][");
		await writeFile(".cursor/mcp.json", JSON.stringify({ mcpServers: { c: { command: "bin" } } }));

		// Malformed sources are simply dropped; the valid cursor config still shows.
		const sources = await detectImportableMcpSources(home);
		expect(sources.map(s => s.source)).toEqual(["cursor"]);
	});
});

describe("formatImportHintLine", () => {
	test("uses singular for one server and the import alias", () => {
		const line = formatImportHintLine({
			source: "claude-code",
			importArg: "claude",
			displayName: "Claude Code",
			count: 1,
		});
		expect(line).toBe("Tip: found 1 MCP server in Claude Code config — run `gjc mcp import claude` to copy them.");
	});

	test("uses plural for multiple servers", () => {
		const line = formatImportHintLine({ source: "cursor", importArg: "cursor", displayName: "Cursor", count: 3 });
		expect(line).toBe("Tip: found 3 MCP servers in Cursor config — run `gjc mcp import cursor` to copy them.");
	});
});
