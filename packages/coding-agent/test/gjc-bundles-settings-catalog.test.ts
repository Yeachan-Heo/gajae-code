import { describe, expect, test } from "bun:test";
import {
	GJC_BUNDLE_SETTINGS_ENTRIES,
	GJC_BUNDLE_SETTINGS_STATES,
	GJC_BUNDLE_SETTINGS_VARIANTS,
	GJC_BUNDLE_SETTINGS_VIEWPORTS,
} from "./fixtures/gjc-bundles-settings-cases";

const EXPECTED_ENTRY_IDS = [
	"cjk/120x36/unicode-color",
	"cjk/160x48/unicode-color",
	"cjk/48x36/unicode-color",
	"cjk/80x24/unicode-color",
	"detail/120x36/unicode-color",
	"detail/160x48/unicode-color",
	"detail/80x24/ascii-no-color",
	"detail/80x24/unicode-color",
	"dual-scope-same-name/120x36/ascii-no-color",
	"dual-scope-same-name/120x36/unicode-color",
	"dual-scope-same-name/160x48/unicode-color",
	"dual-scope-same-name/80x24/unicode-color",
	"empty/120x36/unicode-color",
	"empty/160x48/unicode-color",
	"empty/80x24/unicode-color",
	"error/120x36/unicode-color",
	"error/160x48/unicode-color",
	"error/80x24/ascii-no-color",
	"error/80x24/unicode-color",
	"invalidated-snapshot/120x36/unicode-color",
	"invalidated-snapshot/160x48/unicode-color",
	"invalidated-snapshot/80x24/unicode-color",
	"list/120x36/unicode-color",
	"list/160x48/unicode-color",
	"list/80x24/unicode-color",
	"loading/120x36/unicode-color",
	"loading/160x48/unicode-color",
	"loading/80x24/unicode-color",
	"long-name-wrapping/120x36/unicode-color",
	"long-name-wrapping/160x48/unicode-color",
	"long-name-wrapping/80x24/unicode-color",
	"many-surfaces-scroll/120x36/unicode-color",
	"many-surfaces-scroll/160x48/unicode-color",
	"many-surfaces-scroll/48x36/unicode-color",
	"many-surfaces-scroll/80x24/unicode-color",
	"mutation-in-flight-locked/120x36/unicode-color",
	"mutation-in-flight-locked/160x48/unicode-color",
	"mutation-in-flight-locked/80x24/unicode-color",
	"quarantined-blocked/120x36/ascii-no-color",
	"quarantined-blocked/120x36/unicode-color",
	"quarantined-blocked/160x48/unicode-color",
	"quarantined-blocked/80x24/unicode-color",
	"retry/120x36/unicode-color",
	"retry/160x48/unicode-color",
	"retry/80x24/unicode-color",
	"runtime-current/120x36/unicode-color",
	"runtime-current/160x48/unicode-color",
	"runtime-current/80x24/unicode-color",
	"runtime-unavailable/120x36/unicode-color",
	"runtime-unavailable/160x48/unicode-color",
	"runtime-unavailable/80x24/ascii-no-color",
	"runtime-unavailable/80x24/unicode-color",
	"stale-result/120x36/unicode-color",
	"stale-result/160x48/unicode-color",
	"stale-result/80x24/unicode-color",
	"toggle-bundle/120x36/unicode-color",
	"toggle-bundle/160x48/unicode-color",
	"toggle-bundle/80x24/unicode-color",
	"toggle-surface/120x36/unicode-color",
	"toggle-surface/160x48/unicode-color",
	"toggle-surface/80x24/unicode-color",
	"unsupported-source/120x36/unicode-color",
	"unsupported-source/160x48/unicode-color",
	"unsupported-source/80x24/unicode-color",
	"update-confirm/120x36/unicode-color",
	"update-confirm/160x48/unicode-color",
	"update-confirm/80x24/ascii-no-color",
	"update-confirm/80x24/unicode-color",
	"update-result/120x36/unicode-color",
	"update-result/160x48/unicode-color",
	"update-result/80x24/unicode-color",
	"update-review/120x36/unicode-color",
	"update-review/160x48/unicode-color",
	"update-review/80x24/unicode-color",
	"update-running/120x36/unicode-color",
	"update-running/160x48/unicode-color",
	"update-running/80x24/unicode-color",
] as const;

function stringsIn(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
	return [];
}

describe("GJC bundle Settings catalog", () => {
	test("has the fixed state, viewport, and variant counts", () => {
		expect(GJC_BUNDLE_SETTINGS_STATES).toHaveLength(23);
		expect(GJC_BUNDLE_SETTINGS_VIEWPORTS).toHaveLength(3);
		expect(GJC_BUNDLE_SETTINGS_VARIANTS).toHaveLength(8);
		expect(GJC_BUNDLE_SETTINGS_VARIANTS.filter(variant => variant.renderMode === "ascii-no-color")).toHaveLength(6);
		const narrowVariants = GJC_BUNDLE_SETTINGS_VARIANTS.filter(variant => variant.viewportId === "48x36");
		expect(narrowVariants).toHaveLength(2);
		expect(narrowVariants.every(variant => variant.renderMode === "unicode-color")).toBe(true);
	});

	test("expands to the fixed 77-entry matrix with stable unique identifiers", () => {
		expect(GJC_BUNDLE_SETTINGS_ENTRIES).toHaveLength(77);
		expect(23 * 3 + 6 + 2).toBe(77);
		const entryIds = GJC_BUNDLE_SETTINGS_ENTRIES.map(entry => entry.entryId);
		expect(new Set(entryIds).size).toBe(entryIds.length);
		expect([...entryIds].sort()).toEqual([...EXPECTED_ENTRY_IDS]);
	});

	test("references known states and contains only inert safe fixture strings", () => {
		const stateIds = new Set(GJC_BUNDLE_SETTINGS_STATES.map(state => state.id));
		for (const variant of GJC_BUNDLE_SETTINGS_VARIANTS) expect(stateIds.has(variant.stateId)).toBe(true);

		const forbidden = /:\/\/user:|@[^\s/]+|[?#]|token|\/Users\/|\/home\//i;
		for (const value of stringsIn(GJC_BUNDLE_SETTINGS_STATES)) expect(value).not.toMatch(forbidden);
	});
});
