/**
 * End-to-end RLM pipeline test with real example data.
 *
 * Drives the real surface: the RLM `python` tool executes against the shared
 * persistent Python kernel (a real subprocess), state persists across cells,
 * each cell is aggregated into a real notebook.ipynb, and report.md is
 * synthesized from it. Uses Python stdlib only (no numpy/pandas dependency) so
 * it runs anywhere a python3 interpreter is available.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readNotebookDocument } from "@gajae-code/coding-agent/edit/notebook";
import { disposeKernelSessionsByOwner } from "@gajae-code/coding-agent/eval/py/executor";
import type { CustomToolContext } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import {
	ensureRlmSessionDir,
	generateRlmSessionId,
	resolveRlmArtifactPaths,
} from "@gajae-code/coding-agent/rlm/artifacts";
import { loadRlmDataContext } from "@gajae-code/coding-agent/rlm/data-context";
import { RlmNotebookWriter } from "@gajae-code/coding-agent/rlm/notebook";
import { createRlmPythonTool } from "@gajae-code/coding-agent/rlm/python-tool";
import { synthesizeRlmReport } from "@gajae-code/coding-agent/rlm/report";

const SALES_CSV = `region,amount
north,100
north,150
south,200
south,50
east,300
`;

let cwd: string;
let sessionId: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-e2e-"));
	sessionId = generateRlmSessionId();
});

afterEach(async () => {
	await disposeKernelSessionsByOwner(`rlm:${sessionId}`);
	await fs.rm(cwd, { recursive: true, force: true });
});

function makeTool(notebook: RlmNotebookWriter) {
	const paths = resolveRlmArtifactPaths(cwd, sessionId);
	return createRlmPythonTool({ cwd, sessionId, artifactsDir: paths.dir, notebook });
}

async function runCell(tool: ReturnType<typeof createRlmPythonTool>, code: string): Promise<string> {
	const result = await tool.execute(
		`call-${Math.random().toString(36).slice(2)}`,
		{ code },
		undefined,
		{} as unknown as CustomToolContext,
		undefined,
	);
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

describe("rlm end-to-end with real example data", () => {
	test("real CSV analysis flows through kernel -> notebook -> report", async () => {
		await Bun.write(path.join(cwd, "data.csv"), SALES_CSV);
		await Bun.write(path.join(cwd, "DATA.md"), "Sales CSV with columns region, amount across 5 rows.");

		// DATA.md auto-loads.
		const dataContext = await loadRlmDataContext(cwd, undefined);
		expect(dataContext?.content).toContain("Sales CSV");

		const paths = resolveRlmArtifactPaths(cwd, sessionId);
		await ensureRlmSessionDir(paths);
		const notebook = new RlmNotebookWriter(paths.notebookPath);
		const tool = makeTool(notebook);

		// Cell 1: load the real dataset into kernel state.
		const out1 = await runCell(
			tool,
			["import csv", "rows = list(csv.DictReader(open('data.csv')))", "print('rows', len(rows))"].join("\n"),
		);
		expect(out1).toContain("rows 5");

		// Cell 2: depends on Cell 1 state (proves kernel persistence) and computes real stats.
		const out2 = await runCell(
			tool,
			[
				"import statistics",
				"amounts = [float(r['amount']) for r in rows]",
				"print('total', int(sum(amounts)))",
				"print('mean', int(statistics.mean(amounts)))",
				"by_region = {}",
				"for r in rows: by_region[r['region']] = by_region.get(r['region'], 0) + float(r['amount'])",
				"print('north', int(by_region['north']))",
			].join("\n"),
		);
		expect(out2).toContain("total 800");
		expect(out2).toContain("mean 160");
		expect(out2).toContain("north 250");

		// Notebook aggregated the real cells + outputs, and is valid .ipynb.
		await notebook.flush();
		const doc = await readNotebookDocument(paths.notebookPath, paths.notebookPath);
		const codeCells = doc.cells.filter(cell => cell.cell_type === "code");
		expect(codeCells.length).toBe(2);
		const serialized = JSON.stringify(doc);
		expect(serialized).toContain("rows 5");
		expect(serialized).toContain("total 800");

		// Report synthesized from the real notebook contains the computed evidence.
		const report = synthesizeRlmReport({
			title: "Sales analysis",
			summary: "Total sales were 800 across 5 rows.",
			notebook: doc,
			dataPath: dataContext?.path ?? null,
		});
		await Bun.write(paths.reportPath, report);
		const reportText = await Bun.file(paths.reportPath).text();
		expect(reportText).toContain("# Sales analysis");
		expect(reportText).toContain("Cells executed: 2");
		expect(reportText).toContain("total 800");
		expect(reportText).toContain("north 250");
		expect(reportText).toContain("Total sales were 800");
	}, 90_000);

	test("a failing cell is recorded as a stderr cell without breaking the notebook", async () => {
		const paths = resolveRlmArtifactPaths(cwd, sessionId);
		await ensureRlmSessionDir(paths);
		const notebook = new RlmNotebookWriter(paths.notebookPath);
		const tool = makeTool(notebook);

		const out = await runCell(tool, "raise ValueError('boom')");
		expect(out.toLowerCase()).toContain("valueerror");

		await notebook.flush();
		const doc = await readNotebookDocument(paths.notebookPath, paths.notebookPath);
		expect(doc.cells.length).toBe(1);
		const outputs = doc.cells[0].outputs as Array<Record<string, unknown>>;
		expect(outputs[0].name).toBe("stderr");
	}, 90_000);
});
