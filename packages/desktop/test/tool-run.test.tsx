import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall } from "@gajae-code/desktop-host/tool-protocol";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { browserPath, closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

const suite = browserPath ? describe : describe.skip;
const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	if (!browserPath) return;
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) break; } catch { /* server is starting */ }
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); if (server) { server.kill(); await server.exited; } });

const call = (id: string, callId: string, status: DesktopToolCall["status"], family: DesktopToolCall["family"] = "shell"): DesktopMessage => ({
	id, role: "tool", toolName: "bash", text: `output ${id}`,
	...(status === "failed" ? { isError: true } : {}),
	tool: { callId, status, family, subject: `$ step ${callId}`, detail: true },
});

declare global {
	interface Window {
		toolRunFixture: { loads(): string[]; set(messages: DesktopMessage[]): void };
	}
}

/** The transcript map App renders (grouped entries in `data-transcript-message` wrappers, keyed through the same run memory) with a counting detail loader. */
async function fixture(initial: DesktopMessage[]): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	try {
		await componentReady(page, async () => {
			await page.addScriptTag({ type: "module", content: `
				import React from '/node_modules/.vite/deps/react.js';
				import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
				import { Message } from '/src/components.tsx';
				import { ToolDetailContext } from '/src/ToolCallCard.tsx';
				import { groupTranscript, ToolRun, useTranscriptRuns } from '/src/transcript-groups.tsx';
				const h = React.createElement;
				const loads = [];
				const source = { load: async callId => { loads.push(callId); return { callId, command: 'command ' + loads.length }; } };
				let update;
				function Fixture() {
					const [messages, setMessages] = React.useState(${JSON.stringify(initial)});
					update = setMessages;
					const runs = useTranscriptRuns('fixture', 1);
					return h(ToolDetailContext.Provider, { value: source }, h('div', { className: 'conversation' },
						groupTranscript(messages, 100, runs).map(item => h('div', { key: item.key, 'data-transcript-message': item.key, style: { display: 'contents' } },
							item.tools
								? h(ToolRun, { item, renderMessage: message => h(Message, { message }) })
								: item.messages.map(message => h(Message, { key: message.id, message }))))));
				}
				window.toolRunFixture = { loads: () => [...loads], set: messages => update(messages) };
				const root = document.createElement('div');
				document.body.replaceChildren(root);
				ReactDOM.createRoot(root).render(h(React.StrictMode, null, h(Fixture)));
			` });
			await page.waitForSelector(".tool-run");
		});
		await page.addStyleTag({ url: `${origin}/src/styles.css` });
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

const set = (page: Page, messages: DesktopMessage[]) => page.evaluate(value => window.toolRunFixture.set(value), messages);
const loads = (page: Page) => page.evaluate(() => window.toolRunFixture.loads());
/** Tags the card's DOM node; the tag survives only if React keeps the same element. */
const tag = (page: Page, selector: string) =>
	page.$eval(selector, node => { (node as HTMLElement).dataset.fixtureTag = "kept"; });

suite("tool cards and runs in a mounted transcript", () => {
	test("details load on first open, again when the status changes, and the card is never remounted", async () => {
		const { context, page } = await fixture([call("call:a", "a", "running")]);
		try {
			expect(await loads(page)).toEqual([]);
			await page.click('[data-tool-status="running"] summary');
			await page.waitForFunction(() => document.querySelector(".tool-call-details pre")?.textContent === "command 1");
			expect(await loads(page)).toEqual(["a"]);
			await tag(page, ".tool-call");
			await set(page, [call("1:2", "a", "done")]);
			await page.waitForFunction(() => document.querySelector(".tool-call-details pre")?.textContent === "command 2");
			expect(await page.$eval(".tool-call", node => [node.getAttribute("data-tool-status"), (node as HTMLElement).dataset.fixtureTag, node.querySelector("details")?.open])).toEqual(["done", "kept", true]);
			// Closing and reopening a settled card does not ask again.
			await page.click(".tool-call summary");
			await page.click(".tool-call summary");
			expect(await loads(page)).toEqual(["a", "a"]);
			// The one scroll anchor per entry is the run root.
			expect(await page.$$eval("[data-transcript-message] > .message", nodes => nodes.map(node => node.className))).toEqual(["message tool-run"]);
		} finally { await closeComponentFixture(context, page); }
	}, 30000);

	test("a second call joining an expanded card opens its group around the same card", async () => {
		const { context, page } = await fixture([call("1:2", "a", "done")]);
		try {
			await page.click(".tool-call summary");
			await tag(page, ".tool-call");
			await set(page, [call("1:2", "a", "done"), call("call:b", "b", "running")]);
			await page.waitForSelector(".tool-group-summary");
			expect(await page.$eval(".tool-group-summary", node => node.getAttribute("aria-expanded"))).toBe("true");
			expect(await page.$eval(".tool-run-items", node => (node as HTMLElement).hidden)).toBe(false);
			expect(await page.$eval('[data-tool-status="done"]', node => (node as HTMLElement).dataset.fixtureTag)).toBe("kept");
			expect(await page.$$eval("[data-transcript-message]", nodes => nodes.map(node => (node as HTMLElement).dataset.transcriptMessage))).toEqual(["tool:a"]);
		} finally { await closeComponentFixture(context, page); }
	}, 30000);

	test("an opened group longer than the Host's row window stays open and mounted as new calls slide the window", async () => {
		// The Host sends its newest 160 rows; past that, every new call drops the run's first call.
		const window = (calls: number) => [
			{ id: "0:0", role: "user" as const, text: "go" },
			...Array.from({ length: calls }, (_, index) => call(`${index + 1}:1`, `c${index + 1}`, "done")),
		].slice(-160);
		const { context, page } = await fixture(window(150));
		try {
			await page.click(".tool-group-summary");
			// Expand the newest card, which stays in the window, and mark its element.
			await page.$$eval(".tool-call", nodes => {
				const newest = nodes.at(-1) as HTMLElement;
				newest.dataset.fixtureCard = "opened";
				newest.querySelector("summary")?.click();
			});
			await tag(page, ".tool-run");
			for (const calls of [160, 161, 168, 175]) await set(page, window(calls));
			await page.waitForFunction(() => document.querySelectorAll(".tool-call").length === 160);
			expect(await page.$eval(".tool-run", node => [
				(node as HTMLElement).dataset.fixtureTag,
				node.querySelector(".tool-group-summary")?.getAttribute("aria-expanded"),
				node.parentElement?.dataset.transcriptMessage,
			])).toEqual(["kept", "true", "tool:c1"]);
			// The card the reader expanded is the same element and still open.
			expect(await page.$eval('[data-fixture-card="opened"] details', node => (node as HTMLDetailsElement).open)).toBe(true);
		} finally { await closeComponentFixture(context, page); }
	}, 30000);

	test("card and group icons grow with the text size, and chevrons sit on their first text line", async () => {
		const { context, page } = await fixture([call("1:2", "a", "failed"), call("call:b", "b", "running")]);
		try {
			await page.click(".tool-group-summary");
			const measure = (size: number) => page.evaluate(size => {
				document.documentElement.style.setProperty("--text-size", `${size}px`);
				const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
				const center = (rect: DOMRect) => rect.top + rect.height / 2;
				const card = '[data-tool-status="failed"]';
				return {
					sizes: [
						`${card} summary > .disclosure-chevron`,
						`${card} .tool-call-icon`,
						`${card} .tool-call-status svg`,
						".tool-group-summary > .disclosure-chevron",
						".tool-group-failed svg",
					].map(selector => box(selector).width),
					// Distance between each chevron's center and its first text line's center.
					offsets: [
						center(box(`${card} summary > .disclosure-chevron`)) - center(box(`${card} .tool-call-verb`)),
						center(box(".tool-group-summary > .disclosure-chevron")) - center(box(".tool-group-count")),
					],
				};
			}, size);
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			const normal = await measure(14);
			const large = await measure(20);
			for (const [index, width] of large.sizes.entries()) expect(width / normal.sizes[index]!).toBeGreaterThan(1.35);
			for (const offset of [...normal.offsets, ...large.offsets]) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
		} finally { await closeComponentFixture(context, page); }
	}, 30000);

	test("a group stays collapsed through failures and new calls, shows the newest call, and opens only on request", async () => {
		const { context, page } = await fixture([call("1:2", "a", "done"), call("call:b", "b", "running")]);
		try {
			const summary = () => page.$eval(".tool-group-summary", node => [node.getAttribute("aria-expanded"), node.textContent?.replace(/\s+/g, " ").trim()]);
			expect(await summary()).toEqual(["false", "2 tool calls · 2 commands Running $ step b"]);
			expect(await page.$eval(".tool-run-items", node => (node as HTMLElement).hidden)).toBe(true);
			await set(page, [call("1:2", "a", "done"), call("2:3", "b", "failed"), call("call:c", "c", "waiting", "read")]);
			await page.waitForFunction(() => document.querySelector(".tool-group-summary")?.textContent?.includes("1 failed"));
			expect(await summary()).toEqual(["false", "3 tool calls · 2 commands, 1 read 1 failed Reading $ step c Waiting"]);
			expect(await loads(page)).toEqual([]);
			await page.click(".tool-group-summary");
			expect(await page.$eval(".tool-run-items", node => (node as HTMLElement).hidden)).toBe(false);
			await set(page, [call("1:2", "a", "done"), call("2:3", "b", "failed"), call("3:4", "c", "done", "read")]);
			await page.waitForSelector('[data-tool-family="read"][data-tool-status="done"]');
			expect(await page.$eval(".tool-group-summary", node => node.getAttribute("aria-expanded"))).toBe("true");
		} finally { await closeComponentFixture(context, page); }
	}, 30000);
});
