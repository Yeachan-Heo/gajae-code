/// <reference types="../packages/typescript-edit-benchmark/src/bun-imports.d.ts" />
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@gajae-code/coding-agent";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import benchmarkCodeModeExecDescription from "./benchmark-code-mode-exec-description.md" with { type: "text" };
import benchmarkCodeModePrompts from "./benchmark-code-mode-prompts.md" with { type: "text" };
import benchmarkCodeModeTasks from "./benchmark-code-mode-tasks.md" with { type: "text" };

export const DEFAULT_MODEL = "openai/gpt-5.5";
export const TASK_COUNT = 8;
export const REPETITIONS_PER_TASK = 3;
export const MAX_PLAN_STEPS = 8;
export const MIN_PLAN_STEPS = 3;
export const MAX_PLAN_BYTES = 64_000;
export const MAX_STEP_TEXT_CHARS = 4_000;
export const MAX_REPORT_RESULT_CHARS = 32_000;
export const MAX_ATTEMPTS = 2;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const CLEANUP_TIMEOUT_MS = 10_000;
export const SCHEDULE_SEED = 5792;
export const BOOTSTRAP_REPETITIONS = 10_000;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SEARCH_CORPUS_SENTINELS = [
	"scripts/benchmark-code-mode.ts",
	"scripts/benchmark-code-mode.test.ts",
	"scripts/benchmark-code-mode-prompts.md",
	"scripts/benchmark-code-mode-tasks.md",
	"scripts/benchmark-code-mode-exec-description.md",
	"scripts/benchmark-code-mode-results.json",
	"scripts/benchmark-code-mode-runs.json.gz",
	"scripts/benchmark-code-mode-exploratory-results.json",
	"scripts/benchmark-code-mode-exploratory-runs.json.gz",
] as const;
const SYSTEM_PROMPT = benchmarkCodeModePrompts.trim();
const RUN_RETRY_REASON = "The preceding attempt did not reach a validated final answer.";

export interface BenchmarkTask {
	id: string;
	title: string;
	prompt: string;
	dependencyRequirements: string[];
	initialSearchQuery: string;
	requiredFollowupSearchTerm: string;
	requiredAnswerTerms: string[];
}

export interface ScriptPlanStep {
	id: string;
	tool: "read" | "search";
	input: Record<string, unknown>;
}

export interface ScriptPlan {
	steps: ScriptPlanStep[];
}

export interface ScriptReference {
	$ref: string;
	select: string;
	contains?: string;
}

export interface ScriptResultRecord {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface PairedRequestCount {
	taskId: string;
	aRequests: number;
	bRequests: number;
	aGreen: boolean;
	bGreen: boolean;
}

export interface DecisionSummary {
	medianPairedRequestReduction: number | null;
	medianPairedPercentReduction: number | null;
	bootstrap95CI: { lower: number; upper: number } | null;
	armAGreenRate: number | null;
	armBGreenRate: number | null;
	completionRateDrop: number | null;
	pass: boolean;
}

type Arm = "A" | "B";
type AnyAgentTool = AgentTool<z.ZodType, unknown>;
type JSONRecord = Record<string, unknown>;

const EXEC_PARAMETERS = z.object({ input: z.string().min(1) }).strict();
type ExecAgentTool = AgentTool<typeof EXEC_PARAMETERS, unknown>;

const EXEC_PLAN_LARK_GRAMMAR = String.raw`
start: "{" "\"steps\"" ":" "[" step ("," step)* "]" "}"
step: "{" "\"id\"" ":" ESCAPED_STRING "," "\"tool\"" ":" tool "," "\"input\"" ":" object "}"
tool: "\"read\"" | "\"search\""
object: "{" [pair ("," pair)*] "}"
pair: ESCAPED_STRING ":" value
?value: object | array | ESCAPED_STRING | SIGNED_NUMBER | "true" | "false" | "null"
array: "[" [value ("," value)*] "]"
%import common.ESCAPED_STRING
%import common.SIGNED_NUMBER
%import common.WS
%ignore WS
`.trim();

export function renderExecDescription(
	readTool: Pick<AnyAgentTool, "description" | "parameters">,
	searchTool: Pick<AnyAgentTool, "description" | "parameters">,
): string {
	return prompt
		.render(benchmarkCodeModeExecDescription, {
			read_description: readTool.description,
			read_schema: JSON.stringify(z.toJSONSchema(readTool.parameters), null, "\t"),
			search_description: searchTool.description,
			search_schema: JSON.stringify(z.toJSONSchema(searchTool.parameters), null, "\t"),
		})
		.trim();
}

function isRecord(value: unknown): value is JSONRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectExactKeys(value: JSONRecord, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${label} must contain exactly these keys: ${wanted.join(", ")}.`);
	}
}

function validateReferenceShape(value: JSONRecord): ScriptReference {
	expectExactKeys(
		value,
		value.contains === undefined ? ["$ref", "select"] : ["$ref", "select", "contains"],
		"Reference",
	);
	if (typeof value.$ref !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value.$ref)) {
		throw new Error("Reference $ref must be a valid earlier step ID.");
	}
	if (
		typeof value.select !== "string" ||
		!/^[$A-Za-z_][A-Za-z0-9_$]*(?:\.(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+))*$/.test(value.select) ||
		value.select
			.split(".")
			.some(segment => segment === "__proto__" || segment === "prototype" || segment === "constructor")
	) {
		throw new Error("Reference select must be a safe dot-path into an earlier result.");
	}
	if (
		value.contains !== undefined &&
		(typeof value.contains !== "string" || value.contains.length === 0 || value.contains.length > 256)
	) {
		throw new Error("Reference contains must be a non-empty literal of at most 256 characters.");
	}
	return {
		$ref: value.$ref,
		select: value.select,
		...(typeof value.contains === "string" ? { contains: value.contains } : {}),
	};
}

function collectReferences(value: unknown, result: ScriptReference[] = []): ScriptReference[] {
	if (Array.isArray(value)) {
		for (const entry of value) collectReferences(entry, result);
		return result;
	}
	if (!isRecord(value)) return result;
	if (Object.hasOwn(value, "$ref")) {
		result.push(validateReferenceShape(value));
		return result;
	}
	for (const child of Object.values(value)) collectReferences(child, result);
	return result;
}

function getDependencyValue(step: ScriptPlanStep): unknown[] {
	if (step.tool === "read") return [step.input.path];
	return [step.input.pattern, step.input.paths];
}

function findStepMarkers(value: unknown, result: ScriptReference[] = []): ScriptReference[] {
	return collectReferences(value, result);
}

function normalizeSearchPattern(value: string): string {
	return value.replace(/\\[bB]/g, "").replace(/\\([\\^$.*+?()[\]{}|])/g, "$1");
}

/** Validate the constrained JSON plan before any repository tool is executed. */
export function validateScriptPlan(value: unknown, task?: BenchmarkTask): ScriptPlan {
	if (!isRecord(value)) throw new Error("Script plan must be a JSON object.");
	expectExactKeys(value, ["steps"], "Script plan");
	if (!Array.isArray(value.steps) || value.steps.length < MIN_PLAN_STEPS || value.steps.length > MAX_PLAN_STEPS) {
		throw new Error(`Script plan must contain ${MIN_PLAN_STEPS}–${MAX_PLAN_STEPS} ordered steps.`);
	}
	const seen = new Set<string>();
	const steps: ScriptPlanStep[] = [];
	for (let index = 0; index < value.steps.length; index++) {
		const rawStep = value.steps[index];
		if (!isRecord(rawStep)) throw new Error(`Step ${index + 1} must be an object.`);
		expectExactKeys(rawStep, ["id", "tool", "input"], `Step ${index + 1}`);
		if (typeof rawStep.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(rawStep.id)) {
			throw new Error(`Step ${index + 1} has an invalid ID.`);
		}
		if (seen.has(rawStep.id)) throw new Error(`Duplicate step ID: ${rawStep.id}.`);
		if (rawStep.tool !== "read" && rawStep.tool !== "search") {
			throw new Error(`Step ${index + 1} tool must be read or search.`);
		}
		if (!isRecord(rawStep.input)) throw new Error(`Step ${index + 1} input must be an object.`);
		const step: ScriptPlanStep = { id: rawStep.id, tool: rawStep.tool, input: rawStep.input };
		const refs = findStepMarkers(step.input);
		for (const ref of refs) {
			if (!seen.has(ref.$ref)) {
				throw new Error(`Step ${step.id} references unknown or forward step ${ref.$ref}.`);
			}
		}
		if (index > 0) {
			const previousId = steps[index - 1]!.id;
			const dependencyRefs = getDependencyValue(step).flatMap(value => findStepMarkers(value));
			if (!dependencyRefs.some(ref => ref.$ref === previousId)) {
				throw new Error(`Step ${step.id} path/query must reference the immediately preceding step ${previousId}.`);
			}
		}
		seen.add(step.id);
		steps.push(step);
	}
	const plan = { steps };
	if (task) validateTaskPlan(plan, task);
	return plan;
}

function validateTaskPlan(plan: ScriptPlan, task: BenchmarkTask): void {
	const initial = plan.steps[0]!;
	if (initial.tool !== "search" || typeof initial.input.pattern !== "string") {
		throw new Error(`Task ${task.id} must start with a repository-wide search.`);
	}
	if (!normalizeSearchPattern(initial.input.pattern).includes(task.initialSearchQuery)) {
		throw new Error(`Task ${task.id} initial search must include ${task.initialSearchQuery}.`);
	}
	if (initial.input.paths != null) throw new Error(`Task ${task.id} initial search must not constrain paths.`);
}

/** Parse JSON only; no JavaScript or other language is ever evaluated. */
export function parseScriptPlan(input: string, task?: BenchmarkTask): ScriptPlan {
	const inputBytes = new TextEncoder().encode(input).byteLength;
	if (inputBytes === 0 || inputBytes > MAX_PLAN_BYTES) {
		throw new Error(`Script plan text must be between 1 and ${MAX_PLAN_BYTES} bytes.`);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(input);
	} catch (error) {
		throw new Error(`Script plan is not valid JSON: ${safeError(error)}`);
	}
	return validateScriptPlan(decoded, task);
}

function getSelectedValue(root: unknown, select: string): unknown {
	let current = root;
	for (const segment of select.split(".")) {
		if (Array.isArray(current)) {
			if (!/^\d+$/.test(segment)) throw new Error(`Reference path ${select} does not resolve.`);
			current = current[Number(segment)];
		} else if (isRecord(current) && Object.hasOwn(current, segment)) {
			current = current[segment];
		} else {
			throw new Error(`Reference path ${select} does not resolve.`);
		}
	}
	if (typeof current === "string") return current;
	if (Array.isArray(current) && current.every(entry => typeof entry === "string")) return current;
	throw new Error(`Reference path ${select} must resolve to a string or an array of strings.`);
}

/** Resolve a reference by selecting safe result data; no expression parsing is involved. */
export function resolveScriptReferences(value: unknown, results: ReadonlyMap<string, ScriptResultRecord>): unknown {
	if (Array.isArray(value)) return value.map(entry => resolveScriptReferences(entry, results));
	if (!isRecord(value)) return value;
	if (Object.hasOwn(value, "$ref")) {
		const ref = validateReferenceShape(value);
		const priorResult = results.get(ref.$ref);
		if (!priorResult) throw new Error(`Reference ${ref.$ref} is unknown or forward.`);
		const selected = getSelectedValue(priorResult, ref.select);
		if (ref.contains !== undefined) {
			if (typeof selected !== "string" || !selected.includes(ref.contains)) {
				throw new Error(`Reference ${ref.$ref} result does not contain the requested literal.`);
			}
			return ref.contains;
		}
		return selected;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, resolveScriptReferences(child, results)]),
	);
}

export function validateScriptToolArguments(
	toolName: "read" | "search",
	tool: Pick<AnyAgentTool, "parameters">,
	input: unknown,
): Record<string, unknown> {
	const parsed = tool.parameters.safeParse(input);
	if (!parsed.success) {
		throw new Error(
			`${toolName} arguments failed tool schema validation: ${parsed.error.issues.map(issue => issue.message).join("; ")}`,
		);
	}
	if (!isRecord(parsed.data)) throw new Error(`${toolName} schema must resolve to an argument object.`);
	return parsed.data;
}

export function parseBenchmarkTasks(markdown: string): BenchmarkTask[] {
	const markers = [...markdown.matchAll(/^## TASK ([A-Z0-9-]+) \| ([^\n]+)$/gm)];
	if (markers.length !== TASK_COUNT)
		throw new Error(`Pre-registered task file must contain exactly ${TASK_COUNT} tasks; found ${markers.length}.`);
	const tasks = markers.map((marker, index): BenchmarkTask => {
		const bodyStart = marker.index! + marker[0].length;
		const bodyEnd = markers[index + 1]?.index ?? markdown.length;
		const body = markdown.slice(bodyStart, bodyEnd).trim();
		const sections =
			/^Prompt:\s*\n([\s\S]*?)\nDependency contract:\s*\n([\s\S]*?)\nFinal answer:\s*\n([\s\S]*)$/.exec(body);
		if (!sections)
			throw new Error(`Task ${marker[1]} must declare Prompt, Dependency contract, and Final answer sections.`);
		const dependencyRequirements = sections[2]!
			.split("\n")
			.map(line => line.trim())
			.filter(line => /^\d+\./.test(line));
		if (dependencyRequirements.length < MIN_PLAN_STEPS) {
			throw new Error(`Task ${marker[1]} must require at least ${MIN_PLAN_STEPS} dependent calls.`);
		}
		if (
			!/^1\.\s+Search\b.*without a `paths` filter/i.test(dependencyRequirements[0]!) ||
			!/^2\.\s+Read\b.*path returned by that search/i.test(dependencyRequirements[1]!) ||
			!/^3\.\s+Search\b.*copied identifier `[^`]+` from the immediately preceding read/i.test(dependencyRequirements[2]!) ||
			sections[3]!.trim().length === 0
		) {
			throw new Error(
				`Task ${marker[1]} must require a search → dependent read → dependent search chain and define an answer.`,
			);
		}
		const requiredTermsLine = /^Required answer terms:\s*(.+)$/m.exec(sections[3]!);
		const requiredAnswerTerms = [...(requiredTermsLine?.[1] ?? "").matchAll(/`([^`]+)`/g)].map(match =>
			match[1]!.trim(),
		);
		if (requiredAnswerTerms.length < 2 || requiredAnswerTerms.some(term => term.length === 0)) {
			throw new Error(`Task ${marker[1]} must pre-register at least two required answer terms.`);
		}
		const initialSearchQuery = /Start with a repository-wide search for `([^`]+)`/i.exec(sections[1]!)?.[1];
		const requiredFollowupSearchTerm = /^3\.\s+Search\b.*copied identifier `([^`]+)`/i.exec(dependencyRequirements[2]!)?.[1];
		if (!initialSearchQuery || !requiredFollowupSearchTerm) {
			throw new Error(`Task ${marker[1]} must freeze an initial query and a distinctive follow-up search term.`);
		}
		const prompt = [
			sections[1]!.trim(),
			"",
			"## Required dependent-call contract",
			dependencyRequirements.join("\n"),
			"",
			sections[3]!.trim(),
			"",
			"Follow the numbered dependency contract exactly. Use only the available read/search capability. Make one call at a time in Arm A; in Arm B, put the full ordered chain in one exec plan. Every call after the first must use path or query data from the immediately preceding result.",
			"",
			"Return only a JSON object with exactly two keys: `answer` (a concise string) and `evidence` (an array of at least three short exact strings copied from your tool results). Every evidence string must be directly supported by a tool result.",
		].join("\n");
		return {
			id: marker[1]!,
			title: marker[2]!.trim(),
			prompt,
			dependencyRequirements,
			initialSearchQuery,
			requiredFollowupSearchTerm,
			requiredAnswerTerms,
		};
	});
	if (new Set(tasks.map(task => task.id)).size !== TASK_COUNT)
		throw new Error("Pre-registered task IDs must be unique.");
	return tasks;
}

const TASKS = parseBenchmarkTasks(benchmarkCodeModeTasks);

function resultContentText(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	return result.content
		.map(item => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
		.filter(Boolean)
		.join("\n");
}

function boundedValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return typeof value === "string" ? value.slice(0, MAX_STEP_TEXT_CHARS) : value;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value !== "object") return `[${typeof value}]`;
	if (depth >= 8) return "[Maximum detail depth reached]";
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.slice(0, 100).map(item => boundedValue(item, depth + 1, seen));
	const entries = Object.entries(value as JSONRecord).slice(0, 100);
	return Object.fromEntries(entries.map(([key, entry]) => [key, boundedValue(entry, depth + 1, seen)]));
}

function projectToolDetails(value: unknown): unknown {
	if (!isRecord(value)) return boundedValue(value);
	const priorityKeys = [
		"files",
		"resolvedPath",
		"scopePath",
		"searchPath",
		"fileMatches",
		"matchCount",
		"fileCount",
		"kind",
		"truncated",
		"error",
		"isDirectory",
		"truncation",
	];
	const projected: JSONRecord = {};
	for (const key of priorityKeys) {
		if (!Object.hasOwn(value, key)) continue;
		const raw = value[key];
		const limited = (key === "files" || key === "fileMatches") && Array.isArray(raw) ? raw.slice(0, 20) : raw;
		const candidate = { ...projected, [key]: boundedValue(limited) };
		if (JSON.stringify(candidate).length <= MAX_STEP_TEXT_CHARS) Object.assign(projected, { [key]: candidate[key] });
	}
	return projected;
}

function projectToolResult(result: AgentToolResult): ScriptResultRecord {
	const content = Array.isArray(result.content)
		? result.content.slice(0, 40).map(item => {
				const contentItem = item as { type?: unknown; text?: unknown };
				return {
					type: typeof contentItem.type === "string" ? contentItem.type : "unknown",
					...(typeof contentItem.text === "string"
						? { text: contentItem.text.slice(0, MAX_STEP_TEXT_CHARS) }
						: {}),
				};
			})
		: [];
	return {
		content,
		...(result.details !== undefined ? { details: projectToolDetails(result.details) } : {}),
		...(result.isError !== undefined ? { isError: result.isError } : {}),
	};
}

function resultSearchableText(result: ScriptResultRecord): string {
	const contentText = resultContentText(result).slice(0, MAX_STEP_TEXT_CHARS);
	let detailsText = "";
	try {
		detailsText = result.details === undefined ? "" : JSON.stringify(result.details);
	} catch {
		detailsText = "";
	}
	return `${contentText}\n${detailsText.slice(0, MAX_STEP_TEXT_CHARS)}`;
}

function getPathOrQueryStrings(toolName: string, args: unknown): string[] {
	if (!isRecord(args)) return [];
	const candidates = toolName === "read" ? [args.path] : [args.pattern, args.paths];
	const strings: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") strings.push(value);
		else if (Array.isArray(value)) for (const entry of value) collect(entry);
	};
	for (const candidate of candidates) collect(candidate);
	return strings.filter(value => value.trim().length >= 3);
}

export function usesPreviousResult(toolName: string, args: unknown, previousResult: string): boolean {
	return getPathOrQueryStrings(toolName, args).some(value => {
		const distinctive = value.length >= 6 || value.includes("/") || value.includes(".");
		if (distinctive && previousResult.includes(value)) return true;
		if (toolName === "read") {
			const pathWithoutLineSelector = value.split(/:(?=\d)/, 1)[0];
			if (
				pathWithoutLineSelector &&
				(pathWithoutLineSelector.length >= 6 ||
					pathWithoutLineSelector.includes("/") ||
					pathWithoutLineSelector.includes(".")) &&
				previousResult.includes(pathWithoutLineSelector)
			) {
				return true;
			}
		}
		const normalized = normalizeSearchPattern(value);
		if (normalized !== value && normalized.length >= 6 && previousResult.includes(normalized)) return true;
		const distinctiveTerms = normalized.match(/[A-Za-z0-9_$.-]{6,}/g) ?? [];
		return distinctiveTerms.some(term => previousResult.includes(term));
	});
}

export function validateTaskCallSequence(
	task: Pick<BenchmarkTask, "id" | "initialSearchQuery" | "requiredFollowupSearchTerm">,
	entries: readonly Pick<AToolTraceEntry, "toolName" | "args" | "resultText">[],
): string[] {
	const reasons: string[] = [];
	const initial = entries[0];
	if (!initial || initial.toolName !== "search" || !isRecord(initial.args) || typeof initial.args.pattern !== "string") {
		return [`Task ${task.id} must start with its registered repository-wide search.`];
	}
	if (entries.length < MIN_PLAN_STEPS) reasons.push(`Task ${task.id} completed fewer than ${MIN_PLAN_STEPS} dependent calls.`);
	if (!normalizeSearchPattern(initial.args.pattern).includes(task.initialSearchQuery)) {
		reasons.push(`Task ${task.id} initial search did not contain ${task.initialSearchQuery}.`);
	}
	if (initial.args.paths != null) reasons.push(`Task ${task.id} initial search constrained paths.`);
	return reasons;
}

interface AToolTraceEntry {
	callId: string;
	toolName: string;
	args: unknown;
	startOrder: number;
	endOrder?: number;
	result?: ScriptResultRecord;
	resultText?: string;
	isError?: boolean;
}

interface BStepTraceEntry {
	id: string;
	tool: "read" | "search";
	resolvedInput: Record<string, unknown>;
	result?: ScriptResultRecord;
	resultText?: string;
	isError?: boolean;
}

interface BExecTraceEntry {
	callId: string;
	input: string;
	plan?: ScriptPlan;
	steps: BStepTraceEntry[];
	errors: string[];
}

interface TraceValidation {
	valid: boolean;
	reasons: string[];
	toolResultText: string;
}

function validateATrace(entries: readonly AToolTraceEntry[], task: BenchmarkTask): TraceValidation {
	const reasons: string[] = [];
	const ordered = [...entries].sort((left, right) => left.startOrder - right.startOrder);
	if (ordered.length < MIN_PLAN_STEPS) reasons.push(`Expected at least ${MIN_PLAN_STEPS} read/search calls.`);
	reasons.push(...validateTaskCallSequence(task, ordered));
	for (let index = 0; index < ordered.length; index++) {
		const current = ordered[index]!;
		if (current.toolName !== "read" && current.toolName !== "search")
			reasons.push(`Unsupported Arm A call: ${current.toolName}.`);
		if (current.endOrder === undefined || !current.result || current.isError) {
			reasons.push(`Arm A call ${current.callId} did not complete successfully.`);
			continue;
		}
		if (index > 0) {
			const previous = ordered[index - 1]!;
			if (previous.endOrder === undefined || previous.endOrder >= current.startOrder) {
				reasons.push(`Arm A call ${current.callId} started before its predecessor completed.`);
			}
			if (!previous.resultText || !usesPreviousResult(current.toolName, current.args, previous.resultText)) {
				reasons.push(`Arm A call ${current.callId} path/query did not use data from the preceding result.`);
			}
		}
	}
	return {
		valid: reasons.length === 0,
		reasons,
		toolResultText: ordered
			.map(entry => entry.resultText ?? "")
			.join("\n")
			.slice(0, MAX_REPORT_RESULT_CHARS),
	};
}

function validateBTrace(entries: readonly BExecTraceEntry[], task: BenchmarkTask): TraceValidation {
	const reasons: string[] = [];
	if (entries.length !== 1) reasons.push("Arm B must complete exactly one exec call containing the whole plan.");
	const steps = entries.flatMap(entry => entry.steps);
	if (steps.length < MIN_PLAN_STEPS)
		reasons.push(`Expected at least ${MIN_PLAN_STEPS} executed read/search steps in the plan.`);
	const first = steps[0];
	const second = steps[1];
	const third = steps[2];
	if (!first || first.tool !== "search" || typeof first.resolvedInput.pattern !== "string") {
		reasons.push(`Task ${task.id} Arm B must start with its registered repository-wide search.`);
	} else {
		if (!normalizeSearchPattern(first.resolvedInput.pattern).includes(task.initialSearchQuery)) {
			reasons.push(`Task ${task.id} Arm B initial search omitted ${task.initialSearchQuery}.`);
		}
		if (first.resolvedInput.paths != null) reasons.push(`Task ${task.id} Arm B initial search constrained paths.`);
	}
	if (!second || second.tool !== "read") reasons.push(`Task ${task.id} Arm B second step must be a read.`);
	if (!third || third.tool !== "search" || typeof third.resolvedInput.pattern !== "string") {
		reasons.push(`Task ${task.id} Arm B third step must be the registered follow-up search.`);
	} else if (!normalizeSearchPattern(third.resolvedInput.pattern).includes(task.requiredFollowupSearchTerm)) {
		reasons.push(`Task ${task.id} Arm B follow-up search omitted ${task.requiredFollowupSearchTerm}.`);
	}
	for (let index = 0; index < steps.length; index++) {
		const current = steps[index]!;
		if (current.isError || !current.result || !current.resultText)
			reasons.push(`Arm B step ${current.id} did not complete successfully.`);
		if (index > 0) {
			const previous = steps[index - 1]!;
			if (!previous.resultText || !usesPreviousResult(current.tool, current.resolvedInput, previous.resultText)) {
				reasons.push(`Arm B step ${current.id} path/query did not use data from the preceding result.`);
			}
		}
	}
	for (const call of entries) reasons.push(...call.errors.map(error => `Arm B exec: ${error}`));
	return {
		valid: reasons.length === 0,
		reasons,
		toolResultText: steps
			.map(step => step.resultText ?? "")
			.join("\n")
			.slice(0, MAX_REPORT_RESULT_CHARS),
	};
}

export function validateFinalAnswer(
	text: string,
	trace: TraceValidation,
	requiredAnswerTerms: readonly string[],
): { valid: boolean; reasons: string[] } {
	const reasons = [...trace.reasons];
	if (!trace.valid) return { valid: false, reasons };
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch {
		return { valid: false, reasons: ["Final answer is not valid JSON."] };
	}
	if (!isRecord(decoded)) return { valid: false, reasons: ["Final answer must be a JSON object."] };
	const keys = Object.keys(decoded).sort();
	if (keys.length !== 2 || keys[0] !== "answer" || keys[1] !== "evidence") {
		reasons.push("Final answer must contain exactly answer and evidence keys.");
	}
	if (typeof decoded.answer !== "string" || decoded.answer.trim().length === 0) {
		reasons.push("Final answer answer field must be a non-empty string.");
	} else {
		const answer = decoded.answer.toLowerCase();
		for (const term of requiredAnswerTerms) {
			if (!answer.includes(term.toLowerCase()))
				reasons.push(`Final answer is missing required task-specific term: ${term}.`);
		}
	}
	if (
		!Array.isArray(decoded.evidence) ||
		decoded.evidence.length < 3 ||
		decoded.evidence.some(value => typeof value !== "string" || value.trim().length === 0)
	) {
		reasons.push("Final answer evidence must contain at least three non-empty strings.");
	} else {
		for (const item of decoded.evidence as string[]) {
			if (!trace.toolResultText.includes(item))
				reasons.push("Final answer contains evidence not found verbatim in tool results.");
		}
	}
	return { valid: reasons.length === 0, reasons };
}

function extractAssistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.map(item => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
		.filter(Boolean)
		.join("\n");
}

function safeError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text
		.replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/\b((?:sk|pk|rk)-)[A-Za-z0-9_-]{12,}\b/g, "$1[REDACTED]")
		.slice(0, 2_000);
}

function createExecTool(
	readTool: AnyAgentTool,
	searchTool: AnyAgentTool,
	task: BenchmarkTask,
): { tool: ExecAgentTool; calls: BExecTraceEntry[] } {
	const calls: BExecTraceEntry[] = [];
	const handlers = { read: readTool, search: searchTool };
	const outputForModel = (call: BExecTraceEntry, textLimit: number): string =>
		JSON.stringify({
			steps: call.steps.map(step => ({
				id: step.id,
				tool: step.tool,
				result: (step.resultText ?? "").slice(0, textLimit),
				...(step.isError ? { isError: true } : {}),
			})),
			...(call.errors.length > 0 ? { errors: call.errors.map(error => error.slice(0, textLimit)) } : {}),
		});
	const boundedOutputForModel = (call: BExecTraceEntry): string => {
		let limit = MAX_STEP_TEXT_CHARS;
		let serialized = outputForModel(call, limit);
		while (serialized.length > MAX_REPORT_RESULT_CHARS && limit > 1) {
			limit = Math.floor(limit / 2);
			serialized = outputForModel(call, limit);
		}
		return serialized.slice(0, MAX_REPORT_RESULT_CHARS);
	};
	const tool: ExecAgentTool = {
		name: "exec",
		customWireName: "exec",
		label: "Exec plan",
		description: renderExecDescription(readTool, searchTool),
		parameters: EXEC_PARAMETERS,
		strict: true,
		intent: "omit",
		concurrency: "exclusive",
		customFormat: { syntax: "lark", definition: EXEC_PLAN_LARK_GRAMMAR },
		async execute(toolCallId, params, signal, _onUpdate, _context: AgentToolContext | undefined) {
			const call: BExecTraceEntry = { callId: toolCallId, input: params.input, steps: [], errors: [] };
			calls.push(call);
			try {
				call.plan = parseScriptPlan(params.input, task);
				const previousResults = new Map<string, ScriptResultRecord>();
				for (const step of call.plan.steps) {
					const input = resolveScriptReferences(step.input, previousResults);
					if (!isRecord(input)) throw new Error(`Step ${step.id} input must resolve to an object.`);
					const handler = handlers[step.tool];
					const parsed = validateScriptToolArguments(step.tool, handler, input);
					const trace: BStepTraceEntry = {
						id: step.id,
						tool: step.tool,
						resolvedInput: boundedValue(parsed) as Record<string, unknown>,
					};
					call.steps.push(trace);
					const result = await handler.execute(`${toolCallId}:${step.id}`, parsed, signal, undefined, undefined);
					trace.result = projectToolResult(result);
					trace.resultText = resultSearchableText(trace.result);
					trace.isError = result.isError === true;
					previousResults.set(step.id, trace.result);
					if (trace.isError) {
						call.errors.push(`Step ${step.id} returned an error.`);
						break;
					}
				}
				const text = boundedOutputForModel(call);
				return { content: [{ type: "text", text }], ...(call.errors.length > 0 ? { isError: true } : {}) };
			} catch (error) {
				call.errors.push(safeError(error));
				const text = boundedOutputForModel(call);
				return { content: [{ type: "text", text }], isError: true };
			}
		},
	};
	return { tool, calls };
}

function sessionOptions(params: {
	cwd: string;
	model: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	toolNames: string[];
}): Parameters<typeof createAgentSession>[0] {
	return {
		cwd: params.cwd,
		modelPattern: params.model,
		authStorage: params.authStorage,
		modelRegistry: params.modelRegistry,
		sessionManager: SessionManager.inMemory(params.cwd),
		systemPrompt: [SYSTEM_PROMPT],
		toolNames: params.toolNames,
		hasUI: false,
		enableMCP: false,
		enableMcpAutoload: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
	};
}

async function disposeSessionResult(result: CreateAgentSessionResult | undefined): Promise<void> {
	if (!result) return;
	await result.session.dispose();
	await (result.mcpManager as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
}

function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
	onTimeout?: () => void,
	onLateResolve?: (value: T) => void | Promise<void>,
): Promise<T> {
	const completion = Promise.withResolvers<T>();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		onTimeout?.();
		completion.reject(new Error(message));
	}, Math.max(1, timeoutMs));
	operation.then(
		value => {
			if (timedOut) {
				void Promise.resolve(onLateResolve?.(value)).catch(() => {});
				return;
			}
			completion.resolve(value);
		},
		error => completion.reject(error),
	);
	return completion.promise.finally(() => clearTimeout(timer));
}

async function disposeSessionResultBounded(result: CreateAgentSessionResult | undefined): Promise<void> {
	if (!result) return;
	await withTimeout(
		disposeSessionResult(result),
		CLEANUP_TIMEOUT_MS,
		`Session cleanup exceeded ${CLEANUP_TIMEOUT_MS} ms.`,
	);
}

function modelKey(model: Model | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function getRequiredTool(session: AgentSession, name: string): AnyAgentTool {
	const tool = session.agent.state.tools.find(candidate => candidate.name === name);
	if (!tool) throw new Error(`GJC ${name} AgentTool was not active in the handler session.`);
	return tool;
}

function getAttemptTraceValidation(
	arm: Arm,
	aTrace: AToolTraceEntry[],
	bTrace: BExecTraceEntry[],
	task: BenchmarkTask,
): TraceValidation {
	return arm === "A" ? validateATrace(aTrace, task) : validateBTrace(bTrace, task);
}

interface AttemptMetrics {
	modelRequestCount: number;
	assistantTurnCount: number;
	assistantTurnsToGreen: number | null;
	providerInputTokens: number | null;
	modelFacingToolCalls: number;
	readSearchHandlerCalls: number;
}

interface AttemptRecord {
	attemptNumber: number;
	retryReason?: string;
	arm: Arm;
	model: string;
	startedAt: string;
	finishedAt: string;
	green: boolean;
	finalAnswer: string | null;
	validation: { valid: boolean; reasons: string[] };
	errors: string[];
	metrics: AttemptMetrics;
	trace: {
		functionCalls: AToolTraceEntry[];
		execCalls: BExecTraceEntry[];
	};
}

async function runAttempt(params: {
	arm: Arm;
	task: BenchmarkTask;
	model: string;
	workspaceRoot: string;
	timeoutMs: number;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	readTool: AnyAgentTool;
	searchTool: AnyAgentTool;
	systemPrompt: string;
	attemptNumber: number;
	retryReason?: string;
}): Promise<AttemptRecord> {
	const startedAt = new Date().toISOString();
	const deadlineStartedAt = Date.now();
	const remainingMs = (): number => Math.max(1, params.timeoutMs - (Date.now() - deadlineStartedAt));
	const errors: string[] = [];
	const aTrace: AToolTraceEntry[] = [];
	const pending = new Map<string, AToolTraceEntry>();
	const exec = params.arm === "B" ? createExecTool(params.readTool, params.searchTool, params.task) : undefined;
	let result: CreateAgentSessionResult | undefined;
	let unsubscribe = (): void => {};
	let modelRequestCount = 0;
	let assistantTurnCount = 0;
	let assistantTurnsToGreen: number | null = null;
	let modelFacingToolCalls = 0;
	let providerInputTokens: number | null = null;
	let finalAnswer: string | null = null;
	let validation: { valid: boolean; reasons: string[] } = {
		valid: false,
		reasons: ["No validated final answer was observed."],
	};
	let timedOut = false;
	try {
		const creatingSession = createAgentSession(
			sessionOptions({
				cwd: params.workspaceRoot,
				model: params.model,
				authStorage: params.authStorage,
				modelRegistry: params.modelRegistry,
				toolNames: [],
			}),
		);
		result = await withTimeout(
			creatingSession,
			remainingMs(),
			`Run exceeded timeout of ${params.timeoutMs} ms during session setup.`,
			() => {
				timedOut = true;
			},
			lateResult => disposeSessionResultBounded(lateResult),
		);
		const session = result.session;
		if (modelKey(session.model) !== params.model) {
			throw new Error(
				`Resolved model mismatch: requested ${params.model}, received ${modelKey(session.model) ?? "none"}.`,
			);
		}
		const activeTools = params.arm === "A" ? [params.readTool, params.searchTool] : [exec!.tool];
		session.agent.setTools(activeTools);
		const names = session.agent.state.tools.map(tool => tool.name);
		const expectedNames = params.arm === "A" ? ["read", "search"] : ["exec"];
		if (names.length !== expectedNames.length || expectedNames.some(name => !names.includes(name))) {
			throw new Error(`Unexpected active ${params.arm} tools: ${names.join(", ")}.`);
		}
		if (JSON.stringify(session.systemPrompt) !== JSON.stringify([params.systemPrompt])) {
			throw new Error("System prompt changed between benchmark arms.");
		}
		let eventOrder = 0;
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "turn_start") {
				modelRequestCount++;
				return;
			}
			if (event.type === "tool_execution_start") {
				const trace: AToolTraceEntry = {
					callId: event.toolCallId,
					toolName: event.toolName,
					args: boundedValue(event.args),
					startOrder: ++eventOrder,
				};
				if (params.arm === "A") aTrace.push(trace);
				pending.set(event.toolCallId, trace);
				return;
			}
			if (event.type === "tool_execution_end") {
				const trace = pending.get(event.toolCallId);
				if (trace) {
					trace.endOrder = ++eventOrder;
					trace.result = projectToolResult(event.result as AgentToolResult);
					trace.resultText = resultSearchableText(trace.result);
					trace.isError = event.isError === true || trace.result.isError === true;
					pending.delete(event.toolCallId);
				}
				if (event.isError) errors.push(`${event.toolName} tool call ${event.toolCallId} returned an error.`);
				return;
			}
			if (event.type === "agent_failed") {
				errors.push(`${event.error.code}: ${safeError(event.error.message)}`);
				return;
			}
			if (event.type === "turn_end") {
				if (isRecord(event.message) && event.message.role === "assistant") assistantTurnCount++;
				const text = extractAssistantText(event.message);
				if (!text || !isRecord(event.message) || event.message.stopReason !== "stop") return;
				const traceValidation = getAttemptTraceValidation(params.arm, aTrace, exec?.calls ?? [], params.task);
				const candidate = validateFinalAnswer(text, traceValidation, params.task.requiredAnswerTerms);
				if (candidate.valid && assistantTurnsToGreen === null) {
					assistantTurnsToGreen = assistantTurnCount;
					finalAnswer = text;
					validation = candidate;
				}
			}
		});
		const userPrompt = params.task.prompt;
		const operation = (async () => {
			await session.prompt(userPrompt, { expandPromptTemplates: false });
			await session.waitForIdle();
		})();
		await withTimeout(
			operation,
			remainingMs(),
			`Run exceeded timeout of ${params.timeoutMs} ms during the model/tool loop.`,
			() => {
				timedOut = true;
				session.abort();
			},
		);
		unsubscribe();
		if (assistantTurnsToGreen === null) {
			finalAnswer = session.getLastAssistantText() ?? null;
			const traceValidation = getAttemptTraceValidation(params.arm, aTrace, exec?.calls ?? [], params.task);
			validation = validateFinalAnswer(finalAnswer ?? "", traceValidation, params.task.requiredAnswerTerms);
		}
		modelFacingToolCalls = session.getSessionStats().toolCalls;
		const stats = session.getSessionStats();
		providerInputTokens =
			stats.assistantMessages > 0 ? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite : null;
		if (timedOut) errors.push(`Run exceeded timeout of ${params.timeoutMs} ms.`);
	} catch (error) {
		errors.push(timedOut ? `Run exceeded timeout of ${params.timeoutMs} ms.` : safeError(error));
		if (result) {
			try {
				const session = result.session;
				finalAnswer = session.getLastAssistantText() ?? null;
				const traceValidation = getAttemptTraceValidation(params.arm, aTrace, exec?.calls ?? [], params.task);
				validation = validateFinalAnswer(finalAnswer ?? "", traceValidation, params.task.requiredAnswerTerms);
				const stats = session.getSessionStats();
				modelFacingToolCalls = stats.toolCalls;
				providerInputTokens =
					stats.assistantMessages > 0
						? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite
						: null;
			} catch {
				// Retain unavailable metric values when a partially initialized session has no stats.
			}
		}
	} finally {
		unsubscribe();
		try {
			await disposeSessionResultBounded(result);
		} catch (error) {
			errors.push(`Session disposal failed: ${safeError(error)}`);
		}
	}
	const bTrace = exec?.calls ?? [];
	const traceValidation = getAttemptTraceValidation(params.arm, aTrace, bTrace, params.task);
	if (assistantTurnsToGreen === null) {
		validation = validateFinalAnswer(finalAnswer ?? "", traceValidation, params.task.requiredAnswerTerms);
		if (validation.valid) assistantTurnsToGreen = assistantTurnCount;
	}
	if (!traceValidation.valid && !validation.reasons.length) validation.reasons = traceValidation.reasons;
	const handlerCalls =
		params.arm === "A" ? aTrace.length : bTrace.reduce((count, call) => count + call.steps.length, 0);
	return {
		attemptNumber: params.attemptNumber,
		...(params.retryReason ? { retryReason: params.retryReason } : {}),
		arm: params.arm,
		model: params.model,
		startedAt,
		finishedAt: new Date().toISOString(),
		green: assistantTurnsToGreen !== null && validation.valid,
		finalAnswer,
		validation,
		errors,
		metrics: {
			modelRequestCount,
			assistantTurnCount,
			assistantTurnsToGreen,
			providerInputTokens,
			modelFacingToolCalls,
			readSearchHandlerCalls: handlerCalls,
		},
		trace: {
			functionCalls: aTrace,
			execCalls: bTrace,
		},
	};
}

interface ScheduledRun {
	runId: string;
	taskId: string;
	repetition: number;
	arm: Arm;
	attempts: AttemptRecord[];
	green: boolean;
	retryCount: number;
	metrics: AttemptMetrics;
	errors: string[];
}

function aggregateAttempts(attempts: readonly AttemptRecord[]): {
	green: boolean;
	metrics: AttemptMetrics;
	errors: string[];
} {
	const greenIndex = attempts.findIndex(attempt => attempt.green);
	const green = greenIndex >= 0;
	const considered = green ? attempts.slice(0, greenIndex + 1) : attempts;
	const modelRequestCount = considered.reduce((sum, attempt) => sum + attempt.metrics.modelRequestCount, 0);
	const providerTokenValues = considered
		.map(attempt => attempt.metrics.providerInputTokens)
		.filter((value): value is number => value !== null);
	const modelFacingToolCalls = considered.reduce((sum, attempt) => sum + attempt.metrics.modelFacingToolCalls, 0);
	const readSearchHandlerCalls = considered.reduce((sum, attempt) => sum + attempt.metrics.readSearchHandlerCalls, 0);
	const assistantTurnsToGreen = green
		? considered.slice(0, -1).reduce((sum, attempt) => sum + attempt.metrics.assistantTurnCount, 0) +
			(attempts[greenIndex]!.metrics.assistantTurnsToGreen ?? 0)
		: null;
	return {
		green,
		metrics: {
			modelRequestCount,
			assistantTurnCount: considered.reduce((sum, attempt) => sum + attempt.metrics.assistantTurnCount, 0),
			assistantTurnsToGreen,
			providerInputTokens:
				providerTokenValues.length > 0 ? providerTokenValues.reduce((sum, value) => sum + value, 0) : null,
			modelFacingToolCalls,
			readSearchHandlerCalls,
		},
		errors: attempts.flatMap(attempt => attempt.errors.map(error => `Attempt ${attempt.attemptNumber}: ${error}`)),
	};
}

async function runScheduledArm(params: {
	runId: string;
	task: BenchmarkTask;
	arm: Arm;
	model: string;
	workspaceRoot: string;
	timeoutMs: number;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	readTool: AnyAgentTool;
	searchTool: AnyAgentTool;
}): Promise<ScheduledRun> {
	const attempts: AttemptRecord[] = [];
	for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber++) {
		const priorFailure = attempts.length > 0;
		const attempt = await runAttempt({
			arm: params.arm,
			task: params.task,
			model: params.model,
			workspaceRoot: params.workspaceRoot,
			timeoutMs: params.timeoutMs,
			authStorage: params.authStorage,
			modelRegistry: params.modelRegistry,
			readTool: params.readTool,
			searchTool: params.searchTool,
			systemPrompt: SYSTEM_PROMPT,
			attemptNumber,
			...(priorFailure ? { retryReason: RUN_RETRY_REASON } : {}),
		});
		attempts.push(attempt);
		if (attempt.green) break;
	}
	const aggregate = aggregateAttempts(attempts);
	return {
		runId: params.runId,
		taskId: params.task.id,
		repetition: 1,
		arm: params.arm,
		attempts,
		green: aggregate.green,
		retryCount: Math.max(0, attempts.length - 1),
		metrics: aggregate.metrics,
		errors: aggregate.errors,
	};
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	if (values.some(value => !Number.isFinite(value))) throw new Error("Median inputs must be finite numbers.");
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function medianMetric(values: readonly number[]): number | null {
	return median(values);
}

export function percentReduction(aRequests: number, bRequests: number): number {
	if (!Number.isFinite(aRequests) || !Number.isFinite(bRequests) || aRequests < 0 || bRequests < 0) {
		throw new Error("Request counts must be finite non-negative numbers.");
	}
	if (aRequests === 0) return bRequests === 0 ? 0 : -1;
	return (aRequests - bRequests) / aRequests;
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function quantile(values: readonly number[], probability: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const position = Math.min(1, Math.max(0, probability)) * (sorted.length - 1);
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	const lower = sorted[lowerIndex]!;
	const upper = sorted[upperIndex]!;
	return lower + (upper - lower) * (position - lowerIndex);
}

export function taskClusteredBootstrap95CI(
	pairs: readonly PairedRequestCount[],
	seed = SCHEDULE_SEED ^ 0xb00757,
	iterations = BOOTSTRAP_REPETITIONS,
): { lower: number; upper: number } | null {
	const tasks = new Map<string, number[]>();
	for (const pair of pairs) {
		if (
			!Number.isInteger(pair.aRequests) ||
			!Number.isInteger(pair.bRequests) ||
			pair.aRequests < 0 ||
			pair.bRequests < 0
		) {
			throw new Error("Paired request counts must be non-negative integers.");
		}
		const reductions = tasks.get(pair.taskId) ?? [];
		reductions.push(pair.aRequests - pair.bRequests);
		tasks.set(pair.taskId, reductions);
	}
	if (tasks.size < 2 || iterations < 1) return null;
	const clusters = [...tasks.values()];
	const random = seededRandom(seed);
	const bootstrapMedians: number[] = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		const sample: number[] = [];
		for (let i = 0; i < clusters.length; i++) {
			const cluster = clusters[Math.floor(random() * clusters.length)]!;
			sample.push(...cluster);
		}
		const statistic = median(sample);
		if (statistic !== null) bootstrapMedians.push(statistic);
	}
	const lower = quantile(bootstrapMedians, 0.025);
	const upper = quantile(bootstrapMedians, 0.975);
	return lower === null || upper === null ? null : { lower, upper };
}

export function summarizeDecision(
	pairs: readonly PairedRequestCount[],
	options: { seed?: number; iterations?: number } = {},
): DecisionSummary {
	const requestReductions = pairs.map(pair => pair.aRequests - pair.bRequests);
	const percentReductions = pairs.map(pair => percentReduction(pair.aRequests, pair.bRequests));
	const requestMedian = median(requestReductions);
	const percentMedian = median(percentReductions);
	const bootstrap95CI = taskClusteredBootstrap95CI(pairs, options.seed, options.iterations);
	const armAGreenRate = pairs.length === 0 ? null : pairs.filter(pair => pair.aGreen).length / pairs.length;
	const armBGreenRate = pairs.length === 0 ? null : pairs.filter(pair => pair.bGreen).length / pairs.length;
	const completionRateDrop = armAGreenRate === null || armBGreenRate === null ? null : armAGreenRate - armBGreenRate;
	return {
		medianPairedRequestReduction: requestMedian,
		medianPairedPercentReduction: percentMedian,
		bootstrap95CI,
		armAGreenRate,
		armBGreenRate,
		completionRateDrop,
		pass:
			requestMedian !== null &&
			requestMedian >= 1 &&
			percentMedian !== null &&
			percentMedian >= 0.25 &&
			bootstrap95CI !== null &&
			bootstrap95CI.lower > 0 &&
			armBGreenRate !== null &&
			armBGreenRate >= 0.8 &&
			completionRateDrop !== null &&
			completionRateDrop <= 0.1,
	};
}

function medianOptional(values: readonly (number | null)[]): number | null {
	return median(values.filter((value): value is number => value !== null));
}

interface ScheduledPair {
	pairId: string;
	taskId: string;
	repetition: number;
	armOrder: Arm[];
	A?: ScheduledRun;
	B?: ScheduledRun;
}

function schedulePairs(tasks: readonly BenchmarkTask[], random: () => number): ScheduledPair[] {
	const pairs: ScheduledPair[] = [];
	for (const task of tasks) {
		for (let repetition = 1; repetition <= REPETITIONS_PER_TASK; repetition++) {
			const pairId = `${task.id}-R${repetition}`;
			pairs.push({ pairId, taskId: task.id, repetition, armOrder: random() < 0.5 ? ["A", "B"] : ["B", "A"] });
		}
	}
	return pairs;
}

function assignRepetition(run: ScheduledRun, repetition: number): ScheduledRun {
	return { ...run, repetition };
}

function failedScheduledRun(
	runId: string,
	task: BenchmarkTask,
	repetition: number,
	arm: Arm,
	model: string,
	error: unknown,
): ScheduledRun {
	const reason = safeError(error);
	const attempt: AttemptRecord = {
		attemptNumber: 1,
		arm,
		model,
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		green: false,
		finalAnswer: null,
		validation: { valid: false, reasons: [reason] },
		errors: [reason],
		metrics: {
			modelRequestCount: 0,
			assistantTurnCount: 0,
			assistantTurnsToGreen: null,
			providerInputTokens: null,
			modelFacingToolCalls: 0,
			readSearchHandlerCalls: 0,
		},
		trace: { functionCalls: [], execCalls: [] },
	};
	return {
		runId,
		taskId: task.id,
		repetition,
		arm,
		attempts: [attempt],
		green: false,
		retryCount: 0,
		metrics: attempt.metrics,
		errors: [reason],
	};
}

function summarizePerTask(tasks: readonly BenchmarkTask[], pairs: readonly ScheduledPair[]): unknown[] {
	return tasks.map(task => {
		const taskPairs = pairs.filter(pair => pair.taskId === task.id);
		const aRuns = taskPairs.map(pair => pair.A!).filter(Boolean);
		const bRuns = taskPairs.map(pair => pair.B!).filter(Boolean);
		const paired = taskPairs
			.filter(pair => pair.A && pair.B)
			.map(pair => ({
				aRequests: pair.A!.metrics.modelRequestCount,
				bRequests: pair.B!.metrics.modelRequestCount,
				requestReduction: pair.A!.metrics.modelRequestCount - pair.B!.metrics.modelRequestCount,
				percentReduction: percentReduction(pair.A!.metrics.modelRequestCount, pair.B!.metrics.modelRequestCount),
			}));
		return {
			taskId: task.id,
			title: task.title,
			scheduledPairs: taskPairs.length,
			A: {
				medianModelRequests: median(aRuns.map(run => run.metrics.modelRequestCount)),
				medianTurnsToGreen: medianOptional(aRuns.map(run => run.metrics.assistantTurnsToGreen)),
				medianProviderInputTokens: medianOptional(aRuns.map(run => run.metrics.providerInputTokens)),
				medianModelFacingToolCalls: median(aRuns.map(run => run.metrics.modelFacingToolCalls)),
				medianReadSearchHandlerCalls: median(aRuns.map(run => run.metrics.readSearchHandlerCalls)),
				greenRuns: aRuns.filter(run => run.green).length,
			},
			B: {
				medianModelRequests: median(bRuns.map(run => run.metrics.modelRequestCount)),
				medianTurnsToGreen: medianOptional(bRuns.map(run => run.metrics.assistantTurnsToGreen)),
				medianProviderInputTokens: medianOptional(bRuns.map(run => run.metrics.providerInputTokens)),
				medianModelFacingToolCalls: median(bRuns.map(run => run.metrics.modelFacingToolCalls)),
				medianReadSearchHandlerCalls: median(bRuns.map(run => run.metrics.readSearchHandlerCalls)),
				greenRuns: bRuns.filter(run => run.green).length,
			},
			pairedMedianRequestReduction: median(paired.map(item => item.requestReduction)),
			pairedMedianPercentReduction: median(paired.map(item => item.percentReduction)),
		};
	});
}

function summarizeRunCountsByArm(pairs: readonly ScheduledPair[]): Record<
	Arm,
	{
		scheduled: number;
		green: number;
		failed: number;
		failureRate: number | null;
		retries: number;
		retryRate: number | null;
	}
> {
	return Object.fromEntries(
		(
			[
				["A", pairs.flatMap(pair => (pair.A ? [pair.A] : []))],
				["B", pairs.flatMap(pair => (pair.B ? [pair.B] : []))],
			] as const
		).map(([arm, runs]) => {
			const green = runs.filter(run => run.green).length;
			const failed = runs.length - green;
			const retries = runs.reduce((sum, run) => sum + run.retryCount, 0);
			return [
				arm,
				{
					scheduled: runs.length,
					green,
					failed,
					failureRate: runs.length > 0 ? failed / runs.length : null,
					retries,
					retryRate: runs.length > 0 ? retries / runs.length : null,
				},
			];
		}),
	) as Record<
		Arm,
		{
			scheduled: number;
			green: number;
			failed: number;
			failureRate: number | null;
			retries: number;
			retryRate: number | null;
		}
	>;
}

interface CliOptions {
	model: string;
	outputPath: string;
	taskRepoPath: string;
	timeoutMs: number;
	resume: boolean;
}

function parseCliOptions(args: string[]): CliOptions {
	let model = DEFAULT_MODEL;
	let outputPath: string | undefined;
	let taskRepoPath: string | undefined;
	let timeoutMs = DEFAULT_TIMEOUT_MS;
	let resume = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--model") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("--model requires a provider/model selector.");
			model = value;
		} else if (argument === "--output") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("--output requires an explicit output path.");
			outputPath = value;
		} else if (argument === "--task-repo") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("--task-repo requires an isolated clean repository snapshot path.");
			taskRepoPath = value;
		} else if (argument === "--timeout-ms") {
			const value = Number(args[++index]);
			if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000)
				throw new Error("--timeout-ms must be an integer from 1000 to 3600000.");
			timeoutMs = value;
		} else if (argument === "--resume") {
			resume = true;
		} else if (argument === "--help" || argument === "-h") {
			process.stdout.write(
				"Usage: bun scripts/benchmark-code-mode.ts --task-repo <clean-origin-dev-worktree> --output <external-file.json> [--model provider/model] [--timeout-ms 300000] [--resume]\n",
			);
			process.exit(0);
		} else {
			throw new Error(`Unknown option: ${argument}`);
		}
	}
	if (!outputPath) throw new Error("An explicit --output path is required; existing files are never overwritten.");
	if (!taskRepoPath) throw new Error("An isolated --task-repo snapshot is required for every benchmark run.");
	if (!model.includes("/") || model.startsWith("/") || model.endsWith("/"))
		throw new Error("--model must be an exact provider/model selector.");
	return {
		model,
		outputPath: path.resolve(process.cwd(), outputPath),
		taskRepoPath: path.resolve(process.cwd(), taskRepoPath),
		timeoutMs,
		resume,
	};
}

async function resolvePinnedModel(modelSelector: string, modelRegistry: ModelRegistry): Promise<Model> {
	const parts = modelSelector.split("/");
	const provider = parts.shift()!;
	const modelId = parts.join("/");
	const model = modelRegistry
		.getAvailable()
		.find(candidate => candidate.provider === provider && candidate.id === modelId);
	if (!model) throw new Error(`Model ${modelSelector} is not available from configured auth/model storage.`);
	if (
		!new Set(["openai-responses", "openai-codex-responses"]).has(model.api) ||
		model.applyPatchToolType !== "freeform"
	) {
		throw new Error(
			`Model ${modelSelector} does not declare OpenAI custom-format/freeform tool capability; refusing to substitute another model.`,
		);
	}
	const key = await modelRegistry.getApiKey(model);
	if (typeof key !== "string" || key.trim().length === 0)
		throw new Error(`No usable auth is available for ${modelSelector}.`);
	return model;
}

async function initializeInfrastructure(modelSelector: string): Promise<{
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
}> {
	const authStorage = await discoverAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.refresh("offline");
		await Settings.init({ cwd: REPO_ROOT, overrides: {} });
		const model = await resolvePinnedModel(modelSelector, modelRegistry);
		return { authStorage, modelRegistry, model };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

interface TaskWorkspace {
	root: string;
	commit: string;
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${safeError(stderr)}`);
	return stdout.trim();
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function resolveFuturePath(candidate: string): Promise<string> {
	let parent = path.dirname(candidate);
	const suffix = [path.basename(candidate)];
	while (true) {
		try {
			return path.join(await fs.realpath(parent), ...suffix);
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			const next = path.dirname(parent);
			if (next === parent) throw error;
			suffix.unshift(path.basename(parent));
			parent = next;
		}
	}
}

async function resolveTaskWorkspace(options: CliOptions): Promise<TaskWorkspace> {
	const root = await fs.realpath(options.taskRepoPath);
	if (root === REPO_ROOT) throw new Error("--task-repo must be a separate clean snapshot, never the harness checkout.");
	if (isPathInside(root, options.outputPath)) throw new Error("--output must be outside the task repository search corpus.");
	if (isPathInside(root, await resolveFuturePath(options.outputPath))) {
		throw new Error("--output must not resolve through a symlink into the task repository search corpus.");
	}
	const [gitRoot, taskHead, originDev, status] = await Promise.all([
		gitText(root, "rev-parse", "--show-toplevel"),
		gitText(root, "rev-parse", "HEAD"),
		gitText(REPO_ROOT, "rev-parse", "origin/dev"),
		gitText(root, "status", "--porcelain", "--untracked-files=all"),
	]);
	if ((await fs.realpath(gitRoot)) !== root) throw new Error("--task-repo must be the root of a Git checkout or worktree.");
	if (taskHead !== originDev) throw new Error(`--task-repo must be an exact clean snapshot of origin/dev (${originDev}); got ${taskHead}.`);
	if (status.length > 0) throw new Error("--task-repo must have a clean working tree before benchmark tasks begin.");
	for (const sentinel of SEARCH_CORPUS_SENTINELS) {
		let exists = false;
		try {
			await fs.access(path.join(root, sentinel));
			exists = true;
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		if (exists) throw new Error(`Task corpus contains benchmark artifact ${sentinel}; refusing a contaminated run.`);
	}
	return { root, commit: taskHead };
}

async function runBenchmark(
	options: CliOptions,
	taskWorkspace: TaskWorkspace,
	onProgress?: (report: unknown) => Promise<void>,
): Promise<unknown> {
	let startedAt = new Date().toISOString();
	const infrastructure = await initializeInfrastructure(options.model);
	const { authStorage, modelRegistry, model } = infrastructure;
	const resolvedModel = modelKey(model)!;
	const random = seededRandom(SCHEDULE_SEED);
	const pairs = schedulePairs(TASKS, random);
	if (options.resume) {
		let prior: unknown;
		try {
			prior = JSON.parse(await fs.readFile(options.outputPath, "utf8"));
		} catch (error) {
			throw new Error(`Cannot resume benchmark report: ${safeError(error)}`);
		}
		if (!isRecord(prior) || prior.formatVersion !== 1 || prior.benchmark !== "issue-5792-code-mode-measurement") {
			throw new Error("Resume report does not match the issue #5792 benchmark format.");
		}
		if (prior.executionStatus !== "running") throw new Error("Only an incomplete running report can be resumed.");
		if (!isRecord(prior.model) || prior.model.resolved !== resolvedModel) {
			throw new Error(`Resume report model does not match the pinned model ${resolvedModel}.`);
		}
		if (!isRecord(prior.workspaceSnapshot) || prior.workspaceSnapshot.commit !== taskWorkspace.commit) {
			throw new Error(`Resume report task corpus does not match the clean origin/dev snapshot ${taskWorkspace.commit}.`);
		}
		const taskManifest = TASKS.map(({
			id,
			title,
			prompt,
			dependencyRequirements,
			initialSearchQuery,
			requiredFollowupSearchTerm,
			requiredAnswerTerms,
		}) => ({
			id,
			title,
			prompt,
			dependencyRequirements,
			initialSearchQuery,
			requiredFollowupSearchTerm,
			requiredAnswerTerms,
		}));
		if (JSON.stringify(prior.tasks) !== JSON.stringify(taskManifest)) {
			throw new Error("Resume report task prompts or answer requirements do not match the frozen task manifest.");
		}
		if (
			!isRecord(prior.contract) ||
			prior.contract.runTimeoutMs !== options.timeoutMs ||
			prior.contract.setupCleanupTimeoutMs !== CLEANUP_TIMEOUT_MS
		) {
			throw new Error("Resume report timeout configuration does not match the frozen run limits.");
		}
		if (
			JSON.stringify(prior.schedule) !==
			JSON.stringify(
				pairs.map(pair => ({
					pairId: pair.pairId,
					taskId: pair.taskId,
					repetition: pair.repetition,
					armOrder: pair.armOrder,
				})),
			)
		) {
			throw new Error("Resume report schedule does not match the fixed seeded benchmark schedule.");
		}
		if (!Array.isArray(prior.pairs) || prior.pairs.length !== pairs.length || typeof prior.startedAt !== "string") {
			throw new Error("Resume report is missing the complete fixed paired schedule.");
		}
		startedAt = prior.startedAt;
		for (let index = 0; index < pairs.length; index++) {
			const priorPair = prior.pairs[index];
			if (
				!isRecord(priorPair) ||
				priorPair.pairId !== pairs[index]!.pairId ||
				priorPair.taskId !== pairs[index]!.taskId ||
				priorPair.repetition !== pairs[index]!.repetition ||
				JSON.stringify(priorPair.armOrder) !== JSON.stringify(pairs[index]!.armOrder)
			) {
				throw new Error(`Resume report pair ${index + 1} does not match the fixed schedule.`);
			}
			for (const arm of ["A", "B"] as const) {
				const scheduledRun = priorPair[arm];
				if (scheduledRun === undefined) continue;
				if (
					!isRecord(scheduledRun) ||
					scheduledRun.arm !== arm ||
					scheduledRun.runId !== `${pairs[index]!.pairId}-${arm}`
				) {
					throw new Error(`Resume report contains invalid ${arm} run data for pair ${priorPair.pairId}.`);
				}
				pairs[index]![arm] = scheduledRun as unknown as ScheduledRun;
			}
		}
	}
	const persistProgress = async (executionStatus: "running" | "complete"): Promise<void> => {
		if (!onProgress) return;
		const observedRuns = pairs
			.flatMap(pair => [pair.A, pair.B])
			.filter((run): run is ScheduledRun => run !== undefined);
		await onProgress({
			formatVersion: 1,
			benchmark: "issue-5792-code-mode-measurement",
			executionStatus,
			startedAt,
			updatedAt: new Date().toISOString(),
			workspaceSnapshot: { commit: taskWorkspace.commit, isolation: "clean origin/dev worktree; output outside search corpus" },
			completedPairs: pairs.filter(pair => pair.A !== undefined && pair.B !== undefined).length,
			model: { requested: options.model, resolved: resolvedModel, armA: resolvedModel, armB: resolvedModel },
			contract: {
				taskCount: TASKS.length,
				repetitionsPerTaskPerArm: REPETITIONS_PER_TASK,
				fixedScheduleSeed: SCHEDULE_SEED,
				maxAttemptsPerScheduledRun: MAX_ATTEMPTS,
				runTimeoutMs: options.timeoutMs,
				handlerSetupTimeoutMs: options.timeoutMs,
				setupCleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
				runTimeoutScope: "Each attempt timeout starts before AgentSession creation and covers initialization, prompt execution, and wait-for-idle; handler setup has the same bound, and disposal has a separate bounded cleanup grace.",
				decisionRule:
					"Pass iff median paired request reduction >= 1, median paired percent reduction >= 25%, task-clustered bootstrap 95% CI lower bound > 0, Arm B green rate >= 80%, and B green rate is no more than 10 percentage points below A.",
			},
			tasks: TASKS.map(({ id, title, prompt, dependencyRequirements, initialSearchQuery, requiredFollowupSearchTerm, requiredAnswerTerms }) => ({
				id,
				title,
				prompt,
				dependencyRequirements,
				initialSearchQuery,
				requiredFollowupSearchTerm,
				requiredAnswerTerms,
			})),
			schedule: pairs.map(pair => ({
				pairId: pair.pairId,
				taskId: pair.taskId,
				repetition: pair.repetition,
				armOrder: pair.armOrder,
			})),
			pairs,
			runCounts: {
				scheduled: observedRuns.length,
				green: observedRuns.filter(run => run.green).length,
				failed: observedRuns.filter(run => !run.green).length,
				retries: observedRuns.reduce((sum, run) => sum + run.retryCount, 0),
				errors: observedRuns.reduce((sum, run) => sum + run.errors.length, 0),
			},
			runCountsByArm: summarizeRunCountsByArm(pairs),
		});
	};
	await persistProgress("running");
	try {
		for (const pair of pairs) {
			if (pair.A && pair.B) continue;
			const task = TASKS.find(candidate => candidate.id === pair.taskId)!;
			let handlerSessionResult: CreateAgentSessionResult | undefined;
			let readTool: AnyAgentTool | undefined;
			let searchTool: AnyAgentTool | undefined;
			try {
				const handlerSessionCreation = createAgentSession(
					sessionOptions({
						cwd: taskWorkspace.root,
						model: options.model,
						authStorage,
						modelRegistry,
						toolNames: ["read", "search"],
					}),
				);
				handlerSessionResult = await withTimeout(
					handlerSessionCreation,
					options.timeoutMs,
					`Read/search handler session setup exceeded ${options.timeoutMs} ms.`,
					undefined,
					lateResult => disposeSessionResultBounded(lateResult),
				);
				if (modelKey(handlerSessionResult.session.model) !== resolvedModel) {
					throw new Error(
						`Handler session resolved ${modelKey(handlerSessionResult.session.model) ?? "no model"}, expected ${resolvedModel}.`,
					);
				}
				readTool = getRequiredTool(handlerSessionResult.session, "read");
				searchTool = getRequiredTool(handlerSessionResult.session, "search");
			} catch (error) {
				let setupError = error;
				try {
					await disposeSessionResultBounded(handlerSessionResult);
				} catch (disposeError) {
					setupError = new AggregateError([error, disposeError], "Handler-session setup and disposal failed.");
				}
				for (const arm of pair.armOrder) {
					const run = failedScheduledRun(
						`${pair.pairId}-${arm}`,
						task,
						pair.repetition,
						arm,
						resolvedModel,
						setupError,
					);
					pair[arm] = run;
				}
				await persistProgress("running");
				continue;
			}
			try {
				for (const arm of pair.armOrder) {
					if (pair[arm]) continue;
					const run = await runScheduledArm({
						runId: `${pair.pairId}-${arm}`,
						task,
						arm,
						model: options.model,
						workspaceRoot: taskWorkspace.root,
						timeoutMs: options.timeoutMs,
						authStorage,
						modelRegistry,
						readTool: readTool!,
						searchTool: searchTool!,
					});
					pair[arm] = assignRepetition(run, pair.repetition);
				}
			} finally {
				try {
					await disposeSessionResultBounded(handlerSessionResult);
				} catch (error) {
					for (const arm of pair.armOrder) {
						pair[arm]?.errors.push(`Read/search handler session disposal failed: ${safeError(error)}`);
					}
				}
			}
			await persistProgress("running");
		}
	} finally {
		authStorage.close();
	}
	const pairedCounts: PairedRequestCount[] = pairs.flatMap(pair =>
		pair.A && pair.B
			? [
					{
						taskId: pair.taskId,
						aRequests: pair.A.metrics.modelRequestCount,
						bRequests: pair.B.metrics.modelRequestCount,
						aGreen: pair.A.green,
						bGreen: pair.B.green,
					},
				]
			: [],
	);
	const decision = summarizeDecision(pairedCounts);
	const decisionReport = {
		...decision,
		medianPairedPercentReductionPercent:
			decision.medianPairedPercentReduction === null ? null : decision.medianPairedPercentReduction * 100,
	};
	const perTask = summarizePerTask(TASKS, pairs);
	const scheduledRuns = pairs
		.flatMap(pair => [pair.A, pair.B])
		.filter((run): run is ScheduledRun => run !== undefined);
	const report = {
		formatVersion: 1,
		benchmark: "issue-5792-code-mode-measurement",
		startedAt,
		finishedAt: new Date().toISOString(),
		workspaceSnapshot: { commit: taskWorkspace.commit, isolation: "clean origin/dev worktree; output outside search corpus" },
		workingTree: ".",
		model: { requested: options.model, resolved: resolvedModel, armA: resolvedModel, armB: resolvedModel },
		contract: {
			taskCount: TASKS.length,
			repetitionsPerTaskPerArm: REPETITIONS_PER_TASK,
			scheduledPairedRuns: pairs.length,
			fixedScheduleSeed: SCHEDULE_SEED,
			maxAttemptsPerScheduledRun: MAX_ATTEMPTS,
			runTimeoutMs: options.timeoutMs,
			handlerSetupTimeoutMs: options.timeoutMs,
			setupCleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
			runTimeoutScope: "Each attempt timeout starts before AgentSession creation and covers initialization, prompt execution, and wait-for-idle; handler setup has the same bound, and disposal has a separate bounded cleanup grace.",
			roundTripDefinition: "AgentSession turn_start events (one model request/response cycle per round trip).",
			assistantTurnDefinition:
				"Assistant-role turn_end events; turns-to-green stops at the first final answer that passes task-specific answer-term, JSON/evidence, and dependent-trace validation.",
			providerInputTokenDefinition:
				"SessionStats input + cacheRead + cacheWrite reported on assistant messages; null means no assistant usage was available.",
			percentReductionWhenBaselineIsZero:
				"0% if both arms used zero requests; -100% if B used requests and A used zero, a conservative undefined-baseline penalty.",
			percentReductionStorage: "Fractions (0.25 = 25%) in paired metrics.",
			decisionRule:
				"Pass iff median paired request reduction >= 1, median paired percent reduction >= 25%, task-clustered bootstrap 95% CI lower bound > 0, Arm B green rate >= 80%, and B green rate is no more than 10 percentage points below A.",
			bootstrap: {
				method:
					"resample whole task clusters with replacement; retain all three repetition pairs within each sampled task",
				iterations: BOOTSTRAP_REPETITIONS,
				seed: SCHEDULE_SEED ^ 0xb00757,
			},
		},
		systemPrompt: SYSTEM_PROMPT,
		tasks: TASKS.map(({ id, title, prompt, dependencyRequirements, initialSearchQuery, requiredFollowupSearchTerm, requiredAnswerTerms }) => ({
			id,
			title,
			prompt,
			dependencyRequirements,
			initialSearchQuery,
			requiredFollowupSearchTerm,
			requiredAnswerTerms,
		})),
		schedule: pairs.map(pair => ({
			pairId: pair.pairId,
			taskId: pair.taskId,
			repetition: pair.repetition,
			armOrder: pair.armOrder,
		})),
		pairs,
		perTask,
		runCounts: {
			scheduled: scheduledRuns.length,
			green: scheduledRuns.filter(run => run.green).length,
			failed: scheduledRuns.filter(run => !run.green).length,
			retries: scheduledRuns.reduce((sum, run) => sum + run.retryCount, 0),
			errors: scheduledRuns.reduce((sum, run) => sum + run.errors.length, 0),
		},
		runCountsByArm: summarizeRunCountsByArm(pairs),
		decision: decisionReport,
		executionStatus: "complete",
	};
	await onProgress?.(report);
	return report;
}

async function main(): Promise<void> {
	const options = parseCliOptions(process.argv.slice(2));
	const taskWorkspace = await resolveTaskWorkspace(options);
	await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
	if (!options.resume) {
		await fs.writeFile(
			options.outputPath,
			`${JSON.stringify({ formatVersion: 1, benchmark: "issue-5792-code-mode-measurement", executionStatus: "preflight" }, null, 2)}\n`,
			{ flag: "wx" },
		);
	}
	const report = await runBenchmark(options, taskWorkspace, value =>
		fs.writeFile(options.outputPath, `${JSON.stringify(value, null, 2)}\n`),
	);
	const decision = (report as { decision: DecisionSummary & { medianPairedPercentReductionPercent: number | null } })
		.decision;
	process.stdout.write(`${JSON.stringify({ output: options.outputPath, decision }, null, 2)}\n`);
}

if (import.meta.main) {
	main().catch(error => {
		process.stderr.write(`code-mode benchmark failed closed: ${safeError(error)}\n`);
		process.exitCode = 1;
	});
}
