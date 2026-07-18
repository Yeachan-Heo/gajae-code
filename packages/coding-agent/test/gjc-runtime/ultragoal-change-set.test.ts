import { describe, expect, it } from "bun:test";
import { parseGitNameStatus } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-change-set";

describe("ultragoal change-set extraction", () => {
	it("preserves rename paths and categories", () => {
		expect(parseGitNameStatus("R100\told.ts\tpackages/coding-agent/src/tools/computer.ts\n")).toEqual([
			{
				path: "packages/coding-agent/src/tools/computer.ts",
				oldPath: "old.ts",
				status: "renamed",
				category: "tool",
			},
		]);
	});
});
