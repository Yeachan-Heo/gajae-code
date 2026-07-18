import * as path from "node:path";
import { activeSnapshotPath, assertNonEmptyGjcSessionId, modeStatePath } from "../gjc-runtime/session-layout";
import { CANONICAL_GJC_WORKFLOW_SKILLS, type CanonicalGjcWorkflowSkill, SKILL_ACTIVE_STATE_FILE } from "./active-state";
import { WORKFLOW_STATE_RECEIPT_FRESH_MS, WORKFLOW_STATE_RECEIPT_VERSION } from "./workflow-state-version";

export {
	WORKFLOW_STATE_RECEIPT_FRESH_MS,
	WORKFLOW_STATE_RECEIPT_VERSION,
	WORKFLOW_STATE_VERSION,
} from "./workflow-state-version";

export type { CanonicalGjcWorkflowSkill };
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

export function workflowModeStateFileName(skill: CanonicalGjcWorkflowSkill): string {
	return `${skill}-state.json`;
}

export function buildWorkflowStateReceipt(input: {
	cwd: string;
	skill: CanonicalGjcWorkflowSkill;
	owner: WorkflowStateMutationOwner;
	command: string;
	sessionId: string;
	nowIso?: string;
	mutationId?: string;
}): WorkflowStateReceipt {
	assertNonEmptyGjcSessionId(input.sessionId, "buildWorkflowStateReceipt");
	const cwd = path.resolve(input.cwd);
	const mutatedAt = input.nowIso ?? new Date().toISOString();
	const freshUntil = new Date(Date.parse(mutatedAt) + WORKFLOW_STATE_RECEIPT_FRESH_MS).toISOString();
	return {
		version: WORKFLOW_STATE_RECEIPT_VERSION,
		skill: input.skill,
		owner: input.owner,
		command: input.command,
		state_path: activeSnapshotPath(cwd, input.sessionId),
		storage_path: modeStatePath(cwd, input.sessionId, input.skill),
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
		`Canonical active HUD state: .gjc/_session-{sessionid}/state/${SKILL_ACTIVE_STATE_FILE}`,
		`Skill mode state: .gjc/_session-{sessionid}/state/${workflowModeStateFileName(skill)}`,
		"Receipts include version, skill, owner, command, state_path, storage_path, mutated_at, fresh_until, status, and mutation_id.",
		"Receipts are fresh for 30 minutes; older receipts are stale and render as HUD warnings.",
		"Planning artifacts under .gjc/_session-{sessionid}/specs/** and .gjc/_session-{sessionid}/plans/** remain writable outside the state command.",
	];
}
