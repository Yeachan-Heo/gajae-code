import { describe, expect, it } from "bun:test";
import {
	getDefault,
	getEnumValues,
	reconcileSettingsSchema,
	SETTINGS_SCHEMA,
	type SettingValue,
} from "../src/config/settings-schema";

describe("sessionMemory settings", () => {
	it("defines the mode enum with off/shadow/enabled and defaults to shadow", () => {
		const definition = SETTINGS_SCHEMA["sessionMemory.mode"];
		expect(definition.type).toBe("enum");
		expect(getEnumValues("sessionMemory.mode")).toEqual(["off", "shadow", "enabled"]);
		expect(getDefault("sessionMemory.mode")).toBe("shadow");
	});

	it("defaults context overflow recovery to on (preserves the current safe posture)", () => {
		const definition = SETTINGS_SCHEMA["sessionMemory.contextOverflowRecovery"];
		expect(definition.type).toBe("boolean");
		expect(getDefault("sessionMemory.contextOverflowRecovery")).toBe(true);
	});

	it("exposes typed defaults through the schema helpers", () => {
		const mode: SettingValue<"sessionMemory.mode"> = "shadow";
		const recovery: SettingValue<"sessionMemory.contextOverflowRecovery"> = true;
		expect(getDefault("sessionMemory.mode")).toBe(mode);
		expect(getDefault("sessionMemory.contextOverflowRecovery")).toBe(recovery);
	});

	it.each(["off", "shadow", "enabled"] as const)("accepts mode %s and an explicit recovery off", mode => {
		const reconciled = reconcileSettingsSchema({
			sessionMemory: { mode, contextOverflowRecovery: false },
		});

		expect(reconciled.report.valid).toBe(true);
		expect(reconciled.settings.sessionMemory).toEqual({ mode, contextOverflowRecovery: false });
	});

	it("rejects out-of-enum modes (canary/default-on are release-channel states, not values)", () => {
		const reconciled = reconcileSettingsSchema({ sessionMemory: { mode: "canary" } });

		expect(reconciled.report.valid).toBe(false);
		expect(reconciled.report.issues).toContainEqual({
			path: "sessionMemory.mode",
			kind: "invalid",
			detail: "Expected enum.",
		});
	});

	it("rejects non-boolean context overflow recovery values", () => {
		const reconciled = reconcileSettingsSchema({ sessionMemory: { contextOverflowRecovery: "yes" } });

		expect(reconciled.report.valid).toBe(false);
		expect(reconciled.report.issues).toContainEqual({
			path: "sessionMemory.contextOverflowRecovery",
			kind: "invalid",
			detail: "Expected boolean.",
		});
	});

	it("leaves defaults stable under an empty config (no schema-side materialization)", () => {
		const reconciled = reconcileSettingsSchema({});

		expect(reconciled.report.valid).toBe(true);
		expect(reconciled.settings).toEqual({});
	});
});
