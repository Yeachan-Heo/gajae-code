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

function createSelector(
	availableModelProfiles: string[],
	onChange?: (path: string, value: unknown) => void | Promise<void>,
): {
	component: SettingsSelectorComponent;
	changedSettings: ChangedSetting[];
	cancelled: { count: number };
} {
	const changedSettings: ChangedSetting[] = [];
	const cancelled = { count: 0 };
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availableModelProfiles,
			cwd: process.cwd(),
		},
		{
			onChange: (path, value) => {
				changedSettings.push({ path, value });
				return onChange?.(path, value);
			},
			onCancel: () => {
				cancelled.count++;
			},
		},
	);
	return { component, changedSettings, cancelled };
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

	it("delegates profile persistence to activation on confirmation", () => {
		settings.set("modelProfile.default", "orchestra");
		const { component, changedSettings } = createSelector(["orchestra", "balanced"]);
		focusModelTab(component);

		component.handleInput("\n"); // Open submenu; pre-selected on "orchestra" (index 0).
		component.handleInput("\x1b[B"); // Move to "balanced".
		component.handleInput("\n"); // Confirm.

		expect(settings.get("modelProfile.default")).toBe("orchestra");
		expect(changedSettings).toContainEqual({ path: "modelProfile.default", value: "balanced" });
	});

	it("waits for activation and blocks overlapping profile selections", async () => {
		settings.set("modelProfile.default", "orchestra");
		const { promise: activation, resolve: releaseActivation } = Promise.withResolvers<void>();
		const applied: ChangedSetting[] = [];
		const { component } = createSelector(["orchestra", "balanced"], async (path, value) => {
			applied.push({ path, value });
			await activation;
			settings.set("modelProfile.default", value as string);
		});
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\x1b[A");
		component.handleInput("\n");

		expect(applied).toEqual([{ path: "modelProfile.default", value: "balanced" }]);
		expect(settings.get("modelProfile.default")).toBe("orchestra");
		expect(component.render(120).join("\n")).toContain("orchestra");

		releaseActivation();
		await Bun.sleep(0);

		expect(settings.get("modelProfile.default")).toBe("balanced");
		expect(applied).toHaveLength(1);
	});

	it("blocks tab reconstruction while profile activation is pending and allows Escape cancellation", async () => {
		settings.set("modelProfile.default", "orchestra");
		const activation = Promise.withResolvers<void>();
		const applied: ChangedSetting[] = [];
		const { component, cancelled } = createSelector(["orchestra", "balanced"], async (path, value) => {
			applied.push({ path, value });
			await activation.promise;
		});
		focusModelTab(component);
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		component.handleInput("\x1b[C");
		component.handleInput("\t");
		component.handleInput("\n");
		expect(applied).toEqual([{ path: "modelProfile.default", value: "balanced" }]);

		component.handleInput("\x1b");
		expect(cancelled.count).toBe(1);
		activation.resolve();
		await Bun.sleep(0);
		expect(applied).toHaveLength(1);
	});

	it("allows one successful retry after profile activation rejects", async () => {
		settings.set("modelProfile.default", "orchestra");
		let attempts = 0;
		const { component } = createSelector(["orchestra", "balanced"], async (_path, value) => {
			attempts++;
			if (attempts === 1) throw new Error("activation failed");
			settings.set("modelProfile.default", value as string);
		});
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await Bun.sleep(0);

		expect(settings.get("modelProfile.default")).toBe("orchestra");
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("orchestra");
		expect(rendered).toContain("balanced");

		component.handleInput("\n");
		await Bun.sleep(0);
		expect(attempts).toBe(2);
		expect(settings.get("modelProfile.default")).toBe("balanced");
	});

	it("falls back to the empty-state message when no profiles are registered", () => {
		const { component } = createSelector([]);
		focusModelTab(component);

		component.handleInput("\n"); // Open Default Model Profile submenu.

		expect(component.render(120).join("\n")).toContain("No matching commands");
	});
});
