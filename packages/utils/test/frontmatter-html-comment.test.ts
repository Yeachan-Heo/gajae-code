import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "@gajae-code/utils";
import fc from "fast-check";

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const PROPERTY_SEED = 3202026;
const commentPerf = process.env.FRONTMATTER_COMMENT_PERF !== "1";

function referenceParse(input: string) {
	HTML_COMMENT.lastIndex = 0;
	const normalized = input
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.replace(HTML_COMMENT, "");
	return parseFrontmatter(normalized, { normalize: false, level: "off" });
}

describe("parseFrontmatter HTML comments", () => {
	it("keeps a long run of unterminated HTML comment prefixes", () => {
		const body = `${"<!--".repeat(8_000)}TAIL`;
		const parsed = parseFrontmatter(body, { level: "off" });
		expect(parsed.frontmatter).toEqual({});
		expect(parsed.body).toBe(body);
	});

	it.skipIf(commentPerf)(
		"performance run only: unterminated HTML comment prefixes stay within a second",
		() => {
			const body = `${"<!--".repeat(100_000)}TAIL`;
			const started = performance.now();
			const parsed = parseFrontmatter(body, { level: "off" });
			expect(parsed.body).toBe(body);
			expect(performance.now() - started).toBeLessThan(1_000);
		},
		30_000,
	);

	it("keeps plain markdown and a closed HTML comment", () => {
		const plain = "skill body without a comment";
		expect(parseFrontmatter(plain, { level: "off" }).body).toBe(plain);
		expect(parseFrontmatter("before <!-- hidden --> after", { level: "off" }).body).toBe("before  after");
		expect(parseFrontmatter("<!-- a <!-- b --> c -->", { level: "off" }).body).toBe(" c -->");
		expect(parseFrontmatter("<!---->TAIL", { level: "off" }).body).toBe("TAIL");
		expect(parseFrontmatter("<!-- one -->MID<!-- two -->", { level: "off" }).body).toBe("MID");
		expect(parseFrontmatter("<!--\nsecret\n-->kept", { level: "off" }).body).toBe("kept");
		expect(parseFrontmatter("before\r\n<!-- x -->\r\nafter", { level: "off" }).body).toBe("before\n\nafter");
		expect(parseFrontmatter("<!<!-- note -->--hidden-->", { level: "off" }).body).toBe("<!--hidden-->");
	});

	it("keeps frontmatter keys when a comment sits in the body", () => {
		const parsed = parseFrontmatter("---\nname: demo\ndescription: kept\n---\n# Title\n<!-- hidden -->\nvisible\n", {
			level: "off",
		});
		expect(parsed.frontmatter).toEqual({ name: "demo", description: "kept" });
		expect(parsed.body).toBe("# Title\n\nvisible");
	});

	it("keeps an unterminated comment opener and skips comments when normalize is off", () => {
		expect(parseFrontmatter("visible <!-- still here", { level: "off" }).body).toBe("visible <!-- still here");
		const raw = "before <!-- hidden --> after";
		expect(parseFrontmatter(raw, { normalize: false, level: "off" }).body).toBe(raw);
	});

	it("keeps a long run of terminated HTML comments removed", () => {
		const parsed = parseFrontmatter(`${"<!--x-->".repeat(160_000)}TAIL`, { level: "off" });
		expect(parsed.body).toBe("TAIL");
	});

	it.skipIf(commentPerf)(
		"performance run only: terminated HTML comments stay within a second",
		() => {
			const started = performance.now();
			const parsed = parseFrontmatter(`${"<!--x-->".repeat(160_000)}TAIL`, { level: "off" });
			expect(parsed.body).toBe("TAIL");
			expect(performance.now() - started).toBeLessThan(1_000);
		},
		30_000,
	);

	it("property: HTML comment removal matches the bounded reference, seed 3202026, 64 inputs", () => {
		const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 \n.,-!<>".split("");
		const text = fc.array(fc.constantFrom(...alphabet), { minLength: 0, maxLength: 16 }).map(chars => chars.join(""));
		const chunk = fc.oneof(
			text,
			fc.constant("<!-- note -->"),
			fc.constant("<!---->"),
			fc.constant("<!--"),
			fc.constant("-->"),
			fc.constant("<!-->"),
			fc.constant("\r\n"),
			fc.constant("\uFEFF"),
			fc.constant("---\nname: kept\n---\n"),
			fc.constant("<!-- a <!-- b --> c -->"),
		);
		fc.assert(
			fc.property(fc.array(chunk, { minLength: 0, maxLength: 8 }), parts => {
				const input = parts.join("");
				const once = parseFrontmatter(input, { level: "off" });
				const ref = referenceParse(input);
				expect(once.body).toBe(ref.body);
				expect(once.frontmatter).toEqual(ref.frontmatter);
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});
