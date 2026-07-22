import {
	decodeDeepInterviewAnswerJson,
	decodeDeepInterviewRoundResultJson,
	decodeDeepInterviewSetupJson,
	decodeDeepInterviewTopologyJson,
} from "./deep-interview-repair";
import type { DeepInterviewRoundResultV1 } from "./deep-interview-state";

export const DEEP_INTERVIEW_DRAFT_KINDS = [
	"initialize-context",
	"confirm-topology",
	"record-answer",
	"apply-round-result",
] as const;

export type DeepInterviewDraftKind = (typeof DEEP_INTERVIEW_DRAFT_KINDS)[number];
export type DeepInterviewDraftPayload = Record<string, unknown>;
export type DraftScalarType = "string" | "id" | "text" | "score" | "number" | "safe-int" | "boolean" | "enum";
export interface DraftLeafDescriptor {
	kind: "leaf";
	type: DraftScalarType;
	nullable?: boolean;
	maxBytes?: number;
	values?: readonly string[];
	optional?: boolean;
	dynamicMapValue?: boolean;
}
export interface DraftObjectDescriptor {
	kind: "object";
	fields: Record<string, DraftDescriptor>;
	optional?: boolean;
	dynamicMapValue?: boolean;
	dynamicValue?: DraftLeafDescriptor;
}
export interface DraftArrayDescriptor {
	kind: "array";
	item: DraftLeafDescriptor | DraftObjectDescriptor;
	maxItems: number;
	optional?: boolean;
}
export type DraftDescriptor = DraftLeafDescriptor | DraftObjectDescriptor | DraftArrayDescriptor;

const string = (maxBytes: number, optional = true): DraftLeafDescriptor => ({
	kind: "leaf",
	type: "string",
	maxBytes,
	optional,
});
const text = (maxBytes: number, optional = true): DraftLeafDescriptor => ({
	kind: "leaf",
	type: "text",
	maxBytes,
	optional,
});
const id = (optional = true): DraftLeafDescriptor => ({ kind: "leaf", type: "id", maxBytes: 128, optional });
const score = (optional = true): DraftLeafDescriptor => ({ kind: "leaf", type: "score", optional });
const safeInt = (optional = true): DraftLeafDescriptor => ({ kind: "leaf", type: "safe-int", optional });
const boolean = (optional = true): DraftLeafDescriptor => ({ kind: "leaf", type: "boolean", optional });
const enumeration = (values: readonly string[], optional = true, nullable = false): DraftLeafDescriptor => ({
	kind: "leaf",
	type: "enum",
	values,
	optional,
	nullable,
});
const object = (fields: Record<string, DraftDescriptor>, optional = true): DraftObjectDescriptor => ({
	kind: "object",
	fields,
	optional,
});
const array = (
	item: DraftLeafDescriptor | DraftObjectDescriptor,
	maxItems: number,
	optional = true,
): DraftArrayDescriptor => ({
	kind: "array",
	item,
	maxItems,
	optional,
});

const DIMENSIONS = ["goal", "constraints", "criteria", "context"] as const;
const dimensionScores = object(Object.fromEntries(DIMENSIONS.map(dimension => [dimension, score(false)])), false);
const component = object(
	{ id: id(false), name: string(1024), status: enumeration(["active", "deferred"]), active: boolean() },
	false,
);
const setup = object(
	{
		type: enumeration(["greenfield", "brownfield"], false),
		interview_id: id(),
		initial_idea: text(4096),
		initial_context_summary: text(4096),
		codebase_context: text(4096),
		challenge_modes_used: array(string(256, false), 64),
		threshold: score(false),
		threshold_source: text(4096),
		language: text(4096),
		trace: array(string(2048, false), 64),
		trace_summary: text(4096),
	},
	false,
);
const result = object(
	{
		global_scores: dimensionScores,
		component_updates: array(object({ component_id: id(false), scores: dimensionScores }, false), 12),
		targeting: object({
			target_component_id: id(false),
			target_dimension: enumeration(DIMENSIONS, false),
			weakest_component_id: id(false),
			weakest_dimension: enumeration(DIMENSIONS, false),
			last_targeted_component_id: { ...id(false), nullable: true },
		}),
		triggers: array(
			object(
				{
					kind: enumeration(["A", "B", "C", "D"], false),
					name: text(1024, false),
					status: enumeration(["active", "disputed", "unresolved"], false),
					component: id(false),
					dimension: enumeration(DIMENSIONS, false),
					evidence: text(4096),
					contradictedFactId: id(),
					rationale: text(4096),
				},
				false,
			),
			16,
		),
		fact_ops: array(
			object(
				{
					op: enumeration(["add", "dispute", "supersede"], false),
					id: id(false),
					statement: text(4096),
					component: text(128),
					dimension: enumeration(DIMENSIONS),
					evidence: text(4096),
					target_id: id(),
				},
				false,
			),
			32,
		),
		ontology: object({
			entities: array(
				object(
					{
						id: id(false),
						name: text(1024, false),
						type: text(1024, false),
						fields: array(text(1024, false), 16, false),
					},
					false,
				),
				32,
				false,
			),
			relationships: array(
				object(
					{ id: id(false), from_entity_id: id(false), to_entity_id: id(false), type: text(1024, false) },
					false,
				),
				16,
				false,
			),
			reasoning: array(object({ statement: text(4096, false), evidence: text(4096) }, false), 32, false),
		}),
		bookkeeping: object({
			resolution: enumeration(
				["auto_research_accepted", "auto_answer", "direct", "refined", "cited_confirmation"],
				false,
			),
			round_ids: array(id(false), 32),
			counter_deltas: {
				kind: "object",
				fields: {},
				dynamicValue: { ...safeInt(false), dynamicMapValue: true },
				optional: true,
			},
		}),
	},
	false,
);
const DRAFT_SCHEMAS: Record<DeepInterviewDraftKind, DraftObjectDescriptor> = {
	"initialize-context": setup,
	"confirm-topology": object(
		{ components: array(component, 64, false), deferred_components: array(id(false), 64, false) },
		false,
	),
	"record-answer": object(
		{
			question: text(8192, false),
			answer: object(
				{
					selected_options: array(string(2048, false), 64, false),
					custom_input: { ...text(4096, false), nullable: true },
				},
				false,
			),
		},
		false,
	),
	"apply-round-result": result,
};

export function deepInterviewDraftSchema(kind: DeepInterviewDraftKind): DraftObjectDescriptor {
	return DRAFT_SCHEMAS[kind];
}

/** Shared strict payload decoders used by compatibility JSON and CLI-owned drafts. */
export function decodeInitializeContextPayload(payload: unknown): Record<string, unknown> {
	return decodeDeepInterviewSetupJson(payload);
}

export function decodeConfirmTopologyPayload(payload: unknown): Record<string, unknown> {
	return decodeDeepInterviewTopologyJson(payload);
}

export function decodeRecordAnswerPayload(payload: unknown): {
	question: string;
	answer: { selected_options: string[]; custom_input: string | null };
} {
	const input = asRecord(payload);
	if (Object.keys(input).some(key => key !== "question" && key !== "answer")) throw new Error("DI_INVALID_INPUT_JSON");
	if (typeof input.question !== "string") throw new Error("DI_INVALID_QUESTION_JSON");
	return { question: input.question, answer: decodeDeepInterviewAnswerJson(input.answer) };
}

export function decodeApplyRoundResultPayload(
	payload: unknown,
	state: Record<string, unknown>,
): DeepInterviewRoundResultV1 {
	return decodeDeepInterviewRoundResultJson(payload, state);
}

export function validateDraftPayload(
	kind: DeepInterviewDraftKind,
	payload: unknown,
	state: Record<string, unknown> = {},
): void {
	switch (kind) {
		case "initialize-context":
			decodeInitializeContextPayload(payload);
			return;
		case "confirm-topology":
			decodeConfirmTopologyPayload(payload);
			return;
		case "record-answer":
			decodeRecordAnswerPayload(payload);
			return;
		case "apply-round-result":
			decodeApplyRoundResultPayload(payload, state);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error("DI_INVALID_INPUT_JSON");
	return value as Record<string, unknown>;
}
