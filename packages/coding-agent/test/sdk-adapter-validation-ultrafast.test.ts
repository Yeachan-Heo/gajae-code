import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { validateAdapterControl, validateAdapterSecretFields } from "../src/sdk/protocol/adapter-validation";

describe("validateAdapterSecretFields - ultrafast tier restriction", () => {
	test("rejects config.patch with serviceTier ultrafast at root", () => {
		const result = validateAdapterSecretFields("config.patch", {
			serviceTier: "ultrafast",
		});
		expect(result).toBeDefined();
		expect(result?.code).toBe("ultrafast_tier_forbidden");
		expect(result?.message).toContain("ultrafast");
	});

	test("rejects config.patch with serviceTier ultrafast nested in path", () => {
		const result = validateAdapterSecretFields("config.patch", {
			some: {
				nested: {
					serviceTier: "ultrafast",
				},
			},
		});
		expect(result).toBeDefined();
		expect(result?.code).toBe("ultrafast_tier_forbidden");
	});

	test("rejects config.patch with a dotted task.serviceTier key", () => {
		const result = validateAdapterSecretFields("config.patch", {
			patch: { "task.serviceTier": "ultrafast" },
		});
		expect(result?.code).toBe("ultrafast_tier_forbidden");
	});

	test("rejects config.patch with serviceTier ultrafast in array", () => {
		const result = validateAdapterSecretFields("config.patch", {
			items: [
				{
					serviceTier: "ultrafast",
				},
			],
		});
		expect(result).toBeDefined();
		expect(result?.code).toBe("ultrafast_tier_forbidden");
	});

	test("allows config.patch with serviceTier priority", () => {
		const result = validateAdapterSecretFields("config.patch", {
			serviceTier: "priority",
		});
		expect(result).toBeUndefined();
	});

	test("allows config.patch with serviceTier flex", () => {
		const result = validateAdapterSecretFields("config.patch", {
			serviceTier: "flex",
		});
		expect(result).toBeUndefined();
	});

	test("allows config.patch with serviceTier default", () => {
		const result = validateAdapterSecretFields("config.patch", {
			serviceTier: "default",
		});
		expect(result).toBeUndefined();
	});

	test("allows config.patch with serviceTier none", () => {
		const result = validateAdapterSecretFields("config.patch", {
			serviceTier: "none",
		});
		expect(result).toBeUndefined();
	});

	test("allows config.patch with other settings and serviceTier priority", () => {
		const result = validateAdapterSecretFields("config.patch", {
			modelProfile: { current: "default" },
			serviceTier: "priority",
			retry: { maxRetries: 3 },
		});
		expect(result).toBeUndefined();
	});

	test("rejects config.patch when ultrafast is nested with other settings", () => {
		const result = validateAdapterSecretFields("config.patch", {
			modelProfile: { current: "default" },
			fallback: {
				serviceTier: "ultrafast",
			},
		});
		expect(result).toBeDefined();
		expect(result?.code).toBe("ultrafast_tier_forbidden");
	});

	test("allows non-config.patch operations with serviceTier ultrafast", () => {
		const result = validateAdapterSecretFields("service_tier.set", {
			tier: "ultrafast",
		});
		expect(result).toBeUndefined();
	});

	test("rejects config.patch with secret field (takes priority)", () => {
		const result = validateAdapterSecretFields("config.patch", {
			apiKey: "secret",
			serviceTier: "priority",
		});
		expect(result).toBeDefined();
		expect(result?.code).toBe("secret_field_forbidden");
	});

	test("rejects config.patch with both secret and ultrafast", () => {
		const result = validateAdapterSecretFields("config.patch", {
			apiKey: "secret",
			serviceTier: "ultrafast",
		});
		expect(result).toBeDefined();
		// Secret check comes first
		expect(result?.code).toBe("secret_field_forbidden");
	});
});

describe("validateAdapterControl - service_tier.set validation", () => {
	test("rejects service_tier.set with ultrafast", () => {
		const result = validateAdapterControl("service_tier.set", {
			tier: "ultrafast",
		});
		expect(result).toBeDefined();
		expect(result?.code).toBe("invalid_input");
	});

	test("allows service_tier.set with priority", () => {
		const result = validateAdapterControl("service_tier.set", {
			tier: "priority",
		});
		expect(result).toBeUndefined();
	});

	test("allows service_tier.set with flex", () => {
		const result = validateAdapterControl("service_tier.set", {
			tier: "flex",
		});
		expect(result).toBeUndefined();
	});

	test("allows ultrafast only on the trusted local control route", () => {
		const result = validateAdapterControl("service_tier.set", { tier: "ultrafast" }, { allowUltrafastTier: true });
		expect(result).toBeUndefined();
	});
});

describe("ultrafast service tier settings", () => {
	test("global and task settings accept and advertise ultrafast", () => {
		for (const path of ["serviceTier", "task.serviceTier"] as const) {
			const setting = SETTINGS_SCHEMA[path];
			expect(setting.values).toContain("ultrafast");
			expect(setting.ui.options).toContainEqual(expect.objectContaining({ value: "ultrafast", label: "Ultrafast" }));
		}

		expect(Settings.isolated({ serviceTier: "ultrafast" }).get("serviceTier")).toBe("ultrafast");
		expect(Settings.isolated({ "task.serviceTier": "ultrafast" }).get("task.serviceTier")).toBe("ultrafast");
	});
});
