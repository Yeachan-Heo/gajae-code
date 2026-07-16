import { describe, expect, test, vi } from "bun:test";
import { logger } from "@gajae-code/utils";
import { Marked, type Token, type TokensList } from "marked";
import {
	buildBtwRichBlocks,
	buildRichMessage,
	deliverBtwRichWithFallback,
	deliverRichActionWithFallback,
	deliverRichWithFallback,
	shouldPromoteRich,
} from "../src/sdk/bus/rich-render";
import type { BotApi } from "../src/sdk/bus/telegram-daemon";
import type { ThreadedSend } from "../src/sdk/bus/threaded-render";

/** A valid finalized send that satisfies the rich-markdown marker clauses. */
function makeSend(over: Partial<ThreadedSend> = {}): ThreadedSend {
	return {
		method: "sendMessage",
		lane: "finalized",
		richClass: "final",
		text: "final answer",
		richMarkdown: "# Final\nbody",
		...over,
	};
}

/** A fully-passing `shouldPromoteRich` input; override one field per case. */
function baseInput(
	over: Partial<Parameters<typeof shouldPromoteRich>[0]> = {},
): Parameters<typeof shouldPromoteRich>[0] {
	return { enabled: true, send: makeSend(), ...over };
}

/** Recording BotApi whose response (or throw) is driven by `handler`. */
function makeBot(handler: (method: string, body: unknown) => unknown): {
	bot: BotApi;
	calls: Array<{ method: string; body: unknown }>;
} {
	const calls: Array<{ method: string; body: unknown }> = [];
	const bot: BotApi = {
		async call(method: string, body: unknown): Promise<unknown> {
			calls.push({ method, body });
			return handler(method, body);
		},
	};
	return { bot, calls };
}

describe("shouldPromoteRich truth table", () => {
	test("happy path: every clause holds -> true", () => {
		expect(shouldPromoteRich(baseInput())).toBe(true);
	});

	test("enabled false -> false", () => {
		expect(shouldPromoteRich(baseInput({ enabled: false }))).toBe(false);
	});

	test("enabled undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ enabled: undefined }))).toBe(false);
	});

	test("editable finalized send -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ editable: true }) }))).toBe(false);
	});

	test("non-editable finalized send -> true", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ editable: false }) }))).toBe(true);
	});

	test("method other than sendMessage -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ method: "sendPhoto" }) }))).toBe(false);
	});

	test("lane other than finalized -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ lane: "live" }) }))).toBe(false);
	});

	test("richClass absent -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: undefined }) }))).toBe(false);
	});

	// The type only permits richClass "final"; these forge invalid runtime classes
	// (a buggy/hostile frame) to prove the gate still fail-closes on non-final.
	test("forged richClass ask/idle -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: "ask" as unknown as "final" }) }))).toBe(false);
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: "idle" as unknown as "final" }) }))).toBe(false);
	});

	test("forged richClass system -> false (system metadata frames are not rich-promoted)", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: "system" as unknown as "final" }) }))).toBe(
			false,
		);
	});

	test("richMarkdown empty string -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: "" }) }))).toBe(false);
	});

	test("richMarkdown undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: undefined }) }))).toBe(false);
	});

	test("oversized richMarkdown -> false (HTML chunk path owns long finalized turns)", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: "x".repeat(4097) }) }))).toBe(false);
	});
	test("send.text empty string -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ text: "" }) }))).toBe(false);
	});

	test("send.text undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ text: undefined }) }))).toBe(false);
	});
});

describe("buildRichMessage", () => {
	test("wraps raw markdown verbatim in rich_message shape", () => {
		expect(buildRichMessage("# Title\n**bold** & <raw>")).toEqual({
			rich_message: { markdown: "# Title\n**bold** & <raw>" },
		});
	});

	test("preserves an empty string without substitution", () => {
		expect(buildRichMessage("")).toEqual({ rich_message: { markdown: "" } });
	});
	test("includes reply_markup extras when supplied", () => {
		expect(
			buildRichMessage("answer", { reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] } }),
		).toEqual({
			rich_message: { markdown: "answer" },
			reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] },
		});
	});
});

describe("deliverRichWithFallback", () => {
	test("success (ok:true): one sendRichMessage call, correct body, no fallback, no warn", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 1 } }));
		let fallbacks = 0;
		const warns: string[] = [];
		const send = makeSend({ richMarkdown: "# Final\nbody" });
		await deliverRichWithFallback(
			bot,
			{ chat_id: 42, message_thread_id: 7 },
			send,
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(calls.length).toBe(1);
		expect(calls[0]!.method).toBe("sendRichMessage");
		expect(calls[0]!.body).toEqual({
			chat_id: 42,
			message_thread_id: 7,
			rich_message: { markdown: "# Final\nbody" },
		});
		expect(fallbacks).toBe(0);
		expect(warns.length).toBe(0);
	});

	test("success body omits message_thread_id when base has none", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true }));
		await deliverRichWithFallback(bot, { chat_id: "chat-xyz" }, makeSend({ richMarkdown: "hi" }), async () => {});
		expect(calls[0]!.body).toEqual({ chat_id: "chat-xyz", rich_message: { markdown: "hi" } });
	});

	test("null response counts as success: no fallback, no warn", async () => {
		const { bot } = makeBot(() => null);
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(fallbacks).toBe(0);
		expect(warns.length).toBe(0);
	});

	test("thrown error: warns exactly once before running fallback (order)", async () => {
		const events: string[] = [];
		const bot: BotApi = {
			async call(): Promise<unknown> {
				events.push("call");
				throw new Error("boom");
			},
		};
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				events.push("fallback");
			},
			{
				warn: m => {
					events.push("warn");
					expect(m).toContain("boom");
				},
			},
		);
		expect(events).toEqual(["call", "warn", "fallback"]);
	});

	test("{ok:false} with description: warns once with description then falls back once", async () => {
		const { bot } = makeBot(() => ({ ok: false, description: "Bad Request: rich unsupported" }));
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("Bad Request: rich unsupported");
		expect(warns[0]).toContain("falling back to HTML");
		expect(fallbacks).toBe(1);
	});

	test("{ok:false} without description: warns once with ok:false then falls back once", async () => {
		const { bot } = makeBot(() => ({ ok: false }));
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("ok:false");
		expect(fallbacks).toBe(1);
	});

	test("no log provided: failure still falls back without crashing", async () => {
		const bot: BotApi = {
			async call(): Promise<unknown> {
				throw new Error("boom");
			},
		};
		let fallbacks = 0;
		await deliverRichWithFallback(bot, { chat_id: 1 }, makeSend(), async () => {
			fallbacks++;
		});
		expect(fallbacks).toBe(1);
	});

	test("no log provided: success neither crashes nor falls back", async () => {
		const { bot } = makeBot(() => ({ ok: true }));
		let fallbacks = 0;
		await deliverRichWithFallback(bot, { chat_id: 1 }, makeSend(), async () => {
			fallbacks++;
		});
		expect(fallbacks).toBe(0);
	});
});
describe("deliverRichActionWithFallback", () => {
	test("rich success: one sendRichMessage with top-level reply_markup, returns id, usedRich, no fallback/warn", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 77 } }));
		let fallbacks = 0;
		const warns: string[] = [];
		const replyMarkup = { inline_keyboard: [[{ text: "A", callback_data: "x" }]] };
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 42, message_thread_id: 7 },
			{ markdown: "❓ **Proceed?**\n\n1. Yes\n2. No", replyMarkup },
			async () => {
				fallbacks++;
				return 999;
			},
			{ warn: (m: string) => warns.push(m) },
		);
		expect(res).toEqual({ messageId: 77, usedRich: true, usedFallback: false });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe("sendRichMessage");
		expect(calls[0]!.body).toEqual({
			chat_id: 42,
			message_thread_id: 7,
			rich_message: { markdown: "❓ **Proceed?**\n\n1. Yes\n2. No" },
			reply_markup: replyMarkup,
		});
		expect(fallbacks).toBe(0);
		expect(warns).toHaveLength(0);
	});

	test("no replyMarkup: reply_markup omitted from the rich body (idle)", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 5 } }));
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: "c" },
			{ markdown: "🟢 Agent idle" },
			async () => 0,
		);
		expect(res).toEqual({ messageId: 5, usedRich: true, usedFallback: false });
		expect(calls[0]!.body).toEqual({ chat_id: "c", rich_message: { markdown: "🟢 Agent idle" } });
	});

	test("success without result.message_id: usedRich true, messageId undefined", async () => {
		const { bot } = makeBot(() => ({ ok: true }));
		const res = await deliverRichActionWithFallback(bot, { chat_id: 1 }, { markdown: "x" }, async () => 0);
		expect(res).toEqual({ messageId: undefined, usedRich: true, usedFallback: false });
	});

	test("requireMessageId + rich success without message_id: falls back to HTML for a routable id", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true })); // ok but no result.message_id
		let fallbacks = 0;
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 1 },
			{ markdown: "ask?", requireMessageId: true },
			async () => {
				fallbacks++;
				return 888;
			},
		);
		expect(res).toEqual({ messageId: 888, usedRich: false, usedFallback: true });
		expect(calls.filter(c => c.method === "sendRichMessage")).toHaveLength(1);
		expect(fallbacks).toBe(1);
	});

	test("ok:false: warns exactly once, runs htmlFallback, returns its id, usedFallback", async () => {
		const { bot, calls } = makeBot(() => ({ ok: false, description: "no rich" }));
		const warns: string[] = [];
		let fallbacks = 0;
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 1 },
			{ markdown: "x", replyMarkup: { inline_keyboard: [] } },
			async () => {
				fallbacks++;
				return 321;
			},
			{ warn: (m: string) => warns.push(m) },
		);
		expect(res).toEqual({ messageId: 321, usedRich: false, usedFallback: true });
		expect(calls.filter(c => c.method === "sendRichMessage")).toHaveLength(1);
		expect(fallbacks).toBe(1);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("sendRichMessage(action) failed");
	});

	test("throw: warns once then falls back to HTML and returns the fallback id", async () => {
		const { bot } = makeBot(() => {
			throw new Error("transport down");
		});
		const warns: string[] = [];
		let fallbacks = 0;
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 1 },
			{ markdown: "x" },
			async () => {
				fallbacks++;
				return 654;
			},
			{ warn: (m: string) => warns.push(m) },
		);
		expect(res).toEqual({ messageId: 654, usedRich: false, usedFallback: true });
		expect(fallbacks).toBe(1);
		expect(warns).toHaveLength(1);
	});
});
describe("/btw native table rich rendering", () => {
	const table = "| Name | Score |\n| :--- | ---: |\n| Ada | 10 |";

	test("promotes tables in source order while allowing root spaces and preserving table cell metadata", () => {
		const blocks = buildBtwRichBlocks(
			`\n\n# Results\n\n${table}\n\nBetween tables.\n\n| Key |\n| --- |\n| value |\n\n`,
		);
		expect(blocks).toEqual([
			{ type: "heading", size: 1, text: ["Results"] },
			{
				type: "table",
				cells: [
					[
						{ text: ["Name"], is_header: true, align: "left", valign: "top" },
						{ text: ["Score"], is_header: true, align: "right", valign: "top" },
					],
					[
						{ text: ["Ada"], align: "left", valign: "top" },
						{ text: ["10"], align: "right", valign: "top" },
					],
				],
			},
			{ type: "paragraph", text: ["Between tables."] },
			{
				type: "table",
				cells: [[{ text: ["Key"], is_header: true, valign: "top" }], [{ text: ["value"], valign: "top" }]],
			},
		]);
	});

	test("keeps unsupported, no-table, unsupported-token, over-unit, and over-column input on markdown rich delivery", () => {
		const exactly500 = `| h |\n| --- |\n${Array.from({ length: 498 }, (_, index) => `| ${index} |`).join("\n")}`;
		const oneOver500 = `| h |\n| --- |\n${Array.from({ length: 499 }, (_, index) => `| ${index} |`).join("\n")}`;
		const exactly20 = `| ${Array.from({ length: 20 }, (_, index) => `h${index}`).join(" | ")} |\n| ${Array.from({ length: 20 }, () => "---").join(" | ")} |\n| ${Array.from({ length: 20 }, () => "v").join(" |")} |`;
		const oneOver20 = `| ${Array.from({ length: 21 }, (_, index) => `h${index}`).join(" | ")} |\n| ${Array.from({ length: 21 }, () => "---").join(" | ")} |\n| ${Array.from({ length: 21 }, () => "v").join(" |")} |`;
		const supportedNesting = `***supported***\n\n${table}`;

		expect(buildBtwRichBlocks("plain paragraph")).toBeUndefined();
		expect(buildBtwRichBlocks(`[link](https://example.com)\n\n${table}`)).toBeUndefined();
		expect(buildBtwRichBlocks(`<details>unsupported</details>\n\n${table}`)).toBeUndefined();
		expect(buildBtwRichBlocks(exactly500)).toBeDefined();
		expect(buildBtwRichBlocks(oneOver500)).toBeUndefined();
		expect(buildBtwRichBlocks(exactly20)).toBeDefined();
		expect(buildBtwRichBlocks(oneOver20)).toBeUndefined();
		expect(buildBtwRichBlocks(supportedNesting)).toBeDefined();
	});
	test("accepts tokens reaching depth 16 and rejects tokens reaching depth 17", () => {
		const tableAtDepth = (formattingTokens: number): TokensList => {
			let cell: Token = { type: "text", raw: "value", text: "value" } as Token;
			for (let index = 0; index < formattingTokens; index++) {
				cell = { type: "strong", raw: `**${cell.raw}**`, text: `**${cell.raw}**`, tokens: [cell] } as Token;
			}
			const tokens: Token[] = [
				{
					type: "table",
					raw: "",
					header: [{ text: "Header", tokens: [{ type: "text", raw: "Header", text: "Header" }] }],
					align: [null],
					rows: [[{ text: "value", tokens: [cell] }]],
				} as Token,
			];
			return Object.assign(tokens, { links: {} });
		};

		const lexerSpy = vi.spyOn(Marked.prototype, "lexer");
		try {
			// Table cells enter inline compilation at depth 2; 14 wrappers reach the accepted depth 16.
			lexerSpy.mockImplementation(() => tableAtDepth(14));
			expect(buildBtwRichBlocks(table)).toBeDefined();

			lexerSpy.mockImplementation(() => tableAtDepth(15));
			expect(buildBtwRichBlocks(table)).toBeUndefined();
		} finally {
			lexerSpy.mockRestore();
		}
	});

	test("uses blocks only for an eligible table and falls back once for rejected rich responses or throws", async () => {
		const markdown = table;
		for (const response of [
			() => ({ ok: false, description: "unsupported" }),
			() => {
				throw new Error("transport down");
			},
		]) {
			const { bot, calls } = makeBot(response);
			let fallbacks = 0;
			await deliverBtwRichWithFallback(bot, { chat_id: 42, message_thread_id: 7 }, markdown, async () => {
				fallbacks++;
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual({
				method: "sendRichMessage",
				body: {
					chat_id: 42,
					message_thread_id: 7,
					rich_message: { blocks: buildBtwRichBlocks(markdown), skip_entity_detection: true },
				},
			});
			expect(fallbacks).toBe(1);
		}
	});

	test("uses the exact original markdown rich request when block compilation throws", async () => {
		const markdown = "# Original\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
		const { bot, calls } = makeBot(() => ({ ok: true }));
		const lexerSpy = vi.spyOn(Marked.prototype, "lexer").mockImplementation(() => {
			throw new Error("lexer unavailable");
		});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let fallbacks = 0;
		try {
			await deliverBtwRichWithFallback(bot, { chat_id: 42, message_thread_id: 7 }, markdown, async () => {
				fallbacks++;
			});
			expect(lexerSpy).toHaveBeenCalledTimes(1);
			expect(lexerSpy).toHaveBeenCalledWith(markdown);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledWith(
				"notifications: unable to compile /btw rich blocks; using Markdown fallback",
			);
			expect(calls).toEqual([
				{
					method: "sendRichMessage",
					body: { chat_id: 42, message_thread_id: 7, rich_message: { markdown } },
				},
			]);
			expect(fallbacks).toBe(0);
		} finally {
			warnSpy.mockRestore();
			lexerSpy.mockRestore();
		}
	});
	test("uses one unchanged markdown rich request, fallback, and warning when compilation is unsupported", async () => {
		const markdown = "plain **markdown**";
		for (const [response, warning] of [
			[() => ({ ok: false, description: "unsupported" }), "unsupported"],
			[
				() => {
					throw new Error("transport down");
				},
				"transport down",
			],
		] as const) {
			const { bot, calls } = makeBot(response);
			const fallbacks: string[] = [];
			const warnings: string[] = [];
			await deliverBtwRichWithFallback(
				bot,
				{ chat_id: 42, message_thread_id: 7 },
				markdown,
				async () => {
					fallbacks.push(markdown);
				},
				{ warn: message => warnings.push(message) },
			);
			expect(calls).toEqual([
				{
					method: "sendRichMessage",
					body: { chat_id: 42, message_thread_id: 7, rich_message: { markdown } },
				},
			]);
			expect(fallbacks).toEqual([markdown]);
			expect(warnings).toEqual([`notifications: sendRichMessage(/btw) failed (${warning}); falling back to HTML`]);
		}
	});
});
describe("/btw mathematical-expression rich rendering", () => {
	const tableWith = (cell: string): string => `| Formula |\n| --- |\n| ${cell} |`;

	test("renders dollar and parenthesized inline math inside table cells in source order", () => {
		expect(buildBtwRichBlocks(tableWith("before $x^2$ middle \\(y + 1\\) after"))).toEqual([
			{
				type: "table",
				cells: [
					[{ text: ["Formula"], valign: "top", is_header: true }],
					[
						{
							text: [
								"before ",
								{ type: "mathematical_expression", expression: "x^2" },
								" middle ",
								{ type: "mathematical_expression", expression: "y + 1" },
								" after",
							],
							valign: "top",
						},
					],
				],
			},
		]);
	});

	test("renders standalone dollar and bracket math as blocks while preserving mixed source order", () => {
		expect(
			buildBtwRichBlocks(
				"Lead $a$.\n\n$$x^2 + y^2$$\n\n| Value |\n| --- |\n| \\(z\\) |\n\n\\[\\frac{1}{n}\\]\n\nTail",
			),
		).toEqual([
			{
				type: "paragraph",
				text: ["Lead ", { type: "mathematical_expression", expression: "a" }, "."],
			},
			{ type: "mathematical_expression", expression: "x^2 + y^2" },
			{
				type: "table",
				cells: [
					[{ text: ["Value"], valign: "top", is_header: true }],
					[{ text: [{ type: "mathematical_expression", expression: "z" }], valign: "top" }],
				],
			},
			{ type: "mathematical_expression", expression: "\\frac{1}{n}" },
			{ type: "paragraph", text: ["Tail"] },
		]);
	});
	test("requires an unescaped display-math closing delimiter with odd/even backslash parity", async () => {
		expect(buildBtwRichBlocks(String.raw`$$x\\$$`)).toEqual([
			{ type: "mathematical_expression", expression: String.raw`x\\` },
		]);
		expect(buildBtwRichBlocks(String.raw`\[x\\\]`)).toEqual([
			{ type: "mathematical_expression", expression: String.raw`x\\` },
		]);

		for (const markdown of [String.raw`$$x\$$`, String.raw`\[x\\]`]) {
			expect(buildBtwRichBlocks(markdown)).toBeUndefined();

			const { bot, calls } = makeBot(() => ({ ok: true }));
			await deliverBtwRichWithFallback(bot, { chat_id: 42 }, markdown, async () => {});
			expect(calls).toEqual([{ method: "sendRichMessage", body: { chat_id: 42, rich_message: { markdown } } }]);
		}
	});

	test("keeps escaped dollars literal and fails closed to the exact original markdown for ambiguous math delimiters", async () => {
		const escaped = tableWith(String.raw`cost \$5 and $x$`);
		expect(buildBtwRichBlocks(escaped)).toEqual([
			{
				type: "table",
				cells: [
					[{ text: ["Formula"], valign: "top", is_header: true }],
					[
						{
							text: ["cost $5 and ", { type: "mathematical_expression", expression: "x" }],
							valign: "top",
						},
					],
				],
			},
		]);

		for (const markdown of [
			tableWith("$"),
			tableWith("$unclosed"),
			tableWith("$$"),
			tableWith("$outer $inner$ tail$"),
			"| Formula |\n| --- |\n| \\(unclosed |",
			"| Formula |\n| --- |\n| \\[inline\\] |",
		]) {
			const { bot, calls } = makeBot(() => ({ ok: true }));
			await deliverBtwRichWithFallback(bot, { chat_id: 42 }, markdown, async () => {});
			expect(calls).toEqual([{ method: "sendRichMessage", body: { chat_id: 42, rich_message: { markdown } } }]);
		}
	});
	test("rejects nested or mixed unescaped dollar delimiters in paragraphs, displays, and table cells", async () => {
		const markdowns = [
			"$outer $inner$ tail$",
			String.raw`\(\alpha $x$ \beta\)`,
			"$$outer $inner$ tail$$",
			tableWith("$outer $inner$ tail$"),
			tableWith(String.raw`\(\alpha $x$ \beta\)`),
			String.raw`$x\\$y$`,
		];

		for (const markdown of markdowns) {
			expect(buildBtwRichBlocks(markdown)).toBeUndefined();
			const { bot, calls } = makeBot(() => ({ ok: true }));
			await deliverBtwRichWithFallback(bot, { chat_id: 42 }, markdown, async () => {});
			expect(calls).toEqual([{ method: "sendRichMessage", body: { chat_id: 42, rich_message: { markdown } } }]);
		}

		expect(buildBtwRichBlocks(String.raw`$x\$y$`)).toEqual([
			{ type: "paragraph", text: [{ type: "mathematical_expression", expression: String.raw`x\$y` }] },
		]);
	});

	test("counts mathematical-expression blocks toward the 500-unit document limit", () => {
		const mathBlocks = (count: number) => Array.from({ length: count }, () => "$$x$$").join("\n\n");
		const table = "| h |\n| --- |\n| v |";
		expect(buildBtwRichBlocks(`${mathBlocks(497)}\n\n${table}`)).toBeDefined();
		expect(buildBtwRichBlocks(`${mathBlocks(498)}\n\n${table}`)).toBeUndefined();
	});
});
