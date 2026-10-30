import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import type { StatusLinePreviewSettings } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

export type StatusLineCustomEditorShowcaseStateId =
	| "root-statusbar"
	| "picked-origin-slot"
	| "palette-exact-insert"
	| "separator-control"
	| "separator-choice-focused"
	| "separator-choice-applied"
	| "option-boolean-choice-focused"
	| "option-enum-choice-focused"
	| "option-numeric-choice-focused"
	| "option-choice-applied"
	| "exit-restored"
	| "confirm-persisted"
	| "overflow-two-row-warning"
	| "narrow-cjk";

export interface StatusLineCustomEditorShowcaseEntry {
	stateId: StatusLineCustomEditorShowcaseStateId;
	columns: number;
	rows: number;
	renderMode: "unicode-color" | "ascii-no-color";
}

const BASE_STATES: StatusLineCustomEditorShowcaseStateId[] = [
	"root-statusbar",
	"picked-origin-slot",
	"palette-exact-insert",
	"separator-control",
	"separator-choice-focused",
	"separator-choice-applied",
	"option-boolean-choice-focused",
	"option-enum-choice-focused",
	"option-numeric-choice-focused",
	"option-choice-applied",
	"exit-restored",
	"confirm-persisted",
	"overflow-two-row-warning",
	"narrow-cjk",
];

export const STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES: StatusLineCustomEditorShowcaseEntry[] = [
	...BASE_STATES.filter(stateId => stateId !== "narrow-cjk").map(stateId => ({
		stateId,
		columns: 80,
		rows: 32,
		renderMode: "unicode-color" as const,
	})),
	{ stateId: "overflow-two-row-warning", columns: 48, rows: 40, renderMode: "unicode-color" },
	{ stateId: "narrow-cjk", columns: 48, rows: 40, renderMode: "unicode-color" },
	{ stateId: "root-statusbar", columns: 80, rows: 32, renderMode: "ascii-no-color" },
	{ stateId: "picked-origin-slot", columns: 80, rows: 32, renderMode: "ascii-no-color" },
	{ stateId: "separator-choice-focused", columns: 80, rows: 32, renderMode: "ascii-no-color" },
	{ stateId: "option-boolean-choice-focused", columns: 80, rows: 32, renderMode: "ascii-no-color" },
	{ stateId: "option-enum-choice-focused", columns: 80, rows: 32, renderMode: "ascii-no-color" },
	{ stateId: "option-numeric-choice-focused", columns: 80, rows: 32, renderMode: "ascii-no-color" },
];

export const STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_EXPECTED_ENTRY_COUNT =
	STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES.length;

function openCustomEditor(component: SettingsSelectorComponent): void {
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[B");
	component.handleInput("\n");
}

function render(component: SettingsSelectorComponent, width: number): string {
	return component.render(width).join("\n");
}

function driveUntil(component: SettingsSelectorComponent, width: number, witness: string, limit = 120): void {
	for (let i = 0; i < limit; i++) {
		if (Bun.stripANSI(render(component, width)).includes(witness)) return;
		component.handleInput("\x1b[B");
	}
	throw new Error(
		`Could not reach showcase state ${JSON.stringify(witness)}:\n${Bun.stripANSI(render(component, width))}`,
	);
}

function focusOption(component: SettingsSelectorComponent, width: number, target: string, rightMoves: number): void {
	driveUntil(component, width, "Focus: separator-control");
	for (let i = 0; i < rightMoves; i++) component.handleInput("\x1b[C");
	driveUntil(component, width, `Focus: option:${target}`, 1);
}

function buildComponent(dense = false, cjk = false): SettingsSelectorComponent {
	if (cjk) settings.set("ui.language", "ko");
	settings.set("statusLine.preset", "custom");
	settings.set(
		"statusLine.leftSegments",
		dense ? ["gajae", "hostname", "model", "mode", "path", "git", "pr"] : ["model", "path", "git"],
	);
	settings.set(
		"statusLine.rightSegments",
		dense ? ["session_name", "jobs", "context_pct", "time_spent", "subagents"] : ["session_name", "jobs"],
	);
	settings.set("statusLine.separator", "slash");
	settings.set("statusLine.segmentOptions", { path: { maxLength: 32 }, time: { format: "24h" } });
	let currentPreview = cjk
		? "상태줄 경계 · 意味の境界 · 语义边界"
		: "left=model,path,git right=session_name,jobs separator=slash";
	const formatPreview = (preview: StatusLinePreviewSettings): string =>
		`left=${(preview.leftSegments ?? []).join(",")} right=${(preview.rightSegments ?? []).join(",")} separator=${preview.separator}`;
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["red-claw", "blue-crab"],
			availableModelProfiles: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onStatusLinePreview: preview => {
				if (!cjk) currentPreview = formatPreview(preview);
			},
			getStatusLinePreview: () => currentPreview,
			getStatusLinePreviewForSettings: preview => {
				if (cjk) return "상태줄 경계 · 意味の境界 · 语义边界\n보조 행 · 補助行 · 辅助行";
				if (dense) {
					return `left=${(preview.leftSegments ?? []).join(",")}\nright=${(preview.rightSegments ?? []).join(",")}`;
				}
				return formatPreview(preview);
			},
			...(cjk
				? {}
				: {
						getStatusLinePreviewPartsForSettings: (preview: StatusLinePreviewSettings) => ({
							left: (preview.leftSegments ?? []).map(segment => segment.replace(/_/g, " ")),
							leftIds: preview.leftSegments ?? [],
							right: [...(preview.rightSegments ?? []).map(segment => segment.replace(/_/g, " ")), "v0.16.1"],
							rightIds: [...(preview.rightSegments ?? []), null],
							separator: { left: "|", right: "|" },
						}),
					}),
			onCancel: () => {},
		},
	);
	openCustomEditor(component);
	return component;
}

export async function renderStatusLineCustomEditorShowcase(
	entry: StatusLineCustomEditorShowcaseEntry,
): Promise<string> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, entry.renderMode === "ascii-no-color" ? "ascii" : "unicode", false, "red-claw", "blue-crab");
	const component = buildComponent(
		entry.stateId === "overflow-two-row-warning" || entry.stateId === "narrow-cjk",
		entry.stateId === "narrow-cjk",
	);
	const width = entry.columns;

	switch (entry.stateId) {
		case "picked-origin-slot":
			component.handleInput("\n");
			break;
		case "palette-exact-insert":
			component.handleInput("\x1b[B");
			component.handleInput("\n");
			component.handleInput("\x1b[D");
			component.handleInput("\n");
			break;
		case "separator-control":
			driveUntil(component, width, "Focus: separator-control");
			break;
		case "separator-choice-focused":
			driveUntil(component, width, "Focus: separator-control");
			component.handleInput("\n");
			break;
		case "separator-choice-applied":
			driveUntil(component, width, "Focus: separator-control");
			component.handleInput("\n");
			component.handleInput("\x1b[C");
			component.handleInput("\n");
			break;
		case "option-boolean-choice-focused":
			focusOption(component, width, "model.showThinkingLevel", 1);
			component.handleInput("\n");
			break;
		case "option-enum-choice-focused":
			focusOption(component, width, "time.format", 9);
			component.handleInput("\n");
			break;
		case "option-numeric-choice-focused":
			focusOption(component, width, "path.maxLength", 3);
			component.handleInput("\n");
			break;
		case "option-choice-applied":
			focusOption(component, width, "path.maxLength", 3);
			component.handleInput("\n");
			component.handleInput("\x1b[C");
			component.handleInput("\n");
			break;
		case "exit-restored":
			component.handleInput("\x1b[3~");
			driveUntil(component, width, "Focus: exit");
			component.handleInput("\n");
			break;
		case "confirm-persisted":
			component.handleInput("\x1b[3~");
			driveUntil(component, width, "Focus: confirm");
			component.handleInput("\n");
			break;
		case "overflow-two-row-warning":
		case "narrow-cjk":
			break;
	}

	const text = render(component, width);
	return entry.renderMode === "ascii-no-color" ? Bun.stripANSI(text) : text;
}
