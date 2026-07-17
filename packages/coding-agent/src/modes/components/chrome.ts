import { Container, type SelectItem, SelectList, Text } from "@gajae-code/tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface FramedSelectOptions {
	maxVisible?: number;
	selectedValue?: string;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;
}

export interface FramedSelect {
	container: Container;
	selectList: SelectList;
}

/** Build the shared border/list selector chrome used by compact mode selectors. */
export function FramedSelect(
	title: string | undefined,
	items: ReadonlyArray<SelectItem>,
	opts: FramedSelectOptions = {},
): FramedSelect {
	const container = new Container();
	container.addChild(new DynamicBorder());
	if (title) {
		container.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
	}

	const selectList = new SelectList(items, opts.maxVisible ?? Math.min(items.length, 10), getSelectListTheme());
	const selectedIndex =
		opts.selectedValue === undefined ? -1 : items.findIndex(item => item.value === opts.selectedValue);
	if (selectedIndex !== -1) selectList.setSelectedIndex(selectedIndex);
	selectList.onSelect = item => opts.onSelect?.(item);
	selectList.onCancel = () => opts.onCancel?.();
	if (opts.onSelectionChange) selectList.onSelectionChange = opts.onSelectionChange;
	container.addChild(selectList);
	container.addChild(new DynamicBorder());
	return { container, selectList };
}
