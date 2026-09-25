import { describe, expect, it } from "bun:test";
import { htmlToMarkdown, type HtmlToMarkdownOptions } from "../native/index.js";

type GoldenCase = {
	name: string;
	html?: string;
	repeat?: { tag: string; depth: number; text: string };
	options?: HtmlToMarkdownOptions;
	expectedLines?: string[];
	expectedError?: string;
};

const goldens = JSON.parse(
	await Bun.file(`${import.meta.dir}/fixtures/goldens/html/native-outputs.json`).text(),
) as GoldenCase[];

function htmlFor(golden: GoldenCase): string {
	if (golden.repeat) {
		const { tag, depth, text } = golden.repeat;
		return `<${tag}>`.repeat(depth) + text + `</${tag}>`.repeat(depth);
	}
	if (golden.html === undefined) throw new Error(`Golden ${golden.name} has no HTML input`);
	return golden.html;
}

describe("HTML re-sync differential goldens", () => {
	for (const golden of goldens) {
		it(`matches the pre-sync native output for ${golden.name}`, async () => {
			const conversion = htmlToMarkdown(htmlFor(golden), golden.options);
			if (golden.expectedError !== undefined) {
				await expect(conversion).rejects.toThrow(golden.expectedError);
				return;
			}
			expect(await conversion).toBe(golden.expectedLines?.join("\n"));
		});
	}
});
