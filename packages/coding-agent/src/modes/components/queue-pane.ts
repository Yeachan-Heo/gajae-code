import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@gajae-code/tui";
import type { QueuedMessageEditEntry } from "../../session/agent-session";
import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

const MAX_VISIBLE_QUEUE_MESSAGES = 8;
const RAW_UP = "\x1b[A";
const RAW_DOWN = "\x1b[B";

export class QueuePaneComponent extends Container {
	#selectList: SelectList;
	#selectedEntry: QueuedMessageEditEntry | undefined;
	#selectedIndex: number;
	#onDelete: (entry: QueuedMessageEditEntry, index: number) => void;
	#onMove: (entry: QueuedMessageEditEntry, index: number, direction: "up" | "down") => void;

	constructor(
		entries: QueuedMessageEditEntry[],
		options: {
			selectedIndex?: number;
			onDelete: (entry: QueuedMessageEditEntry, index: number) => void;
			onMove: (entry: QueuedMessageEditEntry, index: number, direction: "up" | "down") => void;
			onClose: () => void;
		},
	) {
		super();
		this.#onDelete = options.onDelete;
		this.#onMove = options.onMove;
		this.#selectedIndex = Math.max(0, Math.min(options.selectedIndex ?? 0, entries.length - 1));
		this.#selectedEntry = entries[this.#selectedIndex];
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		const items: SelectItem[] = entries.map((entry, index) => ({
			value: entry.id,
			label: `${entry.label} ${index + 1}`,
			description: entry.text,
			hint: "Del remove · Ctrl+↑/↓ move",
		}));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Message queue"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Del remove · Ctrl+↑/↓ move · Esc close"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, MAX_VISIBLE_QUEUE_MESSAGES, getSelectListTheme());
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
		if (matchesKey(keyData, "alt+up")) {
			this.#selectList.handleInput(RAW_UP);
			return;
		}
		if (matchesKey(keyData, "alt+down")) {
			this.#selectList.handleInput(RAW_DOWN);
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
