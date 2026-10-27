import { describe, expect, it } from "bun:test";
import { encodeSixel } from "../native/index.js";

const onePixelPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

describe("encodeSixel pixel cap", () => {
	it("rejects a side above 4096", () => {
		expect(() => encodeSixel(onePixelPng, 4097, 1)).toThrow(/4096/);
	});

	it("rejects a pixel count above 8000000 when both sides are within 4096", () => {
		expect(() => encodeSixel(onePixelPng, 4000, 2001)).toThrow(/8000000/);
	});

	it("rejects a huge dimension in a child process instead of aborting", async () => {
		const proc = Bun.spawn({
			cmd: [
				"bun",
				"-e",
				`import { encodeSixel } from "./native/index.js";
const png = Buffer.from(${JSON.stringify(onePixelPng.toString("base64"))}, "base64");
try { encodeSixel(png, 100000, 100000); process.exit(0); }
catch (error) {
  const text = String(error);
  process.exit(text.includes("4096") || text.includes("8000000") ? 2 : 1);
}`,
			],
			cwd: `${import.meta.dir}/..`,
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await proc.exited).toBe(2);
	});

	it("allows a 4096px side", () => {
		const encoded = encodeSixel(onePixelPng, 4096, 1);
		expect(typeof encoded).toBe("string");
		expect(encoded.length).toBeGreaterThan(0);
	});

	it("still returns a string for a 1x1 encode", () => {
		const encoded = encodeSixel(onePixelPng, 1, 1);
		expect(typeof encoded).toBe("string");
		expect(encoded.length).toBeGreaterThan(0);
	});
});
