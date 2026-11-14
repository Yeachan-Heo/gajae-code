import * as fs from "node:fs";
import type { Browser, BrowserContext, Page } from "puppeteer-core";

const BROWSER_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * Resolve the browser that drives the mounted-UI tests.
 *
 * `GJC_QA_CHROME` wins when set, and a set-but-missing override is a configuration
 * error rather than a silent skip. Otherwise probe the usual install locations so the
 * suite runs on macOS developer machines and on the Linux CI image, which ships Chrome.
 */
export function resolveBrowserPath(): string | undefined {
	const override = process.env.GJC_QA_CHROME;
	if (override) {
		if (!fs.existsSync(override)) {
			throw new Error(`GJC_QA_CHROME points at a missing browser: ${override}`);
		}
		return override;
	}
	return BROWSER_CANDIDATES.find(candidate => fs.existsSync(candidate));
}

/** The browser every mounted-UI suite drives; undefined means skip those suites. */
export const browserPath = resolveBrowserPath();

const failures = new WeakMap<Page, { error?: Error; promise: Promise<never> }>();

/** Load a same-origin document without mounting App or Showcase effects. */
export async function componentFixture(
	browser: Browser,
	origin: string,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		const failure = Promise.withResolvers<never>();
		const state: { error?: Error; promise: Promise<never> } = { promise: failure.promise };
		failures.set(page, state);
		void failure.promise.catch(() => {});
		page.on("pageerror", value => {
			const error = value instanceof Error ? value : new Error(String(value));
			state.error ??= error;
			failure.reject(error);
		});
		await page.goto(`${origin}/@vite/client`);
		await page.setContent("<div></div>");
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

export async function componentReady(page: Page, mount: () => Promise<void>): Promise<void> {
	const state = failures.get(page);
	if (!state) throw new Error("Component fixture does not own this page");
	await Promise.race([mount(), state.promise]);
}

export async function closeComponentFixture(context: BrowserContext, page: Page): Promise<void> {
	await context.close();
	const error = failures.get(page)?.error;
	if (error) throw new Error(`Component fixture page error: ${error.message}`, { cause: error });
}
