import { Container, type SelectItem, SelectList } from "@gajae-code/tui";
import { getSelectListTheme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

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
