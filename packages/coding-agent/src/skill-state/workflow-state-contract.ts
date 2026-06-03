import * as path from "node:path";
import { CANONICAL_GJC_WORKFLOW_SKILLS, type CanonicalGjcWorkflowSkill, SKILL_ACTIVE_STATE_FILE } from "./active-state";

export type { CanonicalGjcWorkflowSkill };

export const WORKFLOW_STATE_RECEIPT_VERSION = 1;
export const WORKFLOW_STATE_RECEIPT_FRESH_MS = 30 * 60 * 1000;

export type WorkflowStateMutationOwner = "gjc-state-cli" | "gjc-runtime" | "gjc-hook";
export type WorkflowStateReceiptStatus = "fresh" | "stale";

export interface WorkflowStateContentChecksum {
	algorithm: "sha256";
	value: string;
	covered_path: string;
	computed_at: string;
}

export interface WorkflowStateReceipt {
	version: 1;
	skill: CanonicalGjcWorkflowSkill;
	owner: WorkflowStateMutationOwner;
	command: string;
	state_path: string;
	storage_path: string;
	mutated_at: string;
	fresh_until: string;
	status: WorkflowStateReceiptStatus;
	mutation_id: string;
	verb?: string;
	from_phase?: string;
	to_phase?: string;
	forced?: boolean;
	paths?: string[];
	content_sha256?: WorkflowStateContentChecksum;
}

export interface AuditEntry {
	ts: string;
	skill?: string;
	category: string;
	verb: string;
	owner: WorkflowStateMutationOwner;
	mutation_id: string;
	from_phase?: string;
	to_phase?: string;
	forced: boolean;
	paths: string[];
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

export function workflowModeStateFileName(skill: CanonicalGjcWorkflowSkill): string {
	return `${skill}-state.json`;
}

export function workflowStateStoragePath(cwd: string, skill: CanonicalGjcWorkflowSkill, sessionId?: string): string {
	const normalizedSessionId = safeString(sessionId).trim();
	if (normalizedSessionId) {
		return path.join(
			cwd,
			".gjc",
			"state",
			"sessions",
			encodePathSegment(normalizedSessionId),
			workflowModeStateFileName(skill),
		);
	}
	return path.join(cwd, ".gjc", "state", workflowModeStateFileName(skill));
}

export function workflowActiveStatePath(cwd: string, sessionId?: string): string {
	const normalizedSessionId = safeString(sessionId).trim();
	if (normalizedSessionId) {
		return path.join(
			cwd,
			".gjc",
			"state",
			"sessions",
			encodePathSegment(normalizedSessionId),
			SKILL_ACTIVE_STATE_FILE,
		);
	}
	return path.join(cwd, ".gjc", "state", SKILL_ACTIVE_STATE_FILE);
}

export function buildWorkflowStateReceipt(input: {
	cwd: string;
	skill: CanonicalGjcWorkflowSkill;
	owner: WorkflowStateMutationOwner;
	command: string;
	sessionId?: string;
	nowIso?: string;
	mutationId?: string;
}): WorkflowStateReceipt {
	const mutatedAt = input.nowIso ?? new Date().toISOString();
	const freshUntil = new Date(Date.parse(mutatedAt) + WORKFLOW_STATE_RECEIPT_FRESH_MS).toISOString();
	return {
		version: WORKFLOW_STATE_RECEIPT_VERSION,
		skill: input.skill,
		owner: input.owner,
		command: input.command,
		state_path: workflowActiveStatePath(input.cwd, input.sessionId),
		storage_path: workflowStateStoragePath(input.cwd, input.skill, input.sessionId),
		mutated_at: mutatedAt,
		fresh_until: freshUntil,
		status: "fresh",
		mutation_id: input.mutationId ?? `${input.skill}:${mutatedAt}`,
	};
}

export function workflowReceiptStatus(
	receipt: WorkflowStateReceipt | undefined,
	nowMs = Date.now(),
): WorkflowStateReceiptStatus | undefined {
	if (!receipt) return undefined;
	const freshUntilMs = Date.parse(receipt.fresh_until);
	if (!Number.isFinite(freshUntilMs)) return "stale";
	return nowMs <= freshUntilMs ? "fresh" : "stale";
}

export function canonicalWorkflowSkill(value: string): CanonicalGjcWorkflowSkill | null {
	return (CANONICAL_GJC_WORKFLOW_SKILLS as readonly string[]).includes(value)
		? (value as CanonicalGjcWorkflowSkill)
		: null;
}

export function sanctionedWorkflowStateCommand(skill: CanonicalGjcWorkflowSkill): string {
	return `gjc state ${skill} write --input '<json>'`;
}

export function describeWorkflowStateContract(skill: CanonicalGjcWorkflowSkill): string[] {
	return [
		`Sanctioned mutation path: gjc state ${skill} read|write --input '<json>'`,
		`Canonical active HUD state: .gjc/state/${SKILL_ACTIVE_STATE_FILE} and .gjc/state/sessions/<session>/${SKILL_ACTIVE_STATE_FILE}`,
		`Skill mode state: .gjc/state/${workflowModeStateFileName(skill)} or .gjc/state/sessions/<session>/${workflowModeStateFileName(skill)}`,
		"Receipts include version, skill, owner, command, state_path, storage_path, mutated_at, fresh_until, status, and mutation_id.",
		"Receipts are fresh for 30 minutes; older receipts are stale and render as HUD warnings.",
		"Planning artifacts under .gjc/specs/** and .gjc/plans/** remain writable outside the state command.",
	];
}
