/**
 * Ralplan approval + ultragoal execution gate mapping (#317).
 *
 * Maps the two human-gated lifecycle decisions onto `workflow_gate` events:
 *  - ralplan `pending approval` -> `workflow_gate` { kind: "approval" } whose
 *    answer is one of approve / request-changes / reject (+ optional comments);
 *  - ultragoal execution sign-off -> `workflow_gate` { kind: "execution" } whose
 *    answer is approve / decline (+ optional reason).
 *
 * Gates remain mandatory; the remote SDK client answers at the gate boundary.
 * Declining / requesting changes is honored and is NEVER silently treated as approval.
 *
 * This is the pure mapping primitive used by SDK-native workflow gate emitters.
 */

import type { OpenGateInput } from "./workflow-gate-broker";
import type { JsonSchema, WorkflowGateContext } from "./workflow-gate-types";

export type ApprovalDecision = "approve" | "request-changes" | "reject";
export type ExecutionDecision = "approve" | "decline";

export interface ApprovalGateAnswer {
	decision: ApprovalDecision;
	comments?: string;
}

export interface ExecutionGateAnswer {
	decision: ExecutionDecision;
	reason?: string;
}

export interface ApprovalGateResult {
	approved: boolean;
	decision: ApprovalDecision;
	comments?: string;
}

export interface ExecutionGateResult {
	approved: boolean;
	decision: ExecutionDecision;
	reason?: string;
}

export class ApprovalGateError extends Error {
	constructor(
		readonly code: "invalid_answer_shape" | "unknown_decision" | "missing_comments",
		message: string,
	) {
		super(message);
		this.name = "ApprovalGateError";
	}
}

const APPROVAL_DECISIONS: ApprovalDecision[] = ["approve", "request-changes", "reject"];
const EXECUTION_DECISIONS: ExecutionDecision[] = ["approve", "decline"];

/** Build the ralplan `pending approval` -> `workflow_gate { kind: "approval" }` open-input. */
export function approvalGate(context: WorkflowGateContext = {}): OpenGateInput {
	const schema: JsonSchema = {
		type: "object",
		properties: {
			decision: { type: "string", enum: APPROVAL_DECISIONS },
			comments: { type: "string", description: "required when requesting changes" },
		},
		required: ["decision"],
		additionalProperties: false,
	};
	return {
		stage: "ralplan",
		kind: "approval",
		schema,
		options: APPROVAL_DECISIONS.map(d => ({ value: d, label: d })),
		context: { title: context.title ?? "Approve the plan?", ...context },
	};
}

/** Build the ultragoal execution sign-off -> `workflow_gate { kind: "execution" }` open-input. */
export function executionGate(context: WorkflowGateContext = {}): OpenGateInput {
	const schema: JsonSchema = {
		type: "object",
		properties: {
			decision: { type: "string", enum: EXECUTION_DECISIONS },
			reason: { type: "string", description: "optional rationale; required when declining" },
		},
		required: ["decision"],
		additionalProperties: false,
	};
	return {
		stage: "ultragoal",
		kind: "execution",
		schema,
		options: EXECUTION_DECISIONS.map(d => ({ value: d, label: d })),
		context: { title: context.title ?? "Approve execution?", ...context },
	};
}

function decisionField(answer: unknown): string {
	if (typeof answer !== "object" || answer === null) {
		throw new ApprovalGateError("invalid_answer_shape", "answer must be an object with a `decision` field");
	}
	const decision = (answer as { decision?: unknown }).decision;
	if (typeof decision !== "string") {
		throw new ApprovalGateError("invalid_answer_shape", "answer.decision must be a string");
	}
	return decision;
}

/**
 * Decode a ralplan approval answer. `request-changes` requires comments and is
 * NEVER treated as approval; only an explicit `approve` advances.
 */
export function decodeApproval(answer: unknown): ApprovalGateResult {
	const decision = decisionField(answer);
	if (!APPROVAL_DECISIONS.includes(decision as ApprovalDecision)) {
		throw new ApprovalGateError("unknown_decision", `unknown approval decision: ${decision}`);
	}
	const comments = (answer as { comments?: unknown }).comments;
	if (comments !== undefined && typeof comments !== "string") {
		throw new ApprovalGateError("invalid_answer_shape", "answer.comments must be a string");
	}
	if (decision === "request-changes" && (comments === undefined || comments.trim() === "")) {
		throw new ApprovalGateError("missing_comments", "comments are required when requesting changes");
	}
	return {
		approved: decision === "approve",
		decision: decision as ApprovalDecision,
		comments: comments as string | undefined,
	};
}

/**
 * Decode an ultragoal execution answer. Only an explicit `approve` advances;
 * `decline` is honored and never silently approved.
 */
export function decodeExecution(answer: unknown): ExecutionGateResult {
	const decision = decisionField(answer);
	if (!EXECUTION_DECISIONS.includes(decision as ExecutionDecision)) {
		throw new ApprovalGateError("unknown_decision", `unknown execution decision: ${decision}`);
	}
	const reason = (answer as { reason?: unknown }).reason;
	if (reason !== undefined && typeof reason !== "string") {
		throw new ApprovalGateError("invalid_answer_shape", "answer.reason must be a string");
	}
	return {
		approved: decision === "approve",
		decision: decision as ExecutionDecision,
		reason: reason as string | undefined,
	};
}
