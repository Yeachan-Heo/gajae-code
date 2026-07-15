/** Transport-neutral workflow gate contract used by SDK workflow coordination. */

/** Lifecycle stages that emit machine-addressable SDK workflow gates. */
export type WorkflowStage = "deep-interview" | "ralplan" | "ultragoal";

/** Reserved stage names that are explicitly not part of the v1 contract. */
export const RESERVED_WORKFLOW_STAGES: readonly string[] = ["team"];

export type WorkflowGateKind = "question" | "approval" | "execution";

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
