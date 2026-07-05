import type { SelectListLayoutOptions } from "./components/select-list";

export const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

export function resolveAutocompleteSelectListLayout(prefix: string): SelectListLayoutOptions | undefined {
	return prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
}
