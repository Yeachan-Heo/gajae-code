import { describe, expect, test } from "bun:test";
import { finalizeTelegramHtml, markdownToTelegramHtml, truncateTelegramHtml } from "../src/sdk/bus/html-format";
import { renderThreadedFrame } from "../src/sdk/bus/threaded-render";

const allowedTags = new Set(["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"]);
const allowedTagPattern = /<\/?(?:b|i|u|s|code|pre|blockquote|tg-spoiler)>|<a\s+href="[^"]*">|<\/a>/gi;

function pseudoRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function randomString(seed: number): string {
	const rand = pseudoRandom(seed);
	const atoms = [
		"<",
		">",
		"&",
		"*",
		"`",
		"#",
		"</b>",
		"<b>",
		"<script>",
		"</pre>",
		"&amp;",
		"&lt",
		"&notanentity",
		"[x](javascript:alert(1))",
		"[ok](https://example.com/a?b=1&c=2)",
		"```ts\nconst x = '<tag>';&amp;\n```",
		"a".repeat(256),
		`<unterminated${"x".repeat(32)}`,
		`&amp${"x".repeat(32)}`,
		"plain text ",
	];
	const pieces: string[] = [];
	const count = 1 + Math.floor(rand() * 40);
	for (let i = 0; i < count; i++) {
		pieces.push(atoms[Math.floor(rand() * atoms.length)] ?? "");
		if (rand() < 0.2) pieces.push(String.fromCharCode(32 + Math.floor(rand() * 95)));
	}
	return pieces.join("");
}

function stripAllowedTags(html: string): string {
	return html.replace(allowedTagPattern, "");
}

function assertNoStrayAngles(html: string): void {
	const stripped = stripAllowedTags(html);
	expect(stripped, html).not.toContain("<");
	expect(stripped, html).not.toContain(">");
}

function tagBalance(html: string): Map<string, number> {
	const balance = new Map<string, number>();
	const tagPattern = /<\/?([a-z-]+)(?:\s+href="[^"]*")?>/gi;
	for (const match of html.matchAll(tagPattern)) {
		const whole = match[0] ?? "";
		const name = (match[1] ?? "").toLowerCase();
		if (!allowedTags.has(name)) continue;
		balance.set(name, (balance.get(name) ?? 0) + (whole.startsWith("</") ? -1 : 1));
	}
	return balance;
}

function assertBalancedAllowedTags(html: string): void {
	const stack: string[] = [];
	const tagPattern = /<\/?([a-z-]+)(?:\s+href="[^"]*")?>/gi;
	for (const match of html.matchAll(tagPattern)) {
		const whole = match[0] ?? "";
		const name = (match[1] ?? "").toLowerCase();
		if (!allowedTags.has(name)) continue;
		if (whole.startsWith("</")) {
			expect(stack.pop(), html).toBe(name);
		} else {
			stack.push(name);
		}
	}
	expect(stack, html).toEqual([]);
	for (const [name, count] of tagBalance(html)) {
		expect(count, `${name}: ${html}`).toBe(0);
	}
}

function assertNoTrailingEntityOrTagFragment(html: string): void {
	expect(html).not.toMatch(/&(a(m(p?)?)?|l(t?)?|g(t?)?|q(u(o(t?)?)?)?)?$/);
	expect(html).not.toMatch(/<[^>]*$/);
}

describe("red-team truncateTelegramHtml properties", () => {
	test("converted HTML stays within max and never ends mid-token", () => {
		const maxValues = [5, 16, 64, 4096];
		for (let seed = 1; seed <= 520; seed++) {
			// truncateTelegramHtml's contract is "finished Telegram HTML": in
			// production turn_stream is converted first, then truncated. Feed it
			// valid converted HTML for the mid-token property.
			const html = markdownToTelegramHtml(randomString(seed));
			for (const max of maxValues) {
				const out = truncateTelegramHtml(html, max);
				expect(out.length, `seed=${seed} max=${max} out=${JSON.stringify(out)}`).toBeLessThanOrEqual(max);
				assertNoTrailingEntityOrTagFragment(out);
			}
		}
	});

	test("length guarantee holds for arbitrary raw input regardless of validity", () => {
		const maxValues = [5, 16, 64, 4096];
		for (let seed = 1; seed <= 520; seed++) {
			const sample = randomString(seed);
			for (const max of maxValues) {
				expect(truncateTelegramHtml(sample, max).length, `seed=${seed} max=${max}`).toBeLessThanOrEqual(max);
			}
		}
	});
});

describe("red-team markdownToTelegramHtml escaping property", () => {
	test("dynamic angle brackets are escaped except allowed Telegram tags", () => {
		for (let seed = 1000; seed < 1550; seed++) {
			const out = markdownToTelegramHtml(randomString(seed));
			assertNoStrayAngles(out);
		}
	});
});

describe("red-team adversarial links", () => {
	const unsafeLinks = [
		"[x](data:text/html,<b>x</b>)",
		"[x](javascript:alert(1))",
		"[x](file:///etc/passwd)",
		"[x](vbscript:msgbox(1))",
		"[x](http://a b)",
	];

	test.each(unsafeLinks)("%s stays literal/escaped and does not emit an anchor", input => {
		const out = markdownToTelegramHtml(input);
		expect(out).not.toContain("<a ");
		expect(out).not.toContain("</a>");
		assertNoStrayAngles(out);
	});
});

describe("red-team adversarial markdown balance", () => {
	const cases = [
		"***x***",
		"**a*b**",
		"unclosed `code",
		"```\nliteral </pre> text and <b>fake</b>\n```",
		"[**bold label**](https://example.com)",
	];

	test.each(cases)("%s emits only balanced allowed tags", input => {
		const out = markdownToTelegramHtml(input);
		assertNoStrayAngles(out);
		assertBalancedAllowedTags(out);
	});
});

describe("red-team huge turn_stream-like input", () => {
	test("50k-char markdown converts and finalizes to Telegram limit", () => {
		const chunk =
			"# Heading <unsafe> & stuff\n> quoted **bold** `code <x>` [bad](javascript:1) [ok](https://example.com?a=1&b=2)\n";
		const huge = chunk.repeat(Math.ceil(50_000 / chunk.length)).slice(0, 50_000);
		const finalized = finalizeTelegramHtml(markdownToTelegramHtml(huge));
		expect(finalized).toBeDefined();
		expect(finalized!.length).toBeLessThanOrEqual(4096);
		assertNoTrailingEntityOrTagFragment(finalized!);
		assertNoStrayAngles(finalized!);
		assertBalancedAllowedTags(finalized!);
	});
});

describe("red-team tool activity and reasoning summary rendering", () => {
	test("escapes tool metadata and summary HTML without allowing tag injection", () => {
		const send = renderThreadedFrame({
			type: "tool_activity",
			sessionId: "s",
			toolCallId: "call-1",
			toolName: "<b>shell</b> & \u0000",
			phase: "failed",
			argsSummary: "<script>run</script> & \u0001",
		});
		expect(send?.text).toContain("&lt;b&gt;shell&lt;/b&gt; &amp; \u0000");
		expect(send?.text).toContain("<pre>&lt;script&gt;run&lt;/script&gt; &amp; \u0001</pre>");
		expect(send?.text).not.toContain("<script>");
	});

	test("escapes reasoning HTML once without double-escaping", () => {
		const send = renderThreadedFrame({
			type: "reasoning_summary",
			sessionId: "s",
			text: "<img src=x> & \u0002",
		});
		expect(send?.text).toBe("&lt;img src=x&gt; &amp; \u0002");
		expect(send?.text).not.toContain("&amp;lt;");
	});
});
