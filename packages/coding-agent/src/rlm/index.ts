/**
 * RLM (research) mode entry point.
 *
 * Composes a research session over the existing agent/session loop (python
 * kernel + read + web_search + read-only bash), optional DATA.md context, live
 * notebook.ipynb, first-class complete_research report synthesis, autonomous
 * goal-arg execution, and resumable .gjc/rlm/<session> artifacts.
 */
import * as fs from "node:fs/promises";
import { getProjectDir } from "@gajae-code/utils";
import { type Args, parseArgs } from "../cli/args";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { type RlmPreset, runRootCommand } from "../main";
import rlmReportCommandPrompt from "../prompts/system/rlm-report-command.md" with { type: "text" };
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import {
	ensureRlmSessionDir,
	generateRlmSessionId,
	readRlmNotebookIfPresent,
	resolveRlmArtifactPaths,
	rlmSessionExists,
} from "./artifacts";
import {
	countSuccessfulNotebookRuns,
	createRlmCompleteResearchTool,
	summarizeNotebookForReplay,
	writeRlmReport,
} from "./complete-research-tool";
import { loadRlmDataContext, type RlmDataContext } from "./data-context";
import { RlmNotebookWriter } from "./notebook";
import { assertRlmToolAllowlist, buildRlmSystemPrompt, isRlmToolAllowed, RLM_READ_ONLY_BASH_PREFIXES } from "./preset";
import { createRlmPythonTool } from "./python-tool";
import type { RlmArtifactPaths, RlmSessionMetadata } from "./types";

interface ExtractedRlmFlags {
	dataPath: string | undefined;
	resumeSessionId: string | undefined;
	minSuccessfulRuns: number;
	rest: string[];
}

export interface RlmPresetOptions {
	dataContext: RlmDataContext | null;
	pythonTool: CustomTool;
	completeResearchTool?: CustomTool;
	objective?: string;
	resumeContext?: string;
	onSessionReady?: (session: AgentSession) => void;
}

interface RlmRunController {
	completed: boolean;
	finalSummary: string | undefined;
	session: AgentSession | undefined;
}

function parseNonNegativeIntegerFlag(name: string, value: string | undefined): number {
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`${name} requires a non-negative integer value.`);
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${name} requires a non-negative integer value.`);
	}
	return parsed;
}

/** Pull RLM-owned flags out of argv; the remainder is forwarded to the root command. */
export function extractRlmFlags(argv: string[]): ExtractedRlmFlags {
	const rest: string[] = [];
	let dataPath: string | undefined;
	let resumeSessionId: string | undefined;
	let minSuccessfulRuns = 0;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--data") {
			dataPath = argv[i + 1];
			i += 1;
		} else if (arg.startsWith("--data=")) {
			dataPath = arg.slice("--data=".length);
		} else if (arg === "--resume" || arg === "-r") {
			const next = argv[i + 1];
			if (!next || next.startsWith("-")) throw new Error("gjc rlm --resume requires an RLM session id.");
			resumeSessionId = next;
			i += 1;
		} else if (arg.startsWith("--resume=")) {
			resumeSessionId = arg.slice("--resume=".length);
		} else if (arg === "--min-successful-runs") {
			minSuccessfulRuns = parseNonNegativeIntegerFlag(arg, argv[i + 1]);
			i += 1;
		} else if (arg.startsWith("--min-successful-runs=")) {
			minSuccessfulRuns = parseNonNegativeIntegerFlag(
				"--min-successful-runs",
				arg.slice("--min-successful-runs=".length),
			);
		} else {
			rest.push(arg);
		}
	}
	return { dataPath, resumeSessionId, minSuccessfulRuns, rest };
}

/** @deprecated use extractRlmFlags; retained for tests and compatibility. */
export function extractDataFlag(argv: string[]): { dataPath: string | undefined; rest: string[] } {
	const { dataPath, rest } = extractRlmFlags(argv);
	return { dataPath, rest };
}

export function createRlmPreset({
	dataContext,
	pythonTool,
	completeResearchTool,
	objective,
	resumeContext,
	onSessionReady,
}: RlmPresetOptions): RlmPreset {
	const resolvedObjective = objective ?? buildRlmGoalObjective({ messages: [], dataContext });
	const customTools = completeResearchTool ? [pythonTool, completeResearchTool] : [pythonTool];
	return {
		applyOptions: (options: CreateAgentSessionOptions, settings) => {
			options.systemPrompt = buildRlmSystemPrompt(dataContext, resumeContext);
			options.customTools = customTools;
			options.toolNames = ["read", "web_search", "search_tool_bm25", "bash", "goal"];
			options.requireYieldTool = false;
			options.skills = [];
			options.rules = [];
			options.disableExtensionDiscovery = true;
			options.extensions = [];
			options.additionalExtensionPaths = [];
			options.preloadedExtensions = undefined;
			options.bashAllowedPrefixes = [...RLM_READ_ONLY_BASH_PREFIXES];
			options.bashRestrictionProfile = "read-only";
			options.goalToolAllowedOps = ["get", "complete"];
			options.discoverableToolAllowedNames = [];
			options.slashCommands = [
				...(options.slashCommands ?? []),
				{
					name: "report",
					description: "Synthesize a draft RLM report from the current notebook",
					content: rlmReportCommandPrompt,
					source: "rlm",
				},
			];
			// RLM always runs in goal mode; recipe injection stays outside the research surface.
			settings.override("goal.enabled", true);
			settings.override("tools.discoveryMode", "all");
			settings.override("recipe.enabled", false);
		},
		onSessionCreated: async (session: AgentSession) => {
			onSessionReady?.(session);
			await ensureRlmGoalMode(session, resolvedObjective);
			// Hard boundary: fail launch if any non-allowlisted tool slipped into the active set.
			assertRlmToolAllowlist(session.getActiveToolNames());
		},
	};
}

async function ensureRlmGoalMode(session: AgentSession, objective: string): Promise<void> {
	const current = session.getGoalModeState();
	if (current?.goal && current.goal.status !== "complete" && current.goal.status !== "dropped") {
		if (!current.enabled || current.goal.status === "paused") {
			await session.goalRuntime.resumeGoal();
		}
	} else {
		await session.goalRuntime.createGoal({ objective });
	}
	await session.setActiveToolsByName([...new Set([...session.getActiveToolNames().filter(isRlmToolAllowed), "goal"])]);
}

export function buildRlmGoalObjective(input: {
	messages: readonly string[];
	dataContext: RlmDataContext | null;
}): string {
	const prompt = input.messages
		.map(message => message.trim())
		.filter(Boolean)
		.join("\n\n");
	if (prompt.length > 0) return prompt;
	if (input.dataContext) {
		return `Complete an RLM research session using data context ${input.dataContext.path}, grounding conclusions in notebook outputs and finishing with a report.`;
	}
	return "Complete this RLM research session, grounding conclusions in notebook outputs and finishing with a report.";
}
export function isRlmAutonomousRun(parsed: Pick<Args, "print" | "mode" | "messages">, pipedStdin: boolean): boolean {
	return parsed.print === true || parsed.mode !== undefined || pipedStdin;
}

export function prepareRlmLaunchMode(parsed: Args, pipedStdin: boolean): boolean {
	const autonomous = isRlmAutonomousRun(parsed, pipedStdin);
	if (autonomous && parsed.mode === undefined) {
		parsed.print = true;
	}
	return autonomous;
}

async function loadExistingMetadata(paths: RlmArtifactPaths): Promise<RlmSessionMetadata | undefined> {
	try {
		return (await Bun.file(paths.metadataPath).json()) as RlmSessionMetadata;
	} catch {
		return undefined;
	}
}

async function writeRlmMetadata(input: {
	paths: RlmArtifactPaths;
	sessionId: string;
	createdAt: string;
	cwd: string;
	dataPath: string | null;
	cellCount: number;
	mode: "interactive" | "autonomous";
	resumedFrom: string | null;
	completedAt: string | null;
	finalSummary: string | null;
	minSuccessfulRuns: number;
	successfulRuns: number;
}): Promise<void> {
	const metadata: RlmSessionMetadata = {
		sessionId: input.sessionId,
		createdAt: input.createdAt,
		cwd: input.cwd,
		dataPath: input.dataPath,
		cellCount: input.cellCount,
		mode: input.mode,
		resumedFrom: input.resumedFrom,
		completedAt: input.completedAt,
		finalSummary: input.finalSummary,
		minSuccessfulRuns: input.minSuccessfulRuns,
		successfulRuns: input.successfulRuns,
	};
	await Bun.write(input.paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function runRlmCommand(argv: string[]): Promise<void> {
	const cwd = getProjectDir();
	const { dataPath, resumeSessionId, minSuccessfulRuns, rest } = extractRlmFlags(argv);
	const dataContext = await loadRlmDataContext(cwd, dataPath);

	const sessionId = resumeSessionId ?? generateRlmSessionId();
	const paths = resolveRlmArtifactPaths(cwd, sessionId);
	if (resumeSessionId && !(await rlmSessionExists(cwd, resumeSessionId))) {
		throw new Error(`RLM session not found: ${resumeSessionId}`);
	}
	await ensureRlmSessionDir(paths);
	await fs.mkdir(paths.agentSessionDir, { recursive: true });

	const existingNotebook = resumeSessionId ? await readRlmNotebookIfPresent(cwd, sessionId) : undefined;
	const existingMetadata = await loadExistingMetadata(paths);
	const notebook = new RlmNotebookWriter(paths.notebookPath, existingNotebook);
	const pythonTool = createRlmPythonTool({
		cwd,
		sessionId,
		artifactsDir: paths.dir,
		notebook,
		managedWorkspaceVenv: true,
	});
	const controller: RlmRunController = { completed: false, finalSummary: undefined, session: undefined };
	const reportTitle = `RLM research session ${sessionId}`;
	const completeResearchTool = createRlmCompleteResearchTool({
		paths,
		notebook,
		title: reportTitle,
		dataPath: dataContext?.path ?? null,
		minSuccessfulRuns,
		getGoalStatus: () => controller.session?.getGoalModeState()?.goal.status,
		markCompleted: summary => {
			controller.completed = true;
			controller.finalSummary = summary;
		},
	});

	const parsed = parseArgs(rest);
	parsed.sessionDir = paths.agentSessionDir;
	if (resumeSessionId) {
		parsed.continue = true;
	}
	// Piped stdin (non-TTY), explicit --print, and explicit --mode run as autonomous
	// research. Positional argv messages seed the interactive RLM shell, so
	// `gjc rlm "question"` still loads the TUI instead of being coerced into
	// print mode.
	const pipedStdin = process.stdin.isTTY === false;
	const autonomous = prepareRlmLaunchMode(parsed, pipedStdin);
	const resumeContext = existingNotebook ? summarizeNotebookForReplay(existingNotebook) : undefined;
	const preset = createRlmPreset({
		dataContext,
		pythonTool,
		completeResearchTool,
		objective: buildRlmGoalObjective({ messages: parsed.messages, dataContext }),
		resumeContext,
		onSessionReady: session => {
			controller.session = session;
		},
	});
	if (autonomous) {
		preset.applyOptions = ((applyOptions: RlmPreset["applyOptions"]) => (options, settings) => {
			applyOptions(options, settings);
			options.shouldPause = () => controller.completed;
		})(preset.applyOptions);
	}

	let runError: unknown;
	try {
		await runRootCommand(parsed, rest, { rlmPreset: preset, suppressProcessExit: autonomous });
	} catch (error) {
		runError = error;
		throw error;
	} finally {
		// The RLM python tool owns a retained kernel keyed by `rlm:<sessionId>`; the
		// session's own dispose targets a different owner id, so release it here so
		// the persistent kernel subprocess is reaped on every exit path.
		await disposeKernelSessionsByOwner(`rlm:${sessionId}`).catch(() => {});
		await writeRlmReport({
			paths,
			notebook,
			title: reportTitle,
			summary: controller.finalSummary,
			dataPath: dataContext?.path ?? null,
		});
		await writeRlmMetadata({
			paths,
			sessionId,
			createdAt: existingMetadata?.createdAt ?? new Date().toISOString(),
			cwd,
			dataPath: dataContext?.path ?? null,
			cellCount: notebook.cellCount,
			mode: autonomous ? "autonomous" : "interactive",
			resumedFrom: resumeSessionId ?? null,
			completedAt: controller.completed ? new Date().toISOString() : null,
			finalSummary: controller.finalSummary ?? null,
			minSuccessfulRuns,
			successfulRuns: countSuccessfulNotebookRuns(notebook.document),
		});
	}
	if (autonomous && !controller.completed && runError === undefined) {
		throw new Error("RLM autonomous session ended before complete_research finalized the report.");
	}
}
