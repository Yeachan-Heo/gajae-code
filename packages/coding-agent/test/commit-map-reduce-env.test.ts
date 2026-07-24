import { afterEach, describe, expect, it } from "bun:test";
import { shouldUseMapReduce } from "../src/commit/map-reduce";

const KEYS = ["GJC_COMMIT_MAP_REDUCE", "PI_COMMIT_MAP_REDUCE"] as const;
const original = new Map(KEYS.map(key => [key, Bun.env[key]] as const));
const clear = (): void => {
	for (const key of KEYS) delete Bun.env[key];
};
afterEach(() => {
	for (const [key, value] of original) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

// `minFiles: 0` makes an empty diff (0 files) satisfy `fileCount >= minFiles`, so
// shouldUseMapReduce would return true absent any env override — isolating the
// GJC_COMMIT_MAP_REDUCE / PI_COMMIT_MAP_REDUCE gate.
const forceEligible = { minFiles: 0 };

describe("shouldUseMapReduce env gating", () => {
	it("is enabled when no override is set", () => {
		clear();
		expect(shouldUseMapReduce("", forceEligible)).toBe(true);
	});

	it("honors the documented GJC_COMMIT_MAP_REDUCE=false", () => {
		clear();
		Bun.env.GJC_COMMIT_MAP_REDUCE = "false";
		expect(shouldUseMapReduce("", forceEligible)).toBe(false);
	});

	it("falls back to legacy PI_COMMIT_MAP_REDUCE=false", () => {
		clear();
		Bun.env.PI_COMMIT_MAP_REDUCE = "false";
		expect(shouldUseMapReduce("", forceEligible)).toBe(false);
	});

	it("resolves GJC-first: GJC=true is not overridden by PI=false", () => {
		clear();
		Bun.env.GJC_COMMIT_MAP_REDUCE = "true";
		Bun.env.PI_COMMIT_MAP_REDUCE = "false";
		expect(shouldUseMapReduce("", forceEligible)).toBe(true);
	});
});
