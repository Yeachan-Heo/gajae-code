import type { DesktopTodoPhase } from "@gajae-code/desktop-host/protocol";
import { ChevronDown, ChevronRight, Circle, CircleCheck, ListChecks, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { t } from "./i18n";

const todoStatusIcons = {
	pending: Circle,
	in_progress: LoaderCircle,
	completed: CircleCheck,
	abandoned: X,
};

/**
 * The live `todo_write` list. Collapsed it states the progress and the task in flight; expanded
 * it shows every task, so the tool's state is visible without reading the tool result.
 */
export function TodoPanel({ phases }: { phases: DesktopTodoPhase[] }) {
	const [open, setOpen] = useState(false);
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return null;
	const done = tasks.filter(task => task.status === "completed").length;
	const active = tasks.find(task => task.status === "in_progress");
	return (
		<section className="todo-panel" aria-label={t("support.todosLabel")}>
			<button className="todo-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
				<ListChecks aria-hidden="true" />
				<span className="todo-summary">
					{t("support.todoProgress", { done, total: tasks.length })}
					{!open && active && <small>{active.content}</small>}
				</span>
				{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
			</button>
			{open && (
				<div className="todo-phases">
					{phases.map((phase, phaseIndex) => (
						<div className="todo-phase" key={`${phaseIndex}-${phase.name}`}>
							{phase.name && <h3>{phase.name}</h3>}
							<ul>
								{phase.tasks.map((task, index) => {
									const Icon = todoStatusIcons[task.status];
									return (
										<li key={`${task.content}-${index}`} className={`todo-task ${task.status}`}>
											<Icon aria-hidden="true" />
											<span>{task.content}</span>
										</li>
									);
								})}
							</ul>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
