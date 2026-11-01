import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai/core";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@gajae-code/tui";
import type { AutoroutingSetup } from "../src/config/autorouting-contract";
import { KeybindingsManager } from "../src/config/keybindings";
import { Settings } from "../src/config/settings";
import { type SmartRoutingIntent, SmartRoutingPanelComponent } from "../src/modes/components/smart-routing-panel";
import { initTheme } from "../src/modes/theme/theme";
import {
	createRoutingSettingsService,
	RoutingSettingsConfirmationRequiredError,
	type RoutingSettingsPreview,
} from "../src/sdk/routing-settings";

const setup: AutoroutingSetup = { schema: 1, providers: ["anthropic", "openai-codex"] };
const catalog = [
	{
		provider: "anthropic",
		id: "claude-haiku-4-5",
		name: "Haiku",
		api: "anthropic-messages",
		contextWindow: 1000,
		maxTokens: 1000,
	},
	{
		provider: "openai-codex",
		id: "gpt-5.6-terra",
		name: "Terra",
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
	},
] as Model[];

beforeAll(async () => {
	await initTheme(false);
});
let previousKeybindings: TuiKeybindingsManager;
beforeEach(() => {
	previousKeybindings = getKeybindings();
	setKeybindings(KeybindingsManager.inMemory());
});
afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("smart-routing keyboard confirmation", () => {
	function fixture() {
		const settings = Settings.isolated();
		let currentCatalog = catalog;
		let order = [...setup.providers];
		let generationFails = false;
		const guards: RoutingSettingsPreview[] = [];
		const routing = createRoutingSettingsService({
			settings,
			getCatalog: () => currentCatalog,
			getProviderOrder: () => order,
			isScoped: () => false,
		});
		const intents: SmartRoutingIntent[] = [];
		const pending: { callback?: Promise<RoutingSettingsPreview | undefined> } = {};
		const currentCallback = (): Promise<RoutingSettingsPreview | undefined> | undefined => pending.callback;
		const initialPreview = routing.previewSmartRouting(setup);
		const panel = new SmartRoutingPanelComponent({
			setup,
			enabled: false,
			readOnly: false,
			stale: false,
			preview: initialPreview,
			generatePreview: draft => {
				if (generationFails) throw new Error("generator unavailable");
				return routing.previewSmartRouting(draft);
			},
			discardPreview: preview => routing.discardPreview(preview),
			onSelect: intent => {
				intents.push(intent);
				pending.callback = (async () => {
					try {
						if (intent.kind === "apply") return (await routing.applySmartRouting(intent.draft, intent)).preview;
						if (intent.kind === "refresh") return (await routing.refreshSmartRouting(intent)).preview;
						throw new Error("Unexpected intent");
					} catch (error) {
						if (error instanceof RoutingSettingsConfirmationRequiredError) guards.push(error.preview);
						throw error;
					}
				})();
				return pending.callback;
			},
			onCancel: () => {},
		});
		return {
			settings,
			routing,
			panel,
			intents,
			guards,
			initialPreview,
			setGenerationFails: (value: boolean) => {
				generationFails = value;
			},
			setCatalog: (value: Model[]) => {
				currentCatalog = value;
			},
			setOrder: (value: string[]) => {
				order = value;
			},
			async input(key: string) {
				delete pending.callback;
				panel.handleInput(key);
				const callback = currentCallback();
				if (!callback) throw new Error(`No callback for ${key}`);
				await callback.catch(() => undefined);
				await Promise.resolve();
			},
		};
	}

	test("a failed apply shows a fresh preview and the next a sends a new intent", async () => {
		const f = fixture();
		const firstPreview = f.panel.getPreviewPayload();
		f.setCatalog(catalog.slice(0, 1));
		await f.input("a");
		expect(f.intents).toHaveLength(1);
		expect(f.panel.mode).toBe("editing");
		expect(f.panel.render(120).join("\n")).toContain("fresh preview");
		expect(f.panel.getPreviewPayload().sourceIdentity).not.toEqual(firstPreview.sourceIdentity);
		expect(f.settings.getGlobal("task.autorouting.tiers")).toBeUndefined();
		await f.input("a");
		expect(f.intents).toHaveLength(2);
		expect(f.intents[1]?.kind).toBe("apply");
		expect(f.panel.mode).toBe("done");
		expect(f.settings.getGlobal("task.autorouting.tiers")).toEqual(f.panel.getPreviewPayload().tiers);
	});

	test("panel cancellation discards the prepared proof, while clear-dialog cancellation does not", async () => {
		const f = fixture();
		f.panel.handleInput("c");
		f.panel.handleInput("\x1b");
		expect(f.panel.mode).toBe("editing");
		f.panel.handleInput("\x1b");
		await expect(f.routing.applySmartRouting(setup, { preview: f.initialPreview })).rejects.toThrow("not valid");

		const other = fixture();
		other.panel.handleInput("c");
		other.panel.handleInput("\x1b");
		await other.input("a");
		expect(other.panel.mode).toBe("done");
	});

	test("cancelled refresh proof cannot authorize a later keyboard confirmation", async () => {
		const f = fixture();
		await f.routing.applySmartRouting(setup);
		f.settings.set("task.autorouting.tiers", { fast: ["anthropic/custom"] });
		await f.input("r");
		const first = f.guards[0];
		if (!first) throw new Error("Expected first guard");
		f.panel.handleInput("\x1b");
		await f.input("r");
		const second = f.guards[1];
		if (!second) throw new Error("Expected second guard");
		expect(second).not.toBe(first);
		await expect(f.routing.refreshSmartRouting({ preview: first, confirmHandEdit: true })).rejects.toThrow(
			"not valid",
		);
		await f.input("\r");
		const confirmed = f.intents[2];
		expect(confirmed?.kind).toBe("refresh");
		if (confirmed?.kind !== "refresh") throw new Error("Expected refresh confirmation");
		expect(confirmed.preview).toBe(second);
		expect(confirmed.confirmHandEdit).toBe(true);
		expect(f.panel.mode).toBe("done");
	});

	test("failed regeneration keeps keyboard editing and blocks the invalid proof until a reviewed preview exists", async () => {
		const f = fixture();
		f.setCatalog(catalog.slice(0, 1));
		f.setGenerationFails(true);
		await f.input("a");
		expect(f.panel.mode).toBe("editing");
		expect(f.panel.render(120).join("\n")).toContain("Preview generation failed");
		f.panel.handleInput("a");
		expect(f.intents).toHaveLength(1);
		f.setGenerationFails(false);
		f.panel.handleInput("\x1b[B");
		expect(f.panel.getDraft().providers).toEqual([...setup.providers].reverse());
		expect(f.intents).toHaveLength(1);
		await f.input("a");
		expect(f.intents).toHaveLength(2);
		expect(f.panel.mode).toBe("done");
		expect(f.settings.getGlobal("task.autorouting.setup")).toEqual(f.panel.getDraft());
	});

	for (const drift of ["catalog", "order"] as const) {
		test(`refresh Enter refuses ${drift} drift and preserves the edited draft`, async () => {
			const f = fixture();
			await f.routing.applySmartRouting(setup);
			const handEdited = { fast: ["anthropic/custom"] };
			f.settings.set("task.autorouting.tiers", handEdited);
			f.panel.handleInput("\x1b[B");
			const draft = f.panel.getDraft();
			expect(draft.providers).toEqual([...setup.providers].reverse());
			await f.input("r");
			expect(f.panel.confirmation).toBe("hand-edit");
			if (drift === "catalog") f.setCatalog(catalog.slice(0, 1));
			else f.setOrder([...setup.providers].reverse());
			await f.input("\r");
			expect(f.intents).toHaveLength(2);
			expect(f.intents[1]).toMatchObject({ kind: "refresh", confirmHandEdit: true });
			expect(f.panel.mode).toBe("editing");
			expect(f.panel.render(120).join("\n")).toContain("fresh preview");
			expect(f.panel.getDraft()).toEqual(draft);
			expect(f.settings.getGlobal("task.autorouting.tiers")).toEqual(handEdited);
			expect(f.settings.getGlobal("task.autorouting.setup")).toEqual(setup);
		});
	}
});
