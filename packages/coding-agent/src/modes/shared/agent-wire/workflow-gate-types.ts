/** Transport-neutral workflow gate contract used by SDK workflow coordination. */

/** Lifecycle stages that emit machine-addressable SDK workflow gates. */
export type WorkflowStage = "deep-interview" | "ralplan" | "ultragoal";

/** Lifecycle stages included in the v1 workflow-gate contract. */
export const WORKFLOW_GATE_V1_STAGES: readonly WorkflowStage[] = ["deep-interview", "ralplan", "ultragoal"];

/** Reserved stage names that are explicitly not part of the v1 contract. */
export const RESERVED_WORKFLOW_STAGES: readonly string[] = ["team"];

export type WorkflowGateKind = "question" | "approval" | "execution";

/** "Other (type your own)" sentinel, mirroring the interactive ask tool. */
export const GATE_OTHER_OPTION = "Other (type your own)";

export interface AskGateDeepInterviewState {
	round_id?: string;
	round: number;
	component: string;
	dimension: string;
	ambiguity: number;
}

export interface AskGateStageStateInput {
	id: string;
	multi?: boolean;
	allowEmpty?: boolean;
	navigationLabel?: "Next" | "Done";
	deepInterview?: AskGateDeepInterviewState;
	fallbackState?: Record<string, unknown>;
}

export interface AskGateSchemaInput {
	multi?: boolean;
	allowEmpty?: boolean;
}

function isBoundedAskGateString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 256;
}

/** Rejects stage state that is not exactly compatible with the generic ask-gate producer. */
export function validateAskGateStageState(value: unknown): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("ask gate stage_state must be an object");
	const state = value as Record<string, unknown>;
	const allowed = new Set([
		"question_id",
		"multi",
		"allow_empty",
		"options",
		"other_option",
		"clarification_action",
		"navigation_label",
		"deep_interview_metadata",
		"round",
		"round_id",
		"component",
		"dimension",
		"mode",
		"challenge_mode",
		"ambiguity",
		"topology_gate",
	]);
	if (Object.keys(state).some(key => !allowed.has(key))) throw new Error("ask gate stage_state has an unknown field");
	if (
		!isBoundedAskGateString(state.question_id) ||
		typeof state.multi !== "boolean" ||
		typeof state.allow_empty !== "boolean" ||
		!Array.isArray(state.options) ||
		state.options.some(option => !isBoundedAskGateString(option)) ||
		state.other_option !== GATE_OTHER_OPTION ||
		state.clarification_action !== "clarify"
	)
		throw new Error("ask gate stage_state has invalid required fields");
	if (state.navigation_label !== undefined && state.navigation_label !== "Next" && state.navigation_label !== "Done")
		throw new Error("ask gate stage_state has an invalid navigation label");
	for (const key of ["round_id", "component", "dimension", "mode", "challenge_mode"])
		if (state[key] !== undefined && !isBoundedAskGateString(state[key]))
			throw new Error(`ask gate stage_state has an invalid ${key}`);
	if (state.deep_interview_metadata !== undefined && typeof state.deep_interview_metadata !== "boolean")
		throw new Error("ask gate stage_state has invalid deep interview metadata");
	if (state.round !== undefined && (!Number.isSafeInteger(state.round) || (state.round as number) < 0))
		throw new Error("ask gate stage_state has an invalid round");
	if (
		state.ambiguity !== undefined &&
		(typeof state.ambiguity !== "number" ||
			!Number.isFinite(state.ambiguity) ||
			state.ambiguity < 0 ||
			state.ambiguity > 1)
	)
		throw new Error("ask gate stage_state has an invalid ambiguity");
	if (state.topology_gate !== undefined && typeof state.topology_gate !== "boolean")
		throw new Error("ask gate stage_state has an invalid topology flag");
}

/** Builds the canonical generic ask answer schema. */
export function buildAskGateAnswerSchema(question: AskGateSchemaInput, labels: string[]): JsonSchema {
	const multi = question.multi ?? false;
	const selectedItems: JsonSchema = { type: "string", enum: labels };
	const selectedBase: JsonSchema = { type: "array", items: selectedItems, uniqueItems: true };
	const selectedOnly: JsonSchema = {
		...selectedBase,
		minItems: question.allowEmpty ? 0 : 1,
		...(multi ? {} : { maxItems: 1 }),
	};
	const selectedWithOther: JsonSchema = { ...selectedBase, ...(multi ? {} : { maxItems: 0 }) };
	return {
		type: "object",
		properties: {
			selected: selectedBase,
			other: { type: "boolean", description: "set true to provide a free-text answer in `custom`" },
			custom: {
				type: "string",
				minLength: 1,
				pattern: "\\S",
				description: "free-text answer; required when `other` is true",
			},
			action: {
				type: "string",
				enum: ["answer", "clarify"],
				description: "set to `clarify` to ask about the choices without answering the round",
			},
			question: {
				type: "string",
				minLength: 1,
				pattern: "\\S",
				description: "clarification question; required when action is `clarify`",
			},
		},
		additionalProperties: false,
		anyOf: [
			{
				type: "object",
				properties: { selected: selectedOnly, other: { const: false }, action: { const: "answer" } },
				required: ["selected"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					selected: selectedWithOther,
					other: { const: true },
					custom: { type: "string", minLength: 1, pattern: "\\S" },
					action: { const: "answer" },
				},
				required: ["selected", "other", "custom"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: { action: { const: "clarify" }, question: { type: "string", minLength: 1, pattern: "\\S" } },
				required: ["action", "question"],
				additionalProperties: false,
			},
		],
	};
}

/** Builds and validates exact generic ask stage-state metadata. */
export function buildAskGateStageState(input: AskGateStageStateInput, labels: string[]): Record<string, unknown> {
	const state: Record<string, unknown> = {
		question_id: input.id,
		multi: input.multi ?? false,
		options: labels,
		other_option: GATE_OTHER_OPTION,
		clarification_action: "clarify",
		allow_empty: input.allowEmpty === true,
		...(input.navigationLabel === undefined ? {} : { navigation_label: input.navigationLabel }),
		...(input.deepInterview
			? {
					deep_interview_metadata: true,
					round: input.deepInterview.round,
					component: input.deepInterview.component,
					dimension: input.deepInterview.dimension,
					ambiguity: input.deepInterview.ambiguity,
					...(input.deepInterview.round_id === undefined ? {} : { round_id: input.deepInterview.round_id }),
				}
			: (input.fallbackState ?? {})),
	};
	validateAskGateStageState(state);
	return state;
}

/** The documented JSON Schema 2020-12 subset supported by the gate validator. */
export interface JsonSchema {
	type?: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	items?: JsonSchema;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
	minimum?: number;
	maximum?: number;
	title?: string;
	description?: string;
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
}

export interface WorkflowGateOption {
	value: unknown;
	label: string;
	description?: string;
}

export interface WorkflowGateContext {
	title?: string;
	plan?: string;
	source?: string;
	prompt?: string;
	summary?: string;
	stage_state?: Record<string, unknown>;
	artifact_refs?: Array<{ kind: string; path?: string; sha256?: string }>;
	language?: string;
}

/** Outbound event: a machine-addressable workflow gate awaiting an answer. */
export interface WorkflowGate {
	type: "workflow_gate";
	gate_id: string;
	stage: WorkflowStage;
	kind: WorkflowGateKind;
	schema: JsonSchema;
	schema_hash: string;
	options?: WorkflowGateOption[];
	context: WorkflowGateContext;
	created_at: string;
	required: true;
	/** Immutable runtime turn correlation captured before durable gate visibility. */
	runtime_turn_id?: string;
}

/** Non-actionable durable-gate state retained for restart diagnostics. */
export interface WorkflowGateLifecycle {
	state: "quarantined";
	reason:
		| "orphaned_after_process_restart"
		| "accepted_unadvanced_after_process_restart"
		| "continuation_owner_lost"
		| "opened_without_continuation"
		| "finalization_failed"
		| "advance_failed";
	quarantinedAt: string;
	supersededByGateId?: string;
}

/** A quarantined gate is diagnostic-only and must never be presented or answered. */
export interface WorkflowGateDiagnostic extends WorkflowGate {
	id: string;
	tag: "quarantined";
	lifecycle: WorkflowGateLifecycle;
}

/** Stable Q12 row preserving the root WorkflowGate shape. */
export type WorkflowGateQueryRecord =
	| (WorkflowGate & { id: string; tag: "pending"; lifecycle?: undefined })
	| WorkflowGateDiagnostic;

/** Inbound: the agent's answer to a workflow gate. */
export interface WorkflowGateResponse {
	gate_id: string;
	answer: unknown;
	idempotency_key?: string;
}

/** Outcome of resolving a gate, surfaced back to the answering client. */
export interface WorkflowGateResolution {
	gate_id: string;
	status: "accepted" | "rejected";
	answer_hash: string;
	resolved_at: string;
	error?: WorkflowGateValidationError;
}

/** Typed error shape for schema validation failures. */
export interface WorkflowGateValidationError {
	code: "invalid_workflow_gate_answer";
	gate_id: string;
	schema_hash: string;
	errors: Array<{ path: string; keyword: string; message: string; expected?: unknown }>;
}
