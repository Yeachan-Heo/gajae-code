import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import type { PluginManager } from "@gajae-code/coding-agent/extensibility/plugins/manager";
import type { InstalledPlugin } from "@gajae-code/coding-agent/extensibility/plugins/types";
import {
	createPluginTextSubmenu,
	PluginDetailComponent,
} from "@gajae-code/coding-agent/modes/components/plugin-settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SettingsList, type SettingsListTheme, setKeybindings } from "@gajae-code/tui";

const theme: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	cursor: "> ",
	hint: text => text,
};

function field(original: string) {
	const changes: unknown[] = [];
	const list = new SettingsList(
		[
			{
				id: "hint",
				label: "Hint",
				currentValue: original,
				submenu: createPluginTextSubmenu("hint", { type: "string", description: "Hint text" }, (_key, value) => {
					changes.push(value);
				}),
			},
		],
		5,
		theme,
		() => {},
		() => {},
	);
	list.handleInput("\n");
	return { list, changes };
}

describe("plugin config text confirm", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("commits the stored multiline plugin string when the display prefill is confirmed", () => {
		for (const original of ["line one\nline two", "line one\r\nline two"]) {
			const { list, changes } = field(original);
			const opened = list.render(80).join("\n");
			expect(opened).toContain("line one line two");
			expect(opened.includes(original)).toBe(false);
			list.handleInput("\x1b");
			expect(changes).toEqual([]);
			list.handleInput("\n");
			list.handleInput("\n");
			expect(changes).toEqual([original]);
		}
	});

	it("commits the stored control-bearing plugin string when the display prefill is confirmed", () => {
		const original = "keep\u001b]52;c;cHduZWQ=\u0007me";
		const { list, changes } = field(original);
		const opened = list.render(80).join("\n");
		expect(opened.includes("\u001b]52")).toBe(false);
		expect(opened).toContain("keepme");
		list.handleInput("\n");
		expect(changes).toEqual([original]);
	});

	it("persists an edited plugin string", () => {
		const original = "line one\nline two";
		const { list, changes } = field(original);
		list.handleInput("!");
		list.handleInput("\n");
		expect(changes).toEqual(["line one line two!"]);
	});

	it("commits the flattened plugin string after an edit returns to the prefill", () => {
		const original = "line one\nline two";
		const { list, changes } = field(original);
		list.handleInput("!");
		list.handleInput("\x7f");
		list.handleInput("\n");
		expect(changes).toEqual(["line one line two"]);
	});

	it("commits a control-bearing plugin string after an edit returns to the safe prefill", () => {
		const original = "keep\u001b]52;c;cHduZWQ=\u0007me";
		const { list, changes } = field(original);
		list.handleInput("x");
		list.handleInput("\x7f");
		list.handleInput("\n");
		expect(changes).toEqual(["keepme"]);
	});

	it("commits the flattened plugin string when delete, paste, and enter arrive together", () => {
		const { list, changes } = field("keep\nme");
		list.handleInput("\x7f\x1b[200~e\x1b[201~\n");
		expect(changes).toEqual(["keep me"]);
	});

	it("commits a pasted plugin string when paste and enter arrive together", () => {
		const { list, changes } = field("old");
		list.handleInput("\x1b[200~NEW\x1b[201~\n");
		expect(changes).toEqual(["oldNEW"]);
	});

	it("leaves an empty plugin field unwritten when the user clears it", () => {
		const original = "hint";
		const { list, changes } = field(original);
		list.handleInput("\x7f");
		list.handleInput("\x7f");
		list.handleInput("\x7f");
		list.handleInput("\x7f");
		list.handleInput("\n");
		expect(changes).toEqual([]);
	});
});

async function confirmPluginEnum(stored: string, values: string[], beforeConfirm: string[] = []): Promise<unknown[]> {
	const changes: unknown[] = [];
	let ready!: () => void;
	const opened = new Promise<void>(resolve => {
		ready = resolve;
	});
	const plugin: InstalledPlugin = {
		name: "demo",
		version: "1.0.0",
		path: "plugin-demo",
		enabled: true,
		enabledFeatures: null,
		manifest: {
			version: "1.0.0",
			settings: {
				mode: { type: "enum", values, description: "Mode" },
			},
		},
	};
	const manager = {
		getPluginSettings: async () => ({ mode: stored }),
	} as unknown as PluginManager;
	const detail = new PluginDetailComponent(plugin, manager, {
		onEnabledChange() {},
		onFeatureChange() {},
		onConfigChange(_key, value) {
			changes.push(value);
		},
		onBack() {},
		onRenderRequested() {
			ready();
		},
	});
	await opened;
	for (const character of "mode") detail.handleInput(character);
	detail.handleInput("\n");
	const shown = detail.render(80);
	for (const line of shown) {
		expect(line.includes("\n")).toBe(false);
		expect(line.includes("\r")).toBe(false);
	}
	for (const key of beforeConfirm) detail.handleInput(key);
	detail.handleInput("\n");
	return changes;
}

describe("plugin enum preselection", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("keeps a stored option that contains a line break when Enter confirms it", async () => {
		const changes = await confirmPluginEnum("line\nbreak", ["first", "line\nbreak"]);
		expect(changes).toEqual(["line\nbreak"]);
	});

	it("keeps an ordinary stored option and can still choose another", async () => {
		expect(await confirmPluginEnum("beta", ["alpha", "beta"])).toEqual(["beta"]);
		expect(await confirmPluginEnum("Line-Break", ["line-break", "Line-Break"])).toEqual(["Line-Break"]);
		expect(await confirmPluginEnum("line-break", ["first", "line-break"])).toEqual(["line-break"]);
		expect(await confirmPluginEnum("line\nbreak", ["first", "line\nbreak"], ["\x1b[B"])).toEqual(["first"]);
	});
});
