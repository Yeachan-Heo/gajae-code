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
	it("keeps populated confirm precedence when cancel also matches Enter", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.cancel": "enter",
			}),
		);
		const changes: Array<[string, string]> = [];
		let cancelled = false;
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
				cancelled = true;
			},
		);

		list.handleInput("\n");

		expect(changes).toEqual([["mode", "on"]]);
		expect(cancelled).toBe(false);
	});
	it("does not poison selection when navigation arrives while empty", () => {
		const changes: Array<[string, string]> = [];
		const selections: Array<string | undefined> = [];
		const list = new SettingsList(
			[],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				throw new Error("cancel should not be called");
			},
			item => selections.push(item?.id),
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

		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("→ Mode");
		expect(selections.at(-1)).toBe("mode");
		expect(changes).toEqual([["mode", "on"]]);
	});

	it("still allows cancelling an empty list", () => {
		let cancelled = false;
		const list = new SettingsList(
			[],
			5,
			testTheme,
			() => {},
			() => {
				cancelled = true;
			},
		);

		list.handleInput("\x1b");

		expect(cancelled).toBe(true);
	});

	it("clamps selection when a submenu closes after the list shrinks", () => {
		const list = new SettingsList(
			[
				{
					id: "first",
					label: "First",
					currentValue: "open",
				},
				{
					id: "second",
					label: "Second",
					currentValue: "open",
					submenu: (_currentValue, done) => ({
						render: () => ["submenu"],
						handleInput: () => done(),
						invalidate: () => {},
					}),
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);

		list.handleInput("\x1b[B");
		list.handleInput("\n");
		list.setItems([
			{
				id: "only",
				label: "Only",
				currentValue: "open",
			},
		]);
		list.handleInput("\n");

		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("→ Only");
	});
	it("shrinks labels and clamps values at 48 columns", () => {
		const list = new SettingsList(
			[
				{
					id: "long",
					label: "A setting label that exceeds narrow terminals",
					currentValue: "a value that also exceeds narrow terminals",
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);
		for (const line of list.render(48)) expect(Bun.stripANSI(line).length).toBeLessThanOrEqual(48);
	});
});
