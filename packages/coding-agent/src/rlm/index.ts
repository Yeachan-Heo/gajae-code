/**
 * RLM (research) mode entry point.
 *
 * Composes an interactive research session over the existing agent/session loop
 * via a research preset: a distinct system prompt, a hard-gated research toolset
 * (python kernel + read + web_search), optional DATA.md context, a live
 * notebook.ipynb, and a synthesized report.md on session exit.
 */
import { getProjectDir } from "@gajae-code/utils";
import { parseArgs } from "../cli/args";
import { type RlmPreset, runRootCommand } from "../main";
import { ensureRlmSessionDir, generateRlmSessionId, resolveRlmArtifactPaths } from "./artifacts";
import { loadRlmDataContext } from "./data-context";
import { RlmNotebookWriter } from "./notebook";
import { assertRlmToolAllowlist, buildRlmSystemPrompt } from "./preset";
import { createRlmPythonTool } from "./python-tool";
import { synthesizeRlmReport } from "./report";
import type { RlmSessionMetadata } from "./types";

interface ExtractedDataFlag {
	dataPath: string | undefined;
	rest: string[];
}

/** Pull `--data <path>` / `--data=<path>` out of argv; the remainder is forwarded to the root command. */
export function extractDataFlag(argv: string[]): ExtractedDataFlag {
	const rest: string[] = [];
	let dataPath: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--data") {
			dataPath = argv[i + 1];
			i += 1;
		} else if (arg.startsWith("--data=")) {
			dataPath = arg.slice("--data=".length);
		} else {
			rest.push(arg);
		}
	}
	return { dataPath, rest };
}

export async function runRlmCommand(argv: string[]): Promise<void> {
	const cwd = getProjectDir();
	const { dataPath, rest } = extractDataFlag(argv);
	const dataContext = await loadRlmDataContext(cwd, dataPath);

	const sessionId = generateRlmSessionId();
	const paths = resolveRlmArtifactPaths(cwd, sessionId);
	await ensureRlmSessionDir(paths);

	const notebook = new RlmNotebookWriter(paths.notebookPath);
	const pythonTool = createRlmPythonTool({ cwd, sessionId, artifactsDir: paths.dir, notebook });

	const preset: RlmPreset = {
		applyOptions: (options, settings) => {
			options.systemPrompt = buildRlmSystemPrompt(dataContext);
			options.customTools = [pythonTool, ...(options.customTools ?? [])];
			options.toolNames = ["read", "web_search"];
			options.requireYieldTool = false;
			options.skills = [];
			options.rules = [];
			options.disableExtensionDiscovery = true;
			// Disable goal-mode tool injection so the research surface stays exactly the allowlist.
			settings.override("goal.enabled", false);
		},
		onSessionCreated: session => {
			// Hard boundary: fail launch if any non-allowlisted tool slipped into the active set.
			assertRlmToolAllowlist(session.getActiveToolNames());
		},
	};

	const parsed = parseArgs(rest);
	try {
		await runRootCommand(parsed, rest, { rlmPreset: preset });
	} finally {
		await notebook.flush();
		const report = synthesizeRlmReport({
			title: `RLM research session ${sessionId}`,
			notebook: notebook.document,
			dataPath: dataContext?.path ?? null,
		});
		await Bun.write(paths.reportPath, report);
		const metadata: RlmSessionMetadata = {
			sessionId,
			createdAt: new Date().toISOString(),
			cwd,
			dataPath: dataContext?.path ?? null,
			cellCount: notebook.cellCount,
		};
		await Bun.write(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
	}
}
