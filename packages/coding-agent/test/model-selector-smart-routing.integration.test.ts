import { beforeAll, describe, expect, test, vi } from "bun:test";
import type { Model } from "@gajae-code/ai";
import type { AutoroutingSetup, TierMap } from "@gajae-code/coding-agent/config/autorouting-contract";
import { canonicalJsonBytes } from "@gajae-code/coding-agent/config/autorouting-generator";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import type {
	SmartRoutingPanelComponent,
	SmartRoutingPreview,
} from "@gajae-code/coding-agent/modes/components/smart-routing-panel";
import {
	MAX_PANEL_LINE_WIDTH,
	SmartRoutingPanelComponent as SmartRoutingPanelClass,
} from "@gajae-code/coding-agent/modes/components/smart-routing-panel";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const catalog = [
	model("anthropic", "claude-haiku-4-5"),
	model("anthropic", "claude-sonnet-5"),
	model("anthropic", "claude-sonnet-4-6"),
	model("anthropic", "claude-opus-5"),
	model("openai-codex", "gpt-5.6-terra"),
	model("openai-codex", "gpt-5.6-sol"),
];

const smartProfile = {
	name: "smart-test",
	displayName: "Smart Test",
	requiredProviders: ["anthropic"],
	modelMapping: { default: "anthropic/claude-haiku-4-5" },
	source: "user" as const,
};

function renderText(component: { render(width: number): string[] }): string {
	return component
		.render(240)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function canonicalBytes(value: unknown): string {
	return Buffer.from(canonicalJsonBytes(value)).toString("hex");
}

let themeInstance = await getThemeByName("red-claw");

function installTheme(): void {
	if (!themeInstance) throw new Error("Failed to load test theme");
	setThemeInstance(themeInstance);
}

function createContext(
	options: {
		scopedModels?: unknown[];
		settings?: Settings;
		noProfiles?: boolean;
		providerOrder?: readonly string[];
		refreshError?: Error;
	} = {},
) {
	const settings = options.settings ?? Settings.isolated();
	const ui = { setFocus: vi.fn(), requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } };
	const editorContainer = { clear: vi.fn(), detachChild: vi.fn(), addChild: vi.fn() };
	const registry = {
		getAll: () => catalog,
		getAvailable: () => catalog,
		refresh: vi.fn(async () => {
			if (options.refreshError) throw options.refreshError;
		}),
		getError: () => undefined,
		getCanonicalModels: () => [],
		getCanonicalModelSelections: (query: { candidates?: Model[] } = {}) =>
			(query.candidates ?? catalog).map(candidate => {
				const selector = `${candidate.provider}/${candidate.id}`;
				return {
					record: {
						id: selector,
						name: candidate.name,
						variants: [{ selector, model: candidate, canonicalId: selector, source: "bundled" }],
					},
					model: candidate,
				};
			}),
		resolveCanonicalModel: () => undefined,
		getDiscoverableProviders: () => [],
		autoroutingProviderOrder: () => options.providerOrder ?? [...new Set(catalog.map(model => model.provider))],
		getModelProfiles: () => (options.noProfiles ? new Map() : new Map([[smartProfile.name, smartProfile]])),
		getModelProfile: (name: string) => (name === smartProfile.name ? smartProfile : undefined),
		getAvailableModelProfileNames: () => [smartProfile.name],
		getApiKeyForProvider: vi.fn(async () => "key"),
		getApiKey: vi.fn(async () => "key"),
		hasConfiguredProviderAuth: () => false,
	};
	const session = {
		model: catalog[0],
		thinkingLevel: undefined,
		sessionId: "smart-routing-test",
		scopedModels: options.scopedModels ?? [],
		modelRegistry: registry,
		getActiveModelProfile: () => undefined,
		isFastForProvider: () => false,
		isFastForSubagentProvider: () => false,
		isFastModeActive: () => false,
	};
	const ctx = {
		ui,
		editorContainer,
		editor: {},
		settings,
		session,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		notifyConfigChanged: vi.fn(async () => {}),
		restoreComposer: vi.fn(),
	};
	return { ctx, settings, session, editorContainer };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function openPanel(options: Parameters<typeof createContext>[0] & { smartRoutingOnly?: boolean } = {}): Promise<{
	controller: SelectorController;
	selector: ModelSelectorComponent;
	panel: SmartRoutingPanelComponent;
	settings: Settings;
	ctx: ReturnType<typeof createContext>["ctx"];
}> {
	const { ctx, settings, editorContainer } = createContext(options);
	const controller = new SelectorController(ctx as never);
	controller.showModelSelector(options.smartRoutingOnly ? { smartRoutingOnly: true } : undefined);
	const selector = editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
	await settle();
	installTheme();
	if (options.smartRoutingOnly) {
		// Nothing to navigate: the standalone entry mounts the panel itself.
	} else if ((options.scopedModels?.length ?? 0) > 0) {
		selector.__testOpenSmartRoutingPanel();
	} else {
		for (let index = 0; index < 20 && selector.__testSelectedPresetRowIdentity() !== "smartRouting"; index++) {
			selector.handleInput("\x1b[B");
		}
		selector.handleInput("\n");
	}
	await settle();
	const panel = selector.__testGetSmartRoutingPanel();
	if (!panel) throw new Error("Smart-routing landing row did not open the panel");
	return { controller, selector, panel, settings, ctx };
}

describe("/model smart-routing panel integration", () => {
	beforeAll(async () => {
		themeInstance = await getThemeByName("red-claw");
		installTheme();
	});

	test("bare /model reaches the landing row and freezes the preview as the apply payload (AC5/AC6)", async () => {
		const { panel, settings, ctx } = await openPanel();
		const preview = panel.getPreviewPayload();
		const observedPatches: unknown[] = [];
		const commit = settings.commitAtomicBatchWithCurrent.bind(settings);
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockImplementation(async builder => {
			observedPatches.push(...(await builder({})));
			return commit(builder);
		});

		await panel.__testApply();

		expect(observedPatches.map(patch => (patch as { path: string }).path)).toEqual([
			"task.autorouting.tiers",
			"task.autorouting.setup",
			"task.autorouting.provenance",
		]);
		expect(canonicalBytes(settings.get("task.autorouting.tiers"))).toBe(canonicalBytes(preview.tiers));
		expect(canonicalBytes(settings.get("task.autorouting.setup"))).toBe(canonicalBytes(preview.setup));
		expect(canonicalBytes(settings.get("task.autorouting.provenance"))).toBe(canonicalBytes(preview.provenance));
		expect(
			canonicalBytes({
				tiers: settings.get("task.autorouting.tiers"),
				setup: settings.get("task.autorouting.setup"),
				provenance: settings.get("task.autorouting.provenance"),
			}),
		).toBe(canonicalBytes({ tiers: preview.tiers, setup: preview.setup, provenance: preview.provenance }));
		expect(ctx.showStatus).toHaveBeenCalled();
	});

	test("toggle writes only task.autorouting.enabled (AC8)", async () => {
		const { panel, settings } = await openPanel();
		const observedPatches: unknown[] = [];
		const commit = settings.commitAtomicBatchWithCurrent.bind(settings);
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockImplementation(async builder => {
			observedPatches.push(...(await builder({})));
			return commit(builder);
		});

		await panel.__testToggle(true);

		expect(observedPatches).toHaveLength(1);
		expect(observedPatches[0]).toMatchObject({ path: "task.autorouting.enabled", op: "set", value: true });
	});

	test("refresh guards hand-edited tiers and proceeds after explicit confirmation (AC7)", async () => {
		const { panel, settings } = await openPanel();
		await panel.__testApply();
		settings.override("task.autorouting.tiers", { fast: ["anthropic/hand-edited"] });

		await panel.__testRefresh();
		expect(panel.mode).toBe("confirming");
		expect(panel.confirmation).toBe("hand-edit");
		await panel.__testConfirm();
		expect(settings.get("task.autorouting.provenance")).toBeDefined();
		expect(panel.mode).toBe("done");
	});

	test("confirming a hand-edit-guarded Apply commits the edited draft, not a Refresh of the recorded setup (AC6/AC7)", async () => {
		const { panel, settings } = await openPanel();
		await panel.__testApply();
		const recordedSetup = settings.get("task.autorouting.setup") as { providers: string[] } | undefined;
		expect(recordedSetup?.providers).toBeDefined();

		// The user edits the draft in-panel, then a hand edit lands in settings underneath them.
		const editedProviders = [...(recordedSetup?.providers ?? [])].reverse();
		panel.__testSetProviders(editedProviders);
		const editedPreview = panel.getPreviewPayload();
		settings.override("task.autorouting.tiers", { fast: ["anthropic/hand-edited"] });

		await panel.__testApply();
		expect(panel.mode).toBe("confirming");
		expect(panel.confirmation).toBe("hand-edit");

		await panel.__testConfirm();
		expect(panel.mode).toBe("done");
		// Regression: confirming previously emitted `refresh`, which discarded the edited draft and
		// re-committed the PREVIOUSLY recorded setup. The edited draft must win.
		// (`tiers` itself is asserted via the preview payload rather than settings, because the test
		// harness injects the hand edit through a higher-precedence override layer.)
		expect((settings.get("task.autorouting.setup") as { providers: string[] }).providers).toEqual(editedProviders);
		expect(panel.getPreviewPayload().tiers).toEqual(editedPreview.tiers);
	});

	test("clear unsets generated keys while preserving enabled", async () => {
		const settings = Settings.isolated({
			"task.autorouting.enabled": true,
		});
		const { panel, selector } = await openPanel({ settings });
		await panel.__testApply();
		panel.handleInput("\x1b");
		selector.handleInput("\n");
		await settle();
		const reopened = selector.__testGetSmartRoutingPanel();
		if (!reopened) throw new Error("Smart-routing panel did not reopen");
		reopened.handleInput("c");
		expect(reopened.confirmation).toBe("clear");
		await reopened.__testConfirm();
		expect(settings.get("task.autorouting.tiers")).toEqual({});
		expect(settings.get("task.autorouting.setup")).toBeUndefined();
		expect(settings.get("task.autorouting.provenance")).toBeUndefined();
		expect(settings.get("task.autorouting.enabled")).toBe(true);
	});

	test("stale-provenance indicator renders and scoped sessions are read-only", async () => {
		const settings = Settings.isolated({
			"task.autorouting.setup": { schema: 1, providers: ["anthropic"] },
			"task.autorouting.tiers": { fast: ["anthropic/claude-haiku-4-5"] },
			"task.autorouting.provenance": {
				schema: 1,
				source: { catalogFingerprint: "0".repeat(64), mapFingerprint: "1".repeat(64), generatorVersion: 1 },
				declarationFingerprint: "2".repeat(64),
				tiersFingerprint: "3".repeat(64),
			},
		});
		const { panel: stalePanel } = await openPanel({ settings });
		expect(renderText(stalePanel)).toContain("Stale generated setup");

		const scoped = await openPanel({ scopedModels: [{ model: catalog[0] }] });
		expect(renderText(scoped.panel)).toContain("Read-only");
		await scoped.panel.__testToggle(true);
		expect(scoped.settings.get("task.autorouting.enabled")).toBe(false);
	});

	test("standalone /routing entry reaches the panel with zero model profiles", async () => {
		const { panel, selector } = await openPanel({ smartRoutingOnly: true, noProfiles: true });
		expect(selector.__testViewMode()).toBe("smart-routing");
		expect(renderText(panel)).toContain("Smart routing setup");
	});

	test("standalone /routing renders catalog refresh failures instead of hanging", async () => {
		const { ctx, editorContainer } = createContext({
			noProfiles: true,
			refreshError: new Error("offline refresh failed"),
		});
		const controller = new SelectorController(ctx as never);
		controller.showModelSelector({ smartRoutingOnly: true });
		const selector = editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
		await settle();
		installTheme();

		const text = renderText(selector);
		expect(text).toContain("offline refresh failed");
		expect(text).not.toContain("Loading models...");
	});

	test("standalone panel cancel closes the selector instead of falling back to the preset landing", async () => {
		const { panel, selector, ctx } = await openPanel({ smartRoutingOnly: true, noProfiles: true });
		panel.handleInput("\x1b");
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
		expect(selector.__testViewMode()).toBe("smart-routing");
	});

	test("landing-launched panel cancel still returns to the preset landing", async () => {
		const { panel, selector, ctx } = await openPanel();
		panel.handleInput("\x1b");
		expect(ctx.restoreComposer).not.toHaveBeenCalled();
		expect(selector.__testViewMode()).toBe("presets");
	});
});

describe("provider-order derived seeding (Steps 3-4)", () => {
	beforeAll(() => {
		installTheme();
	});

	test("seeds the draft from the derived provider priority, not raw catalog iteration", async () => {
		const { panel } = await openPanel({ providerOrder: ["openai-codex", "anthropic"] });
		expect(panel.getProviderOrder()).toEqual(["openai-codex", "anthropic"]);
	});

	test("a recorded declaration still wins over the derived seed", async () => {
		const settings = Settings.isolated();
		await settings.set("task.autorouting.setup", { schema: 1, providers: ["anthropic"] });
		const { panel } = await openPanel({ settings, providerOrder: ["openai-codex", "anthropic"] });
		expect(panel.getProviderOrder()).toEqual(["anthropic"]);
	});

	test("refuses to open the panel when no providers are available", async () => {
		const { ctx, editorContainer } = createContext({ providerOrder: [] });
		const controller = new SelectorController(ctx as never);
		controller.showModelSelector();
		const selector = editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
		await settle();
		installTheme();
		for (let index = 0; index < 20 && selector.__testSelectedPresetRowIdentity() !== "smartRouting"; index++) {
			selector.handleInput("\x1b[B");
		}
		selector.handleInput("\n");
		await settle();
		expect(selector.__testGetSmartRoutingPanel()).toBeUndefined();
		expect(selector.__testViewMode()).toBe("presets");
	});

	test("an external provider-order change updates the hint without discarding an unsaved draft", async () => {
		const settings = Settings.isolated();
		const { panel } = await openPanel({ settings, providerOrder: ["anthropic", "openai-codex"] });
		const before = panel.getProviderOrder();
		expect(before.length).toBeGreaterThan(1);
		// Reorder in the panel without applying, then let an external settings change land.
		panel.handleInput("\x1b[B");
		panel.handleInput("J");
		const edited = panel.getProviderOrder();
		// Guard against a tautology: the edit must actually have changed the draft.
		expect(edited).not.toEqual(before);
		await settings.set("modelProviderOrder", ["openai-codex"]);
		await settle();
		// The unsaved draft must survive the advisory refresh.
		expect(panel.getProviderOrder()).toEqual(edited);
	});
});

describe("smart-routing panel hostile render boundary", () => {
	beforeAll(() => {
		installTheme();
	});

	/** Raw render: keep escapes so the assertions can prove they were stripped. */
	function rawRender(panel: SmartRoutingPanelComponent): string {
		return panel.render(120).join("\n");
	}

	const HOSTILE = "\x1b]0;pwned\x07\x1b[2Jbad\x07\tname\nINJECTED-PANEL-ROW\r\nINJECTED-CRLF-ROW";

	function hostilePanel(): SmartRoutingPanelComponent {
		const setup: AutoroutingSetup = {
			schema: 1,
			providers: [HOSTILE, "anthropic"],
			models: [`${HOSTILE}/model`, "x".repeat(400)],
		};
		const tiers: TierMap = {
			fast: [`${HOSTILE}/fast-model`],
			balanced: ["y".repeat(400)],
			strong: ["anthropic/claude-opus-5"],
		};
		const preview = {
			setup,
			tiers,
			provenance: {
				schema: 1 as const,
				source: { catalogFingerprint: "c", mapFingerprint: "m", generatorVersion: 1 },
				declarationFingerprint: "d",
				tiersFingerprint: "t",
			},
			sourceIdentity: { catalogFingerprint: "c", mapFingerprint: "m", generatorVersion: 1 },
		} as unknown as SmartRoutingPreview;
		return new SmartRoutingPanelClass({
			setup,
			tiers,
			enabled: true,
			readOnly: false,
			stale: false,
			preview,
			generatePreview: () => preview,
			onSelect: () => undefined,
			onCancel: () => undefined,
		});
	}

	test("strips control sequences from provider, allowlist, preset, and tier rows", () => {
		const rendered = rawRender(hostilePanel());
		// Only SGR color codes may survive; OSC/CSI-erase/BEL/tab data must not.
		expect(rendered).not.toContain("\x1b]0;");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x07");
		expect(rendered).not.toContain("\t");
		expect(rendered.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
		// The surrounding literal text still renders, so sanitizing did not blank the row.
		expect(rendered).toContain("bad");
		expect(rendered).toContain("anthropic");
	});

	test("keeps every untrusted value on a single row", () => {
		// sanitizeText preserves LF and width truncation treats it as zero-width, so an
		// embedded newline would otherwise inject rows and evade the one-line cap.
		const rendered = rawRender(hostilePanel());
		expect(rendered).not.toContain("INJECTED-PANEL-ROW\n");
		for (const line of rendered.split("\n")) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plain.startsWith("INJECTED-PANEL-ROW")).toBe(false);
			expect(plain.startsWith("INJECTED-CRLF-ROW")).toBe(false);
		}
		// Flattening must preserve the text itself on the owning row.
		expect(rendered).toContain("INJECTED-PANEL-ROW");
	});

	test("bounds oversized catalog selectors to the panel width budget", () => {
		// Wrapping alone would hide an unbounded value, so measure the longest
		// contiguous run of the oversized selector across the whole render.
		const plain = rawRender(hostilePanel())
			.replace(/\x1b\[[0-9;]*m/g, "")
			.replace(/\s+/g, "");
		const longestRun = Math.max(0, ...(plain.match(/y+/g) ?? []).map(run => run.length));
		expect(longestRun).toBeGreaterThan(0);
		expect(longestRun).toBeLessThanOrEqual(MAX_PANEL_LINE_WIDTH);
	});

	test("sanitizes error text raised by a failing preview regeneration", () => {
		const baseSetup: AutoroutingSetup = { schema: 1, providers: ["anthropic", "openai-codex"] };
		const preview = {
			setup: baseSetup,
			tiers: {},
			provenance: {
				schema: 1 as const,
				source: { catalogFingerprint: "c", mapFingerprint: "m", generatorVersion: 1 },
				declarationFingerprint: "d",
				tiersFingerprint: "t",
			},
			sourceIdentity: { catalogFingerprint: "c", mapFingerprint: "m", generatorVersion: 1 },
		} as unknown as SmartRoutingPreview;
		const panel = new SmartRoutingPanelClass({
			setup: baseSetup,
			enabled: false,
			readOnly: false,
			stale: false,
			preview,
			generatePreview: () => {
				throw new Error(HOSTILE);
			},
			onSelect: () => undefined,
			onCancel: () => undefined,
		});
		// Removing a provider regenerates the preview, so the thrown message reaches #error.
		panel.handleInput("x");
		const rendered = rawRender(panel);
		expect(rendered.replace(/\x1b\[[0-9;]*m/g, "")).toContain("bad");
		expect(rendered).not.toContain("\x1b]0;");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x07");
		// The error string is free-form, so it must also stay on exactly one row.
		for (const line of rendered.split("\n")) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plain.startsWith("INJECTED-PANEL-ROW")).toBe(false);
			expect(plain.startsWith("INJECTED-CRLF-ROW")).toBe(false);
			expect(Bun.stringWidth(plain)).toBeLessThanOrEqual(MAX_PANEL_LINE_WIDTH);
		}
	});
});
