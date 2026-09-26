import { describe, expect, test } from "bun:test";
import * as Diff from "diff";
import { diffLines } from "../../native/index.js";
import { diffLinesDifferential } from "./cases/diff-lines";
import { verifyDifferential } from "./harness";

describe("native diffLines differential self-test", () => {
	test("native diffLines matches jsdiff for committed CRLF/BOM/Unicode and edit cases", async () => {
		const report = await verifyDifferential(diffLinesDifferential, `${import.meta.dir}/golden/diff-lines.jsonl`);
		expect(report).toEqual({
			total: diffLinesDifferential.cases.length,
			identical: diffLinesDifferential.cases.length,
			accepted: [],
			unlisted: [],
			stale: [],
		});
		expect(diffLines("left\n", "right\n")).toEqual(
			Diff.diffLines("left\n", "right\n").map(part => ({
				added: part.added ?? false,
				count: part.count ?? 0,
				removed: part.removed ?? false,
				value: part.value,
			})),
		);
	});
});
