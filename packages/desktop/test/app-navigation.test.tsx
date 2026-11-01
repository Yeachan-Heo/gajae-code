import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { installNavigationFixture } from "./fixtures/navigation";

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) break; } catch { /* Server is starting. */ }
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({
		executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
	});
}, 30000);
afterAll(async () => { await browser?.close(); if (server) { server.kill(); await server.exited; } });

async function fixture(holdBootstrap = false): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		await page.setViewport({ width: 1400, height: 900 });
		await page.evaluateOnNewDocument(installNavigationFixture, holdBootstrap);
		await page.goto(origin);
		await page.waitForFunction(() => window.navigationFixture.requests().some(request => request.method === "bootstrap"));
		if (!holdBootstrap) await page.waitForSelector(".session-row");
		return { context, page };
	} catch (error) { await context.close(); throw error; }
}

describe("mounted desktop navigation", () => {
	test("centers the connection state instead of flashing the conversation empty state", async () => {
		const { context, page } = await fixture(true);
		try {
			await page.waitForSelector(".connection-state");
			expect(await page.$eval(".connection-state", node => node.textContent?.trim())).toBe("Connecting to the host…");
			expect(await page.$(".main-pane > p[role=status]")).toBeNull();
			expect(await page.$(".main-pane .empty h2")).toBeNull();
			const centered = await page.$eval(".connection-state", node => {
				const box = node.getBoundingClientRect();
				const pane = node.closest(".main-pane")!.getBoundingClientRect();
				return { x: Math.abs((box.left + box.right - pane.left - pane.right) / 2), y: (box.top + box.bottom) / 2 - pane.top, height: pane.height };
			});
			expect(centered.x).toBeLessThan(2);
			expect(centered.y).toBeGreaterThan(centered.height * 0.4);
			expect(centered.y).toBeLessThan(centered.height * 0.65);
			await page.evaluate(() => window.navigationFixture.connect());
			await page.waitForSelector(".session-row");
			await page.waitForFunction(() => !document.querySelector(".connection-state"));
			expect(await page.$eval(".main-pane .empty h2", node => node.textContent)).toBe("Select a conversation or start a new one");
		} finally { await context.close(); }
	}, 30000);

	test("keeps a failed connection visible as an error, not a permanent spinner", async () => {
		const { context, page } = await fixture(true);
		try {
			await page.evaluate(() => window.navigationFixture.emit({ type: "fatal", error: "Host stopped" }));
			await page.waitForSelector(".main-pane .error-banner");
			expect(await page.$eval(".main-pane .error-banner", node => node.textContent)).toContain("Host stopped");
			expect(await page.$(".connection-state")).toBeNull();
		} finally { await context.close(); }
	}, 30000);
});
