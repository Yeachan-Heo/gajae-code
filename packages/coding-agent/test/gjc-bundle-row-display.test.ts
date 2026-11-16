import { beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import type { GjcBundleSummary } from "../src/extensibility/gjc-plugins/types";
import type { GjcBundleLifecyclePort } from "../src/modes/components/gjc-bundle-settings";
import { GjcBundleSettingsComponent } from "../src/modes/components/gjc-bundle-settings";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const OSC52 = "\x1b]52;c;";
const OSC0 = "\x1b]0;";
const BEL = "\x07";
const CSI_UP = "\x1b[1A";
const SEED = 20261028;
const miss = { ok: false as const, error: { code: "not_installed" as const, message: "no" } };

beforeAll(async () => {
	const loaded = await getThemeByName("red-claw");
	if (!loaded) throw new Error("Failed to load red-claw theme");
	setThemeInstance(loaded);
});

function summary(name: string, surfaceName: string, version = "1.2.0"): GjcBundleSummary {
	return {
		identity: { kind: "gjc-bundle", scope: "project", name },
		version,
		description: "Catalog tools",
		enabled: true,
		source: {
			kind: "git",
			display: "bundle-cache/catalog",
			resolvedAt: "2026-01-02T00:00:00.000Z",
			updatable: true,
		},
		installedAt: "2026-01-02T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		manifestHash: "abc",
		targetFingerprint: "fp",
		surfaces: [{ extensionId: "tool:catalog", kind: "tool", name: surfaceName, enabled: true, quarantined: false }],
		quarantined: false,
	};
}

function port(bundle: GjcBundleSummary): GjcBundleLifecyclePort {
	return {
		listGjcBundles: async () => [bundle],
		getGjcBundle: async () => miss,
		previewGjcBundleUpdate: async () => miss,
		applyGjcBundleUpdate: async () => miss,
		setGjcBundleEnabled: async () => miss,
		setGjcBundleSurfaceEnabled: async () => miss,
	};
}

async function open(bundle: GjcBundleSummary): Promise<GjcBundleSettingsComponent> {
	const component = new GjcBundleSettingsComponent("project", { onClose() {} }, { lifecycle: port(bundle) });
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
	return component;
}

describe("GJC bundle row display", () => {
	it("does not draw bundle or surface terminal controls", async () => {
		const component = await open(
			summary(`${OSC52}PAYLOAD${BEL}${CSI_UP}tools`, `${OSC0}title${BEL}catalog`, `${OSC52}v${BEL}1.2.0`),
		);
		const raw = component.render(100).join("\n");
		expect(raw).not.toContain("\x1b]");
		expect(raw).not.toContain(CSI_UP);
		expect(raw).not.toContain(BEL);
		expect(raw).toContain("tools (project)");
		expect(raw).toContain("1.2.0");
		component.handleInput("\n");
		const detail = component.render(100).join("\n");
		expect(component.stateId).toBe("detail");
		expect(detail).not.toContain("\x1b]");
		expect(detail).not.toContain(CSI_UP);
		expect(detail).not.toContain(BEL);
		expect(detail).toContain("tools (project)");
		expect(detail).toContain("catalog (tool)");
		expect(detail).toContain("bundle-cache/catalog");
		expect(detail).toContain("Catalog tools");
	});

	it("still shows spaced names, letter case, and plain versions", async () => {
		const component = await open(summary("  My Bundle  ", "Catalog", "1.2.0"));
		const raw = component.render(100).join("\n");
		expect(raw).toContain("My Bundle (project)");
		expect(raw).toContain("v1.2.0");
		component.handleInput("\n");
		const detail = component.render(120).join("\n");
		expect(detail).toContain("  My Bundle  ");
		expect(detail).toContain("Catalog (tool)");
		expect(detail).toContain("Catalog tools");
	});

	it("property: bundle rows drop OSC and cursor controls, seed 20261028, 64 inputs", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ maxLength: 16 }), async extra => {
				const component = await open(summary(`${OSC52}${extra}${BEL}tools`, `${OSC0}${extra}${BEL}catalog`));
				const raw = component.render(100).join("\n");
				expect(raw).not.toContain("\x1b]");
				expect(raw).not.toContain(BEL);
				expect(raw).toContain("tools");
				component.handleInput("\n");
				const detail = component.render(100).join("\n");
				expect(detail).not.toContain("\x1b]");
				expect(detail).toContain("catalog");
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});
});
