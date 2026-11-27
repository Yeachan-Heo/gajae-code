import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import {
	SettingsSelectorComponent,
	type StatusLinePreviewSettings,
} from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { setKeybindings } from "@gajae-code/tui";

let testDir: string;
let globalSettings: Settings;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

beforeEach(async () => {
	resetSettingsForTest();
	testDir = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-settings-selector-"));
	globalSettings = await Settings.init({ inMemory: true, cwd: testDir, agentDir: path.join(testDir, "agent") });
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	await fs.rm(testDir, { recursive: true, force: true });
});

function createSelector(
	owner: Settings,
	options: {
		onChange?: (settingPath: string, value: unknown) => void;
		onError?: (message: string) => void;
		getStatusLinePreviewForSettings?: (settings: StatusLinePreviewSettings) => string;
	} = {},
): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			settings: owner,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["red-claw", "blue-crab"],
			availableModelProfiles: [],
			cwd: testDir,
		},
		{
			onChange: options.onChange ?? (() => {}),
			onError: options.onError,
			getStatusLinePreviewForSettings: options.getStatusLinePreviewForSettings,
			onCancel: () => {},
		},
	);
}

function render(component: SettingsSelectorComponent): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

function search(component: SettingsSelectorComponent, text: string): void {
	for (const char of text) component.handleInput(char);
}

describe("scoped settings selector", () => {
	it("reads and writes numeric sampling in the supplied instance, not the singleton", () => {
		globalSettings.set("temperature", 1);
		const owner = Settings.isolated({ temperature: 0.2 });
		const changes: Array<{ path: string; value: unknown }> = [];
		const component = createSelector(owner, { onChange: (path, value) => changes.push({ path, value }) });

		component.handleInput("\x1b[C"); // Model tab.
		search(component, "temperature");
		expect(render(component)).toContain("0.2");
		component.handleInput("\n");
		component.handleInput("\x1b[B"); // 0.2 -> 0.5.
		component.handleInput("\n");

		expect(owner.get("temperature")).toBe(0.5);
		expect(globalSettings.get("temperature")).toBe(1);
		expect(render(component)).toContain("0.5");
		expect(changes).toContainEqual({ path: "temperature", value: "0.5" });
		component.dispose();
	});

	it("evaluates and refreshes schema visibility against the supplied instance", () => {
		globalSettings.set("memory.backend", "off");
		const owner = Settings.isolated({ "memory.backend": "hindsight" });
		const component = createSelector(owner);
		for (let i = 0; i < 4; i++) component.handleInput("\x1b[C");

		expect(render(component)).toContain("Hindsight API URL");
		component.handleInput("\n");
		component.handleInput("\x1b[A");
		component.handleInput("\x1b[A");
		component.handleInput("\n");
		expect(owner.get("memory.backend")).toBe("off");
		expect(globalSettings.get("memory.backend")).toBe("off");
		expect(render(component)).not.toContain("Hindsight API URL");
		component.dispose();
	});

	it("checks the supplied instance's write guard before changing sampling", () => {
		globalSettings.set("temperature", 1);
		const owner = Settings.isolated({ temperature: 0.2 });
		vi.spyOn(owner, "canWriteDurableConfig").mockReturnValue(false);
		const errors: string[] = [];
		const changes: Array<{ path: string; value: unknown }> = [];
		const component = createSelector(owner, {
			onError: message => errors.push(message),
			onChange: (path, value) => changes.push({ path, value }),
		});
		component.handleInput("\x1b[C");
		search(component, "temperature");
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		expect(owner.get("temperature")).toBe(0.2);
		expect(globalSettings.get("temperature")).toBe(1);
		expect(errors).toHaveLength(1);
		expect(changes).toEqual([]);
		component.dispose();
	});

	it("seeds and saves the custom status line from the supplied instance", () => {
		globalSettings.set("statusLine.preset", "minimal");
		globalSettings.set("statusLine.leftSegments", ["git"]);
		const owner = Settings.isolated({
			"statusLine.preset": "custom",
			"statusLine.leftSegments": ["model", "path"],
			"statusLine.rightSegments": [],
			"statusLine.separator": "slash",
		});
		const previews: StatusLinePreviewSettings[] = [];
		const component = createSelector(owner, {
			getStatusLinePreviewForSettings: preview => {
				previews.push(preview);
				return "scoped preview";
			},
		});
		search(component, "status line custom editor");
		component.handleInput("\n");
		render(component);
		expect(previews.at(-1)).toMatchObject({ leftSegments: ["model", "path"], separator: "slash" });
		component.handleInput("\x1b[3~"); // Hide the focused model segment.
		for (let i = 0; i < 80 && !render(component).includes("Focus: confirm"); i++) {
			component.handleInput("\x1b[B");
		}
		expect(render(component)).toContain("Focus: confirm");
		component.handleInput("\n");
		expect(owner.get("statusLine.leftSegments")).toEqual(["path"]);
		expect(owner.get("statusLine.separator")).toBe("slash");
		expect(globalSettings.get("statusLine.preset")).toBe("minimal");
		expect(globalSettings.get("statusLine.leftSegments")).toEqual(["git"]);
		component.dispose();
	});
});
