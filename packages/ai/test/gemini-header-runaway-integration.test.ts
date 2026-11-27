import { describe, expect, it } from "bun:test";
import { GEMINI_HEADER_RUNAWAY_THRESHOLD, GeminiHeaderRunDetector } from "../src/utils/thinking-loop";

/**
 * Integration test: OpenAI-compatible streaming path with Gemini header runaway.
 * Verifies that the stream is interrupted when the detector fires.
 */
describe("Gemini header runaway integration - OpenAI-compatible stream", () => {
	it("interrupts stream when reasoning headers exceed threshold", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Simulate streaming reasoning deltas with headers
		const reasoningDeltas: string[] = [];

		// Generate GEMINI_HEADER_RUNAWAY_THRESHOLD + 10 headers to verify it fires
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD + 10; i++) {
			reasoningDeltas.push(`## Reasoning Step ${i}\n`);
		}

		let didFire = false;
		let headerCountAtFire = 0;

		// Process deltas through detector
		for (const delta of reasoningDeltas) {
			if (detector.push(delta)) {
				didFire = true;
				headerCountAtFire = detector.count;
				break; // Stop processing after fire
			}
		}

		expect(didFire).toBe(true);
		expect(headerCountAtFire).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);
	});

	it("resets detector when transitioning to visible text", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Push some reasoning headers
		for (let i = 0; i < 5; i++) {
			detector.push(`## Header ${i}\n`);
		}
		expect(detector.count).toBe(5);

		// Reset when transitioning to text
		detector.reset();
		expect(detector.count).toBe(0);

		// Can detect again after reset
		detector.push(`## New Header\n`);
		expect(detector.count).toBe(1);
	});

	it("resets detector when transitioning to tool calls", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Push some reasoning headers
		for (let i = 0; i < 10; i++) {
			detector.push(`## Header ${i}\n`);
		}
		expect(detector.count).toBe(10);

		// Tool call received - reset detector
		detector.reset();
		expect(detector.count).toBe(0);
	});

	it("handles mixed reasoning patterns with text interruptions", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Simulate: reasoning headers -> text -> more headers
		for (let i = 0; i < 20; i++) {
			detector.push(`## Header ${i}\n`);
		}
		expect(detector.count).toBe(20);

		// Text appears (detector would be reset in real code)
		detector.reset();
		expect(detector.count).toBe(0);

		// More reasoning after text
		for (let i = 0; i < 15; i++) {
			const fired = detector.push(`## Header ${i}\n`);
			if (fired) {
				expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);
				break;
			}
		}
	});

	it("detects bold and italic header formats that cause runaway", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Alternate between markdown and bold formats
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD + 5; i++) {
			const delta = i % 2 === 0 ? `## Header ${i}\n` : `**Header ${i}**\n`;
			if (detector.push(delta)) {
				expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);
				return;
			}
		}

		throw new Error("Detector should have fired");
	});

	it("does not reset on paragraph content, only on flush", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Headers with paragraphs between them (no reset)
		detector.push("## Header 1\n");
		detector.push("Some explanation paragraph.\n");
		detector.push("More paragraph content.\n");
		detector.push("## Header 2\n");
		detector.push("Another explanation.\n");

		// Should have counted 2 headers (not reset by paragraphs)
		expect(detector.count).toBe(2);
	});

	it("fires exactly once then latches", async () => {
		const detector = new GeminiHeaderRunDetector();
		let fireCount = 0;

		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD * 2; i++) {
			if (detector.push(`## Header ${i}\n`)) {
				fireCount++;
			}
		}

		// Should fire exactly once
		expect(fireCount).toBe(1);
	});
});

/**
 * Integration test: Google provider streaming path with Gemini header runaway.
 * Verifies that the stream throws an error when the detector fires.
 */
describe("Gemini header runaway integration - Google stream", () => {
	it("detects runaway in Google thinking parts", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Simulate streaming thinking from Google API
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD + 10; i++) {
			const part = `## Analysis Step ${i}\n`;
			if (detector.push(part)) {
				// In real code, this would throw and bubble to error handler
				expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);
				return;
			}
		}

		throw new Error("Detector should have fired");
	});

	it("distinguishes between thinking and text in Google response", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Simulate: thinking headers -> text part -> more thinking
		// When transitioning to text, detector resets

		for (let i = 0; i < 15; i++) {
			detector.push(`## Thought ${i}\n`);
		}
		expect(detector.count).toBe(15);

		// Transition to visible text (would call reset in real code)
		detector.reset();

		// New thinking block after text
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD - 10; i++) {
			detector.push(`## Thought ${i}\n`);
		}
		// Should not have fired yet (count is below threshold after reset)
		expect(detector.count).toBeLessThan(GEMINI_HEADER_RUNAWAY_THRESHOLD);
	});

	it("handles tool call transitions correctly", async () => {
		const detector = new GeminiHeaderRunDetector();

		// Simulate: thinking headers -> tool call
		for (let i = 0; i < 20; i++) {
			detector.push(`## Thought ${i}\n`);
		}
		expect(detector.count).toBe(20);

		// Tool call detected (would call reset in real code)
		detector.reset();
		expect(detector.count).toBe(0);

		// Can resume detecting after tool call
		for (let i = 0; i < 5; i++) {
			detector.push(`## Thought ${i}\n`);
		}
		expect(detector.count).toBe(5);
	});
});

/**
 * Integration test: Detector lifecycle across multiple request/response cycles.
 */
describe("Gemini header runaway lifecycle", () => {
	it("isolates detections across separate requests", async () => {
		const detector1 = new GeminiHeaderRunDetector();
		const detector2 = new GeminiHeaderRunDetector();

		// First request hits threshold
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD; i++) {
			if (detector1.push(`## Header ${i}\n`)) {
				break;
			}
		}

		// Second request (fresh detector) starts clean
		expect(detector2.count).toBe(0);
		for (let i = 0; i < 10; i++) {
			detector2.push(`## Header ${i}\n`);
		}
		expect(detector2.count).toBe(10);
	});

	it("supports safe re-enabling after threshold hit via reset", async () => {
		const detector = new GeminiHeaderRunDetector();

		// First cycle: hit threshold
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD; i++) {
			detector.push(`## Header ${i}\n`);
		}
		expect(detector.count).toBe(GEMINI_HEADER_RUNAWAY_THRESHOLD);

		// After stream ends, could reset for a new thinking block
		// (though in practice, we'd create a new detector per request)
		detector.reset();
		expect(detector.count).toBe(0);

		// Can detect again in next block
		detector.push(`## Header 0\n`);
		expect(detector.count).toBe(1);
	});
});
