import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import {
	applyHashlineEdits,
	buildCompactHashlineDiffPreview,
	computeLineHash,
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	FileReadCache,
	generateDiffString,
	getFileReadCache,
	HashlineMismatchError,
	HL_BODY_SEP,
	HL_BODY_SEP_RE_RAW,
	hashlineEditParamsSchema,
	parseHashline,
	parseHashlineWithWarnings,
	splitHashlineInput,
	splitHashlineInputs,
	tryRecoverHashlineWithCache,
} from "@gajae-code/coding-agent/edit";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

const pl = (text: string): string => text;
const outputSep = HL_BODY_SEP;
const outputSepRe = HL_BODY_SEP_RE_RAW;

function tag(line: number, content: string): string {
	return `${line}${computeLineHash(line, content)}`;
}

function sameLineRange(anchor: string): string {
	return `${anchor}..${anchor}`;
}

function mistag(line: number, content: string): string {
	const hash = computeLineHash(line, content);
	return `${line}${hash === "zz" ? "yy" : "zz"}`;
}

function applyDiff(content: string, diff: string): string {
	return applyHashlineEdits(content, parseHashline(diff)).lines;
}

function applyDiffWithPureInsertAutoDrop(content: string, diff: string): string {
	return applyHashlineEdits(content, parseHashline(diff), { autoDropPureInsertDuplicates: true }).lines;
}
function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-edit-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function makeHashlineSession(tempDir: string, settings = Settings.isolated()): ToolSession {
	return { cwd: tempDir, settings } as ToolSession;
}

function hashlineExecuteOptions(
	tempDir: string,
	input: string,
	settings = Settings.isolated(),
	session: ToolSession = makeHashlineSession(tempDir, settings),
): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

describe("hashline parser — block op syntax", () => {
	const content = "aaa\nbbb\nccc";

	it("inserts payload before/after a Lid, and at BOF/EOF", () => {
		const diff = [
			`«${tag(2, "bbb")}`,
			pl("before b"),
			`»${tag(2, "bbb")}`,
			pl("after b"),
			"»BOF",
			pl("top"),
			"»EOF",
			pl("tail"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");
	});

	it("inserts after the final line via `»ANCHOR` instead of falling off the file", () => {
		const diff = [`»${tag(3, "ccc")}`, pl("tail")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\ntail");
	});

	it("deletes one line or an inclusive range when `≔A..B` has no payload", () => {
		expect(applyDiff(content, `≔${sameLineRange(tag(2, "bbb"))}`)).toBe("aaa\nccc");
		expect(applyDiff(content, `≔${tag(2, "bbb")}..${tag(3, "ccc")}`)).toBe("aaa");
	});

	it("blanks a line in place with an explicit empty payload line", () => {
		const diff = `≔${sameLineRange(tag(2, "bbb"))}\n\n`;
		expect(applyDiff(content, diff)).toBe("aaa\n\nccc");
	});

	it("replaces one line or an inclusive range with payload lines", () => {
		const single = [`≔${tag(2, "bbb")}`, pl("BBB")].join("\n");
		expect(applyDiff(content, single)).toBe("aaa\nBBB\nccc");

		const range = [`≔${tag(2, "bbb")}..${tag(3, "ccc")}`, pl("BBB"), pl("CCC")].join("\n");
		expect(applyDiff(content, range)).toBe("aaa\nBBB\nCCC");
	});

	it("treats single-anchor replace sugar as equivalent to an explicit one-line range", () => {
		const anchor = tag(2, "bbb");
		expect(parseHashline(`≔${anchor}\nBBB`)).toEqual(parseHashline(`≔${anchor}..${anchor}\nBBB`));
		expect(applyDiff(content, `≔${anchor}\nBBB`)).toBe(applyDiff(content, `≔${anchor}..${anchor}\nBBB`));
	});

	it("auto-absorbs duplicated multiline prefix boundaries during replacement", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`≔${sameLineRange(tag(3, "old();"))}`, pl("// one"), pl("// two"), pl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["// one", "// two", "new();"].join("\n"));
	});

	it("auto-absorbs duplicated multiline suffix boundaries during replacement", () => {
		const source = ["old();", "// one", "// two"].join("\n");
		const diff = [`≔${sameLineRange(tag(1, "old();"))}`, pl("new();"), pl("// one"), pl("// two")].join("\n");

		expect(applyDiff(source, diff)).toBe(["new();", "// one", "// two"].join("\n"));
	});

	it("auto-absorbs a duplicated single structural suffix during replacement", () => {
		const source = ["old();", "};"].join("\n");
		const diff = [`≔${sameLineRange(tag(1, "old();"))}`, pl("new();"), pl("};")].join("\n");

		expect(applyDiff(source, diff)).toBe(["new();", "};"].join("\n"));
	});

	it("auto-absorbs a duplicated single structural prefix during replacement", () => {
		const source = ["};", "old();"].join("\n");
		const diff = [`≔${sameLineRange(tag(2, "old();"))}`, pl("};"), pl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["};", "new();"].join("\n"));
	});

	it("does not absorb a single structural replacement suffix when it preserves balance", () => {
		// The replacement payload `if ok {` + `}` is itself net-zero, so the trailing
		// `}` is a legitimate part of the new block, not a duplicate of the file's
		// existing `}`. The single-line structural absorb must NOT fire here.
		const source = ["old();", "}"].join("\n");
		const diff = [`≔${sameLineRange(tag(1, "old();"))}`, pl("if ok {"), pl("}")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if ok {", "}", "}"].join("\n"));
	});

	it("does not auto-absorb a single duplicated boundary line", () => {
		const source = ["keep", "old();"].join("\n");
		const diff = [`≔${sameLineRange(tag(2, "old();"))}`, pl("keep"), pl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["keep", "keep", "new();"].join("\n"));
	});

	it("does not auto-absorb a duplicate boundary that another op already targets", () => {
		// Lines 3-4 ("X","Y") match the payload's trailing block, but line 4
		// is also the anchor of a separate insert. Absorbing it would silently
		// steal that anchor and turn the insert into a replacement.
		const source = ["A", "B", "X", "Y", "Z"].join("\n");
		const diff = [
			`≔${tag(1, "A")}..${tag(2, "B")}`,
			pl("alpha"),
			pl("X"),
			pl("Y"),
			`«${tag(4, "Y")}`,
			pl("extra"),
		].join("\n");

		expect(applyDiff(source, diff)).toBe(["alpha", "X", "Y", "X", "extra", "Y", "Z"].join("\n"));
	});

	it("surfaces a warning when boundary duplicates are auto-absorbed", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`≔${sameLineRange(tag(3, "old();"))}`, pl("// one"), pl("// two"), pl("new();")].join("\n");

		const result = applyHashlineEdits(source, parseHashline(diff));
		expect(result.lines).toBe(["// one", "// two", "new();"].join("\n"));
		expect(result.warnings).toBeDefined();
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-absorbed 2 duplicate line\(s\) above replacement/)]),
		);
	});

	it("does not auto-drop generic (multi-line) pure-insert duplicate boundaries by default", () => {
		// Multi-line context echo (`aaa`, `bbb`) is gated on the
		// `autoDropPureInsertDuplicates` opt-in, unlike the single-line
		// structural absorb covered by the test below.
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`»${tag(2, "bbb")}`, pl("aaa"), pl("bbb"), pl("NEW")].join("\n");
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\naaa\nbbb\nNEW\nccc");
	});

	it("auto-drops a duplicated single structural suffix for pure insert by default", () => {
		const source = ["if ok {", "   keep();", "   }"].join("\n");
		const diff = [`«${tag(3, "   }")}`, pl("   added();"), pl("   }")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if ok {", "   keep();", "   added();", "   }"].join("\n"));
	});

	it("auto-drops a duplicated single structural prefix for pure insert by default", () => {
		const source = ["   });", "next();"].join("\n");
		const diff = [`»${tag(1, "   });")}`, pl("   });"), pl("added();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["   });", "added();", "next();"].join("\n"));
	});

	it("preserves an intentional non-structural anchor duplicate for `»ANCHOR` by default", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`»${tag(2, "bbb")}`, pl("bbb"), pl("NEW")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nbbb\nNEW\nccc");
	});

	it("preserves an intentional non-structural anchor duplicate for `«ANCHOR` by default", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`«${tag(2, "bbb")}`, pl("NEW"), pl("bbb")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nNEW\nbbb\nbbb\nccc");
	});

	it("does not drop a single structural pure-insert suffix when it preserves balance", () => {
		const source = ["if outer {", "}"].join("\n");
		const diff = [`«${tag(2, "}")}`, pl("if inner {"), pl("}")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if outer {", "if inner {", "}", "}"].join("\n"));
	});

	it("auto-absorbs duplicated leading payload of a pure `»ANCHOR` insert", () => {
		// Payload echoes the two file lines AT/ABOVE the insertion point
		// (aaa, bbb), then adds NEW. The leading echo is absorbed.
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`»${tag(2, "bbb")}`, pl("aaa"), pl("bbb"), pl("NEW")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc");
	});

	it("auto-absorbs context-wrap echo (leading-above + trailing-below) on `»ANCHOR`", () => {
		// Payload wraps NEW with context above (aaa, bbb) AND below (ccc, ddd).
		// Both ends should be absorbed, leaving only NEW inserted after bbb.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`»${tag(2, "bbb")}`, pl("aaa"), pl("bbb"), pl("NEW"), pl("ccc"), pl("ddd")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated trailing payload of a pure `«ANCHOR` insert", () => {
		// Insert before line 3 ("ccc"). Trailing payload echoes the anchor and the
		// line after it. Drop the trailing duplicates.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`«${tag(3, "ccc")}`, pl("NEW"), pl("ccc"), pl("ddd")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated leading payload at EOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `»EOF` payload echoes the last two file lines, then adds NEW.
		const diff = ["»EOF", pl("bbb"), pl("ccc"), pl("NEW")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nccc\nNEW");
	});

	it("auto-absorbs duplicated trailing payload at BOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `«BOF` payload prepends NEW but trails with the first two file lines.
		const diff = ["«BOF", pl("NEW"), pl("aaa"), pl("bbb")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("NEW\naaa\nbbb\nccc");
	});

	it("auto-drops a single duplicated anchor line in a pure insert when generic duplicate absorption is enabled", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`»${tag(2, "bbb")}`, pl("bbb"), pl("NEW")].join("\n");

		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc");
	});

	it("surfaces a warning when pure-insert duplicates are auto-dropped", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`»${tag(2, "bbb")}`, pl("aaa"), pl("bbb"), pl("NEW")].join("\n");
		const result = applyHashlineEdits(source, parseHashline(diff), { autoDropPureInsertDuplicates: true });
		expect(result.lines).toBe("aaa\nbbb\nNEW\nccc");
		expect(result.warnings).toBeDefined();
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-dropped 2 duplicate line\(s\) at the start of insert/)]),
		);
	});

	it("preserves payload text exactly", () => {
		const diff = [
			`≔${sameLineRange(tag(2, "bbb"))}`,
			pl(""),
			pl("# not a header"),
			pl("+ not an op"),
			pl("  spaced"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n\n# not a header\n+ not an op\n  spaced\nccc");
	});

	it("treats blank lines inside a payload run as empty payload lines", () => {
		// Truly blank lines inside an active payload run are verbatim empty
		// payload lines as long as more payload follows.
		const diff = [`≔${sameLineRange(tag(2, "bbb"))}`, pl("first"), "", "", pl("after")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nfirst\n\n\nafter\nccc");
	});

	it("treats blank lines before the next op as payload", () => {
		const diff = [
			`≔${sameLineRange(tag(1, "aaa"))}`,
			pl("AAA"),
			"",
			"",
			`≔${sameLineRange(tag(3, "ccc"))}`,
			pl("CCC"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("AAA\n\n\nbbb\nCCC");
	});

	it("rejects missing payloads and orphan payload lines", () => {
		expect(() => parseHashline(`»${tag(1, "aaa")}`)).toThrow(/require at least one/);
		expect(() => parseHashline(pl("orphan"))).toThrow(/payload line has no preceding/);
	});

	it("leniently treats a bare blank line after « / » as an empty payload", () => {
		const hash = computeLineHash(5, "aaa");
		const anchor = { line: 5, hash };
		expect(parseHashline(`«${tag(5, "aaa")}\n\n`)).toEqual([
			{ kind: "insert", cursor: { kind: "before_anchor", anchor }, text: "", lineNum: 1, index: 0 },
		]);
		expect(parseHashline(`»${tag(5, "aaa")}\n\n`)).toEqual([
			{ kind: "insert", cursor: { kind: "after_anchor", anchor }, text: "", lineNum: 1, index: 0 },
		]);
	});

	it("rejects old cursor and equals-inline syntax after cutover", () => {
		expect(() => parseHashline(`@${tag(1, "aaa")}\n+old`)).toThrow(/unrecognized op/);
		expect(() => parseHashline(`${tag(1, "aaa")}=AAA`)).toThrow(/payload line has no preceding/);
	});

	it("rejects the retired delete op", () => {
		expect(() => parseHashline(`≔-${sameLineRange(tag(2, "bbb"))}`)).toThrow(/unrecognized op/);
	});

	it("describes current sigils for unknown op syntax", () => {
		expect(() => parseHashline(`-${sameLineRange(tag(2, "bbb"))}`)).toThrow(/Use «ANCHOR.*»ANCHOR.*≔A\.\.B/);
	});

	it("leniently tolerates a trailing `|TEXT` body on anchors copied verbatim from read output", () => {
		const anchor = tag(2, "bbb");
		// Bare trailing `|`, full `|TEXT` body, and both sides of a range.
		expect(applyDiff(content, [`≔${anchor}|`, pl("BBB")].join("\n"))).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, [`≔${anchor}|bbb`, pl("BBB")].join("\n"))).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, [`«${anchor}|bbb`, pl("X")].join("\n"))).toBe("aaa\nX\nbbb\nccc");
		expect(applyDiff(content, [`»${anchor}|bbb`, pl("X")].join("\n"))).toBe("aaa\nbbb\nX\nccc");
		expect(applyDiff(content, `≔${anchor}|bbb..${tag(3, "ccc")}|ccc`)).toBe("aaa");
	});

	it("leniently strips `*`/`>` line-marker decoration from anchors", () => {
		const anchor = tag(2, "bbb");
		expect(applyDiff(content, [`≔*${anchor}`, pl("BBB")].join("\n"))).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, [`«>${anchor}`, pl("X")].join("\n"))).toBe("aaa\nX\nbbb\nccc");
	});

	it("treats a non-matching `|TEXT` body on »/« as an inline payload line (single-line insert)", () => {
		// content is "aaa\nbbb\nccc"; "NEW" does not match line 2 ("bbb"), so the
		// body becomes the only payload line — no following payload required.
		const anchor = tag(2, "bbb");
		expect(applyDiff(content, `»${anchor}|NEW`)).toBe("aaa\nbbb\nNEW\nccc");
		expect(applyDiff(content, `«${anchor}|NEW`)).toBe("aaa\nNEW\nbbb\nccc");
	});

	it("accepts inline `|TEXT` payload containing whitespace on »/«", () => {
		// Regression: the prior regex required `\S+` after the op sigil, so an
		// inline payload like `»2bx|\tconst foo = bar` failed with "unrecognized
		// op" the moment the body contained any whitespace.
		const anchor = tag(2, "bbb");
		const payload = "\tconst streamKeepaliveMs = opts.streamKeepaliveMs;";
		expect(applyDiff(content, `»${anchor}|${payload}`)).toBe(`aaa\nbbb\n${payload}\nccc`);
		expect(applyDiff(content, `«${anchor}|${payload}`)).toBe(`aaa\n${payload}\nbbb\nccc`);
	});

	it("prepends a non-matching inline `|TEXT` body before subsequent payload lines", () => {
		const anchor = tag(2, "bbb");
		const diff = [`»${anchor}|first inline`, pl("second from next line")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nfirst inline\nsecond from next line\nccc");
	});

	it("discards an inline `|TEXT` body that matches the anchored line content", () => {
		// When `|TEXT` reproduces line 2 verbatim it's just visual decoration —
		// require a real payload from the following lines.
		const anchor = tag(2, "bbb");
		const diff = [`»${anchor}|bbb`, pl("X"), pl("Y")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nX\nY\nccc");
		// Matching body with no follow-up payload is still an error.
		expect(() => parseHashline(`»${anchor}|bbb`)).toThrow(/require at least one/);
	});

	it("treats `|TEXT` after BOF/EOF as a payload line (no anchor hash to compare)", () => {
		expect(applyDiff(content, `»BOF|HEAD`)).toBe("HEAD\naaa\nbbb\nccc");
		expect(applyDiff(content, `»EOF|TAIL`)).toBe("aaa\nbbb\nccc\nTAIL");
	});
});

describe("hashline — stale anchors", () => {
	it("throws HashlineMismatchError when a Lid hash no longer matches", () => {
		const diff = [`≔${sameLineRange(mistag(2, "bbb"))}`, pl("BBB")].join("\n");
		expect(() => applyDiff("aaa\nbbb\nccc", diff)).toThrow(HashlineMismatchError);
	});

	it("rejects when an anchor's stored line shifted (no auto-rebase)", () => {
		const stale = tag(2, "bbb");
		const diff = [`≔${sameLineRange(stale)}`, pl("BBB")].join("\n");
		expect(() => applyDiff("aaa\nINSERTED\nbbb\nccc", diff)).toThrow(HashlineMismatchError);
	});

	it("rejects when the line hash matches a different nearby line", () => {
		// Significant-content lines hash by content alone; identical content gives
		// identical hashes, so an anchor pointing at a different line with the
		// same hash must not be silently relocated.
		const file = ["x = 1", "y = 2", "x = 1", "z = 3", "x = 1", "w = 4"].join("\n");
		const collidingHash = computeLineHash(1, "x = 1");
		// User points at line 4 (`z = 3`) with the colliding hash; without auto-
		// rebase, this is a plain mismatch.
		const diff = [`≔${sameLineRange(`4${collidingHash}`)}`, pl("REPLACED")].join("\n");
		expect(() => applyDiff(file, diff)).toThrow(HashlineMismatchError);
	});
});

describe("splitHashlineInput — § headers", () => {
	it("extracts path and diff body from §path header", () => {
		const input = [`§src/foo.ts`, `≔${sameLineRange(tag(2, "bbb"))}`, pl("BBB")].join("\n");
		expect(splitHashlineInput(input)).toEqual({
			path: "src/foo.ts",
			diff: `≔${sameLineRange(tag(2, "bbb"))}\n${pl("BBB")}`,
		});
	});

	it("strips leading blank lines and unquotes matching path quotes", () => {
		expect(splitHashlineInput(`\n§"foo bar.ts"\n»BOF\n${pl("x")}`)).toEqual({
			path: "foo bar.ts",
			diff: `»BOF\n${pl("x")}`,
		});
	});

	it("normalizes cwd-prefixed absolute paths to cwd-relative paths", () => {
		const cwd = process.cwd();
		const absolute = path.join(cwd, "src", "foo.ts");
		expect(splitHashlineInput(`§${absolute}\n»BOF\n${pl("x")}`, { cwd }).path).toBe("src/foo.ts");
	});

	it("uses explicit fallback path only when input has recognizable operations", () => {
		expect(splitHashlineInput(`»BOF\n${pl("x")}`, { path: "a.ts" })).toEqual({
			path: "a.ts",
			diff: `»BOF\n${pl("x")}`,
		});
		expect(() => splitHashlineInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
	});

	it("splits multiple edit sections", () => {
		const input = ["§a.ts", "»BOF", pl("a"), "§b.ts", "»EOF", pl("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `»BOF\n${pl("a")}` },
			{ path: "b.ts", diff: `»EOF\n${pl("b")}` },
		]);
	});

	it("tolerates extra § chars on the section header", () => {
		const input = ["§§a.ts", "»BOF", pl("a"), "§§§b.ts", "»EOF", pl("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `»BOF\n${pl("a")}` },
			{ path: "b.ts", diff: `»EOF\n${pl("b")}` },
		]);
	});

	it("silently drops a duplicate header with no operations between them", () => {
		const input = ["§§src/foo.ts", "§§src/foo.ts", `»BOF`, pl("x")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([{ path: "src/foo.ts", diff: `»BOF\n${pl("x")}` }]);
	});

	it("silently drops a trailing header with no operations", () => {
		const input = ["§§a.ts", "»BOF", pl("a"), "§§b.ts"].join("\n");
		expect(splitHashlineInputs(input)).toEqual([{ path: "a.ts", diff: `»BOF\n${pl("a")}` }]);
	});
});

describe("hashline executor", () => {
	it("creates a missing file with a file-scoped insert", async () => {
		await withTempDir(async tempDir => {
			const input = `§new.ts\n»BOF\n${pl("export const x = 1;")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("new.ts:");
			expect(await Bun.file(path.join(tempDir, "new.ts")).text()).toBe("export const x = 1;");
		});
	});

	it("honors the pure-insert duplicate auto-drop setting", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = ["aaa", "bbb", "ccc"].join("\n");
			const input = `§a.ts\n»${tag(2, "bbb")}\n${pl("aaa")}\n${pl("bbb")}\n${pl("NEW")}\n`;

			await Bun.write(filePath, source);
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));
			expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\naaa\nbbb\nNEW\nccc");

			await Bun.write(filePath, source);
			const enabled = Settings.isolated({ "edit.hashlineAutoDropPureInsertDuplicates": true });
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, enabled));
			expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\nNEW\nccc");
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Auto-dropped");
		});
	});

	it("preflights every section before writing multi-file edits", async () => {
		await withTempDir(async tempDir => {
			const aPath = path.join(tempDir, "a.ts");
			const bPath = path.join(tempDir, "b.ts");
			await Bun.write(aPath, "aaa\n");
			await Bun.write(bPath, "bbb\n");
			const input = [
				"§a.ts",
				`≔${sameLineRange(tag(1, "aaa"))}`,
				pl("AAA"),
				"§b.ts",
				`≔${sameLineRange(mistag(1, "bbb"))}`,
				pl("BBB"),
			].join("\n");

			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(
				/anchor(s)? do(es)? not match the current file/,
			);
			expect(await Bun.file(aPath).text()).toBe("aaa\n");
			expect(await Bun.file(bPath).text()).toBe("bbb\n");
		});
	});

	it("applies multiple sections targeting the same file against the original snapshot", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const original = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"].join("\n");
			await Bun.write(filePath, `${original}\n`);

			// Two sections, both anchored against the ORIGINAL file. Section 1 expands
			// line 2 into 9 lines (net +8 shift). Section 2's anchor points at line 8
			// of the original; after section 1 applies, that content moves to line 16.
			// A naive sequential apply reads the modified disk and fails anchor
			// validation outright.
			const input = [
				"§a.ts",
				`≔${sameLineRange(tag(2, "L2"))}`,
				pl("L2a"),
				pl("L2b"),
				pl("L2c"),
				pl("L2d"),
				pl("L2e"),
				pl("L2f"),
				pl("L2g"),
				pl("L2h"),
				pl("L2i"),
				"§a.ts",
				`»${tag(8, "L8")}`,
				pl("INSERTED"),
			].join("\n");

			await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));

			expect(await Bun.file(filePath).text()).toBe(
				[
					"L1",
					"L2a",
					"L2b",
					"L2c",
					"L2d",
					"L2e",
					"L2f",
					"L2g",
					"L2h",
					"L2i",
					"L3",
					"L4",
					"L5",
					"L6",
					"L7",
					"L8",
					"INSERTED",
					"L9",
					"L10",
					"",
				].join("\n"),
			);
		});
	});
});

describe("hashlineEditParamsSchema — extra-field tolerance", () => {
	it("accepts extra `path` field alongside `input`", () => {
		expect(hashlineEditParamsSchema.safeParse({ path: "x.ts", input: `§x.ts\n»BOF\n${pl("x")}` }).success).toBe(true);
	});

	it("still requires `input`", () => {
		expect(hashlineEditParamsSchema.safeParse({ path: "x.ts" }).success).toBe(false);
	});
});

describe("buildCompactHashlineDiffPreview — anchors track post-edit line numbers", () => {
	it("emits hashes against the new file's line numbers for context after a range expansion", () => {
		const before = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].join("\n");
		const after = ["a1", "a2", "a3", "X", "Y", "Z", "a5", "a6", "a7"].join("\n");
		const { diff } = generateDiffString(before, after);
		const preview = buildCompactHashlineDiffPreview(diff);

		// Walk the preview and verify every ` LINE+HASH${outputSep}content` line matches what
		// the file now has at that line number.
		const newFileLines = after.split("\n");
		for (const line of preview.preview.split("\n")) {
			if (!line.startsWith(" ")) continue;
			// Skip context-elision markers ("...") which carry no real file content.
			if (line.endsWith(`${outputSep}...`)) continue;
			const match = new RegExp(`^\\s(\\d+)([a-z]{2})${outputSepRe}(.*)$`).exec(line);
			expect(match).not.toBeNull();
			if (!match) continue;
			const lineNum = Number(match[1]);
			const hash = match[2];
			const content = match[3];
			expect(newFileLines[lineNum - 1]).toBe(content);
			expect(computeLineHash(lineNum, content)).toBe(hash);
		}
	});

	it("emits + lines with hashes against new line numbers and - lines with the placeholder", () => {
		const before = "alpha\nbeta\ngamma\n";
		const after = "alpha\nDELTA\nEPSILON\ngamma\n";
		const { diff } = generateDiffString(before, after);
		const preview = buildCompactHashlineDiffPreview(diff);

		const additions = preview.preview.split("\n").filter(line => line.startsWith("+"));
		expect(additions).toEqual([
			`+2${computeLineHash(2, "DELTA")}${outputSep}DELTA`,
			`+3${computeLineHash(3, "EPSILON")}${outputSep}EPSILON`,
		]);

		const removals = preview.preview.split("\n").filter(line => line.startsWith("-"));
		expect(removals).toEqual([`-2--${outputSep}beta`]);
	});
});

describe("hashline — anchor-stale recovery via read snapshot cache", () => {
	it("recovers when the file was modified out-of-band after a read", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
			await Bun.write(filePath, `${v0Lines.join("\n")}\n`);

			const session = makeHashlineSession(tempDir);
			// Simulate the read tool having shown V0 to the model in this session.
			getFileReadCache(session).recordContiguous(filePath, 1, v0Lines);

			// External actor (linter, subagent, user) prepends 7 lines. Anchors
			// authored against V0 no longer match V1, so the model's edit cannot
			// land without consulting the cached snapshot.
			const headerLines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7"];
			const v1Lines = [...headerLines, ...v0Lines];
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			// Model authors anchor against V0 — line 2 is "L2" in V0.
			const input = `§a.ts\n≔${sameLineRange(tag(2, "L2"))}\n${pl("L2-MODEL")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));

			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			// The external prepend AND the model's edit must both be present.
			expect(finalLines.slice(0, 7)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
			expect(finalLines).toContain("L2-MODEL");
			expect(finalLines).not.toContain("L2");
			// Other unchanged lines preserved.
			expect(finalLines).toContain("L7");
			expect(finalLines).toContain("L8");

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Recovered from stale anchors using a previous read snapshot/);
		});
	});

	it("falls back to mismatch error when the cache does not cover the failing anchor", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = Array.from({ length: 10 }, (_, idx) => `L${idx + 1}`);
			await Bun.write(filePath, `${v0Lines.join("\n")}\n`);

			const session = makeHashlineSession(tempDir);
			// Cache only covers the first three lines — but the edit targets line 6.
			getFileReadCache(session).recordContiguous(filePath, 1, v0Lines.slice(0, 3));

			const v1Lines = [...v0Lines];
			v1Lines[5] = "L6-CHANGED";
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			const input = `§a.ts\n≔${sameLineRange(tag(6, "L6"))}\n${pl("L6-MODEL")}\n`;
			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session)),
			).rejects.toThrow(HashlineMismatchError);
			// Disk content unchanged.
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
		});
	});

	it("returns null from tryRecoverHashlineWithCache when applyPatch cannot land", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__hashline-recovery-applypatch__.ts";
		cache.recordContiguous(fakePath, 1, ["alpha", "beta", "gamma", "delta", "epsilon"]);

		// Live file is completely different — patch context cannot match even
		// with fuzz tolerance.
		const currentText = "totally\nunrelated\ncontent\nhere\nnow\n";
		const edits = parseHashline(`≔${sameLineRange(tag(2, "beta"))}\n${pl("BETA-MODEL")}`);

		const recovered = tryRecoverHashlineWithCache({
			cache,
			absolutePath: fakePath,
			currentText,
			edits,
			options: {},
		});
		expect(recovered).toBeNull();
	});

	it("isolates caches across sessions", () => {
		const a = new FileReadCache();
		const b = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-isolation__.ts";
		a.recordContiguous(fakePath, 1, ["x", "y", "z"]);
		expect(a.get(fakePath)).not.toBeNull();
		expect(b.get(fakePath)).toBeNull();
	});

	it("captures the post-edit result so the next edit can recover from anchors against it", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["alpha", "beta", "gamma", "delta", "epsilon"];
			await Bun.write(filePath, `${v0Lines.join("\n")}\n`);

			const session = makeHashlineSession(tempDir);
			// Initial read populates the cache with V0.
			getFileReadCache(session).recordContiguous(filePath, 1, v0Lines);

			// First edit: change line 2 → BETA. After the write, the cache should
			// reflect V1 (post-edit), not V0.
			const firstInput = `§a.ts\n≔${sameLineRange(tag(2, "beta"))}\n${pl("BETA")}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));
			const v1Lines = ["alpha", "BETA", "gamma", "delta", "epsilon"];
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
			const snap = getFileReadCache(session).get(filePath);
			expect(snap?.lines.get(1)).toBe("alpha");
			expect(snap?.lines.get(2)).toBe("BETA");
			expect(snap?.lines.get(3)).toBe("gamma");

			// External actor prepends 7 lines after the edit. Anchors authored
			// against V1 (the post-edit state the model just observed) no longer
			// match V2 — recovery must consult the cached V1 snapshot to land the
			// second edit.
			const v2Lines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", ...v1Lines];
			await Bun.write(filePath, `${v2Lines.join("\n")}\n`);

			const secondInput = `§a.ts\n≔${sameLineRange(tag(3, "gamma"))}\n${pl("GAMMA")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, secondInput, undefined, session));

			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			expect(finalLines.slice(0, 7)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
			expect(finalLines).toContain("BETA");
			expect(finalLines).toContain("GAMMA");
			expect(finalLines).not.toContain("gamma");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Recovered from stale anchors using a previous read snapshot/);
		});
	});

	it("drops a cached entry when newly recorded lines disagree on overlap", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-conflict__.ts";
		cache.recordContiguous(fakePath, 1, ["a", "b", "c", "d", "e"]);
		cache.recordSparse(fakePath, [
			[3, "c"],
			[4, "D-CHANGED"],
			[5, "e"],
			[6, "f"],
			[7, "g"],
		]);

		const snap = cache.get(fakePath);
		expect(snap).not.toBeNull();
		// Old entries dropped; only the divergent record's entries remain.
		expect(snap?.lines.has(1)).toBe(false);
		expect(snap?.lines.has(2)).toBe(false);
		expect(snap?.lines.get(4)).toBe("D-CHANGED");
		expect(snap?.lines.get(7)).toBe("g");
	});

	it("evicts old paths past the per-session LRU cap", () => {
		const cache = new FileReadCache();
		// Cap is 30 paths. Insert 32 distinct paths; the oldest two must evict.
		for (let i = 0; i < 32; i++) {
			cache.recordContiguous(`/tmp/file-${i}.ts`, 1, ["x"]);
		}
		expect(cache.get("/tmp/file-0.ts")).toBeNull();
		expect(cache.get("/tmp/file-1.ts")).toBeNull();
		expect(cache.get("/tmp/file-2.ts")).not.toBeNull();
		expect(cache.get("/tmp/file-31.ts")).not.toBeNull();
	});

	it("does not generate anchors from column-truncated read lines", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "long-line.txt");
			const longLine = "abcdefghij";
			await Bun.write(filePath, `${longLine}\nsecond\n`);

			const settings = Settings.isolated({ "tools.outputMaxColumns": 5 });
			const session = makeHashlineSession(tempDir, settings);
			const readTool = new ReadTool(session);
			const readResult = await readTool.execute("read-long-line", { path: `${filePath}:1+1` });
			const readText = toolText(readResult);

			expect(readText).toContain(`1${computeLineHash(1, longLine)}${outputSep}${longLine}`);
			expect(readText).not.toContain("abcde…");

			const anchor = `${1}${computeLineHash(1, longLine)}`;
			await executeHashlineSingle(
				hashlineExecuteOptions(tempDir, `§long-line.txt\n≔${sameLineRange(anchor)}\nshort\n`, settings, session),
			);

			expect(await Bun.file(filePath).text()).toBe("short\nsecond\n");
		});
	});
});

describe("hashline *** Abort recovery sentinel (harmony-leak mitigation)", () => {
	const sentinel = "*** Abort";

	it("parser breaks at *** Abort and surfaces a warning", () => {
		const diff = [`»${tag(1, "alpha")}`, pl("HELLO"), sentinel, `»${tag(99, "junk")}`, pl("never")].join("\n");
		const { edits, warnings } = parseHashlineWithWarnings(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ kind: "insert", text: "HELLO" });
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toMatch(/truncated mid-call/i);
	});

	it("appended sentinel from harmony-leak truncation: ops above are preserved", () => {
		// Mirrors the exact shape harmony-leak emits inside a single section.
		const diff = `»${tag(1, "alpha")}\n${pl("KEPT")}\n*** Abort\n`;
		const { edits, warnings } = parseHashlineWithWarnings(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ text: "KEPT" });
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("splitter respects *** Abort like *** End Patch", () => {
		const input = [
			`§a.ts`,
			`»${tag(1, "alpha")}`,
			pl("a-payload"),
			sentinel,
			`§b.ts`,
			`»${tag(1, "beta")}`,
			pl("never-emitted"),
		].join("\n");
		const sections = splitHashlineInputs(input);
		expect(sections).toHaveLength(1);
		expect(sections[0].path).toBe("a.ts");
		expect(sections[0].diff.includes("never-emitted")).toBe(false);
	});

	it("clean input without sentinel produces no warning", () => {
		const diff = `»${tag(1, "alpha")}\n${pl("PAYLOAD")}\n`;
		const { warnings } = parseHashlineWithWarnings(diff);
		expect(warnings).toEqual([]);
	});
});
