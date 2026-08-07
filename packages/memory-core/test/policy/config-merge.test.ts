import { describe, expect, it } from "bun:test";
import type { MemoryResult } from "../../src/errors";

import {
	DEFAULT_MEMORY_POLICY_CONFIG,
	MEMORY_POLICY_CONFIG_VERSION,
	mergeMemoryPolicyConfigs,
	validateMemoryPolicyConfig,
} from "../../src/policy/config-merge";

const VERSION = { version: MEMORY_POLICY_CONFIG_VERSION } as const;

function expectPolicyDenied(result: MemoryResult<unknown>): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.code).toBe("policy-denied");
}

function expectInvalid(result: MemoryResult<unknown>): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.code).toBe("invalid-input");
}

describe("memory policy config merge", () => {
	it("defines a frozen, strict v1 baseline for every policy family", () => {
		expect(DEFAULT_MEMORY_POLICY_CONFIG).toEqual({
			version: 1,
			retrieval: { maxMaps: 4, maxFiles: 20, maxSections: 8, maxChars: 24_000 },
			ledger: { enabled: true, includeContent: false },
			write: {
				enabled: true,
				requireApproval: true,
				allowedDestinations: [
					"global-canonical",
					"project-canonical",
					"session",
					"proposal",
					"checkpoint",
					"ledger",
					"redact-output",
					"export-output",
					"explain-output",
					"doctor-report",
				],
			},
			security: { pathContainment: true, secretScan: true },
			privacy: { maxSensitivity: "restricted" },
		});
		expect(Object.isFrozen(DEFAULT_MEMORY_POLICY_CONFIG)).toBe(true);
		expect(Object.isFrozen(DEFAULT_MEMORY_POLICY_CONFIG.retrieval)).toBe(true);
		expect(Object.isFrozen(DEFAULT_MEMORY_POLICY_CONFIG.write.allowedDestinations)).toBe(true);
	});

	it("accepts an omitted layer and returns the immutable baseline", () => {
		expect(mergeMemoryPolicyConfigs(undefined)).toEqual({ ok: true, value: DEFAULT_MEMORY_POLICY_CONFIG });
		expect(mergeMemoryPolicyConfigs(undefined, undefined, undefined)).toEqual({
			ok: true,
			value: DEFAULT_MEMORY_POLICY_CONFIG,
		});
	});

	it("merges global, project, and session layers in order, with narrowing winning", () => {
		const global = {
			...VERSION,
			retrieval: { maxMaps: 3, maxFiles: 15, maxSections: 7, maxChars: 20_000 },
			write: {
				requireApproval: true,
				allowedDestinations: ["global-canonical", "project-canonical", "session", "proposal"],
			},
		};
		const project = {
			retrieval: { maxFiles: 10, maxChars: 12_000 },
			ledger: { enabled: false },
			privacy: { maxSensitivity: "private" },
		};
		const session = {
			retrieval: { maxMaps: 1, maxSections: 2 },
			write: { allowedDestinations: ["session", "proposal"] },
		};

		const merged = mergeMemoryPolicyConfigs(global, project, session);
		expect(merged).toEqual({
			ok: true,
			value: {
				version: 1,
				retrieval: { maxMaps: 1, maxFiles: 10, maxSections: 2, maxChars: 12_000 },
				ledger: { enabled: false, includeContent: false },
				write: {
					enabled: true,
					requireApproval: true,
					allowedDestinations: ["session", "proposal"],
				},
				security: { pathContainment: true, secretScan: true },
				privacy: { maxSensitivity: "private" },
			},
		});
	});

	it("accepts every supported narrowing direction", () => {
		const merged = mergeMemoryPolicyConfigs(
			{
				retrieval: { maxMaps: 3, maxFiles: 15, maxSections: 7, maxChars: 20_000 },
				ledger: { enabled: false, includeContent: false },
				write: {
					enabled: false,
					requireApproval: true,
					allowedDestinations: ["project-canonical", "session", "proposal"],
				},
				privacy: { maxSensitivity: "private" },
			},
			{
				retrieval: { maxMaps: 2, maxFiles: 10, maxSections: 4, maxChars: 10_000 },
				ledger: { enabled: false, includeContent: false },
				write: {
					enabled: false,
					requireApproval: true,
					allowedDestinations: ["session", "proposal"],
				},
				privacy: { maxSensitivity: "public-safe" },
			},
			{
				retrieval: { maxMaps: 1, maxFiles: 5, maxSections: 2, maxChars: 5_000 },
				ledger: { enabled: false, includeContent: false },
				write: { enabled: false, requireApproval: true, allowedDestinations: ["session"] },
				privacy: { maxSensitivity: "public-safe" },
			},
		);

		expect(merged).toEqual({
			ok: true,
			value: {
				version: 1,
				retrieval: { maxMaps: 1, maxFiles: 5, maxSections: 2, maxChars: 5_000 },
				ledger: { enabled: false, includeContent: false },
				write: { enabled: false, requireApproval: true, allowedDestinations: ["session"] },
				security: { pathContainment: true, secretScan: true },
				privacy: { maxSensitivity: "public-safe" },
			},
		});
	});

	it("validates partial layers without filling missing keys before merge", () => {
		const validated = validateMemoryPolicyConfig({ retrieval: { maxFiles: 9 } });
		expect(validated).toEqual({ ok: true, value: { retrieval: { maxFiles: 9 } } });

		const merged = mergeMemoryPolicyConfigs({ retrieval: { maxFiles: 9 } }, { retrieval: { maxSections: 3 } });
		expect(merged).toEqual({
			ok: true,
			value: {
				...DEFAULT_MEMORY_POLICY_CONFIG,
				retrieval: { maxMaps: 4, maxFiles: 9, maxSections: 3, maxChars: 24_000 },
			},
		});
	});

	it("rejects every broadening operation as a typed policy denial", () => {
		const cases: readonly [unknown, unknown][] = [
			[{ retrieval: { maxMaps: 3 } }, { retrieval: { maxMaps: 4 } }],
			[{ retrieval: { maxFiles: 4 } }, { retrieval: { maxFiles: 5 } }],
			[{ retrieval: { maxSections: 3 } }, { retrieval: { maxSections: 4 } }],
			[{ retrieval: { maxChars: 4_000 } }, { retrieval: { maxChars: 5_000 } }],
			[{ ledger: { includeContent: false } }, { ledger: { includeContent: true } }],
			[{ ledger: { enabled: false } }, { ledger: { enabled: true } }],
			[{ write: { enabled: false } }, { write: { enabled: true } }],
			[{ write: { requireApproval: true } }, { write: { requireApproval: false } }],
			[
				{ write: { allowedDestinations: ["global-canonical"] } },
				{ write: { allowedDestinations: ["global-canonical", "session"] } },
			],
			[{ privacy: { maxSensitivity: "private" } }, { privacy: { maxSensitivity: "restricted" } }],
			[{ privacy: { maxSensitivity: "public-safe" } }, { privacy: { maxSensitivity: "private" } }],
		];

		for (const [global, project] of cases) {
			const result = mergeMemoryPolicyConfigs(global, project);
			expectPolicyDenied(result);
			if (!result.ok && result.error.code === "policy-denied") {
				expect(result.error.reason).toContain("cannot broaden");
			}
		}
	});

	it("rejects disabled containment and disabled secret scanning", () => {
		for (const layer of [{ security: { pathContainment: false } }, { security: { secretScan: false } }]) {
			expectPolicyDenied(mergeMemoryPolicyConfigs(layer));
			expectPolicyDenied(validateMemoryPolicyConfig(layer));
		}
	});

	it("rejects every legacy override field as a policy denial", () => {
		for (const key of ["override", "allowSensitive", "allowSecrets", "force"] as const) {
			expectPolicyDenied(validateMemoryPolicyConfig({ [key]: true }));
			expectPolicyDenied(validateMemoryPolicyConfig({ write: { [key]: true } }));
		}
	});

	it("accepts explicit security invariants only when enabled", () => {
		expect(mergeMemoryPolicyConfigs({ security: { pathContainment: true, secretScan: true } })).toEqual({
			ok: true,
			value: DEFAULT_MEMORY_POLICY_CONFIG,
		});
	});

	it("rejects unknown keys and wrong structural types at every level", () => {
		const invalidValues: readonly unknown[] = [
			{ ...VERSION, unknown: true },
			{ retrieval: { unknown: 1 } },
			{ ledger: { unknown: true } },
			{ write: { unknown: true } },
			{ security: { unknown: true } },
			{ privacy: { unknown: true } },
			{ retrieval: [] },
			{ ledger: "enabled" },
			{ write: { allowedDestinations: "session" } },
			{ privacy: { maxSensitivity: "secret" } },
			{ version: 2 },
			{ version: "1" },
			[],
			"config",
			null,
		];

		for (const value of invalidValues) {
			expectInvalid(validateMemoryPolicyConfig(value));
			expectInvalid(mergeMemoryPolicyConfigs(value));
		}
	});

	it("rejects non-finite and negative retrieval limits, including nested values", () => {
		expectInvalid(validateMemoryPolicyConfig({ retrieval: { maxFiles: 0 } }));
		expectInvalid(validateMemoryPolicyConfig({ retrieval: { maxFiles: 1.5 } }));
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.01]) {
			expectInvalid(validateMemoryPolicyConfig({ retrieval: { maxFiles: value } }));
		}
		for (const key of ["maxMaps", "maxFiles", "maxSections", "maxChars"] as const) {
			expectInvalid(validateMemoryPolicyConfig({ retrieval: { [key]: -1 } }));
		}
	});

	it("rejects prototype-polluting and inherited configuration objects", () => {
		const polluted = JSON.parse('{"version":1,"__proto__":{"polluted":true}}') as unknown;
		expectInvalid(validateMemoryPolicyConfig(polluted));

		const inherited = Object.create({ retrieval: { maxFiles: 1 } }) as { retrieval: unknown };
		expectInvalid(validateMemoryPolicyConfig(inherited));

		const nullPrototype = Object.create(null) as { version: number };
		nullPrototype.version = 1;
		expectInvalid(validateMemoryPolicyConfig(nullPrototype));

		const pollutedArray = ["session"] as string[];
		Object.setPrototypeOf(pollutedArray, { polluted: true });
		expectInvalid(validateMemoryPolicyConfig({ write: { allowedDestinations: pollutedArray } }));

		const symbol = Symbol("config");
		expectInvalid(validateMemoryPolicyConfig({ [symbol]: true }));
		expectInvalid(validateMemoryPolicyConfig({ retrieval: { maxFiles: 1, [symbol]: true } }));

		const throwing = {};
		Object.defineProperty(throwing, "retrieval", {
			enumerable: true,
			get(): never {
				throw new Error("malformed getter");
			},
		});
		expectInvalid(validateMemoryPolicyConfig(throwing));
	});

	it("produces a deterministic canonical result independent of input key order", () => {
		const first = mergeMemoryPolicyConfigs(
			{
				write: { allowedDestinations: ["proposal", "session", "project-canonical"] },
				retrieval: { maxFiles: 9, maxMaps: 3 },
				privacy: { maxSensitivity: "private" },
			},
			{ write: { allowedDestinations: ["proposal", "session"] }, retrieval: { maxMaps: 2 } },
		);
		const second = mergeMemoryPolicyConfigs(
			{
				privacy: { maxSensitivity: "private" },
				retrieval: { maxMaps: 3, maxFiles: 9 },
				write: { allowedDestinations: ["project-canonical", "session", "proposal"] },
			},
			{ retrieval: { maxMaps: 2 }, write: { allowedDestinations: ["session", "proposal"] } },
		);

		expect(first).toEqual(second);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("does not mutate input layers and returns frozen merged values", () => {
		const layer = {
			retrieval: { maxFiles: 5 },
			write: { allowedDestinations: ["session"] as const },
		};
		const before = JSON.stringify(layer);
		const result = mergeMemoryPolicyConfigs(layer);
		expect(JSON.stringify(layer)).toBe(before);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.retrieval)).toBe(true);
		expect(Object.isFrozen(result.value.write.allowedDestinations)).toBe(true);
	});
});
