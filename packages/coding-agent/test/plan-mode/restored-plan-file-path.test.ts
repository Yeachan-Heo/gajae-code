import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { DEFAULT_PLAN_FILE_PATH, restoredPlanFilePath } from "@gajae-code/coding-agent/plan-mode/state";
import * as fc from "fast-check";

const segment = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._ -]{0,15}$/).filter(s => s !== "." && s !== "..");

describe("restoredPlanFilePath", () => {
	it("keeps a relative path under the session local root", () => {
		fc.assert(
			fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), fc.boolean(), (segments, doubleSlash) => {
				const value = `local:${doubleSlash ? "//" : "/"}${segments.join("/")}`;
				expect(restoredPlanFilePath(value)).toBe(value);
			}),
			{ seed: 7101, numRuns: 128 },
		);
	});

	it("falls back to the default plan file for any path that can leave the local root", () => {
		const escaping = fc.oneof(
			fc.array(segment, { maxLength: 3 }).map(s => path.join(path.sep, ...s, "plan.md")),
			fc.array(segment, { maxLength: 3 }).map(s => ["..", ...s, "plan.md"].join("/")),
			fc
				.tuple(
					fc.array(segment, { maxLength: 2 }),
					fc.constantFrom("..", ".", ""),
					fc.array(segment, { maxLength: 2 }),
				)
				.map(([a, bad, b]) => `local://${[...a, bad, ...b, "plan.md"].join("/")}`),
			fc.array(segment, { maxLength: 2 }).map(s => `local:///${[...s, "plan.md"].join("/")}`),
			fc.constantFrom("%2e%2e", "..\\x", "a?b", "a#b").map(s => `local://${s}/plan.md`),
		);
		fc.assert(
			fc.property(escaping, value => {
				expect(restoredPlanFilePath(value)).toBe(DEFAULT_PLAN_FILE_PATH);
			}),
			{ seed: 7101, numRuns: 128 },
		);
	});

	it("falls back to the default plan file for a non-string value", () => {
		for (const value of [undefined, null, 1, {}, []])
			expect(restoredPlanFilePath(value)).toBe(DEFAULT_PLAN_FILE_PATH);
	});
});
