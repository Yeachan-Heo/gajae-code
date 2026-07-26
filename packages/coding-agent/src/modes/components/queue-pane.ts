import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@gajae-code/tui";
import { formatKeyHint } from "../../config/keybindings";
import type { QueuedMessageEditEntry } from "../../session/agent-session";
import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

const MAX_VISIBLE_QUEUE_MESSAGES = 8;
type QueueSelectorAction = "tui.select.confirm" | "tui.select.cancel";
type QueueSelectorNavigationAction = "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown";

export class QueuePaneComponent extends Container {
	#selectList: SelectList;
	#selectedEntry: QueuedMessageEditEntry | undefined;
	#selectedIndex: number;
	#onDelete: (entry: QueuedMessageEditEntry, index: number) => void;
	#onMove: (entry: QueuedMessageEditEntry, index: number, direction: "up" | "down") => void;
	#onSelect: (entry: QueuedMessageEditEntry) => void;
	#onClose: () => void;
	#entries: QueuedMessageEditEntry[];
	#matchesSelectAction: (keyData: string, action: QueueSelectorAction) => boolean;
	#resolveSelectNavigation: (keyData: string) => QueueSelectorNavigationAction | undefined;
	constructor(
		entries: QueuedMessageEditEntry[],
		options: {
			selectedIndex?: number;
			formatKeyHint?: (key: string) => string;
			formatSelectAction?: (action: QueueSelectorAction) => string;
			matchesSelectAction?: (keyData: string, action: QueueSelectorAction) => boolean;
			resolveSelectNavigation?: (keyData: string) => QueueSelectorNavigationAction | undefined;
			onSelect: (entry: QueuedMessageEditEntry) => void;
			onDelete: (entry: QueuedMessageEditEntry, index: number) => void;
			onMove: (entry: QueuedMessageEditEntry, index: number, direction: "up" | "down") => void;
			onClose: () => void;
		},
	) {
		super();
		this.#onDelete = options.onDelete;
		this.#onSelect = options.onSelect;
		this.#onMove = options.onMove;
		this.#onClose = options.onClose;
		this.#entries = entries;
		this.#matchesSelectAction =
			options.matchesSelectAction ??
			((keyData, action) => matchesKey(keyData, action === "tui.select.confirm" ? "enter" : "escape"));
		this.#resolveSelectNavigation = options.resolveSelectNavigation ?? (() => undefined);
		this.#selectedIndex = Math.max(0, Math.min(options.selectedIndex ?? 0, entries.length - 1));
		this.#selectedEntry = entries[this.#selectedIndex];
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		const displayKey = options.formatKeyHint ?? formatKeyHint;
		const selectKeys = `${displayKey("alt+up")}/${displayKey("alt+down")}`;
		const editKey = options.formatSelectAction
			? options.formatSelectAction("tui.select.confirm") || "Disabled"
			: displayKey("enter");
		const deleteKey = displayKey("delete");
		const moveKeys = `${displayKey("ctrl+up")}/${displayKey("ctrl+down")}`;
		const closeKey = options.formatSelectAction
			? options.formatSelectAction("tui.select.cancel") || "Disabled"
			: displayKey("escape");
		const itemHint = `${editKey} edit · ${deleteKey} remove · ${moveKeys} move`;
		const controlsHint = `${selectKeys} select · ${itemHint} · ${closeKey} close`;
		const items: SelectItem[] = entries.map((entry, index) => ({
			value: entry.id,
			label: `${entry.label} ${index + 1}`,
			description: entry.text,
			hint: itemHint,
		}));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Message queue"), 1, 0));
		this.addChild(new Text(theme.fg("muted", controlsHint), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, MAX_VISIBLE_QUEUE_MESSAGES, getSelectListTheme());
		this.#selectList.onSelect = item => {
			const entry = byId.get(item.value);
			if (entry) this.#onSelect(entry);
		};
		this.#selectList.onSelectionChange = item => {
			const index = entries.findIndex(entry => entry.id === item.value);
			this.#selectedIndex = index === -1 ? this.#selectedIndex : index;
			this.#selectedEntry = byId.get(item.value);
		};
		this.#selectList.setSelectedIndex(this.#selectedIndex);
		this.#selectList.onCancel = options.onClose;
		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (this.#matchesSelectAction(keyData, "tui.select.confirm")) {
			if (this.#selectedEntry) this.#onSelect(this.#selectedEntry);
			return;
		}
		if (this.#matchesSelectAction(keyData, "tui.select.cancel")) {
			this.#onClose();
			return;
		}
		const navigation = this.#resolveSelectNavigation(keyData);
		if (navigation) {
			this.#selectList.handleNavigation(navigation);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "escape")) return;
		if (matchesKey(keyData, "alt+up") || matchesKey(keyData, "alt+down")) {
			const direction = matchesKey(keyData, "alt+up") ? -1 : 1;
			this.#selectedIndex = (this.#selectedIndex + direction + this.#entries.length) % this.#entries.length;
			this.#selectedEntry = this.#entries[this.#selectedIndex];
			this.#selectList.setSelectedIndex(this.#selectedIndex);
			return;
		}
		if (matchesKey(keyData, "ctrl+up") || matchesKey(keyData, "ctrl+shift+up")) {
			if (this.#selectedEntry) this.#onMove(this.#selectedEntry, this.#selectedIndex, "up");
			return;
		}
		if (matchesKey(keyData, "ctrl+down") || matchesKey(keyData, "ctrl+shift+down")) {
			if (this.#selectedEntry) this.#onMove(this.#selectedEntry, this.#selectedIndex, "down");
			return;
		}
		if (matchesKey(keyData, "delete")) {
			if (this.#selectedEntry) this.#onDelete(this.#selectedEntry, this.#selectedIndex);
			return;
		}
		this.#selectList.handleInput(keyData);
	}
}
