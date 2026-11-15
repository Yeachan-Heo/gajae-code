import { describe, expect, test } from "bun:test";
import {
	copyableMessageText,
	fitMessages,
	HISTORY_PAGE_BYTES,
	IMAGE_PREVIEW_BYTES,
	projectHistoryPage,
	projectMessages,
	TEXT_LIMIT,
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

	for (const limit of [TEXT_LIMIT, 32_000]) {
		const project = (messages: readonly unknown[], redact: (text: string) => string) =>
			limit === TEXT_LIMIT ? projectMessages(messages, redact) : projectHistoryPage(messages, 0, 100, redact).page;

		test(`redacts complete strings before the ${limit}-character tail cap in every display path`, () => {
			const secret = "sk-abcdefghij1234567890";
			const tail = "x".repeat(limit - 10);
			const raw = `${secret}${tail}`;
			const expected = `[redacted]${tail}`;
			const input = [
				{ role: "user", content: raw },
				{ role: "user", content: [{ type: "text", text: raw }] },
				{ role: "assistant", stopReason: "stop", content: raw },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: raw },
						{ type: "text", text: raw },
					],
				},
				{ role: "toolResult", content: raw },
				{
					role: "toolResult",
					isError: true,
					content: [
						{ type: "thinking", thinking: "reasoning" },
						{ type: "text", text: raw },
					],
				},
				{ role: "assistant", stopReason: "error", content: [], errorMessage: raw },
				{
					role: "assistant",
					stopReason: "error",
					content: [{ type: "thinking", thinking: "reasoning" }],
					errorMessage: raw,
				},
				{ role: "bashExecution", command: "echo safe", output: raw, exitCode: 0, excludeFromContext: true },
				{ role: "pythonExecution", code: "print('safe')", output: raw, exitCode: 1 },
			];
			const canonical = JSON.stringify(input);
			const seen: string[] = [];
			const messages = project(input, text => {
				seen.push(text);
				return text.replaceAll(secret, "[redacted]");
			});
			expect(messages).toHaveLength(input.length);
			for (const message of messages) {
				expect(message.text).toBe(expected);
				expect(message.text).toHaveLength(limit);
				expect(message.truncated).toBe(true);
			}
			expect(messages[3]?.blocks).toEqual([
				{ type: "thinking", text: expected },
				{ type: "text", text: expected },
			]);
			for (const index of [5, 7]) {
				expect(messages[index]?.blocks).toEqual([
					{ type: "thinking", text: "reasoning" },
					{ type: "text", text: expected },
				]);
				expect(messages[index]?.isError).toBe(true);
			}
			expect(messages[6]?.isError).toBe(true);
			expect(messages[8]?.excludeFromContext).toBe(true);
			expect(messages[8]?.toolName).toBe("Direct shell");
			expect(messages[9]?.toolName).toBe("Direct Python");
			expect(messages[9]?.isError).toBe(true);
			expect(seen).toContain(raw);
			expect(seen).toContain(`echo safe\n${raw}`);
			expect(seen).toContain(`print('safe')\n${raw}`);
			expect(JSON.stringify(messages)).not.toContain("1234567890");
			expect(JSON.stringify(messages)).not.toContain("sk-abcdefghij");
			expect(JSON.stringify(input)).toBe(canonical);
			expect(copyableMessageText(input[0])).toBe(raw);
			expect(copyableMessageText(input[2])).toBe(raw);
		});

		test(`redacts direct execution source and source/output seams before the ${limit}-character cap`, () => {
			const secret = "command-secret\noutput-secret";
			const tail = "x".repeat(limit - 10);
			const sourceSecret = "sk-abcdefghij1234567890";
			const sourceTail = "s".repeat(limit - 11);
			const input = [
				{ role: "bashExecution", command: "command-secret", output: `output-secret${tail}` },
				{ role: "pythonExecution", code: "command-secret", output: `output-secret${tail}` },
				{ role: "bashExecution", command: `${sourceSecret}${sourceTail}`, output: "" },
				{ role: "pythonExecution", code: `${sourceSecret}${sourceTail}`, output: "" },
			];
			const canonical = JSON.stringify(input);
			const messages = project(input, text =>
				text.replaceAll(secret, "[redacted]").replaceAll(sourceSecret, "[redacted]"),
			);
			expect(messages.map(message => message.text)).toEqual([
				`[redacted]${tail}`,
				`[redacted]${tail}`,
				`[redacted]${sourceTail}\n`,
				`[redacted]${sourceTail}\n`,
			]);
			for (const message of messages) {
				expect(message.text).toHaveLength(limit);
				expect(message.truncated).toBe(true);
			}
			expect(JSON.stringify(messages)).not.toContain("output-secret");
			expect(JSON.stringify(messages)).not.toContain("1234567890");
			expect(JSON.stringify(input)).toBe(canonical);
		});

		test(`redacts before the remaining structured tool-text budget at ${limit} characters`, () => {
			const secret = "sk-abcdefghij1234567890";
			const tail = "x".repeat(limit - "final".length - 10);
			const input = [
				{
					role: "toolResult",
					content: [
						{ type: "thinking", thinking: "reasoning" },
						{ type: "text", text: `${secret}${tail}` },
						{ type: "text", text: "final" },
					],
				},
			];
			const canonical = JSON.stringify(input);
			const [message] = project(input, text => text.replaceAll(secret, "[redacted]"));
			expect(message?.blocks).toEqual([
				{ type: "thinking", text: "reasoning" },
				{ type: "text", text: `[redacted]${tail}` },
				{ type: "text", text: "final" },
			]);
			expect(message?.text).toBe(`[redacted]${tail}\nfinal`);
			expect(message?.text).toHaveLength(limit + 1);
			expect(message?.truncated).toBe(true);
			expect(JSON.stringify(message)).not.toContain("1234567890");
			expect(JSON.stringify(input)).toBe(canonical);
		});

		test(`keeps shared-prefix credentials intact for redaction before ${limit}-character truncation`, () => {
			const credentials = ["sk-abcdefghij1234567890", "sk-abcdefghij"];
			const tail = "x".repeat(limit - credentials[1]!.length - 11);
			const raw = `${credentials[0]}/${credentials[1]}${tail}`;
			const [message] = project([{ role: "toolResult", content: [{ type: "text", text: raw }] }], text => {
				for (const credential of credentials) text = text.split(credential).join("[redacted]");
				return text;
			});
			expect(message?.text).toBe(`[redacted]/[redacted]${tail}`);
			expect(message?.text.length).toBeLessThanOrEqual(limit);
			expect(message?.truncated).toBe(true);
			expect(message?.text).not.toContain("1234567890");
			expect(message?.text).not.toContain("sk-abcdefghij");
		});

		test(`redacts the full tool name before its prefix cap in the ${limit}-character projection`, () => {
			const secret = "sk-abcdefghij1234567890";
			const toolName = `${"n".repeat(95)}${secret}`;
			const input = [{ role: "toolResult", toolName, content: "result" }];
			const [message] = project(input, text => text.replaceAll(secret, "[redacted]"));
			expect(message?.toolName).toBe(`${"n".repeat(95)}[reda`);
			expect(message?.toolName).toHaveLength(100);
			expect(message?.text).toBe("result");
			expect(message?.toolName).not.toContain("sk-ab");
			expect(input[0]?.toolName).toBe(toolName);
		});

		test(`keeps expanded redactions within the ${limit}-character text and thinking budgets`, () => {
			const input = [
				{
					role: "toolResult",
					toolName: "k".repeat(100),
					content: [
						{ type: "text", text: "k".repeat(limit / 2) },
						{ type: "thinking", thinking: "k".repeat(limit) },
						{ type: "text", text: "k".repeat(limit / 2) },
					],
				},
			];
			const canonical = JSON.stringify(input);
			const [message] = project(input, text => text.replaceAll("k", "[redacted]"));
			expect(message?.text).toBe("[redacted]".repeat(limit / 10));
			expect(message?.blocks).toEqual([
				{ type: "thinking", text: message?.text },
				{ type: "text", text: message?.text },
			]);
			expect(message?.text).toHaveLength(limit);
			expect(message?.toolName).toBe("[redacted]".repeat(10));
			expect(message?.truncated).toBe(true);
			expect(JSON.stringify(input)).toBe(canonical);
		});
	}

	test("withholds oversized strings in full without passing a raw slice to redaction", () => {
		const maximum = 8 * 1024 * 1024;
		const huge = "s".repeat(maximum + 1);
		const half = "s".repeat(maximum / 2);
		const final = "x".repeat(TEXT_LIMIT - 1);
		const input = [
			{ role: "user", content: huge },
			{ role: "assistant", stopReason: "error", content: [], errorMessage: huge },
			{
				role: "toolResult",
				toolName: huge,
				content: [
					{ type: "thinking", thinking: huge },
					{ type: "text", text: huge },
					{ type: "text", text: final },
				],
			},
			{ role: "bashExecution", command: half, output: half },
			{ role: "pythonExecution", code: huge, output: "" },
		];
		const seen: string[] = [];
		const messages = projectMessages(input, text => {
			seen.push(text);
			return text;
		});
		expect(seen).toEqual([final]);
		expect(messages.map(message => message.text)).toEqual([
			"[withheld: display limit]",
			"[withheld: display limit]",
			`[\n${final}`,
			"[withheld: display limit]",
			"[withheld: display limit]",
		]);
		expect(messages[2]?.blocks).toEqual([
			{ type: "thinking", text: "[withheld: display limit]" },
			{ type: "text", text: "[" },
			{ type: "text", text: final },
		]);
		expect(messages[2]?.toolName).toBe("[withheld: display limit]");
		expect(messages.every(message => message.truncated)).toBe(true);
		expect(input[0]?.content).toBe(huge);
		expect(input[1]?.errorMessage).toBe(huge);
		expect(input[2]?.toolName).toBe(huge);
		expect(input[3]?.command).toBe(half);
		expect(input[3]?.output).toBe(half);
		expect(input[4]?.code).toBe(huge);
	});

	test("withholds overlarge redaction results instead of forwarding them into display fitting", () => {
		const expanded = "s".repeat(8 * 1024 * 1024 + 1);
		const [message] = projectMessages(
			[{ role: "toolResult", toolName: "expand", content: "expand" }],
			() => expanded,
		);
		expect(message?.text).toBe("[withheld: display limit]");
		expect(message?.toolName).toBe("[withheld: display limit]");
		expect(message?.truncated).toBe(true);
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
