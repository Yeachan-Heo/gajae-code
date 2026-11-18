import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import type { DesktopMethod, DesktopRequest } from "@gajae-code/desktop-host/protocol";
import { browserPath } from "./component-fixture";
import { installNavigationFixture } from "./fixtures/navigation";

const suite = browserPath ? describe : describe.skip;

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	if (!browserPath) return;
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) break; } catch { /* Server is starting. */ }
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({
		executablePath: browserPath, headless: true,
	});
}, 30000);
afterAll(async () => { await browser?.close(); if (server) { server.kill(); await server.exited; } });

async function fixture(holdBootstrap = false, unmountable = false): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.createBrowserContext();
	const loadErrors: string[] = [];
	try {
		const page = await context.newPage();
		page.on("pageerror", error => loadErrors.push(String(error)));
		if (unmountable) {
			page.setDefaultTimeout(5_000);
			page.setDefaultNavigationTimeout(5_000);
		}
		await page.setViewport({ width: 1400, height: 900 });
		await page.evaluateOnNewDocument(installNavigationFixture, holdBootstrap);
		let interceptionError: unknown;
		if (unmountable) {
			await page.setRequestInterception(true);
			page.on("request", intercepted => {
				const url = new URL(intercepted.url());
				if (url.pathname !== "/src/App.tsx" || url.searchParams.has("navigation-original")) {
					void intercepted.continue();
					return;
				}
				void (async () => {
					const source = await (await fetch(intercepted.url())).text();
					const react = source.match(/from\s*["']([^"']*\/react\.js(?:\?[^"']*)?)["']/)?.[1];
					if (!react) throw new Error("Missing transformed React import for unmount fixture");
					await intercepted.respond({ status: 200, contentType: "application/javascript", body: `
						import App from "/src/App.tsx?navigation-original";
						import React from ${JSON.stringify(react)};
						const { createElement, useEffect, useState } = React;
						export default function NavigationMount() {
							const [mounted, setMounted] = useState(true);
							useEffect(() => {
								const unmount = () => setMounted(false);
								window.addEventListener("navigation-unmount", unmount);
								return () => window.removeEventListener("navigation-unmount", unmount);
							}, []);
							return mounted ? createElement(App) : null;
						}
					` });
				})().catch(error => {
					interceptionError = error;
					void intercepted.abort();
				});
			});
		}
		await page.goto(origin);
		if (interceptionError) throw interceptionError;
		await page.waitForFunction(() => window.navigationFixture.requests().some(request => request.method === "bootstrap"));
		if (!holdBootstrap) await page.waitForSelector(".session-row");
		return { context, page };
	} catch (error) {
		await context.close();
		if (loadErrors.length) throw new Error(`${String(error)}; browser module errors: ${loadErrors.join("; ")}`);
		throw error;
	}
}

async function holdRequest(page: Page, method: DesktopMethod): Promise<void> {
	await page.evaluate(method => {
		const transport = (window as unknown as {
			__TAURI_INTERNALS__: { invoke(command: string, args?: { request?: DesktopRequest }): Promise<unknown> };
		}).__TAURI_INTERNALS__;
		const invoke = transport.invoke.bind(transport);
		transport.invoke = (command, args) => {
			if (command === "engine_request" && args?.request?.method === method) {
				window.navigationFixture.requests().push(args.request);
				return Promise.resolve();
			}
			return invoke(command, args);
		};
	}, method);
}

async function heldRequest(page: Page, method: DesktopMethod, count = 1): Promise<DesktopRequest> {
	await page.waitForFunction((method, count) => window.navigationFixture.requests().filter(request => request.method === method).length === count, {}, method, count);
	const request = await page.evaluate(method => window.navigationFixture.requests().filter(request => request.method === method).at(-1), method);
	if (!request) throw new Error(`Missing held ${method}`);
	return request;
}

async function conversationAction(page: Page, label: string): Promise<void> {
	await page.click('button[aria-label="Conversation actions menu"]');
	await page.waitForSelector('dialog[open] [aria-label="Conversation actions"]');
	await page.evaluate(label => {
		const button = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Conversation actions"] button')]
			.find(button => button.textContent?.trim() === label);
		if (!button) throw new Error(`Missing conversation action ${label}`);
		button.click();
	}, label);
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

interface TranscriptReading {
	id: string;
	offset: number;
	top: number;
	count: number;
	bottom: number;
}

async function openTranscript(page: Page, id: string): Promise<void> {
	await page.evaluate(id => {
		const title = window.navigationFixture.snapshot().sessions.find(item => item.id === id)?.title;
		const button = [...document.querySelectorAll<HTMLButtonElement>(".session-select")]
			.find(item => item.querySelector(".session-title")?.textContent === title);
		if (!button) throw new Error(`Missing transcript ${id}`);
		button.click();
	}, id);
	await page.waitForFunction(id => {
		const title = window.navigationFixture.snapshot().sessions.find(item => item.id === id)?.title;
		return document.querySelector('.session-select[aria-current="page"] .session-title')?.textContent === title
			&& document.querySelector<HTMLElement>("[data-transcript-message]")?.dataset.transcriptMessage?.startsWith(`${id}-message-`);
	}, { polling: 20 }, id);
}

async function transcriptReading(page: Page): Promise<TranscriptReading> {
	return page.$eval(".conversation", node => {
		const top = node.getBoundingClientRect().top + node.clientTop;
		const messages = [...node.querySelectorAll<HTMLElement>("[data-transcript-message] > .message")];
		const first = messages.find(item => item.getBoundingClientRect().bottom > top);
		if (!first) throw new Error("No visible transcript anchor");
		return {
			id: first.parentElement!.dataset.transcriptMessage!,
			offset: first.getBoundingClientRect().top - top,
			top: node.scrollTop,
			count: messages.length,
			bottom: node.scrollHeight - node.clientHeight - node.scrollTop,
		};
	});
}

async function scrollTranscript(page: Page, top: number): Promise<TranscriptReading> {
	await page.$eval(".conversation", (node, top) => {
		node.scrollTop = top;
		// Deliver the user scroll before navigation, rather than relying on a browser frame race.
		node.dispatchEvent(new Event("scroll"));
	}, top);
	return transcriptReading(page);
}

async function expectTranscriptAnchor(page: Page, saved: TranscriptReading): Promise<void> {
	await page.waitForFunction(({ id, offset }) => {
		const node = document.querySelector(".conversation");
		const message = [...document.querySelectorAll<HTMLElement>("[data-transcript-message]")]
			.find(item => item.dataset.transcriptMessage === id)?.querySelector(".message");
		return node && message && Math.abs(message.getBoundingClientRect().top
			- node.getBoundingClientRect().top - node.clientTop - offset) < 1;
	}, { polling: 20 }, saved);
	const actual = await transcriptReading(page);
	expect(actual.id).toBe(saved.id);
	expect(Math.abs(actual.offset - saved.offset)).toBeLessThan(1);
}

async function seedTranscripts(page: Page, count = 240): Promise<void> {
	await page.evaluate(count => window.navigationFixture.seedTranscripts(count), count);
}

suite("mounted desktop navigation", () => {
	test("refreshes only current projects on focus, online and foreground events, not ordinary snapshots", async () => {
		const { context, page } = await fixture();
		try {
			await page.waitForSelector('.sidebar-open-project:not([disabled])');
			const refreshes = () => page.evaluate(() => window.navigationFixture.requests()
				.filter(request => request.method === "project.refresh").map(request => request.params.projectId));
			const baseline = await page.evaluate(() => window.navigationFixture.requests().length);
			expect(await refreshes()).toEqual([]);
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await heldRequest(page, "project.refresh", 2);
			expect(await refreshes()).toEqual(["p", "q"]);
			await page.evaluate(() => {
				const snapshot = window.navigationFixture.snapshot();
				window.navigationFixture.emit({ type: "snapshot", snapshot: {
					...snapshot,
					projects: [snapshot.projects[0]!, { id: "r", name: "Current workspace", path: "/work/current" }],
					sessions: snapshot.sessions.filter(session => session.projectId === "p"),
				} });
			});
			await page.waitForSelector('[data-project-id="r"]');
			expect(await refreshes()).toEqual(["p", "q"]);
			for (const event of ["focus", "online", "pageshow"]) {
				const count = (await refreshes()).length;
				await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
				await heldRequest(page, "project.refresh", count + 2);
				expect((await refreshes()).slice(-2)).toEqual(["p", "r"]);
			}
			await page.evaluate(() => {
				Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
				document.dispatchEvent(new Event("visibilitychange"));
			});
			expect(await refreshes()).toHaveLength(8);
			await page.evaluate(() => {
				Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
				document.dispatchEvent(new Event("visibilitychange"));
			});
			await heldRequest(page, "project.refresh", 10);
			expect((await refreshes()).slice(-2)).toEqual(["p", "r"]);
			await page.evaluate(() => {
				window.navigationFixture.emit({ type: "snapshot", snapshot: { ...window.navigationFixture.snapshot(), projects: [], sessions: [] } });
				// The host frame closes projects before React has rendered the new catalog.
				window.dispatchEvent(new Event("online"));
			});
			await page.waitForSelector('.project-group', { hidden: true });
			expect(await refreshes()).toHaveLength(10);
			expect(await page.evaluate(baseline => window.navigationFixture.requests().slice(baseline)
				.map(request => request.method), baseline)).toEqual(Array(10).fill("project.refresh"));
		} finally { await context.close(); }
	}, 30000);

	for (const kind of ["refreshed", "throttled"] as const) {
		test(`additive discovery preserves selection, draft, card and reading anchor despite a stale ${kind} response`, async () => {
			const { context, page } = await fixture();
			try {
				await seedTranscripts(page);
				await openTranscript(page, "old");
				await page.waitForSelector('.composer textarea:not([disabled])');
				await page.type('.composer textarea', "Keep this unsent discovery draft");
				await page.click('.session-work-toggle');
				await page.waitForSelector('.session-work-card');
				const saved = await scrollTranscript(page, 1423);
				const stale = await page.evaluate(() => window.navigationFixture.snapshot());
				await holdRequest(page, "project.refresh");
				await page.evaluate(() => window.dispatchEvent(new Event("online")));
				await heldRequest(page, "project.refresh", 2);
				await page.evaluate(() => {
					const snapshot = window.navigationFixture.snapshot();
					const template = snapshot.sessions.find(session => session.id === "old")!;
					window.navigationFixture.emit({ type: "snapshot", snapshot: {
						...snapshot,
						sessions: [...snapshot.sessions, { ...template, id: "discovered", title: "Discovered conversation", controlGeneration: null, messages: [] }],
					} });
				});
				await page.waitForSelector('.session-select[title="Discovered conversation · Idle"]');
				await page.evaluate(({ kind, stale }) => {
					const refreshes = window.navigationFixture.requests().filter(request => request.method === "project.refresh");
					for (const request of refreshes) window.navigationFixture.emit({ type: "response", id: request.id, ok: true,
						result: { kind, ...(kind === "throttled" ? { retryAfter: 30000 } : {}), snapshot: stale } });
				}, { kind, stale });
				await expectTranscriptAnchor(page, saved);
				expect(await page.$('.session-select[title="Discovered conversation · Idle"]')).not.toBeNull();
				expect(await page.$('.session-select[title="Oldest conversation · Idle"][aria-current="page"]')).not.toBeNull();
				expect(await page.$eval('.composer textarea', (node: HTMLTextAreaElement) => node.value)).toBe("Keep this unsent discovery draft");
				expect(await page.$('.session-work-toggle[aria-pressed="true"]')).not.toBeNull();
				expect(await page.$('.session-work-card')).not.toBeNull();
				expect(await page.evaluate(() => window.navigationFixture.requests()
					.filter(request => ["project.open", "session.connect", "session.admit", "prompt"].includes(request.method)))).toEqual([]);
			} finally { await context.close(); }
		}, 30000);
	}

	test("background discovery rejection leaves the host connected and never replays a draft", async () => {
		const { context, page } = await fixture();
		const errors: string[] = [];
		const warnings: string[] = [];
		page.on("pageerror", error => errors.push(String(error)));
		page.on("console", message => {
			if (message.type() === "warn") warnings.push(message.text());
		});
		try {
			await page.click('.session-select[title="Oldest conversation · Idle"]');
			await page.waitForSelector('.composer textarea:not([disabled])');
			await page.type('.composer textarea', "Do not replay this draft");
			await holdRequest(page, "project.refresh");
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await heldRequest(page, "project.refresh", 2);
			await page.evaluate(() => {
				for (const request of window.navigationFixture.requests().filter(request => request.method === "project.refresh"))
					window.navigationFixture.emit({ type: "response", id: request.id, ok: false, error: "Background discovery unavailable" });
			});
			await page.type('.composer textarea', " remains editable");
			expect(await page.$eval('.composer textarea', (node: HTMLTextAreaElement) => node.value)).toBe("Do not replay this draft remains editable");
			expect(await page.$('.sidebar-open-project:not([disabled])')).not.toBeNull();
			expect(await page.$('.main-pane .error-banner')).toBeNull();
			expect(await page.evaluate(() => window.navigationFixture.requests()
				.filter(request => ["project.open", "session.connect", "session.admit", "prompt"].includes(request.method)))).toEqual([]);
			expect(errors).toEqual([]);
			expect(warnings.filter(message => message.includes("Background project discovery refresh failed"))).toHaveLength(2);
			await page.evaluate(() => window.dispatchEvent(new Event("online")));
			await heldRequest(page, "project.refresh", 4);
		} finally { await context.close(); }
	}, 30000);

	test("does not refresh while bootstrap is disconnected or immediately after a fatal frame", async () => {
		const { context, page } = await fixture(true);
		try {
			const trigger = () => page.evaluate(() => {
				for (const event of ["focus", "online", "pageshow"]) window.dispatchEvent(new Event(event));
				document.dispatchEvent(new Event("visibilitychange"));
			});
			await trigger();
			expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "project.refresh"))).toEqual([]);
			await page.evaluate(() => window.navigationFixture.connect());
			await page.waitForSelector('.sidebar-open-project:not([disabled])');
			await page.evaluate(() => {
				window.navigationFixture.emit({ type: "fatal", error: "Host stopped" });
				// Fence the event synchronously, before React commits the fatal state.
				window.dispatchEvent(new Event("online"));
			});
			await page.waitForSelector('.main-pane .error-banner');
			await trigger();
			expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "project.refresh"))).toEqual([]);
		} finally { await context.close(); }
	}, 30000);

	test("keeps discovery listeners stable across snapshots and removes them when App unmounts", async () => {
		const { context, page } = await fixture(false, true);
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(String(error)));
		try {
			await page.waitForSelector('.sidebar-open-project:not([disabled])');
			const client = await page.createCDPSession();
			const listenerCounts = async () => {
				const counts: Record<string, number> = {};
				for (const target of ["window", "document"]) {
					const { result } = await client.send("Runtime.evaluate", { expression: target });
					const { listeners } = await client.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
					for (const event of target === "window" ? ["focus", "online", "pageshow"] : ["visibilitychange"])
						counts[`${target}:${event}`] = listeners.filter(listener => listener.type === event).length;
				}
				return counts;
			};
			const mounted = await listenerCounts();
			expect(mounted["window:online"]).toBe(1);
			await threeProjects(page);
			expect(await listenerCounts()).toEqual(mounted);
			await holdRequest(page, "project.refresh");
			await page.evaluate(() => window.dispatchEvent(new Event("online")));
			await heldRequest(page, "project.refresh", 3);
			await page.evaluate(() => window.dispatchEvent(new Event("navigation-unmount")));
			await page.waitForSelector('.app-shell', { hidden: true });
			await page.evaluate(() => {
				const frame = Promise.withResolvers<void>();
				requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()));
				return frame.promise;
			});
			const unmounted = await listenerCounts();
			for (const [event, count] of Object.entries(mounted)) expect(unmounted[event]).toBeLessThan(count);
			expect(unmounted["window:online"]).toBe(0);
			const before = await page.evaluate(() => window.navigationFixture.requests().length);
			await page.evaluate(() => {
				for (const request of window.navigationFixture.requests().filter(request => request.method === "project.refresh"))
					window.navigationFixture.emit({ type: "response", id: request.id, ok: false, error: "Late discovery failure" });
				for (const event of ["focus", "online", "pageshow"]) window.dispatchEvent(new Event(event));
				document.dispatchEvent(new Event("visibilitychange"));
			});
			expect(await page.evaluate(() => window.navigationFixture.requests().length)).toBe(before);
			expect(errors).toEqual([]);
			await client.detach();
		} finally { await context.close(); }
	}, 30000);

	test("restores a reading anchor across navigation, active streaming and background frames", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			expect((await transcriptReading(page)).bottom).toBeLessThan(1);
			const saved = await scrollTranscript(page, 1123);
			await openTranscript(page, "new");
			expect((await transcriptReading(page)).bottom).toBeLessThan(1);
			await openTranscript(page, "old");
			await expectTranscriptAnchor(page, saved);
			await page.evaluate(() => {
				const snapshot = window.navigationFixture.snapshot();
				const background = snapshot.sessions.find(item => item.id === "new")!;
				window.navigationFixture.emit({ type: "session", session: {
					...background, status: "running", messages: [...background.messages, { id: "background", role: "assistant", text: "Background output" }],
				} });
				// A whole-catalog frame may replace every message array without changing what A displays.
				window.navigationFixture.emit({ type: "snapshot", snapshot: {
					...window.navigationFixture.snapshot(), sessions: window.navigationFixture.snapshot().sessions.map(item => ({ ...item, messages: [...item.messages] })),
				} });
				const active = window.navigationFixture.snapshot().sessions.find(item => item.id === "old")!;
				window.navigationFixture.emit({ type: "session", session: {
					...active, messages: [...active.messages, { id: "streaming", role: "assistant", text: "A growing answer\n".repeat(30) }],
				} });
			});
			await page.waitForSelector('[data-transcript-message="streaming"]');
			await expectTranscriptAnchor(page, saved);
			// Following is also remembered: B still follows its bottom, including the output received away.
			await openTranscript(page, "new");
			expect((await transcriptReading(page)).bottom).toBeLessThan(1);
			await page.evaluate(() => {
				const active = window.navigationFixture.snapshot().sessions.find(item => item.id === "new")!;
				window.navigationFixture.emit({ type: "session", session: {
					...active, messages: [...active.messages, { id: "new-stream", role: "assistant", text: "Another answer\n".repeat(20) }],
				} });
			});
			await page.waitForSelector('[data-transcript-message="new-stream"]');
			expect((await transcriptReading(page)).bottom).toBeLessThan(1);
		} finally { await context.close(); }
	}, 30000);

	test("upward reading intent survives content growth before scroll delivery", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			const saved = await page.$eval(".conversation", node => {
				node.scrollTop -= 700;
				const messages = [...node.querySelectorAll<HTMLElement>("[data-transcript-message] > .message")];
				messages[messages.length - 1]!.style.minHeight = "2400px";
				const top = node.getBoundingClientRect().top + node.clientTop;
				const first = messages.find(item => item.getBoundingClientRect().bottom > top)!;
				const reading = {
					id: first.parentElement!.dataset.transcriptMessage!,
					offset: first.getBoundingClientRect().top - top,
					top: node.scrollTop,
					count: messages.length,
					bottom: node.scrollHeight - node.clientHeight - node.scrollTop,
				};
				node.dispatchEvent(new Event("scroll"));
				return reading;
			});
			await expectTranscriptAnchor(page, saved);
			await openTranscript(page, "new");
			await openTranscript(page, "old");
			await expectTranscriptAnchor(page, saved);
			expect((await transcriptReading(page)).bottom).toBeGreaterThan(100);
		} finally { await context.close(); }
	}, 30000);

	test("load earlier preserves the visible message and retains the expanded tail only for this mounted App", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			const before = await scrollTranscript(page, 0);
			for (const count of [200, 240]) {
				await page.$eval(".conversation > button", button => (button as HTMLButtonElement).click());
				await page.waitForFunction(count => document.querySelectorAll(".conversation .message").length === count, {}, count);
				// Prepending may expose a predecessor in the loader's former space; keep the original message fixed.
				await page.waitForFunction(({ id, offset }) => {
					const node = document.querySelector(".conversation");
					const message = [...document.querySelectorAll<HTMLElement>("[data-transcript-message]")]
						.find(item => item.dataset.transcriptMessage === id)?.querySelector(".message");
					if (!node || !message) return false;
					const top = node.getBoundingClientRect().top + node.clientTop;
					const rect = message.getBoundingClientRect();
					return Math.abs(rect.top - top - offset) < 1 && rect.bottom > top && rect.top < top + node.clientHeight;
				}, { polling: 20 }, before);
				const expanded = await transcriptReading(page);
				expect(expanded.top).toBeGreaterThan(before.top);
				expect(expanded.count).toBe(count);
			}
			const saved = await scrollTranscript(page, 743);
			await openTranscript(page, "new");
			expect((await transcriptReading(page)).count).toBe(100);
			await openTranscript(page, "old");
			await expectTranscriptAnchor(page, saved);
			expect((await transcriptReading(page)).count).toBe(240);
			// Reload creates a new App; no transcript reading state is serialized into browser storage.
			await page.reload();
			await page.waitForSelector(".session-row");
			await seedTranscripts(page);
			await openTranscript(page, "old");
			const reset = await transcriptReading(page);
			expect(reset.count).toBe(100);
			expect(reset.bottom).toBeLessThan(1);
		} finally { await context.close(); }
	}, 30000);

	test("a legitimate zero scroll top survives A to B to A", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			const saved = await scrollTranscript(page, 0);
			expect(saved.top).toBe(0);
			await openTranscript(page, "new");
			await openTranscript(page, "old");
			await expectTranscriptAnchor(page, saved);
			expect((await transcriptReading(page)).top).toBe(0);
		} finally { await context.close(); }
	}, 30000);

	test("keeps the earliest rendered reading anchor when streaming would push it out of the tail", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			const saved = await scrollTranscript(page, 0);
			await page.evaluate(() => {
				const active = window.navigationFixture.snapshot().sessions.find(item => item.id === "old")!;
				window.navigationFixture.emit({ type: "session", session: {
					...active, messages: [...active.messages, ...Array.from({ length: 5 }, (_, i) => ({ id: `append-${i}`, role: "user" as const, text: `New message ${i}` }))],
				} });
			});
			await page.waitForSelector('[data-transcript-message="append-4"]');
			await expectTranscriptAnchor(page, saved);
			expect((await transcriptReading(page)).count).toBe(105);
			await openTranscript(page, "new");
			await openTranscript(page, "old");
			await expectTranscriptAnchor(page, saved);
			expect((await transcriptReading(page)).count).toBe(105);
		} finally { await context.close(); }
	}, 30000);

	test("restores through temporary budgeted projections without forgetting the full transcript anchor", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			const saved = await scrollTranscript(page, 1723);
			const full = await page.evaluate(() => window.navigationFixture.snapshot().sessions.find(item => item.id === "old")!);
			await openTranscript(page, "new");
			await page.evaluate(full => window.navigationFixture.emit({ type: "session", session: { ...full, messages: full.messages.slice(-4), historyTruncated: true } }), full);
			await openTranscript(page, "old");
			expect((await transcriptReading(page)).count).toBe(4);
			await page.evaluate(full => window.navigationFixture.emit({ type: "session", session: full }), full);
			await expectTranscriptAnchor(page, saved);
			expect((await transcriptReading(page)).bottom).toBeGreaterThan(100);
		} finally { await context.close(); }
	}, 30000);

	test("intrinsic layout changes, viewport changes and browser return preserve reading while bottom followers stay pinned", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			const saved = await scrollTranscript(page, 1423);
			await page.$eval(".conversation .message", message => { (message as HTMLElement).style.minHeight = "620px"; });
			await expectTranscriptAnchor(page, saved);
			await page.setViewport({ width: 1000, height: 700 });
			await expectTranscriptAnchor(page, saved);
			await page.evaluate(() => {
				const message = document.querySelector<HTMLElement>(".conversation .message")!;
				message.style.minHeight = "820px";
				window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
				window.dispatchEvent(new Event("focus"));
				document.dispatchEvent(new Event("visibilitychange"));
			});
			await expectTranscriptAnchor(page, saved);
			// A browser-side shrink may clamp the pane to zero before its resize callback.
			await page.$eval(".conversation", node => { (node as HTMLElement).style.display = "none"; });
			await page.waitForFunction(() => document.querySelector<HTMLElement>(".conversation")?.clientHeight === 0);
			await page.$eval(".conversation", node => { (node as HTMLElement).style.display = ""; });
			await expectTranscriptAnchor(page, saved);
			await openTranscript(page, "new");
			await page.$eval(".conversation", node => {
				const messages = node.querySelectorAll<HTMLElement>(".message");
				messages[messages.length - 1]!.style.minHeight = "1800px";
			});
			await page.waitForFunction(() => {
				const node = document.querySelector(".conversation")!;
				return node.scrollHeight - node.clientHeight - node.scrollTop < 1;
			});
			expect((await transcriptReading(page)).bottom).toBeLessThan(1);
		} finally { await context.close(); }
	}, 30000);

	test("cancelled layout callbacks from A and B cannot move the new A visit", async () => {
		const { context, page } = await fixture();
		try {
			await seedTranscripts(page);
			await openTranscript(page, "old");
			await scrollTranscript(page, 1123);
			await page.evaluate(() => {
				window.navigationFixture.holdAnimationFrames(true);
				window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
			});
			expect(await page.evaluate(() => window.navigationFixture.pendingAnimationFrames())).toBeGreaterThan(0);
			await openTranscript(page, "new");
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await openTranscript(page, "old");
			const saved = await scrollTranscript(page, 2323);
			expect(await page.evaluate(() => window.navigationFixture.pendingAnimationFrames())).toBeGreaterThan(1);
			await page.evaluate(() => window.navigationFixture.flushAnimationFrames(true));
			await expectTranscriptAnchor(page, saved);
			expect((await transcriptReading(page)).top).toBe(saved.top);
		} finally { await context.close(); }
	}, 30000);

	test("the 100-entry LRU promotes visits, not background updates, and evicted sessions default to bottom", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => window.navigationFixture.seedTranscripts(130, 101));
			await page.waitForSelector('.session-select[title="Scroll conversation 100 · Idle"]');
			// Expand the existing sidebar paging UI; no alternate selection path is introduced.
			for (let i = 0; i < 20; i++) await page.$eval(".show-more", button => (button as HTMLButtonElement).click());
			await openTranscript(page, "scroll-0");
			const retained = await scrollTranscript(page, 1123);
			await openTranscript(page, "scroll-1");
			await scrollTranscript(page, 0);
			await page.$eval(".conversation > button", button => (button as HTMLButtonElement).click());
			await page.waitForFunction(() => document.querySelectorAll(".conversation .message").length === 130);
			await scrollTranscript(page, 1323);
			for (let i = 2; i < 100; i++) await openTranscript(page, `scroll-${i}`);
			await openTranscript(page, "scroll-0");
			await expectTranscriptAnchor(page, retained);
			await page.evaluate(() => {
				const background = window.navigationFixture.snapshot().sessions.find(item => item.id === "scroll-1")!;
				window.navigationFixture.emit({ type: "session", session: { ...background, messages: [...background.messages] } });
			});
			await openTranscript(page, "scroll-100");
			await openTranscript(page, "scroll-1");
			const evicted = await transcriptReading(page);
			expect(evicted.count).toBe(100);
			expect(evicted.bottom).toBeLessThan(1);
			await openTranscript(page, "scroll-0");
			await expectTranscriptAnchor(page, retained);
		} finally { await context.close(); }
	}, 60000);

	for (const reason of ["deletion", "project-close"] as const) {
		test(`catalog ${reason} prunes scroll and paging memory before the same IDs return`, async () => {
			const { context, page } = await fixture();
			try {
				await seedTranscripts(page);
				await openTranscript(page, "old");
				await scrollTranscript(page, 0);
				await page.$eval(".conversation > button", button => (button as HTMLButtonElement).click());
				await page.waitForFunction(() => document.querySelectorAll(".conversation .message").length === 200);
				await scrollTranscript(page, 1123);
				await openTranscript(page, "other");
				const original = await page.evaluate(() => window.navigationFixture.snapshot());
				await page.evaluate(({ reason, original }) => window.navigationFixture.emit({ type: "snapshot", snapshot: {
					...original,
					projects: reason === "project-close" ? original.projects.filter(item => item.id !== "p") : original.projects,
					sessions: original.sessions.filter(item => reason === "project-close" ? item.projectId !== "p" : item.id !== "old"),
				} }), { reason, original });
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"]', { hidden: true });
				await page.evaluate(snapshot => window.navigationFixture.emit({ type: "snapshot", snapshot }), original);
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"]');
				await openTranscript(page, "old");
				const reset = await transcriptReading(page);
				expect(reset.count).toBe(100);
				expect(reset.bottom).toBeLessThan(1);
			} finally { await context.close(); }
		}, 30000);
	}

	for (const outcome of ["normal", "dismissed", "navigated", "select-refused", "newer-child", "emptied-child", "cancelled"] as const) {
		test(`Fork child draft handoff respects ${outcome}`, async () => {
			const { context, page } = await fixture();
			try {
				await page.click('.session-select[title="Oldest conversation · Idle"]');
				await page.waitForSelector('.composer textarea:not([disabled])');
				await page.type(".composer textarea", "unrelated parent draft");
				await holdRequest(page, "history.get");
				await holdRequest(page, "session.fork");
				await conversationAction(page, "Fork conversation");
				const history = await heldRequest(page, "history.get");
				await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: true, result: {
					sessionId: "old", total: 1, offset: 0, truncated: false,
					messages: [{ id: "fork-entry", entryId: "fork-entry", role: "user", text: "bounded fork preview" }],
				} }), history.id);
				await page.waitForSelector('.fork-panel [aria-label="User message to fork from"]:not([disabled])');
				await page.click('.fork-panel [aria-label="User message to fork from"]');
				await page.waitForSelector('.fork-panel [role="option"]');
				await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.fork-panel [role="option"]')]
					.find(button => button.textContent?.includes("bounded fork preview"))!.click());
				await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".fork-panel button")]
					.find(button => button.textContent?.trim() === "Fork before the selected message")!.click());
				const fork = await heldRequest(page, "session.fork");
				expect(fork.params).toEqual({ sessionId: "old", entryId: "fork-entry" });
				if (outcome === "dismissed" || outcome === "newer-child" || outcome === "emptied-child") {
					await page.keyboard.press("Escape");
					await page.waitForSelector("dialog[open]", { hidden: true });
				}
				if (outcome === "navigated") {
					await page.keyboard.press("Escape");
					await page.waitForSelector("dialog[open]", { hidden: true });
					await page.click('.session-select[title="Newest conversation · Done"]');
					await page.waitForSelector('.session-select[title="Newest conversation · Done"][aria-current="page"]');
					await page.type(".composer textarea", "unrelated selected draft");
				}
				if (outcome === "newer-child" || outcome === "emptied-child") {
					await page.evaluate(() => window.navigationFixture.emit({ type: "session", session: {
						...window.navigationFixture.snapshot().sessions[0]!, id: "fork-child", title: "Fork child",
					} }));
					await page.waitForSelector('.session-select[title="Fork child · Idle"]');
					await page.click('.session-select[title="Fork child · Idle"]');
					await page.waitForSelector('.session-select[title="Fork child · Idle"][aria-current="page"]');
					await page.type(".composer textarea", "newer child draft");
					if (outcome === "emptied-child") {
						await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.select());
						await page.keyboard.press("Backspace");
					}
				}
				if (outcome === "select-refused") await holdRequest(page, "session.select");
				const selectedText = "exact canonical fork text\nwith trailing spaces  ";
				await page.evaluate(({ id, selectedText, cancelled }) => {
					const child = { ...window.navigationFixture.snapshot().sessions[0]!, id: "fork-child", title: "Fork child" };
					if (!cancelled) window.navigationFixture.emit({ type: "session", session: child });
					window.navigationFixture.emit({ type: "response", id, ok: true, result: cancelled
						? { cancelled: true }
						: { cancelled: false, session: child, selectedText } });
				}, { id: fork.id, selectedText, cancelled: outcome === "cancelled" });
				if (outcome === "select-refused") {
					const selection = await heldRequest(page, "session.select", 2);
					expect(selection.params).toEqual({ sessionId: "fork-child" });
					await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: false, error: "Child selection refused" }), selection.id);
					await page.waitForFunction(() => document.body.textContent?.includes("Child selection refused"));
				}
				const expected = outcome === "newer-child" ? "newer child draft" : outcome === "emptied-child" ? "" : selectedText;
				if (outcome !== "cancelled") {
					await page.waitForFunction(expected => JSON.parse(localStorage.getItem("gjc.desktop.composer-drafts") || "{}")["fork-child"] === expected, {}, expected);
					await page.waitForFunction(async expected => {
						const opened = Promise.withResolvers<IDBDatabase>();
						const open = indexedDB.open("gjc.desktop.delivery-recovery", 2);
						open.onsuccess = () => opened.resolve(open.result);
						open.onerror = () => opened.reject(open.error);
						const db = await opened.promise;
						try {
							const loaded = Promise.withResolvers<{ text: string } | undefined>();
							const read = db.transaction("drafts").objectStore("drafts").get("fork-child");
							read.onsuccess = () => loaded.resolve(read.result);
							read.onerror = () => loaded.reject(read.error);
							return (await loaded.promise)?.text === expected;
						} finally { db.close(); }
					}, {}, expected);
				}
				expect(await page.evaluate(() => JSON.parse(localStorage.getItem("gjc.desktop.composer-drafts") || "{}").old)).toBe("unrelated parent draft");
				if (outcome === "navigated") {
					expect(await page.$('.session-select[title="Newest conversation · Done"][aria-current="page"]')).not.toBeNull();
					expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("unrelated selected draft");
				}
				if (outcome === "cancelled") {
					await page.waitForFunction(() => document.body.textContent?.includes("Fork cancelled"));
					expect(await page.evaluate(() => Object.hasOwn(JSON.parse(localStorage.getItem("gjc.desktop.composer-drafts") || "{}"), "fork-child"))).toBe(false);
					return;
				}
				if (outcome === "dismissed" || outcome === "select-refused")
					expect(await page.$('.session-select[title="Oldest conversation · Idle"][aria-current="page"]')).not.toBeNull();
				if (outcome === "normal")
					await page.waitForSelector('.session-select[title="Fork child · Idle"][aria-current="page"]');
				// A later independent selection/reload must still recover the exact child-owned text.
				await page.reload();
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"]');
				await page.evaluate(() => window.navigationFixture.emit({ type: "session", session: {
					...window.navigationFixture.snapshot().sessions[0]!, id: "fork-child", title: "Fork child",
				} }));
				await page.waitForSelector('.session-select[title="Fork child · Idle"]');
				await page.click('.session-select[title="Fork child · Idle"]');
				await page.waitForSelector('.session-select[title="Fork child · Idle"][aria-current="page"]');
				await page.waitForSelector('.composer textarea:not([disabled])');
				await page.waitForFunction(expected => (document.querySelector(".composer textarea") as HTMLTextAreaElement)?.value === expected, {}, expected);
				await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
				await page.type(".composer textarea", "still editable");
				expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe(`${expected}still editable`);
			} finally { await context.close(); }
		}, 30000);
	}

	for (const retired of ["initial", "pagination", "failed"] as const) {
		test(`reopening Fork admits fresh history while retired ${retired} history is pending`, async () => {
			const { context, page } = await fixture();
			try {
				await page.click('.session-select[title="Oldest conversation · Idle"]');
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
				await holdRequest(page, "history.get");
				await conversationAction(page, "Fork conversation");
				let old = await heldRequest(page, "history.get");
				if (retired === "pagination") {
					await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: true, result: {
						sessionId: "old", total: 2, offset: 0, truncated: true,
						messages: [{ id: "retired-first", entryId: "retired-first", role: "user", text: "Retired first page" }],
					} }), old.id);
					await page.waitForSelector('.fork-panel [aria-label="User message to fork from"]:not([disabled])');
					await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".fork-panel button")]
						.find(button => button.textContent?.trim() === "Load the next 500")!.click());
					old = await heldRequest(page, "history.get", 2);
					expect(old.params).toEqual({ sessionId: "old", offset: 1, limit: 500 });
				}
				await page.keyboard.press("Escape");
				await page.waitForSelector("dialog[open]", { hidden: true });
				await conversationAction(page, "Fork conversation");
				const count = retired === "pagination" ? 3 : 2;
				const current = await heldRequest(page, "history.get", count);
				expect(current.params).toEqual({ sessionId: "old", offset: 0, limit: 500 });
				if (retired === "failed") {
					await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: false, error: "Retired history error" }), old.id);
					expect(await page.$("dialog[open] .error-banner")).toBeNull();
					expect(await page.$eval("dialog[open]", node => node.textContent)).not.toContain("Retired history error");
				}
				await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: true, result: {
					sessionId: "old", total: 2, offset: 0, truncated: true,
					messages: [{ id: "current", entryId: "current", role: "user", text: "Current dialog history" }],
				} }), current.id);
				await page.waitForSelector('.fork-panel [aria-label="User message to fork from"]:not([disabled])');
				// The old read remains pending, but only this dialog's pending scope controls its buttons.
				await page.click('.fork-panel [aria-label="User message to fork from"]');
				await page.waitForSelector('.fork-panel [role="option"]');
				await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.fork-panel [role="option"]')]
					.find(button => button.textContent?.includes("Current dialog history"))!.click());
				await page.waitForFunction(() => (document.querySelector(".fork-panel textarea") as HTMLTextAreaElement)?.value === "Current dialog history");
				if (retired !== "failed") {
					await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: true, result: {
						sessionId: "old", total: 1, offset: 0, truncated: false,
						messages: [{ id: "stale", entryId: "stale", role: "user", text: "Stale dialog history" }],
					} }), old.id);
				}
				// Exercise pagination on the replacement too; it must use the same current generation.
				await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".fork-panel button")]
					.find(button => button.textContent?.trim() === "Load the next 500")!.click());
				const next = await heldRequest(page, "history.get", count + 1);
				expect(next.params).toEqual({ sessionId: "old", offset: 1, limit: 500 });
				await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: true, result: {
					sessionId: "old", total: 2, offset: 1, truncated: false,
					messages: [{ id: "current-next", entryId: "current-next", role: "user", text: "Current next page" }],
				} }), next.id);
				await page.waitForSelector('.fork-panel [aria-label="User message to fork from"]:not([disabled])');
				expect(await page.$eval(".fork-panel textarea", (el: HTMLTextAreaElement) => el.value)).toBe("Current dialog history");
				expect(await page.$eval("dialog[open]", node => node.textContent)).not.toContain("Retired history error");
				await page.click('.fork-panel [aria-label="User message to fork from"]');
				await page.waitForSelector('.fork-panel [role="option"]');
				expect(await page.$$eval('.fork-panel [role="option"]', nodes => nodes.map(node => node.textContent)))
					.toEqual(["Select a user message", "1. Current dialog history", "2. Current next page"]);
			} finally { await context.close(); }
		}, 30000);
	}

	for (const selection of ["unchanged", "different", "roundtrip"] as const) {
		test(`new conversation respects ${selection} selection while creation is pending`, async () => {
			const { context, page } = await fixture();
			try {
				await page.click('.session-select[title="Oldest conversation · Idle"]');
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
				await holdRequest(page, "session.create");
				await page.click('.desktop-sidebar [aria-label="New conversation in pandas"]');
				const request = await heldRequest(page, "session.create");
				if (selection !== "unchanged") {
					await page.click('.session-select[title="Newest conversation · Done"]');
					await page.waitForSelector('.session-select[title="Newest conversation · Done"][aria-current="page"]');
					if (selection === "roundtrip") {
						await page.click('.session-select[title="Oldest conversation · Idle"]');
						await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
					}
				}
				await page.evaluate(id => {
					const created = { ...window.navigationFixture.snapshot().sessions[0]!, id: "created", title: "Created conversation" };
					window.navigationFixture.emit({ type: "session", session: created });
					window.navigationFixture.emit({ type: "response", id, ok: true, result: created });
				}, request.id);
				await page.waitForSelector('.desktop-sidebar [aria-label="New conversation in pandas"]:not([disabled])');
				expect(await page.$('.session-select[title="Created conversation · Idle"]')).not.toBeNull();
				const selected = selection === "unchanged" ? "Created conversation · Idle" : selection === "different" ? "Newest conversation · Done" : "Oldest conversation · Idle";
				expect(await page.$(`.session-select[title="${selected}"][aria-current="page"]`)).not.toBeNull();
				expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.select" && request.params.sessionId === "created").length)).toBe(selection === "unchanged" ? 1 : 0);
			} finally { await context.close(); }
		}, 30000);
	}

	for (const selection of ["unchanged", "roundtrip"] as const) {
		test(`/clear respects ${selection} selection while creation is pending`, async () => {
			const { context, page } = await fixture();
			try {
				await page.click('.session-select[title="Oldest conversation · Idle"]');
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
				await page.waitForSelector('.composer textarea:not([disabled])');
				await holdRequest(page, "session.create");
				await page.type(".composer textarea", "/clear");
				await page.keyboard.press("Enter");
				const request = await heldRequest(page, "session.create");
				await page.keyboard.press("Enter");
				expect(request.params).toEqual({ projectId: "p" });
				expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.create").length)).toBe(1);
				if (selection === "roundtrip") {
					await page.click('.session-select[title="Newest conversation · Done"]');
					await page.waitForSelector('.session-select[title="Newest conversation · Done"][aria-current="page"]');
					await page.click('.session-select[title="Oldest conversation · Idle"]');
					await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
				}
				await page.evaluate(id => {
					const created = { ...window.navigationFixture.snapshot().sessions[0]!, id: "clear-created", title: "Clear-created conversation" };
					window.navigationFixture.emit({ type: "session", session: created });
					window.navigationFixture.emit({ type: "response", id, ok: true, result: created });
				}, request.id);
				await page.waitForSelector('.desktop-sidebar [aria-label="New conversation in pandas"]:not([disabled])');
				expect(await page.$$('.session-select[title="Clear-created conversation · Idle"]')).toHaveLength(1);
				const selected = selection === "unchanged" ? "Clear-created conversation · Idle" : "Oldest conversation · Idle";
				expect(await page.$(`.session-select[title="${selected}"][aria-current="page"]`)).not.toBeNull();
				expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.select" && request.params.sessionId === "clear-created").length)).toBe(selection === "unchanged" ? 1 : 0);
				expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.create").length)).toBe(1);
			} finally { await context.close(); }
		}, 30000);
	}

	for (const replaceDialog of [false, true]) {
		test(`export completion ${replaceDialog ? "cannot replace a newer modal" : "shows its normal result"}`, async () => {
			const { context, page } = await fixture();
			try {
				await page.click('.session-select[title="Oldest conversation · Idle"]');
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
				await holdRequest(page, "session.export");
				await conversationAction(page, "Export conversation");
				const request = await heldRequest(page, "session.export");
				if (replaceDialog) {
					await page.keyboard.press("Escape");
					await page.waitForSelector("dialog[open]", { hidden: true });
					await conversationAction(page, "Delete conversation");
					await page.waitForSelector(".delete-confirmation");
				}
				await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: true, result: { path: "/exports/completed.html" } }), request.id);
				if (replaceDialog) {
					await page.waitForSelector('dialog[open] button.danger:not([disabled])');
					expect(await page.$(".delete-confirmation")).not.toBeNull();
					expect(await page.$eval("dialog", node => node.textContent)).not.toContain("completed.html");
				} else {
					await page.waitForFunction(() => document.querySelector("dialog[open]")?.textContent?.includes("/exports/completed.html"));
				}
				expect(request.params).toEqual({ sessionId: "old" });
				expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.export").length)).toBe(1);
			} finally { await context.close(); }
		}, 30000);
	}

	for (const replaceDialog of [false, true]) {
		test(`delete completion ${replaceDialog ? "cannot close a newer modal" : "closes its own confirmation"}`, async () => {
			const { context, page } = await fixture();
			try {
				await page.click('.session-select[title="Oldest conversation · Idle"]');
				await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
				await holdRequest(page, "session.delete");
				await conversationAction(page, "Delete conversation");
				await page.click("dialog[open] button.danger");
				const request = await heldRequest(page, "session.delete");
				if (replaceDialog) {
					await page.keyboard.press("Escape");
					await page.waitForSelector("dialog[open]", { hidden: true });
					await conversationAction(page, "Delete conversation");
					await page.waitForSelector(".delete-confirmation");
				}
				await page.evaluate(id => window.navigationFixture.emit({ type: "response", id, ok: true, result: null }), request.id);
				if (replaceDialog) {
					await page.waitForSelector('dialog[open] button.danger:not([disabled])');
					expect(await page.$(".delete-confirmation")).not.toBeNull();
				} else {
					await page.waitForSelector("dialog[open]", { hidden: true });
				}
				expect(request.params).toEqual({ sessionId: "old" });
				expect(await page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "session.delete").length)).toBe(1);
			} finally { await context.close(); }
		}, 30000);
	}

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

	test("a narrow window collapses the sidebar to its rail, which expands in place and still reorders", async () => {
		const { context, page } = await fixture();
		try {
			await page.setViewport({ width: 700, height: 800 });
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			expect(await page.$eval('.desktop-sidebar', node => node.getBoundingClientRect().width)).toBe(64);
			expect(await page.$('.toolbar .mobile-only, dialog.sidebar-drawer')).toBeNull();
			expect(await page.$eval('.sidebar-toggle', node => node.getAttribute("aria-expanded"))).toBe("false");
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForFunction(() => !document.querySelector('.desktop-sidebar[data-compact]'));
			expect(await page.$eval('.desktop-sidebar', node => node.getBoundingClientRect().width)).toBe(264);
			expect(await page.$$eval('.desktop-sidebar .session-title', nodes => nodes.every(node => node.getBoundingClientRect().width > 0))).toBe(true);
			// Collapsing the sidebar mid-gesture retires the drag instead of dropping it somewhere.
			await startProjectPointer(page, "p", "q", "after");
			await page.waitForSelector('.desktop-sidebar .drop-after');
			await page.evaluate(() => document.querySelector<HTMLButtonElement>('.desktop-sidebar .sidebar-toggle')!.click());
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			await page.mouse.up();
			expect(await reorderRequests(page)).toEqual([]);
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForFunction(() => !document.querySelector('.desktop-sidebar[data-compact]'));
			await startProjectPointer(page, "p", "q", "after");
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

	test("narrow auto-collapse is transient and never rewrites the saved sidebar preference", async () => {
		const { context, page } = await fixture();
		const collapsed = () => page.evaluate(() => document.querySelector('.desktop-sidebar')!.hasAttribute("data-compact"));
		const saved = () => page.evaluate(() => localStorage.getItem("gjc.desktop.sidebar-compact"));
		try {
			expect(await collapsed()).toBe(false);
			await page.setViewport({ width: 700, height: 800 });
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForFunction(() => !document.querySelector('.desktop-sidebar[data-compact]'));
			expect(await saved()).toBe("false");
			// Narrowing again starts collapsed; widening restores the saved expanded sidebar.
			await page.setViewport({ width: 1400, height: 900 });
			await page.setViewport({ width: 700, height: 800 });
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			await page.setViewport({ width: 1400, height: 900 });
			await page.waitForFunction(() => !document.querySelector('.desktop-sidebar[data-compact]'));
			// A saved compact rail survives expanding the sidebar in a narrow window.
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			expect(await saved()).toBe("true");
			await page.setViewport({ width: 700, height: 800 });
			await page.click('.desktop-sidebar .sidebar-toggle');
			await page.waitForFunction(() => !document.querySelector('.desktop-sidebar[data-compact]'));
			expect(await saved()).toBe("true");
			await page.setViewport({ width: 1400, height: 900 });
			await page.waitForSelector('.desktop-sidebar[data-compact]');
			expect(await collapsed()).toBe(true);
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
