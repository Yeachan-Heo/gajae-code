/**
 * TypeScript is the authoritative source of truth for GJC workflow manifests.
 * Any JSON manifest projection is derived from this module and must never be
 * hand-edited.
 */

import { CANONICAL_GJC_WORKFLOW_SKILLS, type CanonicalGjcWorkflowSkill } from "../skill-state/canonical-skills";
import { initialPhaseForSkill } from "../skill-state/initial-phase";

export interface WorkflowState {
	id: string;
	initial?: boolean;
	terminal?: boolean;
}

export interface WorkflowTransition {
	from: string;
	to: string;
	verb: string;
}

export interface WorkflowVerb {
	name: string;
	planned?: boolean;
	/** Invocation surface that exposes this verb in the real CLI parser. */
	surface?: "state-action" | "command-positional" | "command-flag";
}

export interface TypedArgSpec {
	name: string;
	type: "string" | "number" | "boolean" | "enum" | "object";
	enumValues?: string[];
	required?: boolean;
	appliesToVerbs?: string[];
	planned?: boolean;
}

export interface RetentionPolicy {
	category: string;
	keep?: number;
	maxAgeDays?: number;
}

export interface SkillManifest {
	skill: CanonicalGjcWorkflowSkill;
	states: WorkflowState[];
	initialState: string;
	terminalStates: string[];
	transitions: WorkflowTransition[];
	verbs: WorkflowVerb[];
	typedArgs: TypedArgSpec[];
	retention: RetentionPolicy[];
	hudFields: string[];
	graphLabel: string;
	stopReleasingPhases: readonly string[];
	phaseLock: readonly string[];
	canonicalOverrides: readonly string[];
}

const STATE_RETENTION: RetentionPolicy = { category: "state", keep: 1 };
const ARTIFACT_RETENTION: RetentionPolicy = { category: "artifact" };
const LEDGER_RETENTION: RetentionPolicy = { category: "ledger" };
const LOG_RETENTION: RetentionPolicy = { category: "log", maxAgeDays: 30 };
const REPORT_RETENTION: RetentionPolicy = { category: "report", maxAgeDays: 30 };
const PRUNE_RETENTION: RetentionPolicy = { category: "prune/delete", maxAgeDays: 30 };
const FORCE_RETENTION: RetentionPolicy = { category: "force", maxAgeDays: 90 };

const STATE_VERBS = ["read", "write", "clear", "contract", "handoff", "doctor"] as const;
const PLANNED_ADMIN_VERBS = ["graph", "prune", "migrate", "force-overwrite"] as const;

const COMMON_TYPED_ARGS: TypedArgSpec[] = [
	{ name: "input", type: "string", appliesToVerbs: ["write", "api"] },
	{ name: "mode", type: "enum", enumValues: [...CANONICAL_GJC_WORKFLOW_SKILLS], appliesToVerbs: [...STATE_VERBS] },
	{
		name: "session-id",
		type: "string",
		appliesToVerbs: [
			...STATE_VERBS,
			"kickoff",
			"write-spec",
			"write-artifact",
			"stage",
			"check",
			"apply",
			"discard",
			"read",
			"write",
		],
	},
	{ name: "thread-id", type: "string", appliesToVerbs: ["write", "clear", "handoff"] },
	{ name: "turn-id", type: "string", appliesToVerbs: ["write", "clear", "handoff"] },
	{ name: "to", type: "string", required: true, appliesToVerbs: ["handoff"] },
	{ name: "replace", type: "boolean", appliesToVerbs: ["write"] },
	{ name: "force", type: "boolean", appliesToVerbs: ["write", "clear", "handoff"] },
	{ name: "skill", type: "enum", enumValues: [...CANONICAL_GJC_WORKFLOW_SKILLS], appliesToVerbs: ["doctor"] },
	{ name: "json", type: "boolean", appliesToVerbs: ["doctor"] },
];

function verb(name: string, surface: WorkflowVerb["surface"]): WorkflowVerb {
	return { name, surface };
}

function stateVerbs(): WorkflowVerb[] {
	return STATE_VERBS.map(name => verb(name, "state-action"));
}

function positionalVerbs(names: readonly string[]): WorkflowVerb[] {
	return names.map(name => verb(name, "command-positional"));
}

function flagVerbs(names: readonly string[]): WorkflowVerb[] {
	return names.map(name => verb(name, "command-flag"));
}

function plannedVerbs(names: readonly string[]): WorkflowVerb[] {
	return names.map(name => ({ ...verb(name, "state-action"), planned: true }));
}

function state(id: string, initialState: string, terminalStates: readonly string[]): WorkflowState {
	const entry: WorkflowState = { id };
	if (id === initialState) entry.initial = true;
	if (terminalStates.includes(id)) entry.terminal = true;
	return entry;
}

function manifest(input: {
	skill: CanonicalGjcWorkflowSkill;
	states: string[];
	terminalStates: string[];
	transitions: WorkflowTransition[];
	verbs: WorkflowVerb[];
	typedArgs?: TypedArgSpec[];
	retention: RetentionPolicy[];
	hudFields: string[];
	graphLabel: string;
	stopReleasingPhases?: readonly string[];
	phaseLock?: readonly string[];
	canonicalOverrides?: readonly string[];
	initialState?: string;
}): SkillManifest {
	const staleInitialState = initialPhaseForSkill(input.skill);
	const initialState = input.initialState ?? staleInitialState;
	return {
		skill: input.skill,
		states: input.states.map(item => state(item, initialState, input.terminalStates)),
		initialState,
		terminalStates: input.terminalStates,
		transitions: input.transitions,
		verbs: input.verbs,
		typedArgs: [...COMMON_TYPED_ARGS, ...(input.typedArgs ?? [])],
		retention: input.retention,
		hudFields: input.hudFields,
		graphLabel: input.graphLabel,
		stopReleasingPhases: input.stopReleasingPhases ?? [
			"complete",
			"completed",
			"failed",
			"cancelled",
			"canceled",
			"inactive",
		],
		phaseLock: input.phaseLock ?? [],
		canonicalOverrides: input.canonicalOverrides ?? [],
	};
}

export const WORKFLOW_MANIFEST: Record<CanonicalGjcWorkflowSkill, SkillManifest> = {
	"deep-interview": manifest({
		skill: "deep-interview",
		states: ["interviewing", "handoff", "complete"],
		terminalStates: ["handoff", "complete"],
		transitions: [
			{ from: "interviewing", to: "handoff", verb: "write-spec" },
			{ from: "handoff", to: "complete", verb: "clear" },
			{ from: "interviewing", to: "complete", verb: "clear" },
		],
		verbs: [
			...stateVerbs(),
			...flagVerbs(["kickoff", "write-spec"]),
			...positionalVerbs(["stage", "check", "apply", "discard", "read", "write", "clear", "handoff"]),
			...plannedVerbs(PLANNED_ADMIN_VERBS),
		],
		typedArgs: [
			{ name: "quick", type: "boolean", appliesToVerbs: ["kickoff"] },
			{ name: "standard", type: "boolean", appliesToVerbs: ["kickoff"] },
			{ name: "deep", type: "boolean", appliesToVerbs: ["kickoff"] },
			{ name: "threshold", type: "number", appliesToVerbs: ["kickoff"] },
			{ name: "threshold-source", type: "string", appliesToVerbs: ["kickoff"] },
			{ name: "stage", type: "enum", enumValues: ["final"], appliesToVerbs: ["write-spec"] },
			{ name: "slug", type: "string", appliesToVerbs: ["write-spec"] },
			{ name: "spec", type: "string", required: true, appliesToVerbs: ["write-spec"] },
			{ name: "handoff", type: "enum", enumValues: ["ralplan"], appliesToVerbs: ["write-spec"] },
			{ name: "deliberate", type: "boolean", appliesToVerbs: ["write-spec"] },
			{
				name: "json",
				type: "boolean",
				appliesToVerbs: ["write-spec", "stage", "check", "apply", "discard", "read", "write", "clear", "handoff"],
			},
			{ name: "input", type: "string", required: true, appliesToVerbs: ["stage", "write"] },
			{ name: "reset", type: "boolean", appliesToVerbs: ["write"] },
			{
				name: "for",
				type: "enum",
				enumValues: ["initialize-context", "record-round", "update-facts", "merge-state"],
				required: true,
				appliesToVerbs: ["stage"],
			},
			{ name: "args", type: "string", planned: true },
			{ name: "metadata-json", type: "string", planned: true },
		],
		retention: [STATE_RETENTION, ARTIFACT_RETENTION, PRUNE_RETENTION, FORCE_RETENTION],
		hudFields: ["current_phase", "ambiguity_score", "threshold", "spec_slug", "spec_path", "topology"],
		graphLabel: "Deep Interview",
	}),
	ralplan: manifest({
		skill: "ralplan",
		states: [
			"planner",
			"intent",
			"architect",
			"critic",
			"disposition",
			"revision",
			"post-interview",
			"adr",
			"final",
			"handoff",
		],
		terminalStates: ["final", "handoff"],
		transitions: [
			{ from: "planner", to: "intent", verb: "write-artifact" },
			// Legacy in-flight runs may have persisted planner before the intent stage existed.
			{ from: "planner", to: "architect", verb: "write-artifact" },
			{ from: "intent", to: "architect", verb: "write-artifact" },
			{ from: "intent", to: "revision", verb: "write-artifact" },
			{ from: "architect", to: "critic", verb: "write-artifact" },
			{ from: "critic", to: "disposition", verb: "write-artifact" },
			{ from: "architect", to: "disposition", verb: "write-artifact" },
			{ from: "disposition", to: "revision", verb: "write-artifact" },
			{ from: "critic", to: "revision", verb: "write-artifact" },
			{ from: "revision", to: "intent", verb: "write-artifact" },
			{ from: "revision", to: "post-interview", verb: "write-artifact" },
			{ from: "critic", to: "post-interview", verb: "write-artifact" },
			{ from: "disposition", to: "post-interview", verb: "write-artifact" },
			{ from: "post-interview", to: "revision", verb: "write-artifact" },
			{ from: "post-interview", to: "adr", verb: "write-artifact" },
			{ from: "revision", to: "adr", verb: "write-artifact" },
			{ from: "adr", to: "final", verb: "write-artifact" },
			{ from: "planner", to: "handoff", verb: "handoff" },
			{ from: "intent", to: "handoff", verb: "handoff" },
			{ from: "architect", to: "handoff", verb: "handoff" },
			{ from: "critic", to: "handoff", verb: "handoff" },
			{ from: "disposition", to: "handoff", verb: "handoff" },
			{ from: "revision", to: "handoff", verb: "handoff" },
			{ from: "adr", to: "handoff", verb: "handoff" },
			{ from: "post-interview", to: "handoff", verb: "handoff" },
		],
		verbs: [...stateVerbs(), ...flagVerbs(["kickoff", "write-artifact"]), ...plannedVerbs(PLANNED_ADMIN_VERBS)],
		typedArgs: [
			{ name: "interactive", type: "boolean", appliesToVerbs: ["kickoff"] },
			{ name: "deliberate", type: "boolean", appliesToVerbs: ["kickoff"] },
			{ name: "architect", type: "string", appliesToVerbs: ["kickoff"] },
			{ name: "critic", type: "string", appliesToVerbs: ["kickoff"] },
			{ name: "json", type: "boolean", appliesToVerbs: ["kickoff", "write-artifact"] },
			{
				name: "stage",
				type: "enum",
				enumValues: [
					"planner",
					"intent",
					"architect",
					"critic",
					"disposition",
					"revision",
					"post-interview",
					"adr",
					"final",
				],
				appliesToVerbs: ["write-artifact"],
			},
			{ name: "stage_n", type: "number", appliesToVerbs: ["write-artifact"] },
			{ name: "artifact", type: "string", required: true, appliesToVerbs: ["write-artifact"] },
			{ name: "run-id", type: "string", appliesToVerbs: ["write-artifact"] },
			{ name: "args", type: "string", planned: true },
			{ name: "metadata-json", type: "string", planned: true },
		],
		retention: [STATE_RETENTION, ARTIFACT_RETENTION, LEDGER_RETENTION, PRUNE_RETENTION, FORCE_RETENTION],
		hudFields: ["current_phase", "mode", "run_id", "stage", "stage_n", "plan_path"],
		graphLabel: "Ralplan",
		phaseLock: ["final", "handoff", "complete", "completed", "failed", "cancelled", "canceled", "inactive"],
		canonicalOverrides: ["final", "handoff", "complete", "completed", "failed", "cancelled", "canceled", "inactive"],
	}),
	ultragoal: manifest({
		skill: "ultragoal",
		states: ["missing", "goal-planning", "pending", "active", "blocked", "failed", "complete", "handoff"],
		terminalStates: ["missing", "failed", "complete", "handoff"],
		transitions: [
			{ from: "goal-planning", to: "pending", verb: "create-goals" },
			{ from: "pending", to: "active", verb: "complete-goals" },
			{ from: "active", to: "blocked", verb: "checkpoint" },
			{ from: "active", to: "failed", verb: "checkpoint" },
			{ from: "active", to: "complete", verb: "checkpoint" },
			{ from: "blocked", to: "active", verb: "checkpoint" },
			{ from: "failed", to: "active", verb: "complete-goals" },
			{ from: "goal-planning", to: "handoff", verb: "handoff" },
			{ from: "pending", to: "handoff", verb: "handoff" },
			{ from: "active", to: "handoff", verb: "handoff" },
			{ from: "blocked", to: "handoff", verb: "handoff" },
		],
		verbs: [
			...stateVerbs(),
			...positionalVerbs([
				"status",
				"create",
				"create-goals",
				"complete-goals",
				"checkpoint",
				"review",
				"record-review-blockers",
				"steer",
				"classify-blocker",
				"record-critic-verdict",
				"record-critic-gate-override",
				"quality-gate",
				"succession",
			]),
			...plannedVerbs(PLANNED_ADMIN_VERBS),
		],
		typedArgs: [
			{ name: "brief", type: "string", appliesToVerbs: ["create-goals"] },
			{ name: "brief-file", type: "string", appliesToVerbs: ["create-goals"] },
			{ name: "from-stdin", type: "boolean", appliesToVerbs: ["create-goals"] },
			{
				name: "gjc-goal-mode",
				type: "enum",
				enumValues: ["aggregate", "per-story"],
				appliesToVerbs: ["create-goals"],
			},
			{ name: "validation-batch-json", type: "string", appliesToVerbs: ["create-goals"] },
			{ name: "retry-failed", type: "boolean", appliesToVerbs: ["complete-goals"] },
			{ name: "goal-id", type: "string", required: true, appliesToVerbs: ["checkpoint", "record-review-blockers"] },
			{
				name: "status",
				type: "enum",
				enumValues: ["pending", "active", "complete", "failed", "blocked", "review_blocked", "superseded"],
				required: true,
				appliesToVerbs: ["checkpoint"],
			},
			{
				name: "evidence",
				type: "string",
				required: true,
				appliesToVerbs: [
					"checkpoint",
					"record-review-blockers",
					"steer",
					"classify-blocker",
					"record-critic-verdict",
					"record-critic-gate-override",
					"quality-gate",
				],
			},
			{
				name: "terminus",
				type: "enum",
				enumValues: ["completion", "pause"],
				required: true,
				appliesToVerbs: ["record-critic-verdict"],
			},
			{
				name: "verdict",
				type: "enum",
				enumValues: ["OKAY", "ITERATE", "REJECT"],
				required: true,
				appliesToVerbs: ["record-critic-verdict"],
			},
			{ name: "blockers-json", type: "string", appliesToVerbs: ["record-critic-verdict"] },
			{ name: "goal-id", type: "string", appliesToVerbs: ["record-critic-verdict"] },
			{ name: "classification-event-id", type: "string", appliesToVerbs: ["record-critic-verdict"] },
			// Cross-repository succession (#5353). Requiredness varies by subcommand
			// (`offer` needs the target/selection/authorization, `adopt` needs the
			// offer), so these are declared optional here — matching `quality-gate`.
			{ name: "target-repo", type: "string", appliesToVerbs: ["succession"] },
			{ name: "goal-id", type: "string", appliesToVerbs: ["succession"] },
			{ name: "authorize", type: "string", appliesToVerbs: ["succession"] },
			{ name: "authorized-by", type: "string", appliesToVerbs: ["succession"] },
			{ name: "offer", type: "string", appliesToVerbs: ["succession"] },
			{
				name: "gjc-goal-mode",
				type: "enum",
				enumValues: ["aggregate", "per-story"],
				appliesToVerbs: ["succession"],
			},
			{ name: "quality-gate-json", type: "string", appliesToVerbs: ["checkpoint", "quality-gate"] },
			{ name: "goal-id", type: "string", appliesToVerbs: ["quality-gate"] },
			{ name: "goal-id", type: "string", appliesToVerbs: ["steer"] },
			{ name: "goal-id", type: "string", appliesToVerbs: ["classify-blocker"] },
			{
				name: "classification",
				type: "enum",
				enumValues: ["human_blocked", "resolvable"],
				required: true,
				appliesToVerbs: ["classify-blocker"],
			},
			{
				name: "kind",
				type: "enum",
				enumValues: [
					"add_subgoal",
					"split_subgoal",
					"reorder_pending",
					"revise_pending_wording",
					"annotate_ledger",
					"mark_blocked_superseded",
				],
				appliesToVerbs: ["steer"],
			},
			{ name: "title", type: "string", appliesToVerbs: ["record-review-blockers", "steer"] },
			{ name: "objective", type: "string", appliesToVerbs: ["record-review-blockers", "steer"] },
			{ name: "rationale", type: "string", appliesToVerbs: ["steer"] },
			{ name: "replacements-json", type: "string", appliesToVerbs: ["steer"] },
			{ name: "order-json", type: "string", appliesToVerbs: ["steer"] },
			{ name: "pr", type: "string", appliesToVerbs: ["review"] },
			{ name: "branch", type: "string", appliesToVerbs: ["review"] },
			{ name: "spec", type: "string", appliesToVerbs: ["review"] },
			{ name: "executor-qa-json", type: "string", appliesToVerbs: ["review"] },
			{
				name: "mode",
				type: "enum",
				enumValues: ["review-only", "review-start"],
				appliesToVerbs: ["review"],
			},
			{
				name: "json",
				type: "boolean",
				appliesToVerbs: [
					"status",
					"create-goals",
					"complete-goals",
					"review",
					"checkpoint",
					"record-review-blockers",
					"steer",
					"classify-blocker",
					"record-critic-verdict",
					"record-critic-gate-override",
					"succession",
				],
			},
			{ name: "directive-json", type: "string", appliesToVerbs: ["steer"], planned: true },
			{ name: "args", type: "string", planned: true },
			{ name: "metadata-json", type: "string", planned: true },
		],
		retention: [STATE_RETENTION, ARTIFACT_RETENTION, LEDGER_RETENTION, PRUNE_RETENTION, FORCE_RETENTION],
		hudFields: ["current_phase", "active_goal_id", "status", "counts", "ledger_path", "brief_path"],
		graphLabel: "Ultragoal",
	}),
	autoresearch: manifest({
		skill: "autoresearch",
		states: ["intake", "research", "verdict", "complete", "failed", "cancelled", "handoff"],
		terminalStates: ["complete", "failed", "cancelled", "handoff"],
		transitions: [
			{ from: "intake", to: "research", verb: "write" },
			{ from: "research", to: "verdict", verb: "write" },
			{ from: "verdict", to: "research", verb: "write" },
			{ from: "research", to: "failed", verb: "write" },
			{ from: "research", to: "cancelled", verb: "write" },
			{ from: "verdict", to: "complete", verb: "clear" },
			{ from: "research", to: "complete", verb: "clear" },
			{ from: "intake", to: "complete", verb: "clear" },
			{ from: "intake", to: "handoff", verb: "handoff" },
			{ from: "research", to: "handoff", verb: "handoff" },
			{ from: "verdict", to: "handoff", verb: "handoff" },
		],
		verbs: [...stateVerbs(), ...positionalVerbs(["intake"]), ...plannedVerbs(PLANNED_ADMIN_VERBS)],
		typedArgs: [
			{ name: "spec", type: "string", required: true, appliesToVerbs: ["intake"] },
			{ name: "goal", type: "string", appliesToVerbs: ["write"] },
			{
				name: "mode",
				type: "enum",
				enumValues: ["web", "mixed", "data"],
				required: true,
				appliesToVerbs: ["write"],
			},
			{
				name: "json",
				type: "boolean",
				appliesToVerbs: ["read", "write", "clear", "intake", "handoff"],
			},
			{ name: "args", type: "string", planned: true },
			{ name: "metadata-json", type: "string", planned: true },
		],
		retention: [
			STATE_RETENTION,
			ARTIFACT_RETENTION,
			LEDGER_RETENTION,
			LOG_RETENTION,
			REPORT_RETENTION,
			PRUNE_RETENTION,
			FORCE_RETENTION,
		],
		hudFields: ["current_phase", "mode", "intake", "slug", "spec_path", "verdict"],
		graphLabel: "Autoresearch",
	}),
};

export function getSkillManifest(skill: CanonicalGjcWorkflowSkill): SkillManifest {
	return WORKFLOW_MANIFEST[skill];
}

export function isKnownWorkflowState(skill: CanonicalGjcWorkflowSkill, state: string): boolean {
	return WORKFLOW_MANIFEST[skill].states.some(entry => entry.id === state);
}

export function isValidTransition(skill: CanonicalGjcWorkflowSkill, from: string, to: string): boolean {
	if (from === to) return true;
	return WORKFLOW_MANIFEST[skill].transitions.some(transition => transition.from === from && transition.to === to);
}

export function listVerbs(skill: CanonicalGjcWorkflowSkill): string[] {
	return WORKFLOW_MANIFEST[skill].verbs.map(verb => verb.name);
}

export function typedArgsFor(skill: CanonicalGjcWorkflowSkill, verb: string): TypedArgSpec[] {
	return WORKFLOW_MANIFEST[skill].typedArgs.filter(
		arg => arg.appliesToVerbs === undefined || arg.appliesToVerbs.includes(verb),
	);
}

function stableSort(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => stableSort(item));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableSort(item)]),
	);
}

export function serializeManifestProjection(): string {
	return `${JSON.stringify(stableSort(WORKFLOW_MANIFEST), null, 2)}\n`;
}
