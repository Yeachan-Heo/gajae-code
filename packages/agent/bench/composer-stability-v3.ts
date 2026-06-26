#!/usr/bin/env bun
/**
 * Benchmark: Composer stability V3 scenario gate.
 *
 * Modes:
 *   --mock        deterministic synthetic smoke gate
 *   --trace-dir   trace-backed failure-count gate over JSON/JSONL trace artifacts
 *   --live        credential-aware live entrypoint; skips honestly when live capture is unavailable
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { benchRunMetadata, type BenchRunMetadata } from "./_meta";
import {
	COMPOSER_SCENARIOS as SCENARIOS,
	DEFAULT_CODEX_BASELINE_MODEL,
	DEFAULT_COMPOSER_CANDIDATE_MODEL,
	MIN_COMPARABLE_TRACE_SCENARIOS,
	SCENARIO_BY_ID,
	traceExpectationForScenario,
	type FailureClass,
	type ScenarioDefinition,
	type ScenarioId,
	type TraceExpectation,
} from "./composer-scenarios";
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");


const DEFAULT_MODEL = DEFAULT_COMPOSER_CANDIDATE_MODEL;
const DEFAULT_BASELINE_MODEL = DEFAULT_CODEX_BASELINE_MODEL;

export type { FailureClass, ScenarioDefinition, ScenarioId } from "./composer-scenarios";
export {
	COMPOSER_SCENARIOS,
	L2_MIN_SCENARIO_COVERAGE,
	MIN_COMPARABLE_TRACE_SCENARIOS,
	TOTAL_SCENARIO_COUNT,
} from "./composer-scenarios";

type BenchMode = "mock" | "trace" | "live";

export type CliOptions = {
	mode: BenchMode;
	seed: number;
	trialsPerScenario: number;
	model: string;
	baselineModel: string;
	json: boolean;
	tracePaths: string[];
	traceDir?: string;
};

type ModelRole = "candidate" | "baseline";

type TrialStatus = "passed" | "failed" | "skipped";

export type TrialResult = {
	scenarioId: ScenarioId;
	modelRole: ModelRole;
	model: string;
	trial: number;
	status: TrialStatus;
	failureClass?: FailureClass;
	failureClasses?: FailureClass[];
	evidence: string;
	tracePath?: string;
};

type ScenarioSummary = {
	id: ScenarioId;
	description: string;
	turns: string;
	obligation: string;
	failureClass: FailureClass;
	fixture: string;
	recovery: boolean;
	candidateFailures: number;
	baselineFailures: number;
	traceRecords: number;
};

type TraceArtifact = {
	path: string;
	records: number;
	error?: string;
};

export type P1Summary = {
	candidateFailureCount: number;
	baselineFailureCount: number;
	parityDelta: number;
	passed: boolean;
	applicable: boolean;
	reason?: string;
};

type BenchOutput = {
	schemaVersion: 1;
	command: string;
	bench: "composer-stability-v3";
	mode: BenchMode;
	seed: number;
	trialsPerScenario: number;
	model: string;
	baselineModel: string;
	skipped?: boolean;
	skipReasons?: string[];
	p1: P1Summary;
	scenarios: ScenarioSummary[];
	trialResults: TrialResult[];
	traceArtifacts?: TraceArtifact[];
	metadata: BenchRunMetadata;
};

type JsonObject = Record<string, unknown>;


export type TraceRecord = {
	scenarioId: ScenarioId;
	modelRole: ModelRole;
	model: string;
	trial: number;
	events: JsonObject[];
	expected: TraceExpectation;
	tracePath?: string;
};

type ClassifiedTrace = {
	status: TrialStatus;
	failureClasses: FailureClass[];
	evidence: string;
};

const DEFAULT_SEED = 42;
const DEFAULT_TRIALS = 5;
const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch", "applyPatch", "patch"]);
const READ_TOOL_NAMES = new Set(["read", "search", "find"]);
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "executeBash", "terminal"]);
const FILE_READ_COMMAND_PATTERN = /(?:^|[;&|\s])(?:cat|sed|awk|grep|rg|head|tail|less|more)\b/;
const FILE_READ_PIPE_PATTERN = /\|\s*(?:cat|sed|awk|grep|rg|head|tail|less|more)\b/;
const FILE_DISCOVERY_COMMAND_PATTERN = /(?:^|[;&|\s])(?:git(?:\s+-C\s+\S+)?\s+ls-files\b|(?:git\s+)?ls(?:\s|$)|find\s+|fd\s+)/;
const FILE_SCRIPT_READ_COMMAND_PATTERN = /(?:^|[;&|\s])(?:python3?|node|bun)\s+(?:-\s*<<|-c\b|-e\b|--eval\b).*?(?:read_text|readFile|readFileSync|Bun\.file|fs\.readFile|open\s*\([^)]*\)\.read)/s;
const FILE_WRITE_COMMAND_PATTERN = /(?:^|[;&|\s])(?:sed\s+-i|perl\s+-pi)\b|(?:^|[;&|\s])(?:python3?|node|bun)\s+(?:-\s*<<|-c\b|-e\b|--eval\b).*?(?:write_text|writeFile|Bun\.write|fs\.writeFile|open\s*\([^)]*,\s*["'][wa]["'][^)]*\)\.write)|(?:^|[;&|\s])tee(?:\s+-a)?\s+[\w./~:-]+|(?:^|[^<])>>?\s*[\w./~:-]+/s;
const COMMAND_CONTAMINATION_PATTERN = /```|^\s*(?:I\s+(?:will|need|am going)|We\s+(?:need|will)|First[, ]|Now[, ]|Let's)\b/im;
const ANCHOR_ERROR_PATTERN = /(?:anchor|hashline|stale).{0,80}(?:mismatch|do not match|rejected|invalid|bad)|(?:edit rejected).{0,80}(?:anchor|hashline)/i;
const MALFORMED_ARGS_PATTERN = /(?:malformed|invalid|contaminated).{0,80}(?:json|argument|args|tool)|schema validation|failed to parse/i;
const SANITIZE_PATTERN = /sanitize(?:d|r)?\s+(?:payload|replay|output)?\s*(?:failed|failure|error|regression)|harmony|protocol leak|to=functions|contaminated tool/i;
const TIMEOUT_PATTERN = /timeout|timed out|deadline/i;
const COMPOSER_BASH_POLICY_BLOCK_PATTERN = /Composer bash policy blocked repository file I\/O/i;
const PATH_NOT_FOUND_PATTERN = /\bPath ['"].*['"] not found\b/i;
const FRESH_ANCHOR_LINE_PATTERN = /^\*\d+[a-z]{2}\|/m;

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		mode: "mock",
		seed: DEFAULT_SEED,
		trialsPerScenario: DEFAULT_TRIALS,
		model: DEFAULT_MODEL,
		baselineModel: DEFAULT_BASELINE_MODEL,
		json: true,
		tracePaths: [],
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const next = argv[index + 1];
		if (arg === "--mock") options.mode = "mock";
		else if (arg === "--live") options.mode = "live";
		else if (arg === "--trace") options.mode = "trace";
		else if (arg === "--seed" && next !== undefined) {
			options.seed = Number.parseInt(next, 10);
			index++;
		} else if ((arg === "-n" || arg === "--trials") && next !== undefined) {
			options.trialsPerScenario = Number.parseInt(next, 10);
			index++;
		} else if (arg === "--model" && next !== undefined) {
			options.model = next;
			index++;
		} else if (arg === "--baseline-model" && next !== undefined) {
			options.baselineModel = next;
			index++;
		} else if ((arg === "--trace-dir" || arg === "--traces") && next !== undefined) {
			options.mode = options.mode === "live" ? "live" : "trace";
			options.traceDir = next;
			index++;
		} else if ((arg === "--trace-file" || arg === "--trace-path") && next !== undefined) {
			options.mode = options.mode === "live" ? "live" : "trace";
			options.tracePaths.push(next);
			index++;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--text") {
			options.json = false;
		} else if (arg === "--help" || arg === "-h") {
			printHelpAndExit();
		} else {
			throw new Error(`Unknown or incomplete argument: ${arg}`);
		}
	}
	if (!Number.isInteger(options.seed)) throw new Error("--seed must be an integer");
	if (!Number.isInteger(options.trialsPerScenario) || options.trialsPerScenario <= 0) {
		throw new Error("-n/--trials must be a positive integer");
	}
	return options;
}

function printHelpAndExit(): never {
	console.log([
		"Usage: bun packages/agent/bench/composer-stability-v3.ts [--mock|--trace|--live] [--seed N] [-n N]",
		"       [--trace-dir DIR] [--trace-file FILE] [--json|--text]",
		`Defaults: --mock --seed ${DEFAULT_SEED} -n ${DEFAULT_TRIALS}`,
		`Candidate: ${DEFAULT_MODEL}`,
		`Baseline:  ${DEFAULT_BASELINE_MODEL}`,
		"Trace files may be JSON, JSON arrays, JSON {records:[...]}, JSON {events:[...]}, or JSONL.",
	].join("\n"));
	process.exit(0);
}

function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function isRecognizedComposerCandidate(model: string): boolean {
	return model.toLowerCase().includes("grok-composer") || model.toLowerCase().includes("composer-2.5");
}

function isRecognizedCodexBaseline(model: string): boolean {
	return model.toLowerCase().includes("openai-codex/gpt-5.5") || model.toLowerCase().includes("gpt-5.5");
}

function shouldInjectMockFailure(
	role: ModelRole,
	model: string,
	scenario: ScenarioDefinition,
	trial: number,
	random: () => number,
): boolean {
	if (role === "candidate" && isRecognizedComposerCandidate(model)) return false;
	if (role === "baseline" && isRecognizedCodexBaseline(model)) return false;
	const score = random() + (trial % 3) * 0.03 + (scenario.recovery ? 0.04 : 0);
	return score > 0.94;
}

function runMockTrial(
	role: ModelRole,
	model: string,
	scenario: ScenarioDefinition,
	trial: number,
	random: () => number,
): TrialResult {
	const failed = shouldInjectMockFailure(role, model, scenario, trial, random);
	return {
		scenarioId: scenario.id,
		modelRole: role,
		model,
		trial,
		status: failed ? "failed" : "passed",
		failureClass: failed ? scenario.failureClass : undefined,
		failureClasses: failed ? [scenario.failureClass] : [],
		evidence: failed
			? `${scenario.id} violated ${scenario.obligation}`
			: `${scenario.id} satisfied ${scenario.obligation}`,
	};
}

function resolveLiveSkipReasons(options: CliOptions): string[] {
	const reasons: string[] = [];
	if (!process.env.GROK_CLI_OAUTH_TOKEN) reasons.push("SKIP grok-live: GROK_CLI_OAUTH_TOKEN is not set");
	if (!process.env.OPENAI_CODEX_OAUTH_TOKEN && !process.env.CODEX_OAUTH_TOKEN && !process.env.OPENAI_OAUTH_TOKEN && !process.env.OPENAI_API_KEY) {
		reasons.push("SKIP codex-live: OpenAI/Codex credentials are not set");
	}
	if (options.tracePaths.length === 0 && !options.traceDir) {
		reasons.push("SKIP live V3: live capture driver is not implemented in this benchmark; pass --trace-dir from real captured runs for trace-backed scoring");
	}
	return reasons;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNestedObject(object: JsonObject, key: string): JsonObject | undefined {
	const value = object[key];
	return isJsonObject(value) ? value : undefined;
}

function getNestedArray(object: JsonObject, key: string): unknown[] | undefined {
	const value = object[key];
	return Array.isArray(value) ? value : undefined;
}

function getTextBlob(event: JsonObject): string {
	const parts: string[] = [];
	for (const key of ["type", "kind", "status", "message", "error", "stderr", "stdout", "evidence", "reason", "details"]) {
		const value = event[key];
		if (typeof value === "string") parts.push(value);
	}
	const result = getNestedObject(event, "result");
	if (result) parts.push(getTextBlob(result));
	const error = getNestedObject(event, "errorInfo") ?? getNestedObject(event, "errorObject");
	if (error) parts.push(getTextBlob(error));
	return parts.join("\n");
}

function normalizeScenarioId(value: unknown): ScenarioId | undefined {
	const id = asString(value);
	if (!id) return undefined;
	return SCENARIO_BY_ID.has(id as ScenarioId) ? (id as ScenarioId) : undefined;
}

function normalizeRole(value: unknown): ModelRole | undefined {
	const role = asString(value)?.toLowerCase();
	if (role === "candidate" || role === "grok" || role === "composer") return "candidate";
	if (role === "baseline" || role === "codex" || role === "gpt") return "baseline";
	return undefined;
}

function normalizeFailureClass(value: unknown): FailureClass | undefined {
	const failureClass = asString(value);
	if (!failureClass) return undefined;
	const known: FailureClass[] = [
		"shell-read",
		"shell-file-discovery",
		"shell-write",
		"contaminated-command",
		"bad-anchor-unrecovered",
		"malformed-tool-args-unrecovered",
		"sanitize-replay-regression",
		"wrong-file-edit",
		"missing-tool-turn",
		"timeout",
	];
	return known.includes(failureClass as FailureClass) ? (failureClass as FailureClass) : undefined;
}

function normalizeExpected(value: unknown): TraceExpectation {
	if (!isJsonObject(value)) return {};
	const requiredToolsValue = value.requiredTools;
	const requiredTools = Array.isArray(requiredToolsValue)
		? requiredToolsValue.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const targetPath = asString(value.targetPath) ?? asString(value.path);
	const expectedEditText = asString(value.expectedEditText) ?? asString(value.expected_edit_text);
	const recoveryTargetPath = asString(value.recoveryTargetPath) ?? asString(value.recovery_target_path);
	const requireSuccess = typeof value.requireSuccess === "boolean" ? value.requireSuccess : undefined;
	return { targetPath, recoveryTargetPath, requiredTools, expectedEditText, requireSuccess };
}

function mergeTraceExpectation(scenarioId: ScenarioId, override: TraceExpectation | undefined): TraceExpectation {
	const base = traceExpectationForScenario(scenarioId);
	if (!override) return base;
	const overrideKeepsBaseTarget =
		override.targetPath === undefined ||
		(base.targetPath !== undefined && path.normalize(override.targetPath) === path.normalize(base.targetPath));
	return {
		targetPath: override.targetPath ?? base.targetPath,
		requiredTools: override.requiredTools ?? base.requiredTools,
		expectedEditText: override.expectedEditText ?? (overrideKeepsBaseTarget ? base.expectedEditText : undefined),
		recoveryTargetPath: override.recoveryTargetPath ?? base.recoveryTargetPath,
		requireSuccess: override.requireSuccess ?? base.requireSuccess,
	};
}

function eventToolName(event: JsonObject): string | undefined {
	const direct =
		asString(event.toolName) ??
		asString(event.tool_name) ??
		asString(event.tool) ??
		asString(event.name) ??
		asString(event.action);
	if (direct) return direct;
	const toolCall = getNestedObject(event, "toolCall") ?? getNestedObject(event, "tool_call");
	if (toolCall) return eventToolName(toolCall);
	const fn = getNestedObject(event, "function");
	return fn ? asString(fn.name) : undefined;
}

function normalizeArgsPayload(args: unknown): unknown {
	if (typeof args !== "string") return args;
	const trimmed = args.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return args;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isJsonObject(parsed) || Array.isArray(parsed) ? parsed : args;
	} catch {
		return args;
	}
}

function eventArgs(event: JsonObject): unknown {
	if (event.arguments !== undefined) return normalizeArgsPayload(event.arguments);
	if (event.args !== undefined) return normalizeArgsPayload(event.args);
	if (event.input !== undefined) return normalizeArgsPayload(event.input);
	const toolCall = getNestedObject(event, "toolCall") ?? getNestedObject(event, "tool_call");
	if (toolCall) return eventArgs(toolCall);
	const fn = getNestedObject(event, "function");
	return normalizeArgsPayload(fn?.arguments);
}

function stringifyArgs(args: unknown): string {
	if (typeof args === "string") return args;
	if (isJsonObject(args) || Array.isArray(args)) return JSON.stringify(args);
	return "";
}

function eventCommand(event: JsonObject): string | undefined {
	const args = eventArgs(event);
	if (typeof args === "string") return args;
	if (isJsonObject(args)) return asString(args.command) ?? asString(args.cmd) ?? asString(args.input);
	return asString(event.command) ?? asString(event.cmd);
}

function eventPath(event: JsonObject): string | undefined {
	const args = eventArgs(event);
	if (isJsonObject(args)) {
		const direct = asString(args.path) ?? asString(args.filePath) ?? asString(args.file_path) ?? asString(args.targetPath);
		if (direct) return direct;
		const input = asString(args.input);
		const sectionPath = input?.match(/^§(.+)$/m)?.[1]?.trim();
		if (sectionPath) return sectionPath;
	}
	return asString(event.path) ?? asString(event.filePath) ?? asString(event.file_path) ?? asString(event.targetPath);
}

function matchesNormalizedPath(expected: string | undefined, actual: string | undefined): boolean {
	return expected === undefined || (actual !== undefined && path.normalize(actual) === path.normalize(expected));
}

function isEventError(event: JsonObject): boolean {
	const status = asString(event.status)?.toLowerCase();
	const type = asString(event.type)?.toLowerCase();
	return status === "failed" || status === "error" || event.isError === true || type?.includes("error") === true;
}

function isTimeoutFailureEvent(event: JsonObject, text: string): boolean {
	return isEventError(event) && TIMEOUT_PATTERN.test(text);
}

function isSanitizeReplayFailureEvent(event: JsonObject, text: string): boolean {
	return isEventError(event) && SANITIZE_PATTERN.test(text) && !PATH_NOT_FOUND_PATTERN.test(text);
}

function isSuccessfulToolEvent(event: JsonObject): boolean {
	if (isEventError(event)) return false;
	const status = asString(event.status)?.toLowerCase();
	return status === "ok" || status === "passed" || status === "success";
}

function isTerminalResultEvent(event: JsonObject): boolean {
	const type = asString(event.type)?.toLowerCase() ?? "";
	return type === "scenario_result" || type === "trial_result" || type === "run_result";
}

function isTerminalFailureEvent(event: JsonObject): boolean {
	if (!isTerminalResultEvent(event)) return false;
	const status = asString(event.status)?.toLowerCase();
	return status === "failed" || status === "error";
}

function isTerminalSuccessEvent(event: JsonObject): boolean {
	if (!isTerminalResultEvent(event)) return false;
	const status = asString(event.status)?.toLowerCase();
	return status === "ok" || status === "passed" || status === "success";
}

function hasToolCall(event: JsonObject): boolean {
	return eventToolName(event) !== undefined;
}

function isShellReadEvent(event: JsonObject): boolean {
	const toolName = eventToolName(event);
	if (!toolName || !SHELL_TOOL_NAMES.has(toolName)) return false;
	const command = eventCommand(event) ?? stringifyArgs(eventArgs(event));
	return FILE_READ_COMMAND_PATTERN.test(command) || FILE_READ_PIPE_PATTERN.test(command) || FILE_SCRIPT_READ_COMMAND_PATTERN.test(command);
}

function isShellFileDiscoveryEvent(event: JsonObject): boolean {
	const toolName = eventToolName(event);
	if (!toolName || !SHELL_TOOL_NAMES.has(toolName)) return false;
	const command = eventCommand(event) ?? stringifyArgs(eventArgs(event));
	return FILE_DISCOVERY_COMMAND_PATTERN.test(command);
}

function isShellWriteEvent(event: JsonObject): boolean {
	const toolName = eventToolName(event);
	if (!toolName || !SHELL_TOOL_NAMES.has(toolName)) return false;
	const command = eventCommand(event) ?? stringifyArgs(eventArgs(event));
	return FILE_WRITE_COMMAND_PATTERN.test(command);
}

function isComposerBashPolicyBlockedEvent(event: JsonObject, text: string): boolean {
	const toolName = eventToolName(event);
	return Boolean(
		toolName && SHELL_TOOL_NAMES.has(toolName) && isEventError(event) && COMPOSER_BASH_POLICY_BLOCK_PATTERN.test(text),
	);
}

function isContaminatedCommandEvent(event: JsonObject): boolean {
	const toolName = eventToolName(event);
	if (!toolName || !SHELL_TOOL_NAMES.has(toolName)) return false;
	const command = eventCommand(event) ?? stringifyArgs(eventArgs(event));
	return COMMAND_CONTAMINATION_PATTERN.test(command);
}

function isReadEvent(event: JsonObject): boolean {
	const toolName = eventToolName(event);
	return toolName !== undefined && READ_TOOL_NAMES.has(toolName);
}

function isSuccessfulEditEvent(event: JsonObject): boolean {
	const toolName = eventToolName(event);
	return toolName !== undefined && EDIT_TOOL_NAMES.has(toolName) && isSuccessfulToolEvent(event);
}

function addFailure(failures: Set<FailureClass>, failureClass: FailureClass): void {
	failures.add(failureClass);
}

export function classifyTraceRecord(record: TraceRecord): ClassifiedTrace {
	const failures = new Set<FailureClass>();
	const scenario = SCENARIO_BY_ID.get(record.scenarioId);
	const expected = mergeTraceExpectation(record.scenarioId, record.expected);
	const calledTools = new Set<string>();
	let sawAnchorErrorAt = -1;
	let readAfterAnchorErrorAt = -1;
	let anchorRecoveryTargetPath: string | undefined;
	let readAfterAnchorErrorPath: string | undefined;
	let sawRecoveredAnchorError = false;
	let anchorErrorProvidedFreshAnchors = false;
	let sawMalformedArgsAt = -1;
	let malformedArgsToolName: string | undefined;
	let malformedArgsPath: string | undefined;
	let sawSuccessAfterMalformedArgs = false;
	let sawSuccessfulTerminal = false;
	const isHardGuardFeedbackScenario = record.scenarioId === "hard-guard-feedback";
	let sawComposerBashPolicyBlockedIo = false;
	let sawComposerBashPolicyRecoveryTool = false;
	let sawShellIoRetryAfterComposerBashPolicyBlock = false;

	let sawSuccessfulTargetPathEdit = false;
	for (let index = 0; index < record.events.length; index++) {
		const event = record.events[index]!;
		const text = getTextBlob(event);
		const toolName = eventToolName(event);
		if (toolName) calledTools.add(toolName);
		const shellIoFailureClasses = [
			isShellReadEvent(event) ? "shell-read" : undefined,
			isShellFileDiscoveryEvent(event) ? "shell-file-discovery" : undefined,
			isShellWriteEvent(event) ? "shell-write" : undefined,
		].filter((failureClass): failureClass is FailureClass => failureClass !== undefined);
		const composerBashPolicyBlocked =
			isHardGuardFeedbackScenario && shellIoFailureClasses.length > 0 && isComposerBashPolicyBlockedEvent(event, text);
		if (composerBashPolicyBlocked) {
			sawShellIoRetryAfterComposerBashPolicyBlock ||= sawComposerBashPolicyBlockedIo;
			sawComposerBashPolicyBlockedIo = true;
		} else {
			if (sawComposerBashPolicyBlockedIo && shellIoFailureClasses.length > 0) {
				sawShellIoRetryAfterComposerBashPolicyBlock = true;
			}
			for (const failureClass of shellIoFailureClasses) addFailure(failures, failureClass);
		}
		if (isContaminatedCommandEvent(event)) addFailure(failures, "contaminated-command");
		if (isTimeoutFailureEvent(event, text)) addFailure(failures, "timeout");
		if (isSanitizeReplayFailureEvent(event, text)) addFailure(failures, "sanitize-replay-regression");
		if (ANCHOR_ERROR_PATTERN.test(text)) {
			sawAnchorErrorAt = index;
			anchorRecoveryTargetPath = eventPath(event) ?? expected.targetPath;
			readAfterAnchorErrorAt = -1;
			readAfterAnchorErrorPath = undefined;
			anchorErrorProvidedFreshAnchors = FRESH_ANCHOR_LINE_PATTERN.test(text);
			sawRecoveredAnchorError = false;
		}
		if (MALFORMED_ARGS_PATTERN.test(text)) {
			sawMalformedArgsAt = index;
			malformedArgsToolName = toolName;
			malformedArgsPath = eventPath(event) ?? expected.targetPath;
			sawSuccessAfterMalformedArgs = false;
		}
		if (isHardGuardFeedbackScenario && sawComposerBashPolicyBlockedIo && isReadEvent(event) && isSuccessfulToolEvent(event)) {
			const recoveryPath = eventPath(event);
			if (matchesNormalizedPath(expected.recoveryTargetPath, recoveryPath)) {
				sawComposerBashPolicyRecoveryTool = true;
			}
		}
		if (sawAnchorErrorAt >= 0 && index > sawAnchorErrorAt && isReadEvent(event) && isSuccessfulToolEvent(event)) {
			const readPath = eventPath(event);
			if (matchesNormalizedPath(anchorRecoveryTargetPath, readPath)) {
				readAfterAnchorErrorAt = index;
				readAfterAnchorErrorPath = readPath ?? anchorRecoveryTargetPath;
			}
		}
		if (
			sawAnchorErrorAt >= 0 &&
			index > sawAnchorErrorAt &&
			isSuccessfulEditEvent(event) &&
			(readAfterAnchorErrorAt >= 0 || anchorErrorProvidedFreshAnchors)
		) {
			const editPath = eventPath(event);
			if (matchesNormalizedPath(anchorRecoveryTargetPath ?? readAfterAnchorErrorPath, editPath)) {
				sawRecoveredAnchorError = true;
			}
		}
		if (sawMalformedArgsAt >= 0 && index > sawMalformedArgsAt && hasToolCall(event) && isSuccessfulToolEvent(event)) {
			const recoveryToolName = eventToolName(event);
			const recoveryPath = eventPath(event);
			if (
				(malformedArgsToolName === undefined || recoveryToolName === malformedArgsToolName) &&
				matchesNormalizedPath(malformedArgsPath, recoveryPath)
			) {
				sawSuccessAfterMalformedArgs = true;
			}
		}
		const expectedPath = asString(event.expectedPath);
		const actualPath = asString(event.actualPath) ?? eventPath(event);
		if (expectedPath && actualPath && path.normalize(expectedPath) !== path.normalize(actualPath)) {
			addFailure(failures, "wrong-file-edit");
		}
		if (expected.targetPath && toolName && EDIT_TOOL_NAMES.has(toolName)) {
			const targetPath = eventPath(event);
			const editPayload = `${stringifyArgs(eventArgs(event))}\n${text}`;
			const hasExpectedEditText = expected.expectedEditText === undefined || editPayload.includes(expected.expectedEditText);
			if (isSuccessfulEditEvent(event) && matchesNormalizedPath(expected.targetPath, targetPath) && hasExpectedEditText) {
				sawSuccessfulTargetPathEdit = true;
			}
			if (targetPath && !matchesNormalizedPath(expected.targetPath, targetPath)) {
				addFailure(failures, "wrong-file-edit");
			}
		}
		if (isTerminalSuccessEvent(event)) sawSuccessfulTerminal = true;
		if (isTerminalFailureEvent(event) && scenario && !composerBashPolicyBlocked) addFailure(failures, scenario.failureClass);
		const status = asString(event.status)?.toLowerCase();
		const directFailureClass = normalizeFailureClass(event.failureClass);
		if (directFailureClass && (status === "failed" || isEventError(event))) addFailure(failures, directFailureClass);
	}

	if (sawAnchorErrorAt >= 0 && !sawRecoveredAnchorError) {
		addFailure(failures, "bad-anchor-unrecovered");
	}
	if (sawMalformedArgsAt >= 0 && !sawSuccessAfterMalformedArgs) {
		addFailure(failures, "malformed-tool-args-unrecovered");
	}
	if (
		isHardGuardFeedbackScenario &&
		sawComposerBashPolicyBlockedIo &&
		(!sawComposerBashPolicyRecoveryTool || sawShellIoRetryAfterComposerBashPolicyBlock)
	) {
		addFailure(failures, "shell-read");
	}
	if (expected.targetPath && !sawSuccessfulTargetPathEdit) {
		addFailure(failures, "missing-tool-turn");
	}
	for (const requiredTool of expected.requiredTools ?? []) {
		if (!calledTools.has(requiredTool)) addFailure(failures, "missing-tool-turn");
	}
	if (expected.requireSuccess === true && !sawSuccessfulTerminal) {
		addFailure(failures, "missing-tool-turn");
	}

	const failureClasses = Array.from(failures).sort();
	if (failureClasses.length === 0) {
		return {
			status: "passed",
			failureClasses,
			evidence: `${record.scenarioId} trace satisfied trace classifier obligations`,
		};
	}
	return {
		status: "failed",
		failureClasses,
		evidence: `${record.scenarioId} trace failed: ${failureClasses.join(", ")}`,
	};
}

function normalizeTraceRecord(value: unknown, tracePath: string, fallbackTrial: number): TraceRecord | undefined {
	if (!isJsonObject(value)) return undefined;
	const scenarioId = normalizeScenarioId(value.scenarioId ?? value.scenario ?? value.id);
	const modelRole = normalizeRole(value.modelRole ?? value.role ?? value.side);
	if (!scenarioId || !modelRole) return undefined;
	const eventsValue = getNestedArray(value, "events") ?? getNestedArray(value, "trace") ?? [];
	const events = eventsValue.filter(isJsonObject);
	const model = asString(value.model) ?? (modelRole === "candidate" ? DEFAULT_MODEL : DEFAULT_BASELINE_MODEL);
	const trial = asNumber(value.trial) ?? fallbackTrial;
	return {
		scenarioId,
		modelRole,
		model,
		trial,
		events,
		expected: normalizeExpected(value.expected),
		tracePath,
	};
}

function hasEmbeddedTraceEvents(value: unknown): boolean {
	if (!isJsonObject(value)) return false;
	return Array.isArray(value.events) || Array.isArray(value.trace);
}

function aggregateEventLines(events: JsonObject[], tracePath: string): TraceRecord[] {
	if (events.length === 0) return [];
	const first = events[0]!;
	const scenarioId = normalizeScenarioId(first.scenarioId ?? first.scenario ?? first.id);
	const modelRole = normalizeRole(first.modelRole ?? first.role ?? first.side);
	if (!scenarioId || !modelRole) return [];
	return [
		{
			scenarioId,
			modelRole,
			model: asString(first.model) ?? (modelRole === "candidate" ? DEFAULT_MODEL : DEFAULT_BASELINE_MODEL),
			trial: asNumber(first.trial) ?? 0,
			events,
			expected: normalizeExpected(first.expected),
			tracePath,
		},
	];
}

function normalizeJsonTracePayload(payload: unknown, tracePath: string): TraceRecord[] {
	if (Array.isArray(payload)) {
		return payload
			.map((entry, index) => normalizeTraceRecord(entry, tracePath, index))
			.filter((record): record is TraceRecord => record !== undefined);
	}
	if (!isJsonObject(payload)) return [];
	const records = getNestedArray(payload, "records");
	if (records) {
		return records
			.map((entry, index) => normalizeTraceRecord(entry, tracePath, index))
			.filter((record): record is TraceRecord => record !== undefined);
	}
	const record = normalizeTraceRecord(payload, tracePath, 0);
	return record ? [record] : [];
}

function normalizeJsonlTracePayload(payload: string, tracePath: string): TraceRecord[] {
	const parsedLines = payload
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as unknown);
	const embeddedRecords = parsedLines
		.filter(hasEmbeddedTraceEvents)
		.map((entry, index) => normalizeTraceRecord(entry, tracePath, index))
		.filter((record): record is TraceRecord => record !== undefined);
	if (embeddedRecords.length > 0) return embeddedRecords;
	const events = parsedLines.filter(isJsonObject);
	return aggregateEventLines(events, tracePath);
}

async function resolveInputPath(inputPath: string): Promise<string> {
	if (path.isAbsolute(inputPath)) return inputPath;
	try {
		await fs.stat(inputPath);
		return inputPath;
	} catch {
		const repoPath = path.join(REPO_ROOT, inputPath);
		try {
			await fs.stat(repoPath);
			return repoPath;
		} catch {
			return inputPath;
		}
	}
}

async function loadTraceRecordsFromFile(tracePath: string): Promise<TraceRecord[]> {
	const content = await Bun.file(tracePath).text();
	const trimmed = content.trim();
	if (trimmed.length === 0) return [];
	if (/\.jsonl$/i.test(tracePath)) return normalizeJsonlTracePayload(trimmed, tracePath);
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return normalizeJsonTracePayload(JSON.parse(trimmed) as unknown, tracePath);
	}
	return normalizeJsonlTracePayload(trimmed, tracePath);
}

async function collectTraceFiles(traceDir: string): Promise<string[]> {
	const entries = await fs.readdir(traceDir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(traceDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTraceFiles(entryPath)));
		} else if (entry.isFile() && /\.(?:json|jsonl)$/i.test(entry.name)) {
			files.push(entryPath);
		}
	}
	return files.sort();
}

async function loadTraceRecords(
	options: CliOptions,
	tolerateErrors = false,
): Promise<{ records: TraceRecord[]; artifacts: TraceArtifact[] }> {
	const traceFiles = await Promise.all(options.tracePaths.map(resolveInputPath));
	if (options.traceDir) traceFiles.push(...(await collectTraceFiles(await resolveInputPath(options.traceDir))));
	const records: TraceRecord[] = [];
	const artifacts: TraceArtifact[] = [];
	for (const traceFile of traceFiles) {
		try {
			const loaded = await loadTraceRecordsFromFile(traceFile);
			records.push(...loaded);
			artifacts.push({ path: traceFile, records: loaded.length });
		} catch (error) {
			if (!tolerateErrors) throw error;
			const message = error instanceof Error ? error.message : String(error);
			artifacts.push({ path: traceFile, records: 0, error: message });
		}
	}
	return { records, artifacts };
}

export function createP1Summary(trialResults: TrialResult[], reason?: string): P1Summary {
	const candidateResults = trialResults.filter(result => result.modelRole === "candidate");
	const baselineResults = trialResults.filter(result => result.modelRole === "baseline");
	const candidateFailureCount = candidateResults.filter(result => result.status === "failed").length;
	const baselineFailureCount = baselineResults.filter(result => result.status === "failed").length;
	const candidateScenarioIds = new Set(candidateResults.map(result => result.scenarioId));
	const baselineScenarioIds = new Set(baselineResults.map(result => result.scenarioId));
	const comparableScenarioCount = Array.from(candidateScenarioIds).filter(scenarioId =>
		baselineScenarioIds.has(scenarioId),
	).length;
	const hasCandidate = candidateResults.length > 0;
	const hasBaseline = baselineResults.length > 0;
	const missingReason =
		reason ??
		(!hasCandidate
			? "no candidate trace records found"
			: !hasBaseline
				? "no baseline trace records found"
				: undefined);
	const coverageReason =
		!missingReason && comparableScenarioCount < MIN_COMPARABLE_TRACE_SCENARIOS
			? `insufficient comparable scenario coverage: ${comparableScenarioCount}/${MIN_COMPARABLE_TRACE_SCENARIOS}`
			: undefined;
	const applicable = hasCandidate && hasBaseline && !missingReason;
	const parityDelta = candidateFailureCount - baselineFailureCount;
	return {
		candidateFailureCount,
		baselineFailureCount,
		parityDelta,
		passed: applicable && !coverageReason && candidateFailureCount <= baselineFailureCount,
		applicable,
		...(missingReason || coverageReason ? { reason: missingReason ?? coverageReason } : {}),
	};
}

function summarizeScenarios(trialResults: TrialResult[]): ScenarioSummary[] {
	return SCENARIOS.map(scenario => ({
		id: scenario.id,
		fixture: scenario.fixture,
		description: scenario.description,
		turns: scenario.turns,
		obligation: scenario.obligation,
		failureClass: scenario.failureClass,
		recovery: scenario.recovery,
		candidateFailures: trialResults.filter(
			result => result.modelRole === "candidate" && result.scenarioId === scenario.id && result.status === "failed",
		).length,
		baselineFailures: trialResults.filter(
			result => result.modelRole === "baseline" && result.scenarioId === scenario.id && result.status === "failed",
		).length,
		traceRecords: trialResults.filter(result => result.scenarioId === scenario.id && result.tracePath).length,
	}));
}

function traceRecordToTrial(record: TraceRecord): TrialResult {
	const classified = classifyTraceRecord(record);
	return {
		scenarioId: record.scenarioId,
		modelRole: record.modelRole,
		model: record.model,
		trial: record.trial,
		status: classified.status,
		failureClass: classified.failureClasses[0],
		failureClasses: classified.failureClasses,
		evidence: classified.evidence,
		tracePath: record.tracePath,
	};
}

export async function run(options: CliOptions): Promise<BenchOutput> {
	const metadata = await benchRunMetadata();
	const command = ["bun", "packages/agent/bench/composer-stability-v3.ts", ...process.argv.slice(2)].join(" ");
	if (options.mode === "live") {
		const { records, artifacts } = await loadTraceRecords(options, true);
		if (records.length > 0) {
			const trialResults = records.map(traceRecordToTrial);
			return {
				schemaVersion: 1,
				command,
				bench: "composer-stability-v3",
				mode: "live",
				seed: options.seed,
				trialsPerScenario: options.trialsPerScenario,
				model: options.model,
				baselineModel: options.baselineModel,
				p1: createP1Summary(trialResults),
				scenarios: summarizeScenarios(trialResults),
				trialResults,
				traceArtifacts: artifacts,
				metadata,
			};
		}
		const skipReasons = resolveLiveSkipReasons(options);
		for (const artifact of artifacts) {
			if (artifact.error) {
				skipReasons.push(`SKIP live V3: could not parse trace artifact ${artifact.path}: ${artifact.error}`);
			}
		}
		if ((options.tracePaths.length > 0 || options.traceDir) && artifacts.every(artifact => artifact.records === 0)) {
			skipReasons.push("SKIP live V3: no scoreable trace records found in supplied trace artifacts");
		}
		if (skipReasons.length === 0) {
			skipReasons.push("SKIP live V3: no scoreable trace records found and live capture produced no trace artifacts");
		}
		return {
			schemaVersion: 1,
			command,
			bench: "composer-stability-v3",
			mode: options.mode,
			seed: options.seed,
			trialsPerScenario: options.trialsPerScenario,
			model: options.model,
			baselineModel: options.baselineModel,
			skipped: true,
			skipReasons,
			p1: createP1Summary([], skipReasons.join("; ")),
			scenarios: summarizeScenarios([]),
			trialResults: [],
			traceArtifacts: artifacts,
			metadata,
		};
	}
	if (options.mode === "trace") {
		const { records, artifacts } = await loadTraceRecords(options);
		if (records.length === 0) {
			const reason = "no trace records found; pass --trace-dir or --trace-file with candidate and baseline records";
			return {
				schemaVersion: 1,
				command,
				bench: "composer-stability-v3",
				mode: "trace",
				seed: options.seed,
				trialsPerScenario: options.trialsPerScenario,
				model: options.model,
				baselineModel: options.baselineModel,
				skipped: true,
				skipReasons: [reason],
				p1: createP1Summary([], reason),
				scenarios: summarizeScenarios([]),
				trialResults: [],
				traceArtifacts: artifacts,
				metadata,
			};
		}
		const trialResults = records.map(traceRecordToTrial);
		const p1 = createP1Summary(trialResults);
		return {
			schemaVersion: 1,
			command,
			bench: "composer-stability-v3",
			mode: "trace",
			seed: options.seed,
			trialsPerScenario: options.trialsPerScenario,
			model: options.model,
			baselineModel: options.baselineModel,
			p1,
			scenarios: summarizeScenarios(trialResults),
			trialResults,
			traceArtifacts: artifacts,
			metadata,
		};
	}

	const random = createSeededRandom(options.seed);
	const trialResults: TrialResult[] = [];
	for (const scenario of SCENARIOS) {
		for (let trial = 0; trial < options.trialsPerScenario; trial++) {
			trialResults.push(runMockTrial("candidate", options.model, scenario, trial, random));
			trialResults.push(runMockTrial("baseline", options.baselineModel, scenario, trial, random));
		}
	}
	return {
		schemaVersion: 1,
		command,
		bench: "composer-stability-v3",
		mode: options.mode,
		seed: options.seed,
		trialsPerScenario: options.trialsPerScenario,
		model: options.model,
		baselineModel: options.baselineModel,
		p1: createP1Summary(trialResults),
		scenarios: summarizeScenarios(trialResults),
		trialResults,
		metadata,
	};
}

function printText(output: BenchOutput): void {
	if (output.skipped) {
		console.log(output.skipReasons?.join("\n") ?? "SKIP composer-stability-v3");
		if (output.p1.reason) console.log(`p1=not-applicable reason=${output.p1.reason}`);
		return;
	}
	console.log(
		`composer-stability-v3 ${output.mode} seed=${output.seed} n=${output.trialsPerScenario} ` +
			`candidateFailures=${output.p1.candidateFailureCount} baselineFailures=${output.p1.baselineFailureCount} ` +
			`parityDelta=${output.p1.parityDelta} p1=${output.p1.passed ? "pass" : "fail"}`,
	);
}

async function main(): Promise<void> {
	try {
		const options = parseArgs(process.argv.slice(2));
		const output = await run(options);
		if (options.json) console.log(JSON.stringify(output, null, 2));
		else printText(output);
		if (!output.p1.passed && output.p1.applicable) process.exitCode = 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`composer-stability-v3 runner error: ${message}`);
		process.exitCode = 2;
	}
}

if (import.meta.main) {
	await main();
}
