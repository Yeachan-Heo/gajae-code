import { ThinkingLevel, type ThinkingLevel as ThinkingLevelValue } from "@gajae-code/agent-core";
import { Container, type SelectItem, SelectList, Text } from "@gajae-code/tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata, type ThinkingLevelValue as ThinkingMetadataValue } from "../../thinking-metadata";
import { DynamicBorder } from "./dynamic-border";

const SCOPE_ITEMS = [
	{
		value: "session",
		label: "Apply for this session",
		description: "Use this effort until the session changes it again",
	},
	{
		value: "default",
		label: "Set as default",
		description: "Save this effort for future sessions",
	},
] as const satisfies readonly SelectItem[];

export interface ThinkingSelectorSelection {
	level: ThinkingLevelValue;
	persistDefault: boolean;
}

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	#selectList: SelectList;
	#levelList: SelectList;
	#selectedLevel: ThinkingLevelValue | undefined;
	readonly #onSelect: (selection: ThinkingSelectorSelection) => void;
	readonly #onCancel: () => void;

	constructor(
		currentLevel: ThinkingLevelValue | undefined,
		availableLevels: ThinkingLevelValue[],
		onSelect: (selection: ThinkingSelectorSelection) => void,
		onCancel: () => void,
	) {
		super();

		this.#onSelect = onSelect;
		this.#onCancel = onCancel;

		const currentValue = currentLevel ?? ThinkingLevel.Off;
		const thinkingLevels: SelectItem[] = availableLevels.map(level => {
			const metadata = getThinkingLevelMetadata(level as ThinkingMetadataValue);
			return level === currentValue
				? { ...metadata, label: metadata.label + theme.fg("muted", " (current)") }
				: metadata;
		});

		this.#levelList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme());
		this.#selectList = this.#levelList;

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex(item => item.value === currentValue);
		if (currentIndex !== -1) {
			this.#levelList.setSelectedIndex(currentIndex);
		}

		this.#levelList.onSelect = item => {
			this.#selectedLevel = item.value as ThinkingLevelValue;
			this.#renderScopeList();
		};

		this.#levelList.onCancel = () => {
			this.#onCancel();
		};

		this.#renderLevelList();
	}

	#renderLevelList(): void {
		this.detachAll();
		this.#selectedLevel = undefined;
		this.#selectList = this.#levelList;
		this.addChild(new DynamicBorder());
		this.addChild(this.#levelList);
		this.addChild(new DynamicBorder());
	}

	#renderScopeList(): void {
		const level = this.#selectedLevel;
		if (!level) return;

		const scopeList = new SelectList(SCOPE_ITEMS, SCOPE_ITEMS.length, getSelectListTheme());
		scopeList.onSelect = item => {
			this.#onSelect({
				level,
				persistDefault: item.value === "default",
			});
		};
		scopeList.onCancel = () => {
			this.#renderLevelList();
		};

		const metadata = getThinkingLevelMetadata(level as ThinkingMetadataValue);
		this.detachAll();
		this.#selectList = scopeList;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("muted", `  Reasoning effort: ${metadata.label}`), 0, 0));
		this.addChild(scopeList);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
