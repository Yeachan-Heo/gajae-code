import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { formatKeyHints, KEYBINDINGS, KeybindingsManager } from "../src/config/keybindings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { ActionRegistry } from "../src/modes/action-registry";
import { getAvailableActionHints, StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

function createSession() {
	return {
		state: { messages: [] },
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		sessionManager: {
			getSessionName: () => undefined,
			getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function registerAction(
	registry: ActionRegistry<void>,
	id:
		| "app.commandPalette.open"
		| "app.plan.toggle"
		| "app.model.select"
		| "app.history.search"
		| "app.message.queue"
		| "app.message.sendNow",
	available: () => boolean,
): void {
	registry.register({
		id,
		title: {
			"app.commandPalette.open": "Open command palette",
			"app.plan.toggle": "Toggle plan mode",
			"app.model.select": "Select model",
			"app.history.search": "Search history",
			"app.message.queue": "Queue message",
			"app.message.sendNow": "Send message now",
		}[id],
		category: "Test",
		bindingId: id,
		domains: ["composer"],
		availability: available,
		execute: () => {},
	});
}

describe("status line action hints", () => {
	it("uses registry availability and bound KEYBINDINGS chords, truncating whole hints by width", async () => {
		let streaming = false;
		const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });
		registerAction(registry, "app.commandPalette.open", () => !streaming);
		registerAction(registry, "app.plan.toggle", () => !streaming);
		registerAction(registry, "app.model.select", () => !streaming);
		registerAction(registry, "app.history.search", () => !streaming);
		registerAction(registry, "app.message.queue", () => streaming);
		registerAction(registry, "app.message.sendNow", () => streaming);
		const keybindings = KeybindingsManager.inMemory({ "app.message.sendNow": "ctrl+enter" });

		const idle80 = getAvailableActionHints(registry, () => keybindings, 80, "composer");
		const idle120 = getAvailableActionHints(registry, () => keybindings, 120, "composer");
		expect(idle80.length).toBeLessThan(idle120.length);
		expect(idle120.map(hint => hint.id)).toEqual([
			"app.commandPalette.open",
			"app.plan.toggle",
			"app.model.select",
			"app.history.search",
		]);
		const paletteDefault = KEYBINDINGS["app.commandPalette.open"].defaultKeys;
		expect(idle120[0]?.content).toContain(formatKeyHints(paletteDefault));

		const component = new StatusLineComponent(createSession(), {
			actionRegistry: registry,
			getKeybindings: () => keybindings,
		});
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: [],
			separator: "pipe",
			showSkillHud: false,
		});
		const status80 = component.render(80);
		const status120 = component.render(120);
		expect(status80.every(line => visibleWidth(line) <= 80)).toBe(true);
		expect(status120.every(line => visibleWidth(line) <= 120)).toBe(true);
		expect(status80.join("\n")).not.toBe(status120.join("\n"));
		expect(status80.join("\n")).not.toContain("Search history");
		expect(status120.join("\n")).toContain("Search history");

		streaming = true;
		await Promise.resolve();
		const streamingHints = getAvailableActionHints(registry, () => keybindings, 120, "composer");
		expect(streamingHints.map(hint => hint.id)).toEqual(["app.message.sendNow", "app.message.queue"]);
		expect(streamingHints[0]?.content).toContain(keybindings.getDisplayString("app.message.sendNow"));
		expect(streamingHints.map(hint => hint.id)).not.toContain("app.commandPalette.open");
		const streamingStatus = component.render(120).join("\n");
		expect(streamingStatus).toContain("Send message now");
		expect(streamingStatus).toContain("Queue message");
		expect(streamingStatus).not.toContain("Open command palette");
		expect(visibleWidth(streamingStatus)).toBeLessThanOrEqual(120);
	});

	it("hides contextual hints without suppressing configured status segments", () => {
		expect(SETTINGS_SCHEMA["statusLine.showActionHints"].default).toBe(true);
		const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });
		registerAction(registry, "app.model.select", () => true);
		const component = new StatusLineComponent(createSession(), {
			actionRegistry: registry,
			getKeybindings: () => KeybindingsManager.inMemory(),
		});
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["model"],
			separator: "pipe",
			showActionHints: false,
			showSkillHud: false,
		});

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("no-model");
		expect(rendered).not.toContain("Select model");
	});

	it("uses the supplied focus domain when production availability spans composer and selector actions", () => {
		const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });
		registry.register({
			id: "app.commandPalette.open",
			title: "Open command palette",
			category: "Navigation",
			bindingId: "app.commandPalette.open",
			domains: ["composer"],
			availability: () => true,
			execute: () => {},
		});
		registry.register({
			id: "app.session.togglePath",
			title: "Toggle session path",
			category: "Session",
			bindingId: "app.session.togglePath",
			domains: ["selector"],
			availability: () => true,
			execute: () => {},
		});
		const keybindings = KeybindingsManager.inMemory();
		expect(getAvailableActionHints(registry, () => keybindings, 120, "composer").map(hint => hint.id)).toEqual([
			"app.commandPalette.open",
		]);
		expect(getAvailableActionHints(registry, () => keybindings, 120, "selector").map(hint => hint.id)).toEqual([
			"app.session.togglePath",
		]);
	});

	it("preserves configured telemetry before action hints at narrow widths", () => {
		const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });
		registerAction(registry, "app.plan.toggle", () => true);
		const component = new StatusLineComponent(createSession(), {
			actionRegistry: registry,
			getKeybindings: () => KeybindingsManager.inMemory(),
			focusDomain: "composer",
		});
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["model"],
			separator: "pipe",
			showSkillHud: false,
		});
		const narrow = component.render(30).join("\n");
		expect(narrow).toContain("no-model");
		expect(narrow).not.toContain("Toggle plan mode");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(30);
	});
});
