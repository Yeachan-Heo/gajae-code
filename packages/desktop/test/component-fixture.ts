import type { Browser, BrowserContext, Page } from "puppeteer-core";

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
