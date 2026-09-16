import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	hasUi,
	reconcileSettingsSchema,
	resolveSdkPromptDeadlineMs,
	resolveSdkPromptMaxRuntimeMs,
} from "@gajae-code/coding-agent/config/settings-schema";
import { PromptDeadlineManager } from "../src/sdk/prompt-deadline-manager";

const SETTING_PATH = "sdk.promptDeadlineMs";

function schemaReportFor(value: unknown) {
	return reconcileSettingsSchema({ sdk: { promptDeadlineMs: value } }).report;
}

describe("sdk.promptDeadlineMs", () => {
	it("defaults to 3,600,000 milliseconds", () => {
		expect(Settings.isolated().get(SETTING_PATH)).toBe(3_600_000);
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

/**
 * #5584 raised only the schema default; the SDK bus and host each kept their own
 * hardcoded 30-minute fallback, so a Settings lookup that missed still armed the
 * old deadline. Both now resolve through the schema constant — assert the armed
 * lease and the declared default cannot diverge again (#5583).
 */
describe("sdk prompt deadline fallbacks track the schema default", () => {
	const settings = Settings.isolated();

	it("falls back to the declared defaults when a settings read misses", () => {
		for (const missing of [undefined, null, "30m", Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(resolveSdkPromptDeadlineMs(missing)).toBe(settings.get("sdk.promptDeadlineMs"));
			expect(resolveSdkPromptMaxRuntimeMs(missing)).toBe(settings.get("sdk.promptMaxRuntimeMs"));
		}
	});

	it("passes a configured finite value through unchanged", () => {
		expect(resolveSdkPromptDeadlineMs(90_000)).toBe(90_000);
		expect(resolveSdkPromptMaxRuntimeMs(90_000)).toBe(90_000);
	});

	it("arms a lease at the schema default when the host has no settings", () => {
		const now = 1_000;
		const manager = new PromptDeadlineManager({
			reconciliation: { lookup: () => ({ status: "running" }) } as never,
			// Exactly how `createSdkSessionRuntimeExtension` builds its getters.
			getLeaseMs: () => resolveSdkPromptDeadlineMs(undefined),
			getMaxMs: () => resolveSdkPromptMaxRuntimeMs(undefined),
			now: () => now,
		});
		const correlation = { commandId: "deadline-default", turnId: "turn-default" };
		manager.onAccepted(correlation);
		expect(manager.deadlineAt(correlation)).toBe(now + (settings.get("sdk.promptDeadlineMs") as number));
		manager.clearAll();
	});
});
