import { describe, expect, it } from "bun:test";
import {
	GEMINI_HEADER_RUNAWAY_THRESHOLD,
	GeminiHeaderRunDetector,
	isReasoningSummaryHeader,
} from "../src/utils/thinking-loop";

describe("isReasoningSummaryHeader", () => {
	it("detects markdown heading with single hash", () => {
		expect(isReasoningSummaryHeader("# Title")).toBe(true);
	});

	it("detects markdown heading with multiple hashes", () => {
		expect(isReasoningSummaryHeader("## Sub Title")).toBe(true);
		expect(isReasoningSummaryHeader("### Sub Sub Title")).toBe(true);
		expect(isReasoningSummaryHeader("#### Another")).toBe(true);
		expect(isReasoningSummaryHeader("##### Deep")).toBe(true);
		expect(isReasoningSummaryHeader("###### Deepest")).toBe(true);
	});

	it("detects bold runs at whole line", () => {
		expect(isReasoningSummaryHeader("**Bold Title**")).toBe(true);
		expect(isReasoningSummaryHeader("***Bold Italic***")).toBe(true);
	});

	it("requires space after hash", () => {
		expect(isReasoningSummaryHeader("#NoSpace")).toBe(false);
	});

	it("requires non-whitespace after hash and space", () => {
		expect(isReasoningSummaryHeader("#    ")).toBe(false);
		expect(isReasoningSummaryHeader("#\t")).toBe(false);
	});

	it("rejects inline bold emphasis", () => {
		expect(isReasoningSummaryHeader("Text with **bold** inside")).toBe(false);
	});

	it("rejects unclosed bold runs", () => {
		expect(isReasoningSummaryHeader("**Unclosed")).toBe(false);
		expect(isReasoningSummaryHeader("**Unclosed Bold")).toBe(false);
	});

	it("rejects empty bold runs", () => {
		expect(isReasoningSummaryHeader("****")).toBe(false);
	});

	it("rejects plain text", () => {
		expect(isReasoningSummaryHeader("Just plain text")).toBe(false);
	});

	it("ignores leading/trailing whitespace in test (via trim)", () => {
		// Note: the function tests the trimmed line in context of push(),
		// but the function itself doesn't trim
		expect(isReasoningSummaryHeader("  ## Spaced Title")).toBe(false);
		expect(isReasoningSummaryHeader("## Title  ")).toBe(true);
	});
});

describe("GeminiHeaderRunDetector", () => {
	it("counts single header correctly", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header\n");
		expect(detector.count).toBe(1);
	});

	it("counts multiple headers", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header 1\n");
		detector.push("## Header 2\n");
		detector.push("## Header 3\n");
		expect(detector.count).toBe(3);
	});

	it("ignores paragraph lines between headers", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header 1\n");
		detector.push("Some paragraph text\n");
		detector.push("## Header 2\n");
		expect(detector.count).toBe(2);
	});

	it("returns false when below threshold", () => {
		const detector = new GeminiHeaderRunDetector();
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD - 1; i++) {
			const result = detector.push(`## Header ${i}\n`);
			expect(result).toBe(false);
		}
		expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD - 1);
	});

	it("returns true exactly once when threshold is reached", () => {
		const detector = new GeminiHeaderRunDetector();
		let hitThreshold = false;

		// Push to exactly the threshold
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD; i++) {
			const result = detector.push(`## Header ${i}\n`);
			if (result && i === GEMINI_HEADER_RUNAWAY_THRESHOLD - 1) {
				hitThreshold = true;
			}
		}

		// After firing, the detector stops processing (latched)
		const afterFireResult = detector.push("## Another header\n");
		expect(afterFireResult).toBe(false);

		expect(hitThreshold).toBe(true);
		expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);
	});

	it("handles multi-line chunks correctly", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header 1\n## Header 2\n## Header 3\n");
		expect(detector.count).toBe(3);
	});

	it("handles partial lines (no newline)", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header");
		expect(detector.count).toBe(0); // Not complete yet

		detector.push(" 1\n");
		expect(detector.count).toBe(1); // Now it's complete
	});

	it("ignores empty lines", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header 1\n\n## Header 2\n");
		expect(detector.count).toBe(2);
	});

	it("ignores lines with only whitespace", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header 1\n   \n## Header 2\n");
		expect(detector.count).toBe(2);
	});

	it("detects bold headers", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("**Header 1**\n");
		detector.push("**Header 2**\n");
		expect(detector.count).toBe(2);
	});

	it("detects bold italic headers", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("***Header 1***\n");
		detector.push("***Header 2***\n");
		expect(detector.count).toBe(2);
	});

	it("reset clears state", () => {
		const detector = new GeminiHeaderRunDetector();
		detector.push("## Header 1\n");
		detector.push("## Header 2\n");
		expect(detector.count).toBe(2);

		detector.reset();
		expect(detector.count).toBe(0);

		// Can detect again after reset
		detector.push("## Header 3\n");
		expect(detector.count).toBe(1);
	});

	it("handles empty deltas", () => {
		const detector = new GeminiHeaderRunDetector();
		const result = detector.push("");
		expect(result).toBe(false);
		expect(detector.count).toBe(0);
	});

	it("stops processing after threshold is reached", () => {
		const detector = new GeminiHeaderRunDetector();

		// Push to threshold
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD; i++) {
			detector.push(`## Header ${i}\n`);
		}

		// Count should be at threshold
		expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);

		// Further deltas are ignored once fired
		const result1 = detector.push(`## Header ${GEMINI_HEADER_RUNAWAY_THRESHOLD}\n`);
		expect(result1).toBe(false);

		// Empty delta should return false
		const result2 = detector.push("");
		expect(result2).toBe(false);

		// Count stays at threshold
		expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);
	});
});
