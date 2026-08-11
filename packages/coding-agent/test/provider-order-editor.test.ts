import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, type SettingPath, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import {
	ProviderOrderContext,
	type ProviderOrderSnapshot,
} from "@gajae-code/coding-agent/modes/components/provider-order-context";
import { ProviderOrderEditorComponent } from "@gajae-code/coding-agent/modes/components/provider-order-editor";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";

interface Fixture {
	settings: Settings;
	registry: ModelRegistry;
	context: ProviderOrderContext;
	emitAuthGeneration: () => void;
	getSnapshot: () => ProviderOrderSnapshot;
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Fake auth storage that records active generation listeners so tests can assert disposal. */
function createRegistry(
	catalog: Array<{ provider: string }>,
	authListeners: Set<() => void>,
): { registry: ModelRegistry } {
	const authStorage = {
		onGenerationChanged(listener: () => void) {
			authListeners.add(listener);
			return () => authListeners.delete(listener);
		},
	} as unknown as AuthStorage;
	const registry = {
		authStorage,
		getAll: () => catalog,
		hasConfiguredProviderAuth: (provider: string) => provider === "alpha",
	} as unknown as ModelRegistry;
	return { registry };
}

function createFixture(order: string[] = []): Fixture {
	const settingsInstance = Settings.isolated({ modelProviderOrder: order });
	const authListeners = new Set<() => void>();
	const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
	const context = new ProviderOrderContext(registry, settingsInstance);
	return {
		settings: settingsInstance,
		registry,
		context,
		emitAuthGeneration: () => {
			for (const listener of [...authListeners]) listener();
		},
		getSnapshot: () => context.snapshot(),
	};
}

/** A fresh editor over a fresh context sharing the fixture's registry + settings. */
function editorFor(fixture: Fixture): ProviderOrderEditorComponent {
	return new ProviderOrderEditorComponent(new ProviderOrderContext(fixture.registry, fixture.settings), () => {});
}

function render(editor: ProviderOrderEditorComponent): string {
	return Bun.stripANSI(editor.render(120).join("\n"));
}

async function settlePersistence(): Promise<void> {
	await Bun.sleep(0);
	await Promise.resolve();
}

describe("ProviderOrderContext", () => {
	test("retains unavailable persisted providers and skips unrelated setting invalidations", () => {
		const settingsInstance = Settings.isolated({ modelProviderOrder: ["missing", "alpha", "missing"] });
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
		const changed = vi.fn();
		const context = new ProviderOrderContext(registry, settingsInstance, changed);

		expect(context.snapshot().order).toEqual(["missing", "alpha"]);
		expect(context.snapshot().entries).toEqual([
			expect.objectContaining({ id: "missing", available: false, inOrder: true }),
			expect.objectContaining({ id: "alpha", available: true, authenticated: true, inOrder: true }),
			expect.objectContaining({ id: "beta", available: true, inOrder: false }),
		]);

		settingsInstance.set("theme.dark", "red-claw");
		expect(changed).not.toHaveBeenCalled();
		settingsInstance.set("modelProviderOrder", ["beta"]);
		expect(changed).toHaveBeenCalledTimes(1);
		for (const listener of [...authListeners]) listener();
		expect(changed).toHaveBeenCalledTimes(2);

		context.dispose();
		settingsInstance.set("modelProviderOrder", ["alpha"]);
		for (const listener of [...authListeners]) listener();
		expect(changed).toHaveBeenCalledTimes(2);
	});

	test("settings read failure surfaces instead of silently becoming an empty order", () => {
		const settingsInstance = Settings.isolated({ modelProviderOrder: ["alpha"] });
		const originalGetGlobal = settingsInstance.getGlobal.bind(settingsInstance);
		const getSpy = vi.spyOn(settingsInstance, "getGlobal").mockImplementation(path => {
			if (path === "modelProviderOrder") throw new Error("config.yml is malformed");
			return originalGetGlobal(path);
		});
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }], authListeners);
		const context = new ProviderOrderContext(registry, settingsInstance);

		expect(() => context.snapshot()).toThrow("config.yml is malformed");
		getSpy.mockRestore();
	});

	test("reads the global provider order instead of a masking runtime override", () => {
		const settingsInstance = Settings.isolated({ modelProviderOrder: ["alpha"] });
		settingsInstance.override("modelProviderOrder", ["beta"]);
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
		const context = new ProviderOrderContext(registry, settingsInstance);

		expect(settingsInstance.get("modelProviderOrder")).toEqual(["beta"]);
		expect(context.snapshot().order).toEqual(["alpha"]);
	});

	test("treats malformed non-array provider order as empty", () => {
		const settingsInstance = Settings.isolated();
		vi.spyOn(settingsInstance, "getGlobal").mockReturnValue("openrouter" as never);
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }], authListeners);
		const context = new ProviderOrderContext(registry, settingsInstance);

		expect(context.snapshot().order).toEqual([]);
	});

	test("uses the catalog provider spelling for mixed-case custom auth lookup", () => {
		const settingsInstance = Settings.isolated();
		const authListeners = new Set<() => void>();
		const authStorage = {
			onGenerationChanged(listener: () => void) {
				authListeners.add(listener);
				return () => authListeners.delete(listener);
			},
		} as unknown as AuthStorage;
		const registry = {
			authStorage,
			getAll: () => [{ provider: "CustomRouter" }],
			hasConfiguredProviderAuth: (provider: string) => provider === "CustomRouter",
		} as unknown as ModelRegistry;
		const context = new ProviderOrderContext(registry, settingsInstance);

		expect(context.snapshot().entries).toContainEqual(
			expect.objectContaining({ id: "customrouter", authenticated: true }),
		);
	});
});

describe("ProviderOrderEditorComponent", () => {
	test("adds, moves, removes, and resets providers with immediate persistence", async () => {
		const fixture = createFixture([]);
		const editor = editorFor(fixture);

		editor.handleInput("\n");
		editor.handleInput("\x1b[B");
		editor.handleInput("\n");
		await settlePersistence();
		expect(fixture.settings.get("modelProviderOrder")).toEqual(["alpha"]);
		editor.handleInput("\x1b");

		let view = render(editor);
		expect(view).toContain("#1 ALPHA");
		expect(view).toContain("logged in");

		const second = editorFor(fixture);
		second.handleInput("\n");
		second.handleInput("\x1b[B");
		second.handleInput("\n");
		await settlePersistence();
		expect(fixture.settings.get("modelProviderOrder")).toEqual(["alpha", "beta"]);

		const mover = editorFor(fixture);
		for (let index = 0; index < 7; index += 1) mover.handleInput("\x1b[B");
		mover.handleInput("\n");
		await settlePersistence();
		expect(fixture.settings.get("modelProviderOrder")).toEqual(["beta", "alpha"]);

		const remover = editorFor(fixture);
		for (let index = 0; index < 5; index += 1) remover.handleInput("\x1b[B");
		remover.handleInput("\n");
		await settlePersistence();
		expect(fixture.settings.get("modelProviderOrder")).toEqual(["alpha"]);

		const resetter = editorFor(fixture);
		resetter.handleInput("\x1b[B");
		resetter.handleInput("\n");
		await settlePersistence();
		expect(fixture.settings.get("modelProviderOrder")).toEqual([]);
		view = render(resetter);
		expect(view).toContain("No providers in priority order yet");
	});

	test("rebuilds after auth invalidation while preserving the selected provider", () => {
		const fixture = createFixture(["alpha", "missing"]);
		let editor: ProviderOrderEditorComponent | undefined;
		const context = new ProviderOrderContext(fixture.registry, fixture.settings);
		editor = new ProviderOrderEditorComponent(context, () => {});
		for (let index = 0; index < 6; index += 1) editor.handleInput("\x1b[B");
		expect(render(editor)).toContain("❯ #2 MISSING");

		fixture.emitAuthGeneration();
		editor.refresh();
		expect(render(editor)).toContain("❯ #2 MISSING");
		expect(fixture.getSnapshot().entries.find(entry => entry.id === "missing")?.available).toBe(false);
	});

	test("preserves the selected provider across settings-driven rebuilds", () => {
		const fixture = createFixture(["alpha", "beta"]);
		const editor = editorFor(fixture);
		for (let index = 0; index < 6; index += 1) editor.handleInput("\x1b[B");
		expect(render(editor)).toContain("❯ #2 BETA");

		fixture.settings.set("modelProviderOrder", ["beta", "alpha"]);
		editor.refresh();
		expect(render(editor)).toContain("❯ #1 BETA");
	});

	test("rebuilds from the live snapshot before the render pass that follows a change", () => {
		const fixture = createFixture(["alpha"]);
		const editor = editorFor(fixture);
		expect(render(editor)).toContain("#1 ALPHA");

		fixture.settings.set("modelProviderOrder", ["beta"]);
		// The change handler refreshes the editor before requesting a repaint;
		// the next render must reflect the new snapshot, not the stale rows.
		editor.refresh();
		expect(render(editor)).toContain("#1 BETA");
		expect(render(editor)).not.toContain("#1 ALPHA");
	});

	test("catalog-only changes are not live until the editor reopens", () => {
		const settingsInstance = Settings.isolated({ modelProviderOrder: ["alpha"] });
		const authListeners = new Set<() => void>();
		const catalog = [{ provider: "alpha" }, { provider: "beta" }];
		const { registry } = createRegistry(catalog, authListeners);
		const editor = new ProviderOrderEditorComponent(new ProviderOrderContext(registry, settingsInstance), () => {});
		expect(render(editor)).toContain("#1 ALPHA");
		expect(render(editor)).toContain("logged in");

		// The catalog changes while the editor is open. There is no catalog
		// event, so the open editor keeps showing the stale snapshot.
		catalog.splice(0, catalog.length, { provider: "gamma" });
		expect(render(editor)).toContain("#1 ALPHA");
		expect(render(editor)).not.toContain("GAMMA");

		// Reopening (fresh context over the same registry) reflects the new catalog:
		// the saved provider is retained but reported unavailable, and the add page
		// lists the new catalog provider.
		const reopened = new ProviderOrderEditorComponent(new ProviderOrderContext(registry, settingsInstance), () => {});
		expect(render(reopened)).toContain("#1 ALPHA");
		expect(render(reopened)).toContain("unavailable");
		reopened.handleInput("\n");
		expect(render(reopened)).toContain("GAMMA");
	});

	test("move at the order boundaries is a no-op", () => {
		const fixture = createFixture(["alpha"]);
		const editor = editorFor(fixture);

		for (let index = 0; index < 3; index += 1) editor.handleInput("\x1b[B"); // Move up: ALPHA.
		editor.handleInput("\n");
		expect(fixture.settings.get("modelProviderOrder")).toEqual(["alpha"]);

		editor.handleInput("\x1b[B"); // Move down: ALPHA.
		editor.handleInput("\n");
		expect(fixture.settings.get("modelProviderOrder")).toEqual(["alpha"]);
	});

	test("shows an empty state when every known provider is already in the order", () => {
		const fixture = createFixture(["alpha", "beta"]);
		const editor = editorFor(fixture);

		editor.handleInput("\n"); // Add provider.
		expect(render(editor)).toContain("Every known provider is already in the priority order.");
	});

	test("closing the editor releases the context subscriptions", () => {
		const fixture = createFixture(["alpha"]);
		const changed = vi.fn();
		const context = new ProviderOrderContext(fixture.registry, fixture.settings, changed);
		const editor = new ProviderOrderEditorComponent(context, () => {});

		editor.handleInput("\x1b"); // Normal close.
		fixture.settings.set("modelProviderOrder", ["beta"]);
		fixture.emitAuthGeneration();
		expect(changed).not.toHaveBeenCalled();
	});

	test("direct dispose releases the context subscriptions idempotently", () => {
		const fixture = createFixture(["alpha"]);
		const changed = vi.fn();
		const context = new ProviderOrderContext(fixture.registry, fixture.settings, changed);
		const editor = new ProviderOrderEditorComponent(context, () => {});

		editor.dispose();
		editor.dispose(); // Idempotent; late input and render stay safe.
		editor.handleInput("\x1b");
		fixture.settings.set("modelProviderOrder", ["beta"]);
		fixture.emitAuthGeneration();
		expect(changed).not.toHaveBeenCalled();
		expect(() => render(editor)).not.toThrow();
	});
	test("constructor failure disposes the already-subscribed context before rethrowing", () => {
		const settingsInstance = Settings.isolated({ modelProviderOrder: ["alpha"] });
		const originalGetGlobal = settingsInstance.getGlobal.bind(settingsInstance);
		const getSpy = vi.spyOn(settingsInstance, "getGlobal").mockImplementation(path => {
			if (path === "modelProviderOrder") throw new Error("config.yml is malformed");
			return originalGetGlobal(path);
		});
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }], authListeners);
		const changed = vi.fn();
		const context = new ProviderOrderContext(registry, settingsInstance, changed);

		// The initial rebuild reads `modelProviderOrder` and throws; the editor
		// must release the context subscriptions it received before rethrowing.
		expect(() => new ProviderOrderEditorComponent(context, () => {})).toThrow("config.yml is malformed");
		expect(authListeners.size).toBe(0);

		getSpy.mockRestore();
		settingsInstance.set("modelProviderOrder", ["beta"]);
		expect(changed).not.toHaveBeenCalled();
	});

	test("reports durable save failure and restores the prior global order", async () => {
		const fixture = createFixture(["alpha"]);
		const errors: string[] = [];
		vi.spyOn(fixture.settings, "flushOrThrow").mockRejectedValueOnce(new Error("disk full"));
		const editor = new ProviderOrderEditorComponent(
			new ProviderOrderContext(fixture.registry, fixture.settings),
			() => {},
			message => errors.push(message),
		);

		editor.handleInput("\x1b[B");
		editor.handleInput("\n");
		await settlePersistence();

		expect(errors).toEqual(["disk full"]);
		expect(fixture.settings.getGlobal("modelProviderOrder")).toEqual(["alpha"]);
	});
});

describe("SettingsSelectorComponent provider order integration", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	function openProvidersTab(component: SettingsSelectorComponent): void {
		for (let index = 0; index < 8; index += 1) component.handleInput("\t");
	}

	function createSelector(registry: ModelRegistry, errors: string[]): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["red-claw", "blue-crab"],
				availableModelProfiles: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {},
				onCancel: () => {},
				createProviderOrderEditor: closeEditor => {
					// Mirrors the controller wiring: a fresh context per open whose
					// subscriptions the editor disposes on close or teardown.
					let editor: ProviderOrderEditorComponent | undefined;
					const context = new ProviderOrderContext(registry, settings, () => {
						editor?.refresh();
					});
					editor = new ProviderOrderEditorComponent(
						context,
						() => {
							closeEditor();
						},
						message => errors.push(message),
					);
					return editor;
				},
			},
		);
	}

	test("summarizes only the global provider order when a runtime override differs", () => {
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
		settings.set("modelProviderOrder", ["alpha"]);
		settings.override("modelProviderOrder", ["alpha", "beta"]);
		const component = createSelector(registry, []);

		openProvidersTab(component);
		component.handleInput("priority");

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("1 configured");
		expect(rendered).not.toContain("2 configured");
		component.dispose();
	});

	test("refreshes the parent configured-count summary when the editor closes", async () => {
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
		const errors: string[] = [];
		const component = createSelector(registry, errors);

		openProvidersTab(component);
		component.handleInput("priority");
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("0 configured");

		component.handleInput("\n"); // Open the provider priority order editor.
		component.handleInput("\n"); // Add provider.
		component.handleInput("\x1b[B"); // Candidate: ALPHA.
		component.handleInput("\n"); // Append ALPHA to the order.
		await settlePersistence();
		expect(settings.get("modelProviderOrder")).toEqual(["alpha"]);
		component.handleInput("\x1b"); // Back to the order main page.
		component.handleInput("\x1b"); // Close the editor.

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("1 configured");
		expect(errors).toEqual([]);
	});

	test("repeated opens and closes leak no listeners; external teardown releases them too", () => {
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
		const activeSettingsListeners = new Set<(path: SettingPath) => void>();
		const realOnChanged = Settings.instance.onChanged.bind(Settings.instance);
		vi.spyOn(Settings.instance, "onChanged").mockImplementation(listener => {
			activeSettingsListeners.add(listener);
			const unsubscribe = realOnChanged(listener);
			return () => {
				activeSettingsListeners.delete(listener);
				unsubscribe();
			};
		});

		const errors: string[] = [];
		const component = createSelector(registry, errors);
		openProvidersTab(component);
		component.handleInput("priority");

		for (let round = 0; round < 3; round += 1) {
			component.handleInput("\n"); // Open the editor (fresh context).
			expect(activeSettingsListeners.size).toBe(1);
			expect(authListeners.size).toBe(1);
			component.handleInput("\x1b"); // Close it.
			expect(activeSettingsListeners.size).toBe(0);
			expect(authListeners.size).toBe(0);
		}

		// External teardown while the editor is still open must release its
		// subscriptions too (no normal close path runs).
		component.handleInput("\n");
		expect(activeSettingsListeners.size).toBe(1);
		expect(authListeners.size).toBe(1);
		component.dispose();
		expect(activeSettingsListeners.size).toBe(0);
		expect(authListeners.size).toBe(0);
		expect(errors).toEqual([]);
	});
	test("switching tabs while the provider-order editor is open releases its subscriptions", () => {
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
		const activeSettingsListeners = new Set<(path: SettingPath) => void>();
		const realOnChanged = Settings.instance.onChanged.bind(Settings.instance);
		vi.spyOn(Settings.instance, "onChanged").mockImplementation(listener => {
			activeSettingsListeners.add(listener);
			const unsubscribe = realOnChanged(listener);
			return () => {
				activeSettingsListeners.delete(listener);
				unsubscribe();
			};
		});

		const errors: string[] = [];
		const component = createSelector(registry, errors);
		openProvidersTab(component);
		component.handleInput("priority");

		component.handleInput("\n"); // Open the editor (fresh context).
		expect(activeSettingsListeners.size).toBe(1);
		expect(authListeners.size).toBe(1);

		// Tab switch abandons the nested submenu without a normal close; the
		// selector must dispose the editor so no listener survives.
		component.handleInput("\t");
		expect(activeSettingsListeners.size).toBe(0);
		expect(authListeners.size).toBe(0);
		expect(errors).toEqual([]);

		// A later parent teardown stays safe with no editor open.
		component.dispose();
		expect(activeSettingsListeners.size).toBe(0);
		expect(authListeners.size).toBe(0);
	});

	test("parent summary shows the normalized configured count for legacy duplicate/blank values", () => {
		const authListeners = new Set<() => void>();
		const { registry } = createRegistry([{ provider: "alpha" }, { provider: "beta" }], authListeners);
		settings.set("modelProviderOrder", ["alpha", "ALPHA", "", "  beta ", "  "]);
		const errors: string[] = [];
		const component = createSelector(registry, errors);

		openProvidersTab(component);
		component.handleInput("priority");
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("2 configured");
		expect(rendered).not.toContain("5 configured");
		expect(errors).toEqual([]);
	});
});
