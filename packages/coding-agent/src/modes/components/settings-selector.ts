import { ThinkingLevel, type ThinkingLevel as ThinkingLevelValue } from "@gajae-code/agent-core";
import type { Effort } from "@gajae-code/ai/core";
import {
	type Component,
	Container,
	Ellipsis,
	getKeybindings,
	Input,
	matchesKey,
	resolvePetMode,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	type Tab,
	TabBar,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import { type SettingPath, settings } from "../../config/settings";
import type {
	SettingTab,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
} from "../../config/settings-schema";
import { SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import type { GjcRuntimeSnapshotProvider } from "../../extensibility/gjc-plugins/runtime-quarantine";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { getTabBarTheme } from "../shared";
import { resolveUiLanguage, type UiLanguage, uiString } from "../ui-language";
import { DynamicBorder } from "./dynamic-border";
import { DynamicThemeText } from "./dynamic-theme-text";
import { GjcBundleSettingsComponent } from "./gjc-bundle-settings";
import {
	type NotificationsEditorOperations,
	NotificationsSettingsEditorComponent,
} from "./notifications-settings-editor";
import { createPetSelectItems, getPetUnavailableWarning, isPetAvailable } from "./pet-capability";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { normalizeProviderOrder } from "./provider-order-context";
import { getSettingsForTab, type SettingDef } from "./settings-defs";
import { getPreset } from "./status-line/presets";
import { ALL_SEGMENT_IDS } from "./status-line/segments";
import type { StatusLinePreviewParts, StatusLineSegmentOptions } from "./tool-status-header";

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

	submit(): void {
		this.onSubmit(this.#input.getValue());
	}

	cancel(): void {
		this.onCancel();
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
		this.addChild(new DynamicThemeText(() => theme.bold(theme.fg("accent", title))));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new DynamicThemeText(() => theme.fg("muted", description)));
		}

		// Preview (if provided)
		if (getPreview) {
			this.addChild(new Spacer(1));
			this.addChild(
				new DynamicThemeText(() => theme.fg("muted", uiString(settings.get("ui.language"), "settings.preview"))),
			);
			this.#previewText = new Text(getPreview(), 0, 0);
			this.addChild(this.#previewText);
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(options, Math.min(options.length, 10), () => getSelectListTheme());

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
		this.addChild(
			new DynamicThemeText(() => theme.fg("dim", uiString(settings.get("ui.language"), "settings.selectHint"))),
		);
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
		...base,
		...overrides,
		model: base?.model || overrides?.model ? { ...(base?.model ?? {}), ...(overrides?.model ?? {}) } : undefined,
		path: base?.path || overrides?.path ? { ...(base?.path ?? {}), ...(overrides?.path ?? {}) } : undefined,
		git: base?.git || overrides?.git ? { ...(base?.git ?? {}), ...(overrides?.git ?? {}) } : undefined,
		time: base?.time || overrides?.time ? { ...(base?.time ?? {}), ...(overrides?.time ?? {}) } : undefined,
		usage: base?.usage || overrides?.usage ? { ...(base?.usage ?? {}), ...(overrides?.usage ?? {}) } : undefined,
		command:
			base?.command || overrides?.command ? { ...(base?.command ?? {}), ...(overrides?.command ?? {}) } : undefined,
	};
}

function effectiveSegmentOptions(
	preset: StatusLinePreset,
	options: StatusLineSegmentOptions | undefined,
): StatusLineSegmentOptions {
	return mergeSegmentOptions(getPreset(preset).segmentOptions, options);
}

function normalizeEditorSegments(value: unknown): StatusLineSegmentId[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const normalized: StatusLineSegmentId[] = [];
	for (const raw of value) {
		const id = typeof raw === "string" ? raw : String(raw);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		normalized.push(id as StatusLineSegmentId);
	}
	return normalized;
}

function effectiveCustomSegments(
	preset: StatusLinePreset,
	leftSegments: unknown,
	rightSegments: unknown,
): { leftSegments: StatusLineSegmentId[]; rightSegments: StatusLineSegmentId[] } {
	if (preset === "custom") {
		const left = normalizeEditorSegments(leftSegments);
		const leftIds = new Set(left);
		return {
			leftSegments: left,
			rightSegments: normalizeEditorSegments(rightSegments).filter(id => !leftIds.has(id)),
		};
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

function getUsageModeSettings(mode: string): StatusLineSegmentOptions {
	const normalizedMode: UsageMode = mode === "remaining" ? "remaining" : "used";
	const segmentOptions = settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions;
	return {
		...segmentOptions,
		usage: {
			...(segmentOptions.usage ?? {}),
			mode: normalizedMode,
		},
	};
}

function statusSegmentLabel(id: StatusLineSegmentId): string {
	return id.replace(/_/g, " ");
}

type StatusLineSide = "left" | "right";
type StatusLineOptionPath =
	| "model.showThinkingLevel"
	| "path.abbreviate"
	| "path.maxLength"
	| "path.stripWorkPrefix"
	| "git.showBranch"
	| "git.showStaged"
	| "git.showUnstaged"
	| "git.showUntracked"
	| "time.format"
	| "time.showSeconds"
	| "usage.mode"
	| "command.command";
type StatusLineChoiceTarget = "separator" | StatusLineOptionPath;
type StatusLineRootFocus =
	| { kind: "statusbar"; side: StatusLineSide; index: number }
	| { kind: "palette"; index: number }
	| { kind: "separator-control" }
	| { kind: "option-control"; path: StatusLineOptionPath }
	| { kind: "confirm" }
	| { kind: "exit" };
type StatusLineFocus =
	| StatusLineRootFocus
	| { kind: "choice"; target: StatusLineChoiceTarget; focusedIndex: number; returnFocus: StatusLineRootFocus };

interface PickedStatusLineSegment {
	id: StatusLineSegmentId;
	origin: { kind: "statusbar"; side: StatusLineSide; index: number } | { kind: "palette" };
}

interface StatusLineChoiceDescriptor {
	target: StatusLineChoiceTarget;
	label: string;
	values: SelectItem[];
	currentValue: () => string;
	apply: (value: string) => void;
	highlightSegment?: StatusLineSegmentId;
}

const SEPARATOR_OPTIONS: SelectItem[] = [
	{ value: "powerline", label: "Powerline" },
	{ value: "powerline-thin", label: "Thin chevron" },
	{ value: "slash", label: "Slash" },
	{ value: "pipe", label: "Pipe" },
	{ value: "block", label: "Block" },
	{ value: "none", label: "None" },
	{ value: "ascii", label: "ASCII" },
];

function isDeleteKey(data: string): boolean {
	const kb = getKeybindings();
	return (
		kb.matches(data, "tui.editor.deleteCharForward") ||
		matchesKey(data, "delete") ||
		matchesKey(data, "shift+delete") ||
		data === "\x1b[3~"
	);
}

function cloneRootFocus(focus: StatusLineRootFocus): StatusLineRootFocus {
	return { ...focus };
}

class StatusLineCustomEditor extends Container {
	#draft: StatusLineDraft;
	#previewHighlightSegment: StatusLineSegmentId | undefined;
	#focus: StatusLineFocus = { kind: "statusbar", side: "left", index: 0 };
	#picked: PickedStatusLineSegment | undefined;
	#pickedStatusbarFocus: Extract<StatusLineRootFocus, { kind: "statusbar" }> | undefined;
	#textInput: TextInputSubmenu | undefined;

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
		this.#normalizeFocus();
		this.#preview();
	}

	get navigationLocked(): boolean {
		return true;
	}

	#choiceDescriptors(): StatusLineChoiceDescriptor[] {
		return [
			{
				target: "separator",
				label: "Separator",
				values: SEPARATOR_OPTIONS,
				currentValue: () => this.#draft.separator,
				apply: value => {
					this.#draft.separator = value as StatusLineSeparatorStyle;
				},
			},
			{
				target: "model.showThinkingLevel",
				label: "Model: show thinking level",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.model?.showThinkingLevel !== false),
				apply: value => this.#setOption("model.showThinkingLevel", value),
				highlightSegment: "model",
			},
			{
				target: "path.abbreviate",
				label: "Path: abbreviate",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.path?.abbreviate !== false),
				apply: value => this.#setOption("path.abbreviate", value),
				highlightSegment: "path",
			},
			{
				target: "path.maxLength",
				label: "Path: max length",
				values: PATH_LENGTH_OPTIONS,
				currentValue: () => String(this.#draft.segmentOptions.path?.maxLength ?? 32),
				apply: value => this.#setOption("path.maxLength", value),
				highlightSegment: "path",
			},
			{
				target: "path.stripWorkPrefix",
				label: "Path: strip work prefix",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.path?.stripWorkPrefix === true),
				apply: value => this.#setOption("path.stripWorkPrefix", value),
				highlightSegment: "path",
			},
			{
				target: "git.showBranch",
				label: "Git: show branch",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.git?.showBranch !== false),
				apply: value => this.#setOption("git.showBranch", value),
				highlightSegment: "git",
			},
			{
				target: "git.showStaged",
				label: "Git: show staged",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.git?.showStaged !== false),
				apply: value => this.#setOption("git.showStaged", value),
				highlightSegment: "git",
			},
			{
				target: "git.showUnstaged",
				label: "Git: show unstaged",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.git?.showUnstaged !== false),
				apply: value => this.#setOption("git.showUnstaged", value),
				highlightSegment: "git",
			},
			{
				target: "git.showUntracked",
				label: "Git: show untracked",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.git?.showUntracked !== false),
				apply: value => this.#setOption("git.showUntracked", value),
				highlightSegment: "git",
			},
			{
				target: "time.format",
				label: "Time: format",
				values: TIME_FORMAT_OPTIONS,
				currentValue: () => this.#draft.segmentOptions.time?.format ?? "24h",
				apply: value => this.#setOption("time.format", value),
			},
			{
				target: "time.showSeconds",
				label: "Time: show seconds",
				values: BOOL_VALUES.map(value => ({ value, label: value })),
				currentValue: () => String(this.#draft.segmentOptions.time?.showSeconds === true),
				apply: value => this.#setOption("time.showSeconds", value),
			},
			{
				target: "usage.mode",
				label: "Usage: mode",
				values: USAGE_MODE_OPTIONS,
				currentValue: () => this.#draft.segmentOptions.usage?.mode ?? "used",
				apply: value => this.#setOption("usage.mode", value),
				highlightSegment: "usage",
			},
		];
	}

	#descriptor(target: StatusLineChoiceTarget): StatusLineChoiceDescriptor | undefined {
		return this.#choiceDescriptors().find(descriptor => descriptor.target === target);
	}

	#controlTargets(): StatusLineChoiceTarget[] {
		return [...this.#choiceDescriptors().map(descriptor => descriptor.target), "command.command"];
	}

	#hiddenSegments(): StatusLineSegmentId[] {
		const visible = new Set([...this.#draft.leftSegments, ...this.#draft.rightSegments]);
		return PUBLIC_STATUS_SEGMENTS.filter(id => !visible.has(id));
	}

	#paletteSegments(includePicked = this.#focus.kind === "palette"): StatusLineSegmentId[] {
		const visible = new Set([...this.#draft.leftSegments, ...this.#draft.rightSegments]);
		const selected = includePicked ? this.#picked?.id : undefined;
		return PUBLIC_STATUS_SEGMENTS.filter(id => !visible.has(id) || id === selected);
	}

	#focusSegment(): StatusLineSegmentId | undefined {
		if (this.#focus.kind !== "statusbar") return undefined;
		return this.#draft[`${this.#focus.side}Segments`][this.#focus.index];
	}

	#segmentCount(side: StatusLineSide, omitPicked = false): number {
		const segments = this.#draft[`${side}Segments`];
		if (
			!omitPicked ||
			!this.#picked ||
			this.#picked.origin.kind !== "statusbar" ||
			this.#picked.origin.side !== side
		) {
			return segments.length;
		}
		return Math.max(0, segments.length - 1);
	}

	#normalizeFocus(): void {
		if (this.#focus.kind === "choice") {
			const descriptor = this.#descriptor(this.#focus.target);
			if (!descriptor) {
				this.#focus = { kind: "separator-control" };
			} else {
				this.#focus.focusedIndex = Math.max(0, Math.min(this.#focus.focusedIndex, descriptor.values.length - 1));
			}
			return;
		}
		if (this.#focus.kind === "statusbar") {
			const max = this.#picked
				? this.#segmentCount(this.#focus.side, true)
				: this.#draft[`${this.#focus.side}Segments`].length - 1;
			if (max < 0) {
				const otherSide: StatusLineSide = this.#focus.side === "left" ? "right" : "left";
				if (this.#draft[`${otherSide}Segments`].length > 0) {
					this.#focus = { kind: "statusbar", side: otherSide, index: 0 };
				} else if (this.#paletteSegments().length > 0) {
					this.#focus = { kind: "palette", index: 0 };
				} else {
					this.#focus = { kind: "separator-control" };
				}
			} else {
				this.#focus.index = Math.max(0, Math.min(this.#focus.index, max));
			}
		} else if (this.#focus.kind === "palette") {
			const palette = this.#paletteSegments();
			if (palette.length === 0) {
				this.#focus = { kind: "separator-control" };
			} else {
				this.#focus.index = Math.max(0, Math.min(this.#focus.index, palette.length - 1));
			}
		} else if (
			this.#focus.kind === "option-control" &&
			!this.#controlTargets().includes((this.#focus as { path: StatusLineOptionPath }).path)
		) {
			this.#focus = { kind: "separator-control" };
		}
	}

	#rootOrder(): StatusLineRootFocus[] {
		const roots: StatusLineRootFocus[] = [];
		roots.push(this.#nearestStatusbarFocus());
		if (this.#paletteSegments().length > 0) roots.push({ kind: "palette", index: 0 });
		roots.push({ kind: "separator-control" });
		roots.push({ kind: "confirm" }, { kind: "exit" });
		return roots;
	}

	#nearestStatusbarFocus(): StatusLineRootFocus {
		if (this.#focus.kind === "statusbar") {
			return { kind: "statusbar", side: this.#focus.side, index: this.#focus.index };
		}
		if (this.#draft.leftSegments.length > 0 || this.#picked) {
			return {
				kind: "statusbar",
				side: "left",
				index: this.#picked ? this.#segmentCount("left", true) : 0,
			};
		}
		if (this.#draft.rightSegments.length > 0) {
			return { kind: "statusbar", side: "right", index: 0 };
		}
		return { kind: "statusbar", side: "left", index: 0 };
	}

	#rootFocusKey(focus: StatusLineRootFocus): string {
		switch (focus.kind) {
			case "statusbar":
				return `${focus.kind}:${focus.side}:${focus.index}`;
			case "palette":
				return `${focus.kind}:${focus.index}`;
			case "option-control":
				return `${focus.kind}:${focus.path}`;
			default:
				return focus.kind;
		}
	}

	#moveVertical(delta: -1 | 1): void {
		if (this.#focus.kind === "choice") {
			const descriptor = this.#descriptor(this.#focus.target);
			if (!descriptor || descriptor.values.length === 0) return;
			this.#focus.focusedIndex =
				(this.#focus.focusedIndex + delta + descriptor.values.length) % descriptor.values.length;
			return;
		}
		if (this.#picked) {
			if (this.#focus.kind === "palette") {
				if (delta === -1) this.#focus = this.#pickedStatusbarFocus ?? this.#nearestStatusbarFocus();
			} else if (delta === 1) {
				if (this.#focus.kind === "statusbar") this.#pickedStatusbarFocus = { ...this.#focus };
				this.#focus = { kind: "palette", index: this.#focusPaletteIndex() };
			}
			this.#normalizeFocus();
			return;
		}
		const order = this.#rootOrder();
		const currentKey = this.#rootFocusKey(this.#focus);
		const currentIndex = Math.max(
			0,
			order.findIndex(item => this.#rootFocusKey(item) === currentKey),
		);
		this.#focus = cloneRootFocus(order[(currentIndex + delta + order.length) % order.length] ?? order[0]);
		this.#normalizeFocus();
	}

	#focusPaletteIndex(): number {
		if (this.#focus.kind === "palette") return this.#focus.index;
		if (this.#picked) return Math.max(0, this.#paletteSegments(true).indexOf(this.#picked.id));
		return Math.max(0, Math.min(this.#paletteSegments(false).length - 1, 0));
	}

	#linearVisibleFocus(): Array<{ side: StatusLineSide; index: number }> {
		return [
			...this.#draft.leftSegments.map((_, index) => ({ side: "left" as const, index })),
			...this.#draft.rightSegments.map((_, index) => ({ side: "right" as const, index })),
		];
	}

	#moveVisibleFocus(delta: -1 | 1): void {
		if (this.#focus.kind !== "statusbar") return;
		const focus = this.#focus;
		const items = this.#linearVisibleFocus();
		if (items.length === 0) return;
		const currentIndex = Math.max(
			0,
			items.findIndex(item => item.side === focus.side && item.index === focus.index),
		);
		this.#focus = { kind: "statusbar", ...items[(currentIndex + delta + items.length) % items.length] };
	}

	#slotOrder(): Array<{ side: StatusLineSide; index: number }> {
		const leftCount = this.#segmentCount("left", true);
		const rightCount = this.#segmentCount("right", true);
		return [
			...Array.from({ length: leftCount + 1 }, (_, index) => ({ side: "left" as const, index })),
			...Array.from({ length: rightCount + 1 }, (_, index) => ({ side: "right" as const, index })),
		];
	}

	#movePickedSlot(delta: -1 | 1): void {
		if (!this.#picked || this.#focus.kind !== "statusbar") return;
		const focus = this.#focus;
		const slots = this.#slotOrder();
		const currentIndex = Math.max(
			0,
			slots.findIndex(item => item.side === focus.side && item.index === focus.index),
		);
		this.#focus = { kind: "statusbar", ...slots[Math.max(0, Math.min(slots.length - 1, currentIndex + delta))] };
		this.#pickedStatusbarFocus = { ...this.#focus };
		this.#updatePreviewHighlight();
	}

	#movePaletteFocus(delta: -1 | 1): void {
		if (this.#focus.kind !== "palette") return;
		const palette = this.#paletteSegments();
		if (palette.length === 0) return;
		this.#focus.index = (this.#focus.index + delta + palette.length) % palette.length;
	}

	#moveChoiceControl(delta: -1 | 1): void {
		if (this.#focus.kind !== "separator-control" && this.#focus.kind !== "option-control") return;
		const targets = this.#controlTargets();
		const currentTarget = this.#focus.kind === "separator-control" ? "separator" : this.#focus.path;
		const currentIndex = Math.max(0, targets.indexOf(currentTarget));
		const next = targets[(currentIndex + delta + targets.length) % targets.length];
		if (!next) return;
		this.#focus =
			next === "separator"
				? { kind: "separator-control" }
				: { kind: "option-control", path: next as StatusLineOptionPath };
	}

	#moveChoiceTarget(delta: -1 | 1): void {
		if (this.#focus.kind !== "choice") return;
		const focus = this.#focus;
		const descriptors = this.#choiceDescriptors();
		const currentIndex = Math.max(
			0,
			descriptors.findIndex(descriptor => descriptor.target === focus.target),
		);
		const next = descriptors[(currentIndex + delta + descriptors.length) % descriptors.length];
		if (!next) return;
		const currentValue = next.currentValue();
		this.#focus = {
			kind: "choice",
			target: next.target,
			focusedIndex: Math.max(
				0,
				next.values.findIndex(value => value.value === currentValue),
			),
			returnFocus:
				next.target === "separator"
					? { kind: "separator-control" }
					: { kind: "option-control", path: next.target as StatusLineOptionPath },
		};
	}

	#pickFocusedStatusbar(): void {
		if (this.#focus.kind !== "statusbar") return;
		const id = this.#focusSegment();
		if (!id) return;
		this.#picked = { id, origin: { kind: "statusbar", side: this.#focus.side, index: this.#focus.index } };
		this.#pickedStatusbarFocus = { kind: "statusbar", side: this.#focus.side, index: this.#focus.index };
		this.#updatePreviewHighlight();
		this.#preview();
	}

	#pickFocusedPalette(): void {
		if (this.#focus.kind !== "palette") return;
		const id = this.#paletteSegments()[this.#focus.index];
		if (!id) return;
		this.#picked = { id, origin: { kind: "palette" } };
		this.#focus = { kind: "statusbar", side: "left", index: this.#segmentCount("left", true) };
		this.#pickedStatusbarFocus = { ...this.#focus };
		this.#updatePreviewHighlight();
		this.#preview();
	}

	#dropPicked(): void {
		if (!this.#picked || this.#focus.kind !== "statusbar") return;
		const id = this.#picked.id;
		const nextLeft = this.#draft.leftSegments.filter(segment => segment !== id);
		const nextRight = this.#draft.rightSegments.filter(segment => segment !== id);
		const target = this.#focus.side === "left" ? nextLeft : nextRight;
		target.splice(Math.max(0, Math.min(target.length, this.#focus.index)), 0, id);
		this.#draft.leftSegments = nextLeft;
		this.#draft.rightSegments = nextRight;
		this.#focus = { kind: "statusbar", side: this.#focus.side, index: target.indexOf(id) };
		this.#picked = undefined;
		this.#pickedStatusbarFocus = undefined;
		this.#updatePreviewHighlight();
		this.#preview();
	}

	#dropPickedToPalette(): void {
		if (!this.#picked || this.#focus.kind !== "palette") return;
		const id = this.#picked.id;
		this.#draft.leftSegments = this.#draft.leftSegments.filter(segment => segment !== id);
		this.#draft.rightSegments = this.#draft.rightSegments.filter(segment => segment !== id);
		this.#picked = undefined;
		this.#pickedStatusbarFocus = undefined;
		const hidden = this.#hiddenSegments();
		this.#focus = { kind: "palette", index: Math.max(0, hidden.indexOf(id)) };
		this.#updatePreviewHighlight();
		this.#preview();
	}

	#hideFocusedSegment(): void {
		if (this.#picked || this.#focus.kind !== "statusbar") return;
		const group = this.#draft[`${this.#focus.side}Segments`];
		const removed = group[this.#focus.index];
		if (!removed) return;
		group.splice(this.#focus.index, 1);
		const hidden = this.#hiddenSegments();
		this.#focus = hidden.length
			? { kind: "palette", index: Math.max(0, hidden.indexOf(removed)) }
			: { kind: "separator-control" };
		this.#updatePreviewHighlight();
		this.#preview();
	}

	#openChoice(target: StatusLineChoiceTarget, returnFocus: StatusLineRootFocus): void {
		const descriptor = this.#descriptor(target);
		if (!descriptor) return;
		const currentValue = descriptor.currentValue();
		this.#focus = {
			kind: "choice",
			target,
			focusedIndex: Math.max(
				0,
				descriptor.values.findIndex(value => value.value === currentValue),
			),
			returnFocus,
		};
	}

	#openCommandInput(): void {
		this.#textInput = new TextInputSubmenu(
			"Status line command",
			"Runs in the configured shell with a short timeout and cached refreshes.",
			this.#draft.segmentOptions.command?.command ?? "",
			value => {
				this.#setOption("command.command", value);
				this.#textInput = undefined;
				this.#focus = { kind: "option-control", path: "command.command" };
				this.#updatePreviewHighlight();
				this.#preview();
			},
			() => {
				this.#textInput = undefined;
				this.#focus = { kind: "option-control", path: "command.command" };
				this.#updatePreviewHighlight();
				this.#preview();
			},
		);
	}

	#applyChoice(): void {
		if (this.#focus.kind !== "choice") return;
		const descriptor = this.#descriptor(this.#focus.target);
		if (!descriptor) return;
		const value = descriptor.values[this.#focus.focusedIndex]?.value;
		if (value === undefined) return;
		descriptor.apply(value);
		this.#focus = cloneRootFocus(this.#focus.returnFocus);
		this.#updatePreviewHighlight();
		this.#preview();
	}

	#updatePreviewHighlight(): void {
		if (this.#picked) {
			this.#previewHighlightSegment = this.#picked.id;
			return;
		}
		if (this.#focus.kind === "statusbar") {
			this.#previewHighlightSegment = this.#focusSegment();
			return;
		}
		if (this.#focus.kind === "palette") {
			this.#previewHighlightSegment = this.#paletteSegments()[this.#focus.index];
			return;
		}
		if (this.#focus.kind === "option-control") {
			this.#previewHighlightSegment =
				this.#focus.path === "command.command" ? "command" : this.#descriptor(this.#focus.path)?.highlightSegment;
			return;
		}
		if (this.#focus.kind === "choice") {
			this.#previewHighlightSegment = this.#descriptor(this.#focus.target)?.highlightSegment;
			return;
		}
		this.#previewHighlightSegment = undefined;
	}

	#focusLabel(): string {
		switch (this.#focus.kind) {
			case "statusbar":
				return `statusbar:${this.#focus.side}:${this.#focus.index}`;
			case "palette":
				return `palette:${this.#focus.index}`;
			case "option-control":
				return `option:${this.#focus.path}`;
			case "choice":
				return `choice:${this.#focus.target}`;
			default:
				return this.#focus.kind;
		}
	}

	#separatorGlyph(): string {
		if (theme.getSymbolPreset() === "ascii") {
			return this.#draft.separator === "none" ? " " : this.#draft.separator === "pipe" ? " | " : " / ";
		}
		switch (this.#draft.separator) {
			case "pipe":
				return " | ";
			case "block":
				return " █ ";
			case "none":
				return " ";
			case "ascii":
				return " > ";
			case "powerline":
				return "  ";
			case "powerline-thin":
				return " ❯ ";
			case "slash":
				return " / ";
		}
	}

	#fit(line: string, width: number): string {
		const ascii = theme.getSymbolPreset() === "ascii";
		const fitted = truncateToWidth(
			line,
			ascii ? Math.max(0, width - 2) : width,
			ascii ? Ellipsis.Ascii : Ellipsis.Unicode,
		);
		if (!ascii) return fitted;
		return fitted.replace(/·/g, "-").replace(/│/g, "|").replace(/…/g, "...");
	}

	#padEndVisible(line: string, width: number): string {
		return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	}

	#padStartVisible(line: string, width: number): string {
		return " ".repeat(Math.max(0, width - visibleWidth(line))) + line;
	}

	#centerVisible(line: string, width: number): string {
		const left = Math.floor(Math.max(0, width - visibleWidth(line)) / 2);
		return " ".repeat(left) + line;
	}

	#simulationWidth(width: number): number {
		return Math.max(1, width - 2);
	}

	#simulationIndent(width: number): string {
		return " ".repeat(Math.max(0, Math.floor((width - this.#simulationWidth(width)) / 2)));
	}

	#highlightBox(text: string, style: "focus" | "selected"): string {
		const selectedText = `> ${text} <`;
		const bgColor = style === "selected" ? "warning" : "text";
		const brightBg = theme.getFgAnsi(bgColor).replace("\x1b[38;", "\x1b[48;");
		const darkFg = theme.getBgAnsi("selectedBg").replace("\x1b[48;", "\x1b[38;");
		return `${brightBg}${darkFg}${selectedText}\x1b[0m`;
	}

	#focusBox(text: string): string {
		return this.#highlightBox(text, "focus");
	}

	#selectedBox(text: string): string {
		return this.#highlightBox(text, "selected");
	}

	#dashedBox(text: string): string {
		return theme.fg("dim", theme.getSymbolPreset() === "ascii" ? `[ ${text} ]` : `┆ ${text} ┆`);
	}

	#renderSegment(id: StatusLineSegmentId, selected: boolean, visibleInStatusbar: boolean): string {
		const label = statusSegmentLabel(id);
		if (selected) return this.#focusBox(label);
		if (visibleInStatusbar) return label;
		return this.#dashedBox(label);
	}

	#renderSide(side: StatusLineSide, visibleIds: ReadonlySet<StatusLineSegmentId> | undefined): string {
		const segments = this.#draft[`${side}Segments`];
		const rendered: string[] = [];
		for (let index = 0; index < segments.length; index++) {
			const id = segments[index];
			if (!id) continue;
			const isOrigin =
				this.#picked?.origin.kind === "statusbar" &&
				this.#picked.origin.side === side &&
				this.#picked.origin.index === index;
			if (isOrigin) continue;
			const selected =
				!this.#picked &&
				this.#focus.kind === "statusbar" &&
				this.#focus.side === side &&
				this.#focus.index === index;
			rendered.push(this.#renderSegment(id, selected, visibleIds ? visibleIds.has(id) : true));
		}
		if (this.#picked && this.#focus.kind === "statusbar" && this.#focus.side === side) {
			rendered.splice(
				Math.max(0, Math.min(rendered.length, this.#focus.index)),
				0,
				this.#selectedBox(statusSegmentLabel(this.#picked.id)),
			);
		}
		return rendered.length
			? rendered.join(theme.fg("statusLineSep", this.#separatorGlyph()))
			: theme.fg("muted", "(empty)");
	}

	#draftPreviewSettings(includePickedPlacement = false): StatusLinePreviewSettings {
		let leftSegments = [...this.#draft.leftSegments];
		let rightSegments = [...this.#draft.rightSegments];
		let previewHighlightSegment = this.#previewHighlightSegment;
		if (includePickedPlacement && this.#picked) {
			const id = this.#picked.id;
			leftSegments = leftSegments.filter(segment => segment !== id);
			rightSegments = rightSegments.filter(segment => segment !== id);
			if (this.#focus.kind === "statusbar") {
				const target = this.#focus.side === "left" ? leftSegments : rightSegments;
				target.splice(Math.max(0, Math.min(target.length, this.#focus.index)), 0, id);
				previewHighlightSegment = id;
			}
		}
		return {
			preset: "custom",
			leftSegments,
			rightSegments,
			separator: this.#draft.separator,
			segmentOptions: cloneSegmentOptions(this.#draft.segmentOptions),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			maxRows: settings.get("statusLine.maxRows"),
			previewHighlightSegment,
			previewHighlightStyle: this.#picked ? "selected" : "focus",
		};
	}

	#actualStatusbarParts(width: number): StatusLinePreviewParts | undefined {
		return this.callbacks.getStatusLinePreviewPartsForSettings?.(
			this.#draftPreviewSettings(true),
			this.#simulationWidth(width),
		);
	}

	#renderActualStatusbar(width: number, parts: StatusLinePreviewParts | undefined): string[] {
		const rendered = this.callbacks.getStatusLinePreviewForSettings?.(
			this.#draftPreviewSettings(true),
			this.#simulationWidth(width),
		);
		if (rendered) {
			return rendered
				.split("\n")
				.map(line => line.trimEnd())
				.filter(line => line.length > 0)
				.map(line => this.#centerVisible(this.#fit(line, this.#simulationWidth(width)), width));
		}
		return parts ? this.#renderActualStatusbarParts(width, parts) : [];
	}

	#renderActualStatusbarParts(width: number, parts: StatusLinePreviewParts): string[] {
		const barWidth = this.#simulationWidth(width);
		const indent = this.#simulationIndent(width);
		const leftSeparator = theme.fg("statusLineSep", ` ${parts.separator.left} `);
		const rightSeparator = theme.fg("statusLineSep", ` ${parts.separator.right} `);
		const left = parts.left.join(leftSeparator);
		const right = parts.right.join(rightSeparator);
		const combinedGap = Math.max(1, barWidth - visibleWidth(left) - visibleWidth(right));
		if (visibleWidth(left) + visibleWidth(right) + 1 <= barWidth) {
			return [this.#fit(`${indent}${left}${" ".repeat(combinedGap)}${right}`, width)];
		}
		return [
			this.#fit(
				`${indent}${this.#padEndVisible(truncateToWidth(left, barWidth, Ellipsis.Unicode), barWidth)}`,
				width,
			),
			this.#fit(
				`${indent}${this.#padStartVisible(truncateToWidth(right, barWidth, Ellipsis.Unicode), barWidth)}`,
				width,
			),
		];
	}

	#renderSlotRows(width: number, parts: StatusLinePreviewParts | undefined): string[] {
		const barWidth = this.#simulationWidth(width);
		const indent = this.#simulationIndent(width);
		const leftVisible = parts ? new Set(parts.leftIds) : undefined;
		const rightVisible = parts
			? new Set(parts.rightIds.filter((id): id is StatusLineSegmentId => id !== null))
			: undefined;
		const left = `${theme.bold("left")} ${this.#renderSide("left", leftVisible)}`;
		const rightExtras =
			parts?.right
				.filter((part, index) => parts.rightIds[index] === null && /^v\d/.test(Bun.stripANSI(part)))
				.map(part => theme.fg("dim", Bun.stripANSI(part))) ?? [];
		const rightCore = this.#renderSide("right", rightVisible);
		const right =
			rightExtras.length > 0
				? `${theme.bold("right")} ${rightCore}${theme.fg("statusLineSep", this.#separatorGlyph())}${rightExtras.join(
						theme.fg("statusLineSep", this.#separatorGlyph()),
					)}`
				: `${theme.bold("right")} ${rightCore}`;
		const combinedGap = Math.max(1, barWidth - visibleWidth(left) - visibleWidth(right));
		if (visibleWidth(left) + visibleWidth(right) + 1 <= barWidth) {
			return [this.#fit(`${indent}${left}${" ".repeat(combinedGap)}${right}`, width)];
		}
		return [
			this.#fit(
				`${indent}${this.#padEndVisible(truncateToWidth(left, barWidth, Ellipsis.Unicode), barWidth)}`,
				width,
			),
			this.#fit(
				`${indent}${this.#padStartVisible(truncateToWidth(right, barWidth, Ellipsis.Unicode), barWidth)}`,
				width,
			),
		];
	}

	#renderChoicePanel(width: number): string[] {
		if (this.#focus.kind !== "choice") return [];
		const focus = this.#focus;
		const descriptor = this.#descriptor(focus.target);
		if (!descriptor) return [];
		const values = descriptor.values.map((value, index) => {
			const selected = index === focus.focusedIndex;
			const active = value.value === descriptor.currentValue();
			const activeMarker = theme.getSymbolPreset() === "ascii" ? "v " : "✓ ";
			const label = `${active ? activeMarker : ""}${value.label}`;
			if (selected) return this.#focusBox(label);
			if (active) return this.#selectedBox(label);
			return label;
		});
		return [
			truncateToWidth(theme.bold(`Choices: ${descriptor.label}: ${values.join("  ")}`), width),
			truncateToWidth(theme.fg("dim", "  Left/Right value · Up/Down option · Enter apply · Esc return"), width),
		];
	}

	override render(width: number): string[] {
		if (this.#textInput) return this.#textInput.render(width);
		this.#normalizeFocus();
		const lines: string[] = [];
		lines.push(truncateToWidth(theme.bold(theme.fg("accent", "Status Line Custom Editor")), width));
		const focusLine = `Focus: ${this.#focusLabel()}`;
		lines.push(truncateToWidth(theme.fg("muted", focusLine), width));
		if (this.#picked) {
			lines.push(truncateToWidth(theme.fg("accent", `Selected: ${statusSegmentLabel(this.#picked.id)}`), width));
		}
		lines.push("");
		lines.push(this.#centerVisible(theme.bold("Simulated statusbar"), width));
		const actualStatusbarParts = this.#actualStatusbarParts(width);
		const actualStatusbar = this.#renderActualStatusbar(width, actualStatusbarParts);
		if (actualStatusbar.length > 0) {
			lines.push(...actualStatusbar);
		}
		const slotRows = this.#renderSlotRows(width, actualStatusbarParts);
		lines.push(...slotRows);
		if (actualStatusbar.length > 1 || slotRows.length > 1) {
			lines.push(this.#fit(theme.fg("warning", "  Warning: statusbar wrapped to 2 rows"), width));
			if (this.#focus.kind === "statusbar") {
				const focused = this.#picked ? this.#picked.id : this.#focusSegment();
				if (focused) lines.push(this.#fit(`  Focused target: ${statusSegmentLabel(focused)}`, width));
			}
		}
		lines.push("");
		const paletteSegments = this.#paletteSegments();
		const paletteTokens = paletteSegments.map((id, index) => {
			const selected = this.#picked?.id === id;
			const focused = this.#focus.kind === "palette" && this.#focus.index === index;
			const label = `{${statusSegmentLabel(id)}}`;
			if (selected) return this.#selectedBox(label);
			return focused ? this.#focusBox(label) : theme.fg("muted", label);
		});
		lines.push(truncateToWidth(theme.bold("Hidden segment palette"), width));
		lines.push(truncateToWidth(`  ${paletteTokens.length ? paletteTokens.join(" ") : "(empty)"}`, width));
		if (width < 64 && this.#focus.kind === "palette") {
			const focusedPalette = paletteSegments[this.#focus.index];
			if (focusedPalette)
				lines.push(truncateToWidth(`  Focused palette target: ${statusSegmentLabel(focusedPalette)}`, width));
		}
		lines.push("");
		lines.push(truncateToWidth(theme.bold("Visible choices"), width));
		const descriptors = this.#choiceDescriptors();
		const focusedDescriptor = descriptors.find(
			descriptor =>
				(this.#focus.kind === "separator-control" && descriptor.target === "separator") ||
				(this.#focus.kind === "option-control" && descriptor.target === this.#focus.path) ||
				(this.#focus.kind === "choice" && descriptor.target === this.#focus.target),
		);
		const summaryRows = [descriptors.slice(0, 6), descriptors.slice(6)];
		for (const row of summaryRows) {
			lines.push(
				truncateToWidth(
					`  ${row
						.map(descriptor => {
							const focused = focusedDescriptor?.target === descriptor.target;
							return focused ? this.#focusBox(descriptor.label) : descriptor.label;
						})
						.join(" · ")}`,
					width,
				),
			);
		}
		const commandFocused = this.#focus.kind === "option-control" && this.#focus.path === "command.command";
		lines.push(
			truncateToWidth(`  ${commandFocused ? this.#focusBox("Command: command") : "Command: command"}`, width),
		);
		if (focusedDescriptor) {
			const current = focusedDescriptor.currentValue();
			const choices = focusedDescriptor.values
				.map(value => (value.value === current ? `[${value.label}]` : value.label))
				.join(" | ");
			lines.push(
				truncateToWidth(`${theme.fg("accent", theme.nav.cursor)} ${focusedDescriptor.label}: ${choices}`, width),
			);
		} else if (commandFocused) {
			const command = this.#draft.segmentOptions.command?.command ?? "";
			lines.push(truncateToWidth(`${theme.fg("accent", theme.nav.cursor)} Command: ${command || "(empty)"}`, width));
		} else {
			const separator = descriptors[0];
			if (separator) {
				const current = separator.currentValue();
				const choices = separator.values
					.map(value => (value.value === current ? `[${value.label}]` : value.label))
					.join(" | ");
				lines.push(truncateToWidth(`  ${separator.label}: ${choices}`, width));
			}
		}
		lines.push("");
		const confirm = this.#focus.kind === "confirm" ? theme.bold(theme.fg("accent", "[Confirm]")) : "[Confirm]";
		const exit = this.#focus.kind === "exit" ? theme.bold(theme.fg("accent", "[Exit]")) : "[Exit]";
		lines.push(truncateToWidth(`  ${confirm} ${exit}`, width));
		lines.push(...this.#renderChoicePanel(width));
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					"  Enter select/drop/apply · Left/Right segment/palette/value · Up/Down slots/palette/options/actions · Delete hide · Esc exit",
				),
				width,
			),
		);
		return lines.map(line => this.#fit(line, width));
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
			case "command.command":
				this.#draft.segmentOptions.command = {
					...(this.#draft.segmentOptions.command ?? {}),
					command: value,
				};
				break;
		}
	}

	#preview(): void {
		this.callbacks.onRenderRequested?.();
	}

	#emitDraftToParentPreview(): void {
		this.callbacks.onStatusLinePreview?.(this.#draftPreviewSettings());
	}

	#restorePreview(): void {
		this.callbacks.onStatusLinePreview?.({
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			segmentOptions: cloneSegmentOptions(settings.get("statusLine.segmentOptions") as StatusLineSegmentOptions),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			maxRows: settings.get("statusLine.maxRows"),
			previewHighlightSegment: undefined,
		});
	}

	#save(): void {
		const saved = commitInteractiveSettings(this.callbacks, () => {
			settings.set("statusLine.preset", "custom");
			settings.set("statusLine.leftSegments", [...this.#draft.leftSegments]);
			settings.set("statusLine.rightSegments", [...this.#draft.rightSegments]);
			settings.set("statusLine.separator", this.#draft.separator);
			settings.set(
				"statusLine.segmentOptions",
				cloneSegmentOptions(this.#draft.segmentOptions) as Record<string, unknown>,
			);
		});
		if (!saved) return;
		this.callbacks.onChange("statusLine.preset", "custom");
		this.callbacks.onChange("statusLine.leftSegments", [...this.#draft.leftSegments]);
		this.callbacks.onChange("statusLine.rightSegments", [...this.#draft.rightSegments]);
		this.callbacks.onChange("statusLine.separator", this.#draft.separator);
		this.callbacks.onChange("statusLine.segmentOptions", cloneSegmentOptions(this.#draft.segmentOptions));
		this.#previewHighlightSegment = undefined;
		this.#emitDraftToParentPreview();
		this.done("saved");
	}

	#cancel(): void {
		this.#restorePreview();
		this.done();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const selectUp = kb.matches(data, "tui.select.up");
		const selectDown = kb.matches(data, "tui.select.down");
		const selectConfirm = kb.matches(data, "tui.select.confirm") || data === "\n";
		const selectCancel = kb.matches(data, "tui.select.cancel");
		if (this.#textInput) {
			if (selectCancel) this.#textInput.cancel();
			else if (selectConfirm) this.#textInput.submit();
			else this.#textInput.handleInput(data);
			return;
		}
		if (this.#focus.kind === "choice") {
			if (matchesKey(data, "left")) {
				this.#moveVertical(-1);
				this.#updatePreviewHighlight();
				this.#preview();
				return;
			}
			if (matchesKey(data, "right")) {
				this.#moveVertical(1);
				this.#updatePreviewHighlight();
				this.#preview();
				return;
			}
			if (selectUp) {
				this.#moveChoiceTarget(-1);
				this.#updatePreviewHighlight();
				this.#preview();
				return;
			}
			if (selectDown) {
				this.#moveChoiceTarget(1);
				this.#updatePreviewHighlight();
				this.#preview();
				return;
			}
			if (selectConfirm) {
				this.#applyChoice();
				return;
			}
			if (selectCancel) {
				this.#focus = cloneRootFocus(this.#focus.returnFocus);
				this.#updatePreviewHighlight();
				this.#preview();
				return;
			}
			return;
		}

		if (selectCancel) {
			this.#cancel();
			return;
		}
		if (selectUp) {
			this.#moveVertical(-1);
			this.#updatePreviewHighlight();
			this.#preview();
			return;
		}
		if (selectDown) {
			this.#moveVertical(1);
			this.#updatePreviewHighlight();
			this.#preview();
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#focus.kind === "palette") this.#movePaletteFocus(-1);
			else if (this.#focus.kind === "separator-control" || this.#focus.kind === "option-control")
				this.#moveChoiceControl(-1);
			else if (this.#focus.kind === "confirm" || this.#focus.kind === "exit") {
				this.#focus = this.#focus.kind === "confirm" ? { kind: "exit" } : { kind: "confirm" };
			} else if (this.#picked) this.#movePickedSlot(-1);
			else this.#moveVisibleFocus(-1);
			this.#updatePreviewHighlight();
			this.#preview();
			return;
		}
		if (matchesKey(data, "right")) {
			if (this.#focus.kind === "palette") this.#movePaletteFocus(1);
			else if (this.#focus.kind === "separator-control" || this.#focus.kind === "option-control")
				this.#moveChoiceControl(1);
			else if (this.#focus.kind === "confirm" || this.#focus.kind === "exit") {
				this.#focus = this.#focus.kind === "confirm" ? { kind: "exit" } : { kind: "confirm" };
			} else if (this.#picked) this.#movePickedSlot(1);
			else this.#moveVisibleFocus(1);
			this.#updatePreviewHighlight();
			this.#preview();
			return;
		}
		if (isDeleteKey(data)) {
			this.#hideFocusedSegment();
			return;
		}
		if (selectConfirm) {
			switch (this.#focus.kind) {
				case "statusbar":
					if (this.#picked) this.#dropPicked();
					else this.#pickFocusedStatusbar();
					return;
				case "palette":
					if (this.#picked) this.#dropPickedToPalette();
					else this.#pickFocusedPalette();
					return;
				case "separator-control":
					this.#openChoice("separator", { kind: "separator-control" });
					return;
				case "option-control":
					if (this.#focus.path === "command.command") this.#openCommandInput();
					else this.#openChoice(this.#focus.path, { kind: "option-control", path: this.#focus.path });
					return;
				case "confirm":
					this.#save();
					return;
				case "exit":
					this.#cancel();
					return;
			}
		}
	}
}

function getSettingsTabs(language: UiLanguage): Tab[] {
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			return { id, label: `${icon} ${uiString(language, `settings.tab.${id}`)}` };
		}),
		{ id: "plugins", label: `${theme.icon.package} ${uiString(language, "settings.tab.plugins")}` },
		{ id: "gjc-bundles", label: `${theme.icon.package} ${uiString(language, "settings.tab.gjcBundles")}` },
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
	thinkingLevel: ThinkingLevelValue | undefined;
	/** Available themes */
	availableThemes: string[];
	/** Available model profile names (from the model registry) */
	availableModelProfiles: string[];
	/** Working directory for plugins tab */
	cwd: string;
	/** Whether this terminal can render the pet overlay. */
	petAvailable?: boolean;
	/** Terminal environment used to select unavailable-pet guidance. Omitted in production to use Bun.env. */
	terminalEnv?: NodeJS.ProcessEnv;
	/**
	 * Runtime evidence published by the session for the current activation
	 * generation. Omitted when no session published one, in which case the GJC
	 * Bundles tab honestly reports runtime status as unavailable.
	 */
	gjcRuntimeSnapshot?: GjcRuntimeSnapshotProvider;
	/** Activation generation the published snapshot must match to be merged. */
	gjcActivationGeneration?: number;
}

/** Status line settings subset for preview */
export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	previewHighlightSegment?: StatusLineSegmentId;
	previewHighlightStyle?: "focus" | "selected";
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
	/**
	 * Atomically apply and persist a theme selection. Returns false when the
	 * candidate could not be loaded, leaving the submenu open.
	 */
	onThemeCommit?: (path: "theme.dark" | "theme.light", theme: string, previousTheme: string) => Promise<boolean>;
	/** Called to live-preview the gajae pet skin while browsing the pet setting. */
	onPetPreview?: (mode: string) => void;
	/**
	 * Commit a pet mode through the shared result-returning policy. The policy
	 * rechecks capability immediately before mutation and owns persistence, so
	 * the settings surface never persists `pet.mode` ahead of acceptance.
	 * Returns whether the commit was accepted.
	 */
	onPetCommit?: (mode: string) => boolean;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: (width?: number) => string;
	/** Render a status-line preview for supplied draft settings without mutating the live status line. */
	getStatusLinePreviewForSettings?: (settings: StatusLinePreviewSettings, width?: number) => string;
	/** Render status-line segment groups for supplied draft settings without mutating the live status line. */
	getStatusLinePreviewPartsForSettings?: (
		settings: StatusLinePreviewSettings,
		width?: number,
	) => StatusLinePreviewParts;
	/** Called when plugins change */
	onPluginsChanged?: () => void;
	/** Called when asynchronously rebuilt settings content needs a repaint. */
	onRenderRequested?: () => void;
	/** Create the ordered provider-priority editor for `modelProviderOrder`. */
	createProviderOrderEditor?: (done: () => void) => Container;
	/** Called when an interactive setting cannot be committed. */
	onError?: (message: string) => void;
	/** Called when settings panel is closed */
	onCancel: () => void;
}
function commitInteractiveSettings(callbacks: SettingsCallbacks, commit: () => void): boolean {
	if (!settings.canWriteDurableConfig()) {
		callbacks.onError?.(
			"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
		);
		return false;
	}
	try {
		commit();
		return true;
	} catch (error) {
		if (!settings.canWriteDurableConfig()) {
			callbacks.onError?.(error instanceof Error ? error.message : String(error));
			return false;
		}
		throw error;
	}
}

/**
 * Main tabbed settings selector component.
 * Uses declarative settings definitions from settings-defs.ts.
 */
export class SettingsSelectorComponent extends Container {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#gjcBundleComponent: GjcBundleSettingsComponent | null = null;
	#notificationsEditor: NotificationsSettingsEditorComponent | null = null;
	#statusPreviewContainer: Container | null = null;
	#statusPreviewText: Text | null = null;
	#currentTabId: SettingTab | "plugins" | "gjc-bundles" = "appearance";
	#textInputActive = false;
	#activeProviderOrderEditor: Container | null = null;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
		private readonly notificationsOperations?: NotificationsEditorOperations,
	) {
		super();

		// Add top border
		this.addChild(new DynamicBorder());

		// Tab bar
		this.#tabBar = this.#createTabBar();

		this.addChild(this.#tabBar);

		// Spacer after tab bar
		this.addChild(new Spacer(1));

		// Initialize with first tab
		this.#switchToTab("appearance");

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	#language(): UiLanguage {
		return resolveUiLanguage(settings.get("ui.language"));
	}

	#createTabBar(initialIndex = 0): TabBar {
		const language = this.#language();
		const tabBar = new TabBar(
			uiString(language, "settings.title"),
			getSettingsTabs(language),
			getTabBarTheme(),
			initialIndex,
			uiString(language, "settings.navigationHint"),
		);
		tabBar.onTabChange = () => {
			this.#switchToTab(tabBar.getActiveTab().id as SettingTab | "plugins" | "gjc-bundles");
		};
		return tabBar;
	}

	#refreshTabBarLanguage(): void {
		const previous = this.#tabBar;
		this.#tabBar = this.#createTabBar(previous.getActiveIndex());
		this.replaceChildren(this.children.map(child => (child === previous ? this.#tabBar : child)));
	}

	#switchToTab(tabId: SettingTab | "plugins" | "gjc-bundles"): void {
		if (this.#currentTabId === "notifications" && tabId !== "notifications" && !this.#disposeNotificationsEditor()) {
			return;
		}
		// Release an open provider-order editor (and its context subscriptions)
		// before switching tabs; the submenu's done() never runs on tab change,
		// so without this the abandoned editor's listeners would survive.
		this.#activeProviderOrderEditor?.dispose();
		this.#activeProviderOrderEditor = null;
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
		if (this.#gjcBundleComponent) {
			this.removeChild(this.#gjcBundleComponent);
			this.#gjcBundleComponent.dispose();
			this.#gjcBundleComponent = null;
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
		} else if (tabId === "gjc-bundles") {
			this.#showGjcBundlesTab();
		} else if (tabId === "notifications") {
			this.#showNotificationsTab();
		} else {
			this.#showSettingsTab(tabId);
		}

		// Re-add bottom border
		this.addChild(bottomBorder);
	}

	#disposeNotificationsEditor(): boolean {
		const editor = this.#notificationsEditor;
		if (!editor) return true;
		if (editor.navigationLocked) return false;
		editor.dispose();
		this.removeChild(editor);
		this.#notificationsEditor = null;
		return true;
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
		const language = this.#language();
		const label = def.path === "ui.language" ? uiString(language, "settings.language.label") : def.label;
		const description =
			def.path === "ui.language" ? uiString(language, "settings.language.description") : def.description;

		switch (def.type) {
			case "boolean":
				return {
					id: def.path,
					label,
					description,
					currentValue: currentValue ? "true" : "false",
					values: ["true", "false"],
				};

			case "enum":
				return {
					id: def.path,
					label,
					description,
					currentValue: currentValue as string,
					values: [...def.values],
				};

			case "submenu":
				return {
					id: def.path,
					label,
					description,
					currentValue: this.#getSubmenuCurrentValue(def.path, currentValue),
					submenu: (cv, done) => this.#createSubmenu(def, cv, done),
				};

			case "providerOrder": {
				const createEditor = this.callbacks.createProviderOrderEditor;
				if (!createEditor) return null;
				return {
					id: def.path,
					label,
					description,
					currentValue: `${normalizeProviderOrder(settings.getGlobal("modelProviderOrder") ?? []).length} configured`,
					submenu: (_currentValue, done) => {
						const editor = createEditor(() => {
							this.#activeProviderOrderEditor = null;
							// Rebuild the parent list from current settings so the
							// `${count} configured` summary reflects the editor's
							// persistence before the submenu closes.
							this.#refreshCurrentTabItems();
							done();
						});
						this.#activeProviderOrderEditor = editor;
						return editor;
					},
				};
			}

			case "text":
				return {
					id: def.path,
					label,
					description,
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
		const language = this.#language();
		const title = def.path === "ui.language" ? uiString(language, "settings.language.label") : def.label;

		// Special case: inject runtime options for thinking level
		if (def.path === "defaultThinkingLevel") {
			options = [ThinkingLevel.Off, ...this.context.availableThinkingLevels].map(level => {
				const baseOpt = options.find(o => o.value === level);
				return baseOpt || { value: level, label: level };
			});
		} else if (def.path === "theme.dark" || def.path === "theme.light") {
			options = this.context.availableThemes.map(t => ({ value: t, label: t }));
		} else if (def.path === "modelProfile.default") {
			options = this.context.availableModelProfiles.map(p => ({ value: p, label: p }));
		} else if (def.path === "ui.language") {
			options = [
				{ value: "en", label: uiString(language, "settings.language.english") },
				{ value: "ko", label: uiString(language, "settings.language.korean") },
				{ value: "zh", label: uiString(language, "settings.language.chinese") },
				{ value: "ja", label: uiString(language, "settings.language.japanese") },
			];
		}
		if (def.path === "statusLine.preset") {
			options = options.filter(option => option.value !== "custom");
		}
		let description =
			def.path === "ui.language" ? uiString(language, "settings.language.description") : def.description;
		if (def.path === "pet.mode") {
			currentValue = resolvePetMode(currentValue);
			const petAvailable = this.context.petAvailable ?? isPetAvailable();
			options = createPetSelectItems(options, currentValue, petAvailable);
			// Unsupported terminals must see the same actionable guidance the
			// startup notice and /pet show, not only dimmed option descriptions.
			if (!petAvailable) description = getPetUnavailableWarning(this.context.terminalEnv);
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
		} else if (def.path === "pet.mode") {
			const savedPetMode = currentValue;
			onPreview = value => {
				this.callbacks.onPetPreview?.(value);
			};
			onPreviewCancel = () => {
				this.callbacks.onPetPreview?.(savedPetMode);
			};
		}

		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			title,
			description,
			options,
			currentValue,
			value => {
				if (def.path === "modelProfile.default") {
					this.callbacks.onChange(def.path, value);
					done(value);
					return;
				}
				if (def.path === "theme.dark" || def.path === "theme.light") {
					// The theme commit persists through the controller, so it must honor
					// the same invalid-config guard as every other durable write: report
					// the repair error and leave the submenu open instead of no-oping.
					if (!settings.canWriteDurableConfig()) {
						this.callbacks.onError?.(
							"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
						);
						return;
					}
					if (!this.callbacks.onThemeCommit) return;
					void this.callbacks.onThemeCommit(def.path, value, currentValue).then(accepted => {
						if (accepted) done(value);
					});
					return;
				}
				if (def.path === "pet.mode") {
					// The shared pet commit policy rechecks capability immediately
					// before mutation and persists only on acceptance; the settings
					// surface must not persist ahead of that result.
					let accepted = false;
					if (
						!commitInteractiveSettings(this.callbacks, () => {
							accepted = this.callbacks.onPetCommit?.(value) ?? false;
						})
					) {
						return;
					}
					done(accepted ? value : undefined);
					return;
				}
				if (!commitInteractiveSettings(this.callbacks, () => this.#setSettingValue(def.path, value))) return;
				this.callbacks.onChange(def.path, value);
				if (def.path === "ui.language") this.#refreshTabBarLanguage();
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
				if (!commitInteractiveSettings(this.callbacks, () => this.#setSettingValue(def.path, value))) return;
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

	#showNotificationsTab(): void {
		if (!this.notificationsOperations) return;
		this.#notificationsEditor = new NotificationsSettingsEditorComponent(this.notificationsOperations, {
			onCancel: () => this.callbacks.onCancel(),
		});
		this.addChild(this.#notificationsEditor);
	}

	/**
	 * Show a settings tab using definitions.
	 */
	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(tabId);

		// Add status line preview for appearance tab
		if (tabId === "appearance") {
			this.#statusPreviewContainer = this.#createStatusPreviewContainer();
			this.addChild(this.#statusPreviewContainer);
		}

		this.#currentList = new SettingsList(
			this.#buildItemsForTab(defs, tabId),
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === STATUS_LINE_USAGE_MODE_ID) {
					const segmentOptions = getUsageModeSettings(newValue);
					if (
						!commitInteractiveSettings(this.callbacks, () => {
							settings.set("statusLine.segmentOptions", segmentOptions as Record<string, unknown>);
						})
					) {
						this.#refreshCurrentTabItems(defs);
						return;
					}
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
					if (!commitInteractiveSettings(this.callbacks, () => settings.set(path, boolValue as never))) {
						this.#refreshCurrentTabItems(defs);
						return;
					}
					this.callbacks.onChange(path, boolValue);

					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					if (!commitInteractiveSettings(this.callbacks, () => settings.set(path, newValue as never))) {
						this.#refreshCurrentTabItems(defs);
						return;
					}
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

	#createStatusPreviewContainer(): Container {
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(
			new DynamicThemeText(() => theme.fg("muted", uiString(settings.get("ui.language"), "settings.preview"))),
		);
		this.#statusPreviewText = new Text(this.#getStatusPreviewString(), 0, 0);
		container.addChild(this.#statusPreviewText);
		container.addChild(new Spacer(1));
		return container;
	}

	#hideStatusPreview(): void {
		if (!this.#statusPreviewContainer) return;
		this.removeChild(this.#statusPreviewContainer);
		this.#statusPreviewContainer = null;
		this.#statusPreviewText = null;
	}

	#showStatusPreview(): void {
		if (this.#statusPreviewContainer || this.#currentTabId !== "appearance") return;
		const container = this.#createStatusPreviewContainer();
		this.#statusPreviewContainer = container;
		const children = [...this.children];
		const listIndex = this.#currentList ? children.indexOf(this.#currentList) : -1;
		if (listIndex >= 0) {
			children.splice(listIndex, 0, container);
			this.replaceChildren(children);
		} else {
			this.addChild(container);
		}
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
		let items = this.#buildItemsForDefs(defs);
		if (tabId === "appearance") {
			// Keep the long-standing appearance navigation order stable when new
			// appearance settings are added. The dedicated status-line editor is a
			// sibling of the preset row, so keyboard users do not lose it behind
			// unrelated toggles inserted before the preset.
			const appearanceAnchorIds = [
				"theme.dark",
				"theme.light",
				"ui.language",
				"symbolPreset",
				"colorBlindMode",
				"statusLine.preset",
			];
			const anchorIds = new Set(appearanceAnchorIds);
			const anchoredItems = appearanceAnchorIds
				.map(id => items.find(item => item.id === id))
				.filter((item): item is SettingItem => item !== undefined);
			items = [...anchoredItems, ...items.filter(item => !anchorIds.has(item.id))];

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
					"Edit custom status line segments, placement, separator, and typed segment options in a simulated statusbar.",
				currentValue: "open",
				submenu: (_currentValue, done) => {
					this.#hideStatusPreview();
					return new StatusLineCustomEditor(customEditorCallbacks, value => {
						this.#showStatusPreview();
						done(value);
					});
				},
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
	#refreshCurrentTabItems(defs?: SettingDef[]): void {
		if (this.#currentTabId === "plugins" || this.#currentTabId === "gjc-bundles" || !this.#currentList) return;
		this.#currentList.setItems(
			this.#buildItemsForTab(defs ?? getSettingsForTab(this.#currentTabId), this.#currentTabId),
		);
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
			onRenderRequested: () => this.callbacks.onRenderRequested?.(),
		});
		this.addChild(this.#pluginComponent);
	}
	#showGjcBundlesTab(): void {
		this.#gjcBundleComponent = new GjcBundleSettingsComponent(
			this.context.cwd,
			{
				onClose: () => this.callbacks.onCancel(),
				onBundlesChanged: () => this.callbacks.onPluginsChanged?.(),
				onRenderRequested: () => this.callbacks.onRenderRequested?.(),
			},
			{
				runtimeSnapshotProvider: this.context.gjcRuntimeSnapshot,
				activationGeneration: this.context.gjcActivationGeneration,
			},
		);
		this.addChild(this.#gjcBundleComponent);
	}

	getFocusComponent(): Component {
		return (this.#currentList || this.#pluginComponent || this.#gjcBundleComponent || this.#notificationsEditor)!;
	}

	override dispose(): void {
		if (this.#notificationsEditor?.navigationLocked) return;
		// Release an open provider-order editor (and its context subscriptions)
		// when the whole selector is torn down without a normal close.
		this.#activeProviderOrderEditor?.dispose();
		this.#activeProviderOrderEditor = null;
		this.#notificationsEditor?.dispose();
		this.#notificationsEditor = null;
		this.#gjcBundleComponent?.dispose();
		this.#gjcBundleComponent = null;
		super.dispose();
	}

	handleInput(data: string): void {
		const tabNavigation =
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "left") ||
			matchesKey(data, "right");
		if (this.#notificationsEditor && this.#currentTabId === "notifications") {
			if (tabNavigation) {
				if (this.#notificationsEditor.navigationLocked) {
					this.#notificationsEditor.handleInput(data);
					return;
				}
				this.#tabBar.handleInput(data);
				return;
			}
			this.#notificationsEditor.handleInput(data);
			return;
		}
		if (this.#gjcBundleComponent && this.#currentTabId === "gjc-bundles") {
			if (tabNavigation) {
				if (this.#gjcBundleComponent.navigationLocked) {
					this.#gjcBundleComponent.handleInput(data);
					return;
				}
				this.#tabBar.handleInput(data);
				return;
			}
			this.#gjcBundleComponent.handleInput(data);
			return;
		}

		// Handle tab switching — but NOT when a text input is active, since
		// arrow keys must reach the cursor and Tab must not switch tabs.
		if (!this.#textInputActive && tabNavigation) {
			if (this.#currentList?.navigationLocked) {
				this.#currentList.handleInput(data);
				return;
			}
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
		if (this.#gjcBundleComponent) {
			this.#gjcBundleComponent.handleInput(data);
			return;
		}

		// Fallback for future top-level content that does not own cancellation.
		if (matchesAppInterrupt(data)) {
			this.callbacks.onCancel();
		}
	}
}
