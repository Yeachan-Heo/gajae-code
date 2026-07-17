#!/usr/bin/env bun
/**
 * Edit benchmark CLI entry point.
 *
 * Usage:
 *   bun run bench:edit --model anthropic/Anthropic model-sonnet-4-5
 *   bun run bench:edit --tasks core-memory-recall,operations-division
 *   bun run bench:edit --runs 5 --output report.md
 *   bun run bench:edit --fixtures fixtures.tar.gz
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type ResolvedThinkingLevel, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, THINKING_EFFORTS } from "@gajae-code/ai";
import { padding, visibleWidth } from "@gajae-code/tui";
import { postmortem, TempDir } from "@gajae-code/utils";
import { generateJsonReport, generateReport } from "./report";
import {
	type BenchmarkConfig,
	type BenchmarkResult,
	buildBenchmarkResult,
	type ProgressEvent,
	runBenchmark,
} from "./runner";
import { type EditTask, loadTasksFromDir, validateFixturesFromDir } from "./tasks";

const COLOR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const BENCHMARK_THINKING_LEVELS = new Set<string>([ThinkingLevel.Off, ...THINKING_EFFORTS]);

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
} as const;

const RUNS_DIR = path.resolve(import.meta.dir, "..", "..", "..", "runs");

fs.mkdirSync(RUNS_DIR, { recursive: true });

function paint(code: string, text: string): string {
	return COLOR_ENABLED ? `${code}${text}${ANSI.reset}` : text;
}

function rateColor(percent: number): string {
	if (percent >= 80) return ANSI.green;
	if (percent >= 50) return ANSI.yellow;
	return ANSI.red;
}

function parseThinkingLevel(value: string | null | undefined): ResolvedThinkingLevel | undefined {
	return value !== undefined && value !== null && BENCHMARK_THINKING_LEVELS.has(value)
		? (value as ResolvedThinkingLevel)
		: undefined;
}

function generateReportFilename(config: BenchmarkConfig, format: "markdown" | "json"): string {
	const modelName = config.model
		.split("/")
		.pop()!
		.replace(/[^a-zA-Z0-9-]/g, "_");
	const variant = config.editVariant ?? "replace";
	const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "").replace(/Z$/, "Z");
	const ext = format === "json" ? "json" : "md";
	return path.join(RUNS_DIR, `${modelName}_${variant}_${timestamp}.${ext}`);
}

async function resolveConversationDumpDir(outputPath: string): Promise<string> {
	const parsed = path.parse(outputPath);
	const preferredPath = path.join(parsed.dir, `${parsed.name}.dump`);
	try {
		await fs.promises.stat(preferredPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return preferredPath;
		}
		throw error;
	}
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(parsed.dir, `${parsed.name}.${timestamp}.dump`);
}

async function conversationDumpStatus(dumpDir: string): Promise<string> {
	try {
		const stat = await fs.promises.stat(dumpDir);
		if (stat.isDirectory()) {
			return `Conversation dumps written to: ${dumpDir}`;
		}
		return `Conversation dump path is not a directory: ${dumpDir}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return `No conversation dumps written: ${dumpDir}`;
		}
		throw error;
	}
}

function printUsage(tasks?: EditTask[]): void {
	const taskList = tasks
		? tasks.map(t => `  ${t.id.padEnd(30)} ${t.name}`).join("\n")
		: "  (use --list to see available tasks)";
	console.log(`
Edit Benchmark - Evaluate patch application success rates

Usage:
  bun run bench:edit [options]

Options:
  --model <id>              Provider/model ID, e.g. anthropic/claude-sonnet-4-20250514 (default)
  --provider <id>           Override provider (auto-detected from model prefix if omitted)
  --thinking <level>        Thinking level: off, minimal, low, medium, high, xhigh
  --runs <n>                Runs per task (default: 1)
  --timeout <ms>            Timeout per run in ms (default: 120000)
  --connection-timeout <ms>  Timeout for first event before fast-retry (default: 30000)
  --task-concurrency <n>    Max tasks to run in parallel (default: 16)
  --tasks <ids>             Comma-separated task IDs to run (default: all)
  --max-tasks <n>            Max tasks to sample (default: 80, 0 = all)
  --fixtures <path>         Fixtures directory or .tar.gz archive (default: built-in)
  --edit-variant <v>        Edit variant: any string (e.g. replace, patch, hashline, vim, atom, apply_patch), or auto (default: auto)
  --edit-fuzzy <bool>       Fuzzy matching: true, false, auto (default: auto)
  --edit-fuzzy-threshold <n> Fuzzy threshold 0-1 or auto (default: auto)
  --auto-format             Auto-format output files after verify (debug only)
  --guided                  Include an authoritative suggested edit payload (default: false)
  --no-guided               Disable guided mode
  --max-attempts <n>        Max prompt attempts per run (default: 1)
  --no-op-retry-limit <n>   Stop after repeated preventable no-op failures (default: 2)
  --mutation-scope-window <n> Allowed line-distance from mutation target for hashline refs (default: 20)
  --max-turns <n>           Max turn_start events per attempt before failing (default: 30)
  --output <file>           Output file (default: run_<model>_<variant>_<fuzzy>_<threshold>_<timestamp>.md)
  --format <fmt>            Output format: markdown, json (default: markdown)
  --check-fixtures          Validate fixtures and exit
  --require-edit-tool-call  Require edit tool usage for success (default: false)
  --require-read-tool-call  Require read tool usage for success (default: false)
  --no-edit-required        Remove "must edit" prompt requirement (default: false)
  --no-early-stop-on-match  Don't short-circuit the run when output matches expected (default: false)
  --list                    List available tasks and exit
  --help                    Show this help message

Available Tasks:
${taskList}

Examples:
  # Run full benchmark with default model
  bun run bench:edit

  # Run specific tasks
  bun run bench:edit --tasks core-memory-recall,operations-division

  # Compare different models
  bun run bench:edit --model claude-sonnet-4-20250514 --output sonnet.md
  bun run bench:edit --model claude-opus-4-5-20251101 --output opus.md

  # Run with extended thinking
  bun run bench:edit --thinking high --runs 5

  # Run from a fixtures archive
  bun run bench:edit --fixtures edit-fixtures.tar.gz
`);
}

async function resolveExtractedDir(tempDir: string): Promise<string> {
	const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
	const dirs = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	if (dirs.length === 1 && files.length === 0) {
		return path.join(tempDir, dirs[0]!.name);
	}
	return tempDir;
}

async function extractTarGz(archivePath: string): Promise<{ dir: string; cleanupDir: string }> {
	const tempDirObj = await TempDir.create("@reach-benchmark-fixtures-");
	const tempDir = tempDirObj.path();
	try {
		const bytes = await Bun.file(archivePath).arrayBuffer();
		const archive = new Bun.Archive(bytes);
		const files = await archive.files();

		for (const [filePath, file] of files) {
			const destPath = path.join(tempDir, filePath);
			await Bun.write(destPath, file);
		}
	} catch (error) {
		await tempDirObj.remove();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to extract archive: ${message}`, { cause: error });
	}

	return { dir: await resolveExtractedDir(tempDir), cleanupDir: tempDir };
}

async function resolveFixtures(fixturesArg?: string): Promise<{ tasks: EditTask[]; cleanup?: () => Promise<void> }> {
	fixturesArg ??= path.join(import.meta.dir, "../fixtures.tar.gz");

	if (fixturesArg.endsWith(".tar.gz") || fixturesArg.endsWith(".tgz")) {
		const extracted = await extractTarGz(fixturesArg);
		return {
			tasks: await loadTasksFromDir(extracted.dir),
			cleanup: () => fs.promises.rm(extracted.cleanupDir, { recursive: true, force: true }),
		};
	}

	return { tasks: await loadTasksFromDir(fixturesArg) };
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			provider: { type: "string" },
			model: { type: "string", default: "anthropic/claude-sonnet-4-20250514" },
			thinking: { type: "string", default: "low" },
			runs: { type: "string", default: "2" },
			timeout: { type: "string", default: "120000" },
			"connection-timeout": { type: "string", default: "30000" },
			"max-turns": { type: "string", default: "30" },
			"task-concurrency": { type: "string", default: "32" },
			tasks: { type: "string" },
			fixtures: { type: "string" },
			output: { type: "string" },
			format: { type: "string", default: "markdown" },
			"check-fixtures": { type: "boolean", default: false },
			"auto-format": { type: "boolean", default: false },
			guided: { type: "boolean", default: false },
			"no-guided": { type: "boolean", default: false },
			"max-attempts": { type: "string", default: "1" },
			"no-op-retry-limit": { type: "string", default: "2" },
			"max-timeout-retries": { type: "string", default: "3" },
			"max-provider-retries": { type: "string", default: "3" },
			"mutation-scope-window": { type: "string", default: "20" },
			"require-edit-tool-call": { type: "boolean", default: false },
			"require-read-tool-call": { type: "boolean", default: false },
			"no-edit-required": { type: "boolean", default: false },
			"edit-variant": { type: "string" },
			"edit-fuzzy": { type: "string" },
			"edit-fuzzy-threshold": { type: "string" },
			"no-in-process": { type: "boolean", default: false },
			"no-early-stop-on-match": { type: "boolean", default: false },
			"max-tasks": { type: "string", default: "80" },
			list: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	// Extract provider for display/config purposes only.
	// The full model string (e.g. "openrouter/google/gemini-2.5-flash-lite") is passed
	// as --model to the CLI, which handles resolution via parseModelPattern.
	const model = values.model!;
	const slashIndex = model.indexOf("/");
	const provider = values.provider ?? (slashIndex !== -1 ? model.slice(0, slashIndex) : "anthropic");

	if (values.help) {
		printUsage();
		process.exit(0);
	}

	if (values["check-fixtures"] && values.fixtures) {
		const issues = await validateFixturesFromDir(values.fixtures);
		if (issues.length === 0) {
			console.log("Fixtures OK");
			process.exit(0);
		}
		console.error("Fixture validation failed:");
		for (const issue of issues) {
			console.error(`  - ${issue.taskId}: ${issue.message}`);
		}
		process.exit(1);
	}

	const { tasks: allTasks, cleanup } = await resolveFixtures(values.fixtures);

	if (values.list) {
		console.log("Available Tasks:\n");
		for (const task of allTasks) {
			console.log(`  ${task.id}`);
			console.log(`    Name: ${task.name}`);
			console.log(`    Files: ${task.files.join(", ")}`);
			console.log("");
		}
		process.exit(0);
	}

	let thinkingLevel: ResolvedThinkingLevel = Effort.Low;
	if (values.thinking) {
		const level = parseThinkingLevel(values.thinking);
		if (!level) {
			console.error(`Invalid thinking level: ${values.thinking}`);
			console.error(`Valid levels: ${[ThinkingLevel.Off, ...THINKING_EFFORTS].join(", ")}`);
			process.exit(1);
		}
		thinkingLevel = level;
	}

	const runsPerTask = parseInt(values.runs!, 10);
	if (Number.isNaN(runsPerTask) || runsPerTask < 1) {
		console.error(`Invalid runs value: ${values.runs}`);
		process.exit(1);
	}

	const timeout = parseInt(values.timeout!, 10);
	if (Number.isNaN(timeout) || timeout < 1000) {
		console.error(`Invalid timeout value: ${values.timeout}`);
		process.exit(1);
	}

	const maxTurns = parseInt(values["max-turns"]!, 10);
	if (Number.isNaN(maxTurns) || maxTurns < 1) {
		console.error(`Invalid max-turns value: ${values["max-turns"]}. Must be >= 1.`);
		process.exit(1);
	}

	const taskConcurrency = parseInt(values["task-concurrency"]!, 10);
	if (Number.isNaN(taskConcurrency) || taskConcurrency < 1) {
		console.error(`Invalid task concurrency value: ${values["task-concurrency"]}`);
		process.exit(1);
	}

	const maxAttempts = parseInt(values["max-attempts"] ?? "2", 10);
	if (Number.isNaN(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
		console.error(`Invalid max-attempts value: ${values["max-attempts"]}. Must be 1-5.`);
		process.exit(1);
	}

	const noOpRetryLimit = parseInt(values["no-op-retry-limit"] ?? "2", 10);
	const maxTimeoutRetries = parseInt(values["max-timeout-retries"] ?? "3", 10);
	const maxProviderRetries = parseInt(values["max-provider-retries"] ?? "3", 10);
	const mutationScopeWindow = parseInt(values["mutation-scope-window"] ?? "20", 10);
	const connectionTimeout = parseInt(values["connection-timeout"] ?? "30000", 10);

	let tasksToRun = allTasks;
	if (values.tasks) {
		const taskIds = values.tasks.split(",").map(s => s.trim());
		tasksToRun = [];
		for (const id of taskIds) {
			const task = allTasks.find(t => t.id === id);
			if (!task) {
				console.error(`Unknown task ID: ${id}`);
				console.error(`Available tasks: ${allTasks.map(t => t.id).join(", ")}`);
				process.exit(1);
			}
			tasksToRun.push(task);
		}
	}

	// Apply --max-tasks sampling (deterministic by sorting on id)
	const maxTasks = parseInt(values["max-tasks"] ?? "80", 10);
	if (maxTasks > 0 && tasksToRun.length > maxTasks && !values.tasks) {
		// Evenly sample across mutation categories for representative coverage
		const sorted = tasksToRun.slice().sort((a, b) => a.id.localeCompare(b.id));
		const step = sorted.length / maxTasks;
		tasksToRun = Array.from({ length: maxTasks }, (_, i) => sorted[Math.floor(i * step)]!);
	}

	const rawEditVariant = values["edit-variant"] as string | undefined;
	const editVariant = rawEditVariant === "" ? undefined : rawEditVariant;

	let editFuzzy: boolean | "auto" | undefined;
	if (values["edit-fuzzy"] !== undefined) {
		if (values["edit-fuzzy"] === "auto") {
			editFuzzy = "auto";
		} else if (values["edit-fuzzy"] === "true" || values["edit-fuzzy"] === "1") {
			editFuzzy = true;
		} else if (values["edit-fuzzy"] === "false" || values["edit-fuzzy"] === "0") {
			editFuzzy = false;
		} else {
			console.error(`Invalid edit-fuzzy: ${values["edit-fuzzy"]}. Must be true, false, 1, 0, or auto.`);
			process.exit(1);
		}
	}

	let editFuzzyThreshold: number | "auto" | undefined;
	if (values["edit-fuzzy-threshold"] !== undefined) {
		if (values["edit-fuzzy-threshold"] === "auto") {
			editFuzzyThreshold = "auto";
		} else {
			const parsed = parseFloat(values["edit-fuzzy-threshold"]);
			if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
				console.error(`Invalid edit-fuzzy-threshold: ${values["edit-fuzzy-threshold"]}. Must be 0-1 or auto.`);
				process.exit(1);
			}
			editFuzzyThreshold = parsed;
		}
	}

	const guided = values["no-guided"] ? false : values.guided;

	const formatType = values.format === "json" ? "json" : "markdown";
	const config: BenchmarkConfig = {
		provider,
		model,
		thinkingLevel,
		runsPerTask,
		timeout,
		maxTurns,
		taskConcurrency,
		autoFormat: values["auto-format"],
		guided,
		maxAttempts,
		requireEditToolCall: values["require-edit-tool-call"],
		requireReadToolCall: values["require-read-tool-call"],
		noEditRequired: values["no-edit-required"],
		editVariant,
		editFuzzy,
		editFuzzyThreshold,
		noOpRetryLimit,
		maxTimeoutRetries,
		maxProviderFailureRetries: maxProviderRetries,
		mutationScopeWindow,
		connectionTimeout,
		inProcess: !values["no-in-process"],
		earlyStopOnMatch: !values["no-early-stop-on-match"],
	};
	const outputPath = values.output ?? generateReportFilename(config, formatType);
	config.conversationDumpDir = await resolveConversationDumpDir(outputPath);

	console.log("Edit Benchmark");
	console.log("==============");
	console.log(`Provider: ${config.provider}`);
	console.log(`Model: ${config.model}`);
	if (config.thinkingLevel) {
		console.log(`Thinking: ${config.thinkingLevel}`);
	}
	console.log(`Runs per task: ${config.runsPerTask}`);
	console.log(`Timeout: ${config.timeout}ms`);
	console.log(`Task concurrency: ${config.taskConcurrency}`);
	if (config.autoFormat) {
		console.log("Auto-format: enabled");
	}
	console.log(`Guided mode: ${config.guided ? "enabled" : "disabled"}`);
	console.log(`Max attempts: ${config.maxAttempts}`);
	if (config.maxTurns !== undefined) {
		console.log(`Max turns per attempt: ${config.maxTurns}`);
	}
	if (config.requireEditToolCall) {
		console.log("Require edit tool call: yes");
	}
	if (config.requireReadToolCall) {
		console.log("Require read tool call: yes");
	}
	if (config.noEditRequired) {
		console.log("No-edit-required baseline: yes");
	}
	if (config.editVariant) {
		console.log(`Edit variant: ${config.editVariant}`);
	}
	if (config.editFuzzy !== undefined) {
		console.log(`Edit fuzzy: ${config.editFuzzy}`);
	}
	if (config.editFuzzyThreshold !== undefined) {
		console.log(`Edit fuzzy threshold: ${config.editFuzzyThreshold}`);
	}
	console.log(`Tasks: ${tasksToRun.length}`);
	console.log(`Conversation dumps: ${config.conversationDumpDir}`);
	console.log("");

	const progress = new LiveProgress(tasksToRun.length * config.runsPerTask, config.runsPerTask);
	let latestResult = buildBenchmarkResult({
		tasks: tasksToRun,
		config,
		resultsByTask: new Map(),
		startTime: new Date().toISOString(),
	});
	let progressFinished = false;
	let reportWritePromise: Promise<void> | undefined;
	const finishProgress = () => {
		if (progressFinished) return;
		progress.finish();
		progressFinished = true;
	};
	const writeReport = async (result: BenchmarkResult, interrupted: boolean) => {
		if (reportWritePromise) return reportWritePromise;
		reportWritePromise = (async () => {
			if (interrupted) {
				console.log("");
				console.log("Benchmark interrupted; writing partial report...");
			}
			const report = formatType === "json" ? generateJsonReport(result) : generateReport(result);
			await Bun.write(outputPath, report);
			console.log(`Report written to: ${outputPath}`);
			if (config.conversationDumpDir) {
				console.log(await conversationDumpStatus(config.conversationDumpDir));
			}
		})();
		return reportWritePromise;
	};
	const unregisterReportCleanup = postmortem.register("typescript-edit-benchmark-report", async reason => {
		if (reason === postmortem.Reason.EXIT) return;
		finishProgress();
		await writeReport(latestResult, true);
		if (cleanup) {
			await cleanup();
		}
	});
	const result = await runBenchmark(
		tasksToRun,
		config,
		event => {
			progress.handleEvent(event);
		},
		snapshot => {
			latestResult = snapshot;
		},
	);
	latestResult = result;
	finishProgress();

	console.log("");
	console.log("Benchmark complete!");
	console.log(`  Success rate: ${(result.summary.overallSuccessRate * 100).toFixed(1)}%`);
	console.log(`  Total tokens: ${result.summary.totalTokens.input} in / ${result.summary.totalTokens.output} out`);
	if (result.summary.ghostRuns > 0) {
		console.log(`  Ghost runs (0/0/0): ${result.summary.ghostRuns}`);
	}
	if (result.summary.timeoutRuns > 0) {
		console.log(`  Timeout runs: ${result.summary.timeoutRuns}`);
	}
	console.log("");

	await writeReport(result, false);
	unregisterReportCleanup();

	if (cleanup) {
		await cleanup();
	}
}

class LiveProgress {
	readonly #totalRuns: number;
	readonly #runsPerTask: number;
	readonly #isTty: boolean;
	#started = 0;
	#completed = 0;
	#success = 0;
	#totalInput = 0;
	#totalOutput = 0;
	#totalDuration = 0;
	#totalReads = 0;
	#totalEdits = 0;
	#totalWrites = 0;
	#totalEditSuccesses = 0;
	#totalToolInputChars = 0;
	#indentScores: number[] = [];
	#lastLineLength = 0;

	constructor(totalRuns: number, runsPerTask: number) {
		this.#totalRuns = totalRuns;
		this.#runsPerTask = runsPerTask;
		this.#isTty = Boolean(process.stdout.isTTY);
	}

	handleEvent(event: ProgressEvent): void {
		if (event.status === "started") {
			this.#started += 1;
			if (!this.#isTty) {
				console.log(`  [${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} started...`);
			}
			this.#renderLine();
			return;
		}

		this.#completed += 1;
		if (event.result) {
			if (event.result.success) {
				this.#success += 1;
			}
			this.#totalInput += event.result.tokens.input;
			this.#totalOutput += event.result.tokens.output;
			this.#totalDuration += event.result.duration;
			this.#totalReads += event.result.toolCalls.read;
			this.#totalEdits += event.result.toolCalls.edit;
			this.#totalWrites += event.result.toolCalls.write;
			this.#totalEditSuccesses += event.result.toolCalls.editSuccesses;
			this.#totalToolInputChars += event.result.toolCalls.totalInputChars;
			if (typeof event.result.indentScore === "number") {
				this.#indentScores.push(event.result.indentScore);
			}
		}

		const result = event.result;
		if (result && !result.success && result.error) {
			this.#flushLine();
			const header = paint(ANSI.red, `[${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} failed:`);
			console.log(`  ${header} ${result.error}`);
			if (result.diff) {
				const changeLines = result.diff
					.split("\n")
					.filter(line => /^[-+@]/.test(line) && !/^(---|\+\+\+)/.test(line));
				const maxLines = 40;
				const shown = changeLines.slice(0, maxLines);
				for (const line of shown) {
					let color: string | undefined;
					if (line.startsWith("@@")) color = ANSI.cyan;
					else if (line.startsWith("-")) color = ANSI.red;
					else if (line.startsWith("+")) color = ANSI.green;
					console.log(`    ${color ? paint(color, line) : line}`);
				}
				if (changeLines.length > maxLines) {
					console.log(paint(ANSI.dim, `    ... (${changeLines.length - maxLines} more change lines)`));
				}
			}
		}

		if (result?.editFailures && result.editFailures.length > 0) {
			this.#flushLine();
			for (const [i, failure] of result.editFailures.entries()) {
				const args = (failure.args ?? {}) as Record<string, unknown>;
				const target =
					typeof args.path === "string" ? args.path : typeof args.file === "string" ? args.file : undefined;
				const op = typeof args.operation === "string" ? args.operation : undefined;
				const oneLine = failure.error.replace(/\s+/g, " ").trim();
				const clipped = oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
				const tag = paint(ANSI.yellow, `[${event.taskId}] schema #${i + 1}`);
				const metaParts = [op, target].filter((v): v is string => Boolean(v));
				const meta = metaParts.length > 0 ? paint(ANSI.dim, metaParts.join(" ")) : "";
				console.log(`  ${tag}${meta ? ` ${meta}` : ""} ${clipped}`);
			}
		}

		if (!this.#isTty) {
			const status = event.result?.success ? "completed" : "failed";
			console.log(`  [${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} ${status}`);
		}

		this.#renderLine();
	}

	finish(): void {
		this.#flushLine();
		this.#printSummary();
	}

	#printSummary(): void {
		const n = this.#completed;
		const denom = n || 1;

		const successRate = (this.#success / denom) * 100;
		const editSuccessRate = this.#totalEdits > 0 ? (this.#totalEditSuccesses / this.#totalEdits) * 100 : 100;
		const avgIndent =
			this.#indentScores.length > 0 ? this.#indentScores.reduce((a, b) => a + b, 0) / this.#indentScores.length : 0;

		console.log("");
		console.log(paint(ANSI.bold, "Runtime Stats:"));
		console.log(
			`  Task success:     ${paint(rateColor(successRate), `${successRate.toFixed(1)}% (${this.#success}/${n})`)}`,
		);
		console.log(
			`  Edit success:     ${paint(rateColor(editSuccessRate), `${editSuccessRate.toFixed(1)}% (${this.#totalEditSuccesses}/${this.#totalEdits})`)}`,
		);
		console.log(`  Avg indent score: ${avgIndent.toFixed(2)}`);
		console.log(`  Tool calls:       read=${this.#totalReads} edit=${this.#totalEdits} write=${this.#totalWrites}`);
		console.log(`  Tool input chars: ${this.#totalToolInputChars.toLocaleString()}`);
		console.log(
			`  Avg tokens/task:  ${Math.round(this.#totalInput / denom)} in / ${Math.round(this.#totalOutput / denom)} out`,
		);
		console.log(`  Avg time/task:    ${Math.round(this.#totalDuration / denom)}ms`);
	}

	#renderLine(): void {
		if (!this.#isTty) {
			return;
		}
		const successRate = this.#completed > 0 ? (this.#success / this.#completed) * 100 : 0;
		const editRate = this.#totalEdits > 0 ? (this.#totalEditSuccesses / this.#totalEdits) * 100 : 100;
		const avgInput = this.#completed > 0 ? Math.round(this.#totalInput / this.#completed) : 0;
		const avgOutput = this.#completed > 0 ? Math.round(this.#totalOutput / this.#completed) : 0;
		const avgDuration = this.#completed > 0 ? Math.round(this.#totalDuration / this.#completed) : 0;
		const inFlight = this.#started - this.#completed;
		const bar = this.#renderBar(this.#completed, this.#totalRuns, 20);
		const progress = paint(ANSI.bold, `${this.#completed}/${this.#totalRuns}`);
		const taskCol = `task=${paint(rateColor(successRate), `${successRate.toFixed(0)}%`)}`;
		const editCol = `edit=${paint(rateColor(editRate), `${editRate.toFixed(0)}%`)}`;
		const tokCol = paint(ANSI.dim, `tok=${avgInput}/${avgOutput}`);
		const durCol = paint(ANSI.dim, `${avgDuration}ms`);
		const rewCol = paint(ANSI.dim, `r/e/w=${this.#totalReads}/${this.#totalEdits}/${this.#totalWrites}`);
		const flyCol = `fly=${paint(ANSI.cyan, String(inFlight))}`;
		const line = `  ${bar} ${progress} ${taskCol} ${editCol} ${tokCol} ${durCol} ${rewCol} ${flyCol}`;
		this.#writeLine(line);
	}

	#renderBar(done: number, total: number, width: number): string {
		const ratio = total === 0 ? 0 : done / total;
		const filled = Math.round(ratio * width);
		const empty = Math.max(0, width - filled);
		const filledPart = paint(ANSI.green, "#".repeat(filled));
		const emptyPart = paint(ANSI.dim, "-".repeat(empty));
		return `[${filledPart}${emptyPart}]`;
	}

	#writeLine(line: string): void {
		const lineWidth = visibleWidth(line);
		const pad = this.#lastLineLength > lineWidth ? padding(this.#lastLineLength - lineWidth) : "";
		process.stdout.write(`\r${line}${pad}`);
		this.#lastLineLength = lineWidth;
	}

	#flushLine(): void {
		if (!this.#isTty) {
			return;
		}
		if (this.#lastLineLength > 0) {
			process.stdout.write(`\r${padding(this.#lastLineLength)}\r`);
			this.#lastLineLength = 0;
		}
	}
}

main().catch(err => {
	console.error("Benchmark failed:", err);
	process.exit(1);
});
