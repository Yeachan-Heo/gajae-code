import { Container, type SelectItem, type SelectList } from "@gajae-code/tui";
import { FramedSelect } from "./chrome";

/**
 * Component that renders a queue mode selector with borders
 */
export class QueueModeSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		currentMode: "all" | "one-at-a-time",
		onSelect: (mode: "all" | "one-at-a-time") => void,
		onCancel: () => void,
	) {
		super();

		const queueModes: SelectItem[] = [
			{
				value: "one-at-a-time",
				label: "one-at-a-time",
				description: "Process queued messages one by one (recommended)",
			},
			{ value: "all", label: "all", description: "Process all queued messages at once" },
		];

		const framed = FramedSelect(undefined, queueModes, {
			maxVisible: 2,
			selectedValue: currentMode,
			onSelect: item => onSelect(item.value as "all" | "one-at-a-time"),
			onCancel,
		});
		this.#selectList = framed.selectList;
		this.addChild(framed.container);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
