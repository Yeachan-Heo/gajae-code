import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

let activeSettings: Settings;

beforeEach(async () => {
	resetSettingsForTest();
	activeSettings = await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function makeComponent(
	settingsInstance: Settings,
	petAvailable: boolean,
	callbacks: Record<string, unknown>,
	terminalEnv?: NodeJS.ProcessEnv,
): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			settings: settingsInstance,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availableModelProfiles: [],
			cwd: process.cwd(),
			petAvailable,
			terminalEnv,
		},
		{ onChange: () => {}, onCancel: () => {}, ...callbacks },
	);
}

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
	it("shows a saved unavailable pet, permits only Off, and routes the commit through the shared policy", () => {
		activeSettings.set("pet.mode", "red");
		const onChange = vi.fn();
		const onPetPreview = vi.fn();
		const onPetCommit = vi.fn((mode: string) => {
			// Simulate the InteractiveMode policy: accept and persist on acceptance.
			activeSettings.set("pet.mode", mode as never);
			return true;
		});
		const component = makeComponent(activeSettings, false, { onChange, onPetPreview, onPetCommit });

		openPetSetting(component);
		const submenu = stripVTControlCharacters(component.render(80).join("\n"));
		expect(submenu).toContain("RedGajae (saved)");
		expect(submenu).toContain("BlueGajae");
		expect(submenu).toContain("Saved, unavailable");
		expect(stripVTControlCharacters(component.render(40).join("\n"))).toContain("RedGajae (saved)");

		component.handleInput("\x1b[B");
		expect(onPetPreview).not.toHaveBeenCalled();
		component.handleInput("\n");

		// The settings surface never persists pet.mode itself and never routes
		// it through the generic onChange path; the shared policy owns both.
		expect(onPetCommit).toHaveBeenCalledWith("off");
		expect(onChange).not.toHaveBeenCalled();
		expect(activeSettings.get("pet.mode")).toBe("off");
	});

	it("shows the actionable unavailable warning inside the pet submenu", () => {
		activeSettings.set("pet.mode", "red");
		const component = makeComponent(activeSettings, false, {}, {});

		openPetSetting(component);
		const submenu = stripVTControlCharacters(component.render(200).join("\n"));

		// Same guidance as startup and /pet (normal-terminal variant in tests);
		// dimmed option descriptions alone are not sufficient.
		expect(submenu).toContain("Ghostty");
	});

	it.each([
		["TMUX", { TMUX: "/tmp/host,1,0" }],
		["tmux TERM", { TERM: "tmux-256color" }],
	])("shows multiplexer recovery guidance for %s without normal-terminal guidance", (_name, terminalEnv) => {
		activeSettings.set("pet.mode", "red");
		const component = makeComponent(activeSettings, false, {}, terminalEnv);

		openPetSetting(component);
		const submenu = stripVTControlCharacters(component.render(200).join("\n"));

		expect(submenu).toContain("outside the multiplexer");
		expect(submenu).toContain("PI_FORCE_IMAGE_PROTOCOL=sixel");
		expect(submenu).not.toContain("Ghostty");
	});

	it("does not persist pet.mode when the commit policy rejects at select time", () => {
		activeSettings.set("pet.mode", "off");
		const onChange = vi.fn();
		// The submenu was built while the capability looked available, but the
		// policy rechecks at commit time and rejects (TOCTOU race).
		const onPetCommit = vi.fn(() => false);
		const component = makeComponent(activeSettings, true, { onChange, onPetCommit });

		openPetSetting(component);
		component.handleInput("\x1b[B"); // move to an enabled skin choice
		component.handleInput("\n");

		expect(onPetCommit).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
		expect(activeSettings.get("pet.mode")).toBe("off");
	});
	it("rejects read-only pet commits before the shared policy can mutate widget state", () => {
		const canWrite = vi.spyOn(activeSettings, "canWriteDurableConfig").mockReturnValue(false);
		const onChange = vi.fn();
		const onError = vi.fn();
		const onPetCommit = vi.fn(() => true);
		try {
			const component = makeComponent(activeSettings, true, { onChange, onError, onPetCommit });

			openPetSetting(component);
			component.handleInput("\x1b[B");
			component.handleInput("\n");

			expect(onError).toHaveBeenCalledWith(
				"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
			);
			expect(onPetCommit).not.toHaveBeenCalled();
			expect(onChange).not.toHaveBeenCalled();
			expect(activeSettings.get("pet.mode")).toBe("off");
		} finally {
			canWrite.mockRestore();
		}
	});
});
