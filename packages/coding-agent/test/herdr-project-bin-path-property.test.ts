import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { rejectProjectHerdrBinPath } from "../src/main";

const PROPERTY_SEED = 649;

describe("rejectProjectHerdrBinPath", () => {
	it("property: project herdr bin path rejection, seed 649, 64 inputs", () => {
		fc.assert(
			fc.property(
				fc.option(fc.string(), { nil: undefined }),
				fc.option(fc.string(), { nil: undefined }),
				fc.boolean(),
				(runtime, declared, dynamic) => {
					const rejected = rejectProjectHerdrBinPath(runtime, declared, dynamic);
					if (runtime === undefined) {
						expect(rejected).toBe(false);
						return;
					}
					if (dynamic) {
						expect(rejected).toBe(true);
						return;
					}
					if (declared === undefined) {
						expect(rejected).toBe(false);
						return;
					}
					expect(rejected).toBe(runtime === declared || runtime.trim() === declared);
				},
			),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});
