import { describe, expect, it } from "bun:test";
import { detectDefaultKeyCollisions, KeybindingsManager, TUI_KEYBINDINGS } from "@gajae-code/tui/keybindings";

describe("KeybindingsManager", () => {
	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		expect(keybindings.getKeys("tui.input.submit")).toEqual(["enter", "ctrl+enter"]);
		expect(keybindings.getKeys("tui.select.confirm")).toEqual(["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		expect(keybindings.getKeys("tui.select.up")).toEqual(["up", "ctrl+p"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["up"]);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		expect(keybindings.getConflicts()).toEqual([
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		expect(keybindings.getKeys("tui.editor.cursorLeft")).toEqual(["left", "ctrl+b"]);
	});

	describe("user binding ownership", () => {
		it("clones array bindings passed to the constructor", () => {
			const bindings = { "tui.select.up": ["down"] as ("down" | "up")[] };
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);

			bindings["tui.select.up"].push("up");

			expect(keybindings.getUserBindings()["tui.select.up"]).toEqual(["down"]);
			expect(keybindings.getKeys("tui.select.up")).toEqual(["down"]);
			expect(keybindings.matches("\x1b[B", "tui.select.up")).toBe(true);
			expect(keybindings.matches("\x1b[A", "tui.select.up")).toBe(false);
		});

		it("clones array bindings passed to setUserBindings", () => {
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
			const bindings = { "tui.select.up": ["down"] as ("down" | "up")[] };

			keybindings.setUserBindings(bindings);
			bindings["tui.select.up"].push("up");

			expect(keybindings.getUserBindings()["tui.select.up"]).toEqual(["down"]);
			expect(keybindings.getKeys("tui.select.up")).toEqual(["down"]);
		});

		it("does not share returned configuration arrays between instances", () => {
			const bindings = { "tui.select.up": ["down"] as ("down" | "up")[] };
			const first = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
			const second = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
			(first.getUserBindings()["tui.select.up"] as string[]).push("up");

			expect(first.getUserBindings()["tui.select.up"]).toEqual(["down"]);
			expect(second.getUserBindings()["tui.select.up"]).toEqual(["down"]);
			expect(first.getKeys("tui.select.up")).toEqual(["down"]);
			expect(second.getKeys("tui.select.up")).toEqual(["down"]);
		});
	});
});

describe("detectDefaultKeyCollisions", () => {
	it("reports keys whose default binding is claimed by more than one action", () => {
		const collisions = detectDefaultKeyCollisions({
			"tui.input.submit": { defaultKeys: "enter", description: "Submit" },
			"tui.select.confirm": { defaultKeys: "enter", description: "Confirm" },
			"tui.editor.cursorUp": { defaultKeys: "up", description: "Up" },
		});

		expect(collisions).toEqual([{ key: "enter", keybindings: ["tui.input.submit", "tui.select.confirm"] }]);
	});

	it("returns no collisions when every default key is unique", () => {
		expect(
			detectDefaultKeyCollisions({
				"a.one": { defaultKeys: "ctrl+a", description: "" },
				"a.two": { defaultKeys: ["ctrl+b", "alt+b"], description: "" },
			}),
		).toEqual([]);
	});

	it("flags the known cross-context default reuse in TUI_KEYBINDINGS", () => {
		const byKey = new Map(detectDefaultKeyCollisions(TUI_KEYBINDINGS).map(c => [c.key, c.keybindings]));
		// enter is intentionally shared by submit + confirm (context-disambiguated).
		expect(byKey.get("enter")).toEqual(expect.arrayContaining(["tui.input.submit", "tui.select.confirm"]));
		// ctrl+c is shared by input copy + select cancel.
		expect(byKey.get("ctrl+c")).toEqual(expect.arrayContaining(["tui.input.copy", "tui.select.cancel"]));
	});
});

describe("tui.global.debug registry action", () => {
	it("resolves to the default Shift+Ctrl+D chord", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
		expect(keybindings.getKeys("tui.global.debug")).toEqual(["shift+ctrl+d"]);
		expect(keybindings.matches("\x1b[100;6u", "tui.global.debug")).toBe(true);
		expect(keybindings.matches("\x04", "tui.global.debug")).toBe(false);
	});

	it("is remappable like any other registry action", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.global.debug": "ctrl+alt+d",
		});
		expect(keybindings.getKeys("tui.global.debug")).toEqual(["ctrl+alt+d"]);
		expect(keybindings.matches("\x1b[100;7u", "tui.global.debug")).toBe(true);
		expect(keybindings.matches("\x1b[100;6u", "tui.global.debug")).toBe(false);
	});
});
