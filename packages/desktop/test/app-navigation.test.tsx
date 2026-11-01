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

	test("puts new conversations first without shuffling the list on status updates", async () => {
		const { context, page } = await fixture();
		try {
			const titles = () => page.$$eval('.project-group:first-child .session-title', nodes => nodes.map(node => node.textContent));
			expect(await titles()).toEqual(["Newest conversation", "Middle conversation", "Oldest conversation"]);
			await page.evaluate(() => {
				const old = window.navigationFixture.snapshot().sessions[0]!;
				window.navigationFixture.emit({ type: "session", session: { ...old, status: "running" } });
			});
			expect(await titles()).toEqual(["Newest conversation", "Middle conversation", "Oldest conversation"]);
			await page.evaluate(() => {
				const old = window.navigationFixture.snapshot().sessions[0]!;
				window.navigationFixture.emit({ type: "session", session: { ...old, id: "latest", title: "Just created" } });
			});
			await page.waitForFunction(() => document.querySelector('.project-group:first-child .session-title')?.textContent === "Just created");
			expect(await titles()).toEqual(["Just created", "Newest conversation", "Middle conversation", "Oldest conversation"]);
			await page.click('.project-group:first-child .session-select', { button: "right" });
			await page.waitForSelector('.context-menu');
			expect(await page.$eval('.context-menu', node => node.textContent)).not.toContain("Move conversation");
		} finally { await context.close(); }
	}, 30000);

	test("paginates newest first and retains a selected older conversation", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => {
				const snapshot = window.navigationFixture.snapshot();
				const template = snapshot.sessions[0]!;
				const sessions = Array.from({ length: 12 }, (_, i) => ({ ...template, id: `s${i}`, title: `Conversation ${i}` }));
				window.navigationFixture.emit({ type: "snapshot", snapshot: { ...snapshot, sessions } });
			});
			await page.waitForFunction(() => document.querySelector('.session-title')?.textContent === "Conversation 11");
			const titles = () => page.$$eval('.project-group:first-child .session-title', nodes => nodes.map(node => node.textContent));
			expect(await titles()).toEqual([11, 10, 9, 8, 7].map(i => `Conversation ${i}`));
			await page.click('.show-more');
			expect(await titles()).toHaveLength(10);
			await page.click('.show-more');
			expect(await titles()).toHaveLength(12);
			await page.click('.session-select[title="Conversation 0 · Idle"]');
			await page.evaluate(() => {
				const snapshot = window.navigationFixture.snapshot();
				window.navigationFixture.emit({ type: "session", session: { ...snapshot.sessions[0]!, id: "s12", title: "Conversation 12" } });
			});
			await page.waitForFunction(() => document.querySelector('.session-title')?.textContent === "Conversation 12");
			expect(await titles()).toHaveLength(13);
			expect(await page.$('.session-select[title="Conversation 0 · Idle"][aria-current="page"]')).not.toBeNull();
		} finally { await context.close(); }
	}, 30000);

	test("show more advances past the effective page expanded by a selected older row", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => {
				const snapshot = window.navigationFixture.snapshot();
				const sessions = Array.from({ length: 12 }, (_, i) => ({ ...snapshot.sessions[0]!, id: `s${i}`, title: `Conversation ${i}` }));
				window.navigationFixture.emit({ type: "snapshot", snapshot: { ...snapshot, sessions } });
			});
			await page.waitForFunction(() => document.querySelector('.session-title')?.textContent === "Conversation 11");
			await page.click('.session-select[title="Conversation 7 · Idle"]');
			await page.evaluate(() => {
				const template = window.navigationFixture.snapshot().sessions[0]!;
				for (let i = 12; i < 17; i++) window.navigationFixture.emit({ type: "session", session: { ...template, id: `s${i}`, title: `Conversation ${i}` } });
			});
			await page.waitForFunction(() => document.querySelectorAll('.session-row').length === 10);
			await page.click('.show-more');
			await page.waitForFunction(() => document.querySelectorAll('.session-row').length === 15);
			expect(await page.$('.session-select[title="Conversation 7 · Idle"][aria-current="page"]')).not.toBeNull();
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
