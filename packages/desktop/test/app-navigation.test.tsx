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

async function threeProjects(page: Page): Promise<void> {
	await page.evaluate(() => {
		const snapshot = window.navigationFixture.snapshot();
		window.navigationFixture.emit({ type: "snapshot", snapshot: { ...snapshot, projects: [...snapshot.projects, { id: "r", name: "Third workspace", path: "/work/third" }] } });
	});
	await page.waitForSelector('[data-project-id="r"]');
}

async function point(page: Page, selector: string, edge?: "before" | "after"): Promise<{ x: number; y: number }> {
	return page.$eval(selector, (node, edge) => {
		const box = node.getBoundingClientRect();
		return { x: box.left + box.width / 2, y: edge === "before" ? box.top + 8 : edge === "after" ? box.bottom - 8 : box.top + box.height / 2 };
	}, edge);
}

async function startProjectPointer(page: Page, from: string, to: string, edge: "before" | "after", scope = ".desktop-sidebar", handle = "h2"): Promise<void> {
	const start = await point(page, `${scope} [data-project-id="${from}"] ${handle}`);
	const target = await point(page, `${scope} [data-project-id="${to}"]`, edge);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(target.x, target.y, { steps: 12 });
}

async function projectOrder(page: Page): Promise<string[]> {
	return page.$$eval('.desktop-sidebar .project-group', nodes => nodes.map(node => (node as HTMLElement).dataset.projectId!));
}

async function reorderRequests(page: Page): Promise<unknown[]> {
	return page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "project.reorder").map(request => request.params));
}

describe("mounted desktop navigation", () => {
	for (const { from, to, edge, ids } of [
		{ from: "p", to: "r", edge: "before", ids: ["q", "p", "r"] },
		{ from: "p", to: "r", edge: "after", ids: ["q", "r", "p"] },
		{ from: "r", to: "p", edge: "before", ids: ["r", "p", "q"] },
		{ from: "r", to: "p", edge: "after", ids: ["p", "r", "q"] },
	] as const) {
		test(`pointer inserts ${from} ${edge} ${to} at the painted boundary`, async () => {
			const { context, page } = await fixture();
			try {
				await threeProjects(page);
				await startProjectPointer(page, from, to, edge);
				const selector = `.desktop-sidebar [data-project-id="${to}"].drop-${edge}`;
				await page.waitForSelector(selector);
				expect(await projectOrder(page)).toEqual(["p", "q", "r"]);
				expect(await reorderRequests(page)).toEqual([]);
				const line = await page.$eval(selector, node => {
					const style = getComputedStyle(node, "::after");
					return { content: style.content, height: style.height, color: style.backgroundColor, top: style.top, bottom: style.bottom };
				});
				expect(line.content).toBe('""');
				expect(line.height).toBe("3px");
				expect(line.color).not.toBe("rgba(0, 0, 0, 0)");
				expect(line[edge === "before" ? "top" : "bottom"]).toBe("-4px");
				await page.mouse.up();
				await page.waitForFunction(ids => [...document.querySelectorAll('.desktop-sidebar .project-group')].map(node => (node as HTMLElement).dataset.projectId).join() === ids.join(), {}, ids);
				expect(await reorderRequests(page)).toEqual([{ ids: [...ids] }]);
				expect(await page.$('.dragging, .drop-target')).toBeNull();
			} finally { await context.close(); }
		}, 30000);
	}

	test("compact initials drag without collapsing or creating a conversation; ordinary clicks retain focus", async () => {
		const { context, page } = await fixture();
		try {
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			await startProjectPointer(page, "p", "q", "after", ".desktop-sidebar", ".project-toggle");
			await page.waitForSelector('[data-project-id="q"].drop-after');
			await page.mouse.up();
			await page.waitForFunction(() => window.navigationFixture.requests().some(request => request.method === "project.reorder"));
			expect(await page.$eval('[data-project-id="p"] .project-toggle', node => node.getAttribute("aria-expanded"))).toBe("true");
			expect(await page.$eval('.desktop-sidebar', node => node.getBoundingClientRect().width)).toBe(64);
			expect(await page.evaluate(() => window.navigationFixture.requests().some(request => request.method === "session.create"))).toBe(false);
			const toggle = '.desktop-sidebar [data-project-id="p"] .project-toggle';
			await page.click(toggle);
			expect(await page.$eval(toggle, node => node === document.activeElement && node.getAttribute("aria-expanded") === "false")).toBe(true);
			await page.keyboard.press("Enter");
			expect(await page.$eval(toggle, node => node.getAttribute("aria-expanded"))).toBe("true");
		} finally { await context.close(); }
	}, 30000);

	for (const cancel of ["Escape", "pointercancel", "lostcapture", "catalog"] as const) {
		test(`${cancel} cancels a captured pointer without reordering or leaking a click`, async () => {
			const { context, page } = await fixture();
			try {
				await startProjectPointer(page, "p", "q", "after", ".desktop-sidebar", ".project-toggle");
				await page.waitForSelector('.drop-after');
				if (cancel === "Escape") await page.keyboard.press("Escape");
				else await page.evaluate(cancel => {
					const heading = document.querySelector<HTMLElement>('.desktop-sidebar [data-project-id="p"] .project-heading')!;
					if (cancel === "pointercancel") heading.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
					if (cancel === "lostcapture") heading.releasePointerCapture(1);
					if (cancel === "catalog") {
						const snapshot = window.navigationFixture.snapshot();
						window.navigationFixture.emit({ type: "snapshot", snapshot: { ...snapshot, projects: snapshot.projects.toReversed() } });
					}
				}, cancel);
				if (cancel === "lostcapture") {
					const target = await point(page, '.desktop-sidebar [data-project-id="q"]', "after");
					await page.mouse.move(target.x, target.y + 1);
				}
				await page.waitForFunction(() => !document.querySelector('.dragging, .drop-target'));
				await page.mouse.up();
				expect(await reorderRequests(page)).toEqual([]);
				expect(await page.$eval('[data-project-id="p"] .project-toggle', node => node.getAttribute("aria-expanded"))).toBe("true");
			} finally { await context.close(); }
		}, 30000);
	}

	test("the pointer can cross a target midpoint and leave the navigation without a stale drop", async () => {
		const { context, page } = await fixture();
		try {
			await threeProjects(page);
			await startProjectPointer(page, "p", "r", "before");
			await page.waitForSelector('[data-project-id="r"].drop-before');
			const after = await point(page, '.desktop-sidebar [data-project-id="r"]', "after");
			await page.mouse.move(after.x, after.y);
			await page.waitForSelector('[data-project-id="r"].drop-after');
			await page.mouse.move(500, after.y);
			await page.waitForFunction(() => !document.querySelector('.drop-target'));
			await page.mouse.up();
			expect(await reorderRequests(page)).toEqual([]);
		} finally { await context.close(); }
	}, 30000);

	test("keyboard workspace moves and new-conversation clicks remain independent of dragging", async () => {
		const { context, page } = await fixture();
		try {
			await page.focus('.desktop-sidebar [data-project-id="p"] .project-heading');
			await page.keyboard.down("Shift");
			await page.keyboard.press("F10");
			await page.keyboard.up("Shift");
			await page.waitForSelector('.context-menu');
			expect(await page.$$eval('.context-menu [role="menuitem"]', nodes => nodes.slice(0, 2).map(node => (node as HTMLButtonElement).disabled))).toEqual([true, false]);
			await page.keyboard.press("Tab");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => window.navigationFixture.requests().some(request => request.method === "project.reorder"));
			expect(await reorderRequests(page)).toEqual([{ ids: ["q", "p"] }]);
			const create = '.desktop-sidebar [data-project-id="p"] .project-heading > button:not(.project-toggle)';
			const start = await point(page, create);
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(start.x, start.y + 30, { steps: 5 });
			await page.mouse.up();
			expect(await page.$('.dragging, .drop-target')).toBeNull();
			expect(await reorderRequests(page)).toHaveLength(1);
			await page.click(create);
			await page.waitForFunction(() => window.navigationFixture.requests().some(request => request.method === "session.create"));
			expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.create").at(-1)?.params)).toEqual({ projectId: "p" });
		} finally { await context.close(); }
	}, 30000);

	test("pending and rejected reorders retain the catalog order and can be retried", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => window.navigationFixture.holdProjectReorder(true));
			await startProjectPointer(page, "p", "q", "after");
			await page.mouse.up();
			await page.waitForSelector('.sidebar-open-project[disabled]');
			expect(await projectOrder(page)).toEqual(["p", "q"]);
			await startProjectPointer(page, "p", "q", "after");
			await page.mouse.up();
			expect(await reorderRequests(page)).toHaveLength(1);
			expect(await page.$('.dragging, .drop-target')).toBeNull();
			await page.evaluate(() => window.navigationFixture.resolveProjectReorder(false));
			await page.waitForSelector('.sidebar-open-project:not([disabled])');
			expect(await page.$eval('.main-pane .error-banner', node => node.textContent)).toContain("Reorder refused");
			expect(await projectOrder(page)).toEqual(["p", "q"]);
			await page.evaluate(() => window.navigationFixture.holdProjectReorder(false));
			await startProjectPointer(page, "p", "q", "after");
			await page.mouse.up();
			await page.waitForFunction(() => window.navigationFixture.snapshot().projects[0]?.id === "q");
			expect(await reorderRequests(page)).toHaveLength(2);
		} finally { await context.close(); }
	}, 30000);

	test("disconnect cancels an active drag and blocks subsequent gestures", async () => {
		const { context, page } = await fixture();
		try {
			await startProjectPointer(page, "p", "q", "after");
			await page.waitForSelector('.drop-after');
			await page.evaluate(() => window.navigationFixture.emit({ type: "fatal", error: "Host stopped" }));
			await page.waitForFunction(() => !document.querySelector('.dragging, .drop-target'));
			await page.mouse.up();
			await startProjectPointer(page, "p", "q", "after");
			await page.mouse.up();
			expect(await reorderRequests(page)).toEqual([]);
		} finally { await context.close(); }
	}, 30000);

	test("mobile drawer supports project insertion and cancels on drawer removal", async () => {
		const { context, page } = await fixture();
		try {
			await page.setViewport({ width: 700, height: 800 });
			await page.click('.toolbar .mobile-only');
			await page.waitForSelector('dialog.sidebar-drawer');
			await startProjectPointer(page, "p", "q", "after", "dialog.sidebar-drawer");
			await page.waitForSelector('dialog.sidebar-drawer .drop-after');
			await page.evaluate(() => document.querySelector<HTMLButtonElement>('dialog.sidebar-drawer .modal-close')!.click());
			await page.waitForFunction(() => !document.querySelector('dialog.sidebar-drawer'));
			await page.mouse.up();
			expect(await reorderRequests(page)).toEqual([]);
			await page.click('.toolbar .mobile-only');
			await page.waitForSelector('dialog.sidebar-drawer');
			await startProjectPointer(page, "p", "q", "after", "dialog.sidebar-drawer");
			await page.mouse.up();
			await page.waitForFunction(() => window.navigationFixture.requests().some(request => request.method === "project.reorder"));
			expect(await reorderRequests(page)).toEqual([{ ids: ["q", "p"] }]);
		} finally { await context.close(); }
	}, 30000);

	test("session drags, subthreshold presses and same-boundary gestures do not reorder", async () => {
		const { context, page } = await fixture();
		try {
			const session = await point(page, '.desktop-sidebar .session-select');
			await page.mouse.move(session.x, session.y);
			await page.mouse.down();
			await page.mouse.move(session.x, session.y + 60, { steps: 6 });
			await page.mouse.up();
			const heading = await point(page, '.desktop-sidebar .project-heading h2');
			await page.mouse.move(heading.x, heading.y);
			await page.mouse.down();
			await page.mouse.move(heading.x + 3, heading.y);
			await page.mouse.up();
			await startProjectPointer(page, "p", "q", "before");
			await page.waitForSelector('.drop-before');
			await page.mouse.up();
			expect(await reorderRequests(page)).toEqual([]);
			expect(await page.evaluate(() => window.navigationFixture.requests().some(request => request.method === "session.reorder"))).toBe(false);
			expect(await page.$('[draggable="true"]')).toBeNull();
		} finally { await context.close(); }
	}, 30000);

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
