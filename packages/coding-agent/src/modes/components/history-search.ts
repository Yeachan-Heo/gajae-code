import {
	type Component,
	Container,
	Ellipsis,
	Input,
	matchesKey,
	padding,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import { getProjectDir } from "@gajae-code/utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import type { HistoryEntry, HistoryStorage } from "../../session/history-storage";
import { DynamicBorder } from "./dynamic-border";

class HistoryResultsList implements Component {
	#results: HistoryEntry[] = [];
	#selectedIndex = 0;
	#maxVisible = 10;

	setResults(results: HistoryEntry[], selectedIndex: number): void {
		this.#results = results;
		this.#selectedIndex = selectedIndex;
	}

	setSelectedIndex(selectedIndex: number): void {
		this.#selectedIndex = selectedIndex;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.#results.length === 0) {
			lines.push(theme.fg("muted", "  No matching history"));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), this.#results.length - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, this.#results.length);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.#results[i];
			const isSelected = i === this.#selectedIndex;

			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = width - cursorWidth;

			const normalized = entry.prompt.replace(/\s+/g, " ").trim();
			const truncated = truncateToWidth(normalized, maxWidth);
			lines.push(cursor + (isSelected ? theme.bold(truncated) : truncated));
		}

		if (startIndex > 0 || endIndex < this.#results.length) {
			const scrollText = `  (${this.#selectedIndex + 1}/${this.#results.length})`;
			lines.push(theme.fg("muted", truncateToWidth(scrollText, width, Ellipsis.Omit)));
		}

		return lines;
	}
}

export class HistorySearchComponent extends Container {
	#historyStorage: HistoryStorage;
	#cwd: string;
	#searchInput: Input;
	#results: HistoryEntry[] = [];
	#selectedIndex = 0;
	#resultsList: HistoryResultsList;
	#onSelect: (prompt: string) => void;
	#onCancel: () => void;
	#resultLimit = 100;

	constructor(historyStorage: HistoryStorage, onSelect: (prompt: string) => void, onCancel: () => void) {
		super();
		this.#historyStorage = historyStorage;
		this.#cwd = getProjectDir();
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;

		this.#searchInput = new Input();
		this.#searchInput.onSubmit = () => {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#onSelect(selected.prompt);
			}
		};
		this.#searchInput.onEscape = () => {
			this.#onCancel();
		};

		this.#resultsList = new HistoryResultsList();

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Search History (Ctrl+R)"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.#resultsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "up/down navigate  enter select  esc cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#updateResults();
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "down")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#onSelect(selected.prompt);
			}
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			this.#onCancel();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#updateResults();
	}

	#updateResults(): void {
		const query = this.#searchInput.getValue().trim();
		this.#results = query
			? this.#historyStorage.search(query, this.#resultLimit, this.#cwd)
			: this.#historyStorage.getRecent(this.#resultLimit, this.#cwd);
		this.#selectedIndex = 0;
		this.#resultsList.setResults(this.#results, this.#selectedIndex);
	}
}
