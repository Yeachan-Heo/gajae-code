import { randomBytes, timingSafeEqual } from "node:crypto";
import { schemaHash } from "../modes/shared/agent-wire/workflow-gate-schema";
import type { JsonSchema, WorkflowGate } from "../modes/shared/agent-wire/workflow-gate-types";
import { buildAskGateAnswerSchema, validateAskGateStageState } from "../modes/shared/agent-wire/workflow-gate-types";

export type PublicReason =
	| "unsupported_gate"
	| "query_unavailable"
	| "pagination_malformed"
	| "row_unrepresentable"
	| "missing_runtime_turn"
	| "invalid_runtime_turn"
	| "invalid_gate_row"
	| "wrong_session"
	| "ownership_unavailable"
	| "ownership_conflict"
	| "gate_provenance_changed"
	| "turn_terminal"
	| "endpoint_changed"
	| "terminal_race"
	| "terminal_uncertain"
	| "session_closing"
	| "session_unavailable"
	| "reported_failure"
	| "validation_rejected";
export type CoordinatorQuestionStatusV1 = "pending" | "answered" | "stale" | "uncertain";
export interface CoordinatorQuestionOptionPublicV1 {
	id: string;
	label: string;
	recommended: boolean;
}
export interface CoordinatorQuestionPublicV1 extends Record<string, unknown> {
	schema_version: 1;
	question_id: string;
	session_id: string;
	turn_id: string;
	status: CoordinatorQuestionStatusV1;
	stage: string;
	kind: string;
	prompt: string;
	multi: boolean;
	allow_empty: boolean;
	options: CoordinatorQuestionOptionPublicV1[];
	other_allowed: boolean;
	clarification_allowed: boolean;
	created_at: string;
	updated_at: string;
	answered_at: string | null;
	reason: PublicReason | null;
	answer_binding?: string;
}
export interface CoordinatorQuestionDiagnosticPublicV1 {
	schema_version: 1;
	session_id: string;
	turn_id: string | null;
	gate_id: string | null;
	reason: PublicReason;
	observed_at: string;
}
export interface CoordinatorQuestionReconciliationPublicV1 {
	attempted: boolean;
	complete: boolean;
	revision: string | null;
	observed_at: string;
	reason: PublicReason | null;
}
export interface ListQuestionsSuccessV1 extends Record<string, unknown> {
	ok: true;
	schema_version: 1;
	questions: CoordinatorQuestionPublicV1[];
	diagnostics: CoordinatorQuestionDiagnosticPublicV1[];
	reconciliation: CoordinatorQuestionReconciliationPublicV1;
}
export type CoordinatorAskAnswerV1 =
	| { selected: string[]; other?: false }
	| { selected: string[]; other: true; custom: string }
	| { action: "clarify"; question: string };
export interface SubmitQuestionAnswerInputV1 {
	session_id: string;
	turn_id: string;
	question_id: string;
	answer_binding: string;
	answer: CoordinatorAskAnswerV1;
	idempotency_key: string;
	allow_mutation: true;
}
export type SubmitQuestionAnswerSuccessV1 = {
	ok: true;
	schema_version: 1;
	session_id: string;
	turn_id: string;
	question_id: string;
	operation: "workflow.gate_answer";
	status: "accepted";
	replayed: boolean;
	resolved_at: string;
};
export type SubmitQuestionAnswerValidationRejectedV1 = {
	ok: false;
	schema_version: 1;
	session_id: string;
	turn_id: string;
	question_id: string;
	error: { code: "validation_rejected"; message: string };
	question_status: "pending";
};
export type SubmitQuestionAnswerFailureV1 = {
	ok: false;
	error: {
		code: "not_found" | "resource_gone" | "ownership_mismatch" | "terminal_uncertain" | "idempotency_conflict";
		message: string;
	};
};
export interface PrivateAskGateCodecV1 {
	schema_version: 1;
	labels: string[];
	recommended_index: number | null;
	multi: boolean;
	allow_empty: boolean;
	other_allowed: true;
	clarification_allowed: true;
}

const MAX_TEXT = 4096;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const boundedText = (value: unknown, max = 256): value is string =>
	typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
function sameKeys(value: Record<string, unknown>, permitted: readonly string[]): boolean {
	return Object.keys(value).every(key => permitted.includes(key));
}
function validStageState(value: unknown, labels: string[]): value is Record<string, unknown> {
	try {
		validateAskGateStageState(value);
	} catch {
		return false;
	}
	const state = value as Record<string, unknown>;
	return (
		Array.isArray(state.options) &&
		state.options.length === labels.length &&
		state.options.every((item, index) => item === labels[index])
	);
}
function askSchema(labels: string[], multi: boolean, allowEmpty: boolean): JsonSchema {
	return buildAskGateAnswerSchema({ multi, allowEmpty }, labels);
}
export function decodeAskGateV1(gate: WorkflowGate): PrivateAskGateCodecV1 | null {
	if (
		gate.stage !== "deep-interview" ||
		gate.kind !== "question" ||
		!isRecord(gate.context) ||
		!boundedText(gate.context.prompt, MAX_TEXT) ||
		gate.context.prompt !== gate.context.title ||
		!Array.isArray(gate.options) ||
		gate.options.length > 32
	)
		return null;
	const labels: string[] = [];
	let recommendedIndex: number | null = null;
	for (const option of gate.options) {
		if (
			!isRecord(option) ||
			!boundedText(option.label) ||
			option.value !== option.label ||
			labels.includes(option.label)
		)
			return null;
		if (option.description === "recommended") {
			if (recommendedIndex !== null) return null;
			recommendedIndex = labels.length;
		} else if (option.description !== undefined) return null;
		labels.push(option.label);
	}
	if (!validStageState(gate.context.stage_state, labels)) return null;
	const multi = gate.context.stage_state.multi as boolean;
	const allowEmpty = gate.context.stage_state.allow_empty as boolean;
	if (gate.schema_hash !== schemaHash(askSchema(labels, multi, allowEmpty))) return null;
	return {
		schema_version: 1,
		labels,
		recommended_index: recommendedIndex,
		multi,
		allow_empty: allowEmpty,
		other_allowed: true,
		clarification_allowed: true,
	};
}
export function projectAskGateQuestion(input: {
	question_id: string;
	session_id: string;
	turn_id: string;
	status: CoordinatorQuestionStatusV1;
	stage: string;
	kind: string;
	prompt: string;
	codec: PrivateAskGateCodecV1;
	created_at: string;
	updated_at: string;
	answered_at: string | null;
	reason: PublicReason | null;
	answer_binding?: string;
}): CoordinatorQuestionPublicV1 {
	return {
		schema_version: 1,
		question_id: input.question_id,
		session_id: input.session_id,
		turn_id: input.turn_id,
		status: input.status,
		stage: input.stage,
		kind: input.kind,
		prompt: input.prompt,
		multi: input.codec.multi,
		allow_empty: input.codec.allow_empty,
		options: input.codec.labels.map((label, index) => ({
			id: `opt_${index}`,
			label,
			recommended: input.codec.recommended_index === index,
		})),
		other_allowed: true,
		clarification_allowed: true,
		created_at: input.created_at,
		updated_at: input.updated_at,
		answered_at: input.answered_at,
		reason: input.reason,
		...(input.status === "pending" && input.answer_binding ? { answer_binding: input.answer_binding } : {}),
	};
}
export function validateCoordinatorAskAnswer(
	codec: PrivateAskGateCodecV1,
	answer: unknown,
): CoordinatorAskAnswerV1 | null {
	if (!isRecord(answer)) return null;
	if (answer.action === "clarify")
		return sameKeys(answer, ["action", "question"]) && boundedText(answer.question, MAX_TEXT)
			? { action: "clarify", question: answer.question }
			: null;
	if (
		!sameKeys(answer, ["selected", "other", "custom", "action"]) ||
		(answer.action !== undefined && answer.action !== "answer") ||
		!Array.isArray(answer.selected) ||
		answer.selected.length > 32 ||
		!answer.selected.every(item => typeof item === "string") ||
		new Set(answer.selected).size !== answer.selected.length ||
		!answer.selected.every(
			item => /^opt_([0-9]|[12][0-9]|3[01])$/.test(item) && Number(item.slice(4)) < codec.labels.length,
		) ||
		(!codec.multi && answer.selected.length > 1)
	)
		return null;
	if (answer.other === true)
		return answer.selected.length === 0 && boundedText(answer.custom, MAX_TEXT)
			? { selected: [], other: true, custom: answer.custom }
			: null;
	if (
		answer.other !== undefined ||
		answer.custom !== undefined ||
		(!codec.allow_empty && answer.selected.length === 0)
	)
		return null;
	return { selected: [...answer.selected] };
}
export function translateCoordinatorAskAnswer(codec: PrivateAskGateCodecV1, answer: CoordinatorAskAnswerV1): unknown {
	if ("action" in answer) return answer;
	return { ...answer, selected: answer.selected.map(id => codec.labels[Number(id.slice(4))]!) };
}
export function createAnswerBinding(): string {
	return randomBytes(32).toString("base64url");
}
export function answerBindingMatches(binding: string, expected: string): boolean {
	const left = Buffer.from(binding);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}
