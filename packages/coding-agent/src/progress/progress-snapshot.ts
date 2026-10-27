/**
 * Machine-facing projection of the project progress report (SDK query
 * `session.progress`, Q32). It is a pure re-shaping of `ProjectProgressReport`:
 * every number, state, and attention item comes from the same computation, and
 * the human `/progress` view renders this snapshot (`render-progress.ts`), so
 * the two can never disagree. Absent evidence is `null`/empty, never estimated.
 * Every bounded list reports how many entries it omitted.
 */
import {
	boundSnapshotText,
	PROGRESS_SNAPSHOT_LIMITS,
	PROJECT_PROGRESS_SNAPSHOT_SCHEMA,
	type ProjectProgressSnapshot,
} from "./progress-contract";
import type { ProjectProgressReport } from "./project-progress";

function bounded<T, U>(items: readonly T[], limit: number, map: (item: T) => U): { kept: U[]; omitted: number } {
	return { kept: items.slice(0, limit).map(map), omitted: Math.max(0, items.length - limit) };
}

export function toProjectProgressSnapshot(report: ProjectProgressReport): ProjectProgressSnapshot {
	const { completion } = report;
	const stories = report.stories;
	const ultragoal =
		report.ultragoal && stories
			? (() => {
					const { kept, omitted } = bounded(report.ultragoal.stories, PROGRESS_SNAPSHOT_LIMITS.stories, story => ({
						id: boundSnapshotText(story.id, 64),
						title: boundSnapshotText(story.title),
						status: story.status,
						verificationReceipt: story.hasVerificationReceipt,
					}));
					return {
						objective: boundSnapshotText(report.ultragoal.objective),
						counts: {
							total: stories.total,
							complete: stories.complete,
							active: stories.active,
							pending: stories.pending,
							blocked: stories.blocked,
							superseded: stories.superseded,
						},
						stories: kept,
						omittedStories: omitted,
					};
				})()
			: null;
	const todos = report.todos
		? (() => {
				const { kept, omitted } = bounded(report.todoItems, PROGRESS_SNAPSHOT_LIMITS.todos, todo => ({
					content: boundSnapshotText(todo.content),
					status: todo.status,
				}));
				const t = report.todos;
				return {
					counts: {
						total: t.total,
						completed: t.completed,
						inProgress: t.inProgress,
						pending: t.pending,
						abandoned: t.abandoned,
					},
					items: kept,
					omittedItems: omitted,
				};
			})()
		: null;
	const workflows = bounded(report.workflows, PROGRESS_SNAPSHOT_LIMITS.workflows, workflow => ({
		skill: boundSnapshotText(workflow.skill, 64),
		phase: boundSnapshotText(workflow.phase, 64),
		summary: workflow.summary ? boundSnapshotText(workflow.summary) : null,
		chips: workflow.chips.map(chip => ({
			label: boundSnapshotText(chip.label, 64),
			value: chip.value ? boundSnapshotText(chip.value) : null,
			severity: chip.severity ?? null,
		})),
	}));
	const attention = bounded(report.signals, PROGRESS_SNAPSHOT_LIMITS.attention, signal => ({
		kind: signal.kind,
		source: signal.source,
		ref: signal.ref === undefined ? null : boundSnapshotText(signal.ref, 64),
		text: boundSnapshotText(signal.text),
	}));
	const receipts = report.verification.storyReceipts;
	return {
		schema: PROJECT_PROGRESS_SNAPSHOT_SCHEMA,
		state: report.headline,
		completion: {
			basis: completion.basis,
			done: completion.done,
			total: completion.total,
			percent: completion.percent ?? null,
			allUnitsDone: completion.total > 0 && completion.done >= completion.total,
			complete: report.headline === "complete",
			explanation: report.basisExplanation,
		},
		execution: {
			goal: report.goal
				? {
						objective: boundSnapshotText(report.goal.objective),
						status: report.goal.status,
						timeUsedSeconds: report.goal.timeUsedSeconds,
					}
				: null,
			ultragoal,
			todos,
		},
		activeWork: {
			story: stories?.current
				? { id: boundSnapshotText(stories.current.id, 64), title: boundSnapshotText(stories.current.title) }
				: null,
			todo: report.todos?.current ? boundSnapshotText(report.todos.current) : null,
			workflows: workflows.kept,
			omittedWorkflows: workflows.omitted,
			agents: { ...report.agents },
		},
		verification: {
			storyReceipts: receipts
				? {
						complete: receipts.complete,
						withReceipt: receipts.withReceipt,
						withoutReceipt: receipts.complete - receipts.withReceipt,
					}
				: null,
			reviewVerdicts: report.verification.reviewVerdicts.map(({ skill, verdict }) => ({
				skill: boundSnapshotText(skill, 64),
				verdict: boundSnapshotText(verdict, 64),
			})),
		},
		attention: attention.kept,
		omittedAttention: attention.omitted,
		sources: {
			sessionStateRead: report.sessionStateRead,
			unreadable: [...report.unreadable],
			recovered: [...report.recovered],
			discarded: [...report.discarded],
			unresolved: [...report.unresolved],
		},
	};
}
