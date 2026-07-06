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
}

const STATE_RETENTION: RetentionPolicy = { category: "state", keep: 1 };
const ARTIFACT_RETENTION: RetentionPolicy = { category: "artifact" };
const LEDGER_RETENTION: RetentionPolicy = { category: "ledger" };
const LOG_RETENTION: RetentionPolicy = { category: "log", maxAgeDays: 30 };
const REPORT_RETENTION: RetentionPolicy = { category: "report", maxAgeDays: 30 };
const AGENTS_RETENTION: RetentionPolicy = { category: "agents" };
const PRUNE_RETENTION: RetentionPolicy = { category: "prune/delete", maxAgeDays: 30 };
const FORCE_RETENTION: RetentionPolicy = { category: "force", maxAgeDays: 90 };

const STATE_VERBS = ["read", "write", "clear", "contract", "handoff", "doctor"] as const;
const PLANNED_ADMIN_VERBS = ["graph", "prune", "migrate", "force-overwrite"] as const;

const COMMON_TYPED_ARGS: TypedArgSpec[] = [
	{ name: "input", type: "string", appliesToVerbs: ["write", "api"] },
	{ name: "mode", type: "enum", enumValues: [...CANONICAL_GJC_WORKFLOW_SKILLS], appliesToVerbs: [...STATE_VERBS] },
	{ name: "session-id", type: "string", appliesToVerbs: [...STATE_VERBS, "kickoff", "write-spec", "write-artifact"] },
	{ name: "thread-id", type: "string", appliesToVerbs: ["write", "clear", "handoff"] },
	{ name: "turn-id", type: "string", appliesToVerbs: ["write", "clear", "handoff"] },
	{
		name: "to",
		type: "enum",
		enumValues: [...CANONICAL_GJC_WORKFLOW_SKILLS],
		required: true,
		appliesToVerbs: ["handoff"],
	},
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
		verbs: [...stateVerbs(), ...flagVerbs(["kickoff", "write-spec"]), ...plannedVerbs(PLANNED_ADMIN_VERBS)],
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
			{ name: "json", type: "boolean", appliesToVerbs: ["write-spec"] },
			{ name: "args", type: "string", planned: true },
			{ name: "metadata-json", type: "string", planned: true },
		],
		retention: [STATE_RETENTION, ARTIFACT_RETENTION, PRUNE_RETENTION, FORCE_RETENTION],
		hudFields: ["current_phase", "ambiguity_score", "threshold", "spec_slug", "spec_path", "topology"],
		graphLabel: "Deep Interview",
	}),
	ralplan: manifest({
		skill: "ralplan",
		states: ["planner", "architect", "critic", "revision", "post-interview", "adr", "final", "handoff"],
		terminalStates: ["final", "handoff"],
		transitions: [
			{ from: "planner", to: "architect", verb: "write-artifact" },
			{ from: "architect", to: "critic", verb: "write-artifact" },
			{ from: "critic", to: "revision", verb: "write-artifact" },
			{ from: "revision", to: "post-interview", verb: "write-artifact" },
			{ from: "critic", to: "post-interview", verb: "write-artifact" },
			{ from: "post-interview", to: "revision", verb: "write-artifact" },
			{ from: "post-interview", to: "adr", verb: "write-artifact" },
			{ from: "revision", to: "adr", verb: "write-artifact" },
			{ from: "adr", to: "final", verb: "write-artifact" },
			{ from: "planner", to: "handoff", verb: "handoff" },
			{ from: "architect", to: "handoff", verb: "handoff" },
			{ from: "critic", to: "handoff", verb: "handoff" },
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
				enumValues: ["planner", "architect", "critic", "revision", "post-interview", "adr", "final"],
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
				"start-pipeline-overlap",
				"join-pipeline-overlap",
				"rebaseline-pipeline-overlap",
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
					"rebaseline-pipeline-overlap",
				],
			},
			{
				name: "goal-metadata-json",
				type: "string",
				appliesToVerbs: ["create-goals"],
			},
			{
				name: "prior-goal-id",
				type: "string",
				required: true,
				appliesToVerbs: ["start-pipeline-overlap"],
			},
			{
				name: "next-goal-id",
				type: "string",
				required: true,
				appliesToVerbs: ["start-pipeline-overlap"],
			},
			{
				name: "review-handles-json",
				type: "string",
				required: true,
				appliesToVerbs: ["start-pipeline-overlap"],
			},
			{
				name: "qa-handles-json",
				type: "string",
				required: true,
				appliesToVerbs: ["start-pipeline-overlap"],
			},
			{
				name: "implementation-handle-json",
				type: "string",
				required: true,
				appliesToVerbs: ["start-pipeline-overlap"],
			},
			{
				name: "overlap-id",
				type: "string",
				required: true,
				appliesToVerbs: ["join-pipeline-overlap", "rebaseline-pipeline-overlap"],
			},
			{
				name: "review-result-json",
				type: "string",
				required: true,
				appliesToVerbs: ["join-pipeline-overlap"],
			},
			{
				name: "qa-result-json",
				type: "string",
				required: true,
				appliesToVerbs: ["join-pipeline-overlap"],
			},
			{
				name: "target-state-json",
				type: "string",
				required: true,
				appliesToVerbs: ["rebaseline-pipeline-overlap"],
			},
			{ name: "quality-gate-json", type: "string", appliesToVerbs: ["checkpoint"] },
			{ name: "goal-id", type: "string", appliesToVerbs: ["steer"] },
			{ name: "goal-id", type: "string", appliesToVerbs: ["classify-blocker"] },
			{ name: "goal-id", type: "string", required: true, appliesToVerbs: ["rebaseline-pipeline-overlap"] },
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
					"start-pipeline-overlap",
					"join-pipeline-overlap",
					"rebaseline-pipeline-overlap",
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
	team: manifest({
		skill: "team",
		states: ["starting", "running", "awaiting_integration", "complete", "failed", "cancelled", "handoff"],
		terminalStates: ["complete", "failed", "cancelled", "handoff"],
		transitions: [
			{ from: "starting", to: "running", verb: "start" },
			{ from: "starting", to: "failed", verb: "start" },
			{ from: "running", to: "awaiting_integration", verb: "api" },
			{ from: "running", to: "complete", verb: "shutdown" },
			{ from: "running", to: "failed", verb: "shutdown" },
			{ from: "running", to: "cancelled", verb: "shutdown" },
			{ from: "awaiting_integration", to: "running", verb: "resume" },
			{ from: "awaiting_integration", to: "complete", verb: "shutdown" },
			{ from: "starting", to: "handoff", verb: "handoff" },
			{ from: "running", to: "handoff", verb: "handoff" },
			{ from: "awaiting_integration", to: "handoff", verb: "handoff" },
		],
		verbs: [
			...stateVerbs(),
			...positionalVerbs(["start", "list", "status", "monitor", "resume", "shutdown", "api"]),
			...plannedVerbs(PLANNED_ADMIN_VERBS),
		],
		typedArgs: [
			{ name: "dry-run", type: "boolean", appliesToVerbs: ["start"] },
			{ name: "worktree", type: "string", appliesToVerbs: ["start"] },
			{ name: "w", type: "string", appliesToVerbs: ["start"] },
			{ name: "input", type: "string", required: true, appliesToVerbs: ["api"] },
			{
				name: "operation",
				type: "enum",
				enumValues: [
					"send-message",
					"broadcast",
					"mailbox-list",
					"mailbox-mark-delivered",
					"mailbox-mark-notified",
					"notification-list",
					"notification-read",
					"notification-replay",
					"notification-mark-pane-attempt",
					"worker-startup-ack",
					"create-task",
					"read-task",
					"list-tasks",
					"update-task",
					"claim-task",
					"transition-task-status",
					"transition-task",
					"release-task-claim",
					"read-config",
					"read-manifest",
					"read-worker-status",
					"read-worker-heartbeat",
					"update-worker-heartbeat",
					"write-worker-inbox",
					"write-worker-identity",
					"append-event",
					"read-events",
					"await-event",
					"write-shutdown-request",
					"read-shutdown-ack",
					"read-monitor-snapshot",
					"write-monitor-snapshot",
					"read-task-approval",
					"write-task-approval",
				],
				required: true,
				appliesToVerbs: ["api"],
			},
			{ name: "worker-id", type: "string", appliesToVerbs: ["api"] },
			{ name: "task-id", type: "string", appliesToVerbs: ["api"] },
			{ name: "claim-token", type: "string", appliesToVerbs: ["api"] },
			{
				name: "status",
				type: "enum",
				enumValues: ["pending", "blocked", "in_progress", "completed", "failed"],
				appliesToVerbs: ["api"],
			},
			{ name: "completion_evidence", type: "object", appliesToVerbs: ["api"] },
			{ name: "completionEvidence", type: "object", appliesToVerbs: ["api"] },
			{ name: "args", type: "string", planned: true },
			{ name: "metadata-json", type: "string", planned: true },
		],
		retention: [
			STATE_RETENTION,
			ARTIFACT_RETENTION,
			LEDGER_RETENTION,
			LOG_RETENTION,
			REPORT_RETENTION,
			AGENTS_RETENTION,
			PRUNE_RETENTION,
			FORCE_RETENTION,
		],
		hudFields: ["current_phase", "team_name", "workers", "task_counts", "phase", "integration"],
		graphLabel: "Team",
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
