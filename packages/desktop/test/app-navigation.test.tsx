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
	test("keeps projects and status-only conversations usable in a persistent compact rail", async () => {
		const { context, page } = await fixture();
		try {
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			expect(await page.$$eval('.desktop-sidebar .project-initials', nodes => nodes.map(node => node.textContent))).toEqual(["pa", "한글"]);
			expect(await page.$eval('.desktop-sidebar', node => node.getBoundingClientRect().width)).toBe(64);
			expect(await page.$$eval('.desktop-sidebar .session-title', nodes => nodes.every(node => getComputedStyle(node).display === "none"))).toBe(true);
			expect(await page.$$eval('.desktop-sidebar .session-state', nodes => nodes.filter(node => node.getBoundingClientRect().width > 0).length)).toBe(4);
			const newest = '.desktop-sidebar .session-select[title="Newest conversation · Done"]';
			await page.click(newest);
			await page.waitForSelector(`${newest}[aria-current="page"]`);
			expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.select").at(-1)?.params)).toEqual({ sessionId: "new" });
			await page.reload();
			await page.waitForSelector('.desktop-sidebar[data-compact] .session-row');
			expect(await page.$eval('.sidebar-toggle', node => node.getAttribute("aria-expanded"))).toBe("false");
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForFunction(() => !document.querySelector('.desktop-sidebar[data-compact]'));
			expect(await page.$eval('.desktop-sidebar', node => node.getBoundingClientRect().width)).toBe(264);
			expect(await page.$$eval('.desktop-sidebar .session-title', nodes => nodes.every(node => node.getBoundingClientRect().width > 0))).toBe(true);
		} finally { await context.close(); }
	}, 30000);

	test("a desktop compact preference never makes the mobile project drawer icon-only", async () => {
		const { context, page } = await fixture();
		try {
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.setViewport({ width: 700, height: 800 });
			await page.click('.toolbar .mobile-only');
			await page.waitForSelector('dialog.sidebar-drawer');
			expect(await page.$eval('dialog.sidebar-drawer .session-title', node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
			expect(await page.$eval('dialog.sidebar-drawer .project-initials', node => getComputedStyle(node).display)).toBe("none");
			expect(await page.$eval('dialog.sidebar-drawer .sidebar-toggle', node => getComputedStyle(node).display)).toBe("none");
		} finally { await context.close(); }
	}, 30000);

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
