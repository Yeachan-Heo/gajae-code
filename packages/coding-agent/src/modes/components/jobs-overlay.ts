import { Container, type SelectItem, SelectList } from "@gajae-code/tui";
import type { JobsSnapshot } from "../jobs-observer";
import { getSelectListTheme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import {
	buildConfirmItems,
	buildJobDetailItems,
	buildJobsListItems,
	isJobRefPresent,
	type JobRef,
	type JobsOverlayModelOptions,
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
	getSnapshot(): JobsSnapshot;

	getMonitorOutput(id: string): string;
	cancelMonitor(id: string): boolean;
	deleteCron(id: string): boolean;
}

export interface JobsOverlayCallbacks {
	close(): void;
	requestRender(): void;
}

export interface JobsOverlayOptions extends JobsOverlayModelOptions {
	readonly initialRef?: JobRef;
}

type JobsOverlayView = "list" | "detail" | "confirm";
type JobsOverlayAction = "cancel" | "delete";

export class JobsOverlayComponent extends Container {
	readonly #controller: JobsOverlayController;
	readonly #callbacks: JobsOverlayCallbacks;
	readonly #options: JobsOverlayOptions;
	#view: JobsOverlayView = "list";
	#ref: JobRef | undefined;
	#action: JobsOverlayAction | undefined;
	#selectList: SelectList | undefined;
	#initialRevealAvailable = true;

	constructor(controller: JobsOverlayController, callbacks: JobsOverlayCallbacks, options: JobsOverlayOptions = {}) {
		super();
		this.#controller = controller;
		this.#callbacks = callbacks;
		this.#options = options;
		const initialRef = this.#options.initialRef;
		if (initialRef && !isJobRefPresent(this.#controller.getSnapshot(), initialRef)) {
			this.#initialRevealAvailable = false;
			this.#renderUnavailable();
		} else if (initialRef) {
			this.#renderDetail(initialRef);
		} else {
			this.#renderList();
		}
	}

	/** False means an attention reveal raced with owner removal and was not mounted. */
	isInitialRevealAvailable(): boolean {
		return this.#initialRevealAvailable;
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

	#renderUnavailable(): void {
		this.#view = "detail";
		this.#ref = undefined;
		this.#action = undefined;
		this.#replaceList(
			[
				{
					value: "close",
					label: "Job reveal unavailable",
					description: "The background job is no longer present.",
				},
			],
			() => this.#callbacks.close(),
			() => this.#callbacks.close(),
		);
	}

	#renderList(): void {
		this.#view = "list";
		this.#ref = undefined;
		this.#action = undefined;
		const snapshot = this.#controller.getSnapshot();
		const built = buildJobsListItems(snapshot, this.#options);
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
		if (!isJobRefPresent(this.#controller.getSnapshot(), ref)) {
			this.#renderUnavailable();
			return;
		}
		this.#view = "detail";
		this.#ref = ref;
		this.#action = undefined;
		const output =
			this.#options.safeAttentionReveal || ref.kind !== "monitor" ? "" : this.#controller.getMonitorOutput(ref.id);
		const items = buildJobDetailItems(this.#controller.getSnapshot(), ref, output, this.#options);
		this.#replaceList(
			items,
			item => {
				if (item.value === "action:cancel") this.#renderConfirm("cancel");
				else if (item.value === "action:delete") this.#renderConfirm("delete");
				else if (item.value === "back") this.#renderList();
				else if (item.value === "close") this.#callbacks.close();
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
