import type { CanonicalGjcWorkflowSkill } from "../skill-state/active-state";

export interface StateValidationResult {
	valid: boolean;
	error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeName(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

export function validateWorkflowStateEnvelope(skill: CanonicalGjcWorkflowSkill, state: unknown): StateValidationResult {
	if (!isPlainObject(state)) {
		return { valid: false, error: `state for ${skill} must be a JSON object, got ${typeName(state)}` };
	}

	if ("skill" in state && state.skill !== skill) {
		return { valid: false, error: `state skill must match selected mode ${skill}` };
	}
	if ("active" in state && typeof state.active !== "boolean") {
		return { valid: false, error: `state.active must be a boolean when present, got ${typeName(state.active)}` };
	}
	if ("current_phase" in state && typeof state.current_phase !== "string") {
		return {
			valid: false,
			error: `state.current_phase must be a string when present, got ${typeName(state.current_phase)}`,
		};
	}
	if ("version" in state && typeof state.version !== "number") {
		return { valid: false, error: `state.version must be a number when present, got ${typeName(state.version)}` };
	}
	if ("updated_at" in state && typeof state.updated_at !== "string") {
		return {
			valid: false,
			error: `state.updated_at must be a string when present, got ${typeName(state.updated_at)}`,
		};
	}
	if ("receipt" in state && state.receipt !== undefined && !isPlainObject(state.receipt)) {
		return { valid: false, error: `state.receipt must be an object when present, got ${typeName(state.receipt)}` };
	}

	return { valid: true };
}
