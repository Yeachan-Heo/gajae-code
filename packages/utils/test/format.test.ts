import { describe, expect, it } from "bun:test";
import { formatBytes, formatDuration, formatNumber } from "../src/format";

describe("formatNumber", () => {
	it("does not round K and M values into the next suffix", () => {
		expect(formatNumber(999_499)).toBe("999K");
		expect(formatNumber(999_999)).toBe("999K");
		expect(formatNumber(1_000_000)).toBe("1M");
		expect(formatNumber(999_999_999)).toBe("999M");
		expect(formatNumber(1_000_000_000)).toBe("1B");
	});
});

describe("formatBytes", () => {
	it("does not round bytes into the next unit before the threshold", () => {
		expect(formatBytes(1024 * 1024 - 1)).toBe("1023.9KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0MB");
		expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe("1023.9MB");
		expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0GB");
	});

	it("does not clamp the terminal GB unit (no next unit to protect)", () => {
		expect(formatBytes(1024 ** 4)).toBe("1024.0GB");
		expect(formatBytes(2 * 1024 ** 4)).toBe("2048.0GB");
		expect(formatBytes(1023 * 1024 ** 3)).toBe("1023.0GB");
	});
});

describe("formatDuration", () => {
	it("does not round seconds up into the minute unit", () => {
		expect(formatDuration(59_949)).toBe("59.9s");
		expect(formatDuration(59_950)).toBe("59.9s");
		expect(formatDuration(59_999)).toBe("59.9s");
		expect(formatDuration(60_000)).toBe("1m");
	});

	it("keeps existing sub-minute formatting", () => {
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1_000)).toBe("1.0s");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatDuration(30_000)).toBe("30.0s");
	});
});
