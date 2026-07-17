import { Container, type SelectItem, type SelectList } from "@gajae-code/tui";
import { FramedSelect } from "./chrome";

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];

		const framed = FramedSelect(undefined, items, {
			maxVisible: 5,
			selectedValue: currentValue ? "yes" : "no",
			onSelect: item => onSelect(item.value === "yes"),
			onCancel,
		});
		this.#selectList = framed.selectList;
		this.addChild(framed.container);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
