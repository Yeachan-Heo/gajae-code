import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RetiredImageSecretGateError } from "@gajae-code/coding-agent/config/retired-image-secret-gate";
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

function createSelector(settingsInstance: Settings): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			settings: settingsInstance,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availableModelProfiles: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

/** Switch the selector to the memory tab. SETTING_TABS puts memory at index 4 (after appearance/model/interaction/context). */
function focusMemoryTab(comp: SettingsSelectorComponent): void {
	for (let i = 0; i < 4; i++) {
		comp.handleInput("\x1b[C");
	}
}

describe("SettingsSelectorComponent memory tab", () => {
	it("reveals condition-gated Hindsight rows the moment memory.backend changes via the submenu", () => {
		activeSettings.set("memory.backend", "off");
		const comp = createSelector(activeSettings);
		focusMemoryTab(comp);

		const before = comp.render(120).join("\n");
		expect(before).toContain("Memory Backend");
		expect(before).not.toContain("Hindsight API URL");

		// Memory Backend is the only visible row, so it's already selected at index 0.
		// Enter opens the SelectSubmenu pre-positioned on "off"; navigate to "hindsight" (index 2) and confirm.
		comp.handleInput("\n");
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");

		expect(activeSettings.get("memory.backend")).toBe("hindsight");
		const after = comp.render(120).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).toContain("Hindsight API URL");
		expect(after).toContain("Hindsight Auto Recall");
	});
	it("fails closed before selector materialization when the owned config is malformed", async () => {
		const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-selector-recovery-"));
		const agentDir = path.join(testDir, "agent");
		const malformedSecret = "malformed-image-secret";
		fs.mkdirSync(agentDir, { recursive: true });
		resetSettingsForTest();
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`providers:\n  imageCustomKey: ${malformedSecret}\n  invalid: [\n`,
		);

		let cleanupError: unknown;
		let caught: unknown;
		let scopedSettings: Settings | undefined;
		let component: SettingsSelectorComponent | undefined;
		const changes: Array<{ path: string; value: unknown }> = [];
		try {
			try {
				scopedSettings = await Settings.init({ cwd: testDir, agentDir });
				component = new SettingsSelectorComponent(
					{
						settings: scopedSettings,
						availableThinkingLevels: [],
						thinkingLevel: undefined,
						availableThemes: ["blue-crab"],
						availableModelProfiles: [],
						cwd: testDir,
					},
					{
						onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
						onCancel: () => {},
					},
				);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(RetiredImageSecretGateError);
			if (!(caught instanceof RetiredImageSecretGateError)) return;
			expect(caught.source).toBe("global-config");
			expect(caught.code).toBe("RETIRED_IMAGE_SECRET_GATE_BLOCKED");
			expect(caught.message).toBe(
				"Settings startup blocked by an unreadable, malformed, racing, or retired image credential source (global-config).",
			);
			expect(caught.message).not.toContain(malformedSecret);
			expect(scopedSettings).toBeUndefined();
			expect(component).toBeUndefined();
			expect(changes).toEqual([]);
		} finally {
			scopedSettings?.getStorage()?.close();
			try {
				fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") {
					cleanupError = error;
				}
			}
		}
		if (cleanupError) throw cleanupError;
	});

	it("hides Hindsight rows again when the backend is switched back to off without leaving the tab", () => {
		activeSettings.set("memory.backend", "hindsight");
		const comp = createSelector(activeSettings);
		focusMemoryTab(comp);

		expect(comp.render(120).join("\n")).toContain("Hindsight API URL");

		// Open Memory Backend → SelectSubmenu pre-selects the current value
		// ("hindsight" at index 2) → step up twice to reach "off" → Enter confirms.
		comp.handleInput("\n");
		comp.handleInput("\x1b[A");
		comp.handleInput("\x1b[A");
		comp.handleInput("\n");

		expect(activeSettings.get("memory.backend")).toBe("off");
		const after = comp.render(120).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).not.toContain("Hindsight API URL");
		expect(after).not.toContain("Hindsight Auto Recall");
	});
});
