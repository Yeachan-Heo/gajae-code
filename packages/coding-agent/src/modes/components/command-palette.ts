import {
	type Component,
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import { sanitizeStatusText } from "../shared";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface CommandPaletteAction {
	id: string;
	label: string;
	handler: () => void | Promise<void>;
}

export interface CommandPaletteEntry {
	id: string;
	label: string;
	description?: string;
	category?: string;
	keybinding?: string;
	bindingHint?: string;
	searchText?: string;
	handler?: () => void | Promise<void>;
	disabled?: boolean;
}

function sanitizePaletteText(text: string): string {
	return sanitizeStatusText(text.toWellFormed());
}

function isSafePaletteEntryId(id: string): boolean {
	return id.length > 0 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(id);
}

class CommandPaletteList implements Component {
	#entries: CommandPaletteEntry[];
	#filteredEntries: CommandPaletteEntry[];
	#selectedIndex = 0;
	readonly #searchInput = new Input();
	onSelect?: (entry: CommandPaletteEntry) => void;
	onCancel?: () => void;

	constructor(entries: CommandPaletteEntry[]) {
		this.#entries = entries.map(entry => ({
			...entry,
			label: sanitizePaletteText(entry.label),
			description: sanitizePaletteText(entry.description ?? entry.category ?? ""),
			category: entry.category === undefined ? undefined : sanitizePaletteText(entry.category),
			keybinding:
				entry.keybinding === undefined && entry.bindingHint === undefined
					? undefined
					: sanitizePaletteText(entry.keybinding ?? entry.bindingHint ?? ""),
			bindingHint: entry.bindingHint === undefined ? undefined : sanitizePaletteText(entry.bindingHint),
			searchText: entry.searchText === undefined ? undefined : sanitizePaletteText(entry.searchText),
		}));
		this.#filteredEntries = this.#entries;
	}

	#filter(query: string): void {
		this.#filteredEntries = fuzzyFilter(this.#entries, query, entry =>
			[entry.label, entry.description, entry.keybinding ?? "", entry.searchText ?? ""].join(" "),
		);
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#filteredEntries.length - 1));
	}

	invalidate(): void {}

	getEntries(): readonly CommandPaletteEntry[] {
		return this.#filteredEntries;
	}

	render(width: number): string[] {
		const lines = [theme.fg("muted", "  Search commands"), ...this.#searchInput.render(width), ""];
		if (this.#filteredEntries.length === 0) {
			lines.push(theme.fg("muted", "  No matching commands"));
			return lines;
		}

		const maxVisible = 8;
		const start = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredEntries.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.#filteredEntries.length);
		for (let index = start; index < end; index += 1) {
			const entry = this.#filteredEntries[index];
			if (!entry) continue;
			const selected = index === this.#selectedIndex;
			const cursor = `${theme.nav.cursor} `;
			const prefix = selected ? theme.fg("accent", cursor) : padding(visibleWidth(cursor));
			const keybinding = entry.keybinding ? theme.fg("muted", entry.keybinding) : "";
			const availableLabelWidth = Math.max(
				1,
				width - visibleWidth(prefix) - visibleWidth(keybinding) - (keybinding ? 1 : 0),
			);
			const label = truncateToWidth(entry.label, availableLabelWidth);
			const labelPadding = padding(Math.max(0, availableLabelWidth - visibleWidth(label)));
			const renderedLabel = selected ? theme.bold(label) : label;
			lines.push(
				entry.disabled
					? theme.fg("muted", prefix + renderedLabel + labelPadding + (keybinding ? ` ${keybinding}` : ""))
					: prefix + renderedLabel + labelPadding + (keybinding ? ` ${keybinding}` : ""),
			);
			lines.push(theme.fg("dim", truncateToWidth(`  ${entry.description ?? ""}`, width)));
		}
		if (start > 0 || end < this.#filteredEntries.length) {
			lines.push(theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.#filteredEntries.length})`));
		}
		lines.push("", theme.fg("muted", "  [Enter to run, Esc to close]"));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "up")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.#selectedIndex = Math.min(this.#filteredEntries.length - 1, this.#selectedIndex + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const entry = this.#filteredEntries[this.#selectedIndex];
			if (entry && !entry.disabled && isSafePaletteEntryId(entry.id)) this.onSelect?.(entry);
			return;
		}
		this.#searchInput.handleInput(data);
		this.#filter(this.#searchInput.getValue());
	}
}

export class CommandPaletteComponent extends Container {
	#list: CommandPaletteList;

	constructor(entries: CommandPaletteEntry[], onSelect: (entry: CommandPaletteEntry) => void, onCancel: () => void) {
		super();
		this.addChild(new DynamicBorder());
		this.#list = new CommandPaletteList(entries);
		this.#list.onSelect = onSelect;
		this.#list.onCancel = onCancel;
		this.addChild(this.#list);
		this.addChild(new DynamicBorder());
	}

	override render(width: number): string[] {
		return super.render(width).map(line => truncateToWidth(line, width));
	}
	handleInput(data: string): void {
		this.#list.handleInput(data);
	}

	getEntries(): readonly CommandPaletteEntry[] {
		return this.#list.getEntries();
	}
}

/** Backward-compatible name retained for extensions and existing call sites. */
export class CommandPalette extends CommandPaletteComponent {}
