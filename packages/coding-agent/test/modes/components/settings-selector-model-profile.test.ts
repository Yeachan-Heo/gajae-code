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
			onChange: (path, value) => {
				changedSettings.push({ path, value });
				return onChange?.(path, value);
			},
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

	it("emits profile intent without changing the committed default", () => {
		settings.set("modelProfile.default", "orchestra");
		const { component, changedSettings } = createSelector(["orchestra", "balanced"]);
		focusModelTab(component);

		component.handleInput("\n"); // Open submenu; pre-selected on "orchestra" (index 0).
		component.handleInput("\x1b[B"); // Move to "balanced".
		component.handleInput("\n"); // Confirm.

		expect(settings.get("modelProfile.default")).toBe("orchestra");
		expect(changedSettings).toContainEqual({ path: "modelProfile.default", value: "balanced" });
	});
	it("shows only the committed profile after asynchronous validation fails", async () => {
		settings.set("modelProfile.default", "orchestra");
		const { component } = createSelector(["orchestra", "balanced"], async () => {
			throw new Error("profile validation failed");
		});
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await Bun.sleep(0);

		expect(settings.get("modelProfile.default")).toBe("orchestra");
		expect(component.render(120).join("\n")).toContain("orchestra");
	});
	it("refreshes to the profile committed by asynchronous validation", async () => {
		settings.set("modelProfile.default", "orchestra");
		const pending = Promise.withResolvers<void>();
		const { component } = createSelector(["orchestra", "balanced"], async (_path, value) => {
			await pending.promise;
			settings.set("modelProfile.default", value as string);
		});
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(settings.get("modelProfile.default")).toBe("orchestra");

		pending.resolve();
		await pending.promise;
		await Bun.sleep(0);

		expect(settings.get("modelProfile.default")).toBe("balanced");
		expect(component.render(120).join("\n")).toContain("balanced");
	});
	it("locks profile submissions until the committed selection settles", async () => {
		settings.set("modelProfile.default", "orchestra");
		const pending = Promise.withResolvers<void>();
		const requests: string[] = [];
		const { component } = createSelector(["orchestra", "balanced"], async (_path, value) => {
			requests.push(value as string);
			await pending.promise;
			settings.set("modelProfile.default", value as string);
		});
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n"); // Submit balanced.
		component.handleInput("\x1b[A");
		component.handleInput("\n"); // Ignored while balanced is pending.
		component.handleInput("\x1b"); // Cancellation is also ignored while commit is pending.
		component.handleInput("\x1b[C"); // Tab switching is ignored while commit is pending.

		expect(requests).toEqual(["balanced"]);
		expect(settings.get("modelProfile.default")).toBe("orchestra");
		expect(component.render(120).join("\n")).toContain("balanced");

		pending.resolve();
		await pending.promise;
		await Bun.sleep(0);

		expect(settings.get("modelProfile.default")).toBe("balanced");
		expect(component.render(120).join("\n")).toContain("balanced");
	});
	it("keeps tab switching locked until a failed profile selection settles", async () => {
		settings.set("modelProfile.default", "orchestra");
		const pending = Promise.withResolvers<void>();
		const requests: string[] = [];
		const { component } = createSelector(["orchestra", "balanced"], async (_path, value) => {
			requests.push(value as string);
			await pending.promise;
		});
		focusModelTab(component);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\x1b[C");
		component.handleInput("\t");
		component.handleInput("\n");

		expect(requests).toEqual(["balanced"]);
		expect(component.render(120).join("\n")).toContain("balanced");

		pending.reject(new Error("profile validation failed"));
		await pending.promise.catch(() => {});
		await Bun.sleep(0);

		expect(requests).toEqual(["balanced"]);
		expect(settings.get("modelProfile.default")).toBe("orchestra");
		expect(component.render(120).join("\n")).toContain("orchestra");
	});

	it("falls back to the empty-state message when no profiles are registered", () => {
		const { component } = createSelector([]);
		focusModelTab(component);

		component.handleInput("\n"); // Open Default Model Profile submenu.

		expect(component.render(120).join("\n")).toContain("No matching commands");
	});
});
