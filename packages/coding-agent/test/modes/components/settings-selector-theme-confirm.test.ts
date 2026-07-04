import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { SettingPath } from "@gajae-code/coding-agent/config/settings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

const THEMES = ["red-claw", "blue-crab"];

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
	await Settings.init({ inMemory: true });
	settings.set("theme.dark", "red-claw");
	settings.set("theme.light", "blue-crab");
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

describe("SettingsSelectorComponent theme selection", () => {
	it("previews a dark theme while browsing without persisting it", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; red-claw is preselected.
		component.handleInput("\x1b[B"); // Browse to blue-crab.

		expect(previewedThemes).toEqual(["blue-crab"]);
		expect(restoredThemes).toEqual([]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.dark")).toBe("red-claw");
	});

	it("restores the pre-preview rendered theme on cancel and leaves dark settings unchanged", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; red-claw is preselected.
		component.handleInput("\x1b[B"); // Browse to blue-crab.
		component.handleInput("\x1b"); // Cancel submenu.

		expect(previewedThemes).toEqual(["blue-crab"]);
		expect(restoredThemes).toEqual(["red-claw"]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.dark")).toBe("red-claw");
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
		expect(settings.get("theme.dark")).toBe("blue-crab");
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Dark Theme");
		expect(rendered).toContain("blue-crab");
	});

	it("keeps light theme preview independent from persisted light settings", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\x1b[B"); // Move from Dark Theme to Light Theme.
		component.handleInput("\n"); // Open Light Theme submenu; blue-crab is preselected.
		component.handleInput("\x1b[B"); // Wrap to red-claw.
		component.handleInput("\x1b"); // Cancel.

		expect(previewedThemes).toEqual(["red-claw"]);
		expect(restoredThemes).toEqual(["red-claw"]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.light")).toBe("blue-crab");

		component.handleInput("\n"); // Reopen Light Theme submenu.
		component.handleInput("\x1b[B"); // Wrap to red-claw.
		component.handleInput("\n"); // Confirm.

		expect(previewedThemes).toEqual(["red-claw", "red-claw"]);
		expect(restoredThemes).toEqual(["red-claw"]);
		expect(changedSettings).toEqual([{ path: "theme.light", value: "red-claw" }]);
		expect(settings.get("theme.light")).toBe("red-claw");
	});
});
