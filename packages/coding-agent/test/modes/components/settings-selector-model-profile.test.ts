import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import {
	type SettingsMutationResult,
	SettingsSelectorComponent,
} from "@gajae-code/coding-agent/modes/components/settings-selector";
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

function createSelector(
	availableModelProfiles: string[],
	options: {
		profileSelectResult?: SettingsMutationResult;
		onError?: (message: string) => void;
	} = {},
): {
	component: SettingsSelectorComponent;
	changedSettings: ChangedSetting[];
} {
	const changedSettings: ChangedSetting[] = [];
	const component = new SettingsSelectorComponent(
		{
			settings: Settings.instance,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availableModelProfiles,
			cwd: process.cwd(),
		},
		{
			onModelProfileSelect: async (profileName): Promise<SettingsMutationResult> => {
				if (options.profileSelectResult) return options.profileSelectResult;
				Settings.instance.set("modelProfile.default", profileName);
				changedSettings.push({ path: "modelProfile.default", value: profileName });
				return { status: "applied" };
			},
			onModelProfileClear: async (): Promise<SettingsMutationResult> => {
				Settings.instance.unset("modelProfile.default");
				changedSettings.push({ path: "modelProfile.default", value: undefined });
				return { status: "applied" };
			},
			onChange: (path, value) => changedSettings.push({ path, value }),
			onError: options.onError,
			onCancel: () => {},
		},
	);
	return { component, changedSettings };
}

function renderedModelProfileRow(component: SettingsSelectorComponent): string {
	const row = Bun.stripANSI(component.render(120).join("\n"))
		.split("\n")
		.find(line => line.includes("Default Model Profile"));
	if (!row) throw new Error("Default Model Profile row was not rendered");
	return row;
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

	it("persists the chosen profile to modelProfile.default on confirmation", async () => {
		settings.set("modelProfile.default", "orchestra");
		const { component, changedSettings } = createSelector(["orchestra", "balanced"]);
		focusModelTab(component);

		component.handleInput("\n"); // Open submenu; pre-selected on "orchestra" (index 0).
		component.handleInput("\x1b[B"); // Move to "balanced".
		component.handleInput("\n"); // Confirm.
		await Bun.sleep(0);

		expect(settings.get("modelProfile.default")).toBe("balanced");
		expect(changedSettings).toContainEqual({ path: "modelProfile.default", value: "balanced" });
	});

	it("renders the committed profile value immediately after confirmation", async () => {
		settings.set("modelProfile.default", "orchestra");
		const { component } = createSelector(["orchestra", "balanced"]);
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await Bun.sleep(0);

		expect(renderedModelProfileRow(component).trimEnd()).toMatch(/Default Model Profile\s+balanced$/);
	});

	it("clears the saved default to inherit and notifies the clear boundary", async () => {
		settings.set("modelProfile.default", "orchestra");
		const cleared: string[] = [];
		const component = new SettingsSelectorComponent(
			{
				settings: Settings.instance,
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availableModelProfiles: ["orchestra", "balanced"],
				cwd: process.cwd(),
			},
			{
				onChange: (path, value) => {
					if (path === "modelProfile.default" && value === undefined) cleared.push(path);
				},
				onModelProfileClear: async (): Promise<SettingsMutationResult> => {
					Settings.instance.unset("modelProfile.default");
					cleared.push("deactivate", "modelProfile.default");
					return { status: "applied" };
				},
				onCancel: () => {},
			},
		);
		focusModelTab(component);
		component.handleInput("\n");
		component.handleInput("\x1b[A");
		component.handleInput("\n");
		await Bun.sleep(0);

		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(cleared).toEqual(["deactivate", "modelProfile.default"]);
	});

	it("renders the inherited row immediately after a successful clear", async () => {
		settings.set("modelProfile.default", "orchestra");
		const { component } = createSelector(["orchestra", "balanced"]);
		focusModelTab(component);

		component.handleInput("\n");
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("None (inherit)");
		component.handleInput("\x1b[A");
		component.handleInput("\n");
		await Bun.sleep(0);

		const row = renderedModelProfileRow(component);
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(row).not.toContain("orchestra");
		expect(row.trimEnd()).toMatch(/Default Model Profile\s*$/);
	});

	it("keeps the explicit inherit row when no profiles are registered", () => {
		const { component } = createSelector([]);
		focusModelTab(component);

		component.handleInput("\n"); // Open Default Model Profile submenu.

		expect(component.render(120).join("\n")).toContain("None (inherit)");
	});

	it.each([
		["failed", "profile apply failed"],
		["degraded", "profile apply degraded"],
	] as const)("keeps the profile submenu open and truthful for %s results", async (status, error) => {
		settings.set("modelProfile.default", "orchestra");
		const errors: string[] = [];
		const { component } = createSelector(["orchestra", "balanced"], {
			profileSelectResult: { status, error },
			onError: message => errors.push(message),
		});
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await Bun.sleep(0);
		await Bun.sleep(0);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(settings.get("modelProfile.default")).toBe("orchestra");
		expect(errors).toEqual([error]);
		expect(rendered).toContain("Default Model Profile");
		expect(rendered).toContain("balanced");
		expect(rendered).toContain("Enter to select");
	});
});
