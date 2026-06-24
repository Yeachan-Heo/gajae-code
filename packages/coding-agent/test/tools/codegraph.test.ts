import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	buildCodegraphArgs,
	type CodegraphRunResult,
	CodegraphTool,
	renderCodegraphResult,
	type ToolSession,
} from "@gajae-code/coding-agent/tools";

function createTestSession(cwd: string, settings = Settings.isolated()): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

const SEARCH_JSON = JSON.stringify([
	{
		node: {
			kind: "function",
			name: "alpha",
			qualifiedName: "alpha",
			filePath: "a.ts",
			startLine: 1,
			signature: "()",
			isExported: true,
		},
		score: 91.2,
	},
]);

const CALLERS_JSON = JSON.stringify({
	symbol: "alpha",
	callers: [{ name: "gamma", kind: "function", filePath: "b.ts", startLine: 2 }],
});

const IMPACT_JSON = JSON.stringify({
	symbol: "alpha",
	depth: 2,
	nodeCount: 4,
	edgeCount: 3,
	affected: [
		{ name: "alpha", kind: "function", filePath: "a.ts", startLine: 1 },
		{ name: "gamma", kind: "function", filePath: "b.ts", startLine: 2 },
	],
});

const STATUS_JSON = JSON.stringify({
	initialized: true,
	projectPath: "/repo",
	fileCount: 2,
	nodeCount: 6,
	edgeCount: 7,
	languages: ["typescript"],
	pendingChanges: { added: 1, modified: 0, removed: 0 },
});

describe("codegraph buildCodegraphArgs", () => {
	it("builds a search query with limit and path", () => {
		expect(buildCodegraphArgs({ op: "search", target: "alpha", limit: 5 }, "/repo")).toEqual([
			"query",
			"alpha",
			"--json",
			"--limit",
			"5",
			"--path",
			"/repo",
		]);
	});

	it("defaults the search limit to 10", () => {
		expect(buildCodegraphArgs({ op: "search", target: "alpha" }, "/repo")).toContain("10");
	});

	it("builds callers/callees/impact with a symbol and path", () => {
		expect(buildCodegraphArgs({ op: "callers", target: "alpha" }, "/repo")).toEqual([
			"callers",
			"alpha",
			"--json",
			"--path",
			"/repo",
		]);
		expect(buildCodegraphArgs({ op: "impact", target: "alpha" }, "/repo")[0]).toBe("impact");
	});

	it("passes the project path positionally for status", () => {
		expect(buildCodegraphArgs({ op: "status" }, "/repo")).toEqual(["status", "/repo", "--json"]);
	});

	it("builds explore with a variadic query, no --json, and optional --max-files", () => {
		expect(buildCodegraphArgs({ op: "explore", target: "how requests route" }, "/repo")).toEqual([
			"explore",
			"how",
			"requests",
			"route",
			"--path",
			"/repo",
		]);
		expect(buildCodegraphArgs({ op: "explore", target: "alpha", maxFiles: 3 }, "/repo")).toEqual([
			"explore",
			"alpha",
			"--path",
			"/repo",
			"--max-files",
			"3",
		]);
	});

	it("rejects a missing target for symbol ops", () => {
		expect(() => buildCodegraphArgs({ op: "callers" }, "/repo")).toThrow(/requires a non-empty/);
		expect(() => buildCodegraphArgs({ op: "search", target: "   " }, "/repo")).toThrow(/requires a non-empty/);
	});
});

describe("codegraph renderCodegraphResult", () => {
	it("renders search hits with kind and location", () => {
		const text = renderCodegraphResult({ op: "search", target: "alpha" }, SEARCH_JSON);
		expect(text).toContain("alpha (function)");
		expect(text).toContain("a.ts:1");
		expect(text).toContain("[exported]");
	});

	it("renders an empty search clearly", () => {
		const text = renderCodegraphResult({ op: "search", target: "zzz" }, "[]");
		expect(text).toContain('No symbols matched "zzz"');
	});

	it("renders callers", () => {
		const text = renderCodegraphResult({ op: "callers", target: "alpha" }, CALLERS_JSON);
		expect(text).toContain('1 caller(s) of "alpha"');
		expect(text).toContain("gamma (function) — b.ts:2");
	});

	it("renders impact summary and affected list", () => {
		const text = renderCodegraphResult({ op: "impact", target: "alpha" }, IMPACT_JSON);
		expect(text).toContain('Impact of changing "alpha"');
		expect(text).toContain("4 node(s)");
		expect(text).toContain("gamma (function) — b.ts:2");
	});

	it("renders status with pending sync", () => {
		const text = renderCodegraphResult({ op: "status" }, STATUS_JSON);
		expect(text).toContain("files: 2, nodes: 6, edges: 7");
		expect(text).toContain("languages: typescript");
		expect(text).toContain("pending sync: +1 ~0 -0");
	});

	it("passes explore markdown through untouched", () => {
		const report = "**Exploration: alpha**\n\nFound 4 symbols.\n";
		expect(renderCodegraphResult({ op: "explore", target: "alpha" }, report)).toBe(report.trim());
	});

	it("raises on unparseable output", () => {
		expect(() => renderCodegraphResult({ op: "status" }, "not json")).toThrow(/unparseable/);
	});
});

describe("codegraph CodegraphTool.createIf", () => {
	const available = { which: () => "/usr/bin/codegraph", exists: () => true };

	it("registers when the CLI and index are present", () => {
		const tool = CodegraphTool.createIf(createTestSession("/repo"), available);
		expect(tool).not.toBeNull();
		expect(tool?.name).toBe("codegraph");
	});

	it("returns null when the CLI is missing", () => {
		expect(CodegraphTool.createIf(createTestSession("/repo"), { which: () => null, exists: () => true })).toBeNull();
	});

	it("returns null when the project is not indexed", () => {
		expect(
			CodegraphTool.createIf(createTestSession("/repo"), { which: () => "/usr/bin/codegraph", exists: () => false }),
		).toBeNull();
	});

	it("returns null when disabled via settings", () => {
		const settings = Settings.isolated();
		settings.set("codegraph.enabled", false);
		expect(CodegraphTool.createIf(createTestSession("/repo", settings), available)).toBeNull();
	});
});

describe("codegraph CodegraphTool.execute", () => {
	function toolWith(result: CodegraphRunResult): CodegraphTool {
		return new CodegraphTool(createTestSession("/repo"), async () => result);
	}

	it("returns rendered text for a successful query", async () => {
		const tool = toolWith({ ok: true, stdout: CALLERS_JSON, stderr: "" });
		const out = await tool.execute("id", { op: "callers", target: "alpha" });
		expect(out.content[0]).toMatchObject({ type: "text" });
		expect((out.content[0] as { text: string }).text).toContain('1 caller(s) of "alpha"');
	});

	it("returns explore markdown without JSON parsing", async () => {
		const tool = toolWith({ ok: true, stdout: "**Exploration: alpha**\nblast radius...", stderr: "" });
		const out = await tool.execute("id", { op: "explore", target: "alpha" });
		expect((out.content[0] as { text: string }).text).toContain("**Exploration: alpha**");
	});

	it("guides the user to initialize when the index is missing", async () => {
		const tool = toolWith({ ok: false, stdout: "", stderr: "Project is not initialized (.codegraph missing)" });
		await expect(tool.execute("id", { op: "status" })).rejects.toThrow(/codegraph init/);
	});

	it("surfaces other CLI failures", async () => {
		const tool = toolWith({ ok: false, stdout: "", stderr: "boom" });
		await expect(tool.execute("id", { op: "status" })).rejects.toThrow(/boom/);
	});
});
