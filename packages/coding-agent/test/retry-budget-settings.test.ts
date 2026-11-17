import { describe, expect, it } from "bun:test";
import { reconcileSettingsSchema, SETTINGS_SCHEMA } from "../src/config/settings-schema";

describe("retry budget settings schema", () => {
	it("preserves independently configured request and stream retry budgets", () => {
		for (const retry of [
			{ requestMaxRetries: 0, streamMaxRetries: 7 },
			{ requestMaxRetries: 3, streamMaxRetries: 0 },
		]) {
			const reconciled = reconcileSettingsSchema({ retry: { ...retry } });

			expect(reconciled.settings).toEqual({ retry });
			expect(reconciled.report).toEqual({ issues: [], valid: true });
		}
	});

	it("defines a finite nonnegative first-event timeout with a bounded default", () => {
		const setting = SETTINGS_SCHEMA["retry.streamFirstEventTimeoutMs"];

		expect(setting.type).toBe("number");
		expect(setting.default).toBe(100_000);
		expect(setting.validate?.(0)).toBe(true);
		expect(setting.validate?.(12_345)).toBe(true);
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "invalid", null, {}]) {
			const reconciled = reconcileSettingsSchema({ retry: { streamFirstEventTimeoutMs: value } });

			expect(setting.validate?.(value as number), String(value)).toBe(false);
			expect(reconciled.report.valid, String(value)).toBe(false);
			expect(reconciled.report.issues).toContainEqual({
				path: "retry.streamFirstEventTimeoutMs",
				kind: "invalid",
				detail: "Expected number.",
			});
		}
		for (const value of [0, 1, 12_345]) {
			const reconciled = reconcileSettingsSchema({ retry: { streamFirstEventTimeoutMs: value } });

			expect(reconciled.report.valid).toBe(true);
			expect(reconciled.settings.retry).toEqual({ streamFirstEventTimeoutMs: value });
		}
	});
});
