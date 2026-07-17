import { getKeybindings } from "../keybindings";
import type { Component } from "../tui";
import { Ellipsis, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export class SettingsList implements Component {
	#items: SettingItem[];
	#theme: SettingsListTheme;
	#selectedIndex = 0;
	#maxVisible: number;
	#onChange: (id: string, newValue: string) => void;
	#onCancel: () => void;
	#onSelectionChange?: (item: SettingItem | undefined) => void;
	#descriptionRows: number;

	// Submenu state
	#submenuComponent: Component | null = null;
	#submenuItemIndex: number | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		onSelectionChange?: (item: SettingItem | undefined) => void,
		descriptionRows = 0,
	) {
		this.#items = items;
		this.#maxVisible = maxVisible;
		this.#theme = theme;
		this.#onChange = onChange;
		this.#onCancel = onCancel;
		this.#onSelectionChange = onSelectionChange;
		this.#descriptionRows = Math.max(0, descriptionRows);
		this.#notifySelectionChange();
	}

	#clampSelectedIndex(): void {
		if (this.#items.length === 0) {
			this.#selectedIndex = 0;
			return;
		}
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#items.length - 1));
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.#items.find(i => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	/**
	 * Replace the entire items array. Selection is preserved when the prior
	 * index is still valid, otherwise clamped to the last item (or 0 if the
	 * list is now empty). An open submenu is left untouched — its lifetime
	 * is bounded by its own done callback, and `#closeSubmenu` re-clamps the
	 * restored index against the new list on the way out.
	 */
	setItems(items: SettingItem[]): void {
		this.#items = items;
		this.#clampSelectedIndex();
		this.#notifySelectionChange();
	}

	invalidate(): void {
		this.#submenuComponent?.invalidate?.();
	}

	#notifySelectionChange(): void {
		this.#onSelectionChange?.(this.#items[this.#selectedIndex]);
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.#submenuComponent) {
			return this.#submenuComponent.render(width);
		}

		return this.#renderMainList(width);
	}

	#renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.#items.length === 0) {
			lines.push(this.#theme.hint("  No settings available"));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), this.#items.length - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, this.#items.length);

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(
			30,
			Math.max(0, width - 12),
			Math.max(...this.#items.map(item => visibleWidth(item.label))),
		);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.#items[i];
			if (!item) continue;

			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? this.#theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded =
				truncateToWidth(item.label, maxLabelWidth, Ellipsis.Omit) +
				padding(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.#theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = Math.max(0, width - usedWidth - 2);

			const valueText = this.#theme.value(
				truncateToWidth(item.currentValue, valueMaxWidth, Ellipsis.Omit),
				isSelected,
			);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.#items.length) {
			const scrollText = `  (${this.#selectedIndex + 1}/${this.#items.length})`;
			lines.push(this.#theme.hint(truncateToWidth(scrollText, width - 2, Ellipsis.Omit)));
		}

		// Add description for selected item. Some hosts reserve a fixed
		// description area so keyboard navigation does not resize the TUI when
		// moving between described and undescribed rows.
		const selectedItem = this.#items[this.#selectedIndex];
		if (this.#descriptionRows > 0) {
			lines.push("");
			const wrappedDesc = selectedItem?.description ? wrapTextWithAnsi(selectedItem.description, width - 4) : [];
			for (let i = 0; i < this.#descriptionRows; i++) {
				const line = wrappedDesc[i] ?? "";
				lines.push(line ? this.#theme.description(`  ${line}`) : "");
			}
		} else if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.#theme.description(`  ${line}`));
			}
		}

		// Add hint
		lines.push("");
		lines.push(truncateToWidth(this.#theme.hint("  Enter/Space to change · Esc to cancel"), width));

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.#submenuComponent) {
			this.#submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		if (this.#items.length === 0) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.#onCancel();
			}
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#items.length - 1 : this.#selectedIndex - 1;
			this.#notifySelectionChange();
		} else if (kb.matches(data, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === this.#items.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#notifySelectionChange();
		} else if (kb.matches(data, "tui.select.confirm") || data === " " || data === "\n") {
			this.#activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.#onCancel();
		}
	}

	#activateItem(): void {
		const item = this.#items[this.#selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.#submenuItemIndex = this.#selectedIndex;
			this.#submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.#onChange(item.id, selectedValue);
				}
				this.#closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.#onChange(item.id, newValue);
		}
	}

	#closeSubmenu(): void {
		this.#submenuComponent = null;
		// Restore selection to the item that opened the submenu
		if (this.#submenuItemIndex !== null) {
			this.#selectedIndex = this.#submenuItemIndex;
			this.#clampSelectedIndex();
			this.#submenuItemIndex = null;
			this.#notifySelectionChange();
		}
	}
}
