import * as native from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

const onePixelPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

const cases = [
	{
		id: "R01",
		run: async () => {
			const profile: unknown = await native.getWorkProfile(5);
			if (typeof profile !== "object" || profile === null) {
				throw new Error("getWorkProfile returned no profile object");
			}
			const result = profile as { folded?: unknown; summary?: unknown; sampleCount?: unknown };
			if (typeof result.folded !== "string") throw new Error("getWorkProfile returned an invalid folded string");
			if (typeof result.summary !== "string" || result.summary.trim() === "") {
				throw new Error("getWorkProfile returned an empty or invalid summary");
			}
			if (typeof result.sampleCount !== "number" || !Number.isInteger(result.sampleCount) || result.sampleCount < 0) {
				throw new Error("getWorkProfile returned an invalid sampleCount");
			}
		},
	},
	{
		id: "R02",
		run: async () => {
			const sixel: unknown = await native.encodeSixel(onePixelPng, 1, 1);
			if (typeof sixel !== "string" || !sixel.startsWith("\x1bP") || sixel.length <= 2) {
				throw new Error("encodeSixel did not produce a SIXEL sequence");
			}
		},
	},
];

await runAbSuite("prof", cases, 30);
