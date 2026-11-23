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
		recoveryTest: { discards: string[]; copies?: string[]; theme(id: string): void };
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

/** The real Delete dialog in a native Modal with the given unsent texts; the clipboard accepts. */
async function deleteDialog(texts: string[], viewport = { width: 1000, height: 900 }) {
	const { context, page } = await componentFixture(browser, origin);
	try {
		await page.setViewport(viewport);
		await componentReady(page, async () => {
			await page.addScriptTag({
				type: "module",
				content: `
					import '/src/styles.css';
					import React from '/node_modules/.vite/deps/react.js';
					import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
					import { Modal } from '/src/components.tsx';
					import { DeleteConversationConfirmation } from '/src/RecoveryConversation.tsx';
					import { applyTheme } from '/src/themes.ts';
					const h = React.createElement;
					const copies = [];
					window.recoveryTest = { discards: [], copies, theme: applyTheme };
					const root = document.createElement('div');
					document.body.replaceChildren(root);
					ReactDOM.createRoot(root).render(h(Modal, { title: 'Delete conversation', onClose: () => {} },
						h(DeleteConversationConfirmation, { title: 'Fix the flaky test', texts: ${JSON.stringify(texts)}, disabled: false,
							onDelete: () => {}, writer: text => { copies.push(text); return Promise.resolve(); } })));
				`,
			});
			await page.waitForSelector("dialog[open] .delete-confirmation");
		});
		await page.addStyleTag({ url: `${origin}/src/styles.css` });
		await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

suite("Delete conversation dialog", () => {
	test("its irreversible warning reads at 4.5:1 or better in every bundled theme", async () => {
		const { context, page } = await deleteDialog([]);
		try {
			const failures: string[] = [];
			for (const theme of THEME_IDS) {
				await page.evaluate(id => window.recoveryTest.theme(id), theme);
				const [sample] = await page.evaluate(measureContrast, ["dialog[open] .delete-warning strong"]);
				if (sample!.ratio < 4.5) failures.push(`${theme}: ${sample!.ratio}`);
			}
			expect(failures).toEqual([]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("several unsent messages stay separate: each its own numbered, selectable item, copied with clear boundaries", async () => {
		const texts = ["First paragraph.\n\nSecond paragraph of the same message.", "Second message", "Third message"];
		const { context, page } = await deleteDialog(texts);
		try {
			const items = await page.$$eval("dialog[open] .delete-recoveries li", nodes =>
				nodes.map(node => ({
					number: node.querySelector(".delete-recovery-number")?.textContent ?? null,
					text: node.querySelector(".recovery-text")?.textContent ?? null,
					selectable: getComputedStyle(node.querySelector(".recovery-text")!).userSelect,
				})),
			);
			expect(items).toEqual(
				texts.map((text, index) => ({ number: `Message ${index + 1} of 3`, text, selectable: "text" })),
			);
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>("dialog[open] .delete-recoveries button")]
					.find(button => button.textContent === "Copy all text")
					?.click(),
			);
			await page.waitForSelector("dialog[open] .recovery-copy-status");
			expect(await page.evaluate(() => window.recoveryTest.copies)).toEqual([
				[
					"--- Message 1 of 3 ---",
					texts[0],
					"",
					"--- Message 2 of 3 ---",
					texts[1],
					"",
					"--- Message 3 of 3 ---",
					texts[2],
				].join("\n"),
			]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a single unsent message is shown and copied as it is, without a number", async () => {
		const { context, page } = await deleteDialog(["Only message\n  indented line"]);
		try {
			expect(await page.$("dialog[open] .delete-recovery-number")).toBeNull();
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>("dialog[open] .delete-recoveries button")]
					.find(button => button.textContent === "Copy text")
					?.click(),
			);
			await page.waitForSelector("dialog[open] .recovery-copy-status");
			expect(await page.evaluate(() => window.recoveryTest.copies)).toEqual(["Only message\n  indented line"]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);
});

suite("Recovery card showcase", () => {
	test("three stacked cards keep their gutter, edges and actions inside them at 390 px and with 20 px text", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 390, height: 844 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector(".showcase-recovery-column .recovery-card");
			for (const size of [14, 20]) {
				await page.evaluate(px => document.documentElement.style.setProperty("--text-size", `${px}px`), size);
				const cards = await page.$$eval(".showcase-recovery-column > .recovery-card", nodes => {
					const column = nodes[0]!.parentElement!.getBoundingClientRect();
					return nodes.map(card => {
						const box = card.getBoundingClientRect();
						return {
							gutter: box.left - column.left >= 15.5 && column.right - box.right >= 15.5,
							inside: [...card.querySelectorAll("button")].every(button => {
								const rect = button.getBoundingClientRect();
								return rect.left >= box.left && rect.right <= box.right && rect.bottom <= box.bottom;
							}),
							overflow: card.scrollWidth > card.clientWidth,
						};
					});
				});
				expect({ size, cards }).toEqual({
					size,
					cards: Array.from({ length: 3 }, () => ({ gutter: true, inside: true, overflow: false })),
				});
			}
		} finally {
			await context.close();
		}
	}, 30000);

	test("the showcase opens every Delete dialog state in the real dialog, the refused copy included", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-delete-confirmation .delete-dialog-opener");
			expect(await page.$('.showcase-index a[href="#showcase-delete-confirmation"]')).not.toBeNull();
			const openers = await page.$$eval("#showcase-delete-confirmation .delete-dialog-opener", nodes => nodes.length);
			const seen: unknown[] = [];
			for (let index = 0; index < openers; index++) {
				await page.evaluate(
					position =>
						document.querySelectorAll<HTMLButtonElement>("#showcase-delete-confirmation .delete-dialog-opener")[
							position
						]!.click(),
					index,
				);
				await page.waitForSelector("dialog[open] .delete-confirmation");
				const caption = await page.evaluate(
					position =>
						document
							.querySelectorAll("#showcase-delete-confirmation .delete-dialog-opener")
							[position]!.closest(".showcase-todo-state")
							?.querySelector("h3")?.textContent,
					index,
				);
				if (caption?.startsWith("Copy refused")) {
					await page.evaluate(() =>
						[...document.querySelectorAll<HTMLButtonElement>("dialog[open] .delete-recoveries button")]
							.find(button => button.textContent === "Copy text")
							?.click(),
					);
					await page.waitForSelector("dialog[open] .recovery-copy-error");
				}
				seen.push(
					await page.$eval("dialog[open]", dialog => ({
						title: dialog.querySelector("header h2")?.textContent,
						warning: dialog.querySelector(".delete-recoveries > p")?.textContent?.split(".")[0] ?? null,
						refused: dialog.querySelector(".recovery-copy-error") !== null,
						deletes: [...dialog.querySelectorAll("button.danger")].map(button => button.textContent),
					})),
				);
				await page.keyboard.press("Escape");
				await page.waitForFunction(() => !document.querySelector("dialog[open]"));
			}
			const dialog = (warning: string | null, refused = false) => ({
				title: "Delete conversation",
				warning,
				refused,
				deletes: ["Delete conversation"],
			});
			expect(seen).toEqual([
				dialog(null),
				dialog("Deleting also discards 1 unsent message whose draft was never restored"),
				dialog("Deleting also discards 3 unsent messages whose drafts were never restored"),
				dialog("Deleting also discards 2 unsent messages whose drafts were never restored"),
				dialog("Deleting also discards 1 unsent message whose draft was never restored"),
				dialog("Deleting also discards 1 unsent message whose draft was never restored", true),
			]);
		} finally {
			await context.close();
		}
	}, 30000);
});
