import { createHash } from "node:crypto";
import { computeAmbiguityFloor, scoreToUnits } from "./deep-interview-ambiguity";
import type { DeepInterviewDraftKind } from "./deep-interview-payload";
import { runDeepInterviewPostCommitEffects } from "./deep-interview-recorder";
import {
	answerHash,
	applyDeepInterviewRoundResultV1,
	canonicalDeepInterviewJson,
	type DeepInterviewFactOperation,
	type DeepInterviewResolution,
	type DeepInterviewRoundResultV1,
	deepInterviewAnswerIdentityEqual,
	deriveRoundKey,
	questionHash,
	validateDeepInterviewV1Envelope,
} from "./deep-interview-state";
import { modeStatePath } from "./session-layout";
import {
	GuardedWorkflowEnvelopeError,
	readExistingStateForMutation,
	transformGuardedWorkflowEnvelopeAtomic,
	verifyWorkflowEnvelopeReceiptValue,
	workflowEnvelopeContentSha256,
} from "./state-writer";

export interface DeepInterviewRepairResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

export const DEEP_INTERVIEW_REPAIR_VERBS = [
	"initialize-context",
	"confirm-topology",
	"record-answer",
	"apply-round-result",
	"inspect",
	"sanity-check",
] as const;

export type DeepInterviewRepairVerb = (typeof DEEP_INTERVIEW_REPAIR_VERBS)[number];

const VERBS = new Set<string>(DEEP_INTERVIEW_REPAIR_VERBS);

export function isDeepInterviewRepairVerb(value: string): value is DeepInterviewRepairVerb {
	return VERBS.has(value);
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BYTES = 64 * 1024;

class RepairError extends Error {
	constructor(
		readonly code: string,
		readonly status = 2,
	) {
		super(code);
	}
}
function issue(code: string) {
	return { code, message: code };
}
function errorResult(error: unknown): DeepInterviewRepairResult {
	const typed =
		error instanceof RepairError
			? error
			: error instanceof GuardedWorkflowEnvelopeError
				? new RepairError(
						error.code,
						error.code === "DI_ROUND_RESULT_CONFLICT" ||
							error.code === "DI_TOPOLOGY_CONFLICT" ||
							error.code === "DI_ANSWER_CONFLICT" ||
							error.code === "DI_SHELL_CONFLICT"
							? 4
							: 3,
					)
				: new RepairError("DI_INTERNAL_ERROR", 3);
	return { status: typed.status, stderr: `${JSON.stringify({ ok: false, issue: issue(typed.code) })}\n` };
}
function strictJson(value: string): unknown {
	let index = 0;
	const whitespace = () => {
		while (/\s/.test(value[index] ?? "")) index++;
	};
	const string = (): string => {
		const start = index++;
		while (index < value.length) {
			if (value[index] === "\\") {
				index += 2;
				continue;
			}
			if (value[index++] === '"') return JSON.parse(value.slice(start, index)) as string;
		}
		throw new Error("invalid JSON");
	};
	const node = (): void => {
		whitespace();
		if (value[index] === "{") {
			index++;
			const keys = new Set<string>();
			whitespace();
			if (value[index] === "}") {
				index++;
				return;
			}
			for (;;) {
				whitespace();
				if (value[index] !== '"') throw new Error("invalid JSON");
				const key = string();
				if (keys.has(key)) throw new Error("duplicate JSON key");
				keys.add(key);
				whitespace();
				if (value[index++] !== ":") throw new Error("invalid JSON");
				node();
				whitespace();
				if (value[index] === "}") {
					index++;
					return;
				}
				if (value[index++] !== ",") throw new Error("invalid JSON");
			}
		}
		if (value[index] === "[") {
			index++;
			whitespace();
			if (value[index] === "]") {
				index++;
				return;
			}
			for (;;) {
				node();
				whitespace();
				if (value[index] === "]") {
					index++;
					return;
				}
				if (value[index++] !== ",") throw new Error("invalid JSON");
			}
		}
		if (value[index] === '"') {
			string();
			return;
		}
		const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
			value.slice(index),
		);
		if (!primitive) throw new Error("invalid JSON");
		index += primitive[0].length;
	};
	node();
	whitespace();
	if (index !== value.length) throw new Error("invalid JSON");
	return JSON.parse(value) as unknown;
}

function structuredObject(value: unknown, code: string, max: number): Record<string, unknown> {
	if (typeof value === "string") return objectJson(value, code, max);
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new RepairError(code);
	const encoded = JSON.stringify(value);
	if (typeof encoded !== "string" || Buffer.byteLength(encoded) > max) throw new RepairError(code);
	return value as Record<string, unknown>;
}

function objectJson(value: string | undefined, code: string, max: number): Record<string, unknown> {
	if (value === undefined || Buffer.byteLength(value) > MAX_BYTES || Buffer.byteLength(value) > max)
		throw new RepairError(code);
	try {
		const parsed: unknown = strictJson(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		throw new RepairError(code);
	}
}
function stringJson(value: string | undefined): string {
	if (value === undefined || Buffer.byteLength(value) > 2048) throw new RepairError("DI_INVALID_QUESTION_JSON");
	try {
		const parsed: unknown = strictJson(value);
		if (typeof parsed !== "string" || !parsed || Buffer.byteLength(parsed) > 2048) throw new Error();
		return parsed;
	} catch {
		throw new RepairError("DI_INVALID_QUESTION_JSON");
	}
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
	if (Object.keys(value).some(key => !keys.includes(key))) throw new RepairError(code);
}

const DIMENSIONS = ["goal", "constraints", "criteria", "context"] as const;
function resolutionJson(value: unknown): DeepInterviewResolution {
	switch (value) {
		case "auto_research_accepted":
		case "auto_answer":
		case "direct":
		case "refined":
		case "cited_confirmation":
			return value;
		default:
			throw new RepairError("DI_INVALID_RESULT_JSON");
	}
}

function text(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > max)
		throw new RepairError("DI_INVALID_RESULT_JSON");
	return value;
}
function id(value: unknown): string {
	if (typeof value !== "string" || !ID.test(value)) throw new RepairError("DI_INVALID_RESULT_JSON");
	return value;
}
function record(value: unknown, code = "DI_INVALID_RESULT_JSON"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepairError(code);
	return value as Record<string, unknown>;
}
function list(value: unknown, max = 64, budget?: { remaining: number }): unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new RepairError("DI_INVALID_RESULT_JSON");
	if (budget !== undefined) {
		budget.remaining -= value.length;
		if (budget.remaining < 0) throw new RepairError("DI_INVALID_RESULT_JSON");
	}
	return value;
}
function dimension(
	value: unknown,
	allowed: readonly ("goal" | "constraints" | "criteria" | "context")[] = DIMENSIONS,
): "goal" | "constraints" | "criteria" | "context" {
	if (typeof value !== "string" || !allowed.includes(value as (typeof DIMENSIONS)[number]))
		throw new RepairError("DI_INVALID_RESULT_JSON");
	return value as "goal" | "constraints" | "criteria" | "context";
}
function score(value: unknown): number {
	if (typeof value !== "number") throw new RepairError("DI_INVALID_RESULT_JSON");
	try {
		scoreToUnits(value);
		return value;
	} catch {
		throw new RepairError("DI_INVALID_RESULT_JSON");
	}
}
function scores(
	value: unknown,
	dimensions: readonly ("goal" | "constraints" | "criteria" | "context")[],
): Record<"goal" | "constraints" | "criteria" | "context", number> {
	const input = record(value);
	exactKeys(input, dimensions, "DI_INVALID_RESULT_JSON");
	if (Object.keys(input).length !== dimensions.length) throw new RepairError("DI_INVALID_RESULT_JSON");
	return Object.fromEntries(dimensions.map(dimension => [dimension, score(input[dimension])])) as Record<
		"goal" | "constraints" | "criteria" | "context",
		number
	>;
}
function optionalText(value: unknown, max: number): string | undefined {
	return value === undefined ? undefined : text(value, max);
}
export function decodeDeepInterviewAnswerJson(value: unknown): {
	selected_options: string[];
	custom_input: string | null;
} {
	const answer = structuredObject(value, "DI_INVALID_ANSWER_JSON", 8 * 1024);
	exactKeys(answer, ["selected_options", "custom_input"], "DI_INVALID_ANSWER_JSON");
	if (!Array.isArray(answer.selected_options) || answer.selected_options.length > 64)
		throw new RepairError("DI_INVALID_ANSWER_JSON");
	const selected_options = answer.selected_options.map(option => {
		if (typeof option !== "string" || !option || Buffer.byteLength(option) > 2048)
			throw new RepairError("DI_INVALID_ANSWER_JSON");
		return option;
	});
	if (
		answer.custom_input !== null &&
		(typeof answer.custom_input !== "string" || Buffer.byteLength(answer.custom_input) > 4096)
	)
		throw new RepairError("DI_INVALID_ANSWER_JSON");
	return { selected_options, custom_input: answer.custom_input };
}
export function decodeDeepInterviewRoundResultJson(
	value: unknown,
	state: Record<string, unknown>,
): DeepInterviewRoundResultV1 {
	const result = structuredObject(value, "DI_INVALID_RESULT_JSON", 48 * 1024);
	const dimensions =
		state.type === "brownfield"
			? DIMENSIONS
			: state.type === "greenfield"
				? DIMENSIONS.slice(0, -1)
				: (() => {
						throw new RepairError("DI_STATE_SCHEMA_INVALID", 3);
					})();
	const budget = { remaining: 64 };
	exactKeys(
		result,
		["global_scores", "component_updates", "targeting", "triggers", "fact_ops", "ontology", "bookkeeping"],
		"DI_INVALID_RESULT_JSON",
	);
	const component_updates =
		result.component_updates === undefined
			? undefined
			: list(result.component_updates, 12, budget).map(value => {
					const update = record(value);
					exactKeys(update, ["component_id", "scores"], "DI_INVALID_RESULT_JSON");
					return { component_id: id(update.component_id), scores: scores(update.scores, dimensions) };
				});
	if (
		component_updates &&
		new Set(component_updates.map(update => update.component_id)).size !== component_updates.length
	)
		throw new RepairError("DI_INVALID_RESULT_JSON");
	const targeting =
		result.targeting === undefined
			? undefined
			: (() => {
					const input = record(result.targeting);
					exactKeys(
						input,
						[
							"target_component_id",
							"target_dimension",
							"weakest_component_id",
							"weakest_dimension",
							"last_targeted_component_id",
						],
						"DI_INVALID_RESULT_JSON",
					);
					if (input.last_targeted_component_id !== null) id(input.last_targeted_component_id);
					return {
						target_component_id: id(input.target_component_id),
						target_dimension: dimension(input.target_dimension, dimensions),
						weakest_component_id: id(input.weakest_component_id),
						weakest_dimension: dimension(input.weakest_dimension, dimensions),
						last_targeted_component_id: input.last_targeted_component_id as string | null,
					};
				})();
	const fact_ops =
		result.fact_ops === undefined
			? undefined
			: list(result.fact_ops, 32, budget).map(value => {
					const input = record(value);
					const op = input.op;
					if (op === "add") {
						exactKeys(
							input,
							["op", "id", "statement", "component", "dimension", "evidence"],
							"DI_INVALID_RESULT_JSON",
						);
						const operation: DeepInterviewFactOperation = {
							op: "add",
							id: id(input.id),
							statement: text(input.statement, 4096),
							component: optionalText(input.component, 128),
							dimension: input.dimension === undefined ? undefined : dimension(input.dimension, dimensions),
							evidence: optionalText(input.evidence, 4096),
						};
						return operation;
					}
					if (op === "dispute") {
						exactKeys(input, ["op", "id"], "DI_INVALID_RESULT_JSON");
						const operation: DeepInterviewFactOperation = { op: "dispute", id: id(input.id) };
						return operation;
					}
					if (op === "supersede") {
						exactKeys(input, ["op", "id", "target_id"], "DI_INVALID_RESULT_JSON");
						const operation: DeepInterviewFactOperation = {
							op: "supersede",
							id: id(input.id),
							target_id: id(input.target_id),
						};
						return operation;
					}
					throw new RepairError("DI_INVALID_RESULT_JSON");
				});
	const factIds = new Set([
		...(Array.isArray(state.established_facts)
			? state.established_facts.flatMap(fact => {
					const candidate =
						fact && typeof fact === "object" && !Array.isArray(fact)
							? (fact as Record<string, unknown>).id
							: undefined;
					return typeof candidate === "string" && ID.test(candidate) ? [candidate] : [];
				})
			: []),
	]);
	for (const operation of fact_ops ?? []) {
		if (operation.op === "add") {
			if (factIds.has(operation.id)) throw new RepairError("DI_INVALID_RESULT_JSON");
			factIds.add(operation.id);
		} else if (
			!factIds.has(operation.id) ||
			(operation.op === "supersede" && (operation.target_id === undefined || !factIds.has(operation.target_id)))
		) {
			throw new RepairError("DI_INVALID_RESULT_JSON");
		}
	}
	const triggers =
		result.triggers === undefined
			? undefined
			: list(result.triggers, 16, budget).map(value => {
					const input = record(value);
					const status = input.status;
					exactKeys(
						input,
						["kind", "name", "status", "component", "dimension", "evidence", "contradictedFactId", "rationale"],
						"DI_INVALID_RESULT_JSON",
					);
					if (
						!["A", "B", "C", "D"].includes(String(input.kind)) ||
						!["active", "disputed", "unresolved"].includes(String(status))
					)
						throw new RepairError("DI_INVALID_RESULT_JSON");
					if (input.contradictedFactId !== undefined && !factIds.has(id(input.contradictedFactId)))
						throw new RepairError("DI_INVALID_RESULT_JSON");
					if ((status === "disputed" || status === "unresolved") && input.rationale === undefined)
						throw new RepairError("DI_INVALID_RESULT_JSON");
					const trigger = {
						kind: input.kind as "A" | "B" | "C" | "D",
						name: text(input.name, 1024),
						status: status as "active" | "disputed" | "unresolved",
						component: id(input.component),
						dimension: dimension(input.dimension, dimensions),
						...(input.evidence === undefined ? {} : { evidence: optionalText(input.evidence, 4096) }),
						...(input.contradictedFactId === undefined
							? {}
							: { contradictedFactId: id(input.contradictedFactId) }),
						...(input.rationale === undefined ? {} : { rationale: optionalText(input.rationale, 4096) }),
					};
					return trigger;
				});
	const ontology =
		result.ontology === undefined
			? undefined
			: (() => {
					const input = record(result.ontology);
					exactKeys(input, ["entities", "relationships", "reasoning"], "DI_INVALID_RESULT_JSON");
					const entities = list(input.entities, 32, budget).map(value => {
						const entity = record(value);
						exactKeys(entity, ["id", "name", "type", "fields"], "DI_INVALID_RESULT_JSON");
						return {
							id: id(entity.id),
							name: text(entity.name, 1024),
							type: text(entity.type, 1024),
							fields: list(entity.fields, 16, budget).map(field => text(field, 1024)),
						};
					});
					const entityIds = new Set(entities.map(entity => entity.id));
					if (entityIds.size !== entities.length) throw new RepairError("DI_INVALID_RESULT_JSON");
					return {
						entities,
						relationships: list(input.relationships, 16, budget).map(value => {
							const relation = record(value);
							exactKeys(relation, ["id", "from_entity_id", "to_entity_id", "type"], "DI_INVALID_RESULT_JSON");
							const from_entity_id = id(relation.from_entity_id),
								to_entity_id = id(relation.to_entity_id);
							if (!entityIds.has(from_entity_id) || !entityIds.has(to_entity_id))
								throw new RepairError("DI_INVALID_RESULT_JSON");
							return { id: id(relation.id), from_entity_id, to_entity_id, type: text(relation.type, 1024) };
						}),
						reasoning: list(input.reasoning, 32, budget).map(value => {
							const item = record(value);
							exactKeys(item, ["statement", "evidence"], "DI_INVALID_RESULT_JSON");
							return { statement: text(item.statement, 4096), evidence: optionalText(item.evidence, 4096) };
						}),
					};
				})();
	const bookkeeping =
		result.bookkeeping === undefined
			? undefined
			: (() => {
					const input = record(result.bookkeeping);
					exactKeys(input, ["resolution", "round_ids", "counter_deltas"], "DI_INVALID_RESULT_JSON");
					const resolution = resolutionJson(input.resolution);
					const counter_deltas: Record<string, number> | undefined =
						input.counter_deltas === undefined
							? undefined
							: (() => {
									const deltas: Record<string, number> = {};
									for (const [key, value] of Object.entries(record(input.counter_deltas))) {
										if (typeof value !== "number") throw new RepairError("DI_INVALID_RESULT_JSON");
										const counterDelta: number = value;
										if (!Number.isSafeInteger(counterDelta) || Math.abs(counterDelta) > 10_000)
											throw new RepairError("DI_INVALID_RESULT_JSON");
										deltas[id(key)] = counterDelta;
									}
									return deltas;
								})();
					return {
						resolution,
						round_ids: input.round_ids === undefined ? undefined : list(input.round_ids, 32, budget).map(id),
						counter_deltas,
					};
				})();
	return {
		global_scores: scores(result.global_scores, dimensions),
		component_updates,
		targeting,
		triggers,
		fact_ops,
		ontology,
		bookkeeping,
	};
}
function inputText(value: unknown, max: number): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new RepairError("DI_INVALID_INPUT_JSON");
	return value;
}
export function decodeDeepInterviewSetupJson(value: unknown): Record<string, unknown> {
	const input = structuredObject(value, "DI_INVALID_INPUT_JSON", 24 * 1024);
	exactKeys(
		input,
		[
			"type",
			"interview_id",
			"initial_idea",
			"initial_context_summary",
			"codebase_context",
			"challenge_modes_used",
			"threshold",
			"threshold_source",
			"language",
			"trace",
			"trace_summary",
		],
		"DI_INVALID_INPUT_JSON",
	);
	if (
		(input.type !== "greenfield" && input.type !== "brownfield") ||
		typeof input.threshold !== "number" ||
		input.threshold <= 0
	)
		throw new RepairError("DI_INVALID_INPUT_JSON");
	try {
		scoreToUnits(input.threshold);
	} catch {
		throw new RepairError("DI_INVALID_INPUT_JSON");
	}
	for (const key of [
		"interview_id",
		"initial_idea",
		"initial_context_summary",
		"codebase_context",
		"threshold_source",
		"language",
		"trace_summary",
	] as const)
		if (input[key] !== undefined) inputText(input[key], 4096);
	if (input.interview_id !== undefined && !ID.test(input.interview_id as string))
		throw new RepairError("DI_INVALID_INPUT_JSON");
	if (
		input.challenge_modes_used !== undefined &&
		(!Array.isArray(input.challenge_modes_used) ||
			input.challenge_modes_used.length > 64 ||
			input.challenge_modes_used.some(item => typeof item !== "string" || Buffer.byteLength(item) > 256))
	)
		throw new RepairError("DI_INVALID_INPUT_JSON");
	if (
		input.trace !== undefined &&
		(!Array.isArray(input.trace) ||
			input.trace.length > 64 ||
			input.trace.some(item => typeof item !== "string" || Buffer.byteLength(item) > 2048))
	)
		throw new RepairError("DI_INVALID_INPUT_JSON");
	return input;
}
export function decodeDeepInterviewTopologyJson(value: unknown): Record<string, unknown> {
	const input = structuredObject(value, "DI_INVALID_INPUT_JSON", 24 * 1024);
	exactKeys(input, ["components", "deferred_components"], "DI_INVALID_INPUT_JSON");
	if (
		!Array.isArray(input.components) ||
		input.components.length > 64 ||
		!Array.isArray(input.deferred_components) ||
		input.deferred_components.length > 64
	)
		throw new RepairError("DI_INVALID_INPUT_JSON");
	const components = input.components.map(value => {
		const component = record(value, "DI_INVALID_INPUT_JSON");
		exactKeys(component, ["id", "name", "status", "active"], "DI_INVALID_INPUT_JSON");
		if (
			typeof component.id !== "string" ||
			!ID.test(component.id) ||
			(component.name !== undefined &&
				(typeof component.name !== "string" || !component.name || Buffer.byteLength(component.name) > 1024)) ||
			(component.status !== undefined && component.status !== "active" && component.status !== "deferred") ||
			(component.active !== undefined && typeof component.active !== "boolean")
		)
			throw new RepairError("DI_INVALID_INPUT_JSON");
		return component;
	});
	const ids = new Set(components.map(component => component.id as string));
	if (
		ids.size !== components.length ||
		input.deferred_components.some(value => typeof value !== "string" || !ids.has(value))
	)
		throw new RepairError("DI_INVALID_INPUT_JSON");
	return input;
}
function assertTopologyInspectable(input: Record<string, unknown>, confirmedAt: string): void {
	const components = input.components as Record<string, unknown>[];
	const deferredComponents = input.deferred_components as string[];
	const deferredComponentIds = new Set(deferredComponents);
	const projection = {
		status: "confirmed",
		confirmed_at: confirmedAt,
		components: components
			.filter(component => component.status !== "deferred" && !deferredComponentIds.has(component.id as string))
			.map(component => ({
				id: component.id,
				name: textView(component.name),
				description: null,
				active: component.active !== false,
				deferred: false,
				scores: { goal: null, constraints: null, criteria: null, context: null },
				weakest_dimension: null,
			})),
		deferrals: deferredComponents.map(component_id => ({
			component_id,
			reason: textView(""),
			created_at: confirmedAt,
			until_round: null,
		})),
		last_targeted_component_id: null,
	};
	if (Buffer.byteLength(JSON.stringify(projection)) > DATA_LIMIT) throw new RepairError("DI_OUTPUT_LIMIT_EXCEEDED");
}
interface ParsedRepairCommand {
	verb: DeepInterviewRepairVerb;
	flags: Map<string, string>;
}

function parse(args: readonly string[]): ParsedRepairCommand {
	const verb = args[0];
	if (verb === undefined || !isDeepInterviewRepairVerb(verb)) throw new RepairError("DI_UNKNOWN_COMMAND");
	const flags = new Map<string, string>();
	let hasJson = false;
	for (let i = 1; i < args.length; i++) {
		const token = args[i];
		if (!token.startsWith("--") || token.includes("=")) throw new RepairError("DI_INVALID_ARGUMENT");
		if (token === "--json") {
			if (hasJson) throw new RepairError("DI_INVALID_ARGUMENT");
			hasJson = true;
			continue;
		}
		const value = args[++i];
		if (value === undefined || value.startsWith("--") || flags.has(token))
			throw new RepairError("DI_INVALID_ARGUMENT");
		flags.set(token, value);
	}
	if (!hasJson) throw new RepairError("DI_JSON_REQUIRED");
	const session = flags.get("--session-id");
	if (!session || !ID.test(session)) throw new RepairError("DI_INVALID_SESSION_ID");
	return { verb, flags };
}
function safeInt(value: string | undefined, code: string, positive = false): number {
	if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new RepairError(code);
	const number = Number(value);
	if (!Number.isSafeInteger(number) || (positive && number < 1)) throw new RepairError(code);
	return number;
}
function statePath(cwd: string, session: string) {
	return modeStatePath(cwd, session, "deep-interview");
}
function validateMutation(
	parsed: ParsedRepairCommand,
	allowed: readonly string[],
	needsRevision = true,
): { session: string; revision?: number } {
	for (const key of parsed.flags.keys()) if (!allowed.includes(key)) throw new RepairError("DI_INVALID_ARGUMENT");
	const session = parsed.flags.get("--session-id")!;
	const revision = needsRevision
		? safeInt(parsed.flags.get("--expected-revision"), "DI_INVALID_EXPECTED_REVISION")
		: undefined;
	if (needsRevision && parsed.flags.get("--schema-version") !== "1")
		throw new RepairError("DI_INVALID_SCHEMA_VERSION");
	return { session, revision };
}
function transformResult(
	command: string,
	path: string,
	result: {
		revision: number;
		written: boolean;
		stamped?: Record<string, unknown>;
		warnings?: readonly { code: string; message: string }[];
	},
) {
	const state = result.stamped?.state;
	const authoritative =
		state && typeof state === "object" && !Array.isArray(state)
			? {
					current_ambiguity: (state as Record<string, unknown>).current_ambiguity ?? null,
					effective_ambiguity: (state as Record<string, unknown>).effective_ambiguity ?? null,
					floor: (state as Record<string, unknown>).floor ?? null,
					ambiguity_milestone: (state as Record<string, unknown>).ambiguity_milestone ?? null,
				}
			: undefined;
	return {
		ok: true,
		command,
		state_path: path,
		state_revision: result.revision,
		written: result.written,
		content_sha256: result.stamped ? workflowEnvelopeContentSha256(result.stamped) : undefined,
		transition: authoritative,
		warnings: result.warnings ?? [],
	};
}

async function consumeDraftMutation(
	args: readonly string[],
	cwd: string,
): Promise<DeepInterviewRepairResult | undefined> {
	const draft = args.indexOf("--draft-id");
	if (draft === -1) return undefined;
	const verb = args[0];
	if (!verb || !["initialize-context", "confirm-topology", "record-answer", "apply-round-result"].includes(verb))
		throw new RepairError("DI_UNKNOWN_COMMAND");
	const flags = new Map<string, string>();
	let hasJson = false;
	for (let index = 1; index < args.length; ) {
		const flag = args[index++];
		if (flag === "--json") {
			if (hasJson) throw new RepairError("DI_INPUT_MODE_CONFLICT");
			hasJson = true;
			if (args[index] === "true") index++;
			continue;
		}
		const value = args[index++];
		if (
			!flag?.startsWith("--") ||
			!["--draft-id", "--expected-draft-revision"].includes(flag) ||
			value === undefined ||
			value.startsWith("--") ||
			flags.has(flag)
		)
			throw new RepairError("DI_INPUT_MODE_CONFLICT");
		flags.set(flag, value);
	}
	if (!hasJson) throw new RepairError("DI_JSON_REQUIRED");
	const id = flags.get("--draft-id");
	const revision = flags.get("--expected-draft-revision");
	if (!id || !revision) throw new RepairError("DI_INVALID_ARGUMENT");
	const { runDeepInterviewDraftInternalConsumeCommand } = await import("./deep-interview-draft");
	const result = await runDeepInterviewDraftInternalConsumeCommand(
		id,
		Number(revision),
		verb as DeepInterviewDraftKind,
		cwd,
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export async function runDeepInterviewRepairCommand(
	args: readonly string[],
	cwd: string,
): Promise<DeepInterviewRepairResult> {
	try {
		const consumed = await consumeDraftMutation(args, cwd);
		if (consumed) return consumed;
		const parsed = parse(args);
		if (parsed.verb === "sanity-check") return await sanity(parsed, cwd);
		if (parsed.verb === "inspect") return await inspect(parsed, cwd);
		const result = await mutate(parsed, cwd);
		return { status: 0, stdout: `${JSON.stringify(result)}\n` };
	} catch (error) {
		return errorResult(error);
	}
}
async function mutate(parsed: ParsedRepairCommand, cwd: string): Promise<Record<string, unknown>> {
	const configs: Record<Exclude<DeepInterviewRepairVerb, "inspect" | "sanity-check">, readonly string[]> = {
		"initialize-context": ["--session-id", "--schema-version", "--expected-revision", "--input-json"],
		"confirm-topology": ["--session-id", "--schema-version", "--expected-revision", "--input-json"],
		"record-answer": [
			"--session-id",
			"--schema-version",
			"--expected-revision",
			"--round",
			"--question-id",
			"--question-json",
			"--answer-json",
			"--round-id",
			"--component-id",
			"--dimension",
		],
		"apply-round-result": [
			"--session-id",
			"--schema-version",
			"--expected-revision",
			"--round",
			"--question-id",
			"--result-json",
			"--round-id",
		],
	};
	const { session, revision } = validateMutation(parsed, configs[parsed.verb as keyof typeof configs]);
	const setupInput =
		parsed.verb === "initialize-context" ? decodeDeepInterviewSetupJson(parsed.flags.get("--input-json")) : undefined;
	const topologyInput =
		parsed.verb === "confirm-topology"
			? decodeDeepInterviewTopologyJson(parsed.flags.get("--input-json"))
			: undefined;
	const path = statePath(cwd, session);
	const now = new Date().toISOString();
	let nativeProjection: object | undefined;
	const output = await transformGuardedWorkflowEnvelopeAtomic(path, {
		cwd,
		expectedRevision: revision!,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: `gjc deep-interview ${parsed.verb}`,
			sessionId: session,
			nowIso: now,
		},
		validate(value, legacy) {
			if (legacy) validateLegacyDeepInterviewEnvelope(value);
			else validateDeepInterviewV1Envelope(value);
		},
		audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "deep-interview", sessionId: session },
		transform(current) {
			const state = (
				current.state && typeof current.state === "object" && !Array.isArray(current.state) ? current.state : {}
			) as Record<string, unknown>;
			if (parsed.verb === "initialize-context") {
				const input = setupInput!;
				const unresolvedSetup =
					state.setup !== null &&
					typeof state.setup === "object" &&
					!Array.isArray(state.setup) &&
					(state.setup as Record<string, unknown>).status === "unresolved";
				const missing: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(input)) {
					if (key === "type" && unresolvedSetup) {
						if (
							current.trace !== undefined &&
							canonicalDeepInterviewJson(state.type) !== canonicalDeepInterviewJson(value)
						)
							throw new RepairError("DI_SETUP_CONFLICT", 4);
						if (canonicalDeepInterviewJson(state.type) !== canonicalDeepInterviewJson(value))
							missing[key] = value;
					} else if (Object.hasOwn(state, key)) {
						if (canonicalDeepInterviewJson(state[key]) !== canonicalDeepInterviewJson(value))
							throw new RepairError("DI_SETUP_CONFLICT", 4);
					} else {
						missing[key] = value;
					}
				}
				if (Object.keys(missing).length === 0 && !unresolvedSetup) return { kind: "noop" as const };
				const { setup: _setup, ...initializedState } = state;
				return {
					kind: "write" as const,
					value: { ...current, schema_version: 1, state: { ...initializedState, ...missing } },
				};
			}
			if (parsed.verb === "confirm-topology") {
				const input = topologyInput!;
				assertTopologyInspectable(input, now);
				const existing = state.topology;
				const normalized = canonicalDeepInterviewJson(input);
				if (existing && typeof existing === "object" && !Array.isArray(existing)) {
					const existingTopology = existing as Record<string, unknown>;
					const isEmptyPendingTopology =
						existingTopology.status === "pending" &&
						Array.isArray(existingTopology.components) &&
						existingTopology.components.length === 0 &&
						Array.isArray(existingTopology.deferred_components) &&
						existingTopology.deferred_components.length === 0;
					if (!isEmptyPendingTopology) {
						const { status: _status, confirmed_at: _confirmedAt, ...prior } = existingTopology;
						if (canonicalDeepInterviewJson(prior) === normalized) return { kind: "noop" as const };
						throw new RepairError("DI_TOPOLOGY_CONFLICT", 4);
					}
				}
				const { setup: _setup, ...confirmedState } = state;
				return {
					kind: "write" as const,
					value: {
						...current,
						schema_version: 1,
						state: { ...confirmedState, topology: { ...input, status: "confirmed", confirmed_at: now } },
					},
				};
			}
			const round = safeInt(parsed.flags.get("--round"), "DI_INVALID_ROUND", true);
			const questionId = parsed.flags.get("--question-id");
			if (!questionId || !ID.test(questionId)) throw new RepairError("DI_INVALID_QUESTION_ID");
			const roundId = parsed.flags.get("--round-id");
			if (roundId !== undefined && !ID.test(roundId)) throw new RepairError("DI_INVALID_ROUND_ID");
			const key = deriveRoundKey(typeof state.interview_id === "string" ? state.interview_id : undefined, {
				round,
				round_id: roundId,
				questionId,
			});
			if (parsed.verb === "record-answer") {
				const component = parsed.flags.get("--component-id");
				const requestedDimension = parsed.flags.get("--dimension");
				if (component !== undefined && !ID.test(component)) throw new RepairError("DI_INVALID_COMPONENT_ID");
				if (
					requestedDimension !== undefined &&
					!DIMENSIONS.includes(requestedDimension as (typeof DIMENSIONS)[number])
				)
					throw new RepairError("DI_INVALID_DIMENSION");
				const question = stringJson(parsed.flags.get("--question-json"));
				const answer = decodeDeepInterviewAnswerJson(parsed.flags.get("--answer-json"));
				const rounds = Array.isArray(state.rounds) ? [...state.rounds] : [];
				const candidate = {
					round,
					round_key: key,
					round_id: roundId ?? undefined,
					question_id: questionId,
					component,
					dimension: requestedDimension,
					question_text: question,
					question_hash: questionHash(question),
					answer_hash: answerHash(answer.selected_options, answer.custom_input ?? undefined),
					selected_options: answer.selected_options,
					custom_input: answer.custom_input ?? undefined,
				};
				const existing = rounds.find(
					value => value && typeof value === "object" && (value as Record<string, unknown>).round_key === key,
				);
				if (existing) {
					if (
						deepInterviewAnswerIdentityEqual(
							existing as Parameters<typeof deepInterviewAnswerIdentityEqual>[0],
							candidate,
						)
					)
						return { kind: "noop" as const };
					throw new RepairError(
						(existing as Record<string, unknown>).lifecycle === "scored"
							? "DI_SHELL_CONFLICT"
							: "DI_ANSWER_CONFLICT",
						4,
					);
				}
				rounds.push({
					...candidate,
					lifecycle: "answered",
					answered_at: now,
				});
				return { kind: "write" as const, value: { ...current, schema_version: 1, state: { ...state, rounds } } };
			}
			const result = decodeDeepInterviewRoundResultJson(parsed.flags.get("--result-json"), state);
			try {
				const outcome = applyDeepInterviewRoundResultV1(current, key, result, now);
				nativeProjection = outcome.projection;
				if (outcome.kind === "noop") return { kind: "noop" as const };
				return {
					kind: "write" as const,
					value: {
						...persistNativeTriggerMetrics(state, outcome.envelope, key, result),
						schema_version: 1,
					},
				};
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("DI_"))
					throw new RepairError(error.message, error.message.includes("CONFLICT") ? 4 : 3);
				throw error;
			}
		},
	});
	const warnings =
		output.written && output.stamped
			? await runDeepInterviewPostCommitEffects({
					cwd,
					statePath: path,
					sessionId: session,
					envelope: output.stamped,
					revision: output.revision,
					writer: "deep-interview-repair",
					auditWarnings: output.warnings,
				})
			: [];
	return {
		...transformResult(parsed.verb, path, { ...output, warnings }),
		native_projection: nativeProjection,
	};
}
function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	let result = "";
	for (const character of value) {
		if (Buffer.byteLength(result) + Buffer.byteLength(character) > maxBytes) break;
		result += character;
	}
	return result;
}
type InspectSelector = "summary" | "recent-scored" | "pending" | "round" | "topology" | "facts" | "triggers" | "floor";
const INSPECT_SELECTORS = new Set<InspectSelector>([
	"summary",
	"recent-scored",
	"pending",
	"round",
	"topology",
	"facts",
	"triggers",
	"floor",
]);
const PAGED_SELECTORS = new Set<InspectSelector>(["recent-scored", "pending", "facts", "triggers"]);
const DATA_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 48 * 1024;
const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const textView = (value: unknown, limit = 1024) => {
	const text = typeof value === "string" ? value : "";
	const original_bytes = Buffer.byteLength(text);
	return { value: truncateUtf8(text, limit), truncated: original_bytes > limit, original_bytes };
};
const nullableTextView = (value: unknown, limit = 1024) => (typeof value === "string" ? textView(value, limit) : null);
const nullableId = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : null);
const nullableScore = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
function persistNativeTriggerMetrics(
	priorState: Record<string, unknown>,
	envelope: Record<string, unknown>,
	roundKey: string,
	result: DeepInterviewRoundResultV1,
): Record<string, unknown> {
	const nextState = asRecord(envelope.state);
	const rounds = Array.isArray(nextState.rounds) ? nextState.rounds.map(asRecord) : [];
	const roundIndex = rounds.findIndex(round => round.round_key === roundKey);
	if (roundIndex < 0) throw new Error("DI_STATE_SCHEMA_INVALID");
	const round = rounds[roundIndex];
	const prior = rounds
		.filter(
			candidate =>
				candidate.lifecycle === "scored" &&
				(Number(candidate.round) < Number(round.round) ||
					(Number(candidate.round) === Number(round.round) &&
						String(candidate.round_key) < String(round.round_key))),
		)
		.sort(
			(left, right) =>
				Number(right.round) - Number(left.round) || String(right.round_key).localeCompare(String(left.round_key)),
		)[0];
	const priorTopology = asRecord(priorState.topology);
	const priorComponents = Array.isArray(priorTopology.components) ? priorTopology.components.map(asRecord) : [];
	const nextTopology = asRecord(nextState.topology);
	const nextComponents = Array.isArray(nextTopology.components) ? nextTopology.components.map(asRecord) : [];
	const hasTopologyComponents = priorComponents.length > 0;
	const priorAmbiguity = nullableScore(prior?.ambiguity);
	const newAmbiguity = nullableScore(round.ambiguity);
	const triggers = (Array.isArray(round.triggers) ? round.triggers : []).map(value => {
		const trigger = asRecord(value);
		const dimension = String(trigger.dimension);
		const component = String(trigger.component);
		const priorComponent = priorComponents.find(candidate => candidate.id === component);
		const nextComponent = nextComponents.find(candidate => candidate.id === component);
		const metrics =
			trigger.status === "active"
				? {
						prior_dimension_score: hasTopologyComponents
							? nullableScore(asRecord(priorComponent?.clarity_scores)[dimension])
							: nullableScore(asRecord(prior?.scores)[dimension]),
						new_dimension_score: hasTopologyComponents
							? nullableScore(asRecord(nextComponent?.clarity_scores)[dimension])
							: nullableScore(asRecord(result.global_scores)[dimension]),
						prior_effective_ambiguity: priorAmbiguity,
						new_effective_ambiguity: newAmbiguity,
					}
				: {
						prior_dimension_score: null,
						new_dimension_score: null,
						prior_effective_ambiguity: null,
						new_effective_ambiguity: null,
					};
		return {
			...trigger,
			...metrics,
		};
	});
	rounds[roundIndex] = { ...round, triggers };
	return { ...envelope, state: { ...nextState, rounds } };
}
function roundProjection(value: unknown, shell = false): Record<string, unknown> {
	const round = asRecord(value);
	const answer = {
		selected_options: Array.isArray(round.selected_options)
			? round.selected_options.map(option => textView(option))
			: [],
		custom_input: nullableTextView(round.custom_input),
	};
	const base = {
		round_key: String(round.round_key),
		round: Number(round.round),
		round_id: nullableId(round.round_id),
		question_id: nullableId(round.question_id),
		component_id: nullableId(round.component),
		dimension: ["goal", "constraints", "criteria", "context"].includes(String(round.dimension))
			? round.dimension
			: null,
		question: nullableTextView(round.question_text, 2048),
		answer,
		lifecycle:
			round.lifecycle === "scored"
				? "scored"
				: round.lifecycle === "pending_scoring"
					? "pending_scoring"
					: "answered",
		answered_at: String(round.answered_at),
	};
	if (shell)
		return {
			...base,
			question_id: String(round.question_id),
			question: textView(round.question_text, 2048),
			lifecycle: base.lifecycle === "scored" ? "answered" : base.lifecycle,
		};
	return {
		...base,
		scored_at: typeof round.scored_at === "string" ? round.scored_at : null,
		weighted_ambiguity: nullableScore(round.reported_ambiguity),
		effective_ambiguity: nullableScore(round.ambiguity),
		floor: nullableScore(round.ambiguity_floor),
		round_result_digest:
			typeof round.round_result_digest === "string" && /^[0-9a-f]{64}$/.test(round.round_result_digest)
				? { v: 1, algorithm: "sha256", value: round.round_result_digest }
				: null,
	};
}
function sortKey(selector: InspectSelector, item: Record<string, unknown>, insertion = 0): unknown[] {
	if (selector === "recent-scored" || selector === "pending") return [item.round, item.round_key];
	if (selector === "facts") return [item.id, insertion];
	return [item.source_round, item.source_round_key, insertion];
}
function compareKeys(selector: InspectSelector, left: unknown[], right: unknown[]): number {
	for (let index = 0; index < left.length; index++) {
		const order =
			typeof left[index] === "number" && typeof right[index] === "number"
				? Number(left[index]) - Number(right[index])
				: String(left[index]).localeCompare(String(right[index]));
		if (order !== 0) return selector === "recent-scored" ? -order : order;
	}
	return 0;
}
function cursorFor(selector: InspectSelector, revision: number, view_sha256: string, last_sort_key: unknown[]) {
	return Buffer.from(JSON.stringify({ v: 1, selector, revision, view_sha256, last_sort_key })).toString("base64url");
}
function cursorOffset(
	token: string | undefined,
	selector: InspectSelector,
	revision: number,
	view: string,
	items: Record<string, unknown>[],
): number {
	if (!token) return 0;
	let cursor: Record<string, unknown>;
	try {
		const decoded = Buffer.from(token, "base64url").toString("utf8");
		if (!/^[A-Za-z0-9_-]+$/.test(token) || Buffer.from(decoded).toString("base64url") !== token) throw new Error();
		cursor = strictJson(decoded) as Record<string, unknown>;
	} catch {
		throw new RepairError("DI_CURSOR_INVALID");
	}
	const arity = selector === "triggers" ? 3 : 2;
	if (
		!cursor ||
		Object.keys(cursor).length !== 5 ||
		["v", "selector", "revision", "view_sha256", "last_sort_key"].some(key => !Object.hasOwn(cursor, key)) ||
		cursor.v !== 1 ||
		cursor.selector !== selector ||
		!Number.isSafeInteger(cursor.revision) ||
		typeof cursor.view_sha256 !== "string" ||
		!Array.isArray(cursor.last_sort_key) ||
		cursor.last_sort_key.length !== arity ||
		cursor.last_sort_key.some((value, index) => {
			const numberPart =
				selector === "recent-scored" || selector === "pending"
					? index === 0
					: selector === "facts"
						? index === 1
						: index === 0 || index === 2;
			return numberPart ? typeof value !== "number" || !Number.isSafeInteger(value) : typeof value !== "string";
		})
	)
		throw new RepairError("DI_CURSOR_INVALID");
	if (cursor.revision !== revision || cursor.view_sha256 !== view) throw new RepairError("DI_CURSOR_STALE", 3);
	const found = items.findIndex(
		item =>
			canonicalDeepInterviewJson(sortKey(selector, item, Number(item.insertion_index ?? 0))) ===
			canonicalDeepInterviewJson(cursor.last_sort_key),
	);
	if (found < 0) throw new RepairError("DI_CURSOR_INVALID");
	return found + 1;
}
const LEGACY_COLLECTION_LIMIT = 64;
function validateLegacyDeepInterviewEnvelope(value: Record<string, unknown>): void {
	const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
		Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate);
	const isId = (candidate: unknown) => typeof candidate === "string" && ID.test(candidate);
	const isScore = (candidate: unknown) =>
		typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1;
	const isBoundedText = (candidate: unknown, max = 4096): candidate is string =>
		typeof candidate === "string" && Buffer.byteLength(candidate) <= max;
	const boundedRecords = (candidate: unknown): Record<string, unknown>[] => {
		if (
			!Array.isArray(candidate) ||
			candidate.length > LEGACY_COLLECTION_LIMIT ||
			candidate.some(entry => !isRecord(entry))
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
		return candidate;
	};
	const optional = (candidate: unknown, predicate: (item: unknown) => boolean) =>
		candidate === undefined || candidate === null || predicate(candidate);

	const state = value.state;
	if (
		!isRecord(state) ||
		(value.state_revision !== undefined &&
			(!Number.isSafeInteger(value.state_revision) || (value.state_revision as number) < 0)) ||
		(value.active !== undefined && typeof value.active !== "boolean") ||
		(value.current_phase !== undefined && typeof value.current_phase !== "string")
	)
		throw new Error("DI_STATE_SCHEMA_INVALID");

	const rounds = state.rounds === undefined ? [] : boundedRecords(state.rounds);
	const facts = state.established_facts === undefined ? [] : boundedRecords(state.established_facts);
	for (const round of rounds) {
		if (
			!optional(round.round_key, isId) ||
			!optional(round.round, value => Number.isSafeInteger(value) && (value as number) > 0) ||
			!optional(round.lifecycle, value => ["answered", "pending_scoring", "scored"].includes(String(value))) ||
			!optional(round.question_id, isId) ||
			!optional(round.question_text, isBoundedText) ||
			!optional(round.question_hash, value => isBoundedText(value, 128) && value.length > 0) ||
			!optional(round.answer_hash, value => isBoundedText(value, 128) && value.length > 0) ||
			!optional(
				round.selected_options,
				value =>
					Array.isArray(value) &&
					value.length <= LEGACY_COLLECTION_LIMIT &&
					value.every(
						option => typeof option === "string" && option.length > 0 && Buffer.byteLength(option) <= 2048,
					),
			) ||
			!optional(round.custom_input, value => typeof value === "string" && Buffer.byteLength(value) <= 4096) ||
			!optional(round.scores, value => {
				if (
					!isRecord(value) ||
					Object.keys(value).some(key => !DIMENSIONS.includes(key as (typeof DIMENSIONS)[number]))
				)
					return false;
				return Object.values(value).every(isScore);
			}) ||
			!["ambiguity", "reported_ambiguity", "ambiguity_floor", "weighted_ambiguity", "effective_ambiguity"].every(
				key => optional(round[key], isScore),
			) ||
			!optional(round.auto_answered, value => typeof value === "boolean") ||
			!optional(round.triggers, value => {
				const triggers = boundedRecords(value);
				return triggers.every(
					trigger =>
						optional(trigger.kind, value => ["A", "B", "C", "D"].includes(String(value))) &&
						optional(trigger.name, isBoundedText) &&
						optional(trigger.status, value => ["active", "disputed", "unresolved"].includes(String(value))) &&
						optional(trigger.component, isId) &&
						optional(trigger.dimension, value =>
							["goal", "constraints", "criteria", "context"].includes(String(value)),
						) &&
						optional(trigger.evidence, isBoundedText) &&
						optional(trigger.rationale, isBoundedText) &&
						optional(trigger.contradictedFactId, isId),
				);
			})
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	for (const fact of facts) {
		if (
			!optional(fact.id, isId) ||
			!optional(fact.round, value => Number.isSafeInteger(value) && (value as number) > 0) ||
			!optional(fact.statement, isBoundedText) ||
			!optional(fact.disputed, value => typeof value === "boolean") ||
			!optional(fact.superseded_by, isId) ||
			!optional(fact.component, isId) ||
			!optional(fact.dimension, value => ["goal", "constraints", "criteria", "context"].includes(String(value))) ||
			!optional(fact.evidence, isBoundedText) ||
			!optional(fact.resolution_reason, isBoundedText)
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	if (state.topology !== undefined) {
		if (!isRecord(state.topology)) throw new Error("DI_STATE_SCHEMA_INVALID");
		const topology = state.topology;
		if (
			!optional(topology.components, value =>
				boundedRecords(value).every(
					component =>
						isId(component.id) &&
						optional(component.name, isBoundedText) &&
						optional(component.description, isBoundedText) &&
						optional(component.status, value => typeof value === "string") &&
						optional(component.active, value => typeof value === "boolean") &&
						optional(component.weakest_dimension, value =>
							["goal", "constraints", "criteria", "context"].includes(String(value)),
						) &&
						optional(component.clarity_scores, value => {
							if (!isRecord(value)) return false;
							return ["goal", "constraints", "criteria", "context"].every(
								dimension =>
									value[dimension] === undefined || value[dimension] === null || isScore(value[dimension]),
							);
						}),
				),
			) ||
			!optional(
				topology.deferred_components,
				value => Array.isArray(value) && value.length <= LEGACY_COLLECTION_LIMIT && value.every(isId),
			)
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	if (state.ontology_snapshots !== undefined) {
		const snapshots = boundedRecords(state.ontology_snapshots);
		let priorRound = 0;
		for (const snapshot of snapshots) {
			if (
				!Number.isSafeInteger(snapshot.round) ||
				(snapshot.round as number) <= priorRound ||
				typeof snapshot.captured_at !== "string" ||
				!Number.isFinite(Date.parse(snapshot.captured_at)) ||
				!Array.isArray(snapshot.entities) ||
				snapshot.entities.length > LEGACY_COLLECTION_LIMIT ||
				!["no_entities", "first_round", "compared"].includes(String(snapshot.basis)) ||
				!Number.isSafeInteger(snapshot.stable_entities) ||
				!Number.isSafeInteger(snapshot.new_entities) ||
				!Number.isSafeInteger(snapshot.changed_entities) ||
				(snapshot.stability_ratio !== null && !isScore(snapshot.stability_ratio))
			)
				throw new Error("DI_STATE_SCHEMA_INVALID");
			const entities = boundedRecords(snapshot.entities);
			if (
				(snapshot.stable_entities as number) < 0 ||
				(snapshot.new_entities as number) < 0 ||
				(snapshot.changed_entities as number) < 0 ||
				(snapshot.stable_entities as number) +
					(snapshot.new_entities as number) +
					(snapshot.changed_entities as number) !==
					entities.length ||
				((snapshot.basis === "no_entities" || snapshot.basis === "first_round") &&
					snapshot.stability_ratio !== null) ||
				(snapshot.basis === "compared" && snapshot.stability_ratio === null) ||
				entities.some(
					entity =>
						!isId(entity.id) ||
						!isBoundedText(entity.name, 1024) ||
						entity.name === "" ||
						!isBoundedText(entity.type, 1024) ||
						!Array.isArray(entity.fields) ||
						entity.fields.length > 16 ||
						!entity.fields.every(field => isBoundedText(field, 1024)) ||
						!Array.isArray(entity.relationships) ||
						entity.relationships.length > 16 ||
						!entity.relationships.every(relationship => isBoundedText(relationship, 1024)),
				)
			)
				throw new Error("DI_STATE_SCHEMA_INVALID");
			priorRound = snapshot.round as number;
		}
	}
	if (state.counters !== undefined) {
		if (!isRecord(state.counters) || Object.keys(state.counters).length > LEGACY_COLLECTION_LIMIT)
			throw new Error("DI_STATE_SCHEMA_INVALID");
		for (const [key, count] of Object.entries(state.counters))
			if (!isId(key) || typeof count !== "number" || !Number.isSafeInteger(count) || Math.abs(count) > 1_000_000_000)
				throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	if (
		state.auto_answer_streak !== undefined &&
		(!Number.isSafeInteger(state.auto_answer_streak) || (state.auto_answer_streak as number) < 0)
	)
		throw new Error("DI_STATE_SCHEMA_INVALID");
	for (const key of ["auto_answered_rounds", "auto_researched_rounds"] as const) {
		if (
			state[key] !== undefined &&
			(!Array.isArray(state[key]) ||
				state[key].length > LEGACY_COLLECTION_LIMIT ||
				!state[key].every(value => isId(value) || (Number.isSafeInteger(value) && value > 0)))
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
	}
}

function inspectState(read: Record<string, unknown>, legacy: boolean): Record<string, unknown> {
	try {
		if (legacy) validateLegacyDeepInterviewEnvelope(read);
		else validateDeepInterviewV1Envelope(read);
	} catch {
		throw new RepairError("DI_STATE_SCHEMA_INVALID", 3);
	}
	return read.state as Record<string, unknown>;
}

type DeepInterviewDiagnostic = {
	code?: string;
	legacy: boolean;
	state?: Record<string, unknown>;
	value?: Record<string, unknown>;
};

function receiptIssue(receipt: ReturnType<typeof verifyWorkflowEnvelopeReceiptValue>): string | undefined {
	if (receipt === "native-valid" || receipt === "legacy") return undefined;
	return `DI_RECEIPT_${
		receipt === "checksum-mismatch" ? "CHECKSUM_MISMATCH" : receipt === "receipt-missing" ? "MISSING" : "MALFORMED"
	}`;
}

function diagnoseDeepInterviewState(
	read: Awaited<ReturnType<typeof readExistingStateForMutation>>,
	path: string,
): DeepInterviewDiagnostic {
	if (read.kind !== "valid")
		return { code: read.kind === "absent" ? "DI_STATE_ABSENT" : "DI_STATE_CORRUPT", legacy: false };

	const receipt = verifyWorkflowEnvelopeReceiptValue(read.value, path);
	const receiptCode = receiptIssue(receipt);
	if (receiptCode) return { code: receiptCode, legacy: false };

	const legacy = receipt === "legacy";
	let state: Record<string, unknown>;
	try {
		state = inspectState(read.value, legacy);
	} catch (error) {
		return { code: error instanceof RepairError ? error.code : "DI_STATE_SCHEMA_INVALID", legacy };
	}

	if (read.value.current_phase === "complete" || read.value.current_phase === "handoff" || read.value.active === false)
		return { code: "DI_PHASE_NOT_REPAIRABLE", legacy };

	return { legacy, state, value: read.value };
}
async function inspect(parsed: ParsedRepairCommand, cwd: string): Promise<DeepInterviewRepairResult> {
	const { session } = validateMutation(
		parsed,
		["--session-id", "--selector", "--round-key", "--limit", "--cursor"],
		false,
	);
	const selector = parsed.flags.get("--selector") as InspectSelector | undefined;
	if (!selector || !INSPECT_SELECTORS.has(selector)) throw new RepairError("DI_INVALID_SELECTOR");
	const paged = PAGED_SELECTORS.has(selector);
	for (const flag of parsed.flags.keys())
		if (
			![
				"--session-id",
				"--selector",
				...(selector === "round" ? ["--round-key"] : []),
				...(paged ? ["--limit", "--cursor"] : []),
			].includes(flag)
		)
			throw new RepairError("DI_SELECTOR_ARGUMENT_INVALID");
	if (selector === "round" && !parsed.flags.get("--round-key")) throw new RepairError("DI_SELECTOR_ARGUMENT_INVALID");
	const path = statePath(cwd, session);
	const diagnostic = diagnoseDeepInterviewState(await readExistingStateForMutation(path), path);
	if (diagnostic.code || !diagnostic.state || !diagnostic.value)
		throw new RepairError(diagnostic.code ?? "DI_INTERNAL_ERROR", 3);
	const { legacy, state, value } = diagnostic;
	const revision =
		typeof value.state_revision === "number" && Number.isSafeInteger(value.state_revision) ? value.state_revision : 0;
	const rounds = Array.isArray(state.rounds) ? state.rounds.map(asRecord) : [];
	let data: Record<string, unknown>;
	let collection: Record<string, unknown>[] = [];
	if (selector === "summary")
		data = {
			interview_id: nullableId(state.interview_id),
			type: state.type === "greenfield" || state.type === "brownfield" ? state.type : null,
			initial_idea: nullableTextView(state.initial_idea),
			resolution: ["quick", "standard", "deep"].includes(String(value.resolution))
				? value.resolution
				: ["quick", "standard", "deep"].includes(String(state.resolution))
					? state.resolution
					: null,
			threshold: nullableScore(state.threshold),
			current_ambiguity: nullableScore(state.current_ambiguity),
			ambiguity_milestone: ["initial", "progress", "refined", "ready"].includes(String(state.ambiguity_milestone))
				? state.ambiguity_milestone
				: null,
			topology_status: asRecord(state.topology).status === "confirmed" ? "confirmed" : "pending",
			state_revision: revision,
		};
	else if (selector === "round") {
		const round = rounds.find(value => value.round_key === parsed.flags.get("--round-key"));
		if (!round) throw new RepairError("DI_ROUND_NOT_FOUND", 3);
		data = { item: roundProjection(round) };
	} else if (selector === "topology") {
		const topology = asRecord(state.topology);
		const deferredComponents = (
			Array.isArray(topology.deferred_components) ? topology.deferred_components : []
		).filter((value): value is string => typeof value === "string" && ID.test(value));
		const deferredComponentIds = new Set(deferredComponents);
		data = {
			status: topology.status === "confirmed" ? "confirmed" : "pending",
			confirmed_at: typeof topology.confirmed_at === "string" ? topology.confirmed_at : null,
			components: (Array.isArray(topology.components) ? topology.components : [])
				.filter(component => {
					const item = asRecord(component);
					return item.status !== "deferred" && !deferredComponentIds.has(String(item.id));
				})
				.map(component => {
					const item = asRecord(component);
					const scores = asRecord(item.clarity_scores);
					return {
						id: String(item.id),
						name: textView(item.name),
						description: nullableTextView(item.description),
						active: item.active !== false,
						deferred: false,
						scores: {
							goal: nullableScore(scores.goal),
							constraints: nullableScore(scores.constraints),
							criteria: nullableScore(scores.criteria),
							context: state.type === "greenfield" ? null : nullableScore(scores.context),
						},
						weakest_dimension: ["goal", "constraints", "criteria", "context"].includes(
							String(item.weakest_dimension),
						)
							? item.weakest_dimension
							: null,
					};
				}),
			deferrals: deferredComponents.map(component_id => ({
				component_id,
				reason: textView(""),
				created_at: typeof topology.confirmed_at === "string" ? topology.confirmed_at : "",
				until_round: null,
			})),
			last_targeted_component_id: nullableId(topology.last_targeted_component_id),
		};
	} else if (selector === "floor") {
		const floor = computeAmbiguityFloor(state);
		data = {
			floor: floor.floor,
			disputed_fact_count: floor.disputed_fact_count,
			unscored_active_component_count: floor.unscored_active_component_count,
			auto_answer_ratio: floor.auto_answer_ratio,
			weighted_ambiguity: nullableScore(state.weighted_ambiguity),
			effective_ambiguity: nullableScore(state.effective_ambiguity),
		};
	} else {
		if (selector === "recent-scored")
			collection = rounds.filter(round => round.lifecycle === "scored").map(round => roundProjection(round));
		else if (selector === "pending")
			collection = rounds
				.filter(round => round.lifecycle === "answered" || round.lifecycle === "pending_scoring")
				.map(round => roundProjection(round, true));
		else if (selector === "facts")
			collection = (Array.isArray(state.established_facts) ? state.established_facts : []).map(
				(value, insertion_index) => {
					const fact = asRecord(value);
					return {
						id: String(fact.id),
						status: fact.disputed === true ? (fact.superseded_by ? "resolved" : "disputed") : "established",
						source_round: Number(fact.round),
						component_id: nullableId(fact.component),
						dimension: ["goal", "constraints", "criteria", "context"].includes(String(fact.dimension))
							? fact.dimension
							: null,
						statement: textView(fact.statement),
						evidence: nullableTextView(fact.evidence),
						resolution_reason: nullableTextView(fact.resolution_reason),
						superseded_by: nullableId(fact.superseded_by),
						insertion_index,
					};
				},
			);
		else
			collection = rounds.flatMap(round =>
				(Array.isArray(round.triggers) ? round.triggers : []).map((value, insertion_index) => {
					const trigger = asRecord(value);
					return {
						kind: trigger.kind,
						name: textView(trigger.name),
						status: trigger.status,
						source_round: Number(round.round),
						source_round_key: String(round.round_key),
						component_id: String(trigger.component),
						dimension: trigger.dimension,
						prior_dimension_score:
							trigger.status === "active" ? nullableScore(trigger.prior_dimension_score) : null,
						new_dimension_score: trigger.status === "active" ? nullableScore(trigger.new_dimension_score) : null,
						prior_effective_ambiguity:
							trigger.status === "active" ? nullableScore(trigger.prior_effective_ambiguity) : null,
						new_effective_ambiguity:
							trigger.status === "active" ? nullableScore(trigger.new_effective_ambiguity) : null,
						evidence: nullableTextView(trigger.evidence),
						rationale: nullableTextView(trigger.rationale),
						contradicted_fact_id: nullableId(trigger.contradictedFactId),
						insertion_index,
					};
				}),
			);
		collection.sort((a, b) =>
			compareKeys(
				selector,
				sortKey(selector, a, Number(a.insertion_index ?? 0)),
				sortKey(selector, b, Number(b.insertion_index ?? 0)),
			),
		);
		const view_sha256 = createHash("sha256").update(canonicalDeepInterviewJson(collection)).digest("hex");
		const offset = cursorOffset(parsed.flags.get("--cursor"), selector, revision, view_sha256, collection);
		const limit = parsed.flags.has("--limit") ? safeInt(parsed.flags.get("--limit"), "DI_INVALID_LIMIT", true) : 10;
		if (limit > 25) throw new RepairError("DI_INVALID_LIMIT");
		const items: Record<string, unknown>[] = [];
		for (const item of collection.slice(offset, offset + limit)) {
			if (Buffer.byteLength(JSON.stringify({ items: [...items, item] })) > DATA_LIMIT) break;
			items.push(item);
		}
		if (!items.length && offset < collection.length) throw new RepairError("DI_OUTPUT_LIMIT_EXCEEDED", 3);
		data = { items };
		const omitted = offset + items.length < collection.length;
		const next_cursor = omitted
			? cursorFor(
					selector,
					revision,
					view_sha256,
					sortKey(selector, items.at(-1)!, Number(items.at(-1)!.insertion_index ?? 0)),
				)
			: null;
		const response = {
			ok: true,
			command: "inspect",
			schema_version: 1,
			state_path: path,
			state_revision: revision,
			content_sha256: legacy ? null : workflowEnvelopeContentSha256(value),
			view_sha256,
			limits_version: 1,
			data,
			returned_count: items.length,
			total_count: collection.length,
			bytes_returned: Buffer.byteLength(JSON.stringify(data)),
			truncated: omitted,
			next_cursor,
		};
		if (Buffer.byteLength(JSON.stringify(response)) > RESPONSE_LIMIT)
			throw new RepairError("DI_OUTPUT_LIMIT_EXCEEDED", 3);
		return { status: 0, stdout: `${JSON.stringify(response)}\n` };
	}
	const bytes_returned = Buffer.byteLength(JSON.stringify(data));
	if (bytes_returned > DATA_LIMIT) throw new RepairError("DI_OUTPUT_LIMIT_EXCEEDED", 3);
	const response = {
		ok: true,
		command: "inspect",
		schema_version: 1,
		state_path: path,
		state_revision: revision,
		content_sha256: legacy ? null : workflowEnvelopeContentSha256(value),
		view_sha256: createHash("sha256").update(canonicalDeepInterviewJson(data)).digest("hex"),
		limits_version: 1,
		data,
		returned_count: 1,
		total_count: 1,
		bytes_returned,
		truncated: false,
		next_cursor: null,
	};
	if (Buffer.byteLength(JSON.stringify(response)) > RESPONSE_LIMIT)
		throw new RepairError("DI_OUTPUT_LIMIT_EXCEEDED", 3);
	return { status: 0, stdout: `${JSON.stringify(response)}\n` };
}
async function sanity(parsed: ParsedRepairCommand, cwd: string): Promise<DeepInterviewRepairResult> {
	const { session } = validateMutation(parsed, ["--session-id"], false);
	const path = statePath(cwd, session);
	const diagnostic = diagnoseDeepInterviewState(await readExistingStateForMutation(path), path);
	const issues = diagnostic.code ? [issue(diagnostic.code)] : [];
	return {
		status: 0,
		stdout: `${JSON.stringify({
			ok: true,
			command: "sanity-check",
			healthy: issues.length === 0,
			issues,
			limits_version: 1,
		})}\n`,
	};
}
