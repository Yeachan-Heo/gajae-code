import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEmptyNotebook, readNotebookDocument } from "@gajae-code/coding-agent/edit/notebook";
import {
	ensureRlmSessionDir,
	generateRlmSessionId,
	isValidRlmSessionId,
	resolveRlmArtifactPaths,
} from "@gajae-code/coding-agent/rlm/artifacts";
import { loadRlmDataContext } from "@gajae-code/coding-agent/rlm/data-context";
import { RlmNotebookWriter } from "@gajae-code/coding-agent/rlm/notebook";
import {
	assertRlmToolAllowlist,
	buildRlmSystemPrompt,
	isRlmToolAllowed,
	RLM_RESEARCH_PROMPT,
	RLM_TOOL_ALLOWLIST,
} from "@gajae-code/coding-agent/rlm/preset";
import { synthesizeRlmReport } from "@gajae-code/coding-agent/rlm/report";
import type { RlmCellResult } from "@gajae-code/coding-agent/rlm/types";

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-test-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const okCell = (output: string): RlmCellResult => ({
	output,
	exitCode: 0,
	cancelled: false,
	truncated: false,
	displayOutputs: [],
});

describe("rlm artifacts", () => {
	test("validates session ids", () => {
		expect(isValidRlmSessionId("2026-06-16-abc")).toBe(true);
		expect(isValidRlmSessionId("../escape")).toBe(false);
		expect(isValidRlmSessionId("has space")).toBe(false);
		expect(isValidRlmSessionId("")).toBe(false);
	});

	test("generated ids are valid and unique", () => {
		const a = generateRlmSessionId();
		const b = generateRlmSessionId();
		expect(isValidRlmSessionId(a)).toBe(true);
		expect(a).not.toBe(b);
	});

	test("resolves artifact paths under .gjc/rlm/<id> and creates the dir", async () => {
		const paths = resolveRlmArtifactPaths(tmp, "sess1");
		expect(paths.dir).toBe(path.join(tmp, ".gjc", "rlm", "sess1"));
		expect(paths.notebookPath.endsWith(path.join("sess1", "notebook.ipynb"))).toBe(true);
		expect(paths.reportPath.endsWith("report.md")).toBe(true);
		await ensureRlmSessionDir(paths);
		expect((await fs.stat(paths.dir)).isDirectory()).toBe(true);
	});

	test("rejects invalid session ids when resolving paths", () => {
		expect(() => resolveRlmArtifactPaths(tmp, "../escape")).toThrow();
	});
});

describe("rlm notebook writer", () => {
	test("appends code cells live with valid, re-readable .ipynb", async () => {
		const nbPath = path.join(tmp, "notebook.ipynb");
		const writer = new RlmNotebookWriter(nbPath);
		await writer.appendMarkdown("# Investigation");
		await writer.appendCode("x = 1\nprint(x)", okCell("1\n"));
		await writer.flush();

		const doc = await readNotebookDocument(nbPath, nbPath);
		expect(doc.cells.length).toBe(2);
		expect(doc.cells[0].cell_type).toBe("markdown");
		expect(doc.cells[1].cell_type).toBe("code");
		expect(doc.cells[1].execution_count).toBe(1);
		const outputs = doc.cells[1].outputs as Array<Record<string, unknown>>;
		expect(outputs[0].output_type).toBe("stream");
		expect(outputs[0].name).toBe("stdout");
	});

	test("error cells route to stderr stream and do not corrupt the notebook", async () => {
		const nbPath = path.join(tmp, "notebook.ipynb");
		const writer = new RlmNotebookWriter(nbPath);
		await writer.appendCode("boom()", {
			output: "NameError\n",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
		});
		await writer.flush();
		const doc = await readNotebookDocument(nbPath, nbPath);
		const outputs = doc.cells[0].outputs as Array<Record<string, unknown>>;
		expect(outputs[0].name).toBe("stderr");
	});

	test("concurrent appends serialize without corrupting the file", async () => {
		const nbPath = path.join(tmp, "notebook.ipynb");
		const writer = new RlmNotebookWriter(nbPath);
		await Promise.all([
			writer.appendCode("a=1", okCell("a\n")),
			writer.appendCode("b=2", okCell("b\n")),
			writer.appendCode("c=3", okCell("c\n")),
		]);
		await writer.flush();
		const doc = await readNotebookDocument(nbPath, nbPath);
		expect(doc.cells.length).toBe(3);
		const counts = doc.cells.map(cell => cell.execution_count);
		expect(new Set(counts).size).toBe(3);
	});
});

describe("rlm report synthesis", () => {
	test("produces deterministic markdown with cells, outputs, and summary", () => {
		const notebook = createEmptyNotebook();
		notebook.cells.push({ cell_type: "markdown", source: "intro" });
		notebook.cells.push({
			cell_type: "code",
			source: "print('hi')",
			execution_count: 1,
			outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }],
		});
		const report = synthesizeRlmReport({
			title: "My Research",
			summary: "Found something.",
			notebook,
			dataPath: "/tmp/DATA.md",
			generatedAt: "2026-01-01T00:00:00Z",
		});
		expect(report).toContain("# My Research");
		expect(report).toContain("Cells executed: 1");
		expect(report).toContain("Data context: /tmp/DATA.md");
		expect(report).toContain("## Summary");
		expect(report).toContain("Found something.");
		expect(report).toContain("### Cell 1");
		expect(report).toContain("print('hi')");
		expect(report).toContain("hi");
		// Deterministic: same input → same output.
		expect(
			synthesizeRlmReport({
				title: "My Research",
				summary: "Found something.",
				notebook,
				dataPath: "/tmp/DATA.md",
				generatedAt: "2026-01-01T00:00:00Z",
			}),
		).toBe(report);
	});
});

describe("rlm data context", () => {
	test("auto-loads project-root DATA.md when present", async () => {
		await Bun.write(path.join(tmp, "DATA.md"), "rows: 100");
		const ctx = await loadRlmDataContext(tmp, undefined);
		expect(ctx?.content).toBe("rows: 100");
		expect(ctx?.path).toBe(path.join(tmp, "DATA.md"));
	});

	test("returns null when no DATA.md and no flag", async () => {
		expect(await loadRlmDataContext(tmp, undefined)).toBeNull();
	});

	test("--data overrides and is required to exist", async () => {
		await Bun.write(path.join(tmp, "custom.md"), "custom data");
		const ctx = await loadRlmDataContext(tmp, "custom.md");
		expect(ctx?.content).toBe("custom data");
		await expect(loadRlmDataContext(tmp, "missing.md")).rejects.toThrow(/not found/);
	});
});

describe("rlm preset tool boundary", () => {
	test("allowlist membership is case-insensitive and excludes dangerous tools", () => {
		expect(isRlmToolAllowed("python")).toBe(true);
		expect(isRlmToolAllowed("READ")).toBe(true);
		expect(isRlmToolAllowed("web_search")).toBe(true);
		expect(isRlmToolAllowed("bash")).toBe(false);
		expect(isRlmToolAllowed("edit")).toBe(false);
		expect(isRlmToolAllowed("goal")).toBe(false);
		expect(RLM_TOOL_ALLOWLIST).not.toContain("bash");
	});

	test("assertRlmToolAllowlist passes for allowed sets", () => {
		expect(() => assertRlmToolAllowlist(["python", "read", "web_search"])).not.toThrow();
	});

	test("assertRlmToolAllowlist throws naming the leaked tools", () => {
		expect(() => assertRlmToolAllowlist(["python", "bash", "edit"])).toThrow(/bash/);
		expect(() => assertRlmToolAllowlist(["goal"])).toThrow(/goal/);
	});

	test("system prompt builder appends the research prompt and data context", () => {
		const noData = buildRlmSystemPrompt(null)(["base"]);
		expect(noData[0]).toBe("base");
		expect(noData).toContain(RLM_RESEARCH_PROMPT);

		const withData = buildRlmSystemPrompt({ path: "/tmp/DATA.md", content: "schema: x" })(["base"]);
		expect(withData.some(block => block.includes("schema: x") && block.includes("/tmp/DATA.md"))).toBe(true);
	});
});
