import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SettingPath } from "@gajae-code/coding-agent/config/settings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import {
	SettingsSelectorComponent,
	type StatusLinePreviewSettings,
} from "@gajae-code/coding-agent/modes/components/settings-selector";
import { getPreset } from "@gajae-code/coding-agent/modes/components/status-line/presets";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

interface ChangedSetting {
	path: SettingPath;
	value: unknown;
}

interface SelectorOptions {
	getStatusLinePreview?: (width?: number) => string;
	onStatusLinePreview?: (preview: StatusLinePreviewSettings) => void;
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.restoreAllMocks();
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
			onChange: (path, value) => changedSettings.push({ path, value }),
			onStatusLinePreview: preview => {
				previews.push(preview);
				options.onStatusLinePreview?.(preview);
			},
			getStatusLinePreview: width => {
				previewWidths.push(width);
				return options.getStatusLinePreview?.(width) ?? `preview-${width ?? "current"}`;
			},
			onCancel: () => {},
		},
	);
	return { component, previews, changedSettings, previewWidths };
}
function selectCustomEditor(component: SettingsSelectorComponent): void {
	for (let i = 0; i < 5; i++) component.handleInput("\x1b[B");
}

function openCustomEditor(component: SettingsSelectorComponent): void {
	selectCustomEditor(component);
	component.handleInput("\n");
}
describe("SettingsSelectorComponent status line custom editor", () => {
	it("exposes a dedicated Appearance editor", () => {
		const { component } = createSelector();
		selectCustomEditor(component);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Status Line Custom Editor");
	});
	it("keeps Custom out of the generic preset selector", () => {
		const { component } = createSelector();

		for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");

		component.handleInput("\n");

		const presetMenu = Bun.stripANSI(component.render(120).join("\n"));
		expect(presetMenu).toContain("Status Line Preset");
		expect(presetMenu).not.toContain("Custom");
	});
	it("shows usage mode on the appearance tab and persists it", () => {
		settings.set("statusLine.preset", "default");
		settings.set("statusLine.segmentOptions", {});
		const { component, changedSettings, previews } = createSelector();

		for (let i = 0; i < 40; i++) {
			const rendered = Bun.stripANSI(component.render(120).join("\n"));
			if (rendered.includes("❯ Status Line Usage Mode")) break;
			component.handleInput("\x1b[B");
		}

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("❯ Status Line Usage Mode");
		component.handleInput("\n");

		expect(settings.get("statusLine.segmentOptions")).toMatchObject({ usage: { mode: "remaining" } });
		expect(changedSettings.at(-1)).toMatchObject({
			path: "statusLine.segmentOptions",
			value: { usage: { mode: "remaining" } },
		});
		expect(previews.at(-1)?.segmentOptions).toMatchObject({ usage: { mode: "remaining" } });
	});
	it("shows usage mode even when usage is hidden", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model"]);
		settings.set("statusLine.rightSegments", ["context_pct"]);
		const { component } = createSelector();

		for (let i = 0; i < 40; i++) {
			const rendered = Bun.stripANSI(component.render(120).join("\n"));
			if (rendered.includes("❯ Status Line Usage Mode")) break;
			component.handleInput("\x1b[B");
		}

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("❯ Status Line Usage Mode");
	});
	it("seeds custom layout from the active preset, previews segment options, and saves to settings", () => {
		settings.set("statusLine.preset", "minimal");
		settings.set("statusLine.leftSegments", []);
		settings.set("statusLine.rightSegments", []);
		settings.set("statusLine.segmentOptions", { path: { maxLength: 24 }, git: { showUntracked: false } });
		const { component, previews, changedSettings } = createSelector();

		openCustomEditor(component);

		const opened = Bun.stripANSI(component.render(120).join("\n"));
		expect(opened).toContain("Status Line Custom Editor");
		expect(opened).not.toContain("Current width preview");
		expect(opened).not.toContain("Narrow width preview");
		expect(previews.at(-1)).toMatchObject({
			preset: "custom",
			leftSegments: getPreset("minimal").leftSegments,
			rightSegments: getPreset("minimal").rightSegments,
			segmentOptions: { path: { maxLength: 24 }, git: { showUntracked: false } },
		});

		component.handleInput("\n"); // Save custom status line.

		expect(settings.get("statusLine.preset")).toBe("custom");
		expect(settings.get("statusLine.leftSegments")).toEqual(getPreset("minimal").leftSegments);
		expect(settings.get("statusLine.rightSegments")).toEqual(getPreset("minimal").rightSegments);
		expect(changedSettings.map(change => change.path)).toEqual(
			expect.arrayContaining([
				"statusLine.preset",
				"statusLine.leftSegments",
				"statusLine.rightSegments",
				"statusLine.separator",
				"statusLine.segmentOptions",
			]),
		);
	});
	it("refreshes the parent preview while editing and cancelling custom rows", () => {
		settings.set("statusLine.preset", "minimal");
		let renderedPreview = "initial-preview";
		const { component } = createSelector({
			onStatusLinePreview: preview => {
				renderedPreview = `preset:${preview.preset ?? "same"} left:${preview.leftSegments?.join(",") ?? "same"} highlight:${preview.previewHighlightSegment ?? "none"}`;
			},
			getStatusLinePreview: () => renderedPreview,
		});

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("initial-preview");

		openCustomEditor(component);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("preset:custom");

		for (let i = 0; i < 3; i++) component.handleInput("\x1b[B"); // Segment: gajae.
		component.handleInput("\n"); // hidden -> left.
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("left:path,git,gajae");

		component.handleInput("\x1b"); // Cancel restores the parent preview too.
		const restored = Bun.stripANSI(component.render(120).join("\n"));
		expect(restored).toContain("preset:minimal");
		expect(restored).not.toContain("left:path,git,gajae");
	});
	it("keeps the description area height stable while navigating custom rows", () => {
		settings.set("statusLine.preset", "minimal");
		const { component } = createSelector();

		openCustomEditor(component);

		for (let i = 0; i < 5; i++) component.handleInput("\x1b[B"); // Segment: mode.
		const segmentLines = component.render(120).length;
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("❯ Segment: mode");

		component.handleInput("\x1b[B"); // Move left: mode.
		const moveLines = component.render(120).length;
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("❯ Move left: mode");
		expect(moveLines).toBe(segmentLines);
	});
	it("clones preset segment option defaults when saving from a preset", () => {
		settings.set("statusLine.preset", "minimal");
		settings.set("statusLine.segmentOptions", {});
		const minimalSegmentOptions = getPreset("minimal").segmentOptions ?? {};
		const { component, previews } = createSelector();

		openCustomEditor(component);

		expect(previews.at(-1)?.segmentOptions).toEqual(minimalSegmentOptions);

		component.handleInput("\n");

		expect(settings.get("statusLine.segmentOptions")).toEqual(minimalSegmentOptions as Record<string, unknown>);
	});
	it("preserves an intentionally empty saved custom layout", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", []);
		settings.set("statusLine.rightSegments", []);
		const { component, previews } = createSelector();

		openCustomEditor(component);

		expect(previews.at(-1)).toMatchObject({
			preset: "custom",
			leftSegments: [],
			rightSegments: [],
		});

		component.handleInput("\n");

		expect(settings.get("statusLine.leftSegments")).toEqual([]);
		expect(settings.get("statusLine.rightSegments")).toEqual([]);
	});

	it("places usage mode next to the usage segment", () => {
		settings.set("statusLine.preset", "minimal");
		const { component } = createSelector();

		openCustomEditor(component);

		for (let i = 0; i < 80; i++) {
			const rendered = Bun.stripANSI(component.render(120).join("\n"));
			if (rendered.includes("❯ Segment: usage")) break;
			component.handleInput("\x1b[B");
		}

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("❯ Segment: usage");
		component.handleInput("\x1b[B");
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("❯ Usage: mode");
	});

	it("edits segment placement and typed options before saving", () => {
		settings.set("statusLine.preset", "minimal");
		const { component } = createSelector();

		openCustomEditor(component);

		for (let i = 0; i < 3; i++) component.handleInput("\x1b[B");
		component.handleInput("\n"); // Segment: gajae hidden -> left.

		component.handleInput("\x1b[A"); // Move back to the separator row; selection was preserved after refresh.
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Separator");

		component.handleInput("\x1b[A");
		component.handleInput("\x1b[A");
		component.handleInput("\n"); // Save.

		expect(settings.get("statusLine.leftSegments")).toEqual([...getPreset("minimal").leftSegments, "gajae"]);
	});

	it("edits option rows and restores preview on cancel", () => {
		settings.set("statusLine.preset", "minimal");
		const { component, previews } = createSelector();

		openCustomEditor(component);

		component.handleInput("\x1b[A"); // Wrap from Save to Time: show seconds.
		expect(previews.at(-1)?.previewHighlightSegment).toBe("time");
		component.handleInput("\n");
		expect(previews.at(-1)?.segmentOptions?.time?.showSeconds).toBe(true);

		component.handleInput("\x1b"); // Escape from the editor.

		expect(previews.at(-1)).toMatchObject({
			preset: "minimal",
			leftSegments: [],
			rightSegments: [],
		});
		expect(Object.hasOwn(previews.at(-1) ?? {}, "previewHighlightSegment")).toBe(true);
		expect(previews.at(-1)?.previewHighlightSegment).toBeUndefined();
		expect(settings.get("statusLine.preset")).toBe("minimal");
	});
	it("moves segments between sides, reorders within a side, and saves separator changes", () => {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model", "path"]);
		settings.set("statusLine.rightSegments", []);
		settings.set("statusLine.separator", "slash");
		const { component, previews } = createSelector();

		openCustomEditor(component);

		for (let i = 0; i < 9; i++) component.handleInput("\x1b[B");
		component.handleInput("\n"); // Move left: path before model.
		expect(previews.at(-1)?.leftSegments).toEqual(["path", "model"]);

		for (let i = 0; i < 5; i++) component.handleInput("\x1b[A");
		component.handleInput("\n"); // Segment: model left -> right.

		for (let i = 0; i < 2; i++) component.handleInput("\x1b[A");
		component.handleInput("\n"); // Open separator submenu.
		component.handleInput("\x1b[B");
		component.handleInput("\n"); // slash -> pipe.
		expect(previews.at(-1)).toMatchObject({
			leftSegments: ["path"],
			rightSegments: ["model"],
			separator: "pipe",
		});

		component.handleInput("\x1b[A");
		component.handleInput("\x1b[A");
		component.handleInput("\n"); // Save.

		expect(settings.get("statusLine.leftSegments")).toEqual(["path"]);
		expect(settings.get("statusLine.rightSegments")).toEqual(["model"]);
		expect(settings.get("statusLine.separator")).toBe("pipe");
	});
	it("persists approved custom settings across settings reload", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-status-line-settings-"));
		try {
			resetSettingsForTest();
			await Settings.init({ agentDir });
			settings.set("statusLine.preset", "minimal");
			settings.set("statusLine.leftSegments", []);
			settings.set("statusLine.rightSegments", []);
			settings.set("statusLine.segmentOptions", { time: { showSeconds: true } });

			const { component } = createSelector();
			openCustomEditor(component);
			component.handleInput("\n");

			await Bun.sleep(150);

			resetSettingsForTest();
			await Settings.init({ agentDir });

			expect(settings.get("statusLine.preset")).toBe("custom");
			expect(settings.get("statusLine.leftSegments")).toEqual(getPreset("minimal").leftSegments);
			expect(settings.get("statusLine.rightSegments")).toEqual(getPreset("minimal").rightSegments);
			expect(settings.get("statusLine.segmentOptions")).toEqual({
				...getPreset("minimal").segmentOptions,
				time: { showSeconds: true },
			});
		} finally {
			resetSettingsForTest();
			await fs.rm(agentDir, { recursive: true, force: true });
			await Settings.init({ inMemory: true });
		}
	});
});
