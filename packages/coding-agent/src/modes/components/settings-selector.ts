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
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { getSettingsForTab, type SettingDef } from "./settings-defs";
import type { StatusLineSegmentOptions } from "./status-line";
import { getPreset } from "./status-line/presets";
import { ALL_SEGMENT_IDS } from "./status-line/segments";

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
const STATUS_LINE_CUSTOM_EDITOR_ID = "statusLine.customEditor";
const STATUS_LINE_USAGE_MODE_ID = "statusLine.usageMode";
const PUBLIC_STATUS_SEGMENTS = ALL_SEGMENT_IDS.filter(id => id !== "pi");

type StatusLineDraft = Required<
	Pick<StatusLinePreviewSettings, "preset" | "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
>;

const BOOL_VALUES = ["true", "false"];
const PATH_LENGTH_OPTIONS: SelectItem[] = [16, 24, 32, 40, 50, 60, 80].map(value => ({
	value: String(value),
	label: String(value),
}));
const TIME_FORMAT_OPTIONS: SelectItem[] = [
	{ value: "24h", label: "24h" },
	{ value: "12h", label: "12h" },
];
const USAGE_MODE_OPTIONS: SelectItem[] = [
	{ value: "used", label: "Used" },
	{ value: "remaining", label: "Remaining" },
];
const USAGE_MODE_VALUES = ["used", "remaining"] as const;
type UsageMode = (typeof USAGE_MODE_VALUES)[number];

function cloneSegmentOptions(options: StatusLineSegmentOptions | undefined): StatusLineSegmentOptions {
	return mergeSegmentOptions(undefined, options);
}

function mergeSegmentOptions(
	base: StatusLineSegmentOptions | undefined,
	overrides: StatusLineSegmentOptions | undefined,
): StatusLineSegmentOptions {
	return {
		model: base?.model || overrides?.model ? { ...(base?.model ?? {}), ...(overrides?.model ?? {}) } : undefined,
		path: base?.path || overrides?.path ? { ...(base?.path ?? {}), ...(overrides?.path ?? {}) } : undefined,
		git: base?.git || overrides?.git ? { ...(base?.git ?? {}), ...(overrides?.git ?? {}) } : undefined,
		time: base?.time || overrides?.time ? { ...(base?.time ?? {}), ...(overrides?.time ?? {}) } : undefined,
		usage: base?.usage || overrides?.usage ? { ...(base?.usage ?? {}), ...(overrides?.usage ?? {}) } : undefined,
	};
}

function effectiveSegmentOptions(
	preset: StatusLinePreset,
	options: StatusLineSegmentOptions | undefined,
): StatusLineSegmentOptions {
	return mergeSegmentOptions(getPreset(preset).segmentOptions, options);
}

function effectiveCustomSegments(
	preset: StatusLinePreset,
	leftSegments: StatusLineSegmentId[],
	rightSegments: StatusLineSegmentId[],
): { leftSegments: StatusLineSegmentId[]; rightSegments: StatusLineSegmentId[] } {
	if (preset === "custom") {
		return { leftSegments: [...leftSegments], rightSegments: [...rightSegments] };
	}
	const presetDef = getPreset(preset);
	return {
		leftSegments: [...presetDef.leftSegments],
		rightSegments: [...presetDef.rightSegments],
	};
}

function getSavedUsageMode(): UsageMode {
	const segmentOptions = settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions;
	return segmentOptions.usage?.mode === "remaining" ? "remaining" : "used";
}

function setSavedUsageMode(mode: string): StatusLineSegmentOptions {
	const normalizedMode: UsageMode = mode === "remaining" ? "remaining" : "used";
	const segmentOptions = settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions;
	const nextOptions: StatusLineSegmentOptions = {
		...segmentOptions,
		usage: {
			...(segmentOptions.usage ?? {}),
			mode: normalizedMode,
		},
	};
	settings.set("statusLine.segmentOptions", nextOptions as Record<string, unknown>);
	return nextOptions;
}

function statusSegmentLabel(id: StatusLineSegmentId): string {
	return id.replace(/_/g, " ");
}

function segmentPlacement(
	id: StatusLineSegmentId,
	leftSegments: StatusLineSegmentId[],
	rightSegments: StatusLineSegmentId[],
): "hidden" | "left" | "right" {
	if (leftSegments.includes(id)) return "left";
	if (rightSegments.includes(id)) return "right";
	return "hidden";
}

class StatusLineCustomEditor extends Container {
	#list!: SettingsList;
	#draft: StatusLineDraft;
	#previewHighlightSegment: StatusLineSegmentId | undefined;

	constructor(
		private readonly callbacks: SettingsCallbacks,
		private readonly done: (value?: string) => void,
	) {
		super();
		const preset = settings.get("statusLine.preset");
		const seeded = effectiveCustomSegments(
			preset,
			settings.get("statusLine.leftSegments"),
			settings.get("statusLine.rightSegments"),
		);
		this.#draft = {
			preset: "custom",
			leftSegments: seeded.leftSegments,
			rightSegments: seeded.rightSegments,
			separator: settings.get("statusLine.separator"),
			segmentOptions: effectiveSegmentOptions(
				preset,
				settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions,
			),
		};
		this.#preview();
		this.#build();
	}

	#build(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Status Line Custom Editor")), 0, 0));
		this.addChild(new Spacer(1));
		this.#list = new SettingsList(
			this.#items(),
			14,
			getSettingsListTheme(),
			(id, value) => this.#handleChange(id, value),
			() => this.#cancel(),
			item => this.#setSelectedItem(item),
			2,
		);
		this.addChild(this.#list);
	}

	#refresh(): void {
		this.#list.setItems(this.#items());
	}
	#setSelectedItem(item: SettingItem | undefined): void {
		this.#previewHighlightSegment = this.#highlightSegmentForItem(item);
		this.#preview();
	}

	#highlightSegmentForItem(item: SettingItem | undefined): StatusLineSegmentId | undefined {
		if (!item) return undefined;
		if (item.id.startsWith("segment.")) {
			return item.id.slice("segment.".length) as StatusLineSegmentId;
		}
		if (item.id.startsWith("moveup.")) {
			return item.id.slice("moveup.".length) as StatusLineSegmentId;
		}
		if (item.id.startsWith("movedown.")) {
			return item.id.slice("movedown.".length) as StatusLineSegmentId;
		}
		if (item.id.startsWith("option.")) {
			const [segment] = item.id.slice("option.".length).split(".");
			return segment as StatusLineSegmentId;
		}
		return undefined;
	}

	#items(): SettingItem[] {
		const items: SettingItem[] = [
			{
				id: "action.save",
				label: "Save custom status line",
				description: "Persist the previewed custom status line to user config.",
				currentValue: "approve",
				values: ["approve"],
			},
			{
				id: "action.cancel",
				label: "Cancel and restore",
				description: "Close without persisting draft settings and restore the previous preview.",
				currentValue: "restore",
				values: ["restore"],
			},
			{
				id: "separator",
				label: "Separator",
				description: "Separator style between status line segments.",
				currentValue: this.#draft.separator,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Status Line Separator",
						"Style of separators between segments.",
						[
							{ value: "powerline", label: "Powerline" },
							{ value: "powerline-thin", label: "Thin chevron" },
							{ value: "slash", label: "Slash" },
							{ value: "pipe", label: "Pipe" },
							{ value: "block", label: "Block" },
							{ value: "none", label: "None" },
							{ value: "ascii", label: "ASCII" },
						],
						currentValue,
						done,
						() => done(),
					),
			},
		];

		for (const id of PUBLIC_STATUS_SEGMENTS) {
			items.push({
				id: `segment.${id}`,
				label: `Segment: ${statusSegmentLabel(id)}`,
				description: "Cycle placement: hidden → left → right. Use move actions below to reorder visible segments.",
				currentValue: segmentPlacement(id, this.#draft.leftSegments, this.#draft.rightSegments),
				values: ["hidden", "left", "right"],
			});
			if (segmentPlacement(id, this.#draft.leftSegments, this.#draft.rightSegments) !== "hidden") {
				items.push(
					{
						id: `moveup.${id}`,
						label: `Move left: ${statusSegmentLabel(id)}`,
						currentValue: "←",
						values: ["←"],
					},
					{
						id: `movedown.${id}`,
						label: `Move right: ${statusSegmentLabel(id)}`,
						currentValue: "→",
						values: ["→"],
					},
				);
			}
			if (id === "usage") {
				items.push({
					id: "option.usage.mode",
					label: "Usage: mode",
					currentValue: this.#draft.segmentOptions.usage?.mode ?? "used",
					submenu: (currentValue, done) =>
						new SelectSubmenu(
							"Usage mode",
							"Show used quota or remaining quota in the usage segment.",
							USAGE_MODE_OPTIONS,
							currentValue,
							done,
							() => done(),
						),
				});
			}
		}

		items.push(
			{
				id: "option.model.showThinkingLevel",
				label: "Model: show thinking level",
				currentValue: String(this.#draft.segmentOptions.model?.showThinkingLevel !== false),
				values: BOOL_VALUES,
			},
			{
				id: "option.path.abbreviate",
				label: "Path: abbreviate",
				currentValue: String(this.#draft.segmentOptions.path?.abbreviate !== false),
				values: BOOL_VALUES,
			},
			{
				id: "option.path.maxLength",
				label: "Path: max length",
				currentValue: String(this.#draft.segmentOptions.path?.maxLength ?? 32),
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Path max length",
						"Maximum displayed path length.",
						PATH_LENGTH_OPTIONS,
						currentValue,
						done,
						() => done(),
					),
			},
			{
				id: "option.path.stripWorkPrefix",
				label: "Path: strip work prefix",
				currentValue: String(this.#draft.segmentOptions.path?.stripWorkPrefix === true),
				values: BOOL_VALUES,
			},
			{
				id: "option.git.showBranch",
				label: "Git: show branch",
				currentValue: String(this.#draft.segmentOptions.git?.showBranch !== false),
				values: BOOL_VALUES,
			},
			{
				id: "option.git.showStaged",
				label: "Git: show staged",
				currentValue: String(this.#draft.segmentOptions.git?.showStaged !== false),
				values: BOOL_VALUES,
			},
			{
				id: "option.git.showUnstaged",
				label: "Git: show unstaged",
				currentValue: String(this.#draft.segmentOptions.git?.showUnstaged !== false),
				values: BOOL_VALUES,
			},
			{
				id: "option.git.showUntracked",
				label: "Git: show untracked",
				currentValue: String(this.#draft.segmentOptions.git?.showUntracked !== false),
				values: BOOL_VALUES,
			},
			{
				id: "option.time.format",
				label: "Time: format",
				currentValue: this.#draft.segmentOptions.time?.format ?? "24h",
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Time format",
						"Clock format for the time segment.",
						TIME_FORMAT_OPTIONS,
						currentValue,
						done,
						() => done(),
					),
			},
			{
				id: "option.time.showSeconds",
				label: "Time: show seconds",
				currentValue: String(this.#draft.segmentOptions.time?.showSeconds === true),
				values: BOOL_VALUES,
			},
		);

		return items;
	}

	#handleChange(id: string, value: string): void {
		if (id === "action.save") {
			this.#save();
			return;
		}
		if (id === "action.cancel") {
			this.#cancel();
			return;
		}
		if (id === "separator") {
			this.#draft.separator = value as StatusLineSeparatorStyle;
		} else if (id.startsWith("segment.")) {
			this.#setSegmentPlacement(
				id.slice("segment.".length) as StatusLineSegmentId,
				value as "hidden" | "left" | "right",
			);
		} else if (id.startsWith("moveup.")) {
			this.#moveSegment(id.slice("moveup.".length) as StatusLineSegmentId, -1);
		} else if (id.startsWith("movedown.")) {
			this.#moveSegment(id.slice("movedown.".length) as StatusLineSegmentId, 1);
		} else if (id.startsWith("option.")) {
			this.#setOption(id.slice("option.".length), value);
		}
		this.#preview();
		this.#refresh();
	}

	#setSegmentPlacement(id: StatusLineSegmentId, placement: "hidden" | "left" | "right"): void {
		this.#draft.leftSegments = this.#draft.leftSegments.filter(segment => segment !== id);
		this.#draft.rightSegments = this.#draft.rightSegments.filter(segment => segment !== id);
		if (placement === "left") this.#draft.leftSegments.push(id);
		if (placement === "right") this.#draft.rightSegments.push(id);
	}

	#moveSegment(id: StatusLineSegmentId, delta: -1 | 1): void {
		const group = this.#draft.leftSegments.includes(id) ? this.#draft.leftSegments : this.#draft.rightSegments;
		const index = group.indexOf(id);
		if (index < 0) return;
		const nextIndex = Math.max(0, Math.min(group.length - 1, index + delta));
		if (nextIndex === index) return;
		const [segment] = group.splice(index, 1);
		if (segment) group.splice(nextIndex, 0, segment);
	}

	#setOption(path: string, value: string): void {
		const bool = value === "true";
		switch (path) {
			case "model.showThinkingLevel":
				this.#draft.segmentOptions.model = { ...(this.#draft.segmentOptions.model ?? {}), showThinkingLevel: bool };
				break;
			case "path.abbreviate":
				this.#draft.segmentOptions.path = { ...(this.#draft.segmentOptions.path ?? {}), abbreviate: bool };
				break;
			case "path.maxLength":
				this.#draft.segmentOptions.path = { ...(this.#draft.segmentOptions.path ?? {}), maxLength: Number(value) };
				break;
			case "path.stripWorkPrefix":
				this.#draft.segmentOptions.path = { ...(this.#draft.segmentOptions.path ?? {}), stripWorkPrefix: bool };
				break;
			case "git.showBranch":
				this.#draft.segmentOptions.git = { ...(this.#draft.segmentOptions.git ?? {}), showBranch: bool };
				break;
			case "git.showStaged":
				this.#draft.segmentOptions.git = { ...(this.#draft.segmentOptions.git ?? {}), showStaged: bool };
				break;
			case "git.showUnstaged":
				this.#draft.segmentOptions.git = { ...(this.#draft.segmentOptions.git ?? {}), showUnstaged: bool };
				break;
			case "git.showUntracked":
				this.#draft.segmentOptions.git = { ...(this.#draft.segmentOptions.git ?? {}), showUntracked: bool };
				break;
			case "time.format":
				this.#draft.segmentOptions.time = {
					...(this.#draft.segmentOptions.time ?? {}),
					format: value as "12h" | "24h",
				};
				break;
			case "time.showSeconds":
				this.#draft.segmentOptions.time = { ...(this.#draft.segmentOptions.time ?? {}), showSeconds: bool };
				break;
			case "usage.mode":
				this.#draft.segmentOptions.usage = {
					...(this.#draft.segmentOptions.usage ?? {}),
					mode: value === "remaining" ? "remaining" : "used",
				};
				break;
		}
	}

	#preview(): void {
		this.callbacks.onStatusLinePreview?.({
			preset: "custom",
			leftSegments: [...this.#draft.leftSegments],
			rightSegments: [...this.#draft.rightSegments],
			separator: this.#draft.separator,
			segmentOptions: cloneSegmentOptions(this.#draft.segmentOptions),
			previewHighlightSegment: this.#previewHighlightSegment,
		});
	}

	#restorePreview(): void {
		this.callbacks.onStatusLinePreview?.({
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			segmentOptions: cloneSegmentOptions(settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			previewHighlightSegment: undefined,
		});
	}

	#save(): void {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", [...this.#draft.leftSegments]);
		settings.set("statusLine.rightSegments", [...this.#draft.rightSegments]);
		settings.set("statusLine.separator", this.#draft.separator);
		settings.set(
			"statusLine.segmentOptions",
			cloneSegmentOptions(this.#draft.segmentOptions) as Record<string, unknown>,
		);
		this.callbacks.onChange("statusLine.preset", "custom");
		this.callbacks.onChange("statusLine.leftSegments", [...this.#draft.leftSegments]);
		this.callbacks.onChange("statusLine.rightSegments", [...this.#draft.rightSegments]);
		this.callbacks.onChange("statusLine.separator", this.#draft.separator);
		this.callbacks.onChange("statusLine.segmentOptions", cloneSegmentOptions(this.#draft.segmentOptions));
		this.#previewHighlightSegment = undefined;
		this.#preview();
		this.done("saved");
	}

	#cancel(): void {
		this.#restorePreview();
		this.done();
	}

	handleInput(data: string): void {
		this.#list.handleInput(data);
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
	/** Available model profile names (from the model registry) */
	availableModelProfiles: string[];
	/** Working directory for plugins tab */
	cwd: string;
}

/** Status line settings subset for preview */
export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	previewHighlightSegment?: StatusLineSegmentId;
	sessionAccent?: boolean;
	maxRows?: number;
}

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: (path: SettingPath, newValue: unknown) => void;
	/** Called for theme preview while browsing theme settings */
	onThemePreview?: (theme: string) => void | Promise<void>;
	/** Called to restore the rendered theme when theme settings preview is cancelled */
	onThemePreviewCancel?: (theme: string) => void | Promise<void>;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: (width?: number) => string;
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
		} else if (def.path === "modelProfile.default") {
			options = this.context.availableModelProfiles.map(p => ({ value: p, label: p }));
		}
		if (def.path === "statusLine.preset") {
			options = options.filter(option => option.value !== "custom");
		}
		// Preview handlers
		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;

		if (def.path === "theme.dark" || def.path === "theme.light") {
			const activeThemeBeforePreview = getCurrentThemeName() ?? currentValue;
			onPreview = value => {
				return this.callbacks.onThemePreview?.(value);
			};
			onPreviewCancel = () => {
				return this.callbacks.onThemePreviewCancel?.(activeThemeBeforePreview);
			};
		} else if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(value as StatusLinePreset);
				this.callbacks.onStatusLinePreview?.({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
					previewHighlightSegment: undefined,
				});
				this.#updateStatusPreview();
			};
			onPreviewCancel = () => {
				const currentPreset = settings.get("statusLine.preset");
				const presetDef = getPreset(currentPreset);
				const savedCustomSettings =
					currentPreset === "custom"
						? {
								leftSegments: settings.get("statusLine.leftSegments"),
								rightSegments: settings.get("statusLine.rightSegments"),
								separator: settings.get("statusLine.separator"),
								segmentOptions: cloneSegmentOptions(
									settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions,
								),
							}
						: {};
				this.callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
					...savedCustomSettings,
					previewHighlightSegment: undefined,
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
				this.callbacks.onStatusLinePreview?.({ separator, previewHighlightSegment: undefined });
				this.#updateStatusPreview();
			};
		} else if (def.path === "statusLine.maxRows") {
			onPreview = value => {
				this.callbacks.onStatusLinePreview?.({ maxRows: Number(value) });
				this.#updateStatusPreview();
			};
			onPreviewCancel = () => {
				this.callbacks.onStatusLinePreview?.({
					maxRows: settings.get("statusLine.maxRows"),
					previewHighlightSegment: undefined,
				});
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
			this.#buildItemsForTab(defs, tabId),
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === STATUS_LINE_USAGE_MODE_ID) {
					const segmentOptions = setSavedUsageMode(newValue);
					this.callbacks.onChange("statusLine.segmentOptions", segmentOptions);
					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
					this.#refreshCurrentTabItems(defs);
					return;
				}

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

	#buildItemsForTab(defs: SettingDef[], tabId: SettingTab): SettingItem[] {
		const items = this.#buildItemsForDefs(defs);
		if (tabId === "appearance") {
			const customEditorCallbacks: SettingsCallbacks = {
				...this.callbacks,
				onStatusLinePreview: previewSettings => {
					this.callbacks.onStatusLinePreview?.(previewSettings);
					this.#updateStatusPreview();
				},
			};
			const customEditorItem: SettingItem = {
				id: STATUS_LINE_CUSTOM_EDITOR_ID,
				label: "Status Line Custom Editor",
				description:
					"Edit custom status line segments, placement, separator, and typed segment options with live previews.",
				currentValue: "open",
				submenu: (_currentValue, done) => new StatusLineCustomEditor(customEditorCallbacks, done),
			};
			const presetIndex = items.findIndex(item => item.id === "statusLine.preset");
			if (presetIndex >= 0) {
				items.splice(presetIndex + 1, 0, customEditorItem);
			} else {
				items.push(customEditorItem);
			}
			{
				const usageModeItem: SettingItem = {
					id: STATUS_LINE_USAGE_MODE_ID,
					label: "Status Line Usage Mode",
					description: "Show provider quota in the status line as used or remaining.",
					currentValue: getSavedUsageMode(),
					values: [...USAGE_MODE_VALUES],
				};
				if (presetIndex >= 0) {
					items.splice(presetIndex + 2, 0, usageModeItem);
				} else {
					items.push(usageModeItem);
				}
			}
		}
		return items;
	}

	/** Re-evaluate condition gates against the current settings and refresh the active list. */
	#refreshCurrentTabItems(defs: SettingDef[]): void {
		if (this.#currentTabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForTab(defs, this.#currentTabId));
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
			segmentOptions: cloneSegmentOptions(settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			previewHighlightSegment: undefined,
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

		// Pass to current content. SettingsList owns Escape routing so open
		// submenus can run their cancel/restore callbacks before closing.
		if (this.#currentList) {
			this.#currentList.handleInput(data);
			return;
		}
		if (this.#pluginComponent) {
			this.#pluginComponent.handleInput(data);
			return;
		}

		// Fallback for future top-level content that does not own cancellation.
		if (matchesAppInterrupt(data)) {
			this.callbacks.onCancel();
		}
	}
}
