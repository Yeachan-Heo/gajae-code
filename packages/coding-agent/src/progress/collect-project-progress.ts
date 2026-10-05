import type { SubagentLifecycle } from "../async/job-manager";
import { readUltragoalPlan } from "../gjc-runtime/ultragoal-runtime";
import type { Goal, GoalModeState } from "../goals/state";
import type { SessionManager } from "../session/session-manager";
import { normalizeWorkflowHudSummary, readVisibleSkillActiveState } from "../skill-state/active-state";
import type { TodoPhase } from "../tools/todo-write";
import {
	computeProjectProgress,
	type ProgressDurableSource,
	type ProgressUltragoalInput,
	type ProgressWorkflowInput,
	type ProjectProgressInput,
	type ProjectProgressReport,
} from "./project-progress";

/** Session-owned state the overview reads; everything else comes from durable `.gjc` files. */
export interface ProjectProgressSessionView {
	cwd: string;
	/** GJC session id that scopes `.gjc/_session-{id}` state; without it no workflow state is read. */
	sessionId: string | undefined;
	goal: Goal | undefined;
	todoPhases: readonly TodoPhase[];
	subagents: readonly SubagentLifecycle[];
}

async function readWorkflows(cwd: string, sessionId: string): Promise<ProgressWorkflowInput[]> {
	const state = await readVisibleSkillActiveState(cwd, sessionId);
	return (state?.active_skills ?? [])
		.filter(entry => entry.active !== false)
		.map(entry => {
			const hud = normalizeWorkflowHudSummary(entry.hud);
			return {
				skill: entry.skill,
				phase: entry.phase?.trim() || "unknown",
				...(hud?.summary ? { summary: hud.summary } : {}),
				chips: (hud?.chips ?? []).map(chip => ({
					label: chip.label,
					...(chip.value ? { value: chip.value } : {}),
					...(chip.severity ? { severity: chip.severity } : {}),
				})),
			};
		});
}

async function readUltragoal(cwd: string, sessionId: string): Promise<ProgressUltragoalInput | undefined> {
	const plan = await readUltragoalPlan(cwd, sessionId);
	if (!plan || plan.goals.length === 0) return undefined;
	return {
		objective: plan.gjcObjective,
		stories: plan.goals.map(goal => ({
			id: goal.id,
			title: goal.title,
			status: goal.status,
			hasVerificationReceipt: typeof goal.completionVerification?.receiptId === "string",
		})),
	};
}

/**
 * Gather progress input strictly by reading state. A source that fails to read
 * is reported as unreadable and excluded; it never aborts the overview and is
 * never replaced by a guess.
 */
export async function collectProjectProgressInput(view: ProjectProgressSessionView): Promise<ProjectProgressInput> {
	const unreadable: ProgressDurableSource[] = [];
	const sessionId = view.sessionId?.trim() || undefined;
	let workflows: ProgressWorkflowInput[] = [];
	let ultragoal: ProgressUltragoalInput | undefined;
	if (sessionId) {
		const [workflowResult, ultragoalResult] = await Promise.allSettled([
			readWorkflows(view.cwd, sessionId),
			readUltragoal(view.cwd, sessionId),
		]);
		if (workflowResult.status === "fulfilled") workflows = workflowResult.value;
		else unreadable.push("workflow-state");
		if (ultragoalResult.status === "fulfilled") ultragoal = ultragoalResult.value;
		else unreadable.push("ultragoal-plan");
	}
	return {
		...(view.goal
			? {
					goal: {
						objective: view.goal.objective,
						status: view.goal.status,
						timeUsedSeconds: view.goal.timeUsedSeconds,
					},
				}
			: {}),
		todos: view.todoPhases.flatMap(phase =>
			phase.tasks.map(task => ({ content: task.content, status: task.status })),
		),
		workflows,
		...(ultragoal ? { ultragoal } : {}),
		subagents: [...view.subagents],
		sessionStateRead: sessionId !== undefined,
		unreadable,
	};
}

/** The live session state `/progress` and `session.progress` read; satisfied by `AgentSession`. */
export interface ProjectProgressSessionSource {
	getGoalModeState(): GoalModeState | undefined;
	getTodoPhases(): TodoPhase[];
	getSubagentLifecycleStatuses(): SubagentLifecycle[];
}

/** Single entry point shared by the human view and the machine snapshot. */
export async function buildSessionProjectProgress(
	session: ProjectProgressSessionSource,
	sessionManager: Pick<SessionManager, "getCwd" | "getSessionId">,
): Promise<ProjectProgressReport> {
	const input = await collectProjectProgressInput({
		cwd: sessionManager.getCwd(),
		sessionId: sessionManager.getSessionId(),
		goal: session.getGoalModeState()?.goal,
		todoPhases: session.getTodoPhases(),
		subagents: session.getSubagentLifecycleStatuses(),
	});
	return computeProjectProgress(input);
}
