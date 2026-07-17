import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { KEYBINDINGS, KeybindingsManager } from "../src/config/keybindings";
import { ActionRegistry } from "../src/modes/action-registry";
import { CommandPalette } from "../src/modes/components/command-palette";
import { getAvailableActionHints } from "../src/modes/components/tool-status-header";
import { InputController } from "../src/modes/controllers/input-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

beforeAll(() => initTheme());

function createControllerContext(overrides: Partial<InteractiveModeContext> = {}) {
	const editor = { getText: () => "", setText: () => {}, onSubmit: async () => {}, onEscape: () => {} };
	const ui = {
		showOverlay: () => ({ hide: () => {} }),
		setFocus: () => {},
		requestRender: () => {},
	};
	return {
		editor,
		ui,
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
		planModeEnabled: true,
		handlePlanModeCommand: () => {},
		showError: () => {},
		showStatus: () => {},
		historyStorage: { getRecent: () => [] },
		skillCommands: new Map(),
		...overrides,
	} as unknown as InteractiveModeContext;
}

function registerHintAction(
	registry: ActionRegistry<void>,
	id: "app.commandPalette.open" | "app.plan.toggle" | "app.model.select" | "app.history.search" | "app.mode.cycle",
	available: () => boolean,
): void {
	registry.register({
		id,
		title: `Title ${id}`,
		category: "Test",
		bindingId: id,
		domains: ["composer"],
		availability: available,
		execute: () => {},
	});
}

describe("G003 WS2 red-team: command palette", () => {
	it("keeps empty results and disabled rows non-selectable across repeated open/escape cycles", () => {
		let cancelled = 0;
		let selected = 0;
		const palette = new CommandPalette(
			[{ id: "disabled", label: "Unavailable", category: "Test", disabled: true }],
			() => selected++,
			() => cancelled++,
		);
		for (let i = 0; i < 25; i++) palette.handleInput("\u001b");
		expect(cancelled).toBe(25);
		for (const key of "no matching entry") palette.handleInput(key);
		expect(palette.getEntries()).toEqual([]);
		expect(() => palette.handleInput("\n")).not.toThrow();
		expect(selected).toBe(0);
	});

	it("restores composer focus on rapid open/escape cycles", () => {
		let palette: CommandPalette | undefined;
		let hides = 0;
		let editorFocuses = 0;
		const editor = { getText: () => "", setText: () => {}, onSubmit: async () => {}, onEscape: () => {} };
		const ctx = createControllerContext({
			editor: editor as never,
			ui: {
				showOverlay(component: CommandPalette) {
					palette = component;
					return { hide: () => hides++ };
				},
				setFocus(target: unknown) {
					if (target === editor) editorFocuses++;
				},
				requestRender: () => {},
			} as never,
		});
		const controller = new InputController(ctx);
		for (let i = 0; i < 25; i++) {
			controller.openCommandPalette();
			palette?.handleInput("\u001b");
		}
		expect(hides).toBe(25);
		expect(editorFocuses).toBe(25);
	});

	it("handles Unicode filters and long action titles in a 20-column viewport", () => {
		const palette = new CommandPalette(
			[
				{ id: "cjk", label: "設定を開く", category: "ナビゲーション" },
				{
					id: "long",
					label: "An extremely long action title that must not overflow",
					category: "Category",
					description: "Long description",
				},
			],
			() => {},
			() => {},
		);
		for (const key of "設定") palette.handleInput(key);
		expect(palette.getEntries().map(entry => entry.id)).toEqual(["cjk"]);
		const narrow = new CommandPalette(
			[
				{
					id: "long",
					label: "An extremely long action title that must not overflow",
					category: "Category",
					description: "Long description",
				},
			],
			() => {},
			() => {},
		);
		expect(narrow.render(20).every(line => visibleWidth(line) <= 20)).toBe(true);
	});

	it("allows action browsing with a nonempty composer and closes/restores focus before a throwing action reports its error", async () => {
		const statuses: string[] = [];
		const nonempty = createControllerContext({
			editor: { getText: () => "draft", setText: () => {}, onSubmit: async () => {} } as never,
			showStatus: status => statuses.push(status),
		});
		new InputController(nonempty).openCommandPalette();
		expect(statuses).toEqual([]);

		const order: string[] = [];
		let palette: CommandPalette | undefined;
		const editor = { getText: () => "", setText: () => {}, onSubmit: async () => {}, onEscape: () => {} };
		const ctx = createControllerContext({
			editor: editor as never,
			ui: {
				showOverlay(component: CommandPalette) {
					palette = component;
					return { hide: () => order.push("hide") };
				},
				setFocus(target: unknown) {
					if (target === editor) order.push("focus");
				},
				requestRender: () => {},
			} as never,
			handlePlanModeCommand: (() => {
				order.push("execute");
				throw new Error("boom");
			}) as never,
			showError: () => order.push("error"),
		});
		new InputController(ctx).openCommandPalette();
		for (const key of "cycle mode") palette?.handleInput(key);
		palette?.handleInput("\n");
		await Promise.resolve();
		expect(order).toEqual(["hide", "focus", "execute", "error"]);
	});

	it("does not open a palette over an active transcript overlay", () => {
		let overlays = 0;
		const ctx = createControllerContext({
			isTranscriptViewerOpen: () => true,
			ui: {
				showOverlay: () => {
					overlays++;
					return { hide: () => {} };
				},
				setFocus: () => {},
				requestRender: () => {},
			} as never,
		});
		new InputController(ctx).openCommandPalette();
		expect(overlays).toBe(0);
	});
});

describe("G003 WS2 red-team: status hints and mode availability", () => {
	it("has no hint segment with zero available actions, never renders unbound actions, and reflects availability flips", async () => {
		let available = false;
		const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });
		registerHintAction(registry, "app.commandPalette.open", () => available);
		registerHintAction(registry, "app.mode.cycle", () => true);
		const keys = KeybindingsManager.inMemory();
		expect(getAvailableActionHints(registry, () => keys, 80)).toEqual([]);
		available = true;
		await Promise.resolve();
		expect(getAvailableActionHints(registry, () => keys, 80).map(hint => hint.id)).toEqual([
			"app.commandPalette.open",
		]);
	});

	it("truncates only whole hints at width 80 and mode cycle is unavailable without plan mode or during goal mode", async () => {
		const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });
		registerHintAction(registry, "app.commandPalette.open", () => true);
		registerHintAction(registry, "app.plan.toggle", () => true);
		registerHintAction(registry, "app.model.select", () => true);
		registerHintAction(registry, "app.history.search", () => true);
		const hints = getAvailableActionHints(registry, () => KeybindingsManager.inMemory(), 80);
		expect(hints.length).toBeGreaterThan(0);
		expect(hints.every(hint => visibleWidth(hint.content) <= 80)).toBe(true);
		expect(hints.every(hint => KEYBINDINGS[hint.id].defaultKeys.length > 0)).toBe(true);

		for (const [planEnabled, goalModeEnabled, goalModePaused] of [
			[false, false, false],
			[true, true, false],
			[true, false, true],
		] as const) {
			let executed = 0;
			const ctx = createControllerContext({
				settings: { get: (key: string) => key === "plan.enabled" && planEnabled } as never,
				goalModeEnabled,
				goalModePaused,
				handlePlanModeCommand: (() => executed++) as never,
			});
			const controller = new InputController(ctx);
			expect(controller.actionRegistry.isAvailable("app.mode.cycle")).toBe(false);
			expect(await controller.actionRegistry.execute("app.mode.cycle")).toBe(false);
			expect(executed).toBe(0);
		}
	});
});
