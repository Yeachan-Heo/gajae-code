import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
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
		settings.set("memory.backend", "off");
		const comp = createSelector();
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

		expect(settings.get("memory.backend")).toBe("hindsight");
		const after = comp.render(120).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).toContain("Hindsight API URL");
		expect(after).toContain("Hindsight Auto Recall");
	});
	it("reports malformed-YAML repair errors without changing an interactive control", async () => {
		const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-selector-recovery-"));
		const agentDir = path.join(testDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		resetSettingsForTest();
		await Bun.write(path.join(agentDir, "config.yml"), "theme: [");

		const errors: string[] = [];
		const changes: Array<{ path: string; value: unknown }> = [];
		let cleanupError: unknown;
		try {
			await Settings.init({ cwd: testDir, agentDir });
			const component = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["blue-crab"],
					availableModelProfiles: [],
					cwd: testDir,
				},
				{
					onChange: (path, value) => changes.push({ path, value }),
					onError: message => errors.push(message),
					onCancel: () => {},
				},
			);

			component.handleInput("\n");
			component.handleInput("\n");

			expect(errors).toEqual([
				"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
			]);
			expect(changes).toEqual([]);
			expect(settings.get("theme.dark")).toBe("red-claw");
			component.handleInput("\x1b");
			expect(component.render(120).join("\n")).toContain("red-claw");
		} finally {
			Settings.instance.getStorage()?.close();
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
		settings.set("memory.backend", "hindsight");
		const comp = createSelector();
		focusMemoryTab(comp);

		expect(comp.render(120).join("\n")).toContain("Hindsight API URL");

		// Open Memory Backend → SelectSubmenu pre-selects the current value
		// ("hindsight" at index 2) → step up twice to reach "off" → Enter confirms.
		comp.handleInput("\n");
		comp.handleInput("\x1b[A");
		comp.handleInput("\x1b[A");
		comp.handleInput("\n");

		expect(settings.get("memory.backend")).toBe("off");
		const after = comp.render(120).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).not.toContain("Hindsight API URL");
		expect(after).not.toContain("Hindsight Auto Recall");
	});
});
