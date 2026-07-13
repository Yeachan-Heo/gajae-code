import { getKeybindings } from "../keybindings";
import type { SymbolTheme } from "../symbols";
import type { Component } from "../tui";
import { Ellipsis, padding, replaceTabs, truncateToWidth, visibleWidth } from "../utils";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

function sanitizeSingleLine(text: string): string {
	return replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	/** Autocomplete hint consumed by Editor; SelectList does not render it. */
	hint?: string;
	/**
	 * Renders dimmed and can never be selected: navigation skips it, selection
	 * callbacks never fire for it, and a list whose visible items are all
	 * disabled reports no selection (`getSelectedItem()` returns `null`).
	 */
	disabled?: boolean;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	symbols: SymbolTheme;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export class SelectList implements Component {
	#filteredItems: ReadonlyArray<SelectItem>;
	/** Index of the selected enabled item, or `-1` when no enabled item exists. */
	#selectedIndex: number = 0;
	/** First rendered item while selection is absent. */
	#viewportStartIndex: number = 0;

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(
		private readonly items: ReadonlyArray<SelectItem>,
		private readonly maxVisible: number,
		private readonly theme: SelectListTheme,
		private readonly layout: SelectListLayoutOptions = {},
	) {
		this.#filteredItems = items;
		this.#selectedIndex = this.#firstEnabledIndex();
		this.#syncViewportToIndex(Math.max(0, this.#selectedIndex));
	}

	setFilter(filter: string): void {
		this.#filteredItems = this.items.filter(item => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		this.#selectedIndex = this.#firstEnabledIndex();
		this.#syncViewportToIndex(Math.max(0, this.#selectedIndex));
	}

	setSelectedIndex(index: number): void {
		if (this.#filteredItems.length === 0) {
			this.#selectedIndex = -1;
			this.#viewportStartIndex = 0;
			return;
		}
		const clamped = Math.max(0, Math.min(index, this.#filteredItems.length - 1));
		this.#selectedIndex =
			this.#findEnabledIndex(clamped, 1, false) ?? this.#findEnabledIndex(clamped, -1, false) ?? -1;
		this.#syncViewportToIndex(this.#selectedIndex >= 0 ? this.#selectedIndex : clamped);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.#filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		const primaryColumnWidth = this.#getPrimaryColumnWidth();

		// Calculate visible range with scrolling. Selection owns the viewport when
		// present; otherwise navigation moves an independent viewport anchor.
		const startIndex =
			this.#selectedIndex >= 0 ? this.#startIndexForSelection(this.#selectedIndex) : this.#clampedViewportStart();
		const endIndex = Math.min(startIndex + this.maxVisible, this.#filteredItems.length);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.#filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.#selectedIndex && !item.disabled;
			const descriptionText = item.description ? sanitizeSingleLine(item.description) : undefined;
			lines.push(this.#renderItem(item, isSelected, width, descriptionText, primaryColumnWidth));
		}

		// Add scroll indicators if needed. With no selectable item the position
		// is reported as "-" so an all-disabled list never claims a selection.
		if (startIndex > 0 || endIndex < this.#filteredItems.length) {
			const position = this.#selectedIndex >= 0 ? `${this.#selectedIndex + 1}` : "-";
			const scrollText = `  (${position}/${this.#filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, Ellipsis.Omit)));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.#filteredItems.length === 0) {
			if (kb.matches(keyData, "tui.select.cancel")) {
				if (this.onCancel) {
					this.onCancel();
				}
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.#moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.#moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.#movePage(-1);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.#movePage(1);
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selectedItem = this.#filteredItems[this.#selectedIndex];
			if (selectedItem && !selectedItem.disabled && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	#renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected
			? `${this.theme.symbols.cursor} `
			: padding(visibleWidth(this.theme.symbols.cursor) + 1);
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.#truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = padding(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, Ellipsis.Omit);
				if (item.disabled) {
					return this.theme.description(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.#truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (item.disabled) {
			return this.theme.description(`${prefix}${truncatedValue}`);
		}
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	#getPrimaryColumnWidth(): number {
		const { min, max } = this.#getPrimaryColumnBounds();
		const widestPrimary = this.#filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.#getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	#getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	#truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.#getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, Ellipsis.Omit);

		return truncateToWidth(truncatedValue, maxWidth, Ellipsis.Omit);
	}

	#getDisplayValue(item: SelectItem): string {
		return sanitizeSingleLine(item.label || item.value);
	}

	/** First enabled index, or `-1` when every filtered item is disabled. */
	#firstEnabledIndex(): number {
		return this.#filteredItems.findIndex(item => !item.disabled);
	}

	#findEnabledIndex(start: number, direction: 1 | -1, wrap: boolean): number | undefined {
		for (let step = 0; step < this.#filteredItems.length; step++) {
			let index = start + step * direction;
			if (index < 0 || index >= this.#filteredItems.length) {
				if (!wrap) return undefined;
				index = (index + this.#filteredItems.length) % this.#filteredItems.length;
			}
			if (!this.#filteredItems[index]?.disabled) return index;
		}
		return undefined;
	}

	#moveSelection(direction: 1 | -1): void {
		if (this.#filteredItems.length === 0) return;
		if (this.#selectedIndex < 0 && this.#firstEnabledIndex() < 0) {
			this.#moveViewport(direction, true);
			return;
		}
		const start =
			this.#selectedIndex < 0
				? direction === 1
					? 0
					: this.#filteredItems.length - 1
				: (this.#selectedIndex + direction + this.#filteredItems.length) % this.#filteredItems.length;
		const next = this.#findEnabledIndex(start, direction, true);
		if (next === undefined) return;
		if (next === this.#selectedIndex) {
			// Preserve the legacy enabled-only callback contract while suppressing
			// no-op previews when disabled entries collapse navigation to one item.
			if (this.#allItemsEnabled()) this.#notifySelectionChange();
			return;
		}
		this.#selectedIndex = next;
		this.#syncViewportToIndex(next);
		this.#notifySelectionChange();
	}

	#movePage(direction: 1 | -1): void {
		if (this.#filteredItems.length === 0) return;
		if (this.#selectedIndex < 0 && this.#firstEnabledIndex() < 0) {
			this.#moveViewport(direction * this.maxVisible, false);
			return;
		}
		const from = this.#selectedIndex < 0 ? (direction === 1 ? -1 : this.#filteredItems.length) : this.#selectedIndex;
		const target = Math.max(0, Math.min(this.#filteredItems.length - 1, from + direction * this.maxVisible));
		const next =
			this.#findEnabledIndex(target, direction, false) ??
			this.#findEnabledIndex(target, direction === 1 ? -1 : 1, false);
		if (next === undefined) return;
		if (next === this.#selectedIndex) {
			if (this.#allItemsEnabled()) this.#notifySelectionChange();
			return;
		}
		this.#selectedIndex = next;
		this.#syncViewportToIndex(next);
		this.#notifySelectionChange();
	}

	#allItemsEnabled(): boolean {
		return this.#filteredItems.every(item => !item.disabled);
	}

	#maxViewportStart(): number {
		return Math.max(0, this.#filteredItems.length - this.maxVisible);
	}

	#clampedViewportStart(): number {
		return Math.max(0, Math.min(this.#viewportStartIndex, this.#maxViewportStart()));
	}

	#startIndexForSelection(index: number): number {
		return Math.max(0, Math.min(index - Math.floor(this.maxVisible / 2), this.#maxViewportStart()));
	}

	#syncViewportToIndex(index: number): void {
		this.#viewportStartIndex = this.#startIndexForSelection(index);
	}

	#moveViewport(delta: number, wrap: boolean): void {
		const maxStart = this.#maxViewportStart();
		if (maxStart === 0) return;
		const next = this.#viewportStartIndex + delta;
		this.#viewportStartIndex = wrap ? (next + maxStart + 1) % (maxStart + 1) : Math.max(0, Math.min(next, maxStart));
	}

	#notifySelectionChange(): void {
		const selectedItem = this.#filteredItems[this.#selectedIndex];
		if (selectedItem && !selectedItem.disabled && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.#filteredItems[this.#selectedIndex];
		return item && !item.disabled ? item : null;
	}
}
