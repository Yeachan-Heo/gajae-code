/**
 * Live, model-driven RLM end-to-end test.
 *
 * Gated behind GJC_RLM_LIVE=1 because it makes real LLM calls (creds + network)
 * and is therefore not part of the default CI suite. When enabled, it builds a
 * real RLM session via the same SDK path the `gjc rlm` command uses (research
 * preset: distinct system prompt + hard-gated python/read/web_search/read-only bash/goal toolset),
 * lets the real model drive the `python` tool over a real CSV, and asserts the
 * notebook + report capture genuine, model-computed results.
 *
 * Run: GJC_RLM_LIVE=1 [RLM_MODEL=layofflabs/gpt-5.5] bun test test/rlm-live-model-e2e.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { readNotebookDocument } from "@gajae-code/coding-agent/edit/notebook";
import { disposeKernelSessionsByOwner } from "@gajae-code/coding-agent/eval/py/executor";
import {
	ensureRlmSessionDir,
	generateRlmSessionId,
	resolveRlmArtifactPaths,
} from "@gajae-code/coding-agent/rlm/artifacts";
import { loadRlmDataContext } from "@gajae-code/coding-agent/rlm/data-context";
import { createRlmPreset } from "@gajae-code/coding-agent/rlm/index";
import { RlmNotebookWriter } from "@gajae-code/coding-agent/rlm/notebook";
import { assertRlmToolAllowlist } from "@gajae-code/coding-agent/rlm/preset";
import { createRlmPythonTool } from "@gajae-code/coding-agent/rlm/python-tool";
import { synthesizeRlmReport } from "@gajae-code/coding-agent/rlm/report";
import { type CreateAgentSessionOptions, createAgentSession } from "@gajae-code/coding-agent/sdk";

const LIVE = process.env.GJC_RLM_LIVE === "1";
const SALES_CSV = "region,amount\nnorth,100\nnorth,150\nsouth,200\nsouth,50\neast,300\n";

let cwd: string;
let sessionId: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-live-"));
	sessionId = generateRlmSessionId();
});

afterEach(async () => {
	await disposeKernelSessionsByOwner(`rlm:${sessionId}`);
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("rlm live model-driven e2e", () => {
	test.skipIf(!LIVE)(
		"real model drives the python tool and the report captures computed totals",
		async () => {
			await Bun.write(path.join(cwd, "data.csv"), SALES_CSV);
			await Bun.write(path.join(cwd, "DATA.md"), "data.csv has columns region, amount with 5 rows.");

			const paths = resolveRlmArtifactPaths(cwd, sessionId);
			await ensureRlmSessionDir(paths);
			const notebook = new RlmNotebookWriter(paths.notebookPath);
			const tool = createRlmPythonTool({ cwd, sessionId, artifactsDir: paths.dir, notebook });
			const dataContext = await loadRlmDataContext(cwd, undefined);

			const settings = await Settings.init({ cwd });
			const preset = createRlmPreset({ dataContext, pythonTool: tool });
			const options: CreateAgentSessionOptions = {
				cwd,
				modelPattern: process.env.RLM_MODEL ?? "layofflabs/gpt-5.5",
				settings,
				enableLsp: false,
				skipPythonPreflight: true,
			};
			preset.applyOptions(options, settings);
			const { session } = await createAgentSession(options);
			await preset.onSessionCreated?.(session);

			try {
				// Hard tool boundary holds against the real, fully-assembled registry.
				assertRlmToolAllowlist(session.getActiveToolNames());
				expect(session.getActiveToolNames().sort()).toEqual([
					"bash",
					"goal",
					"python",
					"read",
					"search_tool_bm25",
					"web_search",
				]);
				expect(session.getGoalModeState()?.goal.status).toBe("active");

				await session.prompt(
					"Using the python tool, load data.csv and compute the total and mean of amount and the total amount per region. State the numbers, then call the goal completion tool.",
				);

				await notebook.flush();
				const doc = await readNotebookDocument(paths.notebookPath, paths.notebookPath);
				const codeCells = doc.cells.filter(cell => cell.cell_type === "code");
				expect(codeCells.length).toBeGreaterThanOrEqual(1);

				const report = synthesizeRlmReport({
					title: "Live sales analysis",
					notebook: doc,
					dataPath: dataContext?.path ?? null,
				});
				await Bun.write(paths.reportPath, report);
				// The model computed the correct total (800) from the real data.
				expect(report).toContain("800");
			} finally {
				await session.dispose();
			}
		},
		300_000,
	);
});
