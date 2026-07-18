import { describe, expect, test } from "bun:test";
import { parseRichEligibility } from "../src/sdk/bus/rich-document";

const eligible = { kind: "eligible" } as const;
const ineligible = { kind: "ineligible" } as const;
type BotApi101Fixture = {
	source: string;
	published: string;
	anchors: { sendRichMessage: string; inputRichMessage: string };
	sendRichMessage: { supports: string[] };
	inputRichMessage: { supports: string[]; forbids: string[] };
	pinnedOutgoingContract: { forbidden: string[] };
};

function table(columns: number): string {
	const cells = Array.from({ length: columns }, (_, index) => `c${index}`).join(" | ");
	return `| ${cells} |\n| ${Array.from({ length: columns }, () => "---").join(" | ")} |\n| ${cells} |`;
}

describe("parseRichEligibility", () => {
	test("accepts structured headings, inline/display math, formatting, and GFM tables", () => {
		expect(parseRichEligibility("# Result $x^2$\n\n**bold** and `code`\n\n$$\na + b\n$$")).toEqual(eligible);
		expect(parseRichEligibility("| Formula | Value |\n| :-- | --: |\n| $x$ | **2** | ")).toEqual(eligible);
	});

	test("accepts exactly 32,768 Unicode scalars including astral scalars and rejects 32,769", () => {
		const prefix = "$x$\n";
		expect(parseRichEligibility(prefix + "😀".repeat(32_764))).toEqual(eligible);
		expect(parseRichEligibility(prefix + "😀".repeat(32_765))).toEqual(ineligible);
	});

	test("enforces the defensive UTF-8 ceiling alongside the scalar ceiling", () => {
		const largestStructuredFourByteDocument = `$😀$${"😀".repeat(32_765)}`;
		expect(Buffer.byteLength(largestStructuredFourByteDocument, "utf8")).toBe(131_066);
		expect(parseRichEligibility(largestStructuredFourByteDocument)).toEqual(eligible);

		const exactByteCeiling = "😀".repeat(32_768);
		expect(Buffer.byteLength(exactByteCeiling, "utf8")).toBe(131_072);
		expect(parseRichEligibility(exactByteCeiling)).toEqual(ineligible);
		expect(Buffer.byteLength(`${exactByteCeiling}a`, "utf8")).toBe(131_073);
		expect(parseRichEligibility(`${exactByteCeiling}a`)).toEqual(ineligible);
	});

	test("rejects lone UTF-16 high and low surrogates", () => {
		expect(parseRichEligibility("$x$\n\ud800")).toEqual(ineligible);
		expect(parseRichEligibility("$x$\n\udc00")).toEqual(ineligible);
	});

	test("allows 500 recursive blocks and rejects 501", () => {
		expect(parseRichEligibility("$x$\n\n".repeat(500))).toEqual(eligible);
		expect(parseRichEligibility("$x$\n\n".repeat(501))).toEqual(ineligible);
	});

	test("allows formatting nesting depth 16 and rejects 17", () => {
		const nested = (depth: number) => `${"_".repeat(depth * 2)}text${"_".repeat(depth * 2)}\n\n$x$`;
		expect(parseRichEligibility(nested(16))).toEqual(eligible);
		expect(parseRichEligibility(nested(17))).toEqual(ineligible);
	});

	test("allows 20 table columns and rejects 21", () => {
		expect(parseRichEligibility(table(20))).toEqual(eligible);
		expect(parseRichEligibility(table(21))).toEqual(ineligible);
	});

	test("fails closed for malformed math and unsupported or unbalanced Markdown", () => {
		for (const markdown of [
			"$x",
			"$$\nx",
			"\\(x",
			"**bold\n\n$x$",
			"> quote\n\n$x$",
			"- item\n\n$x$",
			"[link](https://example.com)\n\n$x$",
		]) {
			expect(parseRichEligibility(markdown)).toEqual(ineligible);
		}
	});

	test("is deterministic across repeated parsing", () => {
		const markdown = "# Stable\n\n| x | y |\n| --- | --- |\n| $a$ | `b` |";
		const first = parseRichEligibility(markdown);
		for (let index = 0; index < 20; index++) expect(parseRichEligibility(markdown)).toEqual(first);
	});
});
test("pins the June 11 Bot API 10.1 rich-message request surface", async () => {
	const fixture = (await Bun.file(
		new URL("./fixtures/telegram-bot-api-10.1-rich-message-2026-06-11.json", import.meta.url),
	).json()) as BotApi101Fixture;
	expect(fixture.published).toBe("2026-06-11");
	expect(fixture.source).toBe("https://core.telegram.org/bots/api#june-11-2026");
	expect(fixture.anchors).toEqual({
		sendRichMessage: "https://core.telegram.org/bots/api#sendrichmessage",
		inputRichMessage: "https://core.telegram.org/bots/api#inputrichmessage",
	});
	expect(fixture.sendRichMessage.supports).toEqual([
		"message_thread_id",
		"reply_parameters",
		"rich_message",
		"reply_markup",
	]);
	expect(fixture.inputRichMessage.supports).toEqual(["markdown", "skip_entity_detection"]);
	expect(fixture.inputRichMessage.forbids).toEqual(["blocks", "media"]);
	expect(fixture.pinnedOutgoingContract.forbidden).toEqual(["blocks", "media"]);
});
