import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

const THEMES = ["red-claw", "anthracite", "light"];

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "light");
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	settings.set("theme.dark", "red-claw");
	settings.set("theme.light", "light");
});

afterEach(() => {
	resetSettingsForTest();
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: THEMES,
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
			getStatusLinePreview: () => "status-preview",
		},
	);
}

describe("SettingsSelectorComponent theme selection", () => {
	it("does not preview or persist a dark theme while browsing, and cancel leaves the displayed value unchanged", () => {
		const comp = createSelector();

		comp.handleInput("\n"); // Open Dark Theme submenu; red-claw is preselected.
		comp.handleInput("\x1b[B"); // Browse to anthracite.

		expect(settings.get("theme.dark")).toBe("red-claw");

		comp.handleInput("\x1b"); // Cancel submenu.

		expect(settings.get("theme.dark")).toBe("red-claw");
		expect(comp.render(120).join("\n")).toContain("red-claw");
	});

	it("persists and displays the selected dark theme only after confirmation", () => {
		const comp = createSelector();

		comp.handleInput("\n"); // Open Dark Theme submenu.
		comp.handleInput("\x1b[B"); // Browse to anthracite.
		comp.handleInput("\n"); // Confirm.

		expect(settings.get("theme.dark")).toBe("anthracite");
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("Dark Theme");
		expect(rendered).toContain("anthracite");
	});

	it("keeps light theme browsing confirm-only as well", () => {
		const comp = createSelector();

		comp.handleInput("\x1b[B"); // Move from Dark Theme to Light Theme.
		comp.handleInput("\n"); // Open Light Theme submenu; light is preselected.
		comp.handleInput("\x1b[B"); // Wrap to red-claw.
		comp.handleInput("\x1b"); // Cancel.

		expect(settings.get("theme.light")).toBe("light");

		comp.handleInput("\n"); // Reopen Light Theme submenu.
		comp.handleInput("\x1b[B"); // Wrap to red-claw.
		comp.handleInput("\n"); // Confirm.

		expect(settings.get("theme.light")).toBe("red-claw");
	});
});
