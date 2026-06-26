#!/usr/bin/env bun
/**
 * Plans or runs live Composer V3 matrix capture via isolated GJC print-mode sessions.
 * Default: --dry-run prints the matrix without API calls.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { seedScenarioWorkdir } from "./composer-live-fixtures";
import {
	buildTraceRecord,
	findLatestSessionFile,
	readSessionJsonl,
	sessionLinesToTraceEvents,
	traceExpectationForScenario,
} from "./composer-print-trace";
import {
	COMPOSER_SCENARIOS,
	COMPOSER_SCENARIOS_VERSION,
	DEFAULT_CODEX_BASELINE_MODEL,
	DEFAULT_COMPOSER_CANDIDATE_MODEL,
	SCENARIO_BY_ID,
	TOTAL_SCENARIO_COUNT,
	type ScenarioId,
} from "./composer-scenarios";
import { scanTextForPublishSecrets } from "./composer-evidence";
import type { TraceRecord } from "./composer-stability-v3";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

type Role = "candidate" | "baseline";

type PlannedRow = {
	scenarioId: ScenarioId;
	role: Role;
	model: string;
	trial: number;
	userPrompt: string;
};

type RunResult = {
	role: Role;
	model: string;
	scenarioId: ScenarioId;
	artifactSlug: string;
	hasSessionFile: boolean;
	exitCode: number;
	stderrByteLength: number;
	stderrSha256?: string;
	finalTextByteLength: number;
	finalTextSha256?: string;
	toolCount: number;
	toolErrorCount: number;
};

type CaptureArgs = {
	dryRun: boolean;
	skipCredCheck: boolean;
	k: number;
	out?: string;
	candidateModel: string;
	baselineModel: string;
	gjcBin: string;
	scenarioFilter?: Set<ScenarioId>;
	timeoutSec: number;
};

type SessionJsonLine = Record<string, unknown>;
type TraceEvent = Record<string, unknown>;

function parseArgs(argv: string[]): CaptureArgs {
	let dryRun = true;
	let skipCredCheck = false;
	let k = 1;
	let out: string | undefined;
	let candidateModel = DEFAULT_COMPOSER_CANDIDATE_MODEL;
	let baselineModel = DEFAULT_CODEX_BASELINE_MODEL;
	let gjcBin = process.env.GJC_BIN?.trim() || "gjc";
	let scenarioFilter: Set<ScenarioId> | undefined;
	let timeoutSec = 600;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--run") dryRun = false;
		if (arg === "--dry-run") dryRun = true;
		if (arg === "--skip-cred-check") skipCredCheck = true;
		if (arg === "-k" || arg === "--k") k = Number(argv[++i] ?? "1");
		if (arg === "--out") out = argv[++i];
		if (arg === "--model") candidateModel = argv[++i] ?? candidateModel;
		if (arg === "--baseline-model") baselineModel = argv[++i] ?? baselineModel;
		if (arg === "--gjc") gjcBin = argv[++i] ?? gjcBin;
		if (arg === "--timeout") timeoutSec = Number(argv[++i] ?? "600");
		if (arg === "--scenarios") {
			const ids = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean) as ScenarioId[];
			scenarioFilter = new Set(ids);
		}
	}
	return { dryRun, skipCredCheck, k, out, candidateModel, baselineModel, gjcBin, scenarioFilter, timeoutSec };
}

function hasGrokCreds(): boolean {
	return Boolean(process.env.GROK_CLI_OAUTH_TOKEN?.trim());
}

function hasBaselineCreds(): boolean {
	return Boolean(
		process.env.OPENAI_CODEX_OAUTH_TOKEN?.trim() ||
			process.env.CODEX_OAUTH_TOKEN?.trim() ||
			process.env.OPENAI_OAUTH_TOKEN?.trim() ||
			process.env.OPENAI_API_KEY?.trim(),
	);
}

function buildMatrix(args: CaptureArgs): PlannedRow[] {
	const scenarios = args.scenarioFilter
		? COMPOSER_SCENARIOS.filter(s => args.scenarioFilter!.has(s.id))
		: COMPOSER_SCENARIOS;
	const planned: PlannedRow[] = [];
	let trial = 0;
	for (const scenario of scenarios) {
		for (let t = 0; t < args.k; t++) {
			planned.push({
				scenarioId: scenario.id,
				role: "candidate",
				model: args.candidateModel,
				trial: trial++,
				userPrompt: scenario.userPrompt,
			});
			planned.push({
				scenarioId: scenario.id,
				role: "baseline",
				model: args.baselineModel,
				trial: trial++,
				userPrompt: scenario.userPrompt,
			});
		}
	}
	return planned;
}

function slugModel(model: string): string {
	return model.replace(/[/:]/g, "_");
}

const STDERR_CAPTURE_MAX = 64 * 1024;

function sha256Text(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function assertPublishSafeArtifact(name: string, text: string): void {
	const lint = scanTextForPublishSecrets(text);
	if (!lint.ok) {
		throw new Error(`${name} linter failed: ${lint.findings.join(", ")}`);
	}
}

async function runGjcPrint(input: {
	gjcBin: string;
	cwd: string;
	model: string;
	prompt: string;
	sessionDir: string;
	timeoutSec: number;
}): Promise<{ exitCode: number; stderr: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; stderr: string }>();
	const child = spawn(
		input.gjcBin,
		["-p", "--mode", "json", "--model", input.model, "--session-dir", input.sessionDir, input.prompt],
		{
			cwd: input.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stdout?.on("data", () => {
		// discard JSONL stream; session jsonl on disk is the source of truth
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < STDERR_CAPTURE_MAX) {
			stderr += chunk.toString("utf8").slice(0, STDERR_CAPTURE_MAX - stderr.length);
		}
	});
	const timer = setTimeout(() => {
		child.kill("SIGTERM");
	}, input.timeoutSec * 1000);
	child.on("error", err => {
		clearTimeout(timer);
		reject(err);
	});
	child.on("close", code => {
		clearTimeout(timer);
		resolve({ exitCode: code ?? 1, stderr });
	});
	return promise;
}

function countToolsFromSession(lines: SessionJsonLine[]): {
	toolCount: number;
	toolErrorCount: number;
} {
	let toolCount = 0;
	let toolErrorCount = 0;
	for (const line of lines) {
		if (line.type !== "message") continue;
		const message = line.message as Record<string, unknown> | undefined;
		if (message?.role === "toolResult") {
			toolCount++;
			if (message.isError === true) toolErrorCount++;
		}
	}
	return { toolCount, toolErrorCount };
}

async function extractFinalTextFromSession(sessionFile: string | undefined): Promise<string> {
	if (!sessionFile) return "";
	const lines = await readSessionJsonl(sessionFile);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (line.type !== "message") continue;
		const message = line.message as Record<string, unknown> | undefined;
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
				const text = (part as Record<string, unknown>).text;
				if (typeof text === "string" && text.trim()) return text.trim();
			}
		}
	}
	return "";
}

async function executeRow(
	args: CaptureArgs,
	row: PlannedRow,
	outDir: string,
	tracePath: string,
	index: number,
): Promise<{ run: RunResult; record: TraceRecord }> {
	const scenario = SCENARIO_BY_ID.get(row.scenarioId);
	if (!scenario) throw new Error(`unknown scenario ${row.scenarioId}`);
	const workSlug = `${index}-${row.role}-${row.scenarioId}-${slugModel(row.model)}`;
	const workdir = path.join(outDir, "work", workSlug);
	const sessionDir = path.join(outDir, "sessions", workSlug);
	await fs.mkdir(workdir, { recursive: true });
	await fs.mkdir(sessionDir, { recursive: true });
	await seedScenarioWorkdir(workdir, row.scenarioId);

	const { exitCode, stderr } = await runGjcPrint({
		gjcBin: args.gjcBin,
		cwd: workdir,
		model: row.model,
		prompt: row.userPrompt,
		sessionDir,
		timeoutSec: args.timeoutSec,
	});

	const sessionFile = await findLatestSessionFile(sessionDir);
	let events: TraceEvent[] = [];
	let toolCount = 0;
	let toolErrorCount = 0;
	if (sessionFile) {
		const lines = await readSessionJsonl(sessionFile);
		events = sessionLinesToTraceEvents(lines, exitCode);
		const counts = countToolsFromSession(lines);
		toolCount = counts.toolCount;
		toolErrorCount = counts.toolErrorCount;
	} else {
		events = [{ type: "scenario_result", status: "failed", message: "missing session jsonl" }];
	}

	const record = buildTraceRecord({
		scenarioId: row.scenarioId,
		modelRole: row.role,
		model: row.model,
		trial: row.trial,
		events,
		tracePath: path.relative(outDir, tracePath),
		expected: traceExpectationForScenario(row.scenarioId),
	});

	const finalText = await extractFinalTextFromSession(sessionFile);
	const run: RunResult = {
		role: row.role,
		model: row.model,
		scenarioId: row.scenarioId,
		artifactSlug: workSlug,
		hasSessionFile: sessionFile !== undefined,
		exitCode,
		stderrByteLength: Buffer.byteLength(stderr, "utf8"),
		stderrSha256: stderr.length > 0 ? sha256Text(stderr) : undefined,
		finalTextByteLength: Buffer.byteLength(finalText, "utf8"),
		finalTextSha256: finalText.length > 0 ? sha256Text(finalText) : undefined,
		toolCount,
		toolErrorCount,
	};
	return { run, record };
}


async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const planned = buildMatrix(args);
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir =
		args.out ?? path.join(REPO_ROOT, ".gjc/ultragoal/artifacts", `composer-evidence-${runId}`);
	const tracePath = path.join(outDir, "traces", "real-gjc-print-traces.json");

	const payload = {
		schemaVersion: 1,
		composer_scenarios_version: COMPOSER_SCENARIOS_VERSION,
		scenario_count: TOTAL_SCENARIO_COUNT,
		planned_records: planned.length,
		k: args.k,
		capture_mode: "print",
		candidate_model: args.candidateModel,
		baseline_model: args.baselineModel,
		dry_run: args.dryRun,
		credentials: {
			grok: hasGrokCreds(),
			baseline: hasBaselineCreds(),
		},
		repoRootArtifact: path.basename(REPO_ROOT),
		gjc_bin_basename: path.basename(args.gjcBin),
		planned,
	};

	if (args.dryRun) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	if (!args.skipCredCheck && (!hasGrokCreds() || !hasBaselineCreds())) {
		process.stderr.write(
			"capture-composer-v3-live: missing GROK_CLI_OAUTH_TOKEN and/or OpenAI/Codex credentials; use --dry-run or set env\n",
		);
		process.exit(2);
	}

	await fs.mkdir(path.dirname(tracePath), { recursive: true });
	const results: RunResult[] = [];
	const records: TraceRecord[] = [];

	for (let i = 0; i < planned.length; i++) {
		const row = planned[i]!;
		process.stderr.write(`capture: ${row.scenarioId} ${row.role} trial=${row.trial}\n`);
		const { run, record } = await executeRow(args, row, outDir, tracePath, i);
		results.push(run);
		records.push(record);
	}

	const traceArtifact = {
		schemaVersion: 1,
		runId,
		generatedAt: new Date().toISOString(),
		records,
	};
	const traceText = `${JSON.stringify(traceArtifact, null, 2)}\n`;
	assertPublishSafeArtifact("trace artifact", traceText);

	const summary = {
		schemaVersion: 1,
		runId,
		traceArtifact: path.relative(outDir, tracePath),
		results,
	};
	const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
	assertPublishSafeArtifact("summary artifact", summaryText);

	const manifestText = `${JSON.stringify(
		{
			schemaVersion: 1,
			runId,
			traceArtifact: path.relative(outDir, tracePath),
			summaryArtifact: "summary.json",
			composer_scenarios_version: COMPOSER_SCENARIOS_VERSION,
			planned_records: planned.length,
			captured_records: records.length,
			record_count: records.length,
			capture_mode: "print",
			k: args.k,
			candidate_model: args.candidateModel,
			baseline_model: args.baselineModel,
			gjc_bin_basename: path.basename(args.gjcBin),
			trace_sha256: sha256Text(traceText),
		},
		null,
		2,
	)}\n`;
	assertPublishSafeArtifact("provenance manifest", manifestText);

	await fs.writeFile(tracePath, traceText, "utf8");
	const summaryPath = path.join(outDir, "summary.json");
	await fs.writeFile(summaryPath, summaryText, "utf8");
	const manifestPath = path.join(outDir, "provenance-manifest.json");
	await fs.writeFile(manifestPath, manifestText, "utf8");

	process.stdout.write(
		`${JSON.stringify(
			{
				ok: true,
				outputArtifact: path.basename(outDir),
				traceArtifact: path.relative(outDir, tracePath),
				summaryArtifact: "summary.json",
				manifestArtifact: "provenance-manifest.json",
				planned_records: planned.length,
				captured_records: records.length,
			},
			null,
			2,
		)}\n`,
	);
}

if (import.meta.main) {
	await main();
}