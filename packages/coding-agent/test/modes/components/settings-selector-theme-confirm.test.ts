import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { SettingPath } from "@gajae-code/coding-agent/config/settings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme, previewTheme, restoreThemePreview, theme } from "@gajae-code/coding-agent/modes/theme/theme";

const THEMES = ["red-claw", "blue-crab"];
const ORIGINAL_COLORTERM = Bun.env.COLORTERM;

type ChangedSetting = {
	path: SettingPath;
	value: unknown;
};

type SelectorHarness = {
	component: SettingsSelectorComponent;
	previewedThemes: string[];
	restoredThemes: string[];
	changedSettings: ChangedSetting[];
	committedThemes: string[];
};

beforeAll(async () => {
	Bun.env.COLORTERM = "truecolor";
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

afterAll(() => {
	if (ORIGINAL_COLORTERM === undefined) {
		delete Bun.env.COLORTERM;
	} else {
		Bun.env.COLORTERM = ORIGINAL_COLORTERM;
	}
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
	const committedThemes: string[] = [];
	const component = new SettingsSelectorComponent(
		{
			settings: Settings.instance,
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
			onThemeCommit: async (path, themeName) => {
				committedThemes.push(themeName);
				settings.set(path, themeName);
				changedSettings.push({ path, value: themeName });
				return true;
			},
			onCancel: () => {},
			getStatusLinePreview: () => "status-preview",
		},
	);
	return { component, previewedThemes, restoredThemes, changedSettings, committedThemes };
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

	it("recolors the open Settings theme submenu while previewing", async () => {
		const component = new SettingsSelectorComponent(
			{
				settings: Settings.instance,
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: THEMES,
				availableModelProfiles: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {},
				onThemePreview: themeName => previewTheme(themeName).then(() => {}),
				onThemePreviewCancel: themeName => restoreThemePreview(themeName).then(() => {}),
				onCancel: () => {},
				getStatusLinePreview: () => "status-preview",
			},
		);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		await Bun.sleep(1);

		const title = component.render(120).find(line => Bun.stripANSI(line).includes("Dark Theme"));
		expect(title).toContain(theme.getFgAnsi("accent"));
		expect(theme.getFgAnsi("accent")).toBe("\u001b[38;2;94;200;255m");
		await restoreThemePreview("red-claw");
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

	it("keeps a stored dark theme whose name contains a line break or a control", () => {
		for (const name of ["evil\nname", "alpha\u001b]0;x\u0007"]) {
			settings.set("theme.dark", name);
			settings.set("theme.light", "blue-crab");
			const committed: string[] = [];
			const component = new SettingsSelectorComponent(
				{
					settings: Settings.instance,
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["blue-crab", name],
					availableModelProfiles: [],
					cwd: process.cwd(),
				},
				{
					onChange: () => {},
					onThemeCommit: async (path, themeName) => {
						committed.push(themeName);
						settings.set(path, themeName);
						return true;
					},
					onCancel: () => {},
				},
			);
			component.handleInput("\n");
			component.handleInput("\n");
			expect(committed).toEqual([name]);
			expect(settings.get("theme.dark")).toBe(name);
		}
	});

	it("renders a dark theme name with a line break as one row", () => {
		settings.set("theme.dark", "evil\nname");
		const row = Bun.stripANSI(createSelector().component.render(120).join("\n"));
		expect(row).toContain("evil name");
		expect(row.includes("\u001b]0;")).toBe(false);
	});

	it("keeps a stored model profile whose name contains a line break", () => {
		settings.set("modelProfile.default", "line\nbreak");
		const changed: Array<{ path: SettingPath; value: unknown }> = [];
		const component = new SettingsSelectorComponent(
			{
				settings: Settings.instance,
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: THEMES,
				availableModelProfiles: ["alpha", "line\nbreak"],
				cwd: process.cwd(),
			},
			{
				onChange: (path, value) => {
					changed.push({ path, value });
				},
				onCancel: () => {},
			},
		);
		component.handleInput("\x1b[C");
		for (const character of "default model") component.handleInput(character);
		component.handleInput("\n");
		component.handleInput("\n");
		expect(changed.at(-1)).toEqual({ path: "modelProfile.default", value: "line\nbreak" });
	});

	it("keeps an ordinary stored model profile name", () => {
		settings.set("modelProfile.default", "Line-Break");
		const changed: Array<{ path: SettingPath; value: unknown }> = [];
		const component = new SettingsSelectorComponent(
			{
				settings: Settings.instance,
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: THEMES,
				availableModelProfiles: ["line-break", "Line-Break"],
				cwd: process.cwd(),
			},
			{
				onChange: (path, value) => {
					changed.push({ path, value });
				},
				onCancel: () => {},
			},
		);
		component.handleInput("\x1b[C");
		for (const character of "default model") component.handleInput(character);
		component.handleInput("\n");
		component.handleInput("\n");
		expect(changed.at(-1)).toEqual({ path: "modelProfile.default", value: "Line-Break" });
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

	it("keeps the submenu and persisted mapping unchanged when theme confirmation fails", async () => {
		const component = new SettingsSelectorComponent(
			{
				settings: Settings.instance,
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: THEMES,
				availableModelProfiles: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {
					throw new Error("generic change callback must not own theme persistence");
				},
				onThemePreview: () => {},
				onThemePreviewCancel: () => {},
				onThemeCommit: async () => false,
				onCancel: () => {},
			},
		);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await Bun.sleep(1);

		expect(settings.get("theme.dark")).toBe("red-claw");
		expect(component.render(120).join("\n")).toContain("Enter to select");
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
