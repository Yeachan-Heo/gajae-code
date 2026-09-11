import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import type { ReadToolDetails } from "@gajae-code/coding-agent/tools/read";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";

let artifactCounter = 0;

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function createSession(cwd: string, settings = Settings.isolated()): ToolSession {
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			await fs.mkdir(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
	};
}

describe("read summary", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-summary-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("summarizes parseable TypeScript files without an explicit selector", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(
			fixture,
			"export function alpha(value: string): string {\n\tconst clean = value.trim();\n\tconst label = clean || 'alpha';\n\treturn label.toUpperCase();\n}\n\nexport function beta(): number {\n\tconst one = 1;\n\tconst two = 2;\n\treturn one + two;\n}\n",
		);

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-ts", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("export function alpha(value: string): string { .. }");
		expect(text).toContain("export function beta(): number { .. }");
		expect(text).not.toContain("const clean = value.trim()");
		expect(result.details?.summary?.elidedSpans).toBe(2);
	});

	it("summarizes Markdown only when prose summaries are enabled", async () => {
		const fixture = path.join(tmpDir, "fixture.md");
		await fs.writeFile(
			fixture,
			"# Heading\n\nIntro line.\n\n```ts\nexport function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n```\n\nMore prose.\n",
		);

		const defaultTool = new ReadTool(createSession(tmpDir));
		const defaultResult = await defaultTool.execute("read-summary-md-default", { path: fixture });
		expect(textOutput(defaultResult)).toContain("const clean = 'alpha';");
		expect(defaultResult.details?.summary).toBeUndefined();

		const proseTool = new ReadTool(createSession(tmpDir, Settings.isolated({ "read.summarize.prose": true })));
		const proseResult = await proseTool.execute("read-summary-md-prose", { path: fixture });
		expect(textOutput(proseResult)).not.toContain("const clean = 'alpha';");
		expect(proseResult.details?.summary?.elidedSpans).toBe(1);
	});

	it("does not truncate summarized output", async () => {
		const fixture = path.join(tmpDir, "many.ts");
		const source = Array.from(
			{ length: 20 },
			(_, index) =>
				`export function fn${index}(): number {\n\tconst one = ${index};\n\tconst two = ${index + 1};\n\treturn one + two;\n}`,
		).join("\n\n");
		await fs.writeFile(fixture, `${source}\n`);

		const tool = new ReadTool(createSession(tmpDir, Settings.isolated({ "read.defaultLimit": 10 })));
		const result = await tool.execute("read-summary-no-truncate", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("export function fn19(): number {");
		expect(text).not.toContain("[Showing lines");
		expect(result.details?.truncation).toBeUndefined();
		expect(result.details?.summary?.elidedSpans).toBe(20);
	});

	it("retains actual parser summary endpoints and monotonic source anchors when capped", async () => {
		const fixture = path.join(tmpDir, "directional-many.ts");
		await fs.writeFile(
			fixture,
			Array.from(
				{ length: 100 },
				(_, index) =>
					`export function fn${index}(): number {\n\tconst one = ${index};\n\tconst two = 2;\n\treturn one + two;\n}`,
			).join("\n\n"),
		);
		const tool = new ReadTool(createSession(tmpDir, Settings.isolated({ "read.summaryMaxBytes": 1 })));
		for (const truncation of ["head", "last", "both"] as const) {
			const result = await tool.execute("read-summary-directional-cap", { path: fixture, truncation });
			const text = textOutput(result);
			const declarations = [...text.matchAll(/^(\d+)[a-z]{2}-(\d+)[a-z]{2}\|export function fn(\d+)\(/gm)];
			expect(declarations.length).toBeGreaterThan(0);
			const indexes = declarations.map(match => Number(match[3]));
			expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
			for (const match of declarations) {
				expect(Number(match[1])).toBe(Number(match[3]) * 6 + 1);
				expect(Number(match[2])).toBe(Number(match[3]) * 6 + 5);
			}
			if (truncation !== "last") expect(indexes[0]).toBe(0);
			if (truncation !== "head") expect(indexes.at(-1)).toBe(99);
			if (truncation === "head") expect(indexes).not.toContain(99);
			if (truncation === "last") expect(indexes).not.toContain(0);
			expect(text.match(/Summary truncated at 1 KiB/g)).toHaveLength(1);
			expect(text).not.toContain("const one =");
		}
	});

	it("returns verbatim anchored ranges when a selector is explicit", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(fixture, "export function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n");

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-range", { path: `${fixture}:1-9999` });
		const text = textOutput(result);

		expect(text).toContain("const clean = 'alpha';");
		expect(text).not.toContain("...");
		expect(result.details?.summary).toBeUndefined();
	});

	it("returns raw verbatim content without anchors", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(fixture, "export const value = 1;\n");

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-raw", { path: `${fixture}:raw` });
		const text = textOutput(result);

		expect(text).toBe("export const value = 1;\n");
		expect(text).not.toMatch(/^1[a-z]{2}\|/);
	});

	it("returns raw verbatim content for compound `:lines:raw` selector", async () => {
		const fixture = path.join(tmpDir, "compound.ts");
		await fs.writeFile(fixture, "alpha\nbeta\ngamma\ndelta\nepsilon\n");

		const tool = new ReadTool(createSession(tmpDir));
		const linesFirst = await tool.execute("read-summary-compound-lines-raw", { path: `${fixture}:2-4:raw` });
		const linesFirstText = textOutput(linesFirst);
		// Verbatim: no hashline anchors and no line-number prefix.
		expect(linesFirstText).toContain("beta");
		expect(linesFirstText).toContain("gamma");
		expect(linesFirstText).toContain("delta");
		expect(linesFirstText).not.toMatch(/^\s*\d+[a-z]{2}\|/m);
		expect(linesFirstText).not.toMatch(/^\s*\d+\|/m);
		// Note: explicit ranges expand with surrounding context lines, so we don't
		// assert on what is excluded — only that the requested range is present
		// verbatim with no anchor or line-number prefixes.

		const rawFirst = await tool.execute("read-summary-compound-raw-lines", { path: `${fixture}:raw:2-4` });
		const rawFirstText = textOutput(rawFirst);
		expect(rawFirstText).toBe(linesFirstText);
	});

	it("falls back to normal reads when summaries are disabled or parsing fails", async () => {
		const valid = path.join(tmpDir, "valid.ts");
		const broken = path.join(tmpDir, "broken.ts");
		await fs.writeFile(valid, "export function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n");
		await fs.writeFile(broken, "export function broken( {\n");

		const disabledTool = new ReadTool(createSession(tmpDir, Settings.isolated({ "read.summarize.enabled": false })));
		const disabled = await disabledTool.execute("read-summary-disabled", { path: valid });
		expect(textOutput(disabled)).toContain("const clean = 'alpha';");
		expect(disabled.details?.summary).toBeUndefined();

		const enabledTool = new ReadTool(createSession(tmpDir));
		const parseFailure = await enabledTool.execute("read-summary-parse-failure", { path: broken });
		expect(textOutput(parseFailure)).toContain("export function broken( {");
		expect(parseFailure.details?.summary).toBeUndefined();
	});

	it("preserves SQLite colon paths while plain-file selectors split only line suffixes", async () => {
		const dbPath = path.join(tmpDir, "data.db");
		const db = new Database(dbPath);
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
			db.run("INSERT INTO users (id, name) VALUES (42, 'Ada')");
		} finally {
			db.close();
		}

		const tool = new ReadTool(createSession(tmpDir));
		const row = await tool.execute("read-summary-sqlite-row", { path: `${dbPath}:users:42` });
		const text = textOutput(row);

		expect(text).toContain("id: 42");
		expect(text).toContain("name: Ada");
	});

	it("renders brace-pair elisions as a single anchored line with `..`", async () => {
		// Regression for the read-tool format request: collapse the head /
		// elided / closing-brace sandwich into one anchored line of the form
		// `LINE+ID-LINE+ID|head { .. }` instead of three separate lines.
		const fixture = path.join(tmpDir, "merge.ts");
		await fs.writeFile(
			fixture,
			"export function stripNewLinePrefixes(lines: string[]): string[] {\n\tconst out: string[] = [];\n\tfor (const line of lines) {\n\t\tout.push(line.replace(/^\\n+/, ''));\n\t}\n\treturn out;\n}\n",
		);

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-merge", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("export function stripNewLinePrefixes(lines: string[]): string[] { .. }");
		// The plain `...` ellipsis line must NOT appear once the merge fires.
		expect(text).not.toContain("\n...\n");
		// The merged anchor must be a hash-line range (LINE+ID-LINE+ID|head).
		expect(text).toMatch(/\b1[a-z]{2}-7[a-z]{2}\|export function stripNewLinePrefixes/);
		expect(result.details?.summary?.elidedSpans).toBe(1);
	});

	it("merges trailing-punctuation closers like `};` and `})`", async () => {
		// `const x = { ... };` — closer is `};` not just `}`. The merge must
		// still fire and preserve the trailing `;` on the merged line.
		const fixture = path.join(tmpDir, "object.ts");
		await fs.writeFile(fixture, "export const config = {\n\talpha: 1,\n\tbeta: 2,\n\tgamma: 3,\n\tdelta: 4,\n};\n");

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-merge-trailing", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("export const config = { .. };");
		expect(text).not.toContain("\n...\n");
	});

	it("does not merge when the closing line is not a bare brace", async () => {
		// Python def: head ends with `:`, tail ends with `return …` — no brace
		// pair. The summarizer must keep the original head / `...` / tail
		// rendering instead of merging.
		const fixture = path.join(tmpDir, "fixture.py");
		await fs.writeFile(
			fixture,
			"def greet(name: str) -> str:\n    clean = name.strip()\n    label = clean or 'world'\n    upper = label.upper()\n    return f'hello {upper}'\n",
		);

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-no-merge", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("def greet(name: str) -> str:");
		// Python's body elision keeps first/last body lines, so plain `...`
		// must remain as the elided segment.
		expect(text).toContain("\n...\n");
		expect(text).not.toContain(" .. ");
	});

	it("appends an elision footer that names the path and `:raw` recovery selector", async () => {
		// Regression for issue #1046: summarized reads must tell the model how
		// to recover the elided body so it does not stall on `...` / `{ .. }`
		// markers and burn a turn guessing the selector.
		const fixture = path.join(tmpDir, "footer.ts");
		await fs.writeFile(
			fixture,
			"export function alpha(value: string): string {\n\tconst clean = value.trim();\n\tconst label = clean || 'alpha';\n\treturn label.toUpperCase();\n}\n\nexport function beta(): number {\n\tconst one = 1;\n\tconst two = 2;\n\treturn one + two;\n}\n",
		);

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-footer", { path: fixture });
		const text = textOutput(result);

		expect(result.details?.summary?.elidedSpans).toBe(2);
		expect(result.details?.summary?.elidedLines).toBeGreaterThan(0);
		expect(text).toContain("elided regions");
		expect(text).toContain(`${fixture}:raw`);
		expect(text).toContain(`${fixture}:1-9999`);
		// Footer must be the LAST block of output so the recovery hint sits
		// next to the structural summary it describes.
		expect(text.trimEnd().endsWith("for verbatim content]")).toBe(true);
	});

	it("does not append a footer when the file has no elision", async () => {
		const fixture = path.join(tmpDir, "noelide.ts");
		await fs.writeFile(fixture, "export const x = 1;\n");

		const tool = new ReadTool(createSession(tmpDir));
		for (const truncation of ["head", "last", "both"] as const) {
			const result = await tool.execute("read-summary-no-footer", { path: fixture, truncation });
			const text = textOutput(result);
			expect(text).toContain("export const x = 1;");
			expect(text).not.toContain("elided regions");
			expect(text).not.toContain(":raw");
			expect(result.details?.summary).toBeUndefined();
		}
	});
});
