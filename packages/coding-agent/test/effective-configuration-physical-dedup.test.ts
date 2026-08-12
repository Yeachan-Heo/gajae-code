import { describe, expect, it } from "bun:test";
import {
	EFFECTIVE_CONFIGURATION_SOURCE_RANKS,
	EffectiveConfigurationResolver,
	type EffectiveConfigurationSourceRecord,
} from "../src/config/effective-configuration";

const KEY = "provider.endpoint";

function source(
	sourceId: string,
	value: unknown,
	overrides: Partial<EffectiveConfigurationSourceRecord> = {},
): EffectiveConfigurationSourceRecord {
	return {
		sourceId,
		canonicalKey: KEY,
		presence: { presence: "present", value },
		rank: EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject,
		ownership: "discovered",
		safePath: `/safe/${sourceId}.yml`,
		physicalIdentity: { kind: "known", identity: `device:1/inode:shared` },
		revision: "rev",
		digest: "digest",
		cwdDistance: 0,
		aliases: [],
		stability: { state: "stable" },
		...overrides,
	};
}

describe("effective configuration physical identity", () => {
	it("collapses known physical aliases into one evidence source", () => {
		const resolver = new EffectiveConfigurationResolver();
		const result = resolver.resolve(KEY, [
			source(
				"symlink-alias",
				{ endpoint: "https://example.test" },
				{ safePath: "/safe/link.yml", aliases: ["/safe/alias.yml"] },
			),
			source(
				"native-path",
				{ endpoint: "https://example.test" },
				{ safePath: "/safe/native.yml", aliases: ["/safe/native-alias.yml"] },
			),
		]);
		expect(result.state).toBe("resolved");
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0].physicalDeduplication.collapsed).toBe(true);
		expect(result.evidence[0].physicalDeduplication.memberCount).toBe(2);
		expect(result.evidence[0].aliases).toEqual([
			"/safe/alias.yml",
			"/safe/link.yml",
			"/safe/native-alias.yml",
			"/safe/native.yml",
		]);
		const explanation = resolver.explain(result);
		expect(explanation.physicalDedup).toHaveLength(1);
		expect(explanation.physicalDedup[0].collapsed).toBe(true);
	});

	it("does not collapse unknown identities and never lets them win", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("unknown", "secret", {
				physicalIdentity: { kind: "unknown", reason: "unknown_physical_identity" },
			}),
		]);
		expect(result.state).toBe("unavailable");
		if (result.state === "unavailable") expect(result.reason).toBe("unknown_physical_identity");
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0].eligibility).toBe("ineligible");
	});

	it("permits an eligible lower source when a higher physical identity is unknown", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("unknown", "unsafe", {
				rank: EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli,
				physicalIdentity: { kind: "unknown", reason: "unknown_physical_identity" },
			}),
			source("known", "safe", {
				rank: EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser,
				physicalIdentity: { kind: "known", identity: "device:2/inode:9" },
			}),
		]);
		expect(result.state).toBe("resolved");
		if (result.state === "resolved") expect(result.value).toBe("safe");
	});

	it("excludes racing or unstable sources but retains them as evidence", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("racing", "new", {
				physicalIdentity: { kind: "known", identity: "device:3/inode:4" },
				stability: { state: "unstable", reason: "source_race" },
			}),
			source("stable", "old", {
				physicalIdentity: { kind: "known", identity: "device:3/inode:5" },
			}),
		]);
		expect(result.state).toBe("resolved");
		if (result.state === "resolved") expect(result.value).toBe("old");
		const racing = result.evidence.find(entry => entry.sourceId === "racing");
		expect(racing?.eligibility).toBe("ineligible");
		expect(racing?.ineligibilityReason).toBe("source_race");
	});

	it("derives a canonical known identity from device and inode evidence", () => {
		const result = new EffectiveConfigurationResolver().resolve(KEY, [
			source("native", "value", { physicalIdentity: { kind: "known", identity: "4:8", device: 4, inode: 8 } }),
		]);
		expect(result.state).toBe("resolved");
		expect(result.evidence[0].physicalIdentity).toEqual({ kind: "known", identity: "4:8", device: 4, inode: 8 });
	});
});
