import { describe, expect, it } from "bun:test";
import {
	EFFECTIVE_CONFIGURATION_SOURCE_RANKS,
	type EffectiveConfigurationSourceRecord,
	resolveEffectiveConfiguration,
} from "../src/config/effective-configuration";
import {
	createEffectiveConfigurationExplainView,
	renderEffectiveConfigurationExplainLines,
} from "../src/config/effective-configuration-view";

const KEY = "model.default";

type Rank = EffectiveConfigurationSourceRecord["rank"];

function source(
	sourceId: string,
	rank: Rank,
	value: unknown,
	overrides: Partial<EffectiveConfigurationSourceRecord> = {},
): EffectiveConfigurationSourceRecord {
	return {
		sourceId,
		canonicalKey: KEY,
		presence: { presence: "present", value },
		rank,
		ownership: "owned",
		safePath: `/Users/example/repo/.gjc/${sourceId}.yml`,
		physicalIdentity: { kind: "known", identity: `physical:${sourceId}` },
		revision: `revision:${sourceId}`,
		digest: `digest:${sourceId}`,
		aliases: [`alias:${sourceId}`],
		stability: { state: "stable" },
		...overrides,
	};
}

describe("effective configuration explain consumer", () => {
	it("keeps a highest-rank conflict without inventing a winner", () => {
		const result = resolveEffectiveConfiguration(KEY, [
			source("cli-a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "one", { safePath: "/tmp/a.yml" }),
			source("cli-b", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "two", { safePath: "/tmp/b.yml" }),
			source("user", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "lower"),
		]);
		const view = createEffectiveConfigurationExplainView(result);

		expect(view.state).toBe("conflict");
		expect(view.hasWinner).toBe(false);
		expect(view.winner).toBeUndefined();
		expect(view.sources.map(source => source.rank)).toEqual([60, 60, 30]);
		expect(view.sources.map(source => source.sourceId)).toEqual(["cli-a", "cli-b", "user"]);
		expect(view.recovery.code).toBe("resolve_conflict");
		expect(view.lines.join("\n")).toContain("Winner: none (conflict)");
	});

	it("records equal-value evidence, masked lower conflicts, and clear ordering", () => {
		const result = resolveEffectiveConfiguration(KEY, [
			source("high-clear", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli, "ignored", {
				presence: { presence: "absent" },
			}),
			source("equal-a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, { enabled: true }),
			source("equal-b", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, { enabled: true }),
			source("masked-a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.builtin, "a"),
			source("masked-b", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.builtin, "b"),
		]);
		const view = createEffectiveConfigurationExplainView(result);

		expect(view.state).toBe("resolved");
		expect(view.clearToLower).toBe(true);
		expect(view.clearedSourceIds).toEqual(["high-clear"]);
		expect(view.equalValueEvidence.sourceIds).toEqual(["equal-a", "equal-b"]);
		expect(view.equalValueEvidence.rank).toBe(EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser);
		expect(view.sources.find(source => source.sourceId === "equal-a")?.equalValue).toBe(true);
		expect(view.sources.find(source => source.sourceId === "equal-b")?.equalValue).toBe(true);
		expect(view.sources.find(source => source.sourceId === "high-clear")?.cleared).toBe(true);
	});

	it("surfaces unstable and unknown ineligibility with deterministic recovery", () => {
		const unstable = createEffectiveConfigurationExplainView(
			resolveEffectiveConfiguration(KEY, [
				source("racy", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "value", {
					stability: { state: "unstable", reason: "source_race" },
				}),
			]),
		);
		const unknown = createEffectiveConfigurationExplainView(
			resolveEffectiveConfiguration(KEY, [
				source("unknown", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "value", {
					physicalIdentity: { kind: "unknown", reason: "unknown_physical_identity" },
				}),
			]),
		);

		expect(unstable.state).toBe("unavailable");
		expect(unstable.sources[0]?.ineligibilityReason).toBe("source_race");
		expect(unstable.recovery.code).toBe("wait_for_stable_source");
		expect(unknown.state).toBe("unavailable");
		expect(unknown.sources[0]?.ineligibilityReason).toBe("unknown_physical_identity");
		expect(unknown.recovery.code).toBe("identify_source");
	});

	it("is immutable and stable under source permutation", () => {
		const records = [
			source("z", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject, { b: 2, a: "漢字" }, { cwdDistance: 5 }),
			source("a", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject, { a: "漢字", b: 2 }, { cwdDistance: 2 }),
			source("user", EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser, "user"),
		];
		const first = createEffectiveConfigurationExplainView(resolveEffectiveConfiguration(KEY, records));
		const second = createEffectiveConfigurationExplainView(
			resolveEffectiveConfiguration(KEY, [...records].reverse()),
		);

		expect(second).toEqual(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.sources)).toBe(true);
		expect(first.sources.map(source => source.sourceId)).toEqual(["a", "z", "user"]);
		expect(
			renderEffectiveConfigurationExplainLines(first, 36).every(line => !/[\u0000-\u001f\u007f]/u.test(line)),
		).toBe(true);
	});
});
