import { beforeAll, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai";
import type { AutoroutingSetup, TierMap } from "@gajae-code/coding-agent/config/autorouting-contract";
import { canonicalJsonBytes } from "@gajae-code/coding-agent/config/autorouting-generator";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import type {
	SmartRoutingIntent,
	SmartRoutingPanelComponent,
} from "@gajae-code/coding-agent/modes/components/smart-routing-panel";
import {
	MAX_PANEL_LINE_WIDTH,
	SmartRoutingPanelComponent as SmartRoutingPanelClass,
} from "@gajae-code/coding-agent/modes/components/smart-routing-panel";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { TempDir } from "@gajae-code/utils";
import {
	createRoutingSettingsService,
	RoutingSettingsConfirmationRequiredError,
	type RoutingSettingsPreview,
} from "../src/sdk/routing-settings";

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
		refreshStaticGate?: Promise<void>;
	} = {},
) {
	const settings = options.settings ?? Settings.isolated();
	let notifyCatalogChanged = () => {};
	const ui = {
		setFocus: vi.fn(),
		requestRender: vi.fn(),
		requestLayoutRender: vi.fn(),
		terminal: { rows: 40, columns: 120 },
	};
	const editorContainer = { clear: vi.fn(), detachChild: vi.fn(), addChild: vi.fn() };
	const registry = {
		getAll: () => catalog,
		getAvailable: () => catalog,
		refresh: vi.fn(async () => {
			if (options.refreshError) throw options.refreshError;
		}),
		refreshStatic: vi.fn(async () => {
			await options.refreshStaticGate;
		}),
		onCatalogChanged: (listener: () => void) => {
			notifyCatalogChanged = listener;
			return () => {};
		},
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
		isSelectorCircuitOpen: (_selector: string) => false,
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
	return { ctx, settings, session, editorContainer, notifyCatalogChanged: () => notifyCatalogChanged() };
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
	notifyCatalogChanged: () => void;
}> {
	const { ctx, settings, editorContainer, notifyCatalogChanged } = createContext(options);
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
	return { controller, selector, panel, settings, ctx, notifyCatalogChanged };
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

	test("memory-only panel updates do not claim durable persistence", async () => {
		const { panel, ctx } = await openPanel();
		await panel.__testApply();
		expect(renderText(panel)).toContain("Global smart-routing settings updated.");
		expect(renderText(panel)).not.toContain("settings saved");
		expect(ctx.showStatus).toHaveBeenCalledWith("Apply smart-routing settings updated in memory.");
	});

	for (const operation of ["apply", "refresh"] as const) {
		test(`${operation} displays the published preview when activation switches the catalog`, async () => {
			const { controller, panel, settings, ctx, notifyCatalogChanged } = await openPanel();
			if (operation === "refresh") await panel.__testApply();
			const committed = panel.getPreviewPayload();
			const registry = ctx.session.modelRegistry;
			const getAll = vi.spyOn(registry, "getAll");
			ctx.notifyConfigChanged.mockImplementation(async () => {
				// Activation happens after atomic publication, not while preparing the preview.
				expect(settings.get("task.autorouting.tiers")).toEqual(committed.tiers);
				expect(settings.get("task.autorouting.provenance")).toEqual(committed.provenance);
				getAll.mockImplementation(() => catalog.filter(item => item.provider !== "openai-codex"));
				notifyCatalogChanged();
			});

			if (operation === "apply") await panel.__testApply();
			else await panel.__testRefresh();

			expect(panel.mode).toBe("done");
			expect(ctx.showError).not.toHaveBeenCalled();
			expect(settings.get("task.autorouting.setup")).toEqual(committed.setup);
			expect(settings.get("task.autorouting.tiers")).toEqual(committed.tiers);
			expect(settings.get("task.autorouting.provenance")).toEqual(committed.provenance);
			expect(panel.getPreviewPayload()).toEqual(committed);
			expect(renderText(panel)).toContain("openai-codex/gpt-5.6-terra");
			expect(renderText(panel)).toContain("Global smart-routing settings updated.");

			// A separately requested preview is a new candidate, not the saved result.
			const candidate = controller.previewSmartRouting(committed.setup);
			expect(candidate.tiers).not.toEqual(committed.tiers);
			expect(candidate.provenance.source.catalogFingerprint).not.toBe(
				committed.provenance.source.catalogFingerprint,
			);
			expect(panel.getPreviewPayload()).toEqual(committed);
		});

		test(`${operation} remains successful when the catalog becomes unreadable after publication`, async () => {
			const { panel, settings, ctx, notifyCatalogChanged } = await openPanel();
			if (operation === "refresh") await panel.__testApply();
			const committed = panel.getPreviewPayload();
			const getAll = vi.spyOn(ctx.session.modelRegistry, "getAll");
			let postPublicationReads = 0;
			ctx.notifyConfigChanged.mockImplementation(async () => {
				expect(settings.get("task.autorouting.tiers")).toEqual(committed.tiers);
				getAll.mockImplementation(() => {
					postPublicationReads++;
					throw new Error("catalog unavailable after publication");
				});
				notifyCatalogChanged();
			});

			if (operation === "apply") await panel.__testApply();
			else await panel.__testRefresh();

			expect(panel.mode).toBe("done");
			expect(postPublicationReads).toBe(0);
			expect(panel.getPreviewPayload()).toEqual(committed);
			expect(settings.get("task.autorouting.tiers")).toEqual(committed.tiers);
			expect(settings.get("task.autorouting.provenance")).toEqual(committed.provenance);
			expect(ctx.showError).not.toHaveBeenCalled();
			expect(renderText(panel)).toContain("Global smart-routing settings updated.");
			expect(renderText(panel)).not.toContain("catalog unavailable after publication");
		});
	}

	for (const operation of ["apply", "refresh", "clear", "toggle"] as const) {
		for (const failure of ["status", "render", "refresh"] as const) {
			test(`${operation} retains its disk commit when post-publication ${failure} throws`, async () => {
				const temp = TempDir.createSync("@gjc-routing-ui-commit-");
				const agentDir = path.join(temp.path(), "agent");
				const settings = await Settings.loadForScope({ cwd: temp.path(), agentDir });
				try {
					const routing = createRoutingSettingsService({
						settings,
						getCatalog: () => catalog,
						getProviderOrder: () => ["anthropic", "openai-codex"],
						isScoped: () => false,
					});
					if (operation === "refresh" || operation === "clear") {
						await routing.applySmartRouting({ schema: 1, providers: ["anthropic", "openai-codex"] });
					}
					const { panel, selector, ctx } = await openPanel({ settings });
					let activated = false;
					ctx.notifyConfigChanged.mockImplementation(async () => {
						activated = true;
					});
					if (failure === "status")
						ctx.showStatus.mockImplementation(() => {
							if (activated) throw new Error("private status failure");
						});
					if (failure === "render")
						ctx.ui.requestRender.mockImplementation(() => {
							if (activated) throw new Error("private render failure");
						});
					if (failure === "refresh")
						vi.spyOn(selector, "refreshSmartRoutingState").mockImplementation(() => {
							throw new Error("private refresh failure");
						});
					if (operation === "apply") await panel.__testApply();
					else if (operation === "refresh") await panel.__testRefresh();
					else if (operation === "clear") await panel.__testClear();
					else await panel.__testToggle(true);
					expect(activated).toBe(true);
					expect(panel.mode).toBe("done");
					expect(ctx.showError).not.toHaveBeenCalled();
					expect(renderText(panel)).not.toContain("private");
					if (failure === "refresh") {
						expect(renderText(panel)).toContain("Effective enabled: unknown");
						expect(renderText(panel)).toContain("Effective generated setup: unknown");
						expect(renderText(panel)).toContain("Effective settings comparison to global: unknown.");
						expect(renderText(panel)).not.toContain("Provenance recorded");
						expect(renderText(panel)).not.toContain("effective settings currently differ");
					}
					const disk = await Settings.loadReadonly({ cwd: temp.path(), agentDir });
					try {
						for (const key of [
							"task.autorouting.setup",
							"task.autorouting.tiers",
							"task.autorouting.provenance",
							"task.autorouting.enabled",
						] as const) {
							expect(disk.getGlobal(key)).toEqual(settings.getGlobal(key));
						}
						if (operation === "apply" || operation === "refresh") {
							expect(settings.getGlobal("task.autorouting.setup")).toEqual(panel.getPreviewPayload().setup);
							expect(settings.getGlobal("task.autorouting.tiers")).toEqual(panel.getPreviewPayload().tiers);
							expect(settings.getGlobal("task.autorouting.provenance")).toEqual(
								panel.getPreviewPayload().provenance,
							);
						} else if (operation === "clear")
							expect(settings.getGlobal("task.autorouting.setup")).toBeUndefined();
						else expect(settings.getGlobal("task.autorouting.enabled")).toBe(true);
					} finally {
						await disk.close();
					}
				} finally {
					await settings.close();
					temp.removeSync();
				}
			});
		}
	}

	for (const refreshFails of [false, true]) {
		test(`durable activation rollback conflict marks effective state unknown${refreshFails ? " even when refresh would fail" : ""}`, async () => {
			const temp = TempDir.createSync("@gjc-routing-ui-conflict-");
			const agentDir = path.join(temp.path(), "agent");
			const settings = await Settings.loadForScope({ cwd: temp.path(), agentDir });
			try {
				settings.set("task.autorouting.enabled", false);
				await settings.flushOrThrow();
				const { panel, selector, ctx } = await openPanel({ settings });
				ctx.notifyConfigChanged.mockImplementation(async () => {
					settings.set("task.autorouting.enabled", false);
					settings.override("task.autorouting.enabled", true);
					await settings.flushOrThrow();
					throw new Error("activation failed");
				});
				if (refreshFails)
					vi.spyOn(selector, "refreshSmartRoutingState").mockImplementation(() => {
						throw new Error("refresh failed");
					});
				await panel.__testToggle(true);
				expect(settings.getGlobal("task.autorouting.enabled")).toBe(false);
				const disk = await Settings.loadReadonly({ cwd: temp.path(), agentDir });
				try {
					expect(disk.getGlobal("task.autorouting.enabled")).toBe(false);
				} finally {
					await disk.close();
				}
				expect(panel.mode).toBe("error");
				expect(renderText(panel)).toContain("rollback conflict");
				expect(renderText(panel)).toContain("Effective enabled: unknown");
				expect(renderText(panel)).toContain("Effective generated setup: unknown");
			} finally {
				await settings.close();
				temp.removeSync();
			}
		});
	}

	test("failed effective-state marking cannot turn a committed apply into failure or retain stale labels", async () => {
		const { panel, selector, ctx } = await openPanel();
		vi.spyOn(selector, "refreshSmartRoutingState").mockImplementation(() => {
			throw new Error("refresh failed");
		});
		vi.spyOn(selector, "markSmartRoutingEffectiveStateUnknown").mockImplementation(() => {
			throw new Error("mark failed");
		});
		await panel.__testApply();
		expect(panel.mode).toBe("done");
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(renderText(panel)).toContain("Effective enabled: unknown");
		expect(renderText(panel)).toContain("Effective generated setup: unknown");
		expect(renderText(panel)).not.toContain("Provenance recorded");
	});

	test("another service invalidates an already open panel sharing Settings", async () => {
		const temp = TempDir.createSync("@gjc-routing-ui-shared-conflict-");
		const agentDir = path.join(temp.path(), "agent");
		const settings = await Settings.loadForScope({ cwd: temp.path(), agentDir });
		const other = await Settings.loadForScope({ cwd: temp.path(), agentDir });
		try {
			settings.set("task.autorouting.enabled", false);
			await settings.flushOrThrow();
			const { panel, selector, controller, ctx } = await openPanel({ settings });
			const scoped = await openPanel({ settings, scopedModels: [{ model: catalog[0] }] });
			const confirming = await openPanel({ settings });
			panel.handleInput("m");
			const typed = "invalid draft !/unique";
			for (const character of typed) panel.handleInput(character);
			const draft = panel.getDraft();
			const uncommitted = `${draft.models?.join(", ") ?? ""}${typed}`;
			confirming.panel.handleInput("c");
			expect(confirming.panel.confirmation).toBe("clear");
			expect(renderText(confirming.panel)).toContain("Enter confirms");
			expect(renderText(panel)).toContain("Effective enabled: no");
			expect(renderText(scoped.panel)).toContain("Read-only");
			const routing = createRoutingSettingsService({
				settings,
				getCatalog: () => catalog,
				getProviderOrder: () => ["anthropic", "openai-codex"],
				isScoped: () => false,
				activate: async () => {
					await other.commitAtomicBatchWithCurrent(() => [
						{ path: "task.autorouting.enabled", op: "set", value: false },
					]);
					throw new Error("activation failed");
				},
			});
			const renders = ctx.ui.requestRender.mock.calls.length;
			const error = await routing.setAutoroutingEnabled(true).catch(failure => failure);
			expect(error).toMatchObject({ durability: "persisted", rollback: "conflict" });
			// No listener requests a frame; the next render or input observes the shared state.
			expect(ctx.ui.requestRender.mock.calls.length).toBe(renders);
			// Render observes invalidation during editing; input observes it during confirmation.
			const editingText = renderText(panel);
			const commit = vi.spyOn(settings, "commitAtomicBatchWithCurrent");
			confirming.panel.handleInput("\r");
			expect(panel.getDraft()).toEqual(draft);
			expect(editingText).toContain("reload Settings before continuing");
			expect(editingText).toContain(`Uncommitted allowlist draft (read-only): ${uncommitted}`);
			expect(editingText).not.toContain("then Enter");
			expect(editingText).not.toContain("↑/↓ reorder");
			expect(confirming.panel.confirmation).toBeUndefined();
			expect(renderText(confirming.panel)).toContain("reload Settings before continuing");
			expect(renderText(confirming.panel)).not.toContain("Enter confirms");
			expect(renderText(confirming.panel)).toContain("Esc: cancel");
			for (const input of ["\r", "a", "r", "t", "c", "m", "\x7f", "z"]) panel.handleInput(input);
			confirming.panel.handleInput("a");
			expect(panel.getDraft()).toEqual(draft);
			expect(renderText(panel)).toContain(`Uncommitted allowlist draft (read-only): ${uncommitted}`);
			expect(panel.confirmation).toBeUndefined();
			expect(ctx.notifyConfigChanged).not.toHaveBeenCalled();
			expect(confirming.ctx.notifyConfigChanged).not.toHaveBeenCalled();
			await panel.__testApply();
			await panel.__testRefresh();
			await panel.__testToggle(false);
			await panel.__testClear();
			await panel.__testConfirm();
			await scoped.panel.__testToggle(false);
			expect(commit).not.toHaveBeenCalled();
			expect(panel.mode).not.toBe("done");
			expect(scoped.panel.mode).not.toBe("done");
			expect(renderText(scoped.panel)).toContain("Effective enabled: unknown");
			expect(renderText(scoped.panel)).toContain("Effective generated setup: unknown");
			expect(renderText(scoped.panel)).toContain("reload Settings before continuing");
			expect(renderText(confirming.panel)).toContain("Effective enabled: unknown");
			expect(renderText(confirming.panel)).toContain("Effective generated setup: unknown");
			confirming.panel.handleInput("\x1b");
			expect(confirming.selector.__testViewMode()).not.toBe("smart-routing");
			expect(renderText(panel)).toContain("Effective enabled: unknown");
			expect(renderText(panel)).toContain("Effective generated setup: unknown");
			expect(renderText(panel)).not.toContain("Effective enabled: yes");
			expect(renderText(panel)).not.toContain("Effective generated setup: absent");
			await expect(controller.setAutoroutingEnabled(false)).rejects.toThrow("settings are unknown");
			panel.handleInput("\x1b");
			expect(renderText(selector)).toContain("Smart routing (unknown)");
			selector.__testOpenSmartRoutingPanel();
			expect(selector.__testGetSmartRoutingPanel()).toBeUndefined();
			expect(renderText(selector)).toContain("reload Settings before continuing");
			controller.showModelSelector();
			const reopened = ctx.editorContainer.addChild.mock.calls.at(-1)?.[0] as ModelSelectorComponent;
			await settle();
			expect(renderText(reopened)).toContain("Smart routing (unknown)");
			reopened.__testOpenSmartRoutingPanel();
			expect(reopened.__testGetSmartRoutingPanel()).toBeUndefined();
			expect(renderText(reopened)).toContain("reload Settings before continuing");
		} finally {
			await settings.close();
			await other.close();
			temp.removeSync();
		}
	});

	test("cross-instance rollback conflict leaves stale local state unknown in the panel", async () => {
		const temp = TempDir.createSync("@gjc-routing-ui-cross-conflict-");
		const agentDir = path.join(temp.path(), "agent");
		const settings = await Settings.loadForScope({ cwd: temp.path(), agentDir });
		const other = await Settings.loadForScope({ cwd: temp.path(), agentDir });
		try {
			settings.set("task.autorouting.enabled", false);
			await settings.flushOrThrow();
			const { controller, panel, selector, ctx } = await openPanel({ settings });
			ctx.notifyConfigChanged.mockImplementation(async () => {
				await other.commitAtomicBatchWithCurrent(() => [
					{ path: "task.autorouting.enabled", op: "set", value: false },
				]);
				throw new Error("activation failed");
			});
			ctx.showError.mockImplementation(() => {
				throw new Error("error display failed");
			});
			ctx.ui.requestRender.mockImplementation(() => {
				throw new Error("render failed");
			});
			await panel.__testToggle(true);
			const disk = await Settings.loadReadonly({ cwd: temp.path(), agentDir });
			try {
				expect(disk.getGlobal("task.autorouting.enabled")).toBe(false);
			} finally {
				await disk.close();
			}
			expect(settings.getGlobal("task.autorouting.enabled")).toBe(true);
			expect(settings.get("task.autorouting.enabled")).toBe(true);
			expect(panel.mode).toBe("error");
			expect(renderText(panel)).toContain("rollback conflict");
			expect(renderText(panel)).toContain("Effective enabled: unknown");
			expect(renderText(panel)).toContain("Effective generated setup: unknown");
			await expect(controller.setAutoroutingEnabled(false)).rejects.toThrow("settings are unknown");
			ctx.ui.requestRender.mockReset();
			panel.handleInput("\x1b");
			expect(renderText(selector)).toContain("Smart routing (unknown)");
		} finally {
			await settings.close();
			await other.close();
			temp.removeSync();
		}
	});

	test("failure UI callbacks cannot replace the original mutation error", async () => {
		const { controller, settings, ctx } = await openPanel();
		vi.spyOn(settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(new Error("original write failed"));
		ctx.showError.mockImplementation(() => {
			throw new Error("error display failed");
		});
		ctx.ui.requestRender.mockImplementation(() => {
			throw new Error("error render failed");
		});
		await expect(controller.setAutoroutingEnabled(true)).rejects.toThrow("original write failed");
		expect(settings.getGlobal("task.autorouting.enabled")).not.toBe(true);
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
		expect(renderText(panel)).toContain("Global enabled updated: yes.");
		expect(renderText(panel)).toContain("Effective enabled: yes");
	});

	test("toggle reports the saved global value separately from the runtime overlay", async () => {
		const settings = Settings.isolated({ "task.autorouting.enabled": false });
		settings.override("task.autorouting.enabled", false);
		const { panel } = await openPanel({ settings });
		await panel.__testToggle(true);
		expect(settings.getGlobal("task.autorouting.enabled")).toBe(true);
		expect(settings.get("task.autorouting.enabled")).toBe(false);
		expect(renderText(panel)).toContain("Global enabled updated: yes.");
		expect(renderText(panel)).toContain("Effective enabled: no");
	});

	test("clear removes global generated settings without clearing runtime generated settings", async () => {
		const { panel: initialPanel, selector, settings } = await openPanel();
		await initialPanel.__testApply();
		initialPanel.handleInput("\x1b");
		selector.handleInput("\n");
		await settle();
		const panel = selector.__testGetSmartRoutingPanel();
		if (!panel) throw new Error("Expected reopened routing panel");
		const runtimeSetup: AutoroutingSetup = { schema: 1, providers: ["openai-codex"] };
		const runtimeTiers = { fast: ["openai-codex/custom"] };
		const runtimeProvenance = settings.getGlobal("task.autorouting.provenance");
		if (!runtimeProvenance) throw new Error("Expected generated provenance");
		settings.override("task.autorouting.setup", runtimeSetup);
		settings.override("task.autorouting.tiers", runtimeTiers);
		settings.override("task.autorouting.provenance", runtimeProvenance);
		panel.handleInput("c");
		expect(panel.confirmation).toBe("clear");
		await panel.__testConfirm();
		expect(settings.getGlobal("task.autorouting.setup")).toBeUndefined();
		expect(settings.getGlobal("task.autorouting.provenance")).toBeUndefined();
		expect(settings.getGlobal("task.autorouting.tiers") ?? {}).toEqual({});
		expect(settings.get("task.autorouting.setup")).toEqual(runtimeSetup);
		expect(settings.get("task.autorouting.tiers")).toEqual(runtimeTiers);
		expect(settings.get("task.autorouting.provenance")).toEqual(runtimeProvenance);
		expect(renderText(panel)).toContain("Global generated setup cleared.");
		expect(renderText(panel)).toContain("Effective generated setup: present");
	});

	for (const operation of ["toggle", "clear"] as const) {
		for (const failure of ["catalog", "provider order"] as const) {
			test(`${operation} remains committed when ${failure} fails after activation`, async () => {
				const { panel: initialPanel, selector, settings, ctx } = await openPanel();
				let panel = initialPanel;
				if (operation === "clear") {
					await initialPanel.__testApply();
					initialPanel.handleInput("\x1b");
					selector.handleInput("\n");
					await settle();
					const reopened = selector.__testGetSmartRoutingPanel();
					if (!reopened) throw new Error("Expected reopened routing panel");
					panel = reopened;
				}
				const commit = vi.spyOn(settings, "commitAtomicBatchWithCurrent");
				ctx.notifyConfigChanged.mockImplementation(async () => {
					if (failure === "catalog") {
						vi.spyOn(ctx.session.modelRegistry, "getAll").mockImplementation(() => {
							throw new Error("catalog unavailable");
						});
					} else {
						vi.spyOn(ctx.session.modelRegistry, "autoroutingProviderOrder").mockImplementation(() => {
							throw new Error("provider order unavailable");
						});
					}
				});
				if (operation === "toggle") await panel.__testToggle(true);
				else {
					panel.handleInput("c");
					await panel.__testConfirm();
				}
				expect(commit).toHaveBeenCalledTimes(1);
				expect(panel.mode).toBe("done");
				expect(ctx.showError).not.toHaveBeenCalled();
				expect(renderText(panel)).toContain(
					operation === "toggle" ? "Global enabled updated: yes." : "Global generated setup cleared.",
				);
				expect(renderText(panel)).toContain("Preview invalid; regenerate before applying:");
				if (operation === "toggle") expect(settings.getGlobal("task.autorouting.enabled")).toBe(true);
				else expect(settings.getGlobal("task.autorouting.setup")).toBeUndefined();
			});
		}
	}

	test("refresh shows the committed global setup alongside its preview when runtime settings differ", async () => {
		const globalSetup: AutoroutingSetup = { schema: 1, providers: ["anthropic"] };
		const runtimeSetup: AutoroutingSetup = { schema: 1, providers: ["openai-codex"] };
		const runtimeTiers = {
			fast: ["openai-codex/custom-fast"],
			balanced: ["openai-codex/custom-balanced"],
			strong: ["openai-codex/custom-strong"],
		};
		const settings = Settings.isolated({ "task.autorouting.setup": globalSetup });
		settings.override("task.autorouting.setup", runtimeSetup);
		settings.override("task.autorouting.tiers", runtimeTiers);
		const { panel } = await openPanel({ settings });
		expect(panel.getDraft()).toEqual(runtimeSetup);
		await panel.__testRefresh();
		expect(panel.mode).toBe("done");
		expect(settings.getGlobal("task.autorouting.setup")).toEqual(globalSetup);
		expect(panel.getDraft()).toEqual(globalSetup);
		expect(panel.getPreviewPayload().setup).toEqual(globalSetup);
		expect(settings.getGlobal("task.autorouting.tiers")).toEqual(panel.getPreviewPayload().tiers);
		expect(settings.getGlobal("task.autorouting.provenance")).toEqual(panel.getPreviewPayload().provenance);
		expect(settings.get("task.autorouting.setup")).toEqual(runtimeSetup);
		expect(settings.get("task.autorouting.tiers")).toEqual(runtimeTiers);
		expect(renderText(panel)).toContain("Committed preview is global; effective settings currently differ.");
	});

	test("controller and selector forward the exact refresh guard after keyboard cancellation and retry", async () => {
		const settings = Settings.isolated({
			"task.autorouting.setup": { schema: 1, providers: ["anthropic"], models: ["anthropic/claude-haiku-4-5"] },
		});
		const { controller, panel: initialPanel, selector } = await openPanel({ settings });
		await initialPanel.__testApply();
		initialPanel.handleInput("\x1b");
		const globalSetup = settings.getGlobal("task.autorouting.setup");
		if (!globalSetup) throw new Error("Expected a recorded global setup");
		const runtimeSetup: AutoroutingSetup = {
			schema: 1,
			providers: ["openai-codex"],
			models: ["openai-codex/gpt-5.6-terra"],
		};
		settings.override("task.autorouting.setup", runtimeSetup);
		settings.set("task.autorouting.tiers", { fast: ["anthropic/hand-edited"] });
		selector.handleInput("\n");
		await settle();
		const panel = selector.__testGetSmartRoutingPanel();
		if (!panel) throw new Error("Expected reopened routing panel");
		const refresh = controller.refreshSmartRouting.bind(controller);
		const calls: Promise<RoutingSettingsPreview>[] = [];
		const spy = vi.spyOn(controller, "refreshSmartRouting").mockImplementation(options => {
			const call = refresh(options);
			calls.push(call);
			return call;
		});
		panel.handleInput("r");
		const guards: RoutingSettingsConfirmationRequiredError[] = [];
		await calls[0]?.catch(error => {
			if (error instanceof RoutingSettingsConfirmationRequiredError) guards.push(error);
		});
		await settle();
		const first = guards[0];
		if (!first) throw new Error("Expected first refresh guard");
		expect(panel.getDraft()).toEqual(runtimeSetup);
		expect(panel.getPreviewPayload().setup).toEqual(globalSetup);
		expect(renderText(panel)).toContain(
			`Pending refresh uses recorded global providers: ${globalSetup.providers.join(", ")}`,
		);
		expect(renderText(panel)).toContain("Pending refresh uses recorded global allowlist: anthropic/claude-haiku-4-5");
		expect(renderText(panel)).toContain("Allowlist: openai-codex/gpt-5.6-terra");
		panel.handleInput("\x1b");
		expect(panel.getDraft()).toEqual(runtimeSetup);
		panel.handleInput("r");
		await calls[1]?.catch(error => {
			if (error instanceof RoutingSettingsConfirmationRequiredError) guards.push(error);
		});
		await settle();
		const second = guards[1];
		if (!second) throw new Error("Expected second refresh guard");
		expect(first.preview).not.toBe(second.preview);
		await expect(refresh({ preview: first.preview, confirmHandEdit: true })).rejects.toThrow("not valid");
		panel.handleInput("\r");
		await calls[2];
		await settle();
		expect(spy.mock.calls[2]?.[0]?.preview).toBe(second.preview);
		expect(spy.mock.calls[2]?.[0]?.confirmHandEdit).toBe(true);
		expect(panel.mode).toBe("done");
		expect(panel.getDraft()).toEqual(globalSetup);
		expect(panel.getPreviewPayload().setup).toEqual(globalSetup);
		expect(settings.getGlobal("task.autorouting.setup")).toEqual(globalSetup);
		expect(settings.get("task.autorouting.setup")).toEqual(runtimeSetup);
		expect(renderText(panel)).toContain("Committed preview is global; effective settings currently differ.");
	});

	test("refresh guards hand-edited tiers and proceeds after explicit confirmation (AC7)", async () => {
		const { panel, settings } = await openPanel();
		await panel.__testApply();
		settings.set("task.autorouting.tiers", { fast: ["anthropic/hand-edited"] });

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
		settings.set("task.autorouting.tiers", { fast: ["anthropic/hand-edited"] });

		await panel.__testApply();
		expect(panel.mode).toBe("confirming");
		expect(panel.confirmation).toBe("hand-edit");

		await panel.__testConfirm();
		expect(panel.mode).toBe("done");
		// Regression: confirming previously emitted `refresh`, which discarded the edited draft and
		// re-committed the PREVIOUSLY recorded setup. The edited draft must win.
		// The generated tiers and declaration are committed together after confirmation.
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
		expect(renderText(reopened)).toContain("Global generated setup cleared.");
		expect(renderText(reopened)).toContain("Effective generated setup: absent");
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

	test("landing waits for static refresh before opening smart routing", async () => {
		const gate = Promise.withResolvers<void>();
		const { ctx, editorContainer } = createContext({ refreshStaticGate: gate.promise });
		const controller = new SelectorController(ctx as never);
		controller.showModelSelector();
		const selector = editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
		for (let index = 0; index < 20 && selector.__testSelectedPresetRowIdentity() !== "smartRouting"; index++) {
			selector.handleInput("\x1b[B");
		}
		selector.handleInput("\n");
		expect(selector.__testGetSmartRoutingPanel()).toBeUndefined();
		expect(renderText(selector)).toContain("Refreshing model configuration...");

		gate.resolve();
		await settle();
		expect(selector.__testGetSmartRoutingPanel()).toBeDefined();
	});

	test("catalog changes preserve a landing-launched smart-routing draft", async () => {
		const { panel, selector, notifyCatalogChanged } = await openPanel();
		const editedProviders = [...panel.getProviderOrder()].reverse();
		panel.__testSetProviders(editedProviders);

		notifyCatalogChanged();
		await settle();
		expect(selector.__testGetSmartRoutingPanel()).toBe(panel);
		expect(panel.getProviderOrder()).toEqual(editedProviders);
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
		selector.handleInput("\x1b");
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
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

	function hostilePanel(
		options: {
			isStateUnknown?: () => boolean;
			onSelect?: (intent: SmartRoutingIntent) => undefined | Promise<RoutingSettingsPreview | undefined>;
			discardPreview?: (preview: RoutingSettingsPreview) => void;
			onCancel?: () => void;
		} = {},
	): SmartRoutingPanelComponent {
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
		} as unknown as RoutingSettingsPreview;
		return new SmartRoutingPanelClass({
			setup,
			tiers,
			enabled: true,
			readOnly: false,
			stale: false,
			preview,
			generatePreview: () => preview,
			onSelect: options.onSelect ?? (() => undefined),
			isStateUnknown: options.isStateUnknown,
			discardPreview: options.discardPreview,
			onCancel: options.onCancel ?? (() => undefined),
		});
	}

	test("callback-only actions do not invent effective settings", async () => {
		const toggle = hostilePanel();
		await toggle.__testToggle(false);
		const toggleText = renderText(toggle);
		expect(toggleText).toContain("Global enabled updated: no.");
		expect(toggleText).toContain("Effective enabled: unknown");
		const clear = hostilePanel();
		clear.handleInput("c");
		await clear.__testConfirm();
		expect(renderText(clear)).toContain("Global generated setup cleared.");
		expect(renderText(clear)).toContain("Effective generated setup: unknown");
	});

	test("shared invalidation discards a pending hand-edit confirmation before input", async () => {
		let unknown = false;
		const pending = hostilePanel().getPreviewPayload();
		const onSelect = vi.fn(async () => {
			throw new RoutingSettingsConfirmationRequiredError(pending);
		});
		const discardPreview = vi.fn();
		const panel = hostilePanel({ isStateUnknown: () => unknown, onSelect, discardPreview });
		await panel.__testRefresh();
		expect(panel.confirmation).toBe("hand-edit");
		expect(renderText(panel)).toContain("Enter confirms");
		unknown = true;
		panel.handleInput("\r");
		expect(panel.confirmation).toBeUndefined();
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(discardPreview).toHaveBeenCalledWith(pending);
		const text = renderText(panel);
		expect(text).toContain("reload Settings before continuing");
		expect(text).toContain("Effective enabled: unknown");
		expect(text).not.toContain("Enter confirms");
		expect(text).not.toContain("Pending refresh uses");
	});

	test("late confirmation after observed invalidation discards its preview authority", async () => {
		const settings = Settings.isolated();
		const routing = createRoutingSettingsService({
			settings,
			getCatalog: () => catalog,
			getProviderOrder: () => ["anthropic", "openai-codex"],
			isScoped: () => false,
		});
		const setup: AutoroutingSetup = { schema: 1, providers: ["anthropic"] };
		const pending = routing.previewSmartRouting(setup);
		const writes = vi.spyOn(settings, "commitAtomicBatchWithCurrent");
		const gate = Promise.withResolvers<void>();
		let unknown = false;
		const onSelect = vi.fn(async () => {
			await gate.promise;
			throw new RoutingSettingsConfirmationRequiredError(pending);
		});
		const discardPreview = vi.fn((preview: RoutingSettingsPreview) => routing.discardPreview(preview));
		const onCancel = vi.fn();
		const panel = hostilePanel({ isStateUnknown: () => unknown, onSelect, discardPreview, onCancel });
		const operation = panel.__testRefresh();
		expect(panel.mode).toBe("committing");
		unknown = true;
		expect(renderText(panel)).toContain("reload Settings before continuing");
		gate.resolve();
		await operation;
		expect(panel.confirmation).toBeUndefined();
		const text = renderText(panel);
		expect(text).toContain("reload Settings before continuing");
		expect(text).toContain("Esc: cancel");
		expect(text).not.toContain("Enter confirms");
		expect(text).not.toContain("Pending refresh uses");
		panel.handleInput("\r");
		panel.handleInput("a");
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(discardPreview).toHaveBeenCalledWith(pending);
		await expect(routing.applySmartRouting(setup, { preview: pending, confirmHandEdit: true })).rejects.toThrow(
			"preview is not valid",
		);
		expect(writes).not.toHaveBeenCalled();
		panel.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
		writes.mockRestore();
	});

	test("late committed result remains truthful after invalidation and loses preview authority", async () => {
		let unknown = false;
		const result = hostilePanel().getPreviewPayload();
		const gate = Promise.withResolvers<void>();
		const discardPreview = vi.fn();
		const panel = hostilePanel({
			isStateUnknown: () => unknown,
			onSelect: async () => {
				await gate.promise;
				return result;
			},
			discardPreview,
		});
		const operation = panel.__testRefresh();
		unknown = true;
		renderText(panel);
		gate.resolve();
		await operation;
		const text = renderText(panel);
		expect(panel.mode).toBe("done");
		expect(text).toContain("Global smart-routing settings updated.");
		expect(text).toContain("reload Settings before continuing");
		expect(text).toContain("Effective enabled: unknown");
		expect(text).toContain("Committed preview: unknown.");
		expect(discardPreview).toHaveBeenCalledWith(result);
	});

	for (const operation of ["apply", "refresh"] as const) {
		test(`callback-only ${operation} does not present an unverified committed preview`, async () => {
			const panel = hostilePanel();
			if (operation === "apply") await panel.__testApply();
			else await panel.__testRefresh();
			const text = renderText(panel);
			expect(panel.mode).toBe("done");
			expect(text).toContain("Global smart-routing settings updated.");
			expect(text).toContain("Committed preview: unknown.");
			expect(text).toContain("Draft providers:");
			expect(text).toContain("Effective settings comparison to global: unknown.");
			expect(text).not.toContain("fast-model");
		});
	}

	test("pages through the entire sanitized uncommitted draft without permitting mutations", () => {
		let unknown = false;
		const onSelect = vi.fn(() => undefined);
		const onCancel = vi.fn();
		const setup: AutoroutingSetup = {
			schema: 1,
			providers: ["anthropic"],
			models: ["provider/\x1b[2Jok\x07"],
		};
		const preview = { setup, tiers: { fast: [], balanced: [], strong: [] } } as unknown as RoutingSettingsPreview;
		const panel = new SmartRoutingPanelClass({
			setup,
			enabled: true,
			readOnly: false,
			stale: false,
			preview,
			generatePreview: () => preview,
			isStateUnknown: () => unknown,
			onSelect,
			onCancel,
		});
		panel.handleInput("m");
		const typed = `${"x".repeat(220)}-distinct-suffix`;
		for (const character of typed) panel.handleInput(character);
		const draft = panel.getDraft();
		unknown = true;
		const label = "Uncommitted allowlist draft (read-only): ";
		const pages: string[] = [];
		let rowCount = 0;
		for (let page = 0; page < 4; page++) {
			const rows = panel.render(240);
			if (page === 0) rowCount = rows.length;
			expect(rows).toHaveLength(rowCount);
			for (const row of rows) {
				const plain = Bun.stripANSI(row).trimEnd();
				expect(Bun.stringWidth(plain)).toBeLessThanOrEqual(MAX_PANEL_LINE_WIDTH);
				expect(plain).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
			}
			const text = Bun.stripANSI(rows.join("\n"));
			expect(text).not.toContain("\x1b");
			expect(text).toContain("PageUp/PageDown: inspect draft");
			expect(text).toContain("Esc: cancel");
			const row = rows.map(line => Bun.stripANSI(line).trimEnd()).find(line => line.startsWith(label));
			if (row === undefined) throw new Error("Expected uncommitted draft row");
			pages.push(row.slice(label.length));
			if (page < 3) panel.handleInput("\x1b[6~");
		}
		expect(pages[0]).toStartWith("provider/ok");
		expect(pages[3]).toEndWith("-distinct-suffix");
		expect(pages.join("")).toBe(`provider/ok${typed}`);
		panel.handleInput("\x1b[6~");
		expect(renderText(panel)).toContain(pages[3]);
		panel.handleInput("\x1b[5~");
		expect(renderText(panel)).toContain(pages[2]);
		for (const input of ["\r", "a", "r", "t", "c", "m", "\x7f", "z"]) panel.handleInput(input);
		expect(panel.getDraft()).toEqual(draft);
		expect(onSelect).not.toHaveBeenCalled();
		panel.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
	});

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
		} as unknown as RoutingSettingsPreview;
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
