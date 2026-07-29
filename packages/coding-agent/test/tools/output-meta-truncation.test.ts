import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { truncateHead, truncateMiddleWindows } from "../../src/session/streaming-output";
import {
	BASH_DEFAULT_OUTPUT_TAIL_BYTES,
	formatOutputNotice,
	outputMeta,
	resolveBashOutputSinkHeadBytes,
	resolveBashOutputSinkTailBytes,
} from "../../src/tools/output-meta";

describe("output truncation metadata plumbing", () => {
	test("defaults Bash capture to a 1 KiB tail while preserving explicit retention budgets", () => {
		expect(BASH_DEFAULT_OUTPUT_TAIL_BYTES).toBe(1024);
		expect(resolveBashOutputSinkTailBytes(Settings.isolated())).toBe(1024);
		expect(resolveBashOutputSinkTailBytes(Settings.isolated({ "tools.artifactTailBytes": 7 }))).toBe(7 * 1024);
		expect(resolveBashOutputSinkHeadBytes(Settings.isolated())).toBe(0);
		expect(resolveBashOutputSinkHeadBytes(Settings.isolated({ "tools.artifactHeadBytes": 7 }))).toBe(7 * 1024);
	});
	test("forwards noticeOwner on ordinary truncation builders", () => {
		const result = truncateHead("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });
		const meta = outputMeta().truncation(result, { direction: "head", noticeOwner: "body" }).get();
		expect(meta?.truncation?.noticeOwner).toBe("body");
	});

	test("uses actual windows for truncationWindows and forwards noticeOwner", () => {
		const windows = truncateMiddleWindows("aaaaa\nb\nc\nd\ne\nf\ng", { maxBytes: 12, maxLines: 10 });
		const meta = outputMeta().truncationWindows(windows, { noticeOwner: "body" }).get();
		expect(meta?.truncation).toMatchObject({
			direction: "middle",
			noticeOwner: "body",
			headRange: { start: 1, end: 1 },
			tailRange: { start: 5, end: 7 },
		});
	});

	test("labels selected-window coordinates in truncation notices", () => {
		const windows = truncateMiddleWindows("a\nb\nc\nd\ne", { maxBytes: 5, maxLines: 3 });
		const meta = outputMeta().truncationWindows(windows, { rangeBase: "window" }).get();
		const notice = formatOutputNotice(meta);
		expect(notice).toContain("of the selected 5-line range");
	});

	test("marks partial middle tails without inventing a complete tail range", () => {
		const windows = truncateMiddleWindows(`short\n${"Z".repeat(60_000)}`, { maxBytes: 10 * 1024, maxLines: 50 });
		const meta = outputMeta().truncationWindows(windows).get();
		const truncation = meta?.truncation;

		expect(truncation?.partialLine).toMatchObject({ line: 2, sourceBytes: 60_000 });
		expect(truncation?.headRange).toBeUndefined();
		expect(truncation?.tailRange).toBeUndefined();
		expect(formatOutputNotice(meta)).toContain("last");
		expect(formatOutputNotice(meta)).toContain("of line 2");
	});

	test("forwards noticeOwner through summary and text option interfaces", () => {
		const summaryMeta = outputMeta()
			.truncationFromSummary(
				{
					output: "one",
					truncated: true,
					totalLines: 2,
					totalBytes: 7,
					outputLines: 1,
					outputBytes: 3,
				},
				{ direction: "head", noticeOwner: "body" },
			)
			.get();
		expect(summaryMeta?.truncation?.noticeOwner).toBe("body");

		const textMeta = outputMeta()
			.truncationFromText("one", { direction: "head", totalLines: 2, noticeOwner: "body" })
			.get();
		expect(textMeta?.truncation?.noticeOwner).toBe("body");
	});
});
