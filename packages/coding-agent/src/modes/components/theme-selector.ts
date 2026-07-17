import { Container, type SelectItem, type SelectList } from "@gajae-code/tui";
import { FramedSelect } from "./chrome";

/**
 * Component that renders a theme selector.
 * Themes must be pre-loaded and passed to the constructor.
 */
export class ThemeSelectorComponent extends Container {
	#selectList: SelectList;
	#onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		themes: string[],
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super();
		this.#onPreview = onPreview;

		// Create select items from provided themes
		const themeItems: SelectItem[] = themes.map(name => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		const framed = FramedSelect("Select theme", themeItems, {
			maxVisible: 10,
			selectedValue: currentTheme,
			onSelect: item => onSelect(item.value),
			onCancel,
			onSelectionChange: item => this.#onPreview(item.value),
		});
		this.#selectList = framed.selectList;
		this.addChild(framed.container);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
