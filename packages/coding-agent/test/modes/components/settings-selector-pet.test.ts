import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
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

function openPetSetting(component: SettingsSelectorComponent): void {
	for (let attempt = 0; attempt < 100; attempt++) {
		const rendered = stripVTControlCharacters(component.render(160).join("\n"));
		if (rendered.includes("16x16 real-pixel gajae living beside the composer")) {
			component.handleInput("\n");
			return;
		}
		component.handleInput("\x1b[B");
	}
	throw new Error("Gajae Pet setting was not reachable");
}

describe("SettingsSelectorComponent pet capability", () => {
	it("shows a saved unavailable pet but only permits Off", () => {
		settings.set("pet.mode", "red");
		const onChange = vi.fn();
		const onPetPreview = vi.fn();
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availableModelProfiles: [],
				cwd: process.cwd(),
				petAvailable: false,
			},
			{ onChange, onPetPreview, onCancel: () => {} },
		);

		openPetSetting(component);
		const submenu = stripVTControlCharacters(component.render(80).join("\n"));
		expect(submenu).toContain("RedGajae (saved)");
		expect(submenu).toContain("BlueGajae");
		expect(submenu).toContain("Saved, unavailable");
		expect(stripVTControlCharacters(component.render(40).join("\n"))).toContain("RedGajae (saved)");

		component.handleInput("\x1b[B");
		expect(onPetPreview).not.toHaveBeenCalled();
		component.handleInput("\n");

		expect(onChange).toHaveBeenCalledWith("pet.mode", "off");
		expect(settings.get("pet.mode")).toBe("off");
	});
});
