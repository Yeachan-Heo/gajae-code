import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { THEME_IDS } from "../src/themes";
import { browserPath, closeComponentFixture, componentFixture, componentReady } from "./component-fixture";
import { measureContrast } from "./fixtures/contrast";

const suite = browserPath ? describe : describe.skip;

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	if (!browserPath) return;
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {
			/* Server is starting. */
		}
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
}, 30000);
afterAll(async () => {
	await browser?.close();
	if (server) {
		server.kill();
		await server.exited;
	}
});

declare global {
	interface Window {
		recoveryTest: { discards: string[]; theme(id: string): void };
	}
}

const SHORT = "Summarize the failing test output\n  keep this indentation";
const LONG = Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of a long unsent message`).join("\n");

/** Two orphan cards (short and long text) in a conversation column; the clipboard answers as told. */
async function fixture(clipboard: "accept" | "refuse"): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	try {
		await page.setViewport({ width: 1000, height: 900 });
		await componentReady(page, async () => {
			await page.addScriptTag({
				type: "module",
				content: `
					import '/src/styles.css';
					import React from '/node_modules/.vite/deps/react.js';
					import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
					import { RecoveryCard } from '/src/RecoveryConversation.tsx';
					import { applyTheme } from '/src/themes.ts';
					const h = React.createElement;
					const discards = [];
					window.recoveryTest = { discards, theme: applyTheme };
					navigator.clipboard.write = ${clipboard === "accept" ? "() => Promise.resolve()" : "() => Promise.reject(new Error('denied'))"};
					const card = (id, text) => h(RecoveryCard, {
						key: id, notice: 'Delivery recovery: the outcome is unknown.', orphan: true, rememberedTitle: 'Old chat ' + id,
						current: false, text, onOpen: () => {}, discard: { label: 'Discard record', onClick: () => discards.push(id) },
					});
					const root = document.createElement('div');
					root.className = 'conversation-column';
					root.id = 'recovery-fixture';
					document.body.replaceChildren(root);
					ReactDOM.createRoot(root).render([card('short', ${JSON.stringify(SHORT)}), card('long', ${JSON.stringify(LONG)})]);
				`,
			});
			await page.waitForFunction(() => document.querySelectorAll(".recovery-card").length === 2);
		});
		await page.addStyleTag({ url: `${origin}/src/styles.css` });
		await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function copy(page: Page, card: number): Promise<void> {
	await page.evaluate(index => {
		const button = [...document.querySelectorAll(".recovery-card")[index]!.querySelectorAll("button")].find(
			node => node.textContent === "Copy text",
		);
		if (!button) throw new Error("Missing Copy text");
		button.click();
	}, card);
}

/** Visible means laid out with real size, not clipped away like screen-reader-only text. */
async function visible(page: Page, selector: string): Promise<boolean> {
	return page.$eval(selector, node => {
		const box = node.getBoundingClientRect();
		const style = getComputedStyle(node);
		return (
			node.checkVisibility() &&
			box.width > 8 &&
			box.height > 8 &&
			style.clip !== "rect(0px, 0px, 0px, 0px)" &&
			style.visibility === "visible"
		);
	});
}

suite("Recovery card", () => {
	test("an orphan shows its unsent text, selectable with its whitespace, and long text starts collapsed", async () => {
		const { context, page } = await fixture("accept");
		try {
			const text = await page.$$eval(".recovery-card", cards =>
				cards.map(card => {
					const block = card.querySelector<HTMLElement>(".recovery-text");
					const style = block ? getComputedStyle(block) : null;
					return {
						text: block?.textContent,
						shown: !!block && block.checkVisibility(),
						collapsed: card.querySelector("details.recovery-text-disclosure:not([open])") !== null,
						userSelect: style?.userSelect,
						whiteSpace: style?.whiteSpace,
						// The full text is not part of the card's live region.
						announced: card.querySelector("[role=status]")?.contains(block ?? null) ?? false,
					};
				}),
			);
			expect(text).toEqual([
				{ text: SHORT, shown: true, collapsed: false, userSelect: "text", whiteSpace: "pre-wrap", announced: false },
				{ text: LONG, shown: false, collapsed: true, userSelect: "text", whiteSpace: "pre-wrap", announced: false },
			]);
			// A long text is bounded and scrolls inside its block.
			await page.click(".recovery-text-disclosure > summary");
			expect(
				await page.$eval(".recovery-text-disclosure .recovery-text", node => node.scrollHeight > node.clientHeight),
			).toBe(true);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a successful copy says so visibly", async () => {
		const { context, page } = await fixture("accept");
		try {
			await copy(page, 0);
			await page.waitForSelector(".recovery-card .recovery-copy-status");
			expect(await page.$eval(".recovery-card .recovery-copy-status", node => node.textContent)).toBe("Text copied.");
			expect(await visible(page, ".recovery-card .recovery-copy-status")).toBe(true);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a refused copy looks like an error in every theme, opens the text and never discards it", async () => {
		const { context, page } = await fixture("refuse");
		try {
			await copy(page, 1);
			await page.waitForSelector(".recovery-card .recovery-copy-error[role=alert]");
			expect(await visible(page, ".recovery-card .recovery-copy-error")).toBe(true);
			// The long text is now open, so it can be selected and copied by hand.
			expect(await page.$eval(".recovery-card:nth-child(2) details.recovery-text-disclosure", node => node.open)).toBe(
				true,
			);
			expect(await visible(page, ".recovery-card:nth-child(2) .recovery-text")).toBe(true);
			const colors = await page.$eval(".recovery-card:nth-child(2)", card => ({
				error: getComputedStyle(card.querySelector(".recovery-copy-error")!).color,
				prose: getComputedStyle(card.querySelector(".recovery-conversation-hint")!).color,
			}));
			expect(colors.error).not.toBe(colors.prose);
			const failures: string[] = [];
			for (const theme of THEME_IDS) {
				await page.evaluate(id => window.recoveryTest.theme(id), theme);
				const [sample] = await page.evaluate(measureContrast, [".recovery-card .recovery-copy-error"]);
				if (sample!.ratio < 4.5) failures.push(`${theme}: ${sample!.ratio}`);
			}
			expect(failures).toEqual([]);
			expect(await page.$$(".recovery-card")).toHaveLength(2);
			expect(await page.evaluate(() => window.recoveryTest.discards)).toEqual([]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);
});
