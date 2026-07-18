import { Container, type SelectItem, SelectList } from "@gajae-code/tui";
import type { TaskRow, TasksAggregator } from "../tasks-aggregator";
import { getSelectListTheme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface TasksPaneCallbacks {
	close(): void;
	requestRender(): void;
}

/** A compact, read-only unified task list. Source-specific controls remain in their owners. */
export class TasksPaneComponent extends Container {
	readonly #aggregator: TasksAggregator;
	readonly #callbacks: TasksPaneCallbacks;
	#selectList: SelectList | undefined;

	constructor(aggregator: TasksAggregator, callbacks: TasksPaneCallbacks) {
		super();
		this.#aggregator = aggregator;
		this.#callbacks = callbacks;
		this.#render();
		this.#aggregator.acknowledgeFailures();
	}

	getFocus(): SelectList {
		if (!this.#selectList) throw new Error("Tasks pane has no focusable list");
		return this.#selectList;
	}

	handleInput(data: string): void {
		this.#selectList?.handleInput(data);
	}

	refresh(): void {
		this.#render();
	}

	#render(): void {
		const rows = this.#aggregator.getSnapshot().rows;
		const items = rows.length > 0 ? rows.map(taskItem) : [{ value: "close", label: "No tasks" }];
		this.clear();
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, 12, getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "close") this.#callbacks.close();
		};
		this.#selectList.onCancel = () => this.#callbacks.close();
		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
		this.#callbacks.requestRender();
	}
}

export function taskItem(row: TaskRow): SelectItem {
	const badge = row.monitorOutputLines === undefined ? "" : ` (${row.monitorOutputLines} lines)`;
	const resumable = row.resumable ? " [resumable]" : "";
	return { value: row.id, label: `${statusLabel(row.status)} ${row.label}${badge}${resumable}` };
}

function statusLabel(status: TaskRow["status"]): string {
	switch (status) {
		case "running":
			return "Running";
		case "waiting":
			return "Waiting";
		case "done":
			return "Done";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
	}
}
