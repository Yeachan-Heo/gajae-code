import { ThinkingLevel, type ThinkingLevel as ThinkingLevelValue } from "@gajae-code/agent-core";
import { Container, type SelectItem, SelectList } from "@gajae-code/tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata, type ThinkingLevelValue as ThinkingMetadataValue } from "../../thinking-metadata";
import { DynamicBorder } from "./dynamic-border";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		currentLevel: ThinkingLevelValue | undefined,
		availableLevels: ThinkingLevelValue[],
		onSelect: (level: ThinkingLevelValue) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingLevels: SelectItem[] = availableLevels.map(level =>
			getThinkingLevelMetadata(level as ThinkingMetadataValue),
		);

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme());

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex(item => item.value === (currentLevel ?? ThinkingLevel.Off));
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as ThinkingLevelValue);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
