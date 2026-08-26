/**
 * ExtensionList - Inventory list with Master Switch and fuzzy search.
 *
 * When viewing a specific provider (not "ALL"), Row #0 is the Master Switch
 * that toggles the entire provider. All items below are dimmed when the
 * master switch is off.
 */
import {
	type Component,
	extractPrintableText,
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import type { Settings } from "../../../config/settings";
import { isProviderEnabled } from "../../../discovery";
import { theme } from "../../../modes/theme/theme";
import { applyFilter } from "./state-manager";
import type { Extension, ExtensionKind, ExtensionState } from "./types";

export interface ExtensionListCallbacks {
	/** Called when selection changes */
	onSelectionChange?: (extension: Extension | null) => void;
	/** Called when extension is toggled */
	onToggle?: (extensionId: string, enabled: boolean) => void;
	/** Called when master switch is toggled */
	onMasterToggle?: (providerId: string) => void;
	/** Provider ID for master switch (null = no master switch) */
	masterSwitchProvider?: string | null;
	settings?: Settings | null;
}

const DEFAULT_MAX_VISIBLE = 15;

/** Flattened list item for rendering */
type ListItem =
	| { type: "master"; providerId: string; providerName: string; enabled: boolean }
	| { type: "kind-header"; kind: ExtensionKind; label: string; icon: string; count: number }
	| { type: "extension"; item: Extension };

export class ExtensionList implements Component {
	#listItems: ListItem[] = [];
	#selectedIndex = 0;
	#scrollOffset = 0;
	#searchQuery = "";
	#focused = false;
	#masterSwitchProvider: string | null = null;
	#maxVisible: number;
	#settings: Settings | null;

	constructor(
		private extensions: Extension[],
		private readonly callbacks: ExtensionListCallbacks = {},
		maxVisible?: number,
	) {
		this.#masterSwitchProvider = callbacks.masterSwitchProvider ?? null;
		this.#settings = callbacks.settings ?? null;
		this.#maxVisible = maxVisible ?? DEFAULT_MAX_VISIBLE;
		this.#rebuildList();
	}

	setMaxVisible(maxVisible: number): void {
		this.#maxVisible = maxVisible;
		this.#clampSelection();
	}

	setExtensions(extensions: Extension[]): void {
		this.extensions = extensions;
		this.#rebuildList();
		this.#clampSelection();
	}

	setFocused(focused: boolean): void {
		this.#focused = focused;
	}

	setMasterSwitchProvider(providerId: string | null): void {
		this.#masterSwitchProvider = providerId;
		this.#rebuildList();
	}

	getSearchQuery(): string {
		return this.#searchQuery;
	}

	resetSelection(): void {
		this.#selectedIndex = 0;
		this.#scrollOffset = 0;
		this.#notifySelectionChange();
	}

	getSelectedExtension(): Extension | null {
		const item = this.#listItems[this.#selectedIndex];
		return item?.type === "extension" ? item.item : null;
	}

	/** Get the currently selected kind header (for preview purposes) */
	getSelectedKind(): ExtensionKind | null {
		const item = this.#listItems[this.#selectedIndex];
		return item?.type === "kind-header" ? item.kind : null;
	}

	setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#rebuildList();
		this.#selectedIndex = 0;
		this.#scrollOffset = 0;
		this.#notifySelectionChange();
	}

	clearSearch(): void {
		this.setSearchQuery("");
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Search bar
		const searchPrefix = theme.fg("muted", "Search: ");
		const searchText = this.#searchQuery || (this.#focused ? "" : theme.fg("dim", "type to filter"));
		const cursor = this.#focused ? theme.fg("accent", "_") : "";
		lines.push(searchPrefix + searchText + cursor);
		lines.push("");

		if (this.#listItems.length === 0) {
			lines.push(theme.fg("muted", "  No extensions found for this provider."));
			return lines;
		}

		// Determine if master switch is off (for dimming child items)
		const masterDisabled =
			this.#masterSwitchProvider !== null &&
			!isProviderEnabled(this.#masterSwitchProvider, this.#settings ?? undefined);

		// Calculate visible range
		const startIdx = this.#scrollOffset;
		const endIdx = Math.min(startIdx + this.#maxVisible, this.#listItems.length);

		// Render visible items
		for (let i = startIdx; i < endIdx; i++) {
			const listItem = this.#listItems[i];
			const isSelected = this.#focused && i === this.#selectedIndex;

			if (listItem.type === "master") {
				lines.push(this.#renderMasterSwitch(listItem, isSelected, width));
			} else if (listItem.type === "kind-header") {
				lines.push(this.#renderKindHeader(listItem, isSelected, width));
			} else {
				lines.push(this.#renderExtensionRow(listItem.item, isSelected, width, masterDisabled));
			}
		}

		// Scroll indicator
		if (this.#listItems.length > this.#maxVisible) {
			const indicator = theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.#listItems.length})`);
			lines.push(indicator);
		}

		return lines;
	}

	#renderMasterSwitch(item: ListItem & { type: "master" }, isSelected: boolean, width: number): string {
		const checkbox = item.enabled
			? theme.fg("success", theme.checkbox.checked)
			: theme.fg("dim", theme.checkbox.unchecked);
		const icon = theme.icon.package;
		const label = `Enable ${item.providerName}`;
		const badge = theme.fg("warning", "(Master Switch)");

		let line = `${checkbox} ${icon} ${label}  ${badge}`;

		if (isSelected) {
			line = theme.bold(theme.fg("accent", line));
			line = theme.bg("selectedBg", line);
		} else if (!item.enabled) {
			line = theme.fg("dim", line);
		}

		return truncateToWidth(line, width);
	}

	#renderKindHeader(item: ListItem & { type: "kind-header" }, isSelected: boolean, width: number): string {
		const countBadge = theme.fg("muted", `(${item.count})`);
		let line = `${item.icon} ${item.label} ${countBadge}`;

		if (isSelected) {
			line = theme.bold(theme.fg("accent", line));
			line = theme.bg("selectedBg", line);
		} else {
			line = theme.fg("muted", line);
		}

		return truncateToWidth(line, width);
	}

	#renderExtensionRow(ext: Extension, isSelected: boolean, width: number, masterDisabled: boolean): string {
		// When master is disabled, all items appear dimmed
		const effectivelyDisabled = masterDisabled || ext.state === "disabled";

		// Status icon
		const stateIcon = this.#getStateIcon(ext.state, masterDisabled);

		// Name
		let name = ext.displayName;
		const nameWidth = Math.min(24, width - 16);

		// Build the line with indentation (visually "inside" the master switch)
		let line = `   ${stateIcon} `;

		if (isSelected && !masterDisabled) {
			name = theme.bold(theme.fg("accent", name));
		} else if (effectivelyDisabled) {
			name = theme.fg("dim", name);
		} else if (ext.state === "shadowed") {
			name = theme.fg("warning", name);
		}

		// Pad name
		const namePadded = this.#padText(name, nameWidth);
		line += namePadded;

		// Trigger hint
		if (ext.trigger) {
			const triggerStyle = effectivelyDisabled ? "dim" : "muted";
			const remainingWidth = width - visibleWidth(line) - 2;
			if (remainingWidth > 5) {
				line += `  ${truncateToWidth(theme.fg(triggerStyle as "dim" | "muted", ext.trigger), remainingWidth)}`;
			}
		}

		// Apply selection background
		if (isSelected) {
			line = theme.bg("selectedBg", line);
		}

		return truncateToWidth(line, width);
	}

	#getKindIcon(kind: ExtensionKind): string {
		switch (kind) {
			case "extension-module":
				return theme.icon.extensionTool;
			case "skill":
				return theme.icon.extensionSkill;
			case "tool":
				return theme.icon.extensionTool;
			case "slash-command":
				return theme.icon.extensionSlashCommand;
			case "mcp":
				return theme.icon.extensionMcp;
			case "rule":
				return theme.icon.extensionRule;
			case "hook":
				return theme.icon.extensionHook;
			case "prompt":
				return theme.icon.extensionPrompt;
			case "context-file":
				return theme.icon.extensionContextFile;
			case "instruction":
				return theme.icon.extensionInstruction;
			default:
				return theme.format.bullet;
		}
	}

	#getStateIcon(state: ExtensionState, masterDisabled: boolean): string {
		if (masterDisabled) {
			return theme.fg("dim", theme.status.disabled);
		}
		switch (state) {
			case "active":
				return theme.fg("success", theme.status.enabled);
			case "disabled":
				return theme.fg("dim", theme.status.disabled);
			case "shadowed":
				return theme.fg("warning", theme.status.shadowed);
		}
	}

	#padText(text: string, targetWidth: number): string {
		const width = visibleWidth(text);
		if (width >= targetWidth) {
			return truncateToWidth(text, targetWidth);
		}
		return text + padding(targetWidth - width);
	}

	#rebuildList(): void {
		this.#listItems = [];

		// Apply search filter
		const filtered = this.#searchQuery.length > 0 ? applyFilter(this.extensions, this.#searchQuery) : this.extensions;

		// When searching, show flat list
		if (this.#searchQuery.length > 0) {
			for (const ext of filtered) {
				this.#listItems.push({ type: "extension", item: ext });
			}
			return;
		}

		// Provider-specific view: Master switch + flat list
		if (this.#masterSwitchProvider) {
			const providerName = filtered[0]?.source.providerName ?? this.#masterSwitchProvider;
			const enabled = isProviderEnabled(this.#masterSwitchProvider, this.#settings ?? undefined);

			this.#listItems.push({
				type: "master",
				providerId: this.#masterSwitchProvider,
				providerName,
				enabled,
			});

			for (const ext of filtered) {
				this.#listItems.push({ type: "extension", item: ext });
			}
			return;
		}

		// ALL view: Group by kind with headers
		const byKind = new Map<ExtensionKind, Extension[]>();
		for (const ext of filtered) {
			const list = byKind.get(ext.kind) ?? [];
			list.push(ext);
			byKind.set(ext.kind, list);
		}

		const kindOrder: ExtensionKind[] = [
			"extension-module",
			"skill",
			"tool",
			"slash-command",
			"rule",
			"mcp",
			"hook",
			"prompt",
			"context-file",
			"instruction",
		];

		for (const kind of kindOrder) {
			const items = byKind.get(kind);
			if (!items || items.length === 0) continue;

			this.#listItems.push({
				type: "kind-header",
				kind,
				label: this.#getKindLabel(kind),
				icon: this.#getKindIcon(kind),
				count: items.length,
			});

			for (const ext of items) {
				this.#listItems.push({ type: "extension", item: ext });
			}
		}
	}

	#getKindLabel(kind: ExtensionKind): string {
		switch (kind) {
			case "extension-module":
				return "Extension Modules";
			case "skill":
				return "Skills";
			case "tool":
				return "Tools";
			case "slash-command":
				return "Commands";
			case "rule":
				return "Rules";
			case "mcp":
				return "MCP Servers";
			case "hook":
				return "Hooks";
			case "prompt":
				return "Prompts";
			case "context-file":
				return "Context";
			case "instruction":
				return "Instructions";
			default:
				return kind;
		}
	}

	#clampSelection(): void {
		if (this.#listItems.length === 0) {
			this.#selectedIndex = 0;
			this.#scrollOffset = 0;
			return;
		}

		this.#selectedIndex = Math.min(this.#selectedIndex, this.#listItems.length - 1);
		this.#selectedIndex = Math.max(0, this.#selectedIndex);

		// Adjust scroll offset
		if (this.#selectedIndex < this.#scrollOffset) {
			this.#scrollOffset = this.#selectedIndex;
		} else if (this.#selectedIndex >= this.#scrollOffset + this.#maxVisible) {
			this.#scrollOffset = this.#selectedIndex - this.#maxVisible + 1;
		}
	}

	handleInput(data: string): void {
		// Navigation
		if (matchesKey(data, "up") || data === "k") {
			this.#moveSelectionUp();
			return;
		}

		if (matchesKey(data, "down") || data === "j") {
			this.#moveSelectionDown();
			return;
		}

		// Space: Toggle selected item
		if (data === " ") {
			const item = this.#listItems[this.#selectedIndex];
			if (item?.type === "master") {
				this.callbacks.onMasterToggle?.(item.providerId);
			} else if (item?.type === "extension") {
				// Only allow toggling if master is enabled
				const masterDisabled =
					this.#masterSwitchProvider !== null &&
					!isProviderEnabled(this.#masterSwitchProvider, this.#settings ?? undefined);
				if (!masterDisabled) {
					const newEnabled = item.item.state === "disabled";
					this.callbacks.onToggle?.(item.item.id, newEnabled);
				}
			}
			return;
		}

		// Enter: Same as space - toggle selected item
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const item = this.#listItems[this.#selectedIndex];
			if (item?.type === "master") {
				this.callbacks.onMasterToggle?.(item.providerId);
			} else if (item?.type === "extension") {
				const masterDisabled =
					this.#masterSwitchProvider !== null &&
					!isProviderEnabled(this.#masterSwitchProvider, this.#settings ?? undefined);
				if (!masterDisabled) {
					const newEnabled = item.item.state === "disabled";
					this.callbacks.onToggle?.(item.item.id, newEnabled);
				}
			}
			return;
		}

		// Backspace: Delete from search query
		if (matchesKey(data, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.setSearchQuery(this.#searchQuery.slice(0, -1));
			}
			return;
		}

		// Printable characters -> search
		const printableText = extractPrintableText(data);
		if (printableText && printableText.length === 1) {
			const printableCharCode = printableText.charCodeAt(0);
			if (printableCharCode > 32 && printableCharCode < 127) {
				if (printableText === "j" || printableText === "k") {
					return;
				}
				this.setSearchQuery(this.#searchQuery + printableText);
				return;
			}
		}
	}

	#moveSelectionUp(): void {
		if (this.#selectedIndex > 0) {
			this.#selectedIndex--;
			if (this.#selectedIndex < this.#scrollOffset) {
				this.#scrollOffset = this.#selectedIndex;
			}
			this.#notifySelectionChange();
		}
	}

	#moveSelectionDown(): void {
		if (this.#selectedIndex < this.#listItems.length - 1) {
			this.#selectedIndex++;
			if (this.#selectedIndex >= this.#scrollOffset + this.#maxVisible) {
				this.#scrollOffset = this.#selectedIndex - this.#maxVisible + 1;
			}
			this.#notifySelectionChange();
		}
	}

	#notifySelectionChange(): void {
		const ext = this.getSelectedExtension();
		this.callbacks.onSelectionChange?.(ext);
	}
}
