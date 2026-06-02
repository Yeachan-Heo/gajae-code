import type { CanonicalGjcWorkflowSkill } from "../skill-state/active-state";
import type { SkillManifest } from "./workflow-manifest";

function scalar(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stateObject(stateJson: Record<string, unknown>): Record<string, unknown> {
	const nested = stateJson.state;
	return isRecord(nested) ? nested : stateJson;
}

function receiptObject(state: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(state.receipt) ? state.receipt : undefined;
}

function artifactLinks(state: Record<string, unknown>): string[] {
	const links = new Set<string>();
	for (const key of [
		"artifact",
		"artifact_path",
		"artifact_url",
		"plan_path",
		"spec_path",
		"ledger_path",
		"storage_path",
		"state_path",
	]) {
		const value = scalar(state[key]);
		if (value) links.add(value);
	}
	const artifacts = state.artifacts;
	if (Array.isArray(artifacts)) {
		for (const artifact of artifacts) {
			const value = scalar(artifact);
			if (value) links.add(value);
			if (isRecord(artifact)) {
				for (const key of ["path", "url", "href"]) {
					const nested = scalar(artifact[key]);
					if (nested) links.add(nested);
				}
			}
		}
	}
	return [...links];
}

function keyStateFields(state: Record<string, unknown>, manifest: SkillManifest): Array<[string, string]> {
	const keys = new Set<string>([
		"active",
		"current_phase",
		"phase",
		"status",
		"updated_at",
		"session_id",
		...manifest.hudFields,
	]);
	const fields: Array<[string, string]> = [];
	for (const key of keys) {
		const value = scalar(state[key]);
		if (value !== undefined) fields.push([key, value]);
		if (fields.length >= 10) break;
	}
	return fields;
}

export function renderStateMarkdown(
	skill: CanonicalGjcWorkflowSkill,
	stateJson: Record<string, unknown>,
	manifest: SkillManifest,
): string {
	const state = stateObject(stateJson);
	const phase = scalar(state.current_phase) ?? scalar(state.phase) ?? manifest.initialState;
	const next = manifest.transitions.filter(transition => transition.from === phase).map(transition => transition.to);
	const receipt = receiptObject(state);
	const receiptStatus = receipt ? (scalar(receipt.status) ?? "present") : "missing";
	const artifacts = artifactLinks(state);
	const fields = keyStateFields(state, manifest);

	const lines = [`# ${skill} state`, "", `- Current phase: ${phase}`];
	lines.push(`- Valid next transitions: ${next.length ? next.join(", ") : "none"}`);
	if (fields.length) {
		lines.push("- Key fields:");
		for (const [key, value] of fields) lines.push(`  - ${key}: ${value}`);
	} else {
		lines.push("- Key fields: none");
	}
	lines.push(`- Receipt: ${receiptStatus}`);
	if (receipt) {
		const mutationId = scalar(receipt.mutation_id);
		const freshUntil = scalar(receipt.fresh_until);
		if (mutationId) lines.push(`  - mutation_id: ${mutationId}`);
		if (freshUntil) lines.push(`  - fresh_until: ${freshUntil}`);
	}
	if (artifacts.length) {
		lines.push("- Artifacts:");
		for (const artifact of artifacts) lines.push(`  - ${artifact}`);
	}
	return `${lines.join("\n")}\n`;
}
