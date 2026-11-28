import type {
	DesktopMessage,
	DesktopSession,
	DesktopTodoItem,
	DesktopTodoPhase,
} from "@gajae-code/desktop-host/protocol";
import {
	ChevronDown,
	ChevronRight,
	Circle,
	CircleCheck,
	ListChecks,
	LoaderCircle,
	type LucideIcon,
	StickyNote,
	TriangleAlert,
	X,
} from "lucide-react";
import { useState } from "react";
import { type MessageKey, t } from "./i18n";

/** The Host projects at most this many tasks, so a list this long may have been cut. */
export const TODO_TASK_LIMIT = 120;
/** The Host keeps at most this many notes per task, so a full set may hide older ones. */
export const TODO_NOTE_LIMIT = 5;

const todoStatusIcons: Record<DesktopTodoItem["status"], LucideIcon> = {
	pending: Circle,
	in_progress: LoaderCircle,
	completed: CircleCheck,
	abandoned: X,
};

const todoStatusLabels: Record<DesktopTodoItem["status"], MessageKey> = {
	pending: "todo.statusPending",
	in_progress: "todo.statusInProgress",
	completed: "todo.statusCompleted",
	abandoned: "todo.statusAbandoned",
};

export interface TodoProgress {
	/** Completed or abandoned tasks: finished either way, as the terminal counts them. */
	done: number;
	total: number;
	/** The first task in flight. */
	active?: DesktopTodoItem;
}

function finished(task: DesktopTodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/** Progress over every task of the list; the panel, the toolbar chip and its label share it. */
export function todoProgress(phases: readonly DesktopTodoPhase[] | undefined): TodoProgress {
	const tasks = phases?.flatMap(phase => phase.tasks) ?? [];
	return {
		done: tasks.filter(finished).length,
		total: tasks.length,
		active: tasks.find(task => task.status === "in_progress"),
	};
}

function TodoNoteCount({ count }: { count: number }) {
	const full = count >= TODO_NOTE_LIMIT;
	const label = full ? t("todo.noteCountAtLeast", { count: TODO_NOTE_LIMIT }) : t("todo.noteCount", { count });
	return (
		<span className="todo-note-count" title={label}>
			<StickyNote aria-hidden="true" />
			<span aria-hidden="true">{full ? t("todo.noteCountShortAtLeast", { count: TODO_NOTE_LIMIT }) : count}</span>
			<span className="sr-only">{label}</span>
		</span>
	);
}

function TodoTask({ task }: { task: DesktopTodoItem }) {
	const Icon = todoStatusIcons[task.status];
	const notes = task.notes ?? [];
	return (
		<li className={`todo-task ${task.status}`}>
			<Icon role="img" aria-label={t(todoStatusLabels[task.status])} />
			<div className="todo-task-body">
				<span className="todo-task-text">{task.content}</span>
				{notes.length > 0 && <TodoNoteCount count={notes.length} />}
				{task.status === "in_progress" && notes.length > 0 && (
					<ul className="todo-notes" aria-label={t("todo.notesLabel")}>
						{notes.map((note, index) => (
							<li key={`${index}-${note}`}>{note}</li>
						))}
					</ul>
				)}
			</div>
		</li>
	);
}

/**
 * Every phase and task of a list, read-only: numbered phase headings with their own progress,
 * status icons, note counts and the notes of the task in flight. Used by the expanded panel and
 * by the expanded `todo_write` row.
 */
export function TodoPhaseList({ phases }: { phases: readonly DesktopTodoPhase[] }) {
	const total = phases.reduce((count, phase) => count + phase.tasks.length, 0);
	return (
		<div className="todo-phases">
			{phases.map((phase, phaseIndex) => {
				const done = phase.tasks.filter(finished).length;
				return (
					<div className="todo-phase" key={`${phaseIndex}-${phase.name}`}>
						<div className="todo-phase-heading">
							<h3>{phase.name || t("todo.phaseUntitled")}</h3>
							<span className="todo-phase-count">
								<span aria-hidden="true">{t("todo.phaseCount", { done, total: phase.tasks.length })}</span>
								<span className="sr-only">{t("todo.phaseProgress", { done, total: phase.tasks.length })}</span>
							</span>
						</div>
						<ul>
							{phase.tasks.map((task, index) => (
								<TodoTask key={`${task.content}-${index}`} task={task} />
							))}
						</ul>
					</div>
				);
			})}
			{total >= TODO_TASK_LIMIT && <p className="todo-cap">{t("todo.capNotice", { count: TODO_TASK_LIMIT })}</p>}
		</div>
	);
}

/**
 * The live `todo_write` list. Collapsed it states the progress and the task in flight; expanded
 * it shows every task, so the tool's state is visible without reading the tool result.
 */
export function TodoPanel({ phases, defaultOpen = false }: { phases: DesktopTodoPhase[]; defaultOpen?: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	const { done, total, active } = todoProgress(phases);
	if (total === 0) return null;
	return (
		<section className="todo-panel" aria-label={t("support.todosLabel")}>
			<button className="todo-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
				<ListChecks aria-hidden="true" />
				<span className="todo-summary">
					{t("support.todoProgress", { done, total })}
					{!open && active && <small>{active.content}</small>}
					<span className={`todo-progress${done === total ? " complete" : ""}`} aria-hidden="true">
						<span style={{ width: `${(done / total) * 100}%` }} />
					</span>
				</span>
				{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
			</button>
			{open && <TodoPhaseList phases={phases} />}
		</section>
	);
}

/**
 * True when the newest settled `todo_write` row in the visible transcript failed, so the list the
 * Host reports may not be the one the model meant to write. Cancelled rows changed nothing and
 * calls still in flight have no result yet, so both are skipped in favour of the row before.
 */
export function todoListStale(messages: readonly DesktopMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "tool") continue;
		if (message.tool?.family !== "todo" && message.toolName !== "todo_write") continue;
		const status = message.tool?.status;
		if (message.cancelled || status === "cancelled") continue;
		if (status === "preparing" || status === "waiting" || status === "running") continue;
		return message.isError === true || status === "failed";
	}
	return false;
}

/**
 * The task list group of the Session work card: its heading, a hint when the last update failed,
 * and the panel. Renders nothing for a session without tasks.
 */
export function SessionWorkTodos({ session }: { session: DesktopSession }) {
	const phases = session.todos?.filter(phase => phase.tasks.length > 0) ?? [];
	if (phases.length === 0) return null;
	return (
		<section className="session-work-todos" aria-label={t("panels.sessionWorkTodos")}>
			<h3>{t("panels.sessionWorkTodos")}</h3>
			{todoListStale(session.messages) && (
				<p className="todo-stale">
					<TriangleAlert aria-hidden="true" />
					<span>{t("todo.stale")}</span>
				</p>
			)}
			<TodoPanel phases={phases} />
		</section>
	);
}
