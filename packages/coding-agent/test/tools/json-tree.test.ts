import { describe, expect, it } from "bun:test";
import { renderJsonTreeLines } from "../../src/tools/json-tree";

type JsonTreeTheme = Parameters<typeof renderJsonTreeLines>[1];
const theme = {
	fg: (_color: string, text: string) => text,
	styledSymbol: (_key: string, _color: string) => "",
	tree: {
		branch: "├─",
		last: "└─",
		vertical: "│",
		horizontal: "─",
		hook: "└",
	},
} as JsonTreeTheme;

describe("renderJsonTreeLines", () => {
	function testTheme() {
		return theme;
	}

	function stripLines(lines: string[]): string[] {
		return lines.map(line => Bun.stripANSI(line));
	}

	it("wraps long path-like string values as deterministic continuations", async () => {
		const theme = await testTheme();
		const target = "../../../gajae-code.gajae-code-worktrees/release-0-5-4-64d49adc/packages/coding-agent";

		const tree = renderJsonTreeLines({ target }, theme, 2, 10, 32);
		const lines = stripLines(tree.lines);

		expect(tree.truncated).toBe(false);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toContain('target: "../../../gajae-code.gajae-code');
		expect(lines[0]).not.toContain(
			'"../../../gajae-code.gajae-code-worktrees/release-0-5-4-64d49adc/packages/coding-agent"',
		);
		expect(lines.slice(1).every(line => line.includes("↳ "))).toBe(true);
		expect(lines.at(-1)).toContain('"');
		expect(lines.join("\n")).toContain("worktrees/release-0-5-4-64d49");
		expect(lines.join("\n")).toContain("packages/coding-agent");
	});

	it("marks long string values truncated when continuation lines exhaust the line budget", async () => {
		const theme = await testTheme();
		const real =
			"/Users/example/Documents/Workspace/gajae-code.gajae-code-worktrees/release-0-5-4-64d49adc/packages/coding-agent/src/tools/json-tree.ts";

		const tree = renderJsonTreeLines({ real, isSymbolicLink: true }, theme, 2, 2, 36);
		const lines = stripLines(tree.lines);

		expect(tree.truncated).toBe(true);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('real: "');
		expect(lines[1]).toContain("↳ ");
		expect(lines[1]).toContain('…"');
		expect(lines.join("\n")).not.toContain("isSymbolicLink");
	});

	it("keeps escaped tabs readable in wrapped string values", async () => {
		const theme = await testTheme();
		const value = "node_modules/@gajae-code/coding-agent\tpackages/coding-agent/src/tools/json-tree.ts";

		const tree = renderJsonTreeLines({ value }, theme, 2, 10, 28);
		const lines = stripLines(tree.lines);

		expect(tree.truncated).toBe(false);
		expect(lines.join("\n")).toContain("\\t");
		expect(lines.join("\n")).not.toContain("\t");
		expect(lines.at(-1)).toContain('"');
	});

	it("escapes newlines and tabs through the same continuation path", async () => {
		const theme = await testTheme();
		const value = "alpha\tbeta\ngamma\tdelta/packages/coding-agent/src/tools/json-tree.ts";

		const tree = renderJsonTreeLines({ value }, theme, 2, 10, 24);
		const lines = stripLines(tree.lines);

		expect(tree.truncated).toBe(false);
		expect(lines.join("\n")).toContain("\\t");
		expect(lines.join("\n")).toContain("\\n");
		expect(lines.join("\n")).not.toContain("\t");
		expect(lines.slice(1).every(line => line.includes("↳ "))).toBe(true);
	});

	it("does not change non-string scalar rendering", async () => {
		const theme = await testTheme();
		const tree = renderJsonTreeLines({ ok: true, count: 42, empty: null }, theme, 2, 10, 12);
		const lines = stripLines(tree.lines);

		expect(tree.truncated).toBe(false);
		expect(lines.some(line => line.includes("ok: true"))).toBe(true);
		expect(lines.some(line => line.includes("count: 42"))).toBe(true);
		expect(lines.some(line => line.includes("empty: null"))).toBe(true);
	});
});
