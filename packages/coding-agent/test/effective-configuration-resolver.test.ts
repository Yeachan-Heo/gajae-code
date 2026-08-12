import { describe, expect, it } from "bun:test";
import {
	EFFECTIVE_CONFIGURATION_SOURCE_RANKS,
	type EffectiveConfigurationOwnership,
	EffectiveConfigurationResolver,
	type EffectiveConfigurationSourceRecord,
	resolveEffectiveConfiguration,
} from "../src/config/effective-configuration";

const KEY = "model.default";

function source(
	sourceId: string,
	rank: EffectiveConfigurationSourceRecord["rank"],
	value: unknown,
	overrides: Partial<EffectiveConfigurationSourceRecord> = {},
): EffectiveConfigurationSourceRecord {
	return {
		sourceId,
		canonicalKey: KEY,
		presence: { presence: "present", value },
		rank,
		ownership: "owned",
		safePath: `/safe/${sourceId}.yml`,
		physicalIdentity: { kind: "known", identity: `physical:${sourceId}` },
		revision: `revision:${sourceId}`,
		digest: `digest:${sourceId}`,
		cwdDistance: 0,
		aliases: [],
		stability: { state: "stable" },
		...overrides,
	};
}

describe("EffectiveConfigurationResolver", () => {
	it("exports and honors every closed source rank", () => {
		const entries = Object.entries(EFFECTIVE_CONFIGURATION_SOURCE_RANKS) as Array<
			[keyof typeof EFFECTIVE_CONFIGURATION_SOURCE_RANKS, EffectiveConfigurationSourceRecord["rank"]]
		>;
		const records = entries.map(([name, rank]) =>
			source(name, rank, name, {
				ownership: (name === "builtin"
					? "builtin"
					: name === "profileMaterialization"
						? "profile"
						: name === "cli"
							? "cli"
							: name === "session" || name === "turn"
								? "runtime"
								: name === "managed"
									? "managed"
									: "owned") as EffectiveConfigurationOwnership,
			}),
		);
		const result = resolveEffectiveConfiguration(KEY, records);
		expect(result.state).toBe("resolved");
		if (result.state === "resolved") {
			expect(result.value).toBe("managed");
			expect(result.winner.rank).toBe(90);
		}
		expect(result.evidence.map(entry => entry.rank)).toEqual([90, 80, 70, 60, 50, 40, 35, 30, 20, 10]);
	});

	it("is deterministic under every input permutation", () => {
		const records = [
			source(
				"z-project",
				EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject,
				{ b: 2, a: 1 },
				{ safePath: "/safe/z.yml", cwdDistance: 5 },
			),
			source(
				"a-project",
				EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject,
				{ a: 1, b: 2 },
				{ safePath: "/safe/a.yml", cwdDistance: 2 },
			),
			source("user", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "user"),
		];
		const resolver = new EffectiveConfigurationResolver();
		const first = resolver.resolve(KEY, records);
		const second = resolver.resolve(KEY, [...records].reverse());
		expect(second).toEqual(first);
	});

	it("canonicalizes object keys and coalesces equal same-rank values", () => {
		const result = resolveEffectiveConfiguration(KEY, [
			source("a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject, { z: 1, a: [3, 2] }),
			source("b", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject, { a: [3, 2], z: 1 }),
		]);
		expect(result.state).toBe("resolved");
		if (result.state === "resolved") expect(result.value).toEqual({ a: [3, 2], z: 1 });
		expect(result.evidence).toHaveLength(2);
	});

	it("returns a conflict without a winner for differing highest-rank values", () => {
		const result = resolveEffectiveConfiguration(KEY, [
			source("a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "one"),
			source("b", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "two"),
			source("lower", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "lower"),
		]);
		expect(result.state).toBe("conflict");
		if (result.state === "conflict") {
			expect(result.reason).toBe("conflict");
			expect(result.candidates.map(candidate => candidate.sourceId)).toEqual(["a", "b"]);
		}
	});

	it("allows a higher present value to mask lower conflicts while retaining evidence", () => {
		const result = resolveEffectiveConfiguration(KEY, [
			source("high", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "high"),
			source("lower-a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "a"),
			source("lower-b", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "b"),
		]);
		expect(result.state).toBe("resolved");
		expect(result.maskedConflicts).toHaveLength(1);
	});

	it("does not mutate caller-owned records or values", () => {
		const value = { z: 1, a: { b: true } };
		const record = source("owned", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, value);
		const before = structuredClone(record);
		const result = new EffectiveConfigurationResolver().resolve(KEY, [record]);
		expect(record).toEqual(before);
		expect(Object.isFrozen(record)).toBe(false);
		expect(result.state).toBe("resolved");
		if (result.state === "resolved") expect(Object.isFrozen(result.value)).toBe(true);
	});
});
