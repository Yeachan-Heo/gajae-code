import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings";

const testTheme: SettingsListTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

describe("SettingsList", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("cycles the selected value when Enter arrives as LF", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[
				{
					id: "mode",
					label: "Mode",
					currentValue: "off",
					values: ["off", "on"],
				},
			],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				throw new Error("cancel should not be called");
			},
		);

		list.handleInput("\n");

		expect(changes).toEqual([["mode", "on"]]);
	});
	it("keeps selection valid after navigation while empty then repopulating", () => {
		const changes: Array<[string, string]> = [];
		let cancelCount = 0;
		const list = new SettingsList(
			[],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				cancelCount += 1;
			},
		);

		list.handleInput("\x1b[A");
		list.handleInput("\x1b[B");
		list.handleInput("\n");
		list.setItems([
			{
				id: "mode",
				label: "Mode",
				currentValue: "off",
				values: ["off", "on"],
			},
		]);
		list.handleInput("\n");

		expect(changes).toEqual([["mode", "on"]]);
		expect(cancelCount).toBe(0);
	});

	it("cancels from an empty list", () => {
		let cancelCount = 0;
		const list = new SettingsList(
			[],
			5,
			testTheme,
			() => {
				throw new Error("change should not be called");
			},
			() => {
				cancelCount += 1;
			},
		);

		expect(list.render(80)).toEqual(["  No settings available"]);
		list.handleInput("\x1b");

		expect(cancelCount).toBe(1);
	});
});
