import { t } from "./i18n";
import { TodoPhaseList, todoProgress } from "./TodoPanel";
import type { ToolCallBodyProps } from "./ToolCallCard";

/**
 * Expanded body of a `todo_write` row: the task list as the call left it, from `tool.detail`.
 * A failed or cancelled call, or one without task detail, shows the generic output instead, since
 * its error text is what explains it and the list it reports did not change.
 */
export function TodoToolBody({ message, detail, output }: ToolCallBodyProps) {
	const phases = detail?.todo?.filter(phase => phase.tasks.length > 0) ?? [];
	if (message.isError || message.cancelled || phases.length === 0) return output;
	const { done, total } = todoProgress(phases);
	return (
		<div className="todo-tool-body">
			<p className="todo-tool-summary">{t("support.todoProgress", { done, total })}</p>
			<TodoPhaseList phases={phases} />
		</div>
	);
}
