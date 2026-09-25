import { describe, expect, it } from "bun:test";
import { encodeSixel, getWorkProfile } from "../native/index.js";

type Golden = {
	inputPngBase64: string;
	targetWidthPx: number;
	targetHeightPx: number;
	expectedSixelBase64: string;
};

const golden = JSON.parse(
	await Bun.file(`${import.meta.dir}/fixtures/goldens/sixel/native-encode.json`).text(),
) as Golden;

describe("SIXEL re-sync differential golden", () => {
	it("matches the pre-sync native encoding and records its profile region", () => {
		const png = Buffer.from(golden.inputPngBase64, "base64");
		const encoded = encodeSixel(png, golden.targetWidthPx, golden.targetHeightPx);
		expect(Buffer.from(encoded).toString("base64")).toBe(golden.expectedSixelBase64);
		expect(getWorkProfile(60).folded).toContain("sixel.encode");
	});

	it("rejects zero dimensions before trying to decode input", () => {
		expect(() => encodeSixel(new Uint8Array(), 0, 1)).toThrow("Target SIXEL dimensions must be greater than zero");
	});

	it("rejects malformed image bytes", () => {
		expect(() => encodeSixel(new Uint8Array([1, 2, 3]), 1, 1)).toThrow("Failed to decode image");
	});
});
