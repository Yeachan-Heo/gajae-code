import { beforeAll, describe, expect, test } from "bun:test";
import {
	GJC_BUNDLE_SETTINGS_CAPTURE_FILES,
	gjcBundleSettingsCapturePlan,
	renderGjcBundleSettingsEntry,
} from "../scripts/capture-gjc-bundle-settings";
import type { GjcLifecycleContext } from "../src/extensibility/gjc-plugins/lifecycle";
import type { GjcRuntimeSnapshotProvider } from "../src/extensibility/gjc-plugins/runtime-quarantine";
import type {
	GjcBundleIdentity,
	GjcBundleSummary,
	GjcLifecycleResult,
	GjcToggleResult,
	GjcUpdateApplyResult,
	GjcUpdatePreview,
} from "../src/extensibility/gjc-plugins/types";
import { type GjcBundleLifecyclePort, GjcBundleSettingsComponent } from "../src/modes/components/gjc-bundle-settings";
import { PluginSettingsComponent } from "../src/modes/components/plugin-settings";
import { setTheme } from "../src/modes/theme/theme";
import {
	GJC_BUNDLE_SETTINGS_ENTRIES,
	GJC_BUNDLE_SETTINGS_STATES,
	type GjcBundleSettingsFixture,
} from "./fixtures/gjc-bundles-settings-cases";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	const resolvers = Promise.withResolvers<T>();
	return { promise: resolvers.promise, resolve: resolvers.resolve };
}
beforeAll(async () => {
	await setTheme("red-claw");
});

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function sameIdentity(a: GjcBundleIdentity, b: GjcBundleIdentity): boolean {
	return a.kind === b.kind && a.scope === b.scope && a.name === b.name;
}

function cloneSummary(summary: GjcBundleSummary): GjcBundleSummary {
	return {
		...summary,
		identity: { ...summary.identity },
		source: { ...summary.source },
		surfaces: summary.surfaces.map(surface => ({ ...surface })),
	};
}

class InMemoryLifecyclePort implements GjcBundleLifecyclePort {
	readonly bundleToggleCalls: Array<{ identity: GjcBundleIdentity; enabled: boolean }> = [];
	readonly surfaceToggleCalls: Array<{ identity: GjcBundleIdentity; surfaceId: string; enabled: boolean }> = [];
	readonly previewCalls: GjcBundleIdentity[] = [];
	bundleToggleGate: Deferred<GjcLifecycleResult<GjcToggleResult>> | null = null;
	listGate: Deferred<GjcBundleSummary[]> | null = null;
	previewGate: Deferred<GjcLifecycleResult<GjcUpdatePreview>> | null = null;

	constructor(
		private bundles: GjcBundleSummary[],
		private updatePreview: GjcUpdatePreview | null = null,
	) {}

	async listGjcBundles(_ctx: GjcLifecycleContext): Promise<GjcBundleSummary[]> {
		if (this.listGate) return this.listGate.promise;
		return this.bundles.map(cloneSummary);
	}

	async getGjcBundle(
		_ctx: GjcLifecycleContext,
		identity: GjcBundleIdentity,
	): Promise<GjcLifecycleResult<GjcBundleSummary>> {
		const summary = this.bundles.find(candidate => sameIdentity(candidate.identity, identity));
		return summary
			? { ok: true, value: cloneSummary(summary) }
			: { ok: false, error: { code: "not_installed", message: "Not installed." } };
	}

	async previewGjcBundleUpdate(
		_ctx: GjcLifecycleContext,
		identity: GjcBundleIdentity,
	): Promise<GjcLifecycleResult<GjcUpdatePreview>> {
		this.previewCalls.push(identity);
		if (this.previewGate) return this.previewGate.promise;
		if (this.updatePreview && sameIdentity(this.updatePreview.identity, identity))
			return { ok: true, value: this.updatePreview };
		return { ok: false, error: { code: "source_unsupported", message: "Update is unavailable." } };
	}

	async applyGjcBundleUpdate(
		_ctx: GjcLifecycleContext,
		_token: GjcUpdatePreview["token"],
	): Promise<GjcLifecycleResult<GjcUpdateApplyResult>> {
		return { ok: false, error: { code: "stale_candidate", message: "Candidate changed." } };
	}

	async setGjcBundleEnabled(
		_ctx: GjcLifecycleContext,
		identity: GjcBundleIdentity,
		enabled: boolean,
	): Promise<GjcLifecycleResult<GjcToggleResult>> {
		this.bundleToggleCalls.push({ identity, enabled });
		if (this.bundleToggleGate) return this.bundleToggleGate.promise;
		return this.toggleBundle(identity, enabled);
	}

	async setGjcBundleSurfaceEnabled(
		_ctx: GjcLifecycleContext,
		identity: GjcBundleIdentity,
		surfaceId: string,
		enabled: boolean,
	): Promise<GjcLifecycleResult<GjcToggleResult>> {
		this.surfaceToggleCalls.push({ identity, surfaceId, enabled });
		const bundle = this.bundles.find(candidate => sameIdentity(candidate.identity, identity));
		if (!bundle) return { ok: false, error: { code: "not_installed", message: "Not installed." } };
		const surface = bundle.surfaces.find(candidate => candidate.extensionId === surfaceId);
		if (!surface) return { ok: false, error: { code: "surface_unknown", message: "Surface not found." } };
		surface.enabled = enabled;
		return { ok: true, value: { summary: cloneSummary(bundle), mutated: true } };
	}

	toggleBundle(identity: GjcBundleIdentity, enabled: boolean): GjcLifecycleResult<GjcToggleResult> {
		const bundle = this.bundles.find(candidate => sameIdentity(candidate.identity, identity));
		if (!bundle) return { ok: false, error: { code: "not_installed", message: "Not installed." } };
		if (enabled && bundle.quarantined) return { ok: false, error: { code: "quarantined", message: "Quarantined." } };
		bundle.enabled = enabled;
		return { ok: true, value: { summary: cloneSummary(bundle), mutated: true } };
	}
}

function componentFor(
	fixture: GjcBundleSettingsFixture,
	options: {
		lifecycle?: InMemoryLifecyclePort;
		runtime?: GjcRuntimeSnapshotProvider;
		onClose?: () => void;
		onRenderRequested?: () => void;
	} = {},
): GjcBundleSettingsComponent {
	return new GjcBundleSettingsComponent(
		"/safe/project",
		undefined,
		{ onClose: options.onClose ?? (() => {}), onRenderRequested: options.onRenderRequested },
		{
			lifecycle:
				options.lifecycle ?? new InMemoryLifecyclePort(fixture.bundles.map(cloneSummary), fixture.updatePreview),
			runtimeSnapshotProvider: options.runtime ?? { current: () => fixture.runtime },
			activationGeneration: 7,
		},
	);
}

async function ready(component: GjcBundleSettingsComponent): Promise<void> {
	await settle();
	expect(component.stateId).not.toBe("loading");
}

function rendered(component: GjcBundleSettingsComponent, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function select(component: GjcBundleSettingsComponent, down = 0): void {
	for (let index = 0; index < down; index += 1) component.handleInput("\x1b[B");
	component.handleInput("\n");
}

describe("GJC bundle Settings component", () => {
	test("requests repaint after async bundle and plugin list loads", async () => {
		const fixture = GJC_BUNDLE_SETTINGS_STATES.find(state => state.id === "list")!.fixture;
		const lifecycle = new InMemoryLifecyclePort(fixture.bundles.map(cloneSummary));
		lifecycle.listGate = deferred<GjcBundleSummary[]>();
		let bundleRenders = 0;
		const bundle = componentFor(fixture, { lifecycle, onRenderRequested: () => bundleRenders++ });
		const loadingRenders = bundleRenders;
		lifecycle.listGate.resolve(fixture.bundles.map(cloneSummary));
		await ready(bundle);
		expect(bundleRenders).toBeGreaterThan(loadingRenders);
		bundle.dispose();

		let pluginRenders = 0;
		const plugin = new PluginSettingsComponent("/tmp/does-not-need-to-exist", {
			onClose: () => {},
			onPluginChanged: () => {},
			onRenderRequested: () => pluginRenders++,
		});
		for (let attempt = 0; attempt < 100 && pluginRenders === 0; attempt++) await Bun.sleep(5);
		expect(pluginRenders).toBeGreaterThan(0);
		plugin.dispose();
	});

	test("renders every catalog state through the live component and never exposes unsafe locator content", async () => {
		const captured: string[] = [];
		for (const state of GJC_BUNDLE_SETTINGS_STATES) {
			const component = componentFor(state.fixture);
			await ready(component);
			const output = rendered(component);
			expect(output).toContain("GJC Bundles");
			captured.push(output);
			component.dispose();
		}
		const forbidden = /:\/\/user:|@[^\s/]+|[?#]|token|\/Users\/|\/home\//i;
		for (const output of captured) expect(output).not.toMatch(forbidden);
	});

	test("keeps same-name bundles separated by scope when one is toggled", async () => {
		const fixture = GJC_BUNDLE_SETTINGS_STATES.find(state => state.id === "dual-scope-same-name")!.fixture;
		const lifecycle = new InMemoryLifecyclePort(fixture.bundles.map(cloneSummary));
		const component = componentFor(fixture, { lifecycle });
		await ready(component);
		expect(rendered(component)).toContain("shared-name (user)");
		expect(rendered(component)).toContain("shared-name (project)");
		select(component);
		select(component);
		await settle();
		expect(lifecycle.bundleToggleCalls).toEqual([
			{ identity: { kind: "gjc-bundle", scope: "user", name: "shared-name" }, enabled: false },
		]);
		component.handleInput("\x1b");
		expect(rendered(component)).toContain("shared-name (project)");
		component.dispose();
	});

	test("renders mismatched runtime generations as unavailable rather than clear", async () => {
		const fixture = GJC_BUNDLE_SETTINGS_STATES.find(state => state.id === "runtime-current")!.fixture;
		const component = componentFor(fixture, {
			runtime: { current: () => ({ status: "current", snapshot: { generation: 8, findings: [] } }) },
		});
		await ready(component);
		expect(rendered(component)).toContain("runtime unavailable");
		expect(rendered(component)).not.toContain("runtime current");
		component.dispose();
	});

	test("blocks quarantined enablement but permits disablement", async () => {
		const blockedFixture = GJC_BUNDLE_SETTINGS_STATES.find(state => state.id === "quarantined-blocked")!.fixture;
		const disabledQuarantined = cloneSummary(blockedFixture.bundles[0]!);
		disabledQuarantined.enabled = false;
		const disabledFixture: GjcBundleSettingsFixture = { ...blockedFixture, bundles: [disabledQuarantined] };
		const blockedPort = new InMemoryLifecyclePort([cloneSummary(disabledQuarantined)]);
		const blocked = componentFor(disabledFixture, { lifecycle: blockedPort });
		await ready(blocked);
		select(blocked);
		select(blocked);
		expect(blocked.stateId).toBe("quarantined-blocked");
		expect(blockedPort.bundleToggleCalls).toHaveLength(0);
		blocked.dispose();

		const enabledQuarantined = cloneSummary(disabledQuarantined);
		enabledQuarantined.enabled = true;
		const enabledFixture: GjcBundleSettingsFixture = { ...disabledFixture, bundles: [enabledQuarantined] };
		const enabledPort = new InMemoryLifecyclePort([cloneSummary(enabledQuarantined)]);
		const enabled = componentFor(enabledFixture, { lifecycle: enabledPort });
		await ready(enabled);
		select(enabled);
		select(enabled);
		await settle();
		expect(enabledPort.bundleToggleCalls).toHaveLength(1);
		expect(enabledPort.bundleToggleCalls[0]!.enabled).toBe(false);
		enabled.dispose();
	});

	test("locks navigation and suppresses duplicate submissions during a mutation", async () => {
		const fixture = GJC_BUNDLE_SETTINGS_STATES.find(state => state.id === "list")!.fixture;
		const lifecycle = new InMemoryLifecyclePort(fixture.bundles.map(cloneSummary));
		lifecycle.bundleToggleGate = deferred<GjcLifecycleResult<GjcToggleResult>>();
		let closes = 0;
		const component = componentFor(fixture, {
			lifecycle,
			onClose: () => {
				closes += 1;
			},
		});
		await ready(component);
		select(component);
		select(component);
		expect(component.navigationLocked).toBe(true);
		component.handleInput("\x1b");
		component.handleInput("\n");
		expect(closes).toBe(0);
		expect(lifecycle.bundleToggleCalls).toHaveLength(1);
		lifecycle.bundleToggleGate.resolve(lifecycle.toggleBundle(lifecycle.bundleToggleCalls[0]!.identity, false));
		await settle();
		expect(component.navigationLocked).toBe(false);
		component.dispose();
	});

	test("discards a late update preview after focus moves to another identity", async () => {
		const fixture = GJC_BUNDLE_SETTINGS_STATES.find(state => state.id === "dual-scope-same-name")!.fixture;
		const lifecycle = new InMemoryLifecyclePort(fixture.bundles.map(cloneSummary));
		lifecycle.previewGate = deferred<GjcLifecycleResult<GjcUpdatePreview>>();
		const component = componentFor(fixture, { lifecycle });
		await ready(component);
		select(component);
		select(component, 1);
		expect(lifecycle.previewCalls).toHaveLength(1);
		component.handleInput("\x1b");
		select(component, 1);
		lifecycle.previewGate.resolve({ ok: false, error: { code: "source_unsupported", message: "Late result." } });
		await settle();
		expect(component.stateId).toBe("detail");
		expect(rendered(component)).toContain("shared-name (project)");
		component.dispose();
	});

	test("plans exactly four deterministic artifacts for every expanded showcase entry", async () => {
		const plan = gjcBundleSettingsCapturePlan(GJC_BUNDLE_SETTINGS_ENTRIES);
		expect(plan).toHaveLength(77 * 4);
		expect(GJC_BUNDLE_SETTINGS_ENTRIES).toHaveLength(77);
		for (const entry of GJC_BUNDLE_SETTINGS_ENTRIES) {
			expect(
				plan
					.filter(item => item.entryId === entry.entryId)
					.map(item => item.fileName)
					.sort(),
			).toEqual([...GJC_BUNDLE_SETTINGS_CAPTURE_FILES].sort());
		}
		const first = await renderGjcBundleSettingsEntry(GJC_BUNDLE_SETTINGS_ENTRIES[0]!);
		const second = await renderGjcBundleSettingsEntry(GJC_BUNDLE_SETTINGS_ENTRIES[0]!);
		expect(second).toEqual(first);
	});
});
