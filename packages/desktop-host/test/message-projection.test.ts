import { describe, expect, test } from "bun:test";
import {
	fitMessages,
	HISTORY_PAGE_BYTES,
	IMAGE_PREVIEW_BYTES,
	projectHistoryPage,
	projectMessages,
} from "../src/message-projection";

const image = { type: "image", mimeType: "image/png", data: "QUFB" } as const;

describe("desktop message projection", () => {
	test("keeps supplied content in order without provider metadata", () => {
		const [message] = projectMessages([
			{
				role: "assistant",
				headers: { authorization: "header-secret" },
				content: [
					{ type: "thinking", thinking: "reasoning", thinkingSignature: "signature-secret" },
					{ type: "text", text: "first" },
					{ type: "toolCall", arguments: { token: "argument-secret" } },
					image,
					{ type: "text", text: "second" },
				],
			},
		]);
		expect(message?.text).toBe("first\nsecond");
		expect(message?.blocks).toEqual([
			{ type: "thinking", text: "reasoning" },
			{ type: "text", text: "first" },
			image,
			{ type: "text", text: "second" },
		]);
		expect(JSON.stringify(message)).not.toContain("secret");
	});

	test("omits empty assistant turns consistently from history offsets", () => {
		const input = [
			{ role: "assistant", content: [{ type: "toolCall", arguments: {} }] },
			{ role: "assistant", content: " \n " },
			{ role: "assistant", content: [{ type: "thinking", thinking: "thought" }] },
			{ role: "assistant", content: [image] },
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" },
			{ role: "toolResult", content: [image] },
			{ role: "user", content: [image] },
		];
		const first = projectHistoryPage(input, 0, 2);
		const second = projectHistoryPage(input, 2, 10);
		expect(first.total).toBe(5);
		expect(first.page.map(item => item.id)).toEqual(["2:", "3:"]);
		expect(second.page.map(item => item.id)).toEqual(["4:", "5:", "6:"]);
		expect(second.page[0]?.text).toBe("provider failed");
		expect(projectMessages(input).map(item => item.id)).toEqual(["2:", "3:", "4:", "5:", "6:"]);
	});

	test("keeps the latest answer independently of long thinking and earlier text", () => {
		const message = projectMessages([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "t".repeat(12_000) },
					{ type: "text", text: "old".repeat(4_000) },
					{ type: "text", text: "final answer" },
				],
			},
		])[0]!;
		expect(message.blocks?.map(block => block.type)).toEqual(["thinking", "text", "text"]);
		expect(message.blocks?.[0]).toEqual({ type: "thinking", text: "t".repeat(8_000) });
		expect(message.text.endsWith("final answer")).toBe(true);
		expect(message.truncated).toBe(true);
	});

	test("fits the newest rich answer into a small serialized-byte budget", () => {
		const projected = projectMessages([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "想法".repeat(4_000) },
					{ type: "text", text: `${"前部分".repeat(3_000)}final answer` },
				],
			},
		]);
		const budget = 250;
		const fitted = fitMessages(projected, budget);
		expect(fitted.truncated).toBe(true);
		expect(fitted.messages).toHaveLength(1);
		const message = fitted.messages[0]!;
		expect(message.truncated).toBe(true);
		expect(message.text.endsWith("final answer")).toBe(true);
		expect(
			message.blocks
				?.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n"),
		).toBe(message.text);
		expect(Buffer.byteLength(JSON.stringify(message)) + 1).toBeLessThanOrEqual(budget);
		const plain = fitMessages([{ id: "id", role: "assistant", text: `${'漢"'.repeat(1000)}end` }], 120);
		expect(plain.truncated).toBe(true);
		expect(plain.messages[0]?.text.endsWith("end")).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(plain.messages[0])) + 1).toBeLessThanOrEqual(120);
	});

	test("accounts for array brackets at the exact serialized boundary", () => {
		const message = { id: "array-boundary", role: "assistant" as const, text: `${"漢".repeat(100)}end` };
		const budget = Buffer.byteLength(JSON.stringify([message])) - 1;
		const fitted = fitMessages([message], budget);
		expect(fitted.truncated).toBe(true);
		expect(fitted.messages[0]?.text.endsWith("end")).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(fitted.messages))).toBeLessThanOrEqual(budget);
	});

	test("skips an oversized trailing image placeholder to preserve a small answer", () => {
		const message = {
			id: "0:",
			role: "assistant" as const,
			text: "end",
			blocks: [
				{ type: "text" as const, text: "end" },
				{ type: "image-unavailable" as const, reason: "Image preview is unavailable." },
			],
		};
		const result = fitMessages([message], 120);
		expect(result.truncated).toBe(true);
		expect(result.messages[0]?.text).toBe("end");
		expect(result.messages[0]?.blocks).toEqual([{ type: "text", text: "end" }]);
		expect(result.messages[0]?.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result.messages[0])) + 1).toBeLessThanOrEqual(120);
	});

	test("validates inline data and allowlisted media types before previewing", () => {
		const parts = [
			image,
			{ ...image, data: "https://example.com/a.png" },
			{ ...image, data: "%%%=" },
			{ ...image, mimeType: "image/svg+xml" },
			{ ...image, data: "A".repeat(IMAGE_PREVIEW_BYTES + 4) },
		];
		const message = projectMessages([{ role: "user", content: parts }])[0]!;
		expect(message.blocks?.map(block => block.type)).toEqual([
			"image",
			"image-unavailable",
			"image-unavailable",
			"image-unavailable",
			"image-unavailable",
		]);
		expect(JSON.stringify(message)).not.toContain("https://example.com");
	});

	test("bounds repeated images, rich text and aggregate sessions by serialized bytes", () => {
		const data = "A".repeat(200_000);
		const input = Array.from({ length: 40 }, () => ({
			role: "user",
			content: [
				{ type: "text", text: '漢"'.repeat(4000) },
				{ type: "image", mimeType: "image/png", data },
			],
		}));
		const page = projectHistoryPage(input, 0, 100);
		expect(Buffer.byteLength(JSON.stringify(page.page))).toBeLessThanOrEqual(HISTORY_PAGE_BYTES + 2);
		expect(page.page.flatMap(message => message.blocks ?? []).some(block => block.type === "image")).toBe(true);
		expect(page.page.flatMap(message => message.blocks ?? []).some(block => block.type === "image-unavailable")).toBe(
			true,
		);
		const sessions = Array.from(
			{ length: 20 },
			() =>
				fitMessages(
					projectMessages(input, text => text, 25_000),
					25_000,
				).messages,
		);
		expect(Buffer.byteLength(JSON.stringify(sessions))).toBeLessThan(510_000);
	});
});
