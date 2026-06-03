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

const COMPACT_ELIDE_KEYS = new Set([
	"rounds",
	"ontology_snapshots",
	"architect_findings",
	"new_requirements",
	"ci_gates",
	"research_findings",
]);

export const STATE_FIELD_ALLOWLIST = [
	"skill",
	"phase",
	"current_phase",
	"next",
	"active",
	"status",
	"fresh",
	"fresh_until",
	"receipt",
	"artifact_path",
	"plan_path",
	"spec_path",
	"run_id",
	"stage",
	"stage_n",
	"session_id",
	"updated_at",
	"handoff_to",
	"handoff_from",
	"counts",
	"hud",
] as const;

export type StateProjectionField = (typeof STATE_FIELD_ALLOWLIST)[number];

export interface StateStatusSummary {
	skill: CanonicalGjcWorkflowSkill;
	phase: string;
	active: boolean;
	fresh: boolean;
	fresh_until?: string;
	next: string[];
	receipt_status: string;
	storage_path: string;
}

function compactStateFields(state: Record<string, unknown>): Array<[string, string]> {
	const fields: Array<[string, string]> = [];
	for (const key of COMPACT_ELIDE_KEYS) {
		const value = state[key];
		if (Array.isArray(value)) fields.push([key, `${value.length} entries (elided)`]);
	}
	return fields;
}

export function compactProjectStateJson(
	skill: CanonicalGjcWorkflowSkill,
	stateJson: Record<string, unknown>,
	manifest: SkillManifest,
): Record<string, unknown> {
	const state = stateObject(stateJson);
	const compact = projectStateFields(skill, stateJson, manifest, STATE_FIELD_ALLOWLIST);
	const elisions: Record<string, unknown> = {};
	for (const key of COMPACT_ELIDE_KEYS) {
		const value = state[key];
		if (Array.isArray(value)) elisions[key] = { type: "array", count: value.length, pointer: `/${key}` };
	}
	if (Object.keys(elisions).length) compact.elided = elisions;
	return compact;
}

export function projectStateFields(
	skill: CanonicalGjcWorkflowSkill,
	stateJson: Record<string, unknown>,
	manifest: SkillManifest,
	fields: readonly StateProjectionField[],
): Record<string, unknown> {
	const state = stateObject(stateJson);
	const phase = scalar(state.current_phase) ?? scalar(state.phase) ?? manifest.initialState;
	const receipt = receiptObject(state);
	const freshUntil = receipt ? scalar(receipt.fresh_until) : undefined;
	const projected: Record<string, unknown> = {};
	for (const field of fields) {
		switch (field) {
			case "skill":
				projected.skill = skill;
				break;
			case "phase":
			case "current_phase":
				projected[field] = phase;
				break;
			case "next":
				projected.next = manifest.transitions
					.filter(transition => transition.from === phase)
					.map(transition => transition.to);
				break;
			case "fresh":
				projected.fresh = freshUntil ? Date.parse(freshUntil) > Date.now() : false;
				break;
			case "fresh_until":
				projected.fresh_until = freshUntil;
				break;
			case "receipt":
				projected.receipt = receipt;
				break;
			default:
				projected[field] = state[field];
		}
	}
	return projected;
}

export function buildStateStatusSummary(
	skill: CanonicalGjcWorkflowSkill,
	stateJson: Record<string, unknown>,
	manifest: SkillManifest,
	storagePath: string,
): StateStatusSummary {
	const state = stateObject(stateJson);
	const phase = scalar(state.current_phase) ?? scalar(state.phase) ?? manifest.initialState;
	const receipt = receiptObject(state);
	const freshUntil = receipt ? scalar(receipt.fresh_until) : undefined;
	return {
		skill,
		phase,
		active: state.active !== false,
		fresh: freshUntil ? Date.parse(freshUntil) > Date.now() : false,
		...(freshUntil ? { fresh_until: freshUntil } : {}),
		next: manifest.transitions.filter(transition => transition.from === phase).map(transition => transition.to),
		receipt_status: receipt ? (scalar(receipt.status) ?? "present") : "missing",
		storage_path: storagePath,
	};
}

export function renderStateStatusLine(summary: StateStatusSummary): string {
	const freshness = summary.fresh ? "fresh" : "stale";
	return `${summary.skill}: phase=${summary.phase} ${freshness} next=${summary.next.length ? summary.next.join(",") : "none"}\n`;
}

export function renderContractMarkdown(skill: CanonicalGjcWorkflowSkill, contract: unknown): string {
	const record = isRecord(contract) ? contract : {};
	const lines = [`# ${skill} state contract`, ""];
	for (const [key, value] of Object.entries(record)) {
		if (Array.isArray(value)) lines.push(`- ${key}: ${value.length} entries (--json for full)`);
		else if (isRecord(value)) lines.push(`- ${key}: object (${Object.keys(value).length} keys, --json for full)`);
		else if (value !== undefined) lines.push(`- ${key}: ${String(value)}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderHistoryMarkdown(history: {
	entries: unknown[];
	limit: number;
	since?: string;
	truncated: boolean;
}): string {
	const lines = ["# state audit history", "", `- entries: ${history.entries.length}`, `- limit: ${history.limit}`];
	if (history.since) lines.push(`- since: ${history.since}`);
	lines.push(`- truncated: ${history.truncated ? "yes" : "no"}`);
	for (const entry of history.entries) {
		if (!isRecord(entry)) continue;
		const ts = scalar(entry.ts) ?? "unknown-time";
		const skill = scalar(entry.skill) ?? "unknown-skill";
		const verb = scalar(entry.verb) ?? "unknown-verb";
		lines.push(`- ${ts} ${skill} ${verb}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderUltragoalStatusMarkdown(summary: {
	exists: boolean;
	status: string;
	paths: { goalsPath: string; ledgerPath?: string };
	gjcObjective?: string;
	currentGoal?: { id: string; status: string; title?: string; objective?: string };
	counts: Record<string, number>;
	goals: unknown[];
}): string {
	if (!summary.exists)
		return `# ultragoal status\n\n- status: missing\n- No ultragoal plan found at ${summary.paths.goalsPath}. Run \`gjc ultragoal create-goals --brief "..."\` first.\n`;
	const counts = Object.entries(summary.counts)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
	const lines = [
		"# ultragoal status",
		"",
		`- status: ${summary.status}`,
		`- goals: ${summary.goals.length} (${counts})`,
	];
	if (summary.gjcObjective) lines.push(`- objective: ${summary.gjcObjective}`);
	if (summary.currentGoal) lines.push(`- current: ${summary.currentGoal.id} (${summary.currentGoal.status})`);
	lines.push(`- goals_path: ${summary.paths.goalsPath}`);
	if (summary.paths.ledgerPath) lines.push(`- ledger_path: ${summary.paths.ledgerPath}`);
	return `${lines.join("\n")}\n`;
}

export function renderTeamStatusMarkdown(snapshot: {
	team_name: string;
	phase: string;
	tmux_target?: string;
	tmux_session?: string;
	state_dir: string;
	task_total: number;
	task_counts: Record<string, number>;
	workers: Array<{ id: string; status: string }>;
	notification_summary?: { total: number; replay_eligible: number; by_state: Record<string, number> };
	integration_by_worker?: Record<string, { status?: string; conflict_files?: string[] }>;
}): string {
	const counts = Object.entries(snapshot.task_counts)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
	const lines = [
		"# team status",
		"",
		`- team: ${snapshot.team_name}`,
		`- phase: ${snapshot.phase}`,
		`- tmux: ${snapshot.tmux_target || snapshot.tmux_session || "none"}`,
		`- state: ${snapshot.state_dir}`,
		`- tasks: ${snapshot.task_total} (${counts})`,
		`- workers: ${snapshot.workers.length} (${snapshot.workers.map(worker => `${worker.id}:${worker.status}`).join(" ")})`,
	];
	if (snapshot.notification_summary) {
		lines.push(
			`- notifications: total=${snapshot.notification_summary.total} replay_eligible=${snapshot.notification_summary.replay_eligible}`,
		);
	}
	const integrations = Object.entries(snapshot.integration_by_worker ?? {});
	if (integrations.length)
		lines.push(
			`- integrations: ${integrations.map(([worker, state]) => `${worker}:${state.status ?? "unknown"}`).join(" ")}`,
		);
	return `${lines.join("\n")}\n`;
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
	const compactFields = compactStateFields(state);
	if (compactFields.length) {
		lines.push("- Compact elisions:");
		for (const [key, value] of compactFields) lines.push(`  - ${key}: ${value}`);
	}
	return `${lines.join("\n")}\n`;
}
