/**
 * Tests for the autonomous / resumable / completion-gate RLM surface (G002-G005):
 * flag extraction, the complete_research stop+report seam, the optional
 * successful-run gate, and resume artifact helpers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readNotebookDocument } from "@gajae-code/coding-agent/edit/notebook";
import type { CustomToolContext } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import {
	ensureRlmSessionDir,
	generateRlmSessionId,
	readRlmNotebookIfPresent,
	resolveRlmArtifactPaths,
	rlmSessionExists,
} from "@gajae-code/coding-agent/rlm/artifacts";
import {
	countSuccessfulNotebookRuns,
	createRlmCompleteResearchTool,
	summarizeNotebookForReplay,
} from "@gajae-code/coding-agent/rlm/complete-research-tool";
import { extractRlmFlags } from "@gajae-code/coding-agent/rlm/index";
import { RlmNotebookWriter } from "@gajae-code/coding-agent/rlm/notebook";
import type { RlmCellResult } from "@gajae-code/coding-agent/rlm/types";

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-auto-"));
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

const errCell = (output: string): RlmCellResult => ({
	output,
	exitCode: 1,
	cancelled: false,
	truncated: false,
	displayOutputs: [],
});

const ctx = {} as unknown as CustomToolContext;

describe("extractRlmFlags", () => {
	test("pulls --data, --resume, and --min-successful-runs out of argv", () => {
		const parsed = extractRlmFlags([
			"--data",
			"DATA.md",
			"--resume",
			"sess-1",
			"--min-successful-runs",
			"3",
			"investigate the spike",
		]);
		expect(parsed.dataPath).toBe("DATA.md");
		expect(parsed.resumeSessionId).toBe("sess-1");
		expect(parsed.minSuccessfulRuns).toBe(3);
		expect(parsed.rest).toEqual(["investigate the spike"]);
	});

	test("supports = syntax and the -r resume alias", () => {
		const parsed = extractRlmFlags(["--data=custom.md", "-r", "sess-2", "--min-successful-runs=0"]);
		expect(parsed.dataPath).toBe("custom.md");
		expect(parsed.resumeSessionId).toBe("sess-2");
		expect(parsed.minSuccessfulRuns).toBe(0);
		expect(parsed.rest).toEqual([]);
	});

	test("defaults are empty and the min-successful-runs flag rejects non-integers", () => {
		const parsed = extractRlmFlags(["just a goal"]);
		expect(parsed.dataPath).toBeUndefined();
		expect(parsed.resumeSessionId).toBeUndefined();
		expect(parsed.minSuccessfulRuns).toBe(0);
		expect(parsed.rest).toEqual(["just a goal"]);
		expect(() => extractRlmFlags(["--min-successful-runs", "two"])).toThrow(/non-negative integer/);
		expect(() => extractRlmFlags(["--resume"])).toThrow(/requires an RLM session id/);
	});
});

describe("notebook run accounting", () => {
	test("counts code cells without error output as successful", async () => {
		const writer = new RlmNotebookWriter(path.join(tmp, "notebook.ipynb"));
		await writer.appendMarkdown("# intro");
		await writer.appendCode("x = 1", okCell("ok\n"));
		await writer.appendCode("boom()", errCell("NameError\n"));
		await writer.appendCode("y = 2", okCell(""));
		await writer.flush();
		expect(countSuccessfulNotebookRuns(writer.document)).toBe(2);
	});

	test("summarizes prior cells and outputs for replay context", async () => {
		const writer = new RlmNotebookWriter(path.join(tmp, "notebook.ipynb"));
		await writer.appendCode("print('total', 800)", okCell("total 800\n"));
		await writer.flush();
		const summary = summarizeNotebookForReplay(writer.document);
		expect(summary).toContain("Cell 1");
		expect(summary).toContain("print('total', 800)");
		expect(summary).toContain("total 800");
	});
});

describe("complete_research stop+report seam", () => {
	function setup(options: { minSuccessfulRuns?: number; goalStatus?: string } = {}) {
		const paths = resolveRlmArtifactPaths(tmp, "sess-complete");
		const notebook = new RlmNotebookWriter(paths.notebookPath);
		const completed: string[] = [];
		const tool = createRlmCompleteResearchTool({
			paths,
			notebook,
			title: "RLM session",
			dataPath: null,
			minSuccessfulRuns: options.minSuccessfulRuns,
			getGoalStatus: () => options.goalStatus,
			markCompleted: summary => completed.push(summary),
		});
		return { paths, notebook, completed, tool };
	}

	test("final completion requires goal completion first", async () => {
		const { tool } = setup({ goalStatus: "active" });
		await expect(tool.execute("c1", { summary: "done" }, undefined, ctx, undefined)).rejects.toThrow(
			/requires goal\(\{op:"complete"\}\) first/,
		);
	});

	test("final completion writes the report and marks the controller complete", async () => {
		const { paths, notebook, completed, tool } = setup({ goalStatus: "complete" });
		await notebook.appendCode("print('hi')", okCell("hi\n"));
		const result = await tool.execute("c1", { summary: "Found the answer." }, undefined, ctx, undefined);
		expect(result.content[0]?.type === "text" && result.content[0].text).toContain("Final report synthesized");
		expect(completed).toEqual(["Found the answer."]);
		const report = await Bun.file(paths.reportPath).text();
		expect(report).toContain("Found the answer.");
	});

	test("draft mode never completes and ignores goal/gate state", async () => {
		const { paths, completed, tool } = setup({ goalStatus: "active", minSuccessfulRuns: 5 });
		const result = await tool.execute("c1", { summary: "interim", final: false }, undefined, ctx, undefined);
		expect(result.content[0]?.type === "text" && result.content[0].text).toContain("Draft report synthesized");
		expect(completed).toEqual([]);
		expect(await Bun.file(paths.reportPath).text()).toContain("interim");
	});

	test("min-successful-runs gate blocks final completion until satisfied", async () => {
		const { notebook, completed, tool } = setup({ goalStatus: "complete", minSuccessfulRuns: 2 });
		await notebook.appendCode("x = 1", okCell("ok\n"));
		await expect(tool.execute("c1", { summary: "too early" }, undefined, ctx, undefined)).rejects.toThrow(
			/at least 2 successful Python run/,
		);
		await notebook.appendCode("y = 2", okCell("ok\n"));
		await tool.execute("c2", { summary: "now grounded" }, undefined, ctx, undefined);
		expect(completed).toEqual(["now grounded"]);
	});
});

describe("resume artifact helpers", () => {
	test("rlmSessionExists reflects on-disk session dirs", async () => {
		const sessionId = generateRlmSessionId();
		expect(await rlmSessionExists(tmp, sessionId)).toBe(false);
		await ensureRlmSessionDir(resolveRlmArtifactPaths(tmp, sessionId));
		expect(await rlmSessionExists(tmp, sessionId)).toBe(true);
	});

	test("readRlmNotebookIfPresent returns the prior notebook or undefined", async () => {
		const sessionId = generateRlmSessionId();
		expect(await readRlmNotebookIfPresent(tmp, sessionId)).toBeUndefined();
		const paths = resolveRlmArtifactPaths(tmp, sessionId);
		const writer = new RlmNotebookWriter(paths.notebookPath);
		await writer.appendCode("z = 3", okCell("z\n"));
		await writer.flush();
		const restored = await readRlmNotebookIfPresent(tmp, sessionId);
		expect(restored?.cells.length).toBe(1);
		const reread = await readNotebookDocument(paths.notebookPath, paths.notebookPath);
		expect(reread.cells.length).toBe(1);
	});
});
