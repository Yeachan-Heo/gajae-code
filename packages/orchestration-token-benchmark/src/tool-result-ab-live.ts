/**
 * Live tool-result A/B driver (#5945).
 *
 * Runs each corpus task under baseline and candidate settings overrides through the
 * CLI's in-process `createAgentSession` path and records tool-result chars and success.
 * Manual, NON-CI: it spends provider tokens. Usage:
 *   bun run bench:tool-results:live --model <pattern> --baseline '{"tools.maxInlineResultBytes":0}' \
 *     --candidate '{"tools.maxInlineResultBytes":12}' [--repeats 2] [--out <dir>]
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthStorage,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@gajae-code/coding-agent";
import {
	compareArms,
	measureToolResults,
	renderToolResultAbMarkdown,
	summarizeArm,
	type TaskRun,
	TOOL_RESULT_AB_SCHEMA_VERSION,
	type ToolResultAbReport,
	type TranscriptMessage,
	transcriptError,
} from "./tool-result-ab";
import { AB_TASKS, type AbTask, answerMatches, writeAbCorpus } from "./tool-result-ab-corpus";

export interface LiveAbOptions {
	model: string;
	baseline: Record<string, unknown>;
	candidate: Record<string, unknown>;
	repeats: number;
	outputDir: string;
	tasks: readonly AbTask[];
}

const TASK_TOOLS = ["read", "search", "find", "bash"];
const SYSTEM_SUFFIX =
	"You are answering a factual question about the repository in the working directory. Use tools to find the answer, then reply with the answer only.";

async function runTask(
	options: LiveAbOptions,
	arm: string,
	overrides: Record<string, unknown>,
	task: AbTask,
	repeat: number,
	shared: { authStorage: AuthStorage; modelRegistry: ModelRegistry },
): Promise<TaskRun> {
	const run: TaskRun = {
		taskId: task.id,
		arm,
		repeat,
		success: false,
		toolResultChars: 0,
		byTool: {},
		totalTokens: 0,
	};
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-ab-${task.id}-`));
	try {
		await writeAbCorpus(cwd);
		const settings = await Settings.loadForScope({ cwd });
		const override = settings.override.bind(settings) as (path: string, value: unknown) => void;
		for (const [key, value] of Object.entries(overrides)) override(key, value);
		const { session } = await createAgentSession({
			cwd,
			settings,
			modelPattern: options.model,
			authStorage: shared.authStorage,
			modelRegistry: shared.modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			systemPrompt: defaultPrompt => [...defaultPrompt, SYSTEM_SUFFIX],
			toolNames: TASK_TOOLS,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			disableExtensionDiscovery: true,
		});
		try {
			await session.prompt(task.prompt, { expandPromptTemplates: false });
			await session.waitForIdle();
			const transcript = session.messages as TranscriptMessage[];
			const measured = measureToolResults(transcript);
			run.error = transcriptError(transcript);
			run.success = run.error === undefined && answerMatches(session.getLastAssistantText(), task.expect);
			run.toolResultChars = measured.chars;
			run.byTool = measured.byTool;
			run.totalTokens = session.getSessionStats().tokens.total;
			if (run.error === undefined) delete run.error;
			return run;
		} finally {
			await session.dispose();
		}
	} catch (error) {
		return { ...run, error: error instanceof Error ? error.message : String(error) };
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

/** Reject override keys that are not settings before spending provider tokens on a run that measures nothing. */
export function assertKnownSettings(overrides: Record<string, unknown>): void {
	const probe = Settings.isolated();
	const read = probe.get.bind(probe) as (path: string) => unknown;
	for (const key of Object.keys(overrides)) {
		let known: boolean;
		try {
			known = read(key) !== undefined;
		} catch {
			known = false;
		}
		if (!known) throw new Error(`Unknown setting override: ${key}`);
	}
}

/** Reject arms whose effective settings are identical: any "difference" they report is sampling noise. */
export function assertArmsDiffer(baseline: Record<string, unknown>, candidate: Record<string, unknown>): void {
	const read = (overrides: Record<string, unknown>, key: string) => {
		const settings = Settings.isolated();
		const override = settings.override.bind(settings) as (path: string, value: unknown) => void;
		for (const [path, value] of Object.entries(overrides)) override(path, value);
		return JSON.stringify((settings.get.bind(settings) as (path: string) => unknown)(key));
	};
	const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
	if ([...keys].every(key => read(baseline, key) === read(candidate, key))) {
		throw new Error("Baseline and candidate resolve to identical settings; pin the baseline with --baseline");
	}
}

export async function runLiveToolResultAb(options: LiveAbOptions): Promise<ToolResultAbReport> {
	assertKnownSettings(options.baseline);
	assertKnownSettings(options.candidate);
	assertArmsDiffer(options.baseline, options.candidate);
	const authStorage = await discoverAuthStorage();
	const shared = { authStorage, modelRegistry: new ModelRegistry(authStorage) };
	const runs: TaskRun[] = [];
	// Interleave arms per task/repeat so provider drift over the run hits both arms equally.
	for (let repeat = 0; repeat < options.repeats; repeat++) {
		for (const task of options.tasks) {
			runs.push(await runTask(options, "baseline", options.baseline, task, repeat, shared));
			runs.push(await runTask(options, "candidate", options.candidate, task, repeat, shared));
		}
	}
	const baseline = summarizeArm("baseline", runs);
	const candidate = summarizeArm("candidate", runs);
	const report: ToolResultAbReport = {
		schemaVersion: TOOL_RESULT_AB_SCHEMA_VERSION,
		model: options.model,
		repeats: options.repeats,
		arms: { baseline: options.baseline, candidate: options.candidate },
		baseline,
		candidate,
		verdict: compareArms(baseline, candidate),
		runs,
	};
	await fs.mkdir(options.outputDir, { recursive: true });
	await Bun.write(path.join(options.outputDir, "tool-result-ab.json"), `${JSON.stringify(report, null, "\t")}\n`);
	await Bun.write(path.join(options.outputDir, "tool-result-ab.md"), renderToolResultAbMarkdown(report));
	return report;
}

function parseOverrides(raw: string | undefined, flag: string): Record<string, unknown> {
	if (raw === undefined) return {};
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${flag} must be a JSON object of setting overrides`);
	}
	return parsed as Record<string, unknown>;
}

export function parseLiveAbArgs(args: readonly string[]): LiveAbOptions {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i];
		const value = args[i + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "<end>"}`);
		values.set(key, value);
	}
	const model = values.get("--model");
	if (!model) throw new Error("--model is required");
	const candidate = parseOverrides(values.get("--candidate"), "--candidate");
	if (Object.keys(candidate).length === 0) throw new Error("--candidate must override at least one setting");
	const repeats = Number(values.get("--repeats") ?? "2");
	if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
	const taskFilter = values.get("--tasks")?.split(",");
	const tasks = taskFilter ? AB_TASKS.filter(task => taskFilter.includes(task.id)) : AB_TASKS;
	if (tasks.length === 0) throw new Error("--tasks matched no corpus task");
	return {
		model,
		baseline: parseOverrides(values.get("--baseline"), "--baseline"),
		candidate,
		repeats,
		outputDir: values.get("--out") ?? path.join(os.tmpdir(), `gjc-tool-result-ab-${Date.now()}`),
		tasks,
	};
}

if (import.meta.main) {
	const options = parseLiveAbArgs(Bun.argv.slice(2));
	const report = await runLiveToolResultAb(options);
	process.stdout.write(renderToolResultAbMarkdown(report));
	process.stdout.write(`\nArtifacts: ${options.outputDir}\n`);
	process.exit(report.verdict.outcome === "candidate-wins" ? 0 : 1);
}
