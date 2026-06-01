import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Effort } from "@gajae-code/ai";
import {
	Container,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	type Tab,
	TabBar,
	Text,
} from "@gajae-code/tui";
import { type SettingPath, settings } from "../../config/settings";
import type {
	SettingTab,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
} from "../../config/settings-schema";
import { SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import { getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { getSettingsForTab, type SettingDef } from "./settings-defs";
import { getPreset } from "./status-line/presets";

/**
 * A submenu component for selecting from a list of options.
 */
/**
 * Submenu component for free-text string settings.
 * Mirrors the ConfigInputSubmenu pattern from plugin-settings.ts.
 */
class TextInputSubmenu extends Container {
	#input: Input;

	constructor(
		label: string,
		description: string,
		currentValue: string,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", label)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.#input = new Input();
		if (currentValue) {
			this.#input.setValue(currentValue);
			// Move cursor to end of pre-filled value (ctrl+e = cursorLineEnd).
			this.#input.handleInput("\x05");
		}
		this.#input.onSubmit = value => {
			this.onSubmit(value); // empty string clears the setting
		};
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel · Clear field to unset"), 0, 0));
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

class SelectSubmenu extends Container {
	#selectList: SelectList;
	#previewText: Text | null = null;
	#previewUpdateRequestId: number = 0;

	constructor(
		title: string,
		description: string,
		options: ReadonlyArray<SelectItem>,
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void | Promise<void>,
		private readonly getPreview?: () => string,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Preview (if provided)
		if (getPreview) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
			this.#previewText = new Text(getPreview(), 0, 0);
			this.addChild(this.#previewText);
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());

		// Pre-select current value
		const currentIndex = options.findIndex(o => o.value === currentValue);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value);
		};

		this.#selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.#selectList.onSelectionChange = item => {
				const requestId = ++this.#previewUpdateRequestId;
				const result = onSelectionChange(item.value);
				if (result && typeof (result as Promise<void>).then === "function") {
					void (result as Promise<void>).finally(() => {
						if (requestId === this.#previewUpdateRequestId) {
							this.#updatePreview();
						}
					});
					return;
				}
				if (requestId === this.#previewUpdateRequestId) {
					this.#updatePreview();
				}
			};
		}

		this.addChild(this.#selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	#updatePreview(): void {
		if (this.#previewText && this.getPreview) {
			this.#previewText.setText(this.getPreview());
		}
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

function getSettingsTabs(): Tab[] {
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			return { id, label: `${icon} ${meta.label}` };
		}),
		{ id: "plugins", label: `${theme.icon.package} Plugins` },
	];
}

/**
 * Dynamic context for settings that need runtime data.
 * Some settings (like thinking level) are managed by the session, not Settings.
 */
export interface SettingsRuntimeContext {
	/** Available thinking levels (from session) */
	availableThinkingLevels: Effort[];
	/** Current thinking level (from session) */
	thinkingLevel: ThinkingLevel | undefined;
	/** Available themes */
	availableThemes: string[];
	/** Working directory for plugins tab */
	cwd: string;
}

/** Status line settings subset for preview */
export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	sessionAccent?: boolean;
}

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: (path: SettingPath, newValue: unknown) => void;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: () => string;
	/** Called when plugins change */
	onPluginsChanged?: () => void;
	/** Called when settings panel is closed */
	onCancel: () => void;
}

/**
 * Main tabbed settings selector component.
 * Uses declarative settings definitions from settings-defs.ts.
 */
export class SettingsSelectorComponent extends Container {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#currentSubmenu: Container | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#statusPreviewContainer: Container | null = null;
	#statusPreviewText: Text | null = null;
	#currentTabId: SettingTab | "plugins" = "appearance";
	#textInputActive = false;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
	) {
		super();

		// Add top border
		this.addChild(new DynamicBorder());

		// Tab bar
		this.#tabBar = new TabBar("Settings", getSettingsTabs(), getTabBarTheme());
		this.#tabBar.onTabChange = () => {
			this.#switchToTab(this.#tabBar.getActiveTab().id as SettingTab | "plugins");
		};
		this.addChild(this.#tabBar);

		// Spacer after tab bar
		this.addChild(new Spacer(1));

		// Initialize with first tab
		this.#switchToTab("appearance");

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	#switchToTab(tabId: SettingTab | "plugins"): void {
		this.#currentTabId = tabId;

		// Remove current content
		if (this.#currentList) {
			this.removeChild(this.#currentList);
			this.#currentList = null;
		}
		if (this.#pluginComponent) {
			this.removeChild(this.#pluginComponent);
			this.#pluginComponent = null;
		}
		if (this.#statusPreviewContainer) {
			this.removeChild(this.#statusPreviewContainer);
			this.#statusPreviewContainer = null;
			this.#statusPreviewText = null;
		}

		// Remove bottom border temporarily
		const bottomBorder = this.children[this.children.length - 1];
		this.removeChild(bottomBorder);

		if (tabId === "plugins") {
			this.#showPluginsTab();
		} else {
			this.#showSettingsTab(tabId);
		}

		// Re-add bottom border
		this.addChild(bottomBorder);
	}

	/**
	 * Convert a setting definition to a SettingItem for the UI.
	 */
	#defToItem(def: SettingDef): SettingItem | null {
		// Check condition: applies to every variant — booleans, enums, submenus, text inputs.
		if (def.condition && !def.condition()) {
			return null;
		}

		const currentValue = this.#getCurrentValue(def);

		switch (def.type) {
			case "boolean":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: currentValue ? "true" : "false",
					values: ["true", "false"],
				};

			case "enum":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: currentValue as string,
					values: [...def.values],
				};

			case "submenu":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#getSubmenuCurrentValue(def.path, currentValue),
					submenu: (cv, done) => this.#createSubmenu(def, cv, done),
				};

			case "text":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: (currentValue as string) ?? "",
					submenu: (cv, done) => this.#createTextInput(def, cv, done),
				};
		}
	}

	/**
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		return settings.get(def.path);
	}

	#getSubmenuCurrentValue(path: SettingPath, value: unknown): string {
		const rawValue = String(value ?? "");
		if (path === "compaction.thresholdPercent" && (rawValue === "-1" || rawValue === "")) {
			return "default";
		}
		if (path === "compaction.thresholdTokens" && (rawValue === "-1" || rawValue === "")) {
			return "default";
		}
		return rawValue;
	}

	/**
	 * Create a submenu for a submenu-type setting.
	 */
	#createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		let options = def.options;

		// Special case: inject runtime options for thinking level
		if (def.path === "defaultThinkingLevel") {
			options = this.context.availableThinkingLevels.map(level => {
				const baseOpt = options.find(o => o.value === level);
				return baseOpt || { value: level, label: level };
			});
		} else if (def.path === "theme.dark" || def.path === "theme.light") {
			options = this.context.availableThemes.map(t => ({ value: t, label: t }));
		}

		// Preview handlers
		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;

		// Theme selection is confirm-only: moving through the list must not mutate
		// the rendered theme while the displayed/persisted setting still names
		// the previous value. Confirmation persists through Settings hooks.
		if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(
					value as "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom",
				);
				this.callbacks.onStatusLinePreview?.({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
				this.#updateStatusPreview();
			};
			onPreviewCancel = () => {
				const currentPreset = settings.get("statusLine.preset");
				const presetDef = getPreset(currentPreset);
				this.callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
				this.#updateStatusPreview();
			};
		} else if (def.path === "statusLine.separator") {
			onPreview = value => {
				this.callbacks.onStatusLinePreview?.({ separator: value as StatusLineSeparatorStyle });
				this.#updateStatusPreview();
			};
			onPreviewCancel = () => {
				const separator = settings.get("statusLine.separator");
				this.callbacks.onStatusLinePreview?.({ separator });
				this.#updateStatusPreview();
			};
		}

		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			def.label,
			def.description,
			options,
			currentValue,
			value => {
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, value);
				done(value);
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
		);
	}

	/**
	 * Create a text input submenu for a plain string setting.
	 */
	#createTextInput(
		def: SettingDef & { type: "text" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		this.#textInputActive = true;
		const wrappedDone = (value?: string) => {
			this.#textInputActive = false;
			done(value);
		};
		return new TextInputSubmenu(
			def.label,
			def.description,
			currentValue,
			value => {
				// Empty string clears the setting; undefined-typed string settings
				// store "" which the browser.ts expandPath ignores (no-op fallback).
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, value);
				wrappedDone(value);
			},
			() => wrappedDone(),
		);
	}

	/**
	 * Set a setting value, handling type conversion.
	 */
	#setSettingValue(path: SettingPath, value: string): void {
		// Handle number conversions
		const currentValue = settings.get(path);
		if (path === "compaction.thresholdPercent" && value === "default") {
			settings.set(path, -1 as never);
		} else if (path === "compaction.thresholdTokens" && value === "default") {
			settings.set(path, -1 as never);
		} else if (typeof currentValue === "number") {
			settings.set(path, Number(value) as never);
		} else if (typeof currentValue === "boolean") {
			settings.set(path, (value === "true") as never);
		} else {
			settings.set(path, value as never);
		}
	}

	/**
	 * Show a settings tab using definitions.
	 */
	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(tabId);

		// Add status line preview for appearance tab
		if (tabId === "appearance") {
			this.#statusPreviewContainer = new Container();
			this.#statusPreviewContainer.addChild(new Spacer(1));
			this.#statusPreviewContainer.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
			this.#statusPreviewText = new Text(this.#getStatusPreviewString(), 0, 0);
			this.#statusPreviewContainer.addChild(this.#statusPreviewText);
			this.#statusPreviewContainer.addChild(new Spacer(1));
			this.addChild(this.#statusPreviewContainer);
		}

		this.#currentList = new SettingsList(
			this.#buildItemsForDefs(defs),
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const def = defs.find(d => d.path === id);
				if (!def) return;

				const path = def.path;

				if (def.type === "boolean") {
					const boolValue = newValue === "true";
					settings.set(path, boolValue as never);
					this.callbacks.onChange(path, boolValue);

					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					settings.set(path, newValue as never);
					this.callbacks.onChange(path, newValue);
				}
				// Submenu/text types already persisted the value inside their own
				// done callbacks before SettingsList re-dispatches here. Re-run the
				// definition-to-item mapping so condition-gated settings (e.g. the
				// Hindsight cluster guarded by memory.backend) appear/disappear
				// immediately instead of waiting for the next tab switch.
				this.#refreshCurrentTabItems(defs);
			},
			() => this.callbacks.onCancel(),
		);

		this.addChild(this.#currentList);
	}

	/** Map a definition list to UI items, dropping any whose condition is false. */
	#buildItemsForDefs(defs: SettingDef[]): SettingItem[] {
		const items: SettingItem[] = [];
		for (const def of defs) {
			const item = this.#defToItem(def);
			if (item) items.push(item);
		}
		return items;
	}

	/** Re-evaluate condition gates against the current settings and refresh the active list. */
	#refreshCurrentTabItems(defs: SettingDef[]): void {
		if (this.#currentTabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForDefs(defs));
	}

	/**
	 * Get the status line preview string.
	 */
	#getStatusPreviewString(): string {
		if (this.callbacks.getStatusLinePreview) {
			return this.callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", "(preview not available)");
	}

	/**
	 * Trigger status line preview with current settings.
	 */
	#triggerStatusLinePreview(): void {
		const statusLineSettings: StatusLinePreviewSettings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
		};
		this.callbacks.onStatusLinePreview?.(statusLineSettings);
		this.#updateStatusPreview();
	}

	/**
	 * Update the inline status preview text.
	 */
	#updateStatusPreview(): void {
		if (this.#statusPreviewText && this.#currentTabId === "appearance") {
			this.#statusPreviewText.setText(this.#getStatusPreviewString());
		}
	}

	#showPluginsTab(): void {
		this.#pluginComponent = new PluginSettingsComponent(this.context.cwd, {
			onClose: () => this.callbacks.onCancel(),
			onPluginChanged: () => this.callbacks.onPluginsChanged?.(),
		});
		this.addChild(this.#pluginComponent);
	}

	getFocusComponent(): SettingsList | PluginSettingsComponent {
		// Return the current focusable component - one of these will always be set
		return (this.#currentList || this.#pluginComponent)!;
	}

	handleInput(data: string): void {
		// Handle tab switching — but NOT when a text input is active, since
		// arrow keys must reach the cursor and Tab must not switch tabs.
		if (
			!this.#textInputActive &&
			(matchesKey(data, "tab") ||
				matchesKey(data, "shift+tab") ||
				matchesKey(data, "left") ||
				matchesKey(data, "right"))
		) {
			this.#tabBar.handleInput(data);
			return;
		}

		// Escape at top level cancels
		if (matchesAppInterrupt(data) && !this.#currentSubmenu) {
			this.callbacks.onCancel();
			return;
		}

		// Pass to current content
		if (this.#currentList) {
			this.#currentList.handleInput(data);
		} else if (this.#pluginComponent) {
			this.#pluginComponent.handleInput(data);
		}
	}
}
