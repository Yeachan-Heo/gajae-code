import { describe, expect, it } from "bun:test";
import { reconcileSettingsSchema, SETTINGS_SCHEMA } from "../src/config/settings-schema";

describe("settings array item validation", () => {
	const fallbackItemValues = SETTINGS_SCHEMA["web_search.fallback"].items.enum;
	it("accepts supported web search fallback providers", () => {
		const reconciled = reconcileSettingsSchema({ web_search: { fallback: ["exa", "brave"] } });

		expect(reconciled.report.valid).toBe(true);
		expect(reconciled.settings.web_search).toEqual({ fallback: ["exa", "brave"] });
	});

	it.each(["typo-provider", 42])("rejects unsupported web search fallback item %j", item => {
		const reconciled = reconcileSettingsSchema({ web_search: { fallback: [item] } });

		expect(reconciled.report.valid).toBe(false);
		expect(reconciled.report.issues).toContainEqual({
			path: "web_search.fallback",
			kind: "invalid",
			detail: `Expected array items to be one of: ${fallbackItemValues.join(", ")}.`,
		});
	});

	it("reports the array container error for a non-array fallback value", () => {
		const reconciled = reconcileSettingsSchema({ web_search: { fallback: "exa" } });

		expect(reconciled.report.valid).toBe(false);
		expect(reconciled.report.issues).toContainEqual({
			path: "web_search.fallback",
			kind: "invalid",
			detail: "Expected array.",
		});
	});

	it("preserves container-only validation for arrays without item metadata", () => {
		const reconciled = reconcileSettingsSchema({ extensions: [42] });

		expect(reconciled.report.valid).toBe(true);
		expect(reconciled.settings.extensions).toEqual([42]);
	});
});
