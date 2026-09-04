import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import type { SettingPath } from "@gajae-code/coding-agent/config/settings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import {
	SettingsSelectorComponent,
	type StatusLinePreviewSettings,
} from "@gajae-code/coding-agent/modes/components/settings-selector";
import { getPreset } from "@gajae-code/coding-agent/modes/components/status-line/presets";
import type { StatusLineSegmentId } from "@gajae-code/coding-agent/modes/components/status-line/types";
import { initTheme, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { setKeybindings } from "@gajae-code/tui";

interface ChangedSetting {
	path: SettingPath;
	value: unknown;
}

interface SelectorOptions {
	disableStatusLineStringPreview?: boolean;
	getStatusLinePreview?: (width?: number) => string;
	getStatusLinePreviewForSettings?: (preview: StatusLinePreviewSettings, width?: number) => string;
	getStatusLinePreviewPartsForSettings?: (
		preview: StatusLinePreviewSettings,
		width?: number,
	) => {
		left: string[];
		leftIds: NonNullable<StatusLinePreviewSettings["leftSegments"]>;
		right: string[];
		rightIds: Array<StatusLineSegmentId | null>;
		separator: { left: string; right: string };
	};
	onStatusLinePreview?: (preview: StatusLinePreviewSettings) => void;
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

function createSelector(options: SelectorOptions = {}) {
	const previews: StatusLinePreviewSettings[] = [];
	const changedSettings: ChangedSetting[] = [];
	const previewWidths: Array<number | undefined> = [];
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["red-claw", "blue-crab"],
			availableModelProfiles: [],
			cwd: process.cwd(),
		},
		{
			onChange: (settingPath, value) => changedSettings.push({ path: settingPath, value }),
			onStatusLinePreview: preview => {
				previews.push(preview);
				options.onStatusLinePreview?.(preview);
			},
			getStatusLinePreview: width => {
				previewWidths.push(width);
				return options.getStatusLinePreview?.(width) ?? `preview-${width ?? "current"}`;
			},
			...(options.disableStatusLineStringPreview
				? {}
				: {
						getStatusLinePreviewForSettings: (preview: StatusLinePreviewSettings, width?: number) =>
							options.getStatusLinePreviewForSettings?.(preview, width) ??
							`ACTUAL left=${preview.leftSegments?.join(",") ?? ""} right=${preview.rightSegments?.join(",") ?? ""} sep=${preview.separator} width=${width ?? "current"}`,
					}),
			getStatusLinePreviewPartsForSettings: options.getStatusLinePreviewPartsForSettings,
			onCancel: () => {},
		},
	);
	return { component, previews, changedSettings, previewWidths };
}

function render(component: SettingsSelectorComponent, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function selectCustomEditor(component: SettingsSelectorComponent): void {
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[B");
}

function openCustomEditor(component: SettingsSelectorComponent): void {
	selectCustomEditor(component);
	component.handleInput("\n");
}

function driveUntil(component: SettingsSelectorComponent, witness: string, limit = 80): void {
	for (let i = 0; i < limit; i++) {
		if (render(component).includes(witness)) return;
		component.handleInput("\x1b[B");
	}
	expect(render(component)).toContain(witness);
}

describe("SettingsSelectorComponent status line custom editor", () => {
	it("opens a simulated statusbar editor instead of legacy segment/move rows", () => {
		settings.set("statusLine.preset", "minimal");
		const { component, previews } = createSelector();

		openCustomEditor(component);
		const output = render(component);

		expect(output).toContain("Status Line Custom Editor");
		expect(output).toContain("Simulated statusbar");
		expect(output).toContain("ACTUAL left=");
		expect(output).toContain("Hidden segment palette");
		expect(output).toContain("Visible choices");
		expect(output).toContain("Separator:");
		expect(output).toContain("Model: show thinking level");
		expect(output).not.toContain("Live preview:");
		expect(output).not.toContain("Segment: gajae");
		expect(output).not.toContain("Move left:");
		expect(output).not.toContain("Move right:");
		expect(output).toContain(getPreset("minimal").leftSegments[0] ?? "model");
		expect(previews).toEqual([]);
	});

	it("routes Left/Right to picked segment movement instead of tab navigation", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		component.handleInput("\n"); // Pick model.
		expect(render(component)).toContain("Selected: model");
		expect(render(component)).not.toContain("Origin left");
		expect(render(component)).not.toContain("Floating ghost");
		expect(render(component)).toContain(" model ");

		component.handleInput("\x1b[C"); // Move the drop slot right; parent tabs must not consume this.
		component.handleInput("\n"); // Drop.

		expect(render(component)).toContain("ACTUAL left=path,model");
		expect(render(component)).toContain("Simulated statusbar");
	});

	it("honors remapped select navigation, confirm, and cancel actions", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component, previews } = createSelector();

		selectCustomEditor(component);
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.up": "f6",
				"tui.select.down": "f7",
				"tui.select.confirm": "f8",
				"tui.select.cancel": "f9",
			}),
		);
		component.handleInput("\x1b[19~"); // F8 opens the editor.
		component.handleInput("\x1b[19~"); // Pick model.
		expect(render(component)).toContain("Selected: model");
		component.handleInput("\x1b[18~"); // F7 moves to the palette.
		expect(render(component)).toContain("Focus: palette:");
		component.handleInput("\x1b[17~"); // F6 returns to the statusbar.
		expect(render(component)).toContain("Focus: statusbar:");
		component.handleInput("\x1b[20~"); // F9 cancels the editor.

		expect(settings.get("statusLine.leftSegments")).toEqual(["model", "path"]);
		expect(previews.at(-1)).toMatchObject({ leftSegments: ["model", "path"] });
	});

	it("adds hidden palette segments at an exact statusbar slot", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["path", "git"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		component.handleInput("\x1b[B"); // Palette.
		expect(render(component)).toContain("Focus: palette:0");
		component.handleInput("\n"); // Pick first hidden segment, gajae.
		component.handleInput("\x1b[D"); // Exact slot between path and git.
		component.handleInput("\n");

		expect(render(component)).toContain("ACTUAL left=path,gajae,git");
	});

	it("hides visible segments with Delete and restores draft changes on Exit", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component, previews } = createSelector();

		openCustomEditor(component);
		component.handleInput("\x1b[3~");
		expect(render(component)).toContain("ACTUAL left=path");
		driveUntil(component, "Focus: exit");
		component.handleInput("\n");

		expect(settings.get("statusLine.leftSegments")).toEqual(["model", "path"]);
		expect(previews.at(-1)).toMatchObject({
			preset: "custom",
			leftSegments: ["model", "path"],
		});
	});

	it("treats forward-delete chords including macOS Fn+Backspace as hide-segment delete", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		component.handleInput("\x04"); // default tui.editor.deleteCharForward, same action as Delete/Fn+Backspace.

		expect(render(component)).toContain("ACTUAL left=path");
		expect(render(component)).not.toContain("ACTUAL left=model,path");
	});

	it("focuses the segment moved to the palette after Delete", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		component.handleInput("\x1b[3~");
		component.handleInput("\n");

		expect(render(component)).toContain("Selected: model");
	});

	it("applies separator and typed segment options through visible choice panels", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model"]);
		settings.set("statusLine.rightSegments", []);
		settings.set("statusLine.separator", "slash");
		settings.set("statusLine.segmentOptions", { path: { maxLength: 32 } });
		const { component } = createSelector();

		openCustomEditor(component);
		driveUntil(component, "Focus: separator-control");
		component.handleInput("\n");
		expect(render(component)).toContain("Choices: Separator");
		component.handleInput("\x1b[B");
		expect(render(component)).toContain(" Model: show thinking level ");
		expect(render(component)).toContain("Choices: Model: show thinking level");
		component.handleInput("\x1b[A");
		expect(render(component)).toContain(" Separator ");
		expect(render(component)).toContain("Choices: Separator");
		component.handleInput("\x1b[C"); // slash -> pipe.
		component.handleInput(" ");
		expect(render(component)).toContain("[Slash]");
		component.handleInput("\x1b");
		expect(render(component)).toContain("[Slash]");
		component.handleInput("\n");
		component.handleInput("\x1b[C"); // slash -> pipe.
		component.handleInput("\n");
		expect(render(component)).toContain("[Pipe]");

		component.handleInput("\x1b[C");
		component.handleInput("\x1b[C");
		component.handleInput("\x1b[C");
		expect(render(component)).toContain("Focus: option:path.maxLength");
		component.handleInput("\n");
		expect(render(component)).toContain("Choices: Path: max length");
		component.handleInput("\x1b[B");
		expect(render(component)).toContain("Choices: Path: strip work prefix");
		component.handleInput("\x1b[A");
		expect(render(component)).toContain("Choices: Path: max length");
		component.handleInput("\x1b[C");
		component.handleInput("\n");
		expect(render(component)).toContain("[40]");
	});

	it("edits custom command values without leaking cancelled text", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["command"]);
		settings.set("statusLine.rightSegments", []);
		settings.set("statusLine.segmentOptions", { command: { command: "" } });
		const { component, changedSettings } = createSelector();

		openCustomEditor(component);
		driveUntil(component, "Focus: separator-control");
		for (let i = 0; i < 12; i++) component.handleInput("\x1b[C");
		expect(render(component)).toContain("Focus: option:command.command");

		component.handleInput("\n");
		expect(render(component)).toContain("Status line command");
		component.handleInput("discarded");
		component.handleInput("\x1b");
		expect(render(component)).toContain("Command: (empty)");

		component.handleInput("\n");
		component.handleInput("printf '界'");
		component.handleInput("\n");
		expect(render(component)).toContain("Command: printf '界'");

		driveUntil(component, "Focus: confirm");
		component.handleInput("\n");
		expect(changedSettings).toContainEqual({
			path: "statusLine.segmentOptions",
			value: expect.objectContaining({ command: { command: "printf '界'" } }),
		});
	});

	it("preserves empty custom layouts and moves a selected segment between statusbar and palette", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", []);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		expect(render(component)).toContain("left (empty)");
		expect(render(component)).toContain("right (empty)");
		component.handleInput("\n"); // Pick palette item into a left drop slot.
		component.handleInput("\x1b[B");
		expect(render(component)).toContain("Focus: palette:0");
		component.handleInput("\x1b[A");
		expect(render(component)).toContain("Focus: statusbar:left:0");
		component.handleInput("\n");

		expect(render(component)).toContain("ACTUAL left=gajae");
		expect(render(component)).toContain("Simulated statusbar");
	});

	it("keeps draft navigation inside the simulated editor instead of updating the real status preview", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component, previews } = createSelector({ getStatusLinePreview: () => "REAL STATUSBAR" });

		openCustomEditor(component);
		component.handleInput("\n");
		component.handleInput("\x1b[C");
		component.handleInput("\n");

		const output = render(component);
		expect(output).toContain("Simulated statusbar");
		expect(output).not.toContain("REAL STATUSBAR");
		expect(previews).toEqual([]);
	});

	it("only marks slot labels dashed when the real simulated statusbar hides that segment", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["gajae", "hostname", "model", "mode", "path", "git"]);
		settings.set("statusLine.rightSegments", ["context_pct", "time_spent"]);
		const { component } = createSelector({
			disableStatusLineStringPreview: true,
			getStatusLinePreviewPartsForSettings: () => ({
				left: ["🦞", "🖥 Suhoui-MacBookAir", "⬢ gpt-5.5", "📁 gajae-code/status-bar-improved", "⑂ branch"],
				leftIds: ["gajae", "hostname", "model", "path", "git"],
				right: ["◫ 5.9%/272K", "⏱ 24.1s", "v0.16.1"],
				rightIds: ["context_pct", "time_spent", null],
				separator: { left: "|", right: "|" },
			}),
		});

		openCustomEditor(component);
		const output = render(component, 120);

		expect(output).toContain("┆ mode ┆");
		expect(output).not.toContain("┆ gajae ┆");
		expect(output).not.toContain("┆ hostname ┆");
		expect(output).not.toContain("┆ path ┆");
		expect(output).not.toContain("┆ git ┆");
		expect(output).toContain("right context pct / time spent / v0.16.1");
	});

	it("uses the simulation width and preserves unknown visibility in string preview fallback", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		let receivedWidth: number | undefined;
		const { component } = createSelector({
			getStatusLinePreviewForSettings: (_preview, width) => {
				receivedWidth = width;
				return `FALLBACK-${width}`;
			},
		});

		openCustomEditor(component);
		const output = render(component, 80);

		expect(receivedWidth).toBe(78);
		expect(output).toContain("FALLBACK-78");
		expect(output).not.toContain("┆ model ┆");
		expect(output).not.toContain("┆ path ┆");
	});

	it("renders distinct left and right preview separators", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", ["jobs", "context_pct"]);
		const { component } = createSelector({
			disableStatusLineStringPreview: true,
			getStatusLinePreviewPartsForSettings: () => ({
				left: ["L1", "L2"],
				leftIds: ["model", "path"],
				right: ["R1", "R2"],
				rightIds: ["jobs", "context_pct"],
				separator: { left: "<", right: ">" },
			}),
		});

		openCustomEditor(component);
		const output = render(component, 120);

		expect(output).toContain("L1 < L2");
		expect(output).toContain("R1 > R2");
	});

	it("does not claim wrapping for a short narrow layout", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector({
			getStatusLinePreviewPartsForSettings: () => ({
				left: ["model"],
				leftIds: ["model"],
				right: [],
				rightIds: [],
				separator: { left: "|", right: "|" },
			}),
		});

		openCustomEditor(component);

		expect(render(component, 48)).not.toContain("Warning: statusbar wrapped to 2 rows");
	});

	it("preserves draft focus and terminal-cell bounds across resize", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", ["jobs"]);
		const { component } = createSelector();

		openCustomEditor(component);
		component.handleInput("\n");
		component.handleInput("\x1b[C");
		for (const width of [48, 120, 64]) {
			const lines = component.render(width);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("Selected: model");
			expect(lines.every(line => Bun.stringWidth(Bun.stripANSI(line)) <= width)).toBe(true);
		}
		component.handleInput("\n");
		expect(render(component)).toContain("ACTUAL left=path,model");
	});

	it("ignores mouse reports without changing keyboard focus or draft", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		const before = render(component);
		component.handleInput("\x1b[<0;10;5M");
		component.handleInput("\x1b[<0;10;5m");

		expect(render(component)).toBe(before);
	});

	it("uses distinct theme roles for focused and selected segments", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		const focusBackground = theme.getFgAnsi("text").replace("\x1b[38;", "\x1b[48;");
		const selectedBackground = theme.getFgAnsi("warning").replace("\x1b[38;", "\x1b[48;");
		expect(component.render(80).join("\n")).toContain(focusBackground);
		component.handleInput("\n");
		expect(component.render(80).join("\n")).toContain(selectedBackground);
		expect(selectedBackground).not.toBe(focusBackground);
	});

	it("keeps repeated resize rendering bounded", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["gajae", "hostname", "model", "mode", "path", "git", "pr"]);
		settings.set("statusLine.rightSegments", ["session_name", "jobs", "context_pct", "time_spent", "subagents"]);
		const { component } = createSelector();
		openCustomEditor(component);

		const started = performance.now();
		for (let i = 0; i < 250; i++) component.render([40, 64, 80, 120][i % 4] ?? 80);
		expect(performance.now() - started).toBeLessThan(1_500);
	});

	it("does not highlight a hidden slot segment when the selected segment moves next to it", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["gajae", "hostname", "model", "mode", "path", "git", "pr"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector({
			getStatusLinePreviewPartsForSettings: () => ({
				left: ["🦞", "🖥 host", "⬢ gpt-5.5", "📁 repo", "⑂ branch"],
				leftIds: ["gajae", "hostname", "model", "path", "git"],
				right: ["v0.16.1"],
				rightIds: [null],
				separator: { left: "|", right: "|" },
			}),
		});

		openCustomEditor(component);
		for (let i = 0; i < 5; i++) component.handleInput("\x1b[C"); // git
		component.handleInput("\n");
		component.handleInput("\x1b[D");
		component.handleInput("\x1b[D");
		const output = render(component, 120);

		expect(output).toContain("> git <");
		expect(output).toContain("┆ mode ┆");
		expect(output).not.toContain("> mode <");
	});

	it("moves selected segment vertically down to palette and up back to statusbar", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		const { component } = createSelector();

		openCustomEditor(component);
		component.handleInput("\n");
		expect(render(component)).toContain("Selected: model");
		expect(render(component)).toContain("Focus: statusbar:left:0");
		expect(render(component)).not.toContain("> {model} <");

		component.handleInput("\x1b[A");
		expect(render(component)).toContain("Focus: statusbar:left:0");
		expect(render(component)).not.toContain("> {model} <");

		component.handleInput("\x1b[B");
		expect(render(component)).toContain("Focus: palette:");
		expect(render(component)).toContain("> {model} <");

		component.handleInput("\x1b[B");
		expect(render(component)).toContain("Focus: palette:");
		expect(render(component)).toContain("> {model} <");

		component.handleInput("\x1b[A");
		expect(render(component)).toContain("Focus: statusbar:left:0");
	});

	it("confirms custom settings and preserves them across settings reload", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-status-line-settings-"));
		try {
			resetSettingsForTest();
			await Settings.init({ agentDir });
			settings.set("statusLine.preset", "custom");
			settings.set("statusLine.leftSegments", ["model", "path"]);
			settings.set("statusLine.rightSegments", []);
			settings.set("statusLine.separator", "slash");
			settings.set("statusLine.segmentOptions", { time: { showSeconds: true } });

			const { component, changedSettings } = createSelector();
			openCustomEditor(component);
			component.handleInput("\x1b[3~");
			driveUntil(component, "Focus: confirm");
			component.handleInput("\n");

			await Bun.sleep(150);

			resetSettingsForTest();
			await Settings.init({ agentDir });

			expect(settings.get("statusLine.preset")).toBe("custom");
			expect(settings.get("statusLine.leftSegments")).toEqual(["path"]);
			expect(settings.get("statusLine.rightSegments")).toEqual([]);
			expect(settings.get("statusLine.separator")).toBe("slash");
			expect(settings.get("statusLine.segmentOptions")).toEqual({ time: { showSeconds: true } });
			expect(changedSettings.map(change => change.path)).toEqual(
				expect.arrayContaining([
					"statusLine.preset",
					"statusLine.leftSegments",
					"statusLine.rightSegments",
					"statusLine.separator",
					"statusLine.segmentOptions",
				]),
			);
		} finally {
			resetSettingsForTest();
			await fs.rm(agentDir, { recursive: true, force: true });
			await Settings.init({ inMemory: true });
		}
	});

	it("normalizes invalid segment entries while preserving opaque option sections", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "future-segment", 42, "", "model"] as never);
		settings.set("statusLine.rightSegments", ["future-segment", "jobs"] as never);
		settings.set("statusLine.segmentOptions", {
			model: { showThinkingLevel: false },
			futurePlugin: { label: "界" },
		});
		const { component, changedSettings } = createSelector();

		openCustomEditor(component);
		const output = render(component);
		expect(output).toContain("future-segment");
		expect(output).toContain("42");
		driveUntil(component, "Focus: confirm");
		component.handleInput("\n");

		expect(changedSettings).toContainEqual({
			path: "statusLine.leftSegments",
			value: ["model", "future-segment", "42"],
		});
		expect(changedSettings).toContainEqual({ path: "statusLine.rightSegments", value: ["jobs"] });
		expect(changedSettings).toContainEqual({
			path: "statusLine.segmentOptions",
			value: expect.objectContaining({ futurePlugin: { label: "界" } }),
		});
	});

	it("renders a two-row overflow warning at narrow width", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["gajae", "hostname", "model", "mode", "path"]);
		settings.set("statusLine.rightSegments", ["session_name", "jobs", "context_pct"]);
		const { component } = createSelector();

		openCustomEditor(component);
		const output = render(component, 48);

		expect(output).toContain("Warning: statusbar wrapped to 2 rows");
		expect(output).toContain("left");
		expect(output).toContain("right");
	});
});
