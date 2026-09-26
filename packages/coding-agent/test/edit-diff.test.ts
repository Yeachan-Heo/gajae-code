import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	adjustIndentation,
	computeEditDiff,
	computeHashlineDiff,
	DEFAULT_FUZZY_THRESHOLD,
	findMatch,
	formatLineHash,
} from "@gajae-code/coding-agent/edit";

describe("findMatch", () => {
	describe("exact matching", () => {
		test("finds exact match", async () => {
			const content = "line1\nline2\nline3";
			const target = "line2";
			const result = await findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBe(1);
			expect(result.match!.startLine).toBe(2);
		});

		test("reports multiple occurrences", async () => {
			const content = "foo\nbar\nfoo";
			const target = "foo";
			const result = await findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeUndefined();
			expect(result.occurrences).toBe(2);
		});

		test("returns empty for no match", async () => {
			const content = "line1\nline2";
			const target = "notfound";
			const result = await findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeUndefined();
			expect(result.occurrences).toBeUndefined();
		});
	});

	describe("tab/space normalization", () => {
		test("matches tabs in file with spaces in target", async () => {
			const content = "\tfoo\n\t\tbar\n\tbaz";
			const target = "  foo\n    bar\n  baz";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches spaces in file with tabs in target", async () => {
			const content = "  foo\n    bar\n  baz";
			const target = "\tfoo\n\t\tbar\n\tbaz";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches different space counts with same relative structure", async () => {
			const content = "   foo\n      bar\n   baz";
			const target = "  foo\n    bar\n  baz";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches single line with different indentation", async () => {
			const content = 'prefix\n\t\t\t"value",\nsuffix';
			const target = '          "value",';
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});
	});

	describe("fallback for inconsistent indentation", () => {
		test("matches despite one line with wrong indentation in file", async () => {
			const content = "\t\t\tline1\n\t\t\tline2\n\t\tline3\n\t\t\tline4";
			const target = "      line1\n      line2\n      line3\n      line4";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches when target has consistent indent but file varies", async () => {
			const content = "  a\n    b\n   c\n    d";
			const target = "  a\n    b\n    c\n    d";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
		});
	});

	describe("content matching", () => {
		test("collapses internal whitespace", async () => {
			const content = "foo   bar    baz";
			const target = "foo bar baz";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches with trailing whitespace differences", async () => {
			const content = "line1  \nline2\t";
			const target = "line1\nline2";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
		});
	});

	describe("threshold behavior", () => {
		test("respects custom similarity threshold", async () => {
			const content = "function foo() {}";
			const target = "function bar() {}";
			const strictResult = await findMatch(content, target, {
				allowFuzzy: true,
				threshold: 0.99,
			});
			expect(strictResult.match).toBeUndefined();

			const lenientResult = await findMatch(content, target, {
				allowFuzzy: true,
				threshold: 0.7,
			});
			expect(lenientResult.match).toBeDefined();
		});

		test("reports fuzzyMatches count when multiple above threshold", async () => {
			const content = "  item1\n  item2\n  item3";
			const target = "  itemX";
			const result = await findMatch(content, target, {
				allowFuzzy: true,
				threshold: 0.7,
			});
			expect(result.fuzzyMatches).toBeGreaterThan(1);
		});
	});

	describe("edge cases", () => {
		test("handles empty target", async () => {
			const content = "some content";
			const result = await findMatch(content, "", { allowFuzzy: true });
			expect(result).toEqual({});
		});

		test("handles empty lines in content", async () => {
			const content = "line1\n\nline3";
			const target = "line1\n\nline3";
			const result = await findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBe(1);
		});

		test("handles target longer than content", async () => {
			const content = "short";
			const target = "this is much longer than the content";
			const result = await findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeUndefined();
		});
	});
});

describe("adjustIndentation", () => {
	test("adds indentation when actualText is more indented than oldText", () => {
		const oldText = "foo\nbar";
		const actualText = "    foo\n    bar";
		const newText = "foo\nbaz\nbar";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    foo\n    baz\n    bar");
	});

	test("removes indentation when actualText is less indented", () => {
		const oldText = "        foo\n        bar";
		const actualText = "    foo\n    bar";
		const newText = "        foo\n        baz";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    foo\n    baz");
	});

	test("preserves empty lines", () => {
		const oldText = "foo\n\nbar";
		const actualText = "    foo\n\n    bar";
		const newText = "foo\n\nbaz";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    foo\n\n    baz");
	});

	test("returns unchanged when indentation matches", () => {
		const oldText = "    foo";
		const actualText = "    foo";
		const newText = "    bar";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    bar");
	});

	test("uses tab from actualText when adding indentation", () => {
		const oldText = "foo";
		const actualText = "\t\tfoo";
		const newText = "bar";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("\t\tbar");
	});

	test("handles mixed content with different indent levels", () => {
		const oldText = "if (x) {\n  return y;\n}";
		const actualText = "    if (x) {\n      return y;\n    }";
		const newText = "if (x) {\n  return z;\n}";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    if (x) {\n      return z;\n    }");
	});

	test("does not go negative on removal", () => {
		const oldText = "    foo";
		const actualText = "foo";
		const newText = "  bar";
		const result = adjustIndentation(oldText, actualText, newText);
		// Should remove up to 4 chars, but line only has 2, so remove 2
		expect(result).toBe("bar");
	});
});

describe("computeHashlineDiff", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-diff-hashline-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("returns no-op error for unchanged content when move is absent", async () => {
		const sourcePath = path.join(tempDir, "source.txt");
		const line = "unchanged content";
		await Bun.write(sourcePath, `${line}\n`);

		// `≔1<hash>` with the same line as payload is a true no-op: the edit
		// fires through computeHashlineDiff but produces identical content.
		const anchor = formatLineHash(1, line);
		const input = `§${sourcePath}\n≔${anchor}\n${line}\n`;
		const result = await computeHashlineDiff({ input }, tempDir);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("No changes would be made");
		}
	});

	test("accepts hashline input edits", async () => {
		const sourcePath = path.join(tempDir, "source.txt");
		await Bun.write(sourcePath, "first\n");

		const result = await computeHashlineDiff({ input: `§${sourcePath}\n»EOF\nsecond` }, tempDir);
		expect("diff" in result).toBe(true);
		if ("diff" in result) {
			expect(result.diff).toContain("second");
		}
	});
	test("returns a handled error when the source path is a local URL", async () => {
		const result = await computeHashlineDiff({ input: "§local://PLAN.md\n»EOF\n" }, tempDir);

		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain('internal scheme "local://"');
		}
	});
});

describe("computeEditDiff", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-diff-edit-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("returns a handled error when the source path is a local URL", async () => {
		const result = await computeEditDiff("local:/PLAN.md", "old", "new", tempDir);

		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain('internal scheme "local://"');
		}
	});
});
