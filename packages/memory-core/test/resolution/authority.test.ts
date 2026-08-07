import { describe, expect, test } from "bun:test";

import type { MemoryCitation, MemoryClaim } from "../../src/index";
import { compareAuthority, compareClaims, compareFreshness, compareSpecificity } from "../../src/resolution/authority";
import {
	compareVolatility,
	toVolatileClaim,
	volatilityPenalty,
	volatilityScore,
} from "../../src/resolution/volatility";

const AS_OF = "2026-07-29T00:00:00.000Z";

function citation(uri: string, scope: MemoryCitation["scope"] = "global"): MemoryCitation {
	return {
		uri,
		scope,
		relPath: "global/note.md",
		heading: "Rule",
		startLine: 1,
		endLine: 2,
		authority: "user-confirmed",
		volatility: "stable",
		updatedAt: AS_OF,
		digest: "digest",
	};
}

function claim(
	uri: string,
	overrides: Partial<MemoryClaim> = {},
	scope: MemoryCitation["scope"] = "global",
): MemoryClaim {
	return {
		claimKey: "constraint.rule",
		text: "The rule applies.",
		type: "constraint",
		authority: "user-confirmed",
		freshness: AS_OF,
		volatility: "stable",
		source: citation(uri, scope),
		...overrides,
	};
}

describe("authority ordering", () => {
	test("orders every declared authority tier", () => {
		const tiers = [
			"user-confirmed",
			"repository-reviewed",
			"project-config",
			"tool-verified",
			"session-observed",
			"model-inferred",
			"unverified",
		] as const;
		for (let index = 0; index < tiers.length - 1; index += 1) {
			expect(compareAuthority(tiers[index]!, tiers[index + 1]!)).toBe(1);
			expect(compareAuthority(tiers[index + 1]!, tiers[index]!)).toBe(-1);
		}
		expect(compareAuthority("project-config", "project-config")).toBe(0);
	});

	test("orders scope specificity from session to global", () => {
		expect(compareSpecificity("session", "project")).toBe(1);
		expect(compareSpecificity("project", "global")).toBe(1);
		expect(compareSpecificity("global", "session")).toBe(-1);
	});

	test("orders newer strict UTC freshness first and rejects malformed timestamps", () => {
		const newer = compareFreshness("2026-07-29T00:00:01Z", "2026-07-29T00:00:00Z", AS_OF);
		expect(newer).toEqual({ ok: true, value: 1 });
		const older = compareFreshness("2026-07-29T00:00:00Z", "2026-07-29T00:00:01Z", AS_OF);
		expect(older).toEqual({ ok: true, value: -1 });
		for (const timestamp of ["2026-07-29", "2026-07-29T00:00:00+00:00", "2026-02-30T00:00:00Z"]) {
			const result = compareFreshness(timestamp, AS_OF, AS_OF);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("invalid-input");
		}
		const invalidAsOf = compareFreshness(AS_OF, AS_OF, "2026-07-29T00:00:00+00:00");
		expect(invalidAsOf.ok).toBe(false);
	});

	test("applies authority before scope and freshness", () => {
		const globalConfirmed = claim("global://global.md", {
			authority: "user-confirmed",
			freshness: "2026-01-01T00:00:00Z",
		});
		const sessionInferred = claim(
			"session://session.md",
			{ authority: "model-inferred", freshness: "2026-07-29T00:00:00Z" },
			"session",
		);
		const result = compareClaims(globalConfirmed, sessionInferred, { asOf: AS_OF });
		expect(result).toEqual({ ok: true, value: 1 });
	});

	test("uses canonical UTF-8 URI bytes for deterministic ties", () => {
		const a = claim("global://a.md");
		const z = claim("global://z.md");
		const left = compareClaims(a, z, { asOf: AS_OF });
		const right = compareClaims(z, a, { asOf: AS_OF });
		expect(left).toEqual({ ok: true, value: 1 });
		expect(right).toEqual({ ok: true, value: -1 });
		expect(compareClaims(a, claim("global://a.md"), { asOf: AS_OF })).toEqual({ ok: true, value: 0 });
	});
	test("ranks volatility before the URI tie-break", () => {
		const stable = claim("global://z.md", { volatility: "stable" });
		const volatile = claim("global://a.md", { volatility: "volatile" });
		expect(compareClaims(stable, volatile, { asOf: AS_OF })).toEqual({ ok: true, value: 1 });
		expect(compareClaims(volatile, stable, { asOf: AS_OF })).toEqual({ ok: true, value: -1 });
	});
});

describe("volatility downranking", () => {
	test("orders stable above historical above volatile without promotion", () => {
		expect(compareVolatility("stable", "historical")).toBe(1);
		expect(compareVolatility("historical", "volatile")).toBe(1);
		expect(volatilityScore("stable")).toBeGreaterThan(volatilityScore("historical"));
		expect(volatilityScore("historical")).toBeGreaterThan(volatilityScore("volatile"));
		expect(volatilityPenalty("stable")).toBe(0);
		expect(volatilityPenalty("volatile")).toBeGreaterThan(volatilityPenalty("historical"));

		const volatileConfirmed = claim("global://confirmed.md", { authority: "user-confirmed", volatility: "volatile" });
		const stableInferred = claim(
			"session://inferred.md",
			{ authority: "model-inferred", volatility: "stable" },
			"session",
		);
		expect(compareClaims(volatileConfirmed, stableInferred, { asOf: AS_OF })).toEqual({ ok: true, value: 1 });
	});

	test("derives verification metadata for volatile claims", () => {
		const result = toVolatileClaim(claim("global://volatile.md", { volatility: "volatile" }), {
			provider: "test",
			resource: "fixture",
			id: "one",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				claim: "The rule applies.",
				verificationRequired: true,
				verificationHint: { provider: "test", resource: "fixture", id: "one" },
			},
		});
	});
});
