import type { WorkflowHudChip, WorkflowHudSummary } from "./active-state";

interface DeepInterviewHudState {
	phase?: string;
	ambiguity?: number;
	threshold?: number;
	roundCount?: number;
	targetComponent?: string;
	weakestDimension?: string;
	specStatus?: string;
	updatedAt?: string;
}

interface RalplanHudState {
	stage?: string;
	waiting?: string;
	iteration?: number;
	verdict?: string;
	latestSummary?: string;
	pendingApproval?: boolean;
	updatedAt?: string;
}

interface UltragoalLikeGoal {
	id: string;
	title: string;
	status: string;
}

interface UltragoalHudState {
	status: string;
	currentGoal?: UltragoalLikeGoal;
	counts: Record<string, number>;
	goals: UltragoalLikeGoal[];
	latestLedgerEvent?: { event?: string; goalId?: string; timestamp?: string };
	updatedAt?: string;
}

interface TeamHudWorker {
	id: string;
	status?: string;
}

interface TeamHudState {
	phase: string;
	task_total: number;
	task_counts: Record<string, number>;
	workers: TeamHudWorker[];
	updated_at?: string;
	latestEvent?: { type?: string; worker?: string; message?: string };
	latestMessage?: { from_worker?: string; body?: string };
}

function percent(value: number | undefined): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return `${Math.round(value * 100)}%`;
}

function chip(
	label: string,
	value: string | undefined,
	priority: number,
	severity?: WorkflowHudChip["severity"],
): WorkflowHudChip | null {
	if (!value) return null;
	return { label, value, priority, ...(severity ? { severity } : {}) };
}

function compactChips(chips: Array<WorkflowHudChip | null>): WorkflowHudChip[] {
	return chips.filter((item): item is WorkflowHudChip => item !== null);
}

export function buildDeepInterviewHudSummary(state: DeepInterviewHudState): WorkflowHudSummary {
	return {
		version: 1,
		chips: compactChips([
			chip("phase", state.phase, 10),
			chip("ambiguity", [percent(state.ambiguity), percent(state.threshold)].filter(Boolean).join("/"), 20),
			chip("round", state.roundCount === undefined ? undefined : String(state.roundCount), 30),
			chip("target", state.targetComponent, 40),
			chip("weakest", state.weakestDimension, 50),
			chip("spec", state.specStatus, 60),
		]),
		...(state.updatedAt ? { updated_at: state.updatedAt } : {}),
	};
}

export function buildRalplanHudSummary(state: RalplanHudState): WorkflowHudSummary {
	const verdict = state.verdict?.toUpperCase();
	const verdictSeverity =
		verdict === "BLOCK"
			? "blocked"
			: verdict === "ITERATE" || verdict === "WATCH"
				? "warning"
				: verdict === "APPROVE" || verdict === "CLEAR"
					? "success"
					: undefined;
	return {
		version: 1,
		summary: state.latestSummary,
		chips: compactChips([
			state.pendingApproval ? { label: "pending", value: "approval", priority: 5, severity: "warning" } : null,
			chip("stage", state.stage, 10),
			chip("waiting", state.waiting, 20),
			chip("iter", state.iteration === undefined ? undefined : String(state.iteration), 30),
			chip("verdict", verdict, 40, verdictSeverity),
		]),
		...(state.updatedAt ? { updated_at: state.updatedAt } : {}),
	};
}

export function buildUltragoalHudSummary(state: UltragoalHudState): WorkflowHudSummary {
	const total = state.goals.length;
	const complete = state.counts.complete ?? 0;
	const blockers = (state.counts.blocked ?? 0) + (state.counts.review_blocked ?? 0) + (state.counts.failed ?? 0);
	return {
		version: 1,
		chips: compactChips([
			blockers > 0 ? { label: "blocked", value: String(blockers), priority: 5, severity: "blocked" } : null,
			chip("goals", `${complete}/${total}`, 10),
			chip("current", state.currentGoal ? `${state.currentGoal.id}:${state.currentGoal.title}` : state.status, 20),
			chip("status", state.status, 30, state.status === "complete" ? "success" : undefined),
		]),
		details: state.latestLedgerEvent
			? compactChips([
					chip(
						"ledger",
						[state.latestLedgerEvent.event, state.latestLedgerEvent.goalId].filter(Boolean).join(":"),
						100,
					),
				])
			: undefined,
		...(state.updatedAt ? { updated_at: state.updatedAt } : {}),
	};
}

export function buildTeamHudSummary(state: TeamHudState): WorkflowHudSummary {
	const failedWorkers = state.workers.filter(
		worker => worker.status === "failed" || worker.status === "blocked",
	).length;
	const stoppedWorkers = state.workers.filter(worker => worker.status === "stopped").length;
	const completed = state.task_counts.completed ?? 0;
	const failedTasks = (state.task_counts.failed ?? 0) + (state.task_counts.blocked ?? 0);
	const latest = state.latestEvent?.message ?? state.latestEvent?.type ?? state.latestMessage?.body;
	return {
		version: 1,
		chips: compactChips([
			failedWorkers > 0 || failedTasks > 0
				? { label: "blocked", value: String(failedWorkers + failedTasks), priority: 5, severity: "blocked" }
				: stoppedWorkers > 0
					? { label: "stopped", value: String(stoppedWorkers), priority: 5, severity: "warning" }
					: null,
			chip("phase", state.phase, 10),
			chip("workers", `${state.workers.length - failedWorkers}/${state.workers.length}`, 20),
			chip("tasks", `${completed}/${state.task_total}`, 30),
			chip("latest", latest, 50),
		]),
		...(state.updated_at ? { updated_at: state.updated_at } : {}),
	};
}
