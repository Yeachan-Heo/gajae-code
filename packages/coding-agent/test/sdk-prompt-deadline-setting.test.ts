import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { hasUi, reconcileSettingsSchema } from "@gajae-code/coding-agent/config/settings-schema";

const SETTING_PATH = "sdk.promptDeadlineMs";

function schemaReportFor(value: unknown) {
	return reconcileSettingsSchema({ sdk: { promptDeadlineMs: value } }).report;
}

describe("sdk.promptDeadlineMs", () => {
	it("defaults to 1,800,000 milliseconds", () => {
		expect(Settings.isolated().get(SETTING_PATH)).toBe(1_800_000);
	});

	it("accepts its inclusive safe-integer bounds", () => {
		for (const value of [60_000, 86_400_000]) {
			expect(schemaReportFor(value)).toEqual({ issues: [], valid: true });
		}
	});

	it("rejects values outside its safe-integer bounds", () => {
		for (const value of [59_999, 86_400_001, 0, -1, 60_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const report = schemaReportFor(value);
			expect(report.valid).toBe(false);
			expect(report.issues).toContainEqual(expect.objectContaining({ path: SETTING_PATH, kind: "invalid" }));
		}
	});

	it("is hidden from normal settings UI listings", () => {
		expect(hasUi(SETTING_PATH)).toBe(false);
	});

	it("publishes its inclusive bounds in the generated JSON schema", async () => {
		const schema = JSON.parse(
			await Bun.file(new URL("../../../schemas/config.schema.json", import.meta.url)).text(),
		) as {
			properties: {
				sdk: { properties: { promptDeadlineMs: { type: string; minimum: number; maximum: number } } };
			};
		};

		expect(schema.properties.sdk.properties.promptDeadlineMs).toMatchObject({
			type: "integer",
			minimum: 60_000,
			maximum: 86_400_000,
		});
	});
});
