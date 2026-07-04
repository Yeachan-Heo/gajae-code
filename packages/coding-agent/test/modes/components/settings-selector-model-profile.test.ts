import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

type ChangedSetting = { path: string; value: unknown };

function createSelector(availableModelProfiles: string[]): {
	component: SettingsSelectorComponent;
	changedSettings: ChangedSetting[];
} {
	const changedSettings: ChangedSetting[] = [];
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availableModelProfiles,
			cwd: process.cwd(),
		},
		{
			onChange: (path, value) => changedSettings.push({ path, value }),
			onCancel: () => {},
		},
	);
	return { component, changedSettings };
}

/** SETTING_TABS puts model at index 1 (after appearance); Default Model Profile is its first row. */
function focusModelTab(comp: SettingsSelectorComponent): void {
	comp.handleInput("\x1b[C");
}

describe("SettingsSelectorComponent Default Model Profile", () => {
	it("injects registry model profiles into the submenu instead of an empty list", () => {
		const { component } = createSelector(["orchestra", "balanced"]);
		focusModelTab(component);

		expect(component.render(120).join("\n")).toContain("Default Model Profile");

		component.handleInput("\n"); // Open Default Model Profile submenu.

		const opened = component.render(120).join("\n");
		expect(opened).toContain("orchestra");
		expect(opened).toContain("balanced");
		expect(opened).not.toContain("No matching commands");
	});

	it("persists the chosen profile to modelProfile.default on confirmation", () => {
		settings.set("modelProfile.default", "orchestra");
		const { component, changedSettings } = createSelector(["orchestra", "balanced"]);
		focusModelTab(component);

		component.handleInput("\n"); // Open submenu; pre-selected on "orchestra" (index 0).
		component.handleInput("\x1b[B"); // Move to "balanced".
		component.handleInput("\n"); // Confirm.

		expect(settings.get("modelProfile.default")).toBe("balanced");
		expect(changedSettings).toContainEqual({ path: "modelProfile.default", value: "balanced" });
	});

	it("falls back to the empty-state message when no profiles are registered", () => {
		const { component } = createSelector([]);
		focusModelTab(component);

		component.handleInput("\n"); // Open Default Model Profile submenu.

		expect(component.render(120).join("\n")).toContain("No matching commands");
	});
});
