import { beforeAll, describe, expect, it } from "bun:test";
import { CommandPalette, type CommandPaletteEntry } from "../src/modes/components/command-palette";
import { InputController } from "../src/modes/controllers/input-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const entries: CommandPaletteEntry[] = [
	{ id: "action:app.mode.cycle", label: "Cycle mode", category: "Mode" },
	{ id: "slash:/clear", label: "/clear", category: "Command", description: "Clear the session" },
	{ id: "action:app.unavailable", label: "Unavailable", category: "Session", disabled: true },
];

beforeAll(() => initTheme());

describe("CommandPalette", () => {
	it("fuzzy filters actions, commands, and skills", () => {
		const palette = new CommandPalette(
			entries,
			() => {},
			() => {},
		);
		palette.handleInput("c");
		palette.handleInput("l");
		expect(palette.getEntries().map(entry => entry.id)).toEqual(["slash:/clear", "action:app.mode.cycle"]);
	});

	it("does not select disabled entries and closes on Escape without execution", () => {
		let selected = 0;
		let cancelled = 0;
		const palette = new CommandPalette(
			entries,
			() => selected++,
			() => cancelled++,
		);
		palette.handleInput("u");
		palette.handleInput("n");
		palette.handleInput("a");
		palette.handleInput("v");
		palette.handleInput("a");
		palette.handleInput("i");
		palette.handleInput("l");
		palette.handleInput("a");
		palette.handleInput("b");
		palette.handleInput("l");
		palette.handleInput("e");
		palette.handleInput("\n");
		expect(selected).toBe(0);
		palette.handleInput("\u001b");
		expect(cancelled).toBe(1);
	});

	it("sanitizes untrusted palette text before filtering and rendering, and rejects malformed dispatch ids", () => {
		let selected = 0;
		const palette = new CommandPalette(
			[
				{
					id: "slash:/safe-command",
					label: "Safe\u001b]8;;https://example.test\u0007 label\nnext",
					category: "Plugin\tcommands",
					description: "Find\u001b[999m this\u001b[0m result",
					bindingHint: "Ctrl\r+P",
				},
				{ id: "slash:/unsafe command", label: "Unsafe", category: "Plugin" },
			],
			() => selected++,
			() => {},
		);
		for (const key of "find this result") palette.handleInput(key);
		expect(palette.getEntries()[0]).toMatchObject({
			label: "Safe label next",
			category: "Plugin commands",
			description: "Find this result",
			bindingHint: "Ctrl +P",
		});
		const rendered = palette.render(120);
		expect(Bun.stripANSI(rendered.join("\n"))).toContain("Safe label next");
		expect(rendered.join("\n")).not.toContain("\u001b]8;;https://example.test\u0007");
		expect(rendered.join("\n")).not.toContain("\u001b[999m");
		expect(rendered.join("\n")).not.toContain("\u001b[0m result");
		expect(rendered.every(line => !/[\r\n]/.test(line))).toBe(true);
		palette.handleInput("\n");
		expect(selected).toBe(1);

		const invalid = new CommandPalette(
			[{ id: "slash:/unsafe command", label: "Unsafe", category: "Plugin" }],
			() => selected++,
			() => {},
		);
		invalid.handleInput("\n");
		expect(selected).toBe(1);
	});

	it("keeps the selected result visible while navigating beyond ten rows", () => {
		const palette = new CommandPalette(
			Array.from({ length: 12 }, (_, index) => ({
				id: `command:${index}`,
				label: `Command ${index}`,
				category: "Command",
			})),
			() => {},
			() => {},
		);
		for (let index = 0; index < 10; index++) palette.handleInput("\u001b[B");
		const output = palette.render(80).join("\n");
		expect(output).toContain("Command 10");
		expect(output).not.toContain("Command 0");
	});

	it("uses the resolved slash command catalog for palette entries", () => {
		let overlay: CommandPalette | undefined;
		const ctx = {
			editor: { getText: () => "", setText: () => {}, onSubmit: async () => {} },
			ui: {
				showOverlay: (component: CommandPalette) => {
					overlay = component;
					return { hide: () => {} };
				},
				setFocus: () => {},
				requestRender: () => {},
			},
			keybindings: { getKeys: () => [] },
			settings: { get: (key: string) => key === "plan.enabled" },
			session: {
				model: undefined,
				messages: [],
				queuedMessageCount: 0,
				isStreaming: false,
				getRoleModelCycleCandidateCount: () => 0,
				hasForegroundBashBackgroundRequestHandler: () => false,
			},
			chatContainer: { children: [] },
			goalModeEnabled: false,
			goalModePaused: false,
			handlePlanModeCommand: () => {},
			showError: () => {},
			showStatus: () => {},
			historyStorage: { getRecent: () => [] },
			skillCommands: new Map([["skill:demo", { description: "Demo skill" }]]),
			getSlashCommands: () => [
				{ name: "clear", description: "Built-in command" },
				{ name: "extension:demo", description: "Extension command" },
				{ name: "custom:demo", description: "Custom command" },
				{ name: "skill:demo", description: "Demo skill" },
			],
		} as unknown as InteractiveModeContext;
		new InputController(ctx).openCommandPalette();
		expect(overlay?.getEntries().map(entry => entry.label)).toEqual(
			expect.arrayContaining(["/clear", "/extension:demo", "/custom:demo", "/skill:demo"]),
		);
	});

	it("restores composer focus before executing a selected registry action", async () => {
		const order: string[] = [];
		let overlay: CommandPalette | undefined;
		const editor = { getText: () => "", setText: () => {}, onSubmit: async () => {} };
		const ctx = {
			editor,
			ui: {
				showOverlay(component: CommandPalette) {
					overlay = component;
					return { hide: () => order.push("hide") };
				},
				setFocus(target: unknown) {
					if (target === editor) order.push("focus");
				},
				requestRender: () => {},
			},
			keybindings: { getKeys: () => [] },
			settings: { get: (key: string) => key === "plan.enabled" },
			session: {
				model: undefined,
				messages: [],
				queuedMessageCount: 0,
				isStreaming: false,
				getRoleModelCycleCandidateCount: () => 0,
				hasForegroundBashBackgroundRequestHandler: () => false,
			},
			chatContainer: { children: [] },
			goalModeEnabled: false,
			handlePlanModeCommand: () => order.push("execute"),
			showError: () => {},
			showStatus: () => {},
			historyStorage: { getRecent: () => [] },
			skillCommands: new Map(),
			getSlashCommands: () => [{ name: "clear", description: "Clear the session" }],
		} as unknown as InteractiveModeContext;
		new InputController(ctx).openCommandPalette();
		for (const key of "cycle mode") overlay?.handleInput(key);
		overlay?.handleInput("\n");
		await Promise.resolve();
		expect(order).toEqual(["hide", "focus", "execute"]);
	});

	it("dispatches a selected skill slash command through the composer submit handler", async () => {
		let overlay: CommandPalette | undefined;
		const submitted: string[] = [];
		const editor = { getText: () => "", setText: () => {}, onSubmit: async (text: string) => submitted.push(text) };
		const ctx = {
			editor,
			ui: {
				showOverlay(component: CommandPalette) {
					overlay = component;
					return { hide: () => {} };
				},
				setFocus: () => {},
				requestRender: () => {},
			},
			keybindings: { getKeys: () => [] },
			settings: { get: (key: string) => key === "plan.enabled" },
			session: {
				model: undefined,
				messages: [],
				queuedMessageCount: 0,
				isStreaming: false,
				getRoleModelCycleCandidateCount: () => 0,
			},
			chatContainer: { children: [] },
			goalModeEnabled: false,
			handlePlanModeCommand: () => {},
			showError: () => {},
			showStatus: () => {},
			historyStorage: { getRecent: () => [] },
			skillCommands: new Map([["skill:demo", { description: "Demo skill" }]]),
			getSlashCommands: () => [{ name: "skill:demo", description: "Demo skill" }],
		} as unknown as InteractiveModeContext;
		new InputController(ctx).openCommandPalette();
		for (const key of "/skill:demo") overlay?.handleInput(key);
		overlay?.handleInput("\n");
		await Promise.resolve();
		expect(submitted).toEqual(["/skill:demo"]);
	});
});
