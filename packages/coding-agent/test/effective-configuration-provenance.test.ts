import { describe, expect, it } from "bun:test";
import {
	EFFECTIVE_CONFIGURATION_SOURCE_RANKS,
	EffectiveConfigurationResolver,
	type EffectiveConfigurationSourceRecord,
} from "../src/config/effective-configuration";

const KEY = "credentials.mode";

function source(
	sourceId: string,
	value: unknown,
	overrides: Partial<EffectiveConfigurationSourceRecord> = {},
): EffectiveConfigurationSourceRecord {
	return {
		sourceId,
		canonicalKey: KEY,
		presence: { presence: "present", value },
		rank: EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser,
		ownership: "owned",
		safePath: `/safe/${sourceId}.yml`,
		physicalIdentity: { kind: "known", identity: `physical:${sourceId}` },
		revision: "revision-safe",
		digest: "digest-safe",
		cwdDistance: 0,
		aliases: [],
		stability: { state: "stable" },
		...overrides,
	};
}

describe("effective configuration provenance and safe explanation", () => {
	it("explains ordering, eligibility, aliases, winner, and clear-to-lower without values", () => {
		const resolver = new EffectiveConfigurationResolver();
		const result = resolver.resolve(KEY, [
			source("clear", undefined, {
				rank: EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli,
				presence: { presence: "absent" },
			}),
			source("inherited", "do-not-leak", {
				aliases: ["/safe/inherited-alias.yml"],
			}),
		]);
		const explanation = resolver.explain(result);
		expect(explanation.ordering.map(entry => entry.order)).toEqual([1, 2]);
		expect(explanation.ordering.map(entry => entry.sourceId)).toEqual(["clear", "inherited"]);
		expect(explanation.eligibility.every(entry => entry.eligible)).toBe(true);
		expect(explanation.winner?.sourceId).toBe("inherited");
		expect(explanation.clearToLower.occurred).toBe(true);
		const serialized = JSON.stringify(explanation);
		expect(serialized).not.toContain("do-not-leak");
		expect(serialized).toContain("/safe/inherited-alias.yml");
	});

	it("never echoes an unsafe path field or an error object", () => {
		const unsafePathField = { safePath: undefined, path: "/private/raw-secret-path" };
		const record = source("safe", "secret-value", unsafePathField);

		const result = new EffectiveConfigurationResolver().resolve(KEY, [record]);
		const explanation = new EffectiveConfigurationResolver().explain(result);
		const serialized = JSON.stringify(explanation);
		expect(serialized).not.toContain("raw-secret-path");
		expect(serialized).not.toContain("secret-value");
	});

	it("turns unsupported and cyclic present values into unavailable evidence", () => {
		const unsupported = source("function", () => "not-json");
		const cyclicValue: Record<string, unknown> = {};
		cyclicValue.self = cyclicValue;
		const cyclic = source("cycle", cyclicValue);
		const unsupportedResult = new EffectiveConfigurationResolver().resolve(KEY, [unsupported]);
		const cyclicResult = new EffectiveConfigurationResolver().resolve(KEY, [cyclic]);
		expect(unsupportedResult.state).toBe("unavailable");
		expect(cyclicResult.state).toBe("unavailable");
		if (unsupportedResult.state === "unavailable") expect(unsupportedResult.reason).toBe("unsupported_value");
		if (cyclicResult.state === "unavailable") expect(cyclicResult.reason).toBe("cyclic_value");
		expect(unsupportedResult.evidence[0].presence).toBe("unavailable");
		expect(cyclicResult.evidence[0].presence).toBe("unavailable");
	});

	it("keeps every explain reason as a stable snake_case code", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("unknown", "value", {
				physicalIdentity: { kind: "unknown", reason: "unavailable-source" as never },
			}),
		]);
		const explanation = new EffectiveConfigurationResolver().explain(result);
		const reasons = [explanation.reason, ...explanation.eligibility.map(entry => entry.reason)].filter(
			reason => reason !== undefined,
		);
		expect(reasons.every(reason => /^[a-z0-9_]+$/.test(reason))).toBe(true);
	});
});
