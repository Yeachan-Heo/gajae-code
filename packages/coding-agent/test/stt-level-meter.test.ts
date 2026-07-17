import { describe, expect, test } from "bun:test";
import { formatGhostTranscript, pcm16RmsLevel, pushLevel, renderLevelSparkline } from "../src/stt/level-meter";

function pcm16(samples: number[]): Uint8Array {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	samples.forEach((sample, i) => {
		view.setInt16(i * 2, sample, true);
	});
	return bytes;
}

describe("pcm16RmsLevel", () => {
	test("silence maps to 0", () => {
		expect(pcm16RmsLevel(pcm16([0, 0, 0, 0]))).toBe(0);
		expect(pcm16RmsLevel(new Uint8Array(0))).toBe(0);
	});

	test("full-scale square wave maps to 1", () => {
		expect(pcm16RmsLevel(pcm16([32767, -32767, 32767, -32767]))).toBeCloseTo(1, 2);
	});

	test("quiet signal lands inside the meter window", () => {
		// ~-40dBFS sine-ish amplitude (327/32768).
		const level = pcm16RmsLevel(pcm16([327, -327, 327, -327]));
		expect(level).toBeGreaterThan(0.1);
		expect(level).toBeLessThan(0.4);
	});

	test("odd trailing byte is ignored, not misread", () => {
		const bytes = new Uint8Array(5);
		expect(pcm16RmsLevel(bytes)).toBe(0);
	});

	test("louder input yields a higher level (monotonic)", () => {
		const quiet = pcm16RmsLevel(pcm16([100, -100]));
		const loud = pcm16RmsLevel(pcm16([10_000, -10_000]));
		expect(loud).toBeGreaterThan(quiet);
	});
});

describe("pushLevel", () => {
	test("caps history length and clamps values", () => {
		const history: number[] = [];
		for (let i = 0; i < 20; i++) pushLevel(history, i % 2 === 0 ? 2 : -1, 8);
		expect(history).toHaveLength(8);
		expect(Math.max(...history)).toBeLessThanOrEqual(1);
		expect(Math.min(...history)).toBeGreaterThanOrEqual(0);
	});
});

describe("renderLevelSparkline", () => {
	test("renders fixed width with left-padded silence", () => {
		expect(renderLevelSparkline([], 4)).toBe("▁▁▁▁");
		expect(renderLevelSparkline([1], 4)).toBe("▁▁▁█");
	});

	test("maps levels to increasing glyphs", () => {
		const line = renderLevelSparkline([0, 0.3, 0.6, 0.99], 4);
		expect(line).toHaveLength(4);
		expect(line[0]).toBe("▁");
		expect(line[3]).toBe("█");
	});

	test("ascii mode emits only ascii", () => {
		const line = renderLevelSparkline([0, 0.5, 1], 3, false);
		expect(/^[ -~]+$/.test(line)).toBe(true);
	});

	test("keeps only the newest samples", () => {
		expect(renderLevelSparkline([1, 1, 1, 0, 0], 2)).toBe("▁▁");
	});
});

describe("formatGhostTranscript", () => {
	test("passes short text through, collapsing whitespace", () => {
		expect(formatGhostTranscript("  hello\n world  ")).toBe("hello world");
	});

	test("keeps the tail of long text with a leading ellipsis", () => {
		const text = `${"a".repeat(100)} tail-words`;
		const ghost = formatGhostTranscript(text, 20);
		expect(ghost).toHaveLength(20);
		expect(ghost.startsWith("…")).toBe(true);
		expect(ghost.endsWith("tail-words")).toBe(true);
	});
});
