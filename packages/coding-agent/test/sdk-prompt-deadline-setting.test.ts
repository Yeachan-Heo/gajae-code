import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	DEFAULT_SDK_PROMPT_DEADLINE_MS,
	DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS,
	getDefault,
	hasUi,
	reconcileSettingsSchema,
	resolveSdkPromptDeadlineMs,
	resolveSdkPromptMaxRuntimeMs,
	SETTINGS_SCHEMA,
} from "@gajae-code/coding-agent/config/settings-schema";

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

describe("sdk prompt deadline resolvers", () => {
	// A Settings lookup misses in several shapes: no settings object at all, an
	// unwritten key, or a stored value that is not a finite number.
	const MISSES = [
		undefined,
		null,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		"3600000",
		{},
		[],
		true,
	];

	it("falls back to the declared default for every non-finite lookup", () => {
		for (const miss of MISSES) {
			expect(resolveSdkPromptDeadlineMs(miss)).toBe(DEFAULT_SDK_PROMPT_DEADLINE_MS);
			expect(resolveSdkPromptMaxRuntimeMs(miss)).toBe(DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS);
		}
	});

	it("passes finite numbers through unchanged", () => {
		// Finiteness fallback only — range enforcement stays with the schema's
		// `validate:` and must not migrate into the resolvers.
		for (const value of [120_000, 0, -1, 60_000, 86_400_000]) {
			expect(resolveSdkPromptDeadlineMs(value)).toBe(value);
			expect(resolveSdkPromptMaxRuntimeMs(value)).toBe(value);
		}
	});

	it("falls back to the same value a real Settings instance hands back (#5583)", () => {
		expect(resolveSdkPromptDeadlineMs(undefined)).toBe(Settings.isolated().get("sdk.promptDeadlineMs"));
		expect(resolveSdkPromptMaxRuntimeMs(undefined)).toBe(Settings.isolated().get("sdk.promptMaxRuntimeMs"));
	});

	it("exports constants equal to the schema entries' declared defaults", () => {
		expect(DEFAULT_SDK_PROMPT_DEADLINE_MS).toBe(getDefault("sdk.promptDeadlineMs"));
		expect(DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS).toBe(getDefault("sdk.promptMaxRuntimeMs"));
		expect(SETTINGS_SCHEMA["sdk.promptDeadlineMs"].default).toBe(DEFAULT_SDK_PROMPT_DEADLINE_MS);
		expect(SETTINGS_SCHEMA["sdk.promptMaxRuntimeMs"].default).toBe(DEFAULT_SDK_PROMPT_MAX_RUNTIME_MS);
	});
});
