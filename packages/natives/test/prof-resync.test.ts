import { describe, expect, it } from "bun:test";
import { encodeSixel, getWorkProfile, htmlToMarkdown } from "../native/index.js";

type Golden = { expectedStacks: string[] };

const golden = JSON.parse(
	await Bun.file(`${import.meta.dir}/fixtures/goldens/prof/pre-sync-stacks.json`).text(),
) as Golden;
const onePixelPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

describe("work profiler re-sync differential golden", () => {
	it("retains pre-sync HTML/SIXEL region labels in folded profile output", async () => {
		await htmlToMarkdown("<p>profile golden</p>");
		encodeSixel(onePixelPng, 1, 1);
		const stacks = getWorkProfile(60)
			.folded.split("\n")
			.filter(Boolean)
			.map(line => line.slice(0, line.lastIndexOf(" ")));
		expect(stacks).toEqual(expect.arrayContaining(golden.expectedStacks));
	});
});
