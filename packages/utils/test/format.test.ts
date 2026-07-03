import { describe, expect, it } from "bun:test";
import { formatBytes, formatNumber } from "../src/format";

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
});
