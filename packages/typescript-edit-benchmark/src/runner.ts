/**
 * Edit benchmark runner.
 *
 * Orchestrates benchmark runs by launching RPC clients, sending prompts,
 * and verifying results. Supports parallel runs for reliability measurement.
 */
/// <reference types="./bun-imports.d.ts" />
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { computeLineHash, formatSessionDumpText } from "@gajae-code/coding-agent";
import { prompt } from "@gajae-code/utils";
import { diffLines } from "diff";
import { formatDirectory } from "./formatter";
import { discoverSharedInfra, InProcessClient, type SharedInfra } from "./in-process-client";
import benchmarkRetryPrompt from "./prompts/benchmark-retry.md" with { type: "text" };
import benchmarkSystemPrompt from "./prompts/benchmark-system.md" with { type: "text" };
import benchmarkTaskPrompt from "./prompts/benchmark-task.md" with { type: "text" };
import type { EditTask } from "./tasks";
import { verifyExpectedFileSubset, verifyExpectedFiles } from "./verify";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "runs");
const TMP = path.join(RUNS_DIR, `rb-${Math.random().toString(36).slice(2, 10)}`);

function formatLogPath(logFile: string): string {
	const relativePath = path.relative(REPO_ROOT, logFile);
	return relativePath === "" ? "." : relativePath;
}

/** Subset of session state used for markdown conversation dumps (parity with /dump). */
type ConversationDumpSessionState = {
	sessionFile?: string;
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel | undefined;
	dumpTools?: Array<{ name: string; description: string; parameters: unknown }>;
};

/** Common interface for both RPC and in-process clients */
interface BenchmarkClient {
	start(): Promise<void>;
	setThinkingLevel(level: import("@gajae-code/agent-core").ResolvedThinkingLevel): Promise<void>;
	onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
	prompt(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	getSessionStats(): Promise<{
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		assistantMessages: number;
	}>;
	getLastAssistantText(): Promise<string | null>;
	getMessages(): Promise<AgentMessage[]>;
	getState(): Promise<ConversationDumpSessionState>;
	abort?(): void;
	dispose(): Promise<void>;
}

fs.mkdirSync(TMP, { recursive: true });

let n = 0;
function subtmp(pre: string): string {
	const dir = path.join(TMP, `${pre}-${n++}`);
	fs.mkdirSync(dir);
	return dir;
}

export interface BenchmarkConfig {
	provider: string;
	model: string;
	thinkingLevel?: ResolvedThinkingLevel;
	runsPerTask: number;
	timeout: number;
	/** Timeout for the first event to arrive. If no events are observed within this window, abort early. Default: 30000 */
	connectionTimeout?: number;
	maxTurns?: number;
	taskConcurrency: number;
	requireEditToolCall?: boolean;
	requireReadToolCall?: boolean;
	noEditRequired?: boolean;
	autoFormat?: boolean;
	/** If true, abort the agent loop as soon as the formatted file content matches the expected fixture. Default: true. */
	earlyStopOnMatch?: boolean;
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
	guided?: boolean;
	maxAttempts?: number;
	noOpRetryLimit?: number;
	maxTimeoutRetries?: number;
	maxProviderFailureRetries?: number;
	mutationScopeWindow?: number;
	conversationDumpDir?: string;
	/** Use in-process agent sessions instead of spawning CLI subprocesses. Default: true */
	inProcess?: boolean;
}

type ConversationDumpSnapshot = {
	messages: AgentMessage[];
	sourceSessionFile?: string;
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel | undefined;
	dumpTools?: Array<{ name: string; description: string; parameters: unknown }>;
};

function sanitizeDumpPathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getConversationDumpPath(dumpDir: string, taskId: string, runIndex: number): string {
	return path.join(dumpDir, sanitizeDumpPathSegment(taskId), `run-${runIndex + 1}.md`);
}

/** Artifacts directory for a session dump file (.md or legacy .jsonl). */
function dumpArtifactsDir(dumpFilePath: string): string {
	if (dumpFilePath.endsWith(".md")) {
		return dumpFilePath.slice(0, -3);
	}
	if (dumpFilePath.endsWith(".jsonl")) {
		return dumpFilePath.slice(0, -6);
	}
	const ext = path.extname(dumpFilePath);
	return path.join(path.dirname(dumpFilePath), path.basename(dumpFilePath, ext));
}

async function copyConversationArtifacts(sourceSessionFile: string, targetDumpFile: string): Promise<void> {
	const sourceArtifactsDir = dumpArtifactsDir(sourceSessionFile);
	const targetArtifactsDir = dumpArtifactsDir(targetDumpFile);
	try {
		const stat = await fs.promises.stat(sourceArtifactsDir);
		if (!stat.isDirectory()) return;
		await fs.promises.cp(sourceArtifactsDir, targetArtifactsDir, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

export async function writeConversationDump(params: {
	dumpDir: string;
	taskId: string;
	runIndex: number;
	snapshot: ConversationDumpSnapshot;
}): Promise<string> {
	const dumpPath = getConversationDumpPath(params.dumpDir, params.taskId, params.runIndex);
	await fs.promises.mkdir(path.dirname(dumpPath), { recursive: true });
	const body = formatSessionDumpText({
		messages: params.snapshot.messages,
		systemPrompt: params.snapshot.systemPrompt,
		model: params.snapshot.model,
		thinkingLevel: params.snapshot.thinkingLevel,
		tools: params.snapshot.dumpTools,
	});
	await Bun.write(dumpPath, `${body}\n`);
	if (params.snapshot.sourceSessionFile) {
		await copyConversationArtifacts(params.snapshot.sourceSessionFile, dumpPath);
	}
	return dumpPath;
}

async function snapshotConversationDump(client: BenchmarkClient): Promise<ConversationDumpSnapshot> {
	const [messages, state] = await Promise.all([client.getMessages(), client.getState()]);
	return {
		messages,
		sourceSessionFile: state.sessionFile,
		systemPrompt: state.systemPrompt,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		dumpTools: state.dumpTools,
	};
}

function splitLines(value: string): string[] {
	return value.split("\n").filter((line, idx, arr) => idx < arr.length - 1 || line);
}

function getEditPathFromArgs(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const pathValue = (args as { path?: unknown }).path;
	return typeof pathValue === "string" && pathValue.length > 0 ? pathValue : null;
}

function getEditPayloadFromArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const input = (args as { input?: unknown }).input;
	if (typeof input === "string") return input;
	const diff = (args as { diff?: unknown }).diff;
	if (typeof diff === "string") return diff;
	try {
		return JSON.stringify(args);
	} catch {
		return "";
	}
}

export const EDIT_FAILURE_CATEGORIES = [
	"range-continuation",
	"unified-diff",
	"no-change",
	"hash-mismatch",
	"other",
] as const;

export type EditFailureCategory = (typeof EDIT_FAILURE_CATEGORIES)[number];

function categorizeEditFailure(error: string, args: unknown): EditFailureCategory {
	const payload = getEditPayloadFromArgs(args);
	const hasRangeReplacePayload = /^[1-9]\d*[a-z]{2}\.\.[1-9]\d*[a-z]{2}[ \t]*=/m.test(payload);
	if (
		/\\TEXT.* (?:continuation|has been removed)|range[- ]replacement continuation|LidA\.\.LidB=FIRST_LINE/i.test(
			error,
		)
	) {
		return "range-continuation";
	}
	if (/unified-diff syntax|\+Lid[=|]|\+[1-9]\d*[a-z]{2}[=|]/i.test(error)) {
		return "unified-diff";
	}
	if (/No changes made|no changes being made|replacement is identical/i.test(error)) {
		return "no-change";
	}
	if (/hash mismatch|expected hash|stale/i.test(error)) {
		return "hash-mismatch";
	}
	if (hasRangeReplacePayload && /unrecognized op|cannot parse|Lines must start/i.test(error)) {
		return "range-continuation";
	}
	return "other";
}

function emptyEditFailureCategoryCounts(): Record<EditFailureCategory, number> {
	return Object.fromEntries(EDIT_FAILURE_CATEGORIES.map(category => [category, 0])) as Record<
		EditFailureCategory,
		number
	>;
}

function countEditFailureCategories(runs: TaskRunResult[]): Record<EditFailureCategory, number> {
	const counts = emptyEditFailureCategoryCounts();
	for (const run of runs) {
		for (const failure of run.editFailures) {
			counts[failure.category ?? "other"] += 1;
		}
	}
	return counts;
}

const HL_SUBTYPES = ["set", "set_range", "insert"] as const;
const BENCHMARK_TOOL_NAMES = ["read", "edit", "write", "apply_patch"] as const;
const EDIT_TOOL_NAMES = ["edit", "apply_patch"] as const;

function isEditTool(toolName: unknown): toolName is (typeof EDIT_TOOL_NAMES)[number] {
	return toolName === "edit" || toolName === "vim" || toolName === "apply_patch";
}

function isMutationTool(toolName: unknown): boolean {
	return isEditTool(toolName) || toolName === "write";
}

function countHashlineEditSubtypes(args: unknown): Record<string, number> {
	const counts: Record<string, number> = Object.fromEntries(HL_SUBTYPES.map(k => [k, 0]));
	if (!args || typeof args !== "object") return counts;
	const edits = (args as { edits?: unknown[] }).edits;
	if (!Array.isArray(edits)) return counts;
	for (const edit of edits) {
		if (!edit || typeof edit !== "object") continue;
		for (const key of HL_SUBTYPES) {
			if (key in edit) {
				counts[key]++;
				break;
			}
		}
	}
	return counts;
}

async function collectOriginalFileContents(cwd: string, files: string[]): Promise<Map<string, string>> {
	const originals = new Map<string, string>();
	for (const file of files) {
		const fullPath = path.join(cwd, file);
		try {
			originals.set(fullPath, await Bun.file(fullPath).text());
		} catch {
			// Ignore missing files; not all tasks include all paths in every run.
		}
	}
	return originals;
}

function buildMutationPreviewAgainstOriginal(original: string, current: string): string | null {
	if (original === current) return null;

	const changes = diffLines(original, current);
	const preview: string[] = [];
	let lineNum = 1;

	for (const change of changes) {
		const lines = splitLines(change.value);
		if (!change.added && !change.removed) {
			lineNum += lines.length;
			continue;
		}

		if (change.removed) {
			for (const line of lines) {
				const hash = computeLineHash(lineNum, line);
				preview.push(`${lineNum}#${hash}|-${line}`);
				lineNum += 1;
			}
			continue;
		}

		for (const line of lines) {
			const hash = computeLineHash(lineNum, line);
			preview.push(`${lineNum}#${hash}|+${line}`);
		}
	}

	return preview.length > 0 ? preview.join("\n") : null;
}

async function appendNoChangeMutationHint(
	error: string,
	args: unknown,
	cwd: string,
	originalFiles: Map<string, string>,
): Promise<string> {
	if (!error.includes("No changes made")) return error;
	const editPath = getEditPathFromArgs(args);
	if (!editPath) return error;

	const fullPath = editPath.startsWith("/") ? editPath : path.join(cwd, editPath);
	const original = originalFiles.get(fullPath);
	if (original === undefined) return error;

	let current: string;
	try {
		current = await Bun.file(fullPath).text();
	} catch {
		return error;
	}

	const preview = buildMutationPreviewAgainstOriginal(original, current);
	if (!preview) return error;

	return `${error}\nThe file differs from the original fixture at these lines:\n${preview}`;
}

export interface PromptAttemptTelemetry {
	elapsedMs: number;
	eventCount: number;
	toolExecutionStarts: number;
	toolExecutionEnds: number;
	messageEnds: number;
	lastEventType?: string;
	recentEventTypes: string[];
	pendingRetry: boolean;
}

class PromptTimeoutError extends Error {
	telemetry: PromptAttemptTelemetry;

	constructor(telemetry: PromptAttemptTelemetry) {
		super("Timeout waiting for agent_end");
		this.name = "PromptTimeoutError";
		this.telemetry = telemetry;
	}
}

export interface PromptTurnLimitTelemetry {
	elapsedMs: number;
	observedTurns: number;
	maxTurns: number;
	pendingRetry: boolean;
	lastEventType?: string;
	recentEventTypes: string[];
}

class PromptTurnLimitError extends Error {
	telemetry: PromptTurnLimitTelemetry;

	constructor(telemetry: PromptTurnLimitTelemetry) {
		super(
			`Max turn limit exceeded: observed ${telemetry.observedTurns} turn_start events (limit ${telemetry.maxTurns}).`,
		);
		this.name = "PromptTurnLimitError";
		this.telemetry = telemetry;
	}
}

export interface MutationIntentValidation {
	matched: boolean;
	reason: string;
	mutationType?: string;
	file?: string;
	lineNumber?: number;
}

function buildTimeoutRetryContext(telemetry: PromptAttemptTelemetry, retryNumber: number, retryLimit: number): string {
	return [
		`Previous attempt timed out waiting for agent_end after ${telemetry.elapsedMs}ms.`,
		`Observed events=${telemetry.eventCount}, tool_starts=${telemetry.toolExecutionStarts}, tool_ends=${telemetry.toolExecutionEnds}, message_ends=${telemetry.messageEnds}.`,
		telemetry.lastEventType
			? `Last event type: ${telemetry.lastEventType}.`
			: "No events were observed before timeout.",
		`Timeout retry ${retryNumber}/${retryLimit}: emit one minimal, concrete edit attempt quickly and stop.`,
	].join("\n");
}

const AUTH_FAILURE_RE =
	/\b(401|unauthorized|forbidden|invalid api key|invalid key|user not found|authentication|not authenticated|permission denied|access denied)\b/i;

interface ProviderFailure {
	kind: "auth" | "provider";
	message: string;
}

function detectProviderFailure(events: Array<{ type: string; [key: string]: unknown }>): ProviderFailure | null {
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = (event as { message?: unknown }).message;
		if (!message || typeof message !== "object") continue;
		const role = (message as { role?: unknown }).role;
		if (role !== "assistant") continue;
		const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
		if (typeof errorMessage !== "string") continue;
		const normalized = errorMessage.trim();
		if (normalized.length === 0) continue;
		return {
			kind: AUTH_FAILURE_RE.test(normalized) ? "auth" : "provider",
			message: normalized,
		};
	}
	return null;
}

function getProviderFailureRetryDelayMs(retryNumber: number): number {
	const safeRetryNumber = Math.max(1, retryNumber);
	return Math.min(10_000, 1_000 * 2 ** (safeRetryNumber - 1));
}

function buildProviderFailureRetryContext(
	failure: ProviderFailure,
	retryNumber: number,
	retryLimit: number,
	delayMs: number,
): string {
	const category = failure.kind === "auth" ? "provider/auth" : "provider";
	return [
		`Previous attempt failed due to a ${category} error.`,
		`Provider error: ${failure.message}`,
		`Retry ${retryNumber}/${retryLimit} after ${delayMs}ms backoff. Resume the requested edit flow once the provider responds successfully.`,
	].join("\n");
}

async function evaluateMutationIntent(
	task: EditTask,
	cwd: string,
	expectedDir: string,
): Promise<MutationIntentValidation | null> {
	const metadata = task.metadata;
	const file = metadata?.fileName ?? task.files[0];
	const lineNumber = metadata?.lineNumber;
	if (!file || typeof lineNumber !== "number" || lineNumber < 1) {
		return null;
	}

	const currentPath = file.startsWith("/") ? file : path.join(cwd, file);
	const expectedPath = file.startsWith("/") ? file : path.join(expectedDir, file);

	let currentText: string;
	let expectedText: string;
	try {
		currentText = await Bun.file(currentPath).text();
		expectedText = await Bun.file(expectedPath).text();
	} catch {
		return {
			matched: false,
			reason: "Unable to read current/expected target file for mutation-intent check.",
			mutationType: metadata?.mutationType,
			file,
			lineNumber,
		};
	}

	const currentLine = currentText.split("\n")[lineNumber - 1] ?? "";
	const expectedLine = expectedText.split("\n")[lineNumber - 1] ?? "";
	const originalSnippet = metadata?.originalSnippet;
	const mutatedSnippet = metadata?.mutatedSnippet;

	if (currentLine === expectedLine && expectedLine.length > 0) {
		return {
			matched: true,
			reason: "Target line exactly matches expected fixture.",
			mutationType: metadata?.mutationType,
			file,
			lineNumber,
		};
	}

	if (typeof originalSnippet === "string" && originalSnippet.length > 0) {
		const hasOriginal = currentLine.includes(originalSnippet);
		const stillHasMutated =
			typeof mutatedSnippet === "string" && mutatedSnippet.length > 0 ? currentLine.includes(mutatedSnippet) : false;
		if (hasOriginal && !stillHasMutated) {
			return {
				matched: true,
				reason: "Target line contains original snippet and no longer contains mutated snippet.",
				mutationType: metadata?.mutationType,
				file,
				lineNumber,
			};
		}
	}

	return {
		matched: false,
		reason: `Target line mismatch at ${file}:${lineNumber}.`,
		mutationType: metadata?.mutationType,
		file,
		lineNumber,
	};
}

type GuidedHashlineEdit =
	| { set: { ref: string; body: string[] } }
	| { set_range: { beg: string; end: string; body: string[] } }
	| { insert: { after: string; body: string[] } };

function buildGuidedHashlineEdits(actual: string, expected: string): GuidedHashlineEdit[] {
	const changes = diffLines(actual, expected);
	const actualLines = actual.split("\n");

	let line = 1;
	let pendingStart = 1;
	let pendingRemoved: string[] = [];
	let pendingAdded: string[] = [];
	const edits: GuidedHashlineEdit[] = [];

	const flush = () => {
		if (pendingRemoved.length === 0 && pendingAdded.length === 0) {
			return;
		}

		if (pendingRemoved.length === 0) {
			const insertLine = pendingStart;
			if (pendingAdded.length === 0) return;
			if (insertLine === 1) {
				const firstLine = actualLines[0] ?? "";
				const firstRef = `1#${computeLineHash(1, firstLine)}`;
				edits.push({
					set: { ref: firstRef, body: [...pendingAdded, firstLine] },
				});
			} else if (insertLine <= actualLines.length) {
				const afterLine = actualLines[insertLine - 2] ?? "";
				const afterRef = `${insertLine - 1}#${computeLineHash(insertLine - 1, afterLine)}`;
				edits.push({
					insert: { after: afterRef, body: [...pendingAdded] },
				});
			} else if (insertLine === actualLines.length + 1 && actualLines.length > 0) {
				const afterLine = actualLines[actualLines.length - 1] ?? "";
				const afterRef = `${actualLines.length}#${computeLineHash(actualLines.length, afterLine)}`;
				edits.push({
					insert: { after: afterRef, body: [...pendingAdded] },
				});
			}
		} else {
			const startLine = pendingStart;
			const endLine = pendingStart + pendingRemoved.length - 1;
			const startContent = actualLines[startLine - 1] ?? "";
			const startRef = `${startLine}#${computeLineHash(startLine, startContent)}`;
			if (startLine === endLine) {
				edits.push({ set: { ref: startRef, body: [...pendingAdded] } });
			} else {
				const endContent = actualLines[endLine - 1] ?? "";
				const endRef = `${endLine}#${computeLineHash(endLine, endContent)}`;
				edits.push({
					set_range: {
						beg: startRef,
						end: endRef,
						body: [...pendingAdded],
					},
				});
			}
		}

		pendingRemoved = [];
		pendingAdded = [];
	};

	for (const change of changes) {
		const lines = splitLines(change.value);
		if (!change.added && !change.removed) {
			flush();
			line += lines.length;
			continue;
		}
		if (pendingRemoved.length === 0 && pendingAdded.length === 0) {
			pendingStart = line;
		}
		if (change.removed) {
			pendingRemoved.push(...lines);
			line += lines.length;
		}
		if (change.added) {
			pendingAdded.push(...lines);
		}
	}
	flush();

	return edits;
}

async function buildGuidedContext(
	task: EditTask,
	cwd: string,
	expectedDir: string,
	config: BenchmarkConfig,
): Promise<string | null> {
	if (!config.guided) return null;
	if (config.editVariant !== "hashline") return null;

	const file = task.metadata?.fileName ?? task.files[0];
	if (!file) return null;

	const actualPath = path.join(cwd, file);
	const expectedPath = path.join(expectedDir, file);
	const actual = await Bun.file(actualPath)
		.text()
		.catch(() => null);
	const expected = await Bun.file(expectedPath)
		.text()
		.catch(() => null);
	if (actual === null || expected === null) return null;

	const edits = buildGuidedHashlineEdits(actual, expected);
	if (edits.length === 0) return null;
	if (edits.length > 25) return null;

	const args = { path: file, edits };
	const argsText = JSON.stringify(args, null, 2);
	if (argsText.length > 20_000) return null;
	const metaParts: string[] = [];
	if (typeof task.metadata?.lineNumber === "number") metaParts.push(`Line: ${task.metadata.lineNumber}`);
	if (typeof task.metadata?.mutationType === "string") metaParts.push(`Mutation: ${task.metadata.mutationType}`);

	return [
		`Target file: \`${file}\`${metaParts.length > 0 ? ` (${metaParts.join(", ")})` : ""}.`,
		"Apply this edit tool call (single call; copy/paste args exactly):",
		`\`\`\`diff\n${argsText}\n\`\`\``,
	].join("\n\n");
}

function buildInstructions(config: BenchmarkConfig): string {
	return config.noEditRequired
		? "Read the relevant files first, then apply the fix."
		: "Read the relevant files first, then use the edit or vim tool to apply the fix.";
}

type BenchmarkPromptDelivery = {
	kind: "prompt" | "followUp";
	message: string;
};

function buildBenchmarkSystemPrompt(params: { multiFile: boolean; config: BenchmarkConfig }): string {
	return prompt.render(benchmarkSystemPrompt, {
		multiFile: params.multiFile,
		instructions: buildInstructions(params.config),
	});
}

function buildInitialBenchmarkPrompt(params: { taskPrompt: string; guidedContext?: string | null }): string {
	return prompt.render(benchmarkTaskPrompt, {
		task_prompt: params.taskPrompt,
		guided_context: params.guidedContext ?? undefined,
	});
}

function buildRetryBenchmarkPrompt(params: { retryContext: string; guidedContext?: string | null }): string {
	return prompt.render(benchmarkRetryPrompt, {
		retry_context: params.retryContext,
		guided_context: params.guidedContext ?? undefined,
	});
}

function buildBenchmarkPromptDelivery(params: {
	taskPrompt: string;
	guidedContext?: string | null;
	retryContext?: string | null;
}): BenchmarkPromptDelivery {
	if (params.retryContext) {
		return {
			kind: "followUp",
			message: buildRetryBenchmarkPrompt({
				retryContext: params.retryContext,
				guidedContext: params.guidedContext,
			}),
		};
	}

	return {
		kind: "prompt",
		message: buildInitialBenchmarkPrompt({
			taskPrompt: params.taskPrompt,
			guidedContext: params.guidedContext,
		}),
	};
}

const BENCHMARK_PROVIDER_SESSION_VERSION = 1;

function buildBenchmarkProviderSessionId(params: {
	config: BenchmarkConfig;
	task: EditTask;
	multiFile: boolean;
	initialGuidedContext?: string | null;
}): string {
	const keyMaterial = [
		`version:${BENCHMARK_PROVIDER_SESSION_VERSION}`,
		`provider:${params.config.provider}`,
		`model:${params.config.model}`,
		`task:${params.task.id}`,
		`system:${buildBenchmarkSystemPrompt({ multiFile: params.multiFile, config: params.config })}`,
		`initial:${buildInitialBenchmarkPrompt({ taskPrompt: params.task.prompt, guidedContext: params.initialGuidedContext })}`,
	].join("\n");
	return `reb_${Bun.hash(keyMaterial).toString(36)}`;
}

async function prepareBenchmarkSessionSetup(params: {
	config: BenchmarkConfig;
	task: EditTask;
	cwd: string;
	expectedDir: string;
	multiFile: boolean;
}): Promise<{ initialGuidedContext: string | null; providerSessionId: string; rpcArgs: string[] }> {
	const initialGuidedContext = await buildGuidedContext(params.task, params.cwd, params.expectedDir, params.config);
	const providerSessionId = buildBenchmarkProviderSessionId({
		config: params.config,
		task: params.task,
		multiFile: params.multiFile,
		initialGuidedContext,
	});
	return {
		initialGuidedContext,
		providerSessionId,
		rpcArgs: buildBenchmarkRpcArgs(params.config, params.multiFile, providerSessionId),
	};
}

function buildBenchmarkRpcArgs(config: BenchmarkConfig, multiFile: boolean, providerSessionId: string): string[] {
	return [
		"--provider-session-id",
		providerSessionId,
		"--append-system-prompt",
		buildBenchmarkSystemPrompt({ multiFile, config }),
		"--tools",
		BENCHMARK_TOOL_NAMES.join(","),
		"--no-skills",
		"--no-title",
		"--no-rules",
		"--no-lsp",
	];
}

export interface TokenStats {
	input: number;
	output: number;
	total: number;
}

export interface ToolCallStats {
	read: number;
	edit: number;
	write: number;
	editSuccesses: number;
	editFailures: number;
	editWarnings: number;
	editAutocorrects: number;
	totalInputChars: number;
}

export interface EditFailure {
	toolCallId: string;
	args: unknown;
	error: string;
	category?: EditFailureCategory;
}

export interface TaskRunResult {
	runIndex: number;
	success: boolean;
	patchApplied: boolean;
	verificationPassed: boolean;
	seed?: number;
	mutationType?: string;
	mutationCategory?: string;
	difficultyScore?: number;
	error?: string;
	tokens: TokenStats;
	duration: number;
	indentScore?: number;
	formattedEquivalent?: boolean;
	diffStats?: { linesChanged: number; charsChanged: number };
	agentResponse?: string;
	diff?: string;
	toolCalls: ToolCallStats;
	editFailures: EditFailure[];
	editWarnings: string[];
	editAutocorrectCount: number;
	/** Hashline edit subtype counts (replaceLine, replaceLines, etc.) — only when editVariant is hashline */
	hashlineEditSubtypes?: Record<string, number>;
	mutationIntentMatched?: boolean;
	mutationIntentReason?: string;
	timeoutTelemetry?: PromptAttemptTelemetry;
	/** True when the run terminated early because the formatted file content matched the expected fixture. */
	earlyStopped?: boolean;
	/** Retry telemetry: how many retries of each type were used */
	retryStats?: {
		timeoutRetries: number;
		zeroToolRetries: number;
		providerFailureRetries: number;
	};
}

export interface ProgressEvent {
	taskId: string;
	runIndex: number;
	status: "started" | "completed";
	result?: TaskRunResult;
}

export interface TaskResult {
	id: string;
	name: string;
	files: string[];
	runs: TaskRunResult[];
	successRate: number;
	avgTokens: TokenStats;
	avgDuration: number;
	avgIndentScore: number;
	avgToolCalls: ToolCallStats;
	editSuccessRate: number;
	autocorrectFreeSuccessRate: number;
}

export interface BenchmarkSummary {
	totalTasks: number;
	totalRuns: number;
	successfulRuns: number;
	overallSuccessRate: number;
	tasksWithAllPassing: number;
	tasksWithAnyFailing: number;
	totalTokens: TokenStats;
	avgTokensPerRun: TokenStats;
	totalDuration: number;
	avgDurationPerRun: number;
	avgIndentScore: number;
	totalToolCalls: ToolCallStats;
	avgToolCallsPerRun: ToolCallStats;
	editSuccessRate: number;
	autocorrectFreeSuccessfulRuns: number;
	autocorrectFreeSuccessRate: number;
	autocorrectedRuns: number;
	editAutocorrectRate: number;
	timeoutRuns: number;
	/** Total retry counts across all runs */
	totalTimeoutRetries: number;
	totalZeroToolRetries: number;
	totalProviderFailureRetries: number;
	/** Runs where the 0/0/0 ghost signature was detected (0 tokens, 0 tool calls) */
	ghostRuns: number;
	/** Runs excluded because provider/transport stalls exhausted retries (subset of ghostRuns when error matches). */
	transportFailureRuns: number;
	mutationIntentMatchRate?: number;
	editFailureCategories: Record<EditFailureCategory, number>;
	/** Hashline edit subtype totals — only when editVariant is hashline */
	hashlineEditSubtypes?: Record<string, number>;
}

export interface BenchmarkResult {
	config: BenchmarkConfig;
	tasks: TaskResult[];
	summary: BenchmarkSummary;
	startTime: string;
	endTime: string;
}

interface TaskRunItem {
	task: EditTask;
	runIndex: number;
}

async function copyFixtures(task: EditTask, destDir: string): Promise<void> {
	if (!task.inputDir) {
		throw new Error(`Task ${task.id} has no inputDir`);
	}
	const entries = await fs.promises.readdir(task.inputDir, { withFileTypes: true });
	await Promise.all(
		entries.map(entry =>
			fs.promises.cp(path.join(task.inputDir!, entry.name), path.join(destDir, entry.name), { recursive: true }),
		),
	);
}

interface EarlyStopOptions {
	check: () => Promise<boolean>;
	onMatch: () => void | Promise<void>;
}

function buildEarlyStop(params: {
	config: BenchmarkConfig;
	cwd: string;
	expectedDir: string;
	files: string[];
	logEvent: (event: unknown) => Promise<void>;
	attempt: number;
	onMatched: () => void;
}): EarlyStopOptions | undefined {
	if (params.config.earlyStopOnMatch === false) return undefined;
	if (params.files.length === 0) return undefined;
	return {
		check: async () => {
			const verification = await verifyExpectedFileSubset(params.expectedDir, params.cwd, params.files);
			return verification.success;
		},
		onMatch: async () => {
			params.onMatched();
			await params.logEvent({ type: "early_stop", attempt: params.attempt, reason: "formatted_match" });
		},
	};
}

async function runSingleTask(
	task: EditTask,
	runIndex: number,
	config: BenchmarkConfig,
	cwd: string,
	expectedDir: string,
	shared?: SharedInfra,
): Promise<TaskRunResult> {
	const startTime = Date.now();
	let error: string | undefined;
	let patchApplied = false;
	let verificationPassed = false;
	let indentScore: number | undefined;
	let formattedEquivalent: boolean | undefined;
	let diffStats: { linesChanged: number; charsChanged: number } | undefined;
	let tokens: TokenStats = { input: 0, output: 0, total: 0 };
	let agentResponse: string | undefined;
	let diff: string | undefined;
	const editFailures: EditFailure[] = [];
	const editWarnings: string[] = [];
	let editAutocorrectCount = 0;
	let timeoutTelemetry: PromptAttemptTelemetry | undefined;
	let mutationIntentValidation: MutationIntentValidation | null = null;
	let earlyStoppedByMatch = false;
	let conversationSnapshot: ConversationDumpSnapshot | undefined;
	const toolStats = {
		read: 0,
		edit: 0,
		write: 0,
		editSuccesses: 0,
		editFailures: 0,
		editWarnings: 0,
		editAutocorrects: 0,
		totalInputChars: 0,
	};
	const hashlineSubtypes: Record<string, number> = Object.fromEntries(HL_SUBTYPES.map(k => [k, 0]));

	const logFile = path.join(TMP, `run-${task.id}-${runIndex}.jsonl`);
	const logEvent = async (event: unknown) => {
		await fs.promises.appendFile(logFile, `${JSON.stringify(event)}\n`);
	};
	const originalFiles = await collectOriginalFileContents(cwd, task.files);
	let timeoutRetriesUsed = 0;
	let zeroToolRetries = 0;
	let providerFailureRetries = 0;

	try {
		const sessionSetup = await prepareBenchmarkSessionSetup({
			config,
			task,
			cwd,
			expectedDir,
			multiFile: false,
		});
		await fs.promises.appendFile(
			logFile,
			`{"type":"meta","task":"${task.id}","run":${runIndex},"workDir":"${cwd}","providerSessionId":${JSON.stringify(sessionSetup.providerSessionId)}}\n`,
		);

		if (config.editVariant !== undefined) process.env.PI_EDIT_VARIANT = config.editVariant;
		if (config.editFuzzy !== undefined)
			process.env.PI_EDIT_FUZZY = config.editFuzzy === "auto" ? "auto" : config.editFuzzy ? "1" : "0";
		if (config.editFuzzyThreshold !== undefined)
			process.env.PI_EDIT_FUZZY_THRESHOLD =
				config.editFuzzyThreshold === "auto" ? "auto" : String(config.editFuzzyThreshold);
		process.env.PI_NO_TITLE = "1";

		if (config.inProcess === false) {
			throw new Error("The RPC benchmark client was removed; the benchmark now runs in-process only.");
		}
		const client: BenchmarkClient = new InProcessClient({
			cwd,
			model: config.model,
			appendSystemPrompt: buildBenchmarkSystemPrompt({ multiFile: false, config }),
			tools: [...BENCHMARK_TOOL_NAMES],
			editVariant: config.editVariant,
			editFuzzy: config.editFuzzy,
			editFuzzyThreshold: config.editFuzzyThreshold,
			shared,
		});

		try {
			await client.start();

			if (config.thinkingLevel) {
				await client.setThinkingLevel(config.thinkingLevel);
			}

			const initialState = await client.getState();
			const systemPromptTokens = estimateTokens(initialState.systemPrompt?.join("\n\n") ?? "");

			const maxAttempts = Math.max(1, Math.floor(config.maxAttempts ?? 1));
			const maxTimeoutRetries = config.maxTimeoutRetries ?? 3;
			const noOpRetryLimit = config.noOpRetryLimit ?? 2;
			const maxProviderFailureRetries = config.maxProviderFailureRetries ?? 3;
			let retryContext: string | null = null;
			let allEvents: Array<{ type: string; [key: string]: unknown }> = [];

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				const guidedContext =
					attempt === 0
						? sessionSetup.initialGuidedContext
						: await buildGuidedContext(task, cwd, expectedDir, config);
				const delivery = buildBenchmarkPromptDelivery({
					taskPrompt: task.prompt,
					guidedContext,
					retryContext,
				});

				await fs.promises.appendFile(
					logFile,
					`{"type":"prompt","attempt":${attempt + 1},"delivery":${JSON.stringify(delivery.kind)},"message":${JSON.stringify(delivery.message)}}\n`,
				);

				const statsBefore = await client.getSessionStats();
				let events: Array<{ type: string; [key: string]: unknown }>;
				try {
					events = await collectPromptEvents(
						client,
						delivery,
						config,
						logEvent,
						buildEarlyStop({
							config,
							cwd,
							expectedDir,
							files: task.files,
							logEvent,
							attempt: attempt + 1,
							onMatched: () => {
								earlyStoppedByMatch = true;
							},
						}),
					);
				} catch (err) {
					if (err instanceof PromptTurnLimitError) {
						error = err.message;
						await logEvent({ type: "turn_limit_exceeded", attempt: attempt + 1, telemetry: err.telemetry });
						break;
					}
					if (err instanceof PromptTimeoutError) {
						timeoutTelemetry = err.telemetry;
						await logEvent({ type: "timeout", attempt: attempt + 1, telemetry: err.telemetry });
						timeoutRetriesUsed += 1;
						retryContext = buildTimeoutRetryContext(err.telemetry, timeoutRetriesUsed, maxTimeoutRetries);
						if (timeoutRetriesUsed >= maxTimeoutRetries) {
							error = `Timeout exhausted after ${maxTimeoutRetries} retries (last: ${err.telemetry.elapsedMs}ms, events=${err.telemetry.eventCount}, last_event=${err.telemetry.lastEventType ?? "none"})`;
							await logEvent({
								type: "timeout_exhausted",
								retriesUsed: timeoutRetriesUsed,
								telemetry: err.telemetry,
							});
							break;
						}
						attempt--; // Don't consume a regular attempt slot for timeout retries
						continue;
					}
					throw err;
				}
				const statsAfter = await client.getSessionStats();
				const attemptTokens = diffTokenStats(statsBefore, statsAfter, systemPromptTokens);
				tokens = {
					input: tokens.input + attemptTokens.input,
					output: tokens.output + attemptTokens.output,
					total: tokens.total + attemptTokens.total,
				};
				await logEvent({ type: "stats", before: statsBefore, after: statsAfter, attempt: attempt + 1 });
				allEvents = allEvents.concat(events);

				agentResponse = (await client.getLastAssistantText()) ?? undefined;
				await logEvent({ type: "response", text: agentResponse, attempt: attempt + 1 });

				const providerFailure = detectProviderFailure(events);
				const hasMutationToolCall = events.some(
					event =>
						event.type === "tool_execution_start" && isMutationTool((event as { toolName?: unknown }).toolName),
				);
				if (providerFailure && !hasMutationToolCall) {
					await logEvent({
						type: "provider_failure",
						attempt: attempt + 1,
						kind: providerFailure.kind,
						error: providerFailure.message,
					});
					if (providerFailureRetries < maxProviderFailureRetries) {
						providerFailureRetries += 1;
						const delayMs = getProviderFailureRetryDelayMs(providerFailureRetries);
						await logEvent({
							type: "provider_failure_retry",
							attempt: attempt + 1,
							retryNumber: providerFailureRetries,
							retryLimit: maxProviderFailureRetries,
							delayMs,
							kind: providerFailure.kind,
						});
						retryContext = buildProviderFailureRetryContext(
							providerFailure,
							providerFailureRetries,
							maxProviderFailureRetries,
							delayMs,
						);
						await Bun.sleep(delayMs);
						attempt--; // Don't consume a regular attempt slot for provider/auth retries
						continue;
					}
					error = `Provider ${providerFailure.kind} failure: ${providerFailure.message}`;
					await logEvent({
						type: "provider_failure_exhausted",
						attempt: attempt + 1,
						retriesUsed: providerFailureRetries,
						kind: providerFailure.kind,
						error: providerFailure.message,
					});
					break;
				}
				const pendingEdits = new Map<string, unknown>();

				for (const event of events) {
					if (event.type === "tool_execution_start") {
						const e = event as { toolName?: string; toolCallId?: string; args?: unknown };
						const toolName = e.toolName;
						if (toolName === "read") {
							toolStats.read++;
						} else if (isEditTool(toolName)) {
							toolStats.edit++;
							if (e.toolCallId) pendingEdits.set(e.toolCallId, e.args);
						} else if (toolName === "write") {
							toolStats.write++;
						}

						// Count input chars from args
						if (e.args) {
							toolStats.totalInputChars += JSON.stringify(e.args).length;
						}
					} else if (event.type === "tool_execution_end") {
						const e = event as { toolName?: string; toolCallId?: string; isError?: boolean; result?: unknown };
						if (isEditTool(e.toolName) && e.toolCallId && pendingEdits.has(e.toolCallId)) {
							const args = pendingEdits.get(e.toolCallId) ?? null;
							pendingEdits.delete(e.toolCallId);
							if (config.editVariant === "hashline" && args) {
								const counts = countHashlineEditSubtypes(args);
								for (const key of HL_SUBTYPES) {
									hashlineSubtypes[key] += counts[key];
								}
							}
							if (e.isError) {
								toolStats.editFailures++;
								const error = await appendNoChangeMutationHint(
									extractToolErrorMessage(e.result),
									args,
									cwd,
									originalFiles,
								);
								editFailures.push({
									toolCallId: e.toolCallId,
									args,
									error,
									category: categorizeEditFailure(error, args),
								});
							} else {
								toolStats.editSuccesses++;
								if (e.toolName === "edit") {
									const warningMessages = extractHashlineWarnings(e.result);
									if (warningMessages.length > 0) {
										editWarnings.push(...warningMessages);
										toolStats.editWarnings += warningMessages.length;
										if (hasHashlineAutocorrectWarning(warningMessages)) {
											editAutocorrectCount++;
											toolStats.editAutocorrects++;
										}
									}
								}
							}
						}
					}
				}

				// Retry if the model didn't attempt any edit/write (read-only or no tool calls)
				const madeEditAttempt = toolStats.edit > 0 || toolStats.write > 0;
				if (!madeEditAttempt && zeroToolRetries < noOpRetryLimit) {
					zeroToolRetries++;
					await logEvent({ type: "zero_tool_retry", attempt: attempt + 1, retryNumber: zeroToolRetries });
					retryContext = `Previous attempt read files but made no edit attempt — you must use the edit or vim tool to apply the fix. Retry ${zeroToolRetries}/${noOpRetryLimit}.`;
					attempt--; // Don't consume a regular attempt slot
					continue;
				}

				patchApplied = toolStats.edit > 0;
				const verification = await verifyExpectedFiles(expectedDir, cwd);
				if (config.autoFormat) {
					await formatDirectory(cwd);
				}

				verificationPassed = verification.success;
				indentScore = verification.indentScore;
				formattedEquivalent = verification.formattedEquivalent;
				diffStats = verification.diffStats;
				diff = verification.diff;
				mutationIntentValidation = await evaluateMutationIntent(task, cwd, expectedDir);
				if (!verification.success && verification.error) {
					error = verification.error;
				}

				if (verification.success) {
					break;
				}

				const mutationIntentSuffix = mutationIntentValidation
					? `\n\nMutation intent: ${mutationIntentValidation.matched ? "matched" : "not matched"} (${mutationIntentValidation.reason})`
					: "";
				retryContext = error
					? `Verification failed: ${error}${diff ? `\n\nDiff (expected vs actual):\n\n\`\`\`diff\n${diff}\n\`\`\`` : ""}${mutationIntentSuffix}`
					: `Previous attempt failed.${mutationIntentSuffix}`;
			}
			if (config.conversationDumpDir) {
				conversationSnapshot = await snapshotConversationDump(client);
			}
		} finally {
			await client.dispose();
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		await logEvent({ type: "error", error });
	}

	const duration = Date.now() - startTime;
	const mustUseEditTool = Boolean(config.requireEditToolCall) && !config.noEditRequired;
	const mustUseReadTool = Boolean(config.requireReadToolCall) && !config.noEditRequired;
	const editSucceeded = toolStats.editSuccesses > 0;
	const success =
		verificationPassed && (!mustUseEditTool || editSucceeded) && (!mustUseReadTool || toolStats.read > 0);
	const metadata = task.metadata;

	await logEvent({
		type: "result",
		success,
		patchApplied,
		verificationPassed,
		error,
		duration,
		timeoutTelemetry,
		mutationIntentValidation,
	});
	console.log(`  Log: ${formatLogPath(logFile)}`);

	if (config.conversationDumpDir && conversationSnapshot) {
		await writeConversationDump({
			dumpDir: config.conversationDumpDir,
			taskId: task.id,
			runIndex,
			snapshot: conversationSnapshot,
		});
	}

	return {
		runIndex,
		success,
		patchApplied,
		verificationPassed,
		seed: metadata?.seed,
		mutationType: metadata?.mutationType,
		mutationCategory: metadata?.mutationCategory,
		difficultyScore: metadata?.difficultyScore,
		error,
		tokens,
		duration,
		indentScore,
		formattedEquivalent,
		diffStats,
		agentResponse,
		diff,
		toolCalls: toolStats,
		editFailures,
		editWarnings,
		editAutocorrectCount,
		hashlineEditSubtypes: config.editVariant === "hashline" ? hashlineSubtypes : undefined,
		mutationIntentMatched: mutationIntentValidation?.matched,
		mutationIntentReason: mutationIntentValidation?.reason,
		timeoutTelemetry,
		earlyStopped: earlyStoppedByMatch || undefined,
		retryStats: {
			timeoutRetries: timeoutRetriesUsed,
			zeroToolRetries,
			providerFailureRetries,
		},
	};
}

function extractToolText(result: unknown): string | null {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return null;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const entry of content) {
		if (!entry || typeof entry !== "object") continue;
		if (!("text" in entry)) continue;
		const text = (entry as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return null;
}

function extractHashlineWarnings(result: unknown): string[] {
	const text = extractToolText(result);
	if (!text) return [];
	const marker = "Warnings:\n";
	const markerIndex = text.indexOf(marker);
	if (markerIndex === -1) return [];
	return text
		.slice(markerIndex + marker.length)
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function hasHashlineAutocorrectWarning(warnings: string[]): boolean {
	return warnings.some(warning => warning.startsWith("Auto-corrected "));
}

function extractToolErrorMessage(result: unknown): string {
	const text = extractToolText(result);
	if (text) return text;
	try {
		return JSON.stringify(result);
	} catch {
		return "Unknown error";
	}
}

function shuffle<T>(items: T[]): T[] {
	const copy = items.slice();
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
}

async function collectPromptEvents(
	client: BenchmarkClient,
	delivery: BenchmarkPromptDelivery,
	config: BenchmarkConfig,
	logEvent: (event: unknown) => Promise<void>,
	earlyStop?: {
		check: () => Promise<boolean>;
		onMatch: () => void | Promise<void>;
	},
): Promise<Array<{ type: string; [key: string]: unknown }>> {
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	let unsubscribe: (() => void) | undefined;
	const startedAt = Date.now();
	let pendingRetry = false;
	let toolExecutionStarts = 0;
	let toolExecutionEnds = 0;
	let messageEnds = 0;
	let lastEventType: string | undefined;
	const recentEventTypes: string[] = [];
	let observedTurns = 0;
	let timer: NodeJS.Timeout | undefined;
	let settled = false;
	let receivedFirstEvent = false;
	let earlyStopTriggered = false;
	let earlyStopChain: Promise<void> = Promise.resolve();

	const connectionTimeout = config.connectionTimeout ?? 30_000;

	const eventsPromise = new Promise<void>((resolve, reject) => {
		const resolveWait = () => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe?.();
			resolve();
		};

		const rejectWait = (err: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe?.();
			reject(err);
		};

		const fireTimeout = () => {
			client.abort?.();
			rejectWait(
				new PromptTimeoutError({
					elapsedMs: Date.now() - startedAt,
					eventCount: events.length,
					toolExecutionStarts,
					toolExecutionEnds,
					messageEnds,
					lastEventType,
					recentEventTypes: [...recentEventTypes],
					pendingRetry,
				}),
			);
		};

		const triggerEarlyStop = () => {
			if (!earlyStop || earlyStopTriggered || settled) return;
			earlyStopChain = earlyStopChain
				.then(async () => {
					if (earlyStopTriggered || settled) return;
					let matched = false;
					try {
						matched = await earlyStop.check();
					} catch {
						return;
					}
					if (!matched || earlyStopTriggered || settled) return;
					earlyStopTriggered = true;
					try {
						await earlyStop.onMatch();
					} catch {
						// Swallow callback errors; we still want to short-circuit.
					}
					client.abort?.();
					resolveWait();
				})
				.catch(() => {});
		};

		// Start with the shorter connection timeout; upgrade to full timeout on first event
		timer = setTimeout(fireTimeout, connectionTimeout);

		unsubscribe = client.onEvent(event => {
			if (!event || settled) {
				return;
			}
			const typedEvent = event as { type: string; [key: string]: unknown };

			// First event arrived: switch to the full activity timeout
			if (!receivedFirstEvent) {
				receivedFirstEvent = true;
				if (timer) {
					clearTimeout(timer);
				}
				timer = setTimeout(fireTimeout, config.timeout);
			}

			events.push(typedEvent);
			lastEventType = typedEvent.type;
			recentEventTypes.push(typedEvent.type);
			if (recentEventTypes.length > 8) {
				recentEventTypes.shift();
			}
			if (typedEvent.type === "tool_execution_start") {
				toolExecutionStarts += 1;
			}
			if (typedEvent.type === "tool_execution_end") {
				toolExecutionEnds += 1;
			}
			if (
				typedEvent.type === "tool_execution_end" &&
				!(typedEvent as { isError?: boolean }).isError &&
				isMutationTool((typedEvent as { toolName?: unknown }).toolName)
			) {
				triggerEarlyStop();
			}
			if (typedEvent.type === "message_end") {
				messageEnds += 1;
			}

			if (
				typedEvent.type === "tool_execution_start" ||
				typedEvent.type === "tool_execution_end" ||
				typedEvent.type === "message_end"
			) {
				logEvent(typedEvent).catch(() => {});
			}
			if (typedEvent.type === "turn_start") {
				observedTurns += 1;
				if (typeof config.maxTurns === "number" && observedTurns > config.maxTurns) {
					client.abort?.();
					rejectWait(
						new PromptTurnLimitError({
							elapsedMs: Date.now() - startedAt,
							observedTurns,
							maxTurns: config.maxTurns,
							pendingRetry,
							lastEventType,
							recentEventTypes: [...recentEventTypes],
						}),
					);
					return;
				}
				if (pendingRetry) {
					pendingRetry = false;
				}
			} else if (typedEvent.type === "auto_retry_start") {
				pendingRetry = true;
			}
			if (typedEvent.type === "agent_end") {
				if (pendingRetry) {
					return;
				}
				resolveWait();
			}
		});
	});

	// Prevent unhandled rejection if events reject eventsPromise during prompt()
	// (happens in-process where events fire synchronously within prompt/followUp)
	eventsPromise.catch(() => {});

	try {
		if (delivery.kind === "followUp") {
			await client.followUp(delivery.message);
		} else {
			await client.prompt(delivery.message);
		}
	} catch (err) {
		if (earlyStopTriggered) {
			// Abort raised inside prompt(); the run already short-circuited successfully.
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe?.();
			return events;
		}
		if (timer) {
			clearTimeout(timer);
		}
		unsubscribe?.();
		throw err;
	}
	await eventsPromise;
	return events;
}

/** Rough token estimate (4 chars per token). Used to subtract system prompt overhead. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function diffTokenStats(before: SessionTokenStats, after: SessionTokenStats, systemPromptTokens: number): TokenStats {
	// `input` here is the total prompt tokens delivered to the model on the wire,
	// summed across all four buckets the providers expose: non-cached input,
	// cacheRead, cacheWrite. Summing makes the metric comparable across providers
	// with different caching behavior — Anthropic with a hot cache reports its
	// prompt entirely under cacheRead/cacheWrite while non-caching providers put
	// the same content under `input`.
	//
	// The system prompt and tool definitions are constant per-call overhead. We
	// subtract `calls * systemPromptTokens` once per assistant turn so the
	// reported figure reflects task-driven prompt cost rather than fixed boilerplate.
	const calls = Math.max(0, after.assistantMessages - before.assistantMessages);
	const overhead = calls * systemPromptTokens;
	const beforePrompt = before.tokens.input + before.tokens.cacheRead + before.tokens.cacheWrite;
	const afterPrompt = after.tokens.input + after.tokens.cacheRead + after.tokens.cacheWrite;
	const input = Math.max(0, afterPrompt - beforePrompt - overhead);
	const output = Math.max(0, after.tokens.output - before.tokens.output);
	const total = input + output;
	return { input, output, total };
}

type SessionTokenStats = {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	assistantMessages: number;
};

function isTransportFailure(r: TaskRunResult): boolean {
	if (r.success) return false;
	const err = r.error ?? "";
	// Provider/transport stalls retried until the cap was hit. These don't reflect
	// edit-tool quality, so we exclude them from the score denominator.
	return err.includes("Timeout exhausted");
}

function isGhostRun(r: TaskRunResult): boolean {
	if (r.success) return false;
	const noProgress =
		r.tokens.total === 0 && r.toolCalls.read === 0 && r.toolCalls.edit === 0 && r.toolCalls.write === 0;
	return noProgress || isTransportFailure(r);
}

function summarizeTaskRuns(task: EditTask, runs: TaskRunResult[]): TaskResult {
	const orderedRuns = runs.slice().sort((a, b) => a.runIndex - b.runIndex);
	const nonGhostRuns = orderedRuns.filter(r => !isGhostRun(r));
	const effective = nonGhostRuns.length;
	const successfulRuns = orderedRuns.filter(r => r.success).length;
	const successRate = effective > 0 ? successfulRuns / effective : 0;

	const avgTokens: TokenStats =
		effective > 0
			? {
					input: Math.round(nonGhostRuns.reduce((sum, r) => sum + r.tokens.input, 0) / effective),
					output: Math.round(nonGhostRuns.reduce((sum, r) => sum + r.tokens.output, 0) / effective),
					total: Math.round(nonGhostRuns.reduce((sum, r) => sum + r.tokens.total, 0) / effective),
				}
			: { input: 0, output: 0, total: 0 };

	const avgDuration = effective > 0 ? Math.round(nonGhostRuns.reduce((sum, r) => sum + r.duration, 0) / effective) : 0;
	const indentScores = orderedRuns
		.map(run => run.indentScore)
		.filter((score): score is number => typeof score === "number");
	const avgIndentScore =
		indentScores.length > 0 ? indentScores.reduce((sum, score) => sum + score, 0) / indentScores.length : 0;

	const avgToolCalls: ToolCallStats =
		effective > 0
			? {
					read: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.read, 0) / effective,
					edit: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.edit, 0) / effective,
					write: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.write, 0) / effective,
					editSuccesses: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editSuccesses, 0) / effective,
					editFailures: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editFailures, 0) / effective,
					editWarnings: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editWarnings, 0) / effective,
					editAutocorrects: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editAutocorrects, 0) / effective,
					totalInputChars: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.totalInputChars, 0) / effective,
				}
			: {
					read: 0,
					edit: 0,
					write: 0,
					editSuccesses: 0,
					editFailures: 0,
					editWarnings: 0,
					editAutocorrects: 0,
					totalInputChars: 0,
				};

	const totalEditAttempts = nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.edit, 0);
	const totalEditSuccesses = nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editSuccesses, 0);
	const editSuccessRate = totalEditAttempts > 0 ? totalEditSuccesses / totalEditAttempts : 1;
	const autocorrectFreeSuccesses = nonGhostRuns.filter(run => run.success && run.editAutocorrectCount === 0).length;
	const autocorrectFreeSuccessRate = effective > 0 ? autocorrectFreeSuccesses / effective : 0;

	return {
		id: task.id,
		name: task.name,
		files: task.files,
		runs: orderedRuns,
		successRate,
		avgTokens,
		avgDuration,
		avgIndentScore,
		avgToolCalls,
		editSuccessRate,
		autocorrectFreeSuccessRate,
	};
}

function buildFailureResult(item: TaskRunItem, error: string): TaskRunResult {
	return {
		runIndex: item.runIndex,
		success: false,
		patchApplied: false,
		verificationPassed: false,
		error,
		tokens: { input: 0, output: 0, total: 0 },
		duration: 0,
		toolCalls: {
			read: 0,
			edit: 0,
			write: 0,
			editSuccesses: 0,
			editFailures: 0,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 0,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
	};
}

async function runConcurrentBenchmarkRun(
	item: TaskRunItem,
	config: BenchmarkConfig,
	onProgress?: (event: ProgressEvent) => void,
	shared?: SharedInfra,
): Promise<{ task: EditTask; result: TaskRunResult }> {
	const workDir = subtmp(item.task.id);

	try {
		await copyFixtures(item.task, workDir);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "started" });
		const result = await runSingleTask(item.task, item.runIndex, config, workDir, item.task.expectedDir, shared);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const result = buildFailureResult(item, message);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	}
}

export function buildBenchmarkResult(params: {
	tasks: EditTask[];
	config: BenchmarkConfig;
	resultsByTask: Map<string, TaskRunResult[]>;
	startTime: string;
	endTime?: string;
}): BenchmarkResult {
	const taskResults = params.tasks.map(task => summarizeTaskRuns(task, params.resultsByTask.get(task.id) ?? []));

	const endTime = params.endTime ?? new Date().toISOString();

	const allRuns = taskResults.flatMap(t => t.runs);
	const totalRuns = allRuns.length;
	const ghostRuns = allRuns.filter(r => isGhostRun(r)).length;
	const transportFailureRuns = allRuns.filter(r => isTransportFailure(r)).length;
	const effectiveRuns = totalRuns - ghostRuns;
	const nonGhostRuns = allRuns.filter(r => !isGhostRun(r));
	const successfulRuns = allRuns.filter(r => r.success).length;

	const totalTokens: TokenStats = {
		input: nonGhostRuns.reduce((sum, r) => sum + r.tokens.input, 0),
		output: nonGhostRuns.reduce((sum, r) => sum + r.tokens.output, 0),
		total: nonGhostRuns.reduce((sum, r) => sum + r.tokens.total, 0),
	};

	const totalDuration = nonGhostRuns.reduce((sum, r) => sum + r.duration, 0);
	const indentScores = nonGhostRuns
		.map(run => run.indentScore)
		.filter((score): score is number => typeof score === "number");
	const avgIndentScore =
		indentScores.length > 0 ? indentScores.reduce((sum, score) => sum + score, 0) / indentScores.length : 0;

	const totalToolCalls: ToolCallStats = {
		read: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.read, 0),
		edit: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.edit, 0),
		write: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.write, 0),
		editSuccesses: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editSuccesses, 0),
		editFailures: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editFailures, 0),
		editWarnings: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editWarnings, 0),
		editAutocorrects: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.editAutocorrects, 0),
		totalInputChars: nonGhostRuns.reduce((sum, r) => sum + r.toolCalls.totalInputChars, 0),
	};

	const editSuccessRate = totalToolCalls.edit > 0 ? totalToolCalls.editSuccesses / totalToolCalls.edit : 1;
	const autocorrectFreeSuccessfulRuns = nonGhostRuns.filter(
		run => run.success && run.editAutocorrectCount === 0,
	).length;
	const autocorrectedRuns = nonGhostRuns.filter(run => run.editAutocorrectCount > 0).length;
	const editAutocorrectRate =
		totalToolCalls.editSuccesses > 0 ? totalToolCalls.editAutocorrects / totalToolCalls.editSuccesses : 0;
	const timeoutRuns = nonGhostRuns.filter(
		r => r.error?.includes("Timeout") || r.error?.includes("Timeout exhausted"),
	).length;
	const totalTimeoutRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.timeoutRetries ?? 0), 0);
	const totalZeroToolRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.zeroToolRetries ?? 0), 0);
	const totalProviderFailureRetries = nonGhostRuns.reduce(
		(sum, r) => sum + (r.retryStats?.providerFailureRetries ?? 0),
		0,
	);
	const runsWithMutationIntent = nonGhostRuns.filter(r => typeof r.mutationIntentMatched === "boolean");
	const mutationIntentMatchRate =
		runsWithMutationIntent.length > 0
			? runsWithMutationIntent.filter(r => r.mutationIntentMatched).length / runsWithMutationIntent.length
			: undefined;
	const editFailureCategories = countEditFailureCategories(nonGhostRuns);

	const hashlineEditSubtypes: Record<string, number> | undefined =
		params.config.editVariant === "hashline"
			? Object.fromEntries(
					HL_SUBTYPES.map(key => [key, allRuns.reduce((sum, r) => sum + (r.hashlineEditSubtypes?.[key] ?? 0), 0)]),
				)
			: undefined;

	const denom = effectiveRuns || 1;
	const summary: BenchmarkSummary = {
		totalTasks: params.tasks.length,
		totalRuns: effectiveRuns,
		successfulRuns,
		overallSuccessRate: successfulRuns / denom,
		tasksWithAllPassing: taskResults.filter(t => t.successRate === 1).length,
		tasksWithAnyFailing: taskResults.filter(t => t.successRate < 1).length,
		totalTokens,
		avgTokensPerRun: {
			input: Math.round(totalTokens.input / denom),
			output: Math.round(totalTokens.output / denom),
			total: Math.round(totalTokens.total / denom),
		},
		totalDuration,
		avgDurationPerRun: Math.round(totalDuration / denom),
		avgIndentScore,
		totalToolCalls,
		avgToolCallsPerRun: {
			read: totalToolCalls.read / denom,
			edit: totalToolCalls.edit / denom,
			write: totalToolCalls.write / denom,
			editSuccesses: totalToolCalls.editSuccesses / denom,
			editFailures: totalToolCalls.editFailures / denom,
			editWarnings: totalToolCalls.editWarnings / denom,
			editAutocorrects: totalToolCalls.editAutocorrects / denom,
			totalInputChars: totalToolCalls.totalInputChars / denom,
		},
		editSuccessRate,
		autocorrectFreeSuccessfulRuns,
		autocorrectFreeSuccessRate: autocorrectFreeSuccessfulRuns / denom,
		autocorrectedRuns,
		editAutocorrectRate,
		timeoutRuns,
		totalTimeoutRetries,
		totalZeroToolRetries,
		totalProviderFailureRetries,
		ghostRuns,
		transportFailureRuns,
		mutationIntentMatchRate,
		editFailureCategories,
		hashlineEditSubtypes,
	};

	return {
		config: params.config,
		tasks: taskResults,
		summary,
		startTime: params.startTime,
		endTime,
	};
}

export async function runBenchmark(
	tasks: EditTask[],
	config: BenchmarkConfig,
	onProgress?: (event: ProgressEvent) => void,
	onResultSnapshot?: (result: BenchmarkResult) => void,
): Promise<BenchmarkResult> {
	const startTime = new Date().toISOString();

	// Discover shared infrastructure once for in-process mode
	const useInProcess = config.inProcess !== false;
	const shared = useInProcess
		? await discoverSharedInfra({
				editVariant: config.editVariant,
				editFuzzy: config.editFuzzy,
				editFuzzyThreshold: config.editFuzzyThreshold,
			})
		: undefined;

	const runItems: TaskRunItem[] = tasks.flatMap(task =>
		Array.from({ length: config.runsPerTask }, (_, runIndex) => ({ task, runIndex })),
	);

	const pending = shuffle(runItems);
	const resultsByTask = new Map<string, TaskRunResult[]>();
	const concurrency = Math.max(1, Math.floor(config.taskConcurrency));
	const running: Promise<void>[] = [];

	const runNext = async (): Promise<void> => {
		const nextItem = pending.shift();
		if (!nextItem) return;
		const { task, result } = await runConcurrentBenchmarkRun(nextItem, config, onProgress, shared);
		const list = resultsByTask.get(task.id) ?? [];
		list.push(result);
		resultsByTask.set(task.id, list);
		onResultSnapshot?.(buildBenchmarkResult({ tasks, config, resultsByTask, startTime }));
		await runNext();
	};

	const slots = Math.min(concurrency, pending.length);
	for (let i = 0; i < slots; i++) {
		running.push(runNext());
	}

	await Promise.all(running);

	return buildBenchmarkResult({ tasks, config, resultsByTask, startTime });
}
