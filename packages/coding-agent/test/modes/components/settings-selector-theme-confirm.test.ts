import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { SettingPath } from "@gajae-code/coding-agent/config/settings";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";

import {
	enableAutoTheme,
	getCurrentThemeName,
	getDetectedThemeSettingsPath,
	initTheme,
	onTerminalAppearanceChange,
} from "@gajae-code/coding-agent/modes/theme/theme";

const THEMES = ["red-claw", "blue-crab"];

let testSettings: Settings;

type ChangedSetting = {
	path: SettingPath;
	value: unknown;
};

type SelectorHarness = {
	component: SettingsSelectorComponent;
	previewedThemes: string[];
	restoredThemes: string[];
	changedSettings: ChangedSetting[];
};

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

beforeEach(async () => {
	resetSettingsForTest();
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	enableAutoTheme();
	await settleThemeWork();
	testSettings = await Settings.init({ inMemory: true });
	testSettings.set("theme.dark", "red-claw");
	testSettings.set("theme.light", "blue-crab");
	onTerminalAppearanceChange("dark");
	await settleThemeWork();
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function createSelector(): SelectorHarness {
	const previewedThemes: string[] = [];
	const restoredThemes: string[] = [];
	const changedSettings: ChangedSetting[] = [];
	const component = new SettingsSelectorComponent(
		{
			settings: testSettings,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: THEMES,
			availableModelProfiles: [],
			cwd: process.cwd(),
		},
		{
			onChange: (path, value) => {
				changedSettings.push({ path, value });
			},
			onThemePreview: themeName => {
				previewedThemes.push(themeName);
			},
			onThemePreviewCancel: themeName => {
				restoredThemes.push(themeName);
			},
			onCancel: () => {},
			getStatusLinePreview: () => "status-preview",
		},
	);
	return { component, previewedThemes, restoredThemes, changedSettings };
}

async function settleThemeWork(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Bun.sleep(1);
}

async function createControllerSelector(): Promise<{
	component: SettingsSelectorComponent;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
}> {
	const editorContainer = { clear: vi.fn(), addChild: vi.fn() };
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 120 } },
		editorContainer,
		editor: { getTopBorderAvailableWidth: vi.fn(() => 120) },
		settings: testSettings,
		session: {
			getAvailableThinkingLevels: () => [],
			thinkingLevel: undefined,
			modelRegistry: { getModelProfiles: () => new Map() },
		},
		statusLine: {
			invalidate: vi.fn(),
			updateSettings: vi.fn(),
			getPreviewContent: vi.fn(() => "status-preview"),
		},
		updateEditorTopBorder: vi.fn(),
		showStatus,
		showError,
		restoreComposer: vi.fn(),
		notifyConfigChanged: vi.fn(async () => {}),
		isStopped: () => false,
	} as never;
	const controller = new SelectorController(ctx);
	vi.spyOn(themeModule, "getAvailableThemes").mockResolvedValue(THEMES);

	controller.showSettingsSelector();
	for (let index = 0; index < 20; index += 1) {
		await Bun.sleep(1);
		const component = editorContainer.addChild.mock.calls.at(-1)?.[0];
		if (component instanceof SettingsSelectorComponent) return { component, showStatus, showError };
	}
	throw new Error("Settings selector did not mount.");
}

describe("SettingsSelectorComponent theme selection", () => {
	it("previews a dark theme while browsing without persisting it", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; red-claw is preselected.
		component.handleInput("\x1b[B"); // Browse to blue-crab.

		expect(previewedThemes).toEqual(["blue-crab"]);
		expect(restoredThemes).toEqual([]);
		expect(changedSettings).toEqual([]);
		expect(testSettings.get("theme.dark")).toBe("red-claw");
	});

	it("restores the pre-preview rendered theme on cancel and leaves dark settings unchanged", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; red-claw is preselected.
		component.handleInput("\x1b[B"); // Browse to blue-crab.
		component.handleInput("\x1b"); // Cancel submenu.

		expect(previewedThemes).toEqual(["blue-crab"]);
		expect(restoredThemes).toEqual(["red-claw"]);
		expect(changedSettings).toEqual([]);
		expect(testSettings.get("theme.dark")).toBe("red-claw");
		expect(component.render(120).join("\n")).toContain("red-claw");
	});

	it("persists and displays the selected dark theme only after confirmation", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu.
		component.handleInput("\x1b[B"); // Browse to blue-crab.
		component.handleInput("\n"); // Confirm.

		expect(previewedThemes).toEqual(["blue-crab"]);
		expect(restoredThemes).toEqual([]);
		expect(changedSettings).toEqual([{ path: "theme.dark", value: "blue-crab" }]);
		expect(testSettings.get("theme.dark")).toBe("blue-crab");
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Dark Theme");
		expect(rendered).toContain("blue-crab");
	});

	it("keeps light theme preview independent from persisted light settings", async () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\x1b[B"); // Move from Dark Theme to Light Theme.
		component.handleInput("\n"); // Open Light Theme submenu; blue-crab is preselected.
		component.handleInput("\x1b[B"); // Wrap to red-claw.
		component.handleInput("\x1b"); // Cancel.
		await Bun.sleep(0);

		expect(previewedThemes).toEqual(["red-claw"]);
		expect(restoredThemes).toEqual(["red-claw"]);
		expect(changedSettings).toEqual([]);
		expect(testSettings.get("theme.light")).toBe("blue-crab");

		component.handleInput("\n"); // Reopen Light Theme submenu.
		component.handleInput("\x1b[B"); // Wrap to red-claw.
		component.handleInput("\n"); // Confirm.

		expect(previewedThemes).toEqual(["red-claw", "red-claw"]);
		expect(restoredThemes).toEqual(["red-claw"]);
		expect(changedSettings).toEqual([{ path: "theme.light", value: "red-claw" }]);
		expect(testSettings.get("theme.light")).toBe("red-claw");
	});
	it("confirms active and inactive mappings without disabling auto detection", async () => {
		const { component } = await createControllerSelector();

		component.handleInput("\n"); // Open Dark Theme submenu.
		component.handleInput("\x1b[B"); // Preview blue-crab in the active dark slot.
		await settleThemeWork();

		component.handleInput("\n"); // Confirm the active mapping.
		await settleThemeWork();

		expect(testSettings.get("theme.dark")).toBe("blue-crab");
		expect(getDetectedThemeSettingsPath()).toBe("theme.dark");
		expect(getCurrentThemeName()).toBe("blue-crab");

		component.handleInput("\x1b[B"); // Move to Light Theme while dark remains active.
		component.handleInput("\n");
		component.handleInput("\x1b[B"); // Wrap to red-claw in the light slot.
		await settleThemeWork();

		component.handleInput("\n"); // Confirm the inactive light mapping.
		await settleThemeWork();

		expect(testSettings.get("theme.dark")).toBe("blue-crab");
		expect(testSettings.get("theme.light")).toBe("red-claw");
		expect(getDetectedThemeSettingsPath()).toBe("theme.dark");
		expect(getCurrentThemeName()).toBe("blue-crab");

		onTerminalAppearanceChange("light");
		await settleThemeWork();
		expect(getDetectedThemeSettingsPath()).toBe("theme.light");
		expect(getCurrentThemeName()).toBe("red-claw");
		onTerminalAppearanceChange("dark");
		await settleThemeWork();
		expect(getDetectedThemeSettingsPath()).toBe("theme.dark");
		expect(getCurrentThemeName()).toBe("blue-crab");
	});

	it("restores the old mapping and rendered theme after a durable confirmation failure", async () => {
		const { component, showStatus, showError } = await createControllerSelector();

		component.handleInput("\n");
		component.handleInput("\x1b[B"); // Preview blue-crab in the dark slot.
		await settleThemeWork();
		vi.spyOn(testSettings, "flushOrThrow")
			.mockRejectedValueOnce(new Error("durable write failed"))
			.mockResolvedValue(undefined);

		component.handleInput("\n");
		await settleThemeWork();

		expect(testSettings.get("theme.dark")).toBe("red-claw");
		expect(getCurrentThemeName()).toBe("red-claw");
		expect(component.render(120).join("\n")).toContain("red-claw");
		expect(showStatus).toHaveBeenCalledWith("Theme mapping was not saved: durable write failed");
		expect(showError).toHaveBeenCalledWith("Theme mapping was not saved: durable write failed");
	});

	it("surfaces degraded apply copy when mapping rollback also fails", async () => {
		const { component, showStatus, showError } = await createControllerSelector();

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		await settleThemeWork();
		vi.spyOn(testSettings, "flushOrThrow")
			.mockRejectedValueOnce(new Error("durable write failed"))
			.mockRejectedValueOnce(new Error("rollback failed"));

		component.handleInput("\n");
		await settleThemeWork();

		const degradedCopy = "Theme mapping failed: durable write failed; mapping rollback failed: rollback failed";
		expect(testSettings.get("theme.dark")).toBe("red-claw");
		expect(getCurrentThemeName()).toBe("red-claw");
		expect(showStatus).toHaveBeenCalledWith(degradedCopy);
		expect(showError).toHaveBeenCalledWith(degradedCopy);
	});
});
