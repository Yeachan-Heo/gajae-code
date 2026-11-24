import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer-core";
import { THEME_IDS, THEME_STORAGE_KEY } from "../src/themes";
import { browserPath } from "./component-fixture";
import { startViteBrowser, VITE_BROWSER_SETUP_TIMEOUT_MS, type ViteBrowser } from "./vite-browser";
import { measureContrast } from "./fixtures/contrast";

const suite = browserPath ? describe : describe.skip;

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let vite: ViteBrowser | undefined;
let browser: Browser;

beforeAll(async () => {
	if (!browserPath) return;
	vite = await startViteBrowser(port);
	browser = vite.browser;
}, VITE_BROWSER_SETUP_TIMEOUT_MS);
afterAll(async () => {
	await vite?.close();
});

/** The showcase in one bundled theme, applied at startup from storage as the app does. */
async function showcase(page: Page, theme: string): Promise<void> {
	await page.evaluate((key, id) => localStorage.setItem(key, id), THEME_STORAGE_KEY, theme);
	await page.reload();
	await page.waitForFunction(id => document.documentElement.dataset.theme === id, {}, theme);
	await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
}

suite("Session work visuals", () => {
	test("the task-progress chip reads at 4.5:1 or better, pressed or not, in every bundled theme", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			const failures: string[] = [];
			for (const theme of THEME_IDS) {
				await showcase(page, theme);
				await page.waitForSelector("#showcase-todo-chip .session-work-progress");
				// Name each chip by its row's caption, then open the finished list's card too.
				await page.$$eval("#showcase-todo-chip .showcase-todo-toolbar", rows => {
					for (const row of rows) {
						const chip = row.querySelector(".session-work-progress");
						const caption = row.querySelector(".toolbar-title small")?.textContent;
						if (chip && caption) chip.setAttribute("data-chip", caption);
					}
				});
				const check = async (state: string, selectors: string[]) => {
					for (const sample of await page.evaluate(measureContrast, selectors))
						if (sample.ratio < 4.5) failures.push(`${theme} · ${state} · ${sample.selector}: ${sample.ratio}`);
				};
				await page.mouse.move(1, 1);
				await check("closed", ['[data-chip="None done"]', '[data-chip="Some done"]', '[data-chip="All done"]']);
				await page.click('#showcase-todo-chip .session-work-toggle:has([data-chip="All done"])');
				await page.waitForSelector(
					'#showcase-todo-chip .session-work-toggle[aria-pressed="true"]:has([data-chip="All done"])',
				);
				await page.mouse.move(1, 1);
				await check("card open", ['[data-chip="Some done · card open"]', '[data-chip="All done"]']);
			}
			expect(failures).toEqual([]);
		} finally {
			await context.close();
		}
	}, 60000);

	test("the Session work showcase has a heading, an index link and a visibly selected state", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-session-work .session-work-panel");
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			await page.mouse.move(1, 1);
			expect(await page.$eval("#showcase-session-work > h2", node => node.textContent)).toBeTruthy();
			expect(await page.$('.showcase-index a[href="#showcase-session-work"]')).not.toBeNull();
			const look = (pressed: boolean) =>
				page.$eval(`#showcase-session-work .actions[role=group] button[aria-pressed="${pressed}"]`, node => {
					const style = getComputedStyle(node);
					return { background: style.backgroundColor, border: style.borderTopColor };
				});
			const selected = await look(true);
			const other = await look(false);
			expect(selected.background).not.toBe(other.background);
			expect(selected.border).not.toBe(other.border);
			const [contrast] = await page.evaluate(measureContrast, [
				'#showcase-session-work .actions[role=group] button[aria-pressed="true"]',
			]);
			expect(contrast!.ratio).toBeGreaterThanOrEqual(4.5);
		} finally {
			await context.close();
		}
	}, 30000);

	test("tool-row, dialog close, provider Back and toolbar icons grow with the text; nothing moves at the default size", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-todo-chip .session-work-toggle");
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			// A provider detail (for Back), and the native Providers dialog (for its close button).
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>("#showcase-providers > .actions button")]
					.find(button => button.textContent === "Both methods")
					?.click(),
			);
			await page.waitForSelector("#showcase-providers .provider-back");
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>("#showcase-providers > .actions button")]
					.find(button => button.textContent === "Open in a native dialog")
					?.click(),
			);
			await page.waitForSelector("dialog[open] .modal-close");
			const sizes = (px: number) =>
				page.evaluate(size => {
					document.documentElement.style.setProperty("--text-size", `${size}px`);
					const box = (selector: string) => {
						const rect = document.querySelector(selector)!.getBoundingClientRect();
						return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
					};
					return {
						legacyChevron: box("#showcase-tool-call-legacy .tool-disclosure > summary > .disclosure-chevron"),
						toolbarIcon: box("#showcase-todo-chip .session-work-toggle > svg"),
						backChevron: box("#showcase-providers .provider-back > svg"),
						closeIcon: box("dialog[open] .modal-close > svg"),
						closeButton: box("dialog[open] .modal-close"),
						// Other users of the shared icon rule, which keep their size.
						bannerIcon: box("#showcase-feedback .error-banner > svg"),
						composerIcon: box("#showcase-composers .composer-action > svg"),
						// Icons inside a tool disclosure that keep their own sizes over the moved rule.
						todoTaskIcon: box("#showcase-todo-tool .tool-disclosure .todo-task > svg"),
						toolStatusIcon: box("#showcase-tool-calls .tool-call .tool-call-status svg"),
					};
				}, px);
			expect(await sizes(14)).toEqual({
				legacyChevron: "16x16",
				toolbarIcon: "16x16",
				backChevron: "16x16",
				closeIcon: "16x16",
				closeButton: "34x34",
				bannerIcon: "16x16",
				composerIcon: "16x16",
				todoTaskIcon: "14x14",
				toolStatusIcon: "14x14",
			});
			// 1rem and 2.125rem at 20 px text, whose root is 20 / 0.875 = 22.86 px (whole pixels, as layout rounds).
			expect(await sizes(20)).toEqual({
				legacyChevron: "23x23",
				toolbarIcon: "23x23",
				backChevron: "23x23",
				closeIcon: "23x23",
				closeButton: "49x49",
				bannerIcon: "16x16",
				composerIcon: "16x16",
				todoTaskIcon: "14x14",
				toolStatusIcon: "20x20",
			});
		} finally {
			await context.close();
		}
	}, 30000);

	test("the Identity disclosure shows only the app's chevron, turned when open", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			const summary = "#showcase-session-work .activity-details > summary";
			await page.waitForSelector(summary);
			const disclosure = () =>
				page.$eval(summary, node => {
					const chevron = node.querySelector(".disclosure-chevron")!;
					const style = getComputedStyle(node);
					// Any browser marker would take room before the chevron, which is the summary's first child.
					return {
						chevronFirst:
							chevron.getBoundingClientRect().left <=
							node.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft) + 0.5,
						turned: getComputedStyle(chevron).transform !== "none",
					};
				});
			expect(await disclosure()).toEqual({ chevronFirst: true, turned: false });
			await page.click(summary);
			await page.waitForSelector("#showcase-session-work .activity-details[open]");
			expect(await disclosure()).toEqual({ chevronFirst: true, turned: true });
		} finally {
			await context.close();
		}
	}, 30000);
});
