import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@gajae-code/tui";
import { formatKeyHint } from "../../config/keybindings";
import type { QueuedMessageEditEntry } from "../../session/agent-session";
import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

const MAX_VISIBLE_QUEUED_MESSAGES = 8;
type QueuedMessageMoveDirection = "up" | "down";
type QueueSelectorAction = "tui.select.confirm" | "tui.select.cancel";
type QueueSelectorNavigationAction = "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown";

export type { QueuedMessageMoveDirection };

export class QueuedMessageSelectorComponent extends Container {
	#selectList: SelectList;
	#selectedEntry: QueuedMessageEditEntry | undefined;
	#selectedIndex = 0;
	#onDelete: (entry: QueuedMessageEditEntry, selectedIndex: number) => void;
	#onMove: (entry: QueuedMessageEditEntry, selectedIndex: number, direction: QueuedMessageMoveDirection) => void;
	#onSelect: (entry: QueuedMessageEditEntry) => void;
	#onCancel: () => void;
	#entries: QueuedMessageEditEntry[];
	#matchesSelectAction: (keyData: string, action: QueueSelectorAction) => boolean;
	#resolveSelectNavigation: (keyData: string) => QueueSelectorNavigationAction | undefined;
	constructor(
		entries: QueuedMessageEditEntry[],
		onSelect: (entry: QueuedMessageEditEntry) => void,
		onDelete: (entry: QueuedMessageEditEntry, selectedIndex: number) => void,
		onMove: (entry: QueuedMessageEditEntry, selectedIndex: number, direction: QueuedMessageMoveDirection) => void,
		onCancel: () => void,
		options?: {
			selectedIndex?: number;
			formatKeyHint?: (key: string) => string;
			formatSelectAction?: (action: QueueSelectorAction) => string;
			matchesSelectAction?: (keyData: string, action: QueueSelectorAction) => boolean;
			resolveSelectNavigation?: (keyData: string) => QueueSelectorNavigationAction | undefined;
		},
	) {
		super();

		this.#onDelete = onDelete;
		this.#onMove = onMove;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#entries = entries;
		this.#matchesSelectAction =
			options?.matchesSelectAction ??
			((keyData, action) => matchesKey(keyData, action === "tui.select.confirm" ? "enter" : "escape"));
		this.#resolveSelectNavigation = options?.resolveSelectNavigation ?? (() => undefined);
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		this.#selectedIndex = Math.max(0, Math.min(options?.selectedIndex ?? 0, entries.length - 1));
		this.#selectedEntry = entries[this.#selectedIndex];
		const displayKey = options?.formatKeyHint ?? formatKeyHint;
		const selectKeys = `${displayKey("alt+up")}/${displayKey("alt+down")}`;
		const editKey = options?.formatSelectAction
			? options.formatSelectAction("tui.select.confirm") || "Disabled"
			: displayKey("enter");
		const deleteKey = displayKey("delete");
		const moveKeys = `${displayKey("ctrl+up")}/${displayKey("ctrl+down")}`;
		const cancelKey = options?.formatSelectAction
			? options.formatSelectAction("tui.select.cancel") || "Disabled"
			: displayKey("escape");
		const itemHint = `${editKey} edit · ${deleteKey} remove · ${moveKeys} move`;
		const controlsHint = `${selectKeys} select · ${itemHint} · ${cancelKey} cancel`;
		const items: SelectItem[] = entries.map((entry, index) => ({
			value: entry.id,
			label: `${entry.label} ${index + 1}`,
			description: entry.text,
			hint: itemHint,
		}));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Queued messages"), 1, 0));
		this.addChild(new Text(theme.fg("muted", controlsHint), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#selectList = new SelectList(items, MAX_VISIBLE_QUEUED_MESSAGES, getSelectListTheme());
		this.#selectList.onSelect = item => {
			const entry = byId.get(item.value);
			if (entry) onSelect(entry);
		};
		this.#selectList.onSelectionChange = item => {
			const index = entries.findIndex(entry => entry.id === item.value);
			this.#selectedIndex = index === -1 ? this.#selectedIndex : index;
			this.#selectedEntry = byId.get(item.value);
		};
		this.#selectList.setSelectedIndex(this.#selectedIndex);
		this.#selectList.onCancel = onCancel;

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (this.#matchesSelectAction(keyData, "tui.select.confirm")) {
			if (this.#selectedEntry) this.#onSelect(this.#selectedEntry);
			return;
		}
		if (this.#matchesSelectAction(keyData, "tui.select.cancel")) {
			this.#onCancel();
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

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
