import { describe, expect, test } from "bun:test";
import { suggestClosestSkillName } from "../../src/tools/skill";

describe("suggestClosestSkillName", () => {
	test("suggests ultragoal for common typos", () => {
		expect(suggestClosestSkillName("ultragoals", ["deep-interview", "ralplan", "ultragoal", "team"])).toBe(
			"ultragoal",
		);
		expect(suggestClosestSkillName("ral-plan", ["deep-interview", "ralplan", "ultragoal", "team"])).toBe("ralplan");
	});

	test("returns undefined when nothing is close enough", () => {
		expect(suggestClosestSkillName("zzzz", ["deep-interview", "ralplan"])).toBeUndefined();
	});
});
