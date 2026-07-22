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

function createInputControllerContext(options: {
	draft?: string;
	pendingImages?: InteractiveModeContext["pendingImages"];
	onSubmit?: (text: string) => Promise<void>;
	delegated?: boolean;
}) {
	let text = options.draft ?? "";
	let overlay: CommandPalette | undefined;
	let executeDelegated: ((name: string) => Promise<void>) | undefined;
	const statuses: string[] = [];
	const editor = {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		onSubmit: options.onSubmit ?? (async () => {}),
	};
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
			hasForegroundBashBackgroundRequestHandler: () => false,
		},
		chatContainer: { children: [] },
		goalModeController: { enabled: false, paused: false, handleCommand: async () => {} },
		planModeController: { enabled: false, handleCommand: async () => {} },
		showError: () => {},
		showStatus: (status: string) => statuses.push(status),
		handleChangelogCommand: options.onSubmit ?? (async () => {}),
		historyStorage: { getRecent: () => [] },
		skillCommands: new Map(),
		pendingImages: options.pendingImages ?? [],
		getSlashCommands: () => [{ name: "changelog", description: "Show changelog" }],
		hasActiveBtw: () => false,
	} as unknown as InteractiveModeContext;
	if (options.delegated) {
		ctx.showCommandPalette = (_commands, _actions, execute) => {
			executeDelegated = execute;
		};
	}
	const controller = new InputController(ctx);
	return {
		controller,
		getText: () => text,
		getOverlay: () => overlay,
		getExecuteDelegated: () => executeDelegated,
		statuses,
	};
}

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

	it("uses the live slash command registry for both palette routes", () => {
		let overlay: CommandPalette | undefined;
		const liveCommands = [
			{ name: "clear", description: "Built-in command" },
			{ name: "extension:demo", description: "Extension command" },
			{ name: "custom:demo", description: "Custom command" },
			{ name: "skill:demo", description: "Demo skill" },
		];
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
			getSlashCommands: () => liveCommands,
			hasActiveBtw: () => false,
		} as unknown as InteractiveModeContext;
		new InputController(ctx).openCommandPalette();
		expect(overlay?.getEntries().map(entry => entry.label)).toEqual(
			expect.arrayContaining(["/clear", "/extension:demo", "/custom:demo", "/skill:demo"]),
		);
		let forwardedCommands: unknown;
		ctx.showCommandPalette = commands => {
			forwardedCommands = commands;
		};
		new InputController(ctx).openCommandPalette();
		expect(forwardedCommands).toEqual(liveCommands);
		expect(forwardedCommands).not.toBe(liveCommands);
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
			goalModeController: { enabled: false, paused: false, handleCommand: async () => {} },
			planModeController: { enabled: false, handleCommand: async () => order.push("execute") },
			showError: () => {},
			showStatus: () => {},
			historyStorage: { getRecent: () => [] },
			skillCommands: new Map(),
			getSlashCommands: () => [{ name: "clear", description: "Clear the session" }],
			hasActiveBtw: () => false,
		} as unknown as InteractiveModeContext;
		new InputController(ctx).openCommandPalette();
		for (const key of "cycle mode") overlay?.handleInput(key);
		overlay?.handleInput("\n");
		await Promise.resolve();
		expect(order).toEqual(["hide", "focus", "execute"]);
	});

	it("dispatches a selected slash command through the canonical controller path", async () => {
		let overlay: CommandPalette | undefined;
		const order: string[] = [];
		const editor = { getText: () => "", setText: () => {} };
		const ctx = {
			editor,
			ui: {
				showOverlay(component: CommandPalette) {
					overlay = component;
					return { hide: () => order.push("hide") };
				},
				setFocus: (target: unknown) => {
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
			},
			chatContainer: { children: [] },
			pendingImages: [],
			goalModeController: { enabled: false, paused: false, handleCommand: async () => {} },
			planModeController: { enabled: false, handleCommand: async () => {} },
			handleChangelogCommand: async () => order.push("execute"),
			showError: () => {},
			showStatus: () => {},
			historyStorage: { getRecent: () => [] },
			skillCommands: new Map(),
			getSlashCommands: () => [{ name: "changelog", description: "Show changelog" }],
			hasActiveBtw: () => false,
		} as unknown as InteractiveModeContext;
		new InputController(ctx).openCommandPalette();
		for (const key of "/changelog") overlay?.handleInput(key);
		overlay?.handleInput("\n");
		await Promise.resolve();
		expect(order).toEqual(["hide", "focus", "execute"]);
	});
	it("preserves drafts when slash commands are selected through either palette route", async () => {
		const local = createInputControllerContext({ draft: "keep this draft" });
		local.controller.openCommandPalette();
		for (const key of "/changelog") local.getOverlay()?.handleInput(key);
		local.getOverlay()?.handleInput("\n");
		await Promise.resolve();
		expect(local.getText()).toBe("keep this draft");
		expect(local.statuses).toEqual(["Send or clear the draft before running a palette command."]);

		const delegated = createInputControllerContext({ draft: "keep this draft", delegated: true });
		delegated.controller.openCommandPalette();
		await delegated.getExecuteDelegated()?.("changelog");
		expect(delegated.getText()).toBe("keep this draft");
		expect(delegated.statuses).toEqual(["Send or clear the draft before running a palette command."]);
	});

	it("rejects overlapping slash command execution through either palette route", async () => {
		let releaseLocal!: () => void;
		const local = createInputControllerContext({
			onSubmit: () => new Promise<void>(resolve => (releaseLocal = resolve)),
		});
		local.controller.openCommandPalette();
		for (const key of "/changelog") local.getOverlay()?.handleInput(key);
		local.getOverlay()?.handleInput("\n");
		local.getOverlay()?.handleInput("\n");
		await Promise.resolve();
		expect(local.statuses).toEqual(["A palette command is still running."]);
		releaseLocal();
		await Promise.resolve();

		let releaseDelegated!: () => void;
		const delegated = createInputControllerContext({
			delegated: true,
			onSubmit: () => new Promise<void>(resolve => (releaseDelegated = resolve)),
		});
		delegated.controller.openCommandPalette();
		const execute = delegated.getExecuteDelegated();
		const first = execute?.("changelog");
		const second = execute?.("changelog");
		await Promise.resolve();
		expect(delegated.statuses).toEqual(["A palette command is still running."]);
		releaseDelegated();
		await Promise.all([first, second]);
	});
});
