import { Container, type SelectItem, SelectList } from "@gajae-code/tui";
import type { JobsSnapshot } from "../jobs-observer";
import { getSelectListTheme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import {
	buildConfirmItems,
	buildJobDetailItems,
	buildJobsListItems,
	type JobRef,
	parseJobRef,
} from "./jobs-overlay-model";

/**
 * Generic single-level selector used by the jobs overlay. The selector
 * controller mounts a fresh instance per navigation level (list -> detail ->
 * confirm); focus is placed on the inner SelectList, matching the existing
 * selector components (e.g. ThemeSelectorComponent).
 */
export class JobsSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(items: SelectItem[], onSelect: (item: SelectItem) => void, onCancel: () => void, maxVisible = 12) {
		super();
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, maxVisible, getSelectListTheme());
		this.#selectList.onSelect = onSelect;
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}

export interface JobsOverlayController {
	acknowledgeFailures(): void;
	getSnapshot(): JobsSnapshot;
	getMonitorOutput(id: string): string;
	cancelMonitor(id: string): boolean;
	deleteCron(id: string): boolean;
}

export interface JobsOverlayCallbacks {
	close(): void;
	requestRender(): void;
}

type JobsOverlayView = "list" | "detail" | "confirm";
type JobsOverlayAction = "cancel" | "delete";

export class JobsOverlayComponent extends Container {
	readonly #controller: JobsOverlayController;
	readonly #callbacks: JobsOverlayCallbacks;
	#view: JobsOverlayView = "list";
	#ref: JobRef | undefined;
	#action: JobsOverlayAction | undefined;
	#selectList: SelectList | undefined;

	constructor(controller: JobsOverlayController, callbacks: JobsOverlayCallbacks) {
		super();
		this.#controller = controller;
		this.#callbacks = callbacks;
		this.#controller.acknowledgeFailures();
		this.#renderList();
	}

	getFocus(): SelectList {
		if (!this.#selectList) throw new Error("Jobs overlay has no focusable list");
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#view === "confirm") {
			const key = data.toLowerCase();
			if (key === "y") {
				this.#confirmYes();
				return;
			}
			if (key === "n") {
				this.#renderDetail();
				return;
			}
		}
		this.#selectList?.handleInput(data);
	}

	#replaceList(
		items: SelectItem[],
		onSelect: (item: SelectItem) => void,
		onCancel: () => void,
		maxVisible = 12,
	): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, maxVisible, getSelectListTheme());
		this.#selectList.onSelect = onSelect;
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
		this.#callbacks.requestRender();
	}

	#renderList(): void {
		this.#view = "list";
		this.#ref = undefined;
		this.#action = undefined;
		const snapshot = this.#controller.getSnapshot();
		const built = buildJobsListItems(snapshot);
		const items = built.length > 0 ? built : [{ value: "close", label: "No active monitor or cron jobs" }];
		this.#replaceList(
			items,
			item => {
				const ref = parseJobRef(item.value);
				if (ref) this.#renderDetail(ref);
				else this.#callbacks.close();
			},
			() => this.#callbacks.close(),
		);
	}

	#renderDetail(ref = this.#ref): void {
		if (!ref) {
			this.#renderList();
			return;
		}
		this.#view = "detail";
		this.#ref = ref;
		this.#action = undefined;
		const output = ref.kind === "monitor" ? this.#controller.getMonitorOutput(ref.id) : "";
		const items = buildJobDetailItems(this.#controller.getSnapshot(), ref, output);
		this.#replaceList(
			items,
			item => {
				if (item.value === "action:cancel") this.#renderConfirm("cancel");
				else if (item.value === "action:delete") this.#renderConfirm("delete");
				else if (item.value === "back") this.#renderList();
			},
			() => this.#callbacks.close(),
		);
	}

	#renderConfirm(action: JobsOverlayAction): void {
		if (!this.#ref) {
			this.#renderList();
			return;
		}
		this.#view = "confirm";
		this.#action = action;
		const label = action === "cancel" ? "cancel this monitor" : "delete this cron";
		this.#replaceList(
			buildConfirmItems(label),
			item => {
				if (item.value === "yes") this.#confirmYes();
				else this.#renderDetail();
			},
			() => this.#renderDetail(),
			4,
		);
	}

	#confirmYes(): void {
		if (!this.#ref || !this.#action) {
			this.#renderList();
			return;
		}
		if (this.#action === "cancel") this.#controller.cancelMonitor(this.#ref.id);
		else this.#controller.deleteCron(this.#ref.id);
		this.#renderList();
	}
}
