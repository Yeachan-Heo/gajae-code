import { describe, expect, it } from "bun:test";
import {
	EFFECTIVE_CONFIGURATION_SOURCE_RANKS,
	EffectiveConfigurationResolver,
	type EffectiveConfigurationSourceRecord,
} from "../src/config/effective-configuration";

const KEY = "theme.name";

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
		ownership: "discovered",
		safePath: `/safe/${sourceId}.yml`,
		physicalIdentity: { kind: "known", identity: `physical:${sourceId}` },
		cwdDistance: 10,
		aliases: [],
		stability: { state: "stable" },
		...overrides,
	};
}

describe("effective configuration source ordering", () => {
	it("orders rank before identity, source, path, and cwd distance", () => {
		const resolver = new EffectiveConfigurationResolver();
		const result = resolver.resolve(KEY, [
			source("far", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject, "same", {
				safePath: "/safe/z.yml",
				cwdDistance: 20,
			}),
			source("near", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject, "same", {
				safePath: "/safe/z.yml",
				cwdDistance: 1,
			}),
			source("lower", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "lower"),
		]);
		expect(result.state).toBe("resolved");
		expect(result.provenance.map(entry => entry.sourceId)).toEqual(["far", "near", "lower"]);
	});

	it("uses the source id after equal identity and path and distance", () => {
		const resolver = new EffectiveConfigurationResolver();
		const records = [
			source("z-source", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "same", {
				physicalIdentity: { kind: "known", identity: "same-identity" },
				safePath: "/safe/shared.yml",
				cwdDistance: 2,
			}),
			source("a-source", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "same", {
				physicalIdentity: { kind: "known", identity: "same-identity" },
				safePath: "/safe/shared.yml",
				cwdDistance: 2,
			}),
		];
		const first = resolver.resolve(KEY, records);
		const second = resolver.resolve(KEY, [...records].reverse());
		expect(first).toEqual(second);
		expect(first.provenance[0].sourceId).toBe("a-source");
	});

	it("lets an absent high source reveal a lower value", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("clear", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, undefined, {
				presence: { presence: "absent" },
			}),
			source("lower", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "inherited"),
		]);
		expect(result.state).toBe("resolved");
		if (result.state === "resolved") {
			expect(result.value).toBe("inherited");
			expect(result.reason).toBe("clear_to_lower");
		}
		const explanation = new EffectiveConfigurationResolver().explain(result);
		expect(explanation.clearToLower.occurred).toBe(true);
		expect(explanation.clearToLower.higherAbsentSourceIds).toEqual(["clear"]);
	});

	it("reveals a lower conflict after a high clear", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("clear", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, undefined, {
				presence: { presence: "absent" },
			}),
			source("lower-a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "a"),
			source("lower-b", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "b"),
		]);
		expect(result.state).toBe("conflict");
		if (result.state === "conflict") expect(result.reason).toBe("revealed_conflict");
		const explanation = new EffectiveConfigurationResolver().explain(result);
		expect(explanation.clearToLower.revealedState).toBe("conflict");
	});

	it("returns absent when every eligible source is a clear", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("owned", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, undefined, {
				presence: { presence: "absent" },
			}),
			source("builtin", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.builtin, undefined, {
				presence: { presence: "absent" },
			}),
		]);
		expect(result.state).toBe("absent");
		if (result.state === "absent") expect(result.reason).toBe("absent");
	});
});
