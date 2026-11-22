import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { THEME_IDS, THEME_STORAGE_KEY } from "../src/themes";
import { browserPath } from "./component-fixture";
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
