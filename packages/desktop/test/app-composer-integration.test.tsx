import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { browserPath } from "./component-fixture";
import type { DesktopActivitySnapshot } from "@gajae-code/desktop-host/activity-protocol";
import type { DesktopSessionInfo } from "@gajae-code/desktop-host/session-info-protocol";
import type { DesktopPreferences } from "@gajae-code/desktop-host/preferences-protocol";
import type { DesktopDeliveryReceipt, DesktopDiff, DesktopFrame, DesktopMessage, DesktopModel, DesktopRequest, DesktopSession } from "@gajae-code/desktop-host/protocol";

const suite = browserPath ? describe : describe.skip;

type PromptRequest = DesktopRequest & { method: "prompt"; params: { sessionId: string; attachments?: unknown[] } };
interface FixtureState {
	receipts: DesktopDeliveryReceipt[];
	requests: DesktopRequest[];
	bootReceipt?: DesktopDeliveryReceipt;
	ackMode?: "lost" | "error";
}
interface FixtureControl {
	emit(frame: DesktopFrame): void;
	copyResponse(id: string, text: string): void;
	requests(): DesktopRequest[];
	lastPrompt(): PromptRequest | undefined;
	bootstrapReceipt(receipt: DesktopDeliveryReceipt): void;
	failNextAck(mode: "lost" | "error"): void;
	failPostHandoffDraftSave(count?: number): void;
	holdPreferences(method: "preferences.get" | "preferences.apply" | "composer.complete" | "session.info" | "session.pullRequest", hold: boolean): void;
	setModels(models: DesktopModel[]): void;
	setDiffs(diffs: DesktopDiff[]): void;
	setActivity(sessionId: string, activity: DesktopActivitySnapshot): void;
	receipt(id: string, sessionId: string, disposition: DesktopDeliveryReceipt["disposition"]): void;
	response(id: string, ok: boolean, error?: string, deliveryDisposition?: "refused" | "failed" | "unknown"): void;
}
interface FixtureWindow extends Window {
	fixture: FixtureControl;
	isTauri: boolean;
	__TAURI_INTERNALS__: {
		transformCallback(callback: (event: unknown) => void): number;
		unregisterCallback(id: number): void;
		invoke(command: string, args?: { handler?: number; eventId?: number; request?: DesktopRequest }): Promise<unknown>;
	};
	__TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener(): void };
}
declare global {
	interface Window {
		fixture: FixtureControl;
		responseClipboard: {
			writes: number;
			commits: string[];
			rejections: number;
			active: boolean[];
			failure: "setup" | "write" | null;
		};
	}
}

// A real Vite/Chromium app with a page-owned Tauri transport. No process-global mocks.
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
		try { if ((await fetch(origin)).ok) break; } catch { /* server is starting */ }
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

const pageErrors = new WeakMap<Page, Promise<never>>();
const observedPageErrors = new WeakMap<Page, Error>();
async function closeFixture(context: BrowserContext, page: Page): Promise<void> {
	await context.close();
	const error = observedPageErrors.get(page);
	if (error) throw new Error(`Browser page error: ${error.message}`, { cause: error });
}
async function step<T>(page: Page, label: string, action: () => Promise<T>): Promise<T> {
	const failure = pageErrors.get(page);
	try {
		return await Promise.race(failure ? [action(), failure] : [action()]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${label}: ${detail}`, { cause: error });
	}
}

async function fixture(observeRecoveryNotices = false): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(5000);
	const pageFailure = Promise.withResolvers<never>();
	pageErrors.set(page, pageFailure.promise);
	// Keep the rejection observed even when it arrives between test steps.
	void pageFailure.promise.catch(() => {});
	page.on("pageerror", error => {
		const normalized = error instanceof Error ? error : new Error(String(error));
		observedPageErrors.set(page, normalized);
		pageFailure.reject(normalized);
	});
	try {
	await page.setViewport({ width: 1400, height: 900 });
	await page.evaluateOnNewDocument((observeRecoveryNotices: boolean) => {
		const w = window as unknown as FixtureWindow;
		if (observeRecoveryNotices) {
			new MutationObserver(() => {
				if ([...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("Delivery recovery:")))
					sessionStorage.setItem("sawRecoveryNotice", "yes");
			}).observe(document, { subtree: true, childList: true, characterData: true });
		}
		const callbacks = new Map<number, (event: unknown) => void>();
		const listeners = new Map<number, number>();
		let serial = 0;
		let failDraftAfterHandoff = 0;
		let sawHandoff = false;
		const heldPreferences = new Set<string>();
		let models: DesktopModel[] = [];
		const activities = new Map<string, DesktopActivitySnapshot>();
		let activityRevision = 0;
		let diffs: DesktopDiff[] = [];
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value, key) {
			const fault = sessionStorage.getItem("failDeliveryPut");
			if (this.name === "deliveries" && fault === `${value.id}:${value.disposition}`) {
				sessionStorage.removeItem("failDeliveryPut");
				throw new DOMException("Injected delivery save failure", "QuotaExceededError");
			}
			return key === undefined ? Reflect.apply(put, this, [value]) : Reflect.apply(put, this, [value, key]);
		};
		const transaction = IDBDatabase.prototype.transaction;
		IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
			const names = Array.isArray(storeNames) ? storeNames : [storeNames];
			if (sessionStorage.getItem("failBootstrapRestore") && names.includes("deliveries") && names.includes("drafts") && mode === "readwrite") {
				sessionStorage.removeItem("failBootstrapRestore");
				throw new DOMException("Injected bootstrap restore failure", "QuotaExceededError");
			}
			if (failDraftAfterHandoff && sawHandoff && names.length === 1 && names[0] === "drafts" && mode === "readwrite") {
				failDraftAfterHandoff--;
				throw new DOMException("Injected post-handoff storage failure", "QuotaExceededError");
			}
			if (failDraftAfterHandoff && names.includes("deliveries") && names.includes("drafts") && mode === "readwrite") sawHandoff = true;
			return Reflect.apply(transaction, this, [storeNames, mode, options]);
		};
		const session = (id: string, title: string): DesktopSession => ({ id, title, projectId: "p", status: "idle", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [] });
		const stored = (): FixtureState => JSON.parse(sessionStorage.getItem("fixture") || '{"receipts":[],"requests":[]}') as FixtureState;
		const save = (value: FixtureState) => sessionStorage.setItem("fixture", JSON.stringify(value));
		const emit = (frame: DesktopFrame) => {
			if (frame.type === "delivery") {
				const state = stored();
				state.receipts = state.receipts.filter(r => r.id !== frame.receipt.id).concat(frame.receipt);
				save(state);
			}
			for (const [id, handler] of listeners) callbacks.get(handler)?.({ event: "engine-frame", id, payload: frame });
		};
		w.fixture = {
			emit,
			copyResponse: (id, text) => emit({ type: "response", id, ok: true, result: { text } }),
			requests: () => stored().requests,
			lastPrompt: () => stored().requests.filter((r): r is PromptRequest => r.method === "prompt" && typeof r.params.sessionId === "string").at(-1),
			bootstrapReceipt: (receipt: DesktopDeliveryReceipt) => { const state = stored(); state.bootReceipt = receipt; state.receipts = []; save(state); },
			failNextAck: (mode: "lost" | "error") => { const state = stored(); state.ackMode = mode; save(state); },
			failPostHandoffDraftSave: (count = 1) => { failDraftAfterHandoff = count; sawHandoff = false; },
			holdPreferences: (method, hold) => { if (hold) heldPreferences.add(method); else heldPreferences.delete(method); },
			setModels: value => { models = value; },
			setDiffs: value => { diffs = value; },
			setActivity: (sessionId, activity) => { activities.set(sessionId, activity); },
			receipt: (id: string, sessionId: string, disposition: DesktopDeliveryReceipt["disposition"]) => emit({ type: "delivery", receipt: { id, sessionId, disposition } }),
			response: (id: string, ok: boolean, error = "refused", deliveryDisposition?: "refused" | "failed" | "unknown") => emit(ok ? { type: "response", id, ok, result: {} } : { type: "response", id, ok, error, deliveryDisposition }),
		};
		w.isTauri = true;
		w.__TAURI_INTERNALS__ = {
			transformCallback(callback: (event: unknown) => void) { const id = ++serial; callbacks.set(id, callback); return id; },
			unregisterCallback(id: number) { callbacks.delete(id); },
			async invoke(command: string, args: { handler?: number; eventId?: number; request?: DesktopRequest } = {}) {
				if (command === "plugin:event|listen") { if (args.handler === undefined) throw new Error("Missing handler"); const id = ++serial; listeners.set(id, args.handler); return id; }
				if (command === "plugin:event|unlisten") { if (args.eventId !== undefined) listeners.delete(args.eventId); return; }
				if (command === "desktop_update_check") return { currentVersion: "0.0.0-fixture", bundledGjcVersion: "0.0.0-fixture", available: false, reason: "Updates are not configured in this mounted fixture." };
				if (command !== "engine_request" || !args.request) throw new Error(command);
				const request = args.request;
				const state = stored(); state.requests.push(request); save(state);
				if (request.method === "prompt" || request.method === "message.copyText" || heldPreferences.has(request.method)) return;
				if (request.method === "bootstrap" && sessionStorage.getItem("bufferedReceipts")) {
					const receipts = JSON.parse(sessionStorage.getItem("bufferedReceipts")!) as DesktopDeliveryReceipt[];
					sessionStorage.removeItem("bufferedReceipts");
					for (const receipt of receipts) emit({ type: "delivery", receipt });
				}
				if (request.method === "bootstrap" && sessionStorage.getItem("failBootstrap")) {
					const mode = sessionStorage.getItem("failBootstrap");
					sessionStorage.removeItem("failBootstrap");
					if (mode === "fatal") emit({ type: "fatal", error: "Injected bootstrap fatal" });
					queueMicrotask(() => emit({ type: "response", id: request.id, ok: false, error: "Injected bootstrap failure" }));
					return;
				}
				let result: unknown;
				if (request.method === "session.select") {
					const sessionId = request.params.sessionId;
					if (sessionId !== "a" && sessionId !== "b") throw new Error("Unknown fixture session");
					result = session(sessionId, sessionId === "a" ? "Session A" : "Session B");
				}
				if (request.method === "bootstrap") result = { protocolVersion: 1, projects: [{ id: "p", name: "Project", path: "/project" }], sessions: [session("a", "Session A"), session("b", "Session B")], models: [], capabilities: [], deliveries: state.receipts };
				if (request.method === "bootstrap" && state.bootReceipt) {
					const receipt = state.bootReceipt; delete state.bootReceipt; save(state);
					emit({ type: "delivery", receipt });
				}
				if (request.method === "composer.complete") result = {
					items: Array.from({ length: 24 }, (_, index) => {
						const value = `fixture-command-${index + 1}`;
						const text = `/${value} `;
						return { value, label: `/${value}`, description: "Synthetic mounted App completion · draft only", text, cursor: text.length };
					}),
				};
				if (request.method === "models.list") result = models;
				if (request.method === "diff.get") result = diffs;
				if (request.method === "settings.get" || request.method === "auth.keyProviders" || request.method === "auth.providers") result = [];
				if (request.method === "auth.state") result = null;
				if (request.method === "preferences.get") result = { profiles: [], roles: [], sampling: [] };
				if (request.method === "queue.cancel") {
					const prompt = state.requests.find(item => item.id === request.params.queueId);
					if (prompt && typeof prompt.params.sessionId === "string") emit({ type: "delivery", receipt: { id: prompt.id, sessionId: prompt.params.sessionId, disposition: "cancelled" } });
					result = { removed: true };
				}
				if (request.method === "activity.get") {
					const sessionId = request.params.sessionId;
					if (typeof sessionId !== "string") throw new Error("Missing activity session");
					result = { sessionId, revision: ++activityRevision, activity: activities.get(sessionId) ?? { available: false, reason: "Fixture has no activity backend", sessionGeneration: "fixture-session", connectionGeneration: "fixture-connection" } };
				}
				if (request.method === "activity.detail") {
					const { sessionId, ref } = request.params;
					if (typeof sessionId !== "string" || !ref || typeof ref !== "object" || !("key" in ref) || typeof ref.key !== "string") throw new Error("Invalid activity detail target");
					const activity = activities.get(sessionId);
					const entry = activity?.available ? [...activity.jobs, ...activity.tasks, ...activity.crons].find(entry => entry.ref.key === ref.key) : undefined;
					if (!entry) throw new Error("Unknown fixture activity");
					result = { entry };
				}
				if (
					request.method === "project.close" ||
					request.method === "project.reorder" ||
					request.method === "session.reorder" ||
					request.method === "session.rename" ||
					request.method === "session.revision"
				)
					result = null;
				if (request.method === "delivery.ack") {
					result = null;
					const mode = state.ackMode;
					delete state.ackMode;
					if (mode !== "error") state.receipts = state.receipts.filter(r => r.id !== request.params.deliveryId);
					save(state);
					if (mode === "lost") return;
					if (mode === "error") { queueMicrotask(() => emit({ type: "response", id: request.id, ok: false, error: "ack failure" })); return; }
				}
				if (result === undefined) throw new Error(`Unsupported fixture method: ${request.method}`);
				queueMicrotask(() => emit({ type: "response", id: request.id, ok: true, result }));
			},
		};
		w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
	}, observeRecoveryNotices);
	await step(page, "open app", () => page.goto(origin));
	await step(page, "bootstrap session list", () => page.waitForSelector(".session-select"));
	await step(page, "bootstrap connection", () => page.waitForFunction(() => !document.body.textContent?.includes("Connecting to the host")));
	return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}
async function select(page: Page, index = 0) {
	return step(page, `select session ${index}`, async () => {
	await page.waitForSelector(".desktop-sidebar .session-select");
	for (let attempt = 0; attempt < 100; attempt++) {
		const title = index === 0 ? "Session A" : "Session B";
		await page.evaluate(title => {
			const button = [...document.querySelectorAll<HTMLButtonElement>(".desktop-sidebar .session-select")]
				.find(node => node.querySelector(".session-title")?.textContent === title);
			button?.click();
		}, title);
		const current = await page.$eval(".desktop-sidebar .session-select[aria-current='page']", el => el.textContent).catch(() => "");
		if (current?.includes(index === 0 ? "Session A" : "Session B") && await page.$(".composer textarea:not([disabled])")) return;
		await Bun.sleep(50);
	}
	throw new Error("Session composer did not become available (bootstrap or recovery storage not ready)");
	});
}
async function attach(page: Page) {
	return step(page, "attach file", async () => {
	await page.evaluate(() => {
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const transfer = new DataTransfer(); transfer.items.add(new File(["attachment payload"], "payload.txt", { type: "text/plain" }));
		input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await page.waitForSelector(".attachment-ready");
	});
}
async function send(page: Page, text: string) {
	return step(page, "send prompt", async () => {
	if (text) await page.type(".composer textarea", text);
	await page.click('.composer button[type="submit"]');
	await page.waitForFunction(() => window.fixture.lastPrompt());
	const request = await page.evaluate(() => window.fixture.lastPrompt());
	if (!request) throw new Error("Prompt was not recorded");
	return request;
	});
}
async function receipt(page: Page, request: PromptRequest, disposition: DesktopDeliveryReceipt["disposition"]) {
	await step(page, `emit ${disposition} receipt`, () => page.evaluate(({ request, disposition }) => window.fixture.receipt(request.id, request.params.sessionId, disposition), { request, disposition }));
}
async function waitStoredDisposition(page: Page, id: string, disposition: DesktopDeliveryReceipt["disposition"]) {
	await page.waitForFunction(async (id, disposition) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("gjc.desktop.delivery-recovery", 2);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const entry = await new Promise<{ disposition: string } | undefined>((resolve, reject) => {
			const request = db.transaction("deliveries").objectStore("deliveries").get(id);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		db.close();
		return entry?.disposition === disposition;
	}, {}, id, disposition);
}

// Each copy scenario owns its fresh page and clipboard; no module/global clipboard mock.
async function installResponseClipboard(page: Page): Promise<void> {
	await page.evaluate(() => {
		const state: Window["responseClipboard"] = { writes: 0, commits: [], rejections: 0, active: [], failure: null };
		window.responseClipboard = state;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				write(items: ClipboardItem[]): Promise<void> {
					state.writes++;
					state.active.push(navigator.userActivation.isActive);
					if (state.failure === "setup") throw new Error("Clipboard setup denied");
					return (async () => {
						try {
							if (items.length !== 1 || items[0].types.join() !== "text/plain") throw new Error("Wrong clipboard payload");
							const blob = await items[0].getType("text/plain");
							const text = await blob.text();
							if (state.failure === "write") throw new Error("Clipboard write denied");
							state.commits.push(text);
						} catch (error) {
							state.rejections++;
							throw error;
						}
					})();
				},
			},
		});
	});
}

function responseSession(overrides: Partial<DesktopSession> = {}): DesktopSession {
	return {
		id: "a", title: "Session A", projectId: "p", status: "done", starred: false,
		imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1,
		messages: [{
			id: "answer", role: "assistant", text: "bounded preview", truncated: true,
			blocks: [{ type: "thinking", text: "private reasoning must not copy" }, { type: "text", text: "bounded preview" }],
			copy: { entryId: "canonical-answer", sessionGeneration: 1 },
		}, { id: "tool", role: "tool", text: "tool output must not copy", toolName: "read" }],
		...overrides,
	};
}
async function publishResponse(page: Page, session = responseSession()): Promise<void> {
	await page.evaluate(session => window.fixture.emit({ type: "session", session }), session);
	if (session.messages.some(message => message.role === "assistant" && message.copy?.sessionGeneration === session.controlGeneration))
		await page.waitForSelector(".conversation .message-copy");
}
async function copyRequest(page: Page, count = 1): Promise<DesktopRequest> {
	await page.waitForFunction(count => window.fixture.requests().filter(r => r.method === "message.copyText").length === count, {}, count);
	const request = await page.evaluate(() => window.fixture.requests().filter(r => r.method === "message.copyText").at(-1));
	if (!request) throw new Error("Missing canonical copy request");
	return request;
}

function hudInfo(name: string, branch: string | null = null): DesktopSessionInfo {
	const unavailable = { available: false as const, reason: "Not measured by this fixture" };
	return {
		available: true,
		metadata: { catalogSessionId: "a", name, sessionFileDisplay: null, cwd: "/project", createdAt: null, persisted: true },
		model: { provider: "fixture", id: "hud-model", name: "HUD model" }, thinkingLevel: "high",
		hud: { branch, jobs: 2, tokensPerSecond: 12.5, version: "1.2.3" },
		run: { state: "idle", streaming: false, bashRunning: false, pythonRunning: false, compacting: false, retrying: false, postPromptWork: false, queuedMessages: 0 },
		tools: { available: 3, pending: 0, calls: 1, results: 1 },
		recordedTotals: unavailable, activeTotals: unavailable, liveProgress: unavailable,
		context: { tokens: 250, contextWindow: 1000, percent: 25, source: "heuristic", note: "Fixture estimate" },
		accountQuota: unavailable, actualBilledCost: unavailable,
	};
}

async function hudRequest(page: Page, method: "session.info" | "session.pullRequest", count: number): Promise<DesktopRequest> {
	await page.waitForFunction(({ method, count }) => window.fixture.requests().filter(r => r.method === method).length === count, {}, { method, count });
	const request = await page.evaluate(method => window.fixture.requests().filter(r => r.method === method).at(-1), method);
	if (!request) throw new Error(`Missing ${method} request`);
	expect(request.params).toEqual({ sessionId: "a" });
	return request;
}

async function answerHud(page: Page, request: DesktopRequest, result: unknown): Promise<void> {
	await page.evaluate(({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }), { id: request.id, result });
	// Drain the response's promise callbacks and React paint before checking absence of stale content.
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function openHud(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.fixture.holdPreferences("session.info", true);
		window.fixture.holdPreferences("session.pullRequest", true);
	});
	await page.click('.toolbar button[aria-label="Session status"]');
	await page.waitForSelector("dialog[open] .session-hud-panel");
}

async function hudTitle(page: Page, name: string): Promise<void> {
	await page.waitForFunction(name => [...document.querySelectorAll(".session-hud dd")].some(node => node.textContent === name), {}, name);
}

suite("mounted session status HUD", () => {
	test("toolbar opens status directly, outside conversation actions, and renders host fields", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await openHud(page);
			expect(await page.$('[aria-label="Conversation actions"]')).toBeNull();
			await answerHud(page, await hudRequest(page, "session.info", 1), hudInfo("Toolbar snapshot"));
			await hudTitle(page, "Toolbar snapshot");
			const fields = await page.$$eval(".session-hud dd", nodes => nodes.map(node => node.textContent));
			expect(fields).toEqual(expect.arrayContaining(["HUD model", "high", "2", "12.5/s", "/project", "v1.2.3"]));
			expect(await page.$eval('.session-hud meter', node => node.getAttribute("aria-valuetext"))).toBe("25.0%");
			expect(await page.evaluate(() => window.fixture.requests().filter(r => r.method === "session.pullRequest"))).toEqual([]);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("settled session changes refresh the open HUD without another toolbar click", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await openHud(page);
			await answerHud(page, await hudRequest(page, "session.info", 1), hudInfo("Before settlement"));
			await hudTitle(page, "Before settlement");
			await page.evaluate(session => window.fixture.emit({ type: "session", session }), responseSession());
			await answerHud(page, await hudRequest(page, "session.info", 2), hudInfo("After settlement"));
			await hudTitle(page, "After settlement");
			expect(await page.$eval(".session-hud", node => node.textContent)).not.toContain("Before settlement");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("a settled refresh queued behind an in-flight read is not dropped", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await openHud(page);
			const first = await hudRequest(page, "session.info", 1);
			await page.evaluate(async session => {
				window.fixture.emit({ type: "session", session });
				// Let the mounted App consume the frame and queue its effect while the read stays held.
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			}, responseSession());
			expect(await page.evaluate(() => window.fixture.requests().filter(r => r.method === "session.info").length)).toBe(1);
			await answerHud(page, first, hudInfo("Read started before settlement"));
			const queued = await hudRequest(page, "session.info", 2);
			expect(queued.id).not.toBe(first.id);
			await answerHud(page, queued, hudInfo("Queued fresh snapshot"));
			await hudTitle(page, "Queued fresh snapshot");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("closing fences an old read from a reopened HUD and cancels its queued refresh", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await openHud(page);
			const old = await hudRequest(page, "session.info", 1);
			await page.evaluate(async session => {
				window.fixture.emit({ type: "session", session });
				// Let the mounted App consume the frame and queue its effect while the read stays held.
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			}, responseSession());
			await page.click("dialog[open] .modal-close");
			await page.waitForSelector("dialog[open]", { hidden: true });
			await openHud(page);
			const reopened = await hudRequest(page, "session.info", 2);
			await answerHud(page, reopened, hudInfo("Reopened current snapshot"));
			await hudTitle(page, "Reopened current snapshot");
			await answerHud(page, old, hudInfo("Closed obsolete snapshot", "obsolete-branch"));
			expect(await page.$eval(".session-hud", node => node.textContent)).toContain("Reopened current snapshot");
			expect(await page.$eval(".session-hud", node => node.textContent)).not.toContain("Closed obsolete snapshot");
			expect(await page.evaluate(() => window.fixture.requests().filter(r => r.method === "session.info").length)).toBe(2);
			expect(await page.evaluate(() => window.fixture.requests().filter(r => r.method === "session.pullRequest").length)).toBe(0);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("a slow branch A pull request cannot overwrite the newer branch B result", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await openHud(page);
			await answerHud(page, await hudRequest(page, "session.info", 1), hudInfo("Branch A snapshot", "feature/a"));
			const branchA = await hudRequest(page, "session.pullRequest", 1);
			await page.evaluate(session => window.fixture.emit({ type: "session", session }), responseSession());
			await answerHud(page, await hudRequest(page, "session.info", 2), hudInfo("Branch B snapshot", "feature/b"));
			const branchB = await hudRequest(page, "session.pullRequest", 2);
			await answerHud(page, branchB, { number: 202, url: "https://github.com/fixture/project/pull/202" });
			await page.waitForFunction(() => document.querySelector(".session-hud-link")?.textContent === "#202");
			await answerHud(page, branchA, { number: 101, url: "https://github.com/fixture/project/pull/101" });
			expect(await page.$eval(".session-hud-link", node => ({ text: node.textContent, title: node.getAttribute("title") }))).toEqual({ text: "#202", title: "https://github.com/fixture/project/pull/202" });
			expect(await page.$eval(".session-hud", node => node.textContent)).toContain("feature/b");
			expect(await page.$eval(".session-hud", node => node.textContent)).not.toContain("feature/a");
		} finally { await closeFixture(context, page); }
	}, 30000);
});

suite("desktop response copy mounted App", () => {
	test("response copy reads the entire canonical answer once, excludes reasoning/tools, and registers clipboard during the click", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await installResponseClipboard(page);
			await publishResponse(page);
			await page.waitForSelector('.message-copy[aria-label="Copy response"]');
			await page.click(".message-copy");
			const request = await copyRequest(page);
			expect(request.params).toEqual({ sessionId: "a", sessionGeneration: 1, entryId: "canonical-answer" });
			await page.evaluate(() => {
				const button = document.querySelector<HTMLButtonElement>(".message-copy");
				button?.click(); button?.click();
			});
			expect(await page.$eval(".message-copy", button => ({ disabled: (button as HTMLButtonElement).disabled, busy: button.getAttribute("aria-busy") }))).toEqual({ disabled: true, busy: "true" });
			expect(await page.evaluate(() => window.fixture.requests().filter(r => r.method === "message.copyText").length)).toBe(1);
			expect(await page.evaluate(() => window.responseClipboard)).toMatchObject({ writes: 1, commits: [], active: [true] });
			const full = `# Complete canonical answer\n${"canonical answer body\n".repeat(3000)}tail after 32 KiB`;
			await page.evaluate(({ id, full }) => window.fixture.copyResponse(id, full), { id: request.id, full });
			await page.waitForSelector('.message-copy-status[role="status"]');
			expect(await page.evaluate(() => window.responseClipboard.commits)).toEqual([full]);
			expect(await page.evaluate(() => window.responseClipboard.writes)).toBe(1);
			expect(await page.$eval(".message-copy-status", el => el.textContent)).toBe("Response copied.");
			expect(await page.$eval(".message-copy", el => el.querySelector("svg")?.classList.contains("lucide-check"))).toBe(true);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("prompt copy reads the exact persisted prompt from the user message header", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await installResponseClipboard(page);
			const base = responseSession();
			await publishResponse(page, responseSession({
				messages: [{
					id: "prompt", role: "user", text: "bounded prompt preview", truncated: true, entryId: "user-entry",
					copy: { entryId: "user-entry", sessionGeneration: 1 },
				}, { id: "image-only", role: "user", text: "", blocks: [{ type: "image-unavailable", reason: "Image preview is unavailable." }] }, ...base.messages],
			}));
			const prompt = '.message.user .message-header .message-copy[aria-label="Copy prompt"]';
			await page.waitForSelector(prompt);
			expect(await page.$$eval(".message.user .message-copy", nodes => nodes.length)).toBe(1);
			await page.click(prompt);
			const request = await copyRequest(page);
			expect(request.params).toEqual({ sessionId: "a", sessionGeneration: 1, entryId: "user-entry" });
			const full = `${"complete prompt line\n".repeat(2000)}  trailing  `;
			await page.evaluate(({ id, full }) => window.fixture.copyResponse(id, full), { id: request.id, full });
			await page.waitForSelector('.message.user .message-copy-status[role="status"]');
			expect(await page.evaluate(() => window.responseClipboard.commits)).toEqual([full]);
			expect(await page.$eval(".message.user .message-copy-status", el => el.textContent)).toBe("Prompt copied.");
			expect(await page.$eval(".message.assistant .message-copy", el => el.getAttribute("aria-label"))).toBe("Copy response");
		} finally { await closeFixture(context, page); }
	}, 30000);

	const editable = (revision?: DesktopMessage["revision"]) => responseSession({
		promptEditing: true,
		messages: [{
			id: "prompt", role: "user", text: "bounded prompt preview", truncated: true, entryId: "user-entry",
			copy: { entryId: "user-entry", sessionGeneration: 1 }, revision,
		}, ...responseSession().messages],
	});
	const requestsOf = (page: Page, method: string) =>
		page.evaluate(method => window.fixture.requests().filter(r => r.method === method), method);

	test("prompt edit starts from the persisted text and sends it as a branch edit", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await publishResponse(page, editable());
			const edit = '.message.user .message-header .message-edit[aria-label="Edit prompt"]';
			await page.waitForSelector(edit);
			await page.click(edit);
			const cancelRead = await copyRequest(page);
			expect(cancelRead.params).toEqual({ sessionId: "a", sessionGeneration: 1, entryId: "user-entry" });
			await page.evaluate(id => window.fixture.copyResponse(id, "discarded edit"), cancelRead.id);
			await page.waitForSelector('.prompt-editor textarea[aria-label="Edited prompt"]');
			await page.keyboard.press("Escape");
			await page.waitForSelector(".prompt-editor", { hidden: true });
			expect(await page.$eval(".message.user .message-text", el => el.textContent)).toContain("bounded prompt preview");

			await page.click(edit);
			const read = await copyRequest(page, 2);
			const full = `${"complete persisted prompt\n".repeat(40)}tail`;
			await page.evaluate(({ id, full }) => window.fixture.copyResponse(id, full), { id: read.id, full });
			await page.waitForSelector(".prompt-editor textarea");
			expect(await page.$eval(".prompt-editor textarea", (el: HTMLTextAreaElement) => el.value)).toBe(full);
			expect(await page.$(edit)).toBeNull();
			await page.$eval(".prompt-editor textarea", (el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.length));
			await page.keyboard.press("Backspace");
			expect(await page.$eval(".prompt-editor-send", el => (el as HTMLButtonElement).disabled)).toBe(true);
			await page.type(".prompt-editor textarea", "edited prompt");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => window.fixture.lastPrompt());
			const prompt = await page.evaluate(() => window.fixture.lastPrompt());
			expect(prompt?.params).toEqual({ sessionId: "a", sessionGeneration: 1, text: "edited prompt", editEntryId: "user-entry" });
			await page.waitForSelector(".prompt-editor", { hidden: true });
			expect(await page.$eval(edit, el => (el as HTMLButtonElement).disabled)).toBe(true);
			expect(await requestsOf(page, "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("a refused prompt edit is restored into the composer and a failed load can be retried", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await publishResponse(page, editable());
			const edit = ".message.user .message-edit";
			await page.waitForSelector(edit);
			await page.click(edit);
			const failed = await copyRequest(page);
			await page.evaluate(id => window.fixture.response(id, false, "Canonical read refused"), failed.id);
			await page.waitForSelector('.message.user .message-copy-error[role="alert"]');
			expect(await page.$eval(".message.user .message-copy-error", el => el.textContent)).toContain("Select Edit prompt to try again");
			expect(await page.$(".prompt-editor")).toBeNull();
			await page.click(edit);
			const read = await copyRequest(page, 2);
			await page.evaluate(id => window.fixture.copyResponse(id, "edit that the host refuses"), read.id);
			await page.waitForSelector(".prompt-editor textarea");
			expect(await page.$(".message.user .message-copy-error")).toBeNull();
			await page.click(".prompt-editor-send");
			await page.waitForFunction(() => window.fixture.lastPrompt());
			const prompt = await page.evaluate(() => window.fixture.lastPrompt());
			if (!prompt) throw new Error("Edited prompt was not recorded");
			expect(prompt.params).toMatchObject({ text: "edit that the host refuses", editEntryId: "user-entry" });
			await page.evaluate((id: string) => window.fixture.response(id, false, "Edit the prompt after the current operation finishes.", "refused"), prompt.id);
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "edit that the host refuses");
			await page.waitForFunction(() => !(document.querySelector(".message.user .message-edit") as HTMLButtonElement | null)?.disabled);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("revision arrows show the position and request the neighbouring branch", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await publishResponse(page, editable({ index: 1, count: 3, previous: "first-entry", next: "third-entry" }));
			const group = '.message.user .message-header .prompt-revision[aria-label="Prompt revisions"]';
			await page.waitForSelector(group);
			expect(await page.$eval(`${group} .prompt-revision-position`, el => el.textContent)).toBe("2/3Revision 2 of 3");
			await page.click(`${group} button[aria-label="Previous revision"]`);
			await page.waitForFunction(() => window.fixture.requests().some(r => r.method === "session.revision"));
			await page.waitForFunction(() => !(document.querySelector('.prompt-revision button[aria-label="Next revision"]') as HTMLButtonElement).disabled);
			await page.click(`${group} button[aria-label="Next revision"]`);
			await page.waitForFunction(() => window.fixture.requests().filter(r => r.method === "session.revision").length === 2);
			expect((await requestsOf(page, "session.revision")).map(r => r.params)).toEqual([
				{ sessionId: "a", entryId: "first-entry" },
				{ sessionId: "a", entryId: "third-entry" },
			]);

			await publishResponse(page, editable({ index: 0, count: 2, next: "second-entry" }));
			await page.waitForFunction(() => document.querySelector(".prompt-revision-position")?.textContent?.startsWith("1/2"));
			expect(await page.$eval('.prompt-revision button[aria-label="Previous revision"]', el => (el as HTMLButtonElement).disabled)).toBe(true);
			await publishResponse(page, { ...editable({ index: 0, count: 2, next: "second-entry" }), status: "running" });
			await page.waitForFunction(() => (document.querySelector('.prompt-revision button[aria-label="Next revision"]') as HTMLButtonElement).disabled);
			expect(await page.$eval(".message.user .message-edit", el => (el as HTMLButtonElement).disabled)).toBe(true);
			await publishResponse(page, { ...editable({ index: 0, count: 2, next: "second-entry" }), promptEditing: undefined });
			await page.waitForSelector(".prompt-revision", { hidden: true });
			expect(await page.$(".message.user .message-edit")).toBeNull();
			expect(await page.$(".message.user .message-copy")).not.toBeNull();
		} finally { await closeFixture(context, page); }
	}, 30000);

	for (const failure of ["read", "empty", "setup", "setup-read", "write"] as const) {
		test(`response copy ${failure} failure is actionable and retry reads canonical text again`, async () => {
			const { context, page } = await fixture();
			try {
				await select(page); await installResponseClipboard(page); await publishResponse(page);
				if (failure === "setup" || failure === "setup-read" || failure === "write")
					await page.evaluate(failure => { window.responseClipboard.failure = failure === "setup-read" ? "setup" : failure; }, failure);
				await page.click(".message-copy");
				const first = await copyRequest(page);
				if (failure === "read" || failure === "setup-read") await page.evaluate(id => window.fixture.response(id, false, "Canonical read refused"), first.id);
				else await page.evaluate(({ id, text }) => window.fixture.copyResponse(id, text), { id: first.id, text: failure === "empty" ? "" : "complete first answer" });
				await page.waitForSelector('.message-copy-error[role="alert"]');
				expect(await page.$eval(".message-copy-error", el => el.textContent)).toContain("Select Copy response to try again");
				expect(await page.evaluate(() => window.responseClipboard.commits)).toEqual([]);
				expect(await page.$eval(".message-copy", el => (el as HTMLButtonElement).disabled)).toBe(false);
				await page.evaluate(() => { window.responseClipboard.failure = null; });
				await page.click(".message-copy");
				const retry = await copyRequest(page, 2);
				expect(retry.id).not.toBe(first.id);
				await page.evaluate(id => window.fixture.copyResponse(id, "complete retry answer"), retry.id);
				await page.waitForSelector(".message-copy-status");
				expect(await page.evaluate(() => window.responseClipboard.commits)).toEqual(["complete retry answer"]);
				expect(await page.evaluate(() => window.responseClipboard.writes)).toBe(2);
			} finally { await closeFixture(context, page); }
		}, 30000);
	}

	for (const change of ["source", "entry", "generation", "unmount", "owner", "owner-roundtrip"] as const) {
		test(`response copy rejects a late answer after ${change} changes`, async () => {
			const { context, page } = await fixture();
			try {
				await select(page); await installResponseClipboard(page); await publishResponse(page);
				await page.click(".message-copy");
				const request = await copyRequest(page);
				if (change === "owner" || change === "owner-roundtrip") {
					await select(page, 1);
					if (change === "owner-roundtrip") {
						await select(page); await publishResponse(page);
					}
				} else if (change === "generation") {
					await publishResponse(page, responseSession({ controlGeneration: 2 }));
					await page.waitForFunction(() => !document.querySelector(".message-copy"));
				} else if (change === "unmount") {
					await publishResponse(page, responseSession({ messages: [] }));
					await page.waitForFunction(() => !document.querySelector(".message.assistant"));
				} else {
					const session = responseSession();
					session.messages[0].copy = change === "source" ? undefined : { entryId: "replacement-entry", sessionGeneration: 1 };
					await publishResponse(page, session);
					await page.waitForFunction(change => change === "source" ? !document.querySelector(".message-copy") : document.querySelector(".message-copy")?.getAttribute("aria-busy") === "false", {}, change);
				}
				await page.evaluate(id => window.fixture.copyResponse(id, "stale full answer must never commit"), request.id);
				await page.waitForFunction(() => window.responseClipboard.rejections === 1);
				expect(await page.evaluate(() => window.responseClipboard.commits)).toEqual([]);
				expect(await page.evaluate(() => window.responseClipboard.writes)).toBe(1);
				expect(await page.$(".message-copy-status")).toBeNull();
			} finally { await closeFixture(context, page); }
		}, 30000);
	}
});

const available = { available: true, reason: null };
const profilePreferences: DesktopPreferences = {
	profiles: [{
		id: "focused",
		name: "Focused profile",
		description: null,
		group: "CODEX",
		groupRank: 0,
		available: true,
		source: "configured",
		active: false,
		default: false,
		roles: [
			{ id: "default", model: "fixture/model-one" },
			{ id: "executor", model: "fixture/model-two" },
			{ id: "architect", model: null },
			{ id: "planner", model: null },
			{ id: "critic", model: null },
			{ id: "image", model: null },
		],
		capabilities: { selectSession: available, persistDefault: available },
	}],
	roles: [],
	sampling: [],
};

const deferralPreferences: DesktopPreferences = {
	...profilePreferences,
	roles: [
		{
			id: "default",
			name: "Default",
			configured: true,
			model: { id: "model-one", provider: "fixture", name: "Model One" },
			thinkingLevel: null,
			configurationResolution: { origin: "runtime", layers: ["runtime"] },
			canApply: available,
			scope: "default",
			canClear: { available: false, reason: "The default model cannot be cleared." },
		},
		{
			id: "executor",
			name: "Executor",
			configured: false,
			model: null,
			thinkingLevel: null,
			configurationResolution: { origin: "runtime", layers: ["runtime"] },
			canApply: available,
			scope: "session",
			canClear: { available: false, reason: "No session-owned role choice is present." },
		},
	],
};

async function selectionFixture(preferences: DesktopPreferences = deferralPreferences, preferencesError?: string): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await fixture();
	try {
		await page.evaluate(() => {
			window.fixture.setModels([
				{ id: "fixture/model-one", name: "Model One", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
				{ id: "fixture/model-two", name: "Model Two", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
			]);
			window.fixture.holdPreferences("preferences.get", true);
			window.fixture.holdPreferences("preferences.apply", true);
		});
		await select(page);
		await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "preferences.get"));
		const read = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").at(-1)!;
		await page.evaluate(({ id, result, error }) => window.fixture.emit(error
			? { type: "response", id, ok: false, error }
			: { type: "response", id, ok: true, result }), { id: read.id, result: preferences, error: preferencesError });
		await selectionSession(page, "idle");
		await page.waitForSelector(".model-trigger:not([disabled])");
		await page.evaluate(() => {
			const committed = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => committed.resolve()));
			return committed.promise;
		});
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function selectionSession(page: Page, status: DesktopSession["status"], generation = 1): Promise<void> {
	await page.evaluate(({ status, generation }) => window.fixture.emit({
		type: "session",
		session: {
			id: "a", title: "Session A", projectId: "p", status, starred: false,
			imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: generation,
			model: "fixture/model-one", messages: [],
		},
	}), { status, generation });
}

async function openSelectionScope(page: Page, kind: "model" | "profile"): Promise<void> {
	await page.click(".model-trigger");
	await page.waitForSelector(".model-dialog");
	await page.evaluate(kind => document.querySelectorAll<HTMLButtonElement>(".model-tab")[kind === "profile" ? 0 : 1]!.click(), kind);
	if (kind === "profile") {
		await page.waitForSelector(".preset-group-head");
		if (await page.$('.preset-group-head[aria-expanded="false"]')) await page.click(".preset-group-head");
		await page.waitForSelector('[data-profile-id="focused"]');
		await page.click('[data-profile-id="focused"]');
	} else {
		await page.click('[data-model-id="fixture/model-two"]');
		await page.waitForSelector(".model-role-option:not([disabled])");
		await page.click(".model-role-option");
	}
	await page.waitForSelector(".model-scope-choice");
}

async function selectionWrites(page: Page): Promise<DesktopRequest[]> {
	return (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set" || request.method === "preferences.apply");
}

suite("mounted model and preset scope confirmation", () => {
	test("unavailable owner preferences do not discard valid session model controls", async () => {
		const { context, page } = await selectionFixture(deferralPreferences, "Remote preferences unavailable");
		try {
			await page.waitForFunction(() => document.body.textContent?.includes("Remote preferences unavailable"));
			await openSelectionScope(page, "model");
			expect(await page.$eval('.model-scope-option[data-scope="default"]', element => (element as HTMLButtonElement).disabled)).toBe(true);
			expect(await page.$eval('.model-scope-option[data-scope="session"]', element => (element as HTMLButtonElement).disabled)).toBe(false);
			await page.click('.model-scope-option[data-scope="session"]');
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "model.set"));
			const writes = await selectionWrites(page);
			expect(writes).toHaveLength(1);
			expect(writes[0]!.method).toBe("model.set");
			expect(writes[0]!.params).toEqual({ sessionId: "a", sessionGeneration: 1, modelId: "fixture/model-two" });
		} finally { await closeFixture(context, page); }
	}, 30000);
	for (const kind of ["model", "profile"] as const) {
		for (const scope of ["session", "default"] as const) {
			test(`${kind} ${scope} confirmation dispatches the exact owner-scoped operation`, async () => {
				const { context, page } = await selectionFixture();
				try {
					await openSelectionScope(page, kind);
					expect(await selectionWrites(page)).toEqual([]);
					await page.click(`.model-scope-option[data-scope="${scope}"]`);
					await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "model.set" || request.method === "preferences.apply"));
					const writes = await selectionWrites(page);
					expect(writes).toHaveLength(1);
					if (kind === "model" && scope === "session") {
						expect(writes[0]!.method).toBe("model.set");
						expect(writes[0]!.params).toEqual({ sessionId: "a", sessionGeneration: 1, modelId: "fixture/model-two" });
					} else {
						expect(writes[0]!.method).toBe("preferences.apply");
						expect(writes[0]!.params).toEqual({
							sessionId: "a",
							action: kind === "profile"
								? { type: "profile.select", name: "focused", scope }
								: { type: "role.set", role: "default", modelId: "fixture/model-two" },
						});
						await page.waitForSelector(".model-trigger[disabled]");
						expect(await page.$$eval(".composer .model-control-status", nodes =>
							nodes.some(node => node.textContent?.includes("Applying the selected settings")),
						)).toBe(false);
					}
				} finally { await closeFixture(context, page); }
			}, 30000);
		}

		test(`${kind} default intent survives streaming and dispatches once after settling`, async () => {
			const { context, page } = await selectionFixture();
			try {
				await selectionSession(page, "running");
				await page.waitForFunction(() => document.body.textContent?.includes("Working"));
				await openSelectionScope(page, kind);
				await page.click('.model-scope-option[data-scope="default"]');
				await page.waitForSelector(".model-dialog", { hidden: true });
				expect(await selectionWrites(page)).toEqual([]);
				await selectionSession(page, "done");
				await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "preferences.apply"));
				const writes = await selectionWrites(page);
				expect(writes).toHaveLength(1);
				expect(writes[0]!.method).toBe("preferences.apply");
				expect(writes[0]!.params).toEqual({
					sessionId: "a",
					action: kind === "profile"
						? { type: "profile.select", name: "focused", scope: "default" }
						: { type: "role.set", role: "default", modelId: "fixture/model-two" },
				});
				await page.evaluate(({ id, kind, preferences }) => window.fixture.emit({
					type: "response", id, ok: true,
					result: kind === "profile"
						? { applied: "profile.select", profileId: "focused", scope: "default", durability: "persisted", preferences }
						: { applied: "role.set", role: "default", scope: "default", durability: "persisted", preferences },
				}), { id: writes[0]!.id, kind, preferences: deferralPreferences });
				await page.waitForSelector(".model-trigger:not([disabled])");
				await selectionSession(page, "done");
				await Bun.sleep(150);
				expect(await selectionWrites(page)).toHaveLength(1);
			} finally { await closeFixture(context, page); }
		}, 30000);

		test(`${kind} confirmation cannot outlive its owner's control generation`, async () => {
			const { context, page } = await selectionFixture();
			try {
				await openSelectionScope(page, kind);
				// Keep a real stale DOM callback, then replace the same session's owner.
				await page.evaluate(() => {
					const stale = document.querySelector<HTMLButtonElement>('.model-scope-option[data-scope="default"]')!;
					document.addEventListener("fixture-stale-selection", () => stale.click(), { once: true });
				});
				await selectionSession(page, "idle", 2);
				await page.waitForSelector(".model-dialog", { hidden: true });
				await page.evaluate(() => document.dispatchEvent(new Event("fixture-stale-selection")));
				await selectionSession(page, "done", 2);
				await Bun.sleep(150);
				expect(await selectionWrites(page)).toEqual([]);
			} finally { await closeFixture(context, page); }
		}, 30000);

		test(`${kind} deferred default is discarded on owner change`, async () => {
			const { context, page } = await selectionFixture();
			try {
				await selectionSession(page, "running");
				await page.waitForFunction(() => document.body.textContent?.includes("Working"));
				await openSelectionScope(page, kind);
				await page.click('.model-scope-option[data-scope="default"]');
				await page.waitForSelector(".model-dialog", { hidden: true });
				await selectionSession(page, "idle", 2);
				await page.waitForFunction(() => !document.body.textContent?.includes("Working"));
				await selectionSession(page, "done", 2);
				await Bun.sleep(150);
				expect(await selectionWrites(page)).toEqual([]);
			} finally { await closeFixture(context, page); }
		}, 30000);

		test(`${kind} deferred default cannot follow selection to another conversation`, async () => {
			const { context, page } = await selectionFixture();
			try {
				await selectionSession(page, "running");
				await page.waitForFunction(() => document.body.textContent?.includes("Working"));
				await openSelectionScope(page, kind);
				await page.click('.model-scope-option[data-scope="default"]');
				await page.waitForSelector(".model-dialog", { hidden: true });
				await select(page, 1);
				await selectionSession(page, "done");
				await Bun.sleep(150);
				expect(await selectionWrites(page)).toEqual([]);
			} finally { await closeFixture(context, page); }
		}, 30000);

		test(`${kind} cancellation and restricted defaults do not write preferences`, async () => {
			const restricted: DesktopPreferences = {
				...deferralPreferences,
				roles: deferralPreferences.roles.map(role => role.id === "default" ? { ...role, canApply: { available: false, reason: "Settings are read-only" } } : role),
				profiles: deferralPreferences.profiles.map(profile => ({ ...profile, capabilities: { ...profile.capabilities, persistDefault: { available: false, reason: "Settings are read-only" } } })),
			};
			const { context, page } = await selectionFixture(restricted);
			try {
				await openSelectionScope(page, kind);
				expect(await page.$eval('.model-scope-option[data-scope="default"]', button => (button as HTMLButtonElement).disabled)).toBe(true);
				expect(await page.$eval(".model-role-reason", reason => reason.textContent)).toBe("Settings are read-only");
				await page.click('.model-scope-option[data-scope="default"]');
				await page.keyboard.press("Escape");
				await page.waitForSelector(".model-dialog", { hidden: true });
				expect(await selectionWrites(page)).toEqual([]);
				await openSelectionScope(page, kind);
				await page.click(".model-role-cancel");
				await page.waitForSelector(".model-dialog", { hidden: true });
				expect(await selectionWrites(page)).toEqual([]);
				await openSelectionScope(page, kind);
				await page.click('.model-scope-option[data-scope="session"]');
				await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "model.set" || request.method === "preferences.apply"));
				const writes = await selectionWrites(page);
				expect(writes).toHaveLength(1);
				expect(writes[0]!.params).toEqual(kind === "profile"
					? { sessionId: "a", action: { type: "profile.select", name: "focused", scope: "session" } }
					: { sessionId: "a", sessionGeneration: 1, modelId: "fixture/model-two" });
			} finally { await closeFixture(context, page); }
		}, 30000);
	}

	test("task roles remain session-only and use the existing busy preference queue", async () => {
		const { context, page } = await selectionFixture();
		try {
			await selectionSession(page, "running");
			await page.waitForFunction(() => document.body.textContent?.includes("Working"));
			await page.click(".model-trigger");
			await page.waitForSelector('[data-model-id="fixture/model-two"]');
			await page.click('[data-model-id="fixture/model-two"]');
			await page.waitForSelector(".model-role-option");
			await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>(".model-role-option")[1]!.click());
			await page.waitForSelector(".model-dialog", { hidden: true });
			expect(await selectionWrites(page)).toEqual([]);
			await selectionSession(page, "done");
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "preferences.apply"));
			const writes = await selectionWrites(page);
			expect(writes).toHaveLength(1);
			expect(writes[0]!.params).toEqual({ sessionId: "a", action: { type: "role.set", role: "executor", modelId: "fixture/model-two" } });
		} finally { await closeFixture(context, page); }
	}, 30000);
});

suite("mounted model selection deferral", () => {
	test("applies a model chosen during a run once the session settles, without a second request", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() =>
				window.fixture.setModels([
					{ id: "fixture/model-one", name: "Model One", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
					{ id: "fixture/model-two", name: "Model Two", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
				]),
			);
			// Hold the preferences read so the role-capable fixture is authoritative.
			await page.evaluate(() => window.fixture.holdPreferences("preferences.get", true));
			await select(page);
			const read = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").at(-1)!;
			await page.evaluate(
				({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }),
				{ id: read.id, result: deferralPreferences },
			);
			await page.waitForSelector(".model-trigger:not([disabled])");
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a", title: "Session A", projectId: "p", status: "running", starred: false,
						imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [],
					},
				}),
			);
			await page.waitForFunction(() => document.body.textContent?.includes("Working"));
			await page.click(".model-trigger");
			await page.waitForSelector(".model-dialog");
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-tab")].find(tab => tab.textContent?.includes("Models"))?.click(),
			);
			await page.click('.model-option-hit[data-model-id="fixture/model-two"]');
			await page.waitForSelector(".model-role-choice");
			await page.waitForFunction(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-role-option")].some(button => !button.disabled),
			);
			await page.click(".model-role-option");
			await page.waitForSelector('.model-scope-option[data-scope="session"]:not([disabled])');
			await page.click('.model-scope-option[data-scope="session"]');
			// The chosen model shows immediately; nothing is sent and no prose explains the wait.
			await page.waitForFunction(() => document.querySelector(".model-trigger")?.textContent?.includes("Model Two"));
			expect((await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set")).toHaveLength(0);
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a", title: "Session A", projectId: "p", status: "done", starred: false,
						imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [],
					},
				}),
			);
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "model.set"));
			const applied = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set");
			expect(applied).toHaveLength(1);
			expect(applied[0]!.params).toEqual({ sessionId: "a", sessionGeneration: 1, modelId: "fixture/model-two" });
			await page.evaluate(({ id }) => window.fixture.response(id, true), { id: applied[0]!.id });
			// The host reflects the applied model; the picker follows the host, not its own intent.
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a", title: "Session A", projectId: "p", status: "done", starred: false,
						imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1,
						model: "fixture/model-two", messages: [],
					},
				}),
			);
			await page.waitForFunction(() => document.querySelector(".model-trigger")?.textContent?.includes("Model Two"));
		} finally { await closeFixture(context, page); }
	}, 30000);
});

suite("mounted deferred selection intent", () => {
	test("merges model and reasoning choices, waits for queued input, and sends one request", async () => {
		const { context, page } = await fixture();
		const sessionFrame = (status: DesktopSession["status"], queued: NonNullable<DesktopSession["queued"]>) =>
			page.evaluate(
				({ status, queued }) =>
					window.fixture.emit({
						type: "session",
						session: {
							id: "a", title: "Session A", projectId: "p", status, starred: false,
							imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1,
							model: "fixture/model-one",
							thinking: { level: "low", options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], available: true, scope: "session", mode: "effort" },
							messages: [],
							queued,
						},
					}) as unknown as Promise<void>,
				{ status, queued },
			);
		try {
			await page.evaluate(() =>
				window.fixture.setModels([
					{ id: "fixture/model-one", name: "Model One", provider: "fixture", contextWindow: 128000, reasoning: true, thinking: { options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] } },
					{ id: "fixture/model-two", name: "Model Two", provider: "fixture", contextWindow: 128000, reasoning: true, thinking: { options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] } },
				]),
			);
			await page.evaluate(() => window.fixture.holdPreferences("preferences.get", true));
			await select(page);
			const read = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").at(-1)!;
			await page.evaluate(
				({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }),
				{ id: read.id, result: deferralPreferences },
			);
			await sessionFrame("running", []);
			await page.waitForFunction(() => document.body.textContent?.includes("Working"));
			await page.click(".model-trigger");
			await page.waitForSelector(".model-dialog");
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-tab")].find(tab => tab.textContent?.includes("Models"))?.click(),
			);
			await page.click('.model-option-hit[data-model-id="fixture/model-two"]');
			await page.waitForSelector(".model-role-choice");
			await page.waitForFunction(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-role-option")].some(button => !button.disabled),
			);
			await page.click(".model-role-option");
			await page.waitForSelector('.model-scope-option[data-scope="session"]:not([disabled])');
			await page.click('.model-scope-option[data-scope="session"]');
			await page.waitForFunction(() => document.querySelector(".model-trigger")?.textContent?.includes("Model Two"));
			// A reasoning choice made while busy must merge, not replace, the model choice.
			await page.click(".reasoning-control .select-trigger");
			await page.waitForSelector(".select-menu .select-option:not([disabled])");
			await page.evaluate(() => {
				const option = [...document.querySelectorAll<HTMLButtonElement>(".select-menu .select-option")].find(
					item => item.textContent?.includes("High"),
				);
				option?.click();
			});
			await page.waitForFunction(() => document.querySelector(".reasoning-control .select-trigger")?.textContent?.includes("High"));
			// A settled session that still owns queued input is not settled.
			await sessionFrame("done", [{ id: "q1", text: "queued follow up", deliverAs: "followUp", cancelable: true }]);
			await Bun.sleep(300);
			expect(
				(await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set"),
			).toHaveLength(0);
			await sessionFrame("done", []);
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "model.set"));
			const applied = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set");
			expect(applied).toHaveLength(1);
			expect(applied[0]!.params).toEqual({ sessionId: "a", sessionGeneration: 1, modelId: "fixture/model-two", thinkingLevel: "high" });
			await page.evaluate(({ id }) => window.fixture.response(id, true), { id: applied[0]!.id });
			await sessionFrame("done", []);
			// The intent is cleared: the picker returns to the host's own model and sends nothing more.
			await page.waitForFunction(() => document.querySelector(".model-trigger")?.textContent?.includes("Model One"));
			await Bun.sleep(200);
			expect(
				(await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set"),
			).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("applies a session preset chosen during a run once the session settles", async () => {
		const { context, page } = await fixture();
		const sessionFrame = (status: DesktopSession["status"]) =>
			page.evaluate(
				({ status }) =>
					window.fixture.emit({
						type: "session",
						session: {
							id: "a", title: "Session A", projectId: "p", status, starred: false,
							imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1,
							model: "fixture/model-one", messages: [],
						},
					}) as unknown as Promise<void>,
				{ status },
			);
		try {
			await page.evaluate(() =>
				window.fixture.setModels([
					{ id: "fixture/model-one", name: "Model One", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
				]),
			);
			await page.evaluate(() => window.fixture.holdPreferences("preferences.get", true));
			await select(page);
			const read = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").at(-1)!;
			await page.evaluate(
				({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }),
				{ id: read.id, result: profilePreferences },
			);
			await sessionFrame("running");
			await page.waitForFunction(() => document.body.textContent?.includes("Working"));
			await page.click(".model-trigger");
			await page.waitForSelector(".model-dialog");
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][0]!.click());
			// Preset providers start collapsed, so the profile inside the group must be opened.
			await page.click(".preset-group-head");
			await page.waitForSelector(".preset-roles");
			await page.click('.model-option-hit[aria-label="Choose preset: Focused profile"]');
			await page.waitForSelector('.model-scope-option[data-scope="session"]:not([disabled])');
			await page.click('.model-scope-option[data-scope="session"]');
			await Bun.sleep(300);
			// A preset chosen mid-run is held, not refused and not written while streaming.
			expect(
				(await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.apply"),
			).toHaveLength(0);
			await sessionFrame("done");
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "preferences.apply"));
			await Bun.sleep(200);
			const applied = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.apply");
			expect(applied).toHaveLength(1);
			expect(applied[0]!.params).toEqual({
				sessionId: "a",
				action: { type: "profile.select", name: "focused", scope: "session" },
			});
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("a rejected deferred change restores the host value and shows the host error", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() =>
				window.fixture.setModels([
					{ id: "fixture/model-one", name: "Model One", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
					{ id: "fixture/model-two", name: "Model Two", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
				]),
			);
			await page.evaluate(() => window.fixture.holdPreferences("preferences.get", true));
			await select(page);
			const read = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").at(-1)!;
			await page.evaluate(
				({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }),
				{ id: read.id, result: deferralPreferences },
			);
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a", title: "Session A", projectId: "p", status: "running", starred: false,
						imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1,
						model: "fixture/model-one", messages: [],
					},
				}),
			);
			await page.waitForFunction(() => document.body.textContent?.includes("Working"));
			await page.click(".model-trigger");
			await page.waitForSelector(".model-dialog");
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][1]!.click());
			await page.click('.model-option-hit[data-model-id="fixture/model-two"]');
			await page.waitForSelector(".model-role-choice");
			await page.waitForFunction(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-role-option")].some(button => !button.disabled),
			);
			await page.click(".model-role-option");
			await page.waitForSelector('.model-scope-option[data-scope="session"]:not([disabled])');
			await page.click('.model-scope-option[data-scope="session"]');
			// The chosen model stays visible while the session is still running.
			await page.waitForFunction(() => document.querySelector(".model-trigger")?.textContent?.includes("Model Two"));
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a", title: "Session A", projectId: "p", status: "done", starred: false,
						imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1,
						model: "fixture/model-one", messages: [],
					},
				}),
			);
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "model.set"));
			const write = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set").at(-1)!;
			await page.evaluate(
				({ id }) => window.fixture.response(id, false, "The selected model is not available."),
				{ id: write.id },
			);
			// The host value returns and the refusal is visible instead of the old value looking applied.
			await page.waitForFunction(() => document.querySelector(".model-trigger")?.textContent?.includes("Model One"));
			// The fixture answers an unhandled method with its own refusal; either message proving
			// the host answered must reach the user, so accept the rendered alert rather than one wording.
			await page.waitForFunction(() =>
				[...document.querySelectorAll('.model-control-status [role="alert"]')].some(node =>
					/(not available|Unsupported fixture method)/iu.test(node.textContent ?? ""),
				),
			);
			expect(
				(await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set"),
			).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);
});


function workActivity(sessionId: string): DesktopActivitySnapshot {
	return {
		available: true, sessionGeneration: `session-${sessionId}`, connectionGeneration: "connection",
		jobs: [], crons: [],
		tasks: [{ type: "task", id: `task-${sessionId}`, status: "running", controls: ["cancel"], ref: { key: `task-${sessionId}`, sessionGeneration: `session-${sessionId}`, connectionGeneration: "connection" } }],
		truncated: { jobs: false, tasks: false, crons: false }, activeMonitorCount: 1, activeCronCount: 0,
		worstState: "running", failedUnacknowledged: false,
	};
}

suite("mounted Session work", () => {
	test("automatically opens a compact card for live work and preserves each owner's manual dismissal", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(activity => window.fixture.setActivity("b", activity), workActivity("b"));
			const toggle = '.toolbar button[aria-label="Session work"]';
			expect(await page.$('.toolbar button[aria-label="Activity"]')).toBeNull();
			expect(await page.$eval(toggle, element => ({ text: element.textContent?.trim(), expanded: element.getAttribute("aria-expanded"), icon: !!element.querySelector("svg") }))).toEqual({ text: "", expanded: "false", icon: true });
			expect(await page.$(".session-work-card")).toBeNull();
			await page.evaluate(activity => window.fixture.emit({ type: "activity", update: { sessionId: "a", revision: 100, activity } }), workActivity("a"));
			await page.waitForFunction(() => document.querySelector(".session-work-card .activity-entry h4")?.textContent === "task-a");
			expect(await page.$$eval(".session-work-card button", buttons => buttons.some(button => /refresh/i.test(`${button.textContent} ${button.getAttribute("aria-label") ?? ""}`)))).toBe(false);
			const bounds = await page.evaluate(() => {
				const card = document.querySelector(".session-work-card")!.getBoundingClientRect();
				const conversation = document.querySelector(".conversation")!.getBoundingClientRect();
				const composer = document.querySelector(".composer")!.getBoundingClientRect();
				const overlaps = (other: DOMRect) => card.left < other.right && card.right > other.left && card.top < other.bottom && card.bottom > other.top;
				return { conversationOverlap: overlaps(conversation), composerOverlap: overlaps(composer), height: card.height, viewport: innerHeight };
			});
			expect(bounds.conversationOverlap).toBe(false);
			expect(bounds.composerOverlap).toBe(false);
			expect(bounds.height).toBeLessThan(bounds.viewport / 2);
			const updated = workActivity("a");
			if (updated.available) updated.tasks[0]!.id = "task-a-updated";
			await page.evaluate(activity => { window.fixture.setActivity("a", activity); window.fixture.emit({ type: "activity", update: { sessionId: "a", revision: 101, activity } }); }, updated);
			await page.waitForFunction(() => document.querySelector(".session-work-card .activity-entry h4")?.textContent === "task-a-updated");
			expect(await page.$eval(toggle, el => el.getAttribute("aria-expanded"))).toBe("true");
			expect(await page.$$eval(".session-work-body .activity-actions button", buttons => buttons.map(button => button.textContent))).toEqual(["View details", "Cancel"]);
			await page.click('.session-work-header button');
			await page.waitForSelector(".session-work-card", { hidden: true });
			await page.evaluate(activity => window.fixture.emit({ type: "activity", update: { sessionId: "a", revision: 102, activity } }), updated);
			expect(await page.$(".session-work-card")).toBeNull();
			await select(page, 1);
			await page.waitForFunction(() => document.querySelector(".session-work-body .activity-entry h4")?.textContent === "task-b");
			expect(await page.$eval(".session-work-body", el => el.textContent)).not.toContain("task-a");
			await page.evaluate(activity => window.fixture.emit({ type: "activity", update: { sessionId: "a", revision: 103, activity } }), workActivity("a"));
			expect(await page.$eval(".session-work-body .activity-entry h4", el => el.textContent)).toBe("task-b");
			await select(page);
			expect(await page.$(".session-work-card")).toBeNull();
			expect(await page.$eval(toggle, el => el.getAttribute("aria-expanded"))).toBe("false");
			await page.click(toggle);
			await page.waitForSelector(".session-work-card");
			await page.click('.toolbar button[aria-label="Review changes"]');
			await page.waitForSelector(".review-card");
			expect(await page.$(".session-work-panel")).toBeNull();
			expect(await page.$eval(toggle, el => el.getAttribute("aria-expanded"))).toBe("false");
			await page.click(toggle);
			await page.waitForSelector(".session-work-panel");
			expect(await page.$(".review-card")).toBeNull();
			await page.click(toggle);
			await page.waitForSelector(".session-work-panel", { hidden: true });
			expect(await page.$eval(toggle, el => el.getAttribute("aria-expanded"))).toBe("false");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("keeps the narrow card nonmodal and closes nested detail before work without losing draft or queue", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.click('.toolbar button[aria-label="Session work"]');
			await page.waitForSelector(".session-work-card");
			expect(await page.$(".session-work-card .activity-entry")).toBeNull();
			expect(await page.$("dialog[open]")).toBeNull();
			await page.click('.session-work-header button');
			await page.waitForSelector(".session-work-card", { hidden: true });
			await page.evaluate(({ activity, session }) => { window.fixture.setActivity("a", activity); window.fixture.emit({ type: "session", session }); window.fixture.emit({ type: "activity", update: { sessionId: "a", revision: 100, activity } }); }, { activity: workActivity("a"), session: responseSession({ queued: [{ id: "queued-work", text: "keep queued work", deliverAs: "steer", cancelable: true }] }) });
			await page.type(".composer textarea", "keep this draft");
			await page.click('.toolbar button[aria-label="Session work"]');
			await page.waitForSelector(".session-work-body .activity-actions button");
			await page.click(".session-work-body .activity-actions button");
			await page.waitForFunction(() => !!document.querySelector("dialog[open]") && window.fixture.requests().some(r => r.method === "activity.detail"));
			await page.setViewport({ width: 700, height: 900 });
			await page.waitForSelector(".session-work-card");
			expect(await page.$(".session-work-sheet")).toBeNull();
			expect(await page.$("dialog[open]")).not.toBeNull();
			await page.keyboard.press("Escape");
			await page.waitForSelector("dialog[open]", { hidden: true });
			expect(await page.$(".session-work-card")).not.toBeNull();
			expect(await page.$('.session-work-card[aria-modal="true"], .session-work-backdrop')).toBeNull();
			const narrow = await page.evaluate(() => {
				const card = document.querySelector(".session-work-card")!.getBoundingClientRect();
				const conversation = document.querySelector(".conversation")!.getBoundingClientRect();
				return { bottom: card.bottom, conversationTop: conversation.top, height: card.height, viewport: innerHeight };
			});
			expect(narrow.bottom).toBeLessThanOrEqual(narrow.conversationTop);
			expect(narrow.height).toBeLessThan(narrow.viewport / 2);
			await page.keyboard.press("Escape");
			await page.waitForSelector(".session-work-panel", { hidden: true });
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("keep this draft");
			expect(await page.$eval(".queued-input", el => el.textContent)).toContain("keep queued work");
			await page.click('.toolbar button[aria-label="Session work"]');
			await page.waitForSelector(".session-work-card");
			expect(await page.$("dialog[open]")).toBeNull();
			await page.click('.session-work-header button');
			await page.waitForSelector(".session-work-panel", { hidden: true });
			expect(await page.evaluate(() => window.fixture.requests().filter(r => r.method === "prompt" || r.method === "queue.cancel"))).toHaveLength(0);
		} finally { await closeFixture(context, page); }
	}, 30000);
});

suite("mounted composer autocomplete", () => {
	test("review card stays nonmodal and preserves draft and diff across viewport changes", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.type(".composer textarea", "keep review draft");
			const toggle = '.toolbar button[aria-label="Review changes"]';
			await page.click(toggle);
			await page.waitForFunction(() => document.querySelector(".review-card")?.textContent?.includes("No changes"));
			expect(await page.$("dialog[open], .review-drawer, .review-pane")).toBeNull();
			await page.click('button[aria-label="Close review changes"]');
			expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Review changes");
			await page.evaluate(() => window.fixture.setDiffs([{ path: "src/검토.ts", status: "modified", patch: "--- old\n+++ new\n-old value\n+new value" }]));
			await page.click(toggle);
			await page.waitForSelector(".review-card .diff-output");
			const wide = await page.evaluate(() => {
				const card = document.querySelector(".review-card")!.getBoundingClientRect();
				return { left: card.left, height: card.height, viewport: innerHeight, textRight: document.querySelector(".conversation")!.getBoundingClientRect().right, composerRight: document.querySelector(".composer")!.getBoundingClientRect().right };
			});
			expect(wide.textRight).toBeLessThanOrEqual(wide.left);
			expect(wide.composerRight).toBeLessThanOrEqual(wide.left);
			expect(wide.height).toBeLessThan(wide.viewport * 0.7);
			for (const width of [700, 390]) {
				await page.setViewport({ width, height: 844 });
				const narrow = await page.evaluate(() => ({ bottom: document.querySelector(".review-card")!.getBoundingClientRect().bottom, top: document.querySelector(".conversation")!.getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth }));
				expect(narrow.bottom).toBeLessThanOrEqual(narrow.top);
				expect(narrow.overflow).toBe(false);
				expect(await page.$("dialog[open]")).toBeNull();
				expect(await page.$eval(".diff-output", el => el.textContent)).toContain("+new value");
			}
			await page.keyboard.press("Escape");
			await page.waitForSelector(".review-card", { hidden: true });
			expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Review changes");
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("keep review draft");
		} finally { await closeFixture(context, page); }
	}, 30000);
	test("review toolbar action is icon-only with an accessible name and tooltip", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			const button = await page.$eval('.toolbar button[aria-label="Review changes"]', element => ({
				text: element.textContent?.trim(), title: element.getAttribute("title"), icon: !!element.querySelector("svg"),
			}));
			expect(button).toEqual({ text: "", title: "Review changes", icon: true });
		} finally { await closeFixture(context, page); }
	});
	test("typing slash queries the current owner, opens a bounded popup and only replaces the draft", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Commands"))).toBe(false);
			expect(await page.$("#command-search, #command-input, .command-run")).toBeNull();
			await page.keyboard.down("Meta");
			await page.keyboard.press("k");
			await page.keyboard.up("Meta");
			expect(await page.$("dialog[open]")).toBeNull();
			await page.type('.composer textarea', '/');
			await page.waitForSelector('.composer-completions [role="option"]');
			const query = await page.evaluate(() => window.fixture.requests().find(request => request.method === 'composer.complete'));
			expect(query?.params).toEqual({ sessionId: 'a', sessionGeneration: 1, text: '/', cursor: 1 });
			expect(await page.$('dialog[open]')).toBeNull();
			const menu = await page.$eval('.composer-completions', element => {
				const box = element.getBoundingClientRect();
				return { above: box.bottom < document.querySelector('.composer')!.getBoundingClientRect().top, bounded: box.height <= 240, scrollable: element.scrollHeight > element.clientHeight };
			});
			expect(menu).toEqual({ above: true, bounded: true, scrollable: true });
			if (process.env.GJC_DESKTOP_VISUAL_DIR) {
				await Bun.write(`${process.env.GJC_DESKTOP_VISUAL_DIR}/app-completion-wide.png`, await page.screenshot({ fullPage: true }));
				await page.setViewport({ width: 390, height: 844 });
				await Bun.write(`${process.env.GJC_DESKTOP_VISUAL_DIR}/app-completion-narrow.png`, await page.screenshot({ fullPage: true }));
			}
			await page.click('.composer-completions [role="option"]');
			await page.waitForFunction(() => (document.querySelector('.composer textarea') as HTMLTextAreaElement).value === '/fixture-command-1 ');
			expect(await page.$eval('.composer textarea', element => ({ focus: element === document.activeElement, cursor: (element as HTMLTextAreaElement).selectionStart }))).toEqual({ focus: true, cursor: '/fixture-command-1 '.length });
			expect(await page.evaluate(() => window.fixture.requests().filter(request => request.method === 'prompt').length)).toBe(0);
			await page.keyboard.press('Enter');
			await page.waitForFunction(() => !!window.fixture.lastPrompt());
			const prompt = await page.evaluate(() => window.fixture.lastPrompt()!);
			await page.evaluate(id => {
				window.fixture.emit({ type: 'delivery', receipt: { id, sessionId: 'a', disposition: 'completed' } });
				window.fixture.emit({ type: 'response', id, ok: true, result: { consumed: true, output: 'Canonical command output' } });
			}, prompt.id);
			await page.waitForFunction(() => document.querySelector('.notice')?.textContent === 'Canonical command output');
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("a late completion from the previous session cannot replace the current draft", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() => window.fixture.holdPreferences('composer.complete', true));
			await page.type('.composer textarea', '/old');
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === 'composer.complete'));
			const old = await page.evaluate(() => window.fixture.requests().find(request => request.method === 'composer.complete')!);
			await select(page, 1);
			await page.evaluate(id => window.fixture.emit({ type: 'response', id, ok: true, result: { items: [{ value: 'old', label: 'Stale suggestion', text: '/old-owner ', cursor: 11 }] } }), old.id);
			expect(await page.$('.composer-completions [role="option"]')).toBeNull();
			expect(await page.$eval('.composer textarea', element => (element as HTMLTextAreaElement).value)).toBe('');
			expect(await page.evaluate(() => window.fixture.requests().some(request => request.method === 'prompt'))).toBe(false);
		} finally { await closeFixture(context, page); }
	}, 30000);
});

suite("mounted composer delivery recovery", () => {
	test("short workspace keeps queued inputs and recovery controls reachable", async () => {
		const { context, page } = await fixture();
		try {
			await page.setViewport({ width: 1000, height: 480 });
			await select(page);
			const prompt = await send(page, "recover this payload");
			await receipt(page, prompt, "failed");
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"] button')].some(button => button.textContent?.includes("Restore draft")));
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], queued: Array.from({ length: 30 }, (_, index) => ({ id: `queue-${index}`, text: `queued ${index} ${"long".repeat(100)}`, deliverAs: "followUp" as const, cancelable: true })) } }));
			await page.waitForSelector(".queued-input:nth-child(31)");
			const layout = await page.evaluate(() => {
				const queue = document.querySelector<HTMLElement>(".queued-inputs")!;
				const pane = document.querySelector<HTMLElement>(".main-pane")!;
				const recovery = [...document.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent?.includes("Restore draft"))!;
				const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
				const reachable = (element: HTMLElement) => {
					element.scrollIntoView({ block: "nearest", inline: "nearest" });
					const rect = element.getBoundingClientRect();
					const bounds = pane.getBoundingClientRect();
					return rect.top >= Math.max(0, bounds.top) && rect.bottom <= Math.min(innerHeight, bounds.bottom) && rect.left >= 0 && rect.right <= innerWidth;
				};
				return { queueHeight: queue.getBoundingClientRect().height, queueScrolls: queue.scrollHeight > queue.clientHeight, recovery: reachable(recovery), composer: reachable(composer), documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, width: innerWidth, height: innerHeight, documentTop: document.scrollingElement?.scrollTop };
			});
			expect(layout.queueHeight).toBeLessThanOrEqual(layout.height * 0.2 + 1);
			expect(layout.queueScrolls).toBe(true);
			expect(layout.recovery).toBe(true);
			expect(layout.composer).toBe(true);
			expect(layout.documentWidth).toBeLessThanOrEqual(layout.width);
			expect(layout.documentHeight).toBeLessThanOrEqual(layout.height);
			expect(layout.documentTop).toBe(0);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("bootstrap reconciliation of an accepted delivery never shows a recovery warning", async () => {
		const { context, page } = await fixture(true);
		try {
			await select(page); const request = await send(page, "bootstrap accepted");
			await page.evaluate((request: PromptRequest) => window.fixture.bootstrapReceipt({ id: request.id, sessionId: request.params.sessionId, disposition: "accepted" }), request);
			await page.reload(); await select(page);
			await waitStoredDisposition(page, request.id, "accepted");
			expect(await page.evaluate(() => sessionStorage.getItem("sawRecoveryNotice"))).toBeNull();
			expect(await page.evaluate((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), request.id)).toBe(false);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("bootstrap without a matching receipt exposes the retained unknown payload", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await send(page, "missing receipt payload");
			await page.reload(); await select(page);
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("the outcome is unknown")));
			expect(await page.evaluate(() => document.body.textContent?.includes("Restore draft"))).toBe(true);
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	for (const mode of ["error", "fatal"] as const) test(`failed bootstrap (${mode}) persists unknown and never replays`, async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const request = await send(page, "unconfirmed bootstrap payload");
			await page.evaluate((mode: string) => sessionStorage.setItem("failBootstrap", mode), mode);
			await page.reload();
			await waitStoredDisposition(page, request.id, "unknown");
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
			await page.reload(); await select(page);
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("the outcome is unknown")));
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Restore draft"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "unconfirmed bootstrap payload");
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	for (const mode of ["normal", "error", "fatal"] as const) test(`bootstrap (${mode}) continues later receipts for the same delivery after a save failure`, async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const request = await send(page, "multiple receipt payload");
			await page.evaluate(({ request, mode }) => {
				sessionStorage.setItem("failDeliveryPut", `${request.id}:accepted`);
				sessionStorage.setItem("bufferedReceipts", JSON.stringify([
					{ id: request.id, sessionId: request.params.sessionId, disposition: "accepted" },
					{ id: request.id, sessionId: request.params.sessionId, disposition: "failed" },
				]));
				if (mode !== "normal") sessionStorage.setItem("failBootstrap", mode);
			}, { request, mode });
			await page.reload();
			await waitStoredDisposition(page, request.id, "failed");
			if (mode !== "normal") await page.reload();
			await select(page);
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("delivery failed")));
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("failed unknown classification remains actionable in memory while later records reconcile", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(async () => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const open = indexedDB.open("gjc.desktop.delivery-recovery", 2);
					open.onsuccess = () => resolve(open.result);
					open.onerror = () => reject(open.error);
				});
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction("deliveries", "readwrite");
					const store = tx.objectStore("deliveries");
					store.put({ id: "a-unknown", sessionId: "a", text: "exact uncertain payload", attachments: [], disposition: "pending" });
					store.put({ id: "b-accepted", sessionId: "a", text: "active payload", attachments: [], disposition: "pending" });
					tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
				});
				db.close();
				const state = JSON.parse(sessionStorage.getItem("fixture") || '{"receipts":[],"requests":[]}') as FixtureState;
				state.receipts = [{ id: "b-accepted", sessionId: "a", disposition: "accepted" }];
				sessionStorage.setItem("fixture", JSON.stringify(state));
				sessionStorage.setItem("failDeliveryPut", "a-unknown:unknown");
			});
			await page.reload(); await select(page);
			await waitStoredDisposition(page, "a-unknown", "pending");
			await waitStoredDisposition(page, "b-accepted", "accepted");
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("the outcome is unknown")));
			expect(await page.evaluate(() => document.body.textContent?.includes("Retry recovery"))).toBe(false);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Restore draft"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "exact uncertain payload");
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
			expect(await page.evaluate(() => window.fixture.requests().some(r => r.method === "delivery.ack"))).toBe(false);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("bootstrap continues other deliveries after an isolated restoration failure", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(async () => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const open = indexedDB.open("gjc.desktop.delivery-recovery", 2);
					open.onsuccess = () => resolve(open.result);
					open.onerror = () => reject(open.error);
				});
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction("deliveries", "readwrite");
					const store = tx.objectStore("deliveries");
					store.put({ id: "a-refused", sessionId: "b", text: "refused payload", attachments: [], disposition: "pending" });
					store.put({ id: "b-missing", sessionId: "a", text: "exact missing payload", attachments: [], disposition: "pending" });
					store.put({ id: "c-accepted", sessionId: "a", text: "active payload", attachments: [], disposition: "pending" });
					tx.oncomplete = () => resolve();
					tx.onabort = () => reject(tx.error);
				});
				db.close();
				const state = JSON.parse(sessionStorage.getItem("fixture") || '{"receipts":[],"requests":[]}') as FixtureState;
				state.receipts = [
					{ id: "a-refused", sessionId: "b", disposition: "refused" },
					{ id: "c-accepted", sessionId: "a", disposition: "accepted" },
				];
				sessionStorage.setItem("fixture", JSON.stringify(state));
				sessionStorage.setItem("failBootstrapRestore", "yes");
			});
			await page.reload(); await select(page);
			await waitStoredDisposition(page, "b-missing", "unknown");
			await waitStoredDisposition(page, "c-accepted", "accepted");
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("the outcome is unknown")));
			expect(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].filter(el => el.textContent?.includes("Delivery recovery:")).length)).toBe(1);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Restore draft"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "exact missing payload");
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
			expect(await page.evaluate(() => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === "c-accepted"))).toBe(false);
			await select(page, 1);
			await page.waitForFunction(() => document.body.textContent?.includes("Retry recovery"));
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Discard recovery record"))?.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Retry recovery"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "refused payload");
			await page.waitForFunction(() => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === "a-refused"));
			expect(await page.evaluate(() => window.fixture.requests().some(r => r.method === "delivery.ack" && (r.params.deliveryId === "b-missing" || r.params.deliveryId === "c-accepted")))).toBe(false);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("delayed refusal restores attachment and merges newer text once in its original session", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await attach(page); const request = await send(page, "original");
			await step(page, "wait for sent draft to clear", () => page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === ""));
			await step(page, "type newer draft", () => page.type(".composer textarea", "newer"));
			await select(page, 1); await page.type(".composer textarea", "other session");
			await receipt(page, request, "refused"); await receipt(page, request, "refused");
			await page.evaluate((id: string) => window.fixture.response(id, false), request.id);
			await step(page, "wait for refusal acknowledgement", () => page.waitForFunction(() => window.fixture.requests().some(r => r.method === "delivery.ack")));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("other session");
			await select(page); await step(page, "wait for refusal draft restore", () => page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "original\n\nnewer"));
			expect(await page.$$(".attachment-ready")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("locked send retains newer draft and attachment-only submission is journaled", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await attach(page); const request = await send(page, "");
			expect(request.params.attachments).toHaveLength(1);
			await page.type(".composer textarea", "locked draft"); await page.click('.composer button[type="submit"]');
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("locked draft");
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("combined text and ready attachment exceeding wire limit never clears or sends", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await attach(page);
			await page.evaluate(() => {
				const textarea = document.querySelector(".composer textarea") as HTMLTextAreaElement;
				// Keep all 8 MiB while bounding individual lines, so this tests framing rather than pathological word layout.
				Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, `${"x".repeat(1023)}\n`.repeat(8192));
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction(() => document.body.textContent?.includes("8 MiB frame limit"));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value.length)).toBe(8 * 1024 * 1024);
			expect(await page.$$(".attachment-ready")).toHaveLength(1);
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("two post-handoff draft write failures unblock after explicit durable repair", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await attach(page);
			await page.type(".composer textarea", "repair twice");
			await page.evaluate(() => window.fixture.failPostHandoffDraftSave(2));
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction(() => document.body.textContent?.includes("Retry recovery"));
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Discard recovery record"))?.disabled)).toBe(true);
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
			expect(await page.$eval('.composer button[type="submit"]', (el: HTMLButtonElement) => el.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Retry recovery"))?.click());
			await page.waitForFunction(() => !(document.querySelector('.composer button[type="submit"]') as HTMLButtonElement).disabled);
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction(() => window.fixture.lastPrompt());
			expect((await page.evaluate(() => window.fixture.lastPrompt()))?.params.attachments).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("repair is offered only for the unsent delivery, never an active delivery in the same session", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const first = await send(page, "active first");
			await receipt(page, first, "accepted");
			await waitStoredDisposition(page, first.id, "accepted");
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], queued: [] } }));
			await page.type(".composer textarea", "unsent second");
			await page.evaluate(() => window.fixture.failPostHandoffDraftSave(2));
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction(() => document.body.textContent?.includes("Retry recovery"));
			const panels = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')]
				.filter(el => el.textContent?.includes("Delivery recovery:"))
				.map(el => ({ text: el.textContent ?? "", repairs: [...el.querySelectorAll("button")].filter(button => button.textContent?.includes("Retry recovery")).length })));
			expect(panels).toHaveLength(1);
			expect(panels[0]?.repairs).toBe(1);
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Discard recovery record"))?.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Retry recovery"))?.click());
			await page.waitForFunction(() => !document.body.textContent?.includes("Retry recovery"));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("unsent second");
			expect(await page.evaluate((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), first.id)).toBe(false);
			expect(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("Delivery recovery:")))).toBe(false);
			await waitStoredDisposition(page, first.id, "accepted");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("post-handoff storage failure restores known-unsent payload durably before retry", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await attach(page);
			await page.type(".composer textarea", "unsent payload");
			await page.evaluate(() => window.fixture.failPostHandoffDraftSave());
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction(() => document.body.textContent?.includes("Injected post-handoff storage failure"));
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "unsent payload");
			expect(await page.$$(".attachment-ready")).toHaveLength(1);
			await page.reload(); await select(page);
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "unsent payload");
			expect(await page.$$(".attachment-ready")).toHaveLength(1);
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("classified pre-admission refusal restores without a receipt frame", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await attach(page); const request = await send(page, "preflight rejected");
			await page.evaluate((id: string) => window.fixture.response(id, false, "invalid request", "refused"), request.id);
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "preflight rejected");
			expect(await page.$$(".attachment-ready")).toHaveLength(1);
			await page.reload(); await select(page);
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "preflight rejected");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("classified failed and unclassified prompt errors never automatically restore", async () => {
		for (const disposition of ["failed", undefined] as const) {
			const { context, page } = await fixture();
			try {
				await select(page); const request = await send(page, "do not replay");
				await page.evaluate(({ id, disposition }) => window.fixture.response(id, false, "same error", disposition), { id: request.id, disposition });
				await page.waitForFunction(copy => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes(copy)), {}, disposition === "failed" ? "delivery failed" : "the outcome is unknown");
				expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("");
				const panel = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].find(el => el.textContent?.includes("Delivery recovery:"))?.textContent ?? "");
				expect(panel).toContain(disposition === "failed" ? "Some work may already have run." : "It may already have run.");
				expect(panel).toContain("Restore draft");
				expect(panel).toContain(disposition === "failed" ? "Discard recovery record" : "Restoring the draft will not resend it automatically");
			} finally { await closeFixture(context, page); }
		}
	}, 30000);

	test("active deliveries cannot be discarded before their final outcome", async () => {
		const { context, page } = await fixture(true);
		try {
			await select(page); const request = await send(page, "retain active");
			for (const disposition of ["pending", "accepted", "queued"] as const) {
				await receipt(page, request, disposition);
				await waitStoredDisposition(page, request.id, disposition);
				expect(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("Delivery recovery:")))).toBe(false);
				expect(await page.evaluate((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), request.id)).toBe(false);
			}
			await receipt(page, request, "completed");
			await page.waitForFunction((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), {}, request.id);
			expect(await page.evaluate(() => sessionStorage.getItem("sawRecoveryNotice"))).toBeNull();
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("fatal after a successful queued response exposes durable uncertainty without replay", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [] } }));
			// No delivery choice is offered: a prompt typed during a run is queued and steered.
			expect(await page.$(".composer-delivery")).toBeNull();
			const request = await send(page, "queued disconnect payload");
			expect(request.params.deliverAs).toBe("steer");
			await receipt(page, request, "queued");
			await waitStoredDisposition(page, request.id, "queued");
			await page.evaluate((id: string) => window.fixture.response(id, true), request.id);
			await page.type(".composer textarea", "newer draft");
			await page.waitForFunction(() => !(document.querySelector('.composer button[type="submit"]') as HTMLButtonElement).disabled);
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await waitStoredDisposition(page, request.id, "unknown");
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("the outcome is unknown")));
			expect(await page.evaluate((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), request.id)).toBe(false);
			await page.evaluate(() => window.fixture.failNextAck("error"));
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Restore draft"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "queued disconnect payload\n\nnewer draft");
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("failed acknowledgement does not block a new draft or become an unsent repair", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const first = await send(page, "ack failure payload");
			await page.evaluate(() => window.fixture.failNextAck("error"));
			await receipt(page, first, "removed");
			await page.waitForFunction(() => document.body.textContent?.includes("Delivery acknowledgement error"));
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "ack failure payload");
			expect(await page.evaluate(() => document.body.textContent?.includes("Retry recovery"))).toBe(false);
			await page.evaluate((id: string) => window.fixture.response(id, true), first.id);
			await page.waitForFunction(() => !(document.querySelector('.composer button[type="submit"]') as HTMLButtonElement).disabled);
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction((id: string) => window.fixture.lastPrompt()?.id !== id, {}, first.id);
		} finally { await closeFixture(context, page); }
	}, 30000);

	for (const mode of ["lost", "error"] as const) test(`finalization survives ${mode} acknowledgement and stale duplicate receipt`, async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const request = await send(page, "restore once");
			await page.evaluate((mode: "lost" | "error") => window.fixture.failNextAck(mode), mode);
			await receipt(page, request, "removed");
			await page.waitForFunction(() => window.fixture.requests().some(r => r.method === "delivery.ack"));
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "restore once");
			if (mode === "lost") {
				await page.evaluate((id: string) => window.fixture.response(id, true), request.id);
				await page.type(".composer textarea", " newer");
				await attach(page);
				await page.click('.composer button[type="submit"]');
				await page.waitForFunction((id: string) => window.fixture.lastPrompt()?.id !== id, {}, request.id);
				const next = await page.evaluate(() => window.fixture.lastPrompt());
				expect(next?.params.attachments).toHaveLength(1);
				if (!next) throw new Error("Second prompt was not recorded");
				await receipt(page, next, "failed");
				await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("delivery failed")));
			}
			await receipt(page, request, "accepted");
			await page.reload(); await select(page);
			await page.waitForFunction(() => window.fixture.requests().filter(r => r.method === "delivery.ack").length >= 2);
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe(mode === "lost" ? "" : "restore once");
			if (mode === "lost") {
				await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("delivery failed")));
				await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Restore draft"))?.click());
				await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "restore once newer");
				expect(await page.$$(".attachment-ready")).toHaveLength(1);
			}
			await page.reload(); await select(page);
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe(mode === "lost" ? "restore once newer" : "restore once");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("identical errors deduplicate only by request owner", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const request = await send(page, "owner test");
			await page.evaluate((request: PromptRequest) => {
				const session: DesktopSession = { id: "a", title: "Session A", projectId: "p", status: "error", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], error: "same error", errorOwner: "another-request" };
				window.fixture.emit({ type: "session", session });
				window.fixture.response(request.id, false, "same error");
			}, request);
			await page.waitForFunction(() => [...document.querySelectorAll('.error-banner')].filter(el => el.textContent?.includes('same error')).length === 2);
			await page.evaluate((id: string) => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "error", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], error: "same error", errorOwner: id } }), request.id);
			await page.waitForFunction(() => [...document.querySelectorAll('.error-banner')].filter(el => el.textContent?.includes('same error')).length === 1);
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.desktop-sidebar button')].find(button => button.textContent?.trim() === 'Settings')?.click());
			await page.waitForSelector('dialog[open]');
			expect(await page.evaluate(() => [...document.querySelectorAll('.error-banner')].filter(el => el.textContent?.includes('same error')).length)).toBe(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("the run status lives in the sidebar row, not in the conversation header", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a",
						title: "Session A",
						projectId: "p",
						status: "running",
						starred: false,
						imageInput: { supported: true, blocked: false },
						operatorRunning: false,
						controlGeneration: 1,
						messages: [],
					},
				}) as unknown as Promise<void>,
			);
			await page.waitForFunction(() => document.body.textContent?.includes("Working"));
			// The composer's stop action and the sidebar row already say a turn is running; a
			// third copy in the header only pushed the conversation down.
			const occurrences = await page.evaluate(
				() => (document.body.textContent ?? "").split("Working").length - 1,
			);
			expect(occurrences).toBe(1);
			expect(await page.$(".main-pane .session-status")).toBeNull();
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("a dropdown pressed a second time closes and stays closed", async () => {
		const { context, page } = await fixture();
		try {
			// The reasoning control stays disabled until its model is in the catalog, so the
			// fixture needs a reasoning-capable model before the menu can open at all.
			await page.evaluate(() =>
				window.fixture.setModels([
					{
						id: "fixture/model-one",
						name: "Model One",
						provider: "fixture",
						contextWindow: 128000,
						reasoning: true,
						thinking: {
							options: [
								{ value: "low", label: "Low" },
								{ value: "high", label: "High" },
							],
						},
					},
				]),
			);
			await select(page);
			await Bun.sleep(300);
			// The fixture's own sessions carry no reasoning, so this frame is what enables the menu.
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a",
						title: "Session A",
						projectId: "p",
						status: "idle",
						starred: false,
						imageInput: { supported: true, blocked: false },
						operatorRunning: false,
						controlGeneration: 1,
						model: "fixture/model-one",
						thinking: {
							level: "low",
							options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
							available: true,
							scope: "session",
							mode: "effort",
						},
						messages: [],
					},
				}) as unknown as Promise<void>,
			);
			await page.waitForSelector(".reasoning-control .select-trigger:not([disabled])");
			const trigger = await page.evaluate(() => {
				const rect = document.querySelector(".reasoning-control .select-trigger")!.getBoundingClientRect();
				return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			});
			const openMenus = async () => page.evaluate(() => document.querySelectorAll(".select-menu").length);
			await page.mouse.click(trigger.x, trigger.y);
			await page.waitForSelector(".select-menu");
			// The press itself closes the menu. Closing on the click instead left the window open for
			// the host to reopen, which is what turned a second press into close-then-open.
			await page.mouse.move(trigger.x, trigger.y);
			await page.mouse.down();
			await page.waitForFunction(() => document.querySelectorAll(".select-menu").length === 0);
			await page.mouse.up();
			// The click that follows the closing press must not reopen it.
			await Bun.sleep(150);
			expect(await openMenus()).toBe(0);
			await page.mouse.click(trigger.x, trigger.y);
			await page.waitForSelector(".select-menu");
			expect(await openMenus()).toBe(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("app settings hold no conversation model or reasoning controls", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>("button")]
					.find(button => button.textContent?.trim() === "Settings")
					?.click(),
			);
			await page.waitForSelector(".settings-tabs");
			const general = await page.evaluate(() => {
				const panel = document.querySelector('.settings-panel:not([hidden])');
				return {
					hasModelTrigger: !!panel?.querySelector(".model-trigger"),
					hasReasoning: !!panel?.querySelector(".select-trigger[aria-label^=\"Reasoning level\"]"),
					hasRoleTags: !!panel?.querySelector(".model-controls"),
				};
			});
			// Model and reasoning belong to the conversation, not to app-wide settings.
			expect(general).toEqual({ hasModelTrigger: false, hasReasoning: false, hasRoleTags: false });
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".settings-tab")]
					.find(tab => tab.textContent?.trim() === "Account")
					?.click(),
			);
			const account = await page.evaluate(() => {
				const panel = document.querySelector(".settings-panel:not([hidden])");
				return {
					nativeSelects: panel?.querySelectorAll("select").length ?? 0,
					listboxes: panel?.querySelectorAll('button[aria-haspopup="listbox"]').length ?? 0,
				};
			});
			// Every choice list uses the app's own listbox instead of a native macOS menu.
			expect(account.nativeSelects).toBe(0);
			expect(account.listboxes).toBeGreaterThan(0);
		} finally { await closeFixture(context, page); }
	}, 40000);

	test("the settings button opens a real tab instead of passing the click event", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.click('button[aria-label="Settings"]');
			await page.waitForSelector(".settings-tabs");
			const state = await page.evaluate(() => ({
				selected: [...document.querySelectorAll('.settings-tab[aria-selected="true"]')].map(tab => tab.textContent?.trim()),
				visiblePanels: document.querySelectorAll(".settings-panel:not([hidden])").length,
				focusableTabs: [...document.querySelectorAll(".settings-tab")].filter(tab => tab.getAttribute("tabindex") === "0").length,
			}));
			// A click event must never reach the tab state: it would hide every panel and leave
			// the whole tab list unreachable from the keyboard.
			expect(state.selected).toEqual(["General"]);
			expect(state.visiblePanels).toBe(1);
			expect(state.focusableTabs).toBe(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("the composer keeps one icon action beside the model controls and turns it into stop", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a",
						title: "Session A",
						projectId: "p",
						status: "running",
						starred: false,
						imageInput: { supported: true, blocked: false },
						operatorRunning: false,
						controlGeneration: 1,
						messages: [],
					},
				}),
			);
			const idle = await page.evaluate(() => {
				const footer = document.querySelector(".composer-footer");
				const controls = footer?.querySelector(".composer-controls");
				const actions = footer?.querySelector(".composer-actions");
				const buttons = [...(actions?.querySelectorAll("button") ?? [])];
				const rowOf = (element: Element | null | undefined) => {
					if (!element) return null;
					const box = element.getBoundingClientRect();
					return { top: Math.round(box.top), height: Math.round(box.height), text: (element.textContent ?? "").trim() };
				};
				return {
					hasFooter: !!footer,
					controlsInsideFooter: !!controls,
					actionsInsideFooter: !!actions,
					buttonCount: buttons.length,
					buttonType: buttons[0]?.getAttribute("type"),
					buttonLabel: buttons[0]?.getAttribute("aria-label"),
					buttonText: (buttons[0]?.textContent ?? "").trim(),
					selects: [...document.querySelectorAll(".composer select")].length,
					attachmentRow: rowOf(controls?.querySelector(".attachment-trigger")),
					attachmentFirst: controls?.querySelector("button")?.classList.contains("attachment-trigger"),
					inputOnly: document.querySelector(".composer-input")?.children.length === 1,
					controlsRow: rowOf(controls?.querySelector(".model-trigger")),
					reasoningRow: rowOf(controls?.querySelector(".select-trigger")),
					actionRow: rowOf(buttons[0]),
				};
			});
			// Model trigger, reasoning trigger and the single action share one row.
			expect(idle.hasFooter).toBe(true);
			expect(idle.controlsInsideFooter).toBe(true);
			expect(idle.actionsInsideFooter).toBe(true);
			expect(idle.buttonCount).toBe(1);
			expect(idle.buttonType).toBe("button");
			expect(idle.buttonLabel).toBe("Stop");
			expect(idle.buttonText).toBe("");
			expect(idle.selects).toBe(0);
			// Same line means their vertical bands overlap, which holds even when the model
			// control adds a status line underneath. The reasoning trigger must be on it too.
			expect(idle.attachmentFirst).toBe(true);
			expect(idle.inputOnly).toBe(true);
			const bands = [idle.attachmentRow, idle.controlsRow, idle.reasoningRow, idle.actionRow];
			for (const band of bands) expect(band).not.toBeNull();
			for (const band of bands) {
				expect((band?.top ?? 0)).toBeGreaterThanOrEqual((idle.actionRow?.top ?? 0) - 0.5);
				expect((band?.top ?? 0)).toBeLessThan((idle.actionRow?.top ?? 0) + (idle.actionRow?.height ?? 0));
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			if (process.env.GJC_DESKTOP_VISUAL_DIR) {
				await Bun.write(`${process.env.GJC_DESKTOP_VISUAL_DIR}/footer-wide.png`, await page.screenshot({ fullPage: true }));
			}
			// The same holds at a phone width: nothing overflows and the action stays on the row.
			await page.setViewport({ width: 420, height: 900 });
			await page.waitForFunction(() => window.innerWidth === 420);
			const narrow = await page.evaluate(() => {
				const footer = document.querySelector(".composer-footer");
				const action = footer?.querySelector(".composer-actions button");
				const trigger = footer?.querySelector(".model-trigger");
				const rect = (element: Element | null | undefined) =>
					element ? { top: Math.round(element.getBoundingClientRect().top) } : null;
				return {
					actionTop: rect(action)?.top ?? null,
					triggerTop: rect(trigger)?.top ?? null,
					overflow: document.documentElement.scrollWidth > window.innerWidth,
				};
			});
			expect(narrow.overflow).toBe(false);
			expect(narrow.actionTop).toBe(narrow.triggerTop);
			await attach(page);
			expect(await page.$eval('.composer-input .attachment-list', element => element.getBoundingClientRect().bottom <= document.querySelector('.composer textarea')!.getBoundingClientRect().top)).toBe(true);
			expect(await page.$('.composer-footer .attachment-list')).toBeNull();
			if (process.env.GJC_DESKTOP_VISUAL_DIR) {
				await Bun.write(`${process.env.GJC_DESKTOP_VISUAL_DIR}/footer-narrow-attachment.png`, await page.screenshot({ fullPage: true }));
			}
			await page.setViewport({ width: 1400, height: 900 });
			// Typing during a run turns the same slot back into send, still with no visible text.
			await page.type(".composer textarea", "steer this run");
			await page.waitForFunction(
				() => document.querySelector('.composer-actions button')?.getAttribute("type") === "submit",
			);
			const typed = await page.evaluate(() => {
				const button = document.querySelector(".composer-actions button");
				return {
					type: button?.getAttribute("type"),
					label: button?.getAttribute("aria-label"),
					text: (button?.textContent ?? "").trim(),
					delivery: document.querySelectorAll(".composer-delivery").length,
				};
			});
			expect(typed.type).toBe("submit");
			expect(typed.label).toBe("Send and steer the run");
			expect(typed.text).toBe("");
			expect(typed.delivery).toBe(0);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("shows the live task list and goal state the builtin tools maintain", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a",
						title: "Session A",
						projectId: "p",
						status: "running",
						starred: false,
						imageInput: { supported: true, blocked: false },
						operatorRunning: false,
						controlGeneration: 1,
						messages: [],
						todos: [
							{
								name: "Foundation",
								tasks: [
									{ content: "Read the host", status: "completed" },
									{ content: "Project todos", status: "in_progress" },
								],
							},
							{ name: "UI", tasks: [{ content: "Render the panel", status: "pending" }] },
						],
						goal: { objective: "Ship the desktop parity work", status: "active", tokensUsed: 12, timeUsedSeconds: 3 },
					},
				}),
			);
			await page.waitForSelector(".session-work-body .todo-panel");
			expect(await page.$eval('.toolbar button[aria-label="Session work"]', el => el.getAttribute("aria-expanded"))).toBe("true");
			expect(await page.$(".session-work-body .goal-status")).not.toBeNull();
			const collapsed = await page.evaluate(() => ({
				summary: document.querySelector(".todo-summary")?.textContent,
				tasks: document.querySelectorAll(".todo-task").length,
			}));
			// Collapsed it states progress and the task in flight; the full list needs one click.
			expect(collapsed.summary).toContain("1/3 tasks done");
			expect(collapsed.summary).toContain("Project todos");
			expect(collapsed.tasks).toBe(0);
			await page.click(".todo-toggle");
			await page.waitForSelector(".todo-task");
			const expanded = await page.evaluate(() => ({
				tasks: [...document.querySelectorAll(".todo-task")].map(task => `${task.className}:${task.textContent}`),
				phases: [...document.querySelectorAll(".todo-phase h3")].map(heading => heading.textContent),
				expanded: document.querySelector(".todo-toggle")?.getAttribute("aria-expanded"),
			}));
			expect(expanded.expanded).toBe("true");
			expect(expanded.phases).toEqual(["Foundation", "UI"]);
			expect(expanded.tasks).toEqual([
				"todo-task completed:Read the host",
				"todo-task in_progress:Project todos",
				"todo-task pending:Render the panel",
			]);
			const goal = await page.evaluate(() => ({
				status: document.querySelector(".goal-status")?.textContent,
				objective: document.querySelector(".goal-objective")?.textContent,
				actions: [...document.querySelectorAll(".goal-action")].map(action => action.getAttribute("aria-label")),
			}));
			expect(goal.status).toBe("Active goal");
			expect(goal.objective).toBe("Ship the desktop parity work");
			expect(goal.actions).toEqual(["Pause goal", "Complete goal", "Drop goal"]);
			// A running turn owns the session, so the actions are disabled instead of failing silently.
			const busyDisabled = await page.evaluate(() =>
				[...document.querySelectorAll(".goal-action")].map(action => (action as HTMLButtonElement).disabled),
			);
			expect(busyDisabled).toEqual([true, true, true]);
			await page.evaluate(() => {
				(document.querySelector('.goal-action[aria-label="Pause goal"]') as HTMLButtonElement | null)?.click();
			});
			expect(await page.evaluate(() => window.fixture.requests().some(r => r.method === "goal.operate"))).toBe(false);
			// Once the turn settles the same strip operates the goal.
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a",
						title: "Session A",
						projectId: "p",
						status: "done",
						starred: false,
						imageInput: { supported: true, blocked: false },
						operatorRunning: false,
						controlGeneration: 1,
						messages: [],
						goal: { objective: "Ship the desktop parity work", status: "active", tokensUsed: 12 },
					},
				}),
			);
			await page.waitForFunction(
				() => !(document.querySelector('.goal-action[aria-label="Pause goal"]') as HTMLButtonElement | null)?.disabled,
			);
			await page.click('.goal-action[aria-label="Pause goal"]');
			await page.waitForFunction(() =>
				window.fixture.requests().some(request => request.method === "goal.operate"),
			);
			expect(
				await page.evaluate(
					() => window.fixture.requests().find(request => request.method === "goal.operate")?.params,
				),
			).toEqual({ sessionId: "a", op: "pause" });
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("shows five conversations per workspace and pages the rest on demand", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => {
				const make = (id: string, title: string): DesktopSession => ({
					id,
					title,
					projectId: "p",
					status: "idle",
					starred: false,
					imageInput: { supported: true, blocked: false },
					operatorRunning: false,
					controlGeneration: 1,
					messages: [],
				});
				window.fixture.emit({
					type: "snapshot",
					snapshot: {
						protocolVersion: 1,
						projects: [{ id: "p", name: "Project", path: "/project" }],
						sessions: Array.from({ length: 12 }, (_, index) => make(`s${index}`, `Conversation ${index + 1}`)),
						models: [],
						capabilities: [],
						deliveries: [],
					},
				});
			});
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length === 5);
			const paged = await page.evaluate(() => ({
				rows: [...document.querySelectorAll(".project-group .session-row")].map(row => row.textContent),
				more: document.querySelector(".project-group .show-more")?.textContent,
			}));
			expect(paged.rows).toHaveLength(5);
			expect(paged.more).toBe("Show 5 more");
			// Each click appends one page of five, not the whole remainder.
			await page.click(".project-group .show-more");
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length === 10);
			expect(await page.$eval(".project-group .show-more", button => button.textContent)).toBe("Show 2 more");
			// The last click reveals the remainder and the button goes away.
			await page.click(".project-group .show-more");
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length === 12);
			expect(await page.$(".project-group .show-more")).toBeNull();
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("a narrow window keeps the sidebar rail and its context menu behind one Escape at a time", async () => {
		const { context, page } = await fixture();
		try {
			await page.setViewport({ width: 700, height: 900 });
			await page.evaluate(() => {
				window.fixture.emit({
					type: "snapshot",
					snapshot: {
						protocolVersion: 1,
						projects: [{ id: "p", name: "Project", path: "/project" }],
						sessions: [
							{
								id: "s1",
								title: "One",
								projectId: "p",
								status: "idle",
								starred: false,
								imageInput: { supported: true, blocked: false },
								operatorRunning: false,
								controlGeneration: 1,
								messages: [],
							},
						],
						models: [],
						capabilities: [],
						deliveries: [],
					},
				});
			});
			await page.waitForSelector(".desktop-sidebar[data-compact] .project-heading");
			expect(await page.$(".mobile-only, dialog.sidebar-drawer")).toBeNull();
			await page.evaluate(() => {
				const heading = document.querySelector(".desktop-sidebar .project-heading") as HTMLElement | null;
				heading?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 120 }));
			});
			await page.waitForSelector(".context-menu");
			expect(await page.evaluate(() => document.querySelectorAll(".context-menu").length)).toBe(1);
			// One Escape dismisses only the menu; the rail stays.
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector(".context-menu"));
			expect(await page.$(".desktop-sidebar[data-compact]")).not.toBeNull();
			// A dialog over the rail owns Escape and closes alone.
			await page.click('button[aria-label="Settings"]');
			await page.waitForSelector("dialog[open] .settings-tabs");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.querySelector("dialog[open]") === null);
			expect(await page.$(".desktop-sidebar[data-compact]")).not.toBeNull();
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("the Manage goal dialog offers only the operations the goal state allows", async () => {
		const { context, page } = await fixture();
		/** Opens conversation actions, reports whether "Manage goal" is offered, and opens it when it is. */
	const openGoalDialog = async () => {
		await page.click('button[aria-label="Conversation actions menu"]');
		await page.waitForSelector('dialog[open] nav[aria-label="Conversation actions"]');
		const manage = await page.evaluate(() => {
			const button = [...document.querySelectorAll<HTMLButtonElement>(".command-list button")].find(
				item => item.textContent?.trim() === "Manage goal",
			);
			return button ? { disabled: button.disabled } : null;
		});
		if (!manage) throw new Error("Manage goal is missing from conversation actions");
		if (manage.disabled) {
			await page.click("dialog[open] .modal-close");
			await page.waitForFunction(() => !document.querySelector("dialog[open]"));
			return null;
		}
		await page.evaluate(() =>
			[...document.querySelectorAll<HTMLButtonElement>(".command-list button")]
				.find(button => button.textContent?.trim() === "Manage goal")
				?.click(),
		);
		await page.waitForSelector("dialog[open] #objective");
		const offered = await page.evaluate(
			() =>
				[...document.querySelectorAll("dialog[open] .actions button")].map(button => button.textContent?.trim()),
		);
		// Dismiss through the dialog's own close control; Escape focus rules differ per state.
		await page.click("dialog[open] .modal-close");
		await page.waitForFunction(() => !document.querySelector("dialog[open]"));
		return offered;
	};
		// Puppeteer widens the serialized argument, so the status is narrowed back inside the page.
		const goalFrame = (input: { status: string; sessionStatus: string }) => {
			const status = input.status === "paused" ? "paused" : "active";
			window.fixture.emit({
				type: "session",
				session: {
					id: "a",
					title: "Session A",
					projectId: "p",
					status:
						input.sessionStatus === "running"
							? "running"
							: input.sessionStatus === "waiting"
								? "waiting"
								: "idle",
					starred: false,
					imageInput: { supported: true, blocked: false },
					operatorRunning: false,
					controlGeneration: 1,
					messages: [],
					goal: { objective: "Ship it", status },
				},
			});
		};
		try {
			await select(page);
			expect(await page.$(".session-work-card")).toBeNull();
			// Empty work stays closed; goal commands remain in conversation actions.
			expect(await openGoalDialog()).toEqual(["Create", "View"]);
			await page.evaluate(goalFrame, { status: "active", sessionStatus: "idle" });
			await page.waitForFunction(() => document.querySelector(".goal-status")?.textContent === "Active goal");
			expect(await openGoalDialog()).toEqual(["View", "Pause", "Complete", "Drop goal"]);
			await page.evaluate(goalFrame, { status: "paused", sessionStatus: "idle" });
			await page.waitForFunction(() => document.querySelector(".goal-status")?.textContent === "Paused goal");
			expect(await openGoalDialog()).toEqual(["View", "Resume", "Drop goal"]);
			// A turn owns the session, so the host would refuse: the command is not offered at all.
			await page.evaluate(goalFrame, { status: "active", sessionStatus: "running" });
			await page.waitForFunction(() => document.querySelector(".goal-status")?.textContent === "Active goal");
			expect(await openGoalDialog()).toBeNull();
			// Waiting on an answer is the same situation: the dialog would offer nothing.
			await page.evaluate(goalFrame, { status: "active", sessionStatus: "waiting" });
			// The row status is what carries the waiting state; the goal strip stays as it was.
			await page.waitForFunction(
				() => document.querySelector(".session-row .session-state.waiting") !== null,
			);
			expect(await openGoalDialog()).toBeNull();
		} finally {
			await closeFixture(context, page);
		}
	}, 40000);

	test("the workspace menu reorders the workspace list", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => {
				const make = (id: string): DesktopSession => ({
					id,
					title: `Conversation ${id}`,
					projectId: "p",
					status: "idle",
					starred: false,
					imageInput: { supported: true, blocked: false },
					operatorRunning: false,
					controlGeneration: 1,
					messages: [],
				});
				window.fixture.emit({
					type: "snapshot",
					snapshot: {
						protocolVersion: 1,
						projects: [
							{ id: "p", name: "Project", path: "/project" },
							{ id: "q", name: "Second", path: "/second" },
						],
						sessions: [make("s1"), make("s2")],
						models: [],
						capabilities: [],
						deliveries: [],
					},
				});
			});
			await page.waitForFunction(() => document.querySelectorAll(".project-group").length === 2);
			// Both workspaces can move, so the menu offers both directions.
			await page.evaluate(() => {
				const heading = document.querySelectorAll(".project-group .project-heading")[1];
				heading?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 200 }));
			});
			await page.waitForSelector(".context-menu [role=\"menuitem\"]");
			const items = await page.evaluate(() =>
				[...document.querySelectorAll(".context-menu [role=\"menuitem\"]")].map(item => ({
					label: item.textContent?.trim(),
					disabled: (item as HTMLButtonElement).disabled,
				})),
			);
			expect(items.map(item => item.label)).toEqual([
				"Move workspace up",
				"Move workspace down",
				"Close workspace",
			]);
			// The second and last workspace can move up but not down.
			expect(items.slice(0, 2).map(item => item.disabled)).toEqual([false, true]);
			expect(items[2]?.disabled).toBe(false);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector(".context-menu"));
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("conversation actions omit history, run settings, and rename", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.click('button[aria-label="Conversation actions menu"]');
			await page.waitForSelector('[aria-label="Conversation actions"] button');
			const labels = await page.$$eval('[aria-label="Conversation actions"] button', nodes =>
				nodes.map(node => node.textContent?.trim() ?? ""),
			);
			expect(labels.some(label => label.startsWith("Fork conversation"))).toBe(true);
			for (const removed of ["Full conversation history", "Model profiles and run settings", "Rename"])
				expect(labels.some(label => label.startsWith(removed))).toBe(false);
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("the sidebar menu renames another conversation without selecting it", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() => {
				const row = [...document.querySelectorAll(".desktop-sidebar .session-item")].find(
					node => node.querySelector(".session-title")?.textContent === "Session B",
				);
				row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 200 }));
			});
			await page.waitForSelector('.context-menu [role="menuitem"]');
			const items = await page.$$eval('.context-menu [role="menuitem"]', nodes => nodes.map(node => node.textContent?.trim()));
			expect(items).toEqual(["Open conversation", "Rename"]);
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>('.context-menu [role="menuitem"]')].at(1)?.click(),
			);
			await page.waitForSelector("#session-title");
			expect(await page.$(".context-menu")).toBeNull();
			expect(await page.$eval("#session-title", node => (node as HTMLInputElement).value)).toBe("Session B");
			await page.click("#session-title", { count: 3 });
			await page.keyboard.press("Backspace");
			const submit = '.modal form button[type="submit"]';
			expect(await page.$eval(submit, node => (node as HTMLButtonElement).disabled)).toBe(true);
			await page.type("#session-title", "Renamed B");
			await page.click(submit);
			await page.waitForFunction(() => !document.querySelector("#session-title"));
			const requests = await page.evaluate(() => window.fixture.requests());
			const renames = requests.filter(request => request.method === "session.rename").map(request => request.params);
			expect(renames).toEqual([{ sessionId: "b", title: "Renamed B" }]);
			const current = await page.$eval(".desktop-sidebar .session-select[aria-current='page'] .session-title", node => node.textContent);
			expect(current).toBe("Session A");
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("pages a long conversation list five at a time", async () => {
		const { context, page } = await fixture();
		try {
			const seed = () => {
				const make = (id: string, title: string): DesktopSession => ({
					id,
					title,
					projectId: "p",
					status: "idle",
					starred: false,
					imageInput: { supported: true, blocked: false },
					operatorRunning: false,
					controlGeneration: 1,
					messages: [],
				});
				window.fixture.emit({
					type: "snapshot",
					snapshot: {
						protocolVersion: 1,
						projects: [{ id: "p", name: "Project", path: "/project" }],
						sessions: Array.from({ length: 12 }, (_, index) => make(`s${index}`, `Conversation ${index + 1}`)),
						models: [],
						capabilities: [],
						deliveries: [],
					},
				});
			};
			await page.evaluate(seed);
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length === 5);
			// The list pages five at a time and says how many more it holds.
			expect(await page.$eval(".project-group .show-more", button => button.textContent)).toBe("Show 5 more");
			await page.click(".project-group .show-more");
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length === 10);
			await page.evaluate(() => {
				const seven = [...document.querySelectorAll<HTMLButtonElement>(".project-group .session-select")]
					.find(node => node.querySelector(".session-title")?.textContent === "Conversation 7");
				seven?.click();
			});
			await page.waitForFunction(
				() =>
					document.querySelector(".project-group .session-row.selected")?.textContent?.includes("Conversation 7") ===
					true,
			);
			await page.click(".project-group .show-more");
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length === 12);
			// Every conversation is reachable once the pages are spent, so the control disappears.
			expect(await page.$(".project-group .show-more")).toBeNull();
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("actual filesystem image and text drops become prompt attachments", async () => {
		const { context, page } = await fixture();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-file-drop-"));
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
		const text = "# 드롭 문서\r\n실제 파일 내용 𝛂\n";
		const documentPath = path.join(directory, "notes.md");
		const image = path.join(directory, "capture.png");
		await Bun.write(documentPath, text);
		await Bun.write(image, Buffer.from(png, "base64"));
		const cdp = await page.target().createCDPSession();
		const expectPromptAttachments = async () => {
			expect(await page.evaluate(() => {
				const list = document.querySelector(".attachment-list")!;
				const input = document.querySelector(".composer textarea")!;
				const footer = document.querySelector(".composer-footer")!;
				return {
					insidePrompt: !!list.closest(".composer-input"),
					aboveText: list.getBoundingClientRect().bottom <= input.getBoundingClientRect().top,
					outsideFooter: !footer.contains(list),
					pickerInFooter: !!footer.querySelector(".attachment-trigger"),
				};
			})).toEqual({ insidePrompt: true, aboveText: true, outsideFooter: true, pickerInFooter: true });
		};
		try {
			await select(page);
			const chooser = page.waitForFileChooser();
			await page.click(".attachment-trigger");
			await (await chooser).accept([documentPath]);
			await page.waitForSelector(".attachment-ready");
			await expectPromptAttachments();
			expect(await page.$eval(".attachment-chip button", button => ({
				text: button.textContent?.trim(), label: button.getAttribute("aria-label"),
				title: button.getAttribute("title"), icon: !!button.querySelector('svg[aria-hidden="true"]'),
			}))).toEqual({ text: "", label: "Remove notes.md", title: "Remove notes.md", icon: true });
			await page.click('button[aria-label="Remove notes.md"]');
			await page.waitForSelector(".attachment-chip", { hidden: true });
			const box = await page.$eval(".composer textarea", element => {
				const rect = element.getBoundingClientRect();
				return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			});
			const data = { items: [], files: [documentPath, image], dragOperationsMask: 1 };
			await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...box, data });
			await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...box, data });
			await page.waitForSelector(".attachment-drop-overlay");
			expect(await page.$eval(".attachment-drop-overlay", overlay => {
				const composer = document.querySelector(".composer")!;
				const inner = overlay.getBoundingClientRect();
				const outer = composer.getBoundingClientRect();
				const style = getComputedStyle(overlay);
				return {
					insideComposer: overlay.parentElement === composer,
					coversComposer:
						inner.width >= outer.width - 2 && inner.height >= outer.height - 2 &&
						inner.left >= outer.left && inner.right <= outer.right,
					darkened: style.backgroundColor !== getComputedStyle(composer).backgroundColor,
					passive: style.pointerEvents,
					icon: !!overlay.querySelector('svg[aria-hidden="true"]'),
					text: overlay.textContent,
				};
			})).toEqual({
				insideComposer: true,
				coversComposer: true,
				darkened: true,
				passive: "none",
				icon: true,
				text: "Drop files hereUp to 16 files · 8 MiB total",
			});
			await cdp.send("Input.dispatchDragEvent", { type: "drop", ...box, data });
			await page.waitForFunction(() => document.querySelectorAll(".attachment-ready").length === 2);
			await expectPromptAttachments();
			expect(await page.$(".attachment-drop-overlay")).toBeNull();
			expect(page.url()).toBe(`${origin}/`);
			const folder = { items: [], files: [directory], dragOperationsMask: 1 };
			for (const type of ["dragEnter", "dragOver", "drop"] as const)
				await cdp.send("Input.dispatchDragEvent", { type, ...box, data: folder });
			await page.waitForFunction(() => document.body.textContent?.includes("Folders cannot be attached"));
			expect(await page.$$(".attachment-ready").then(nodes => nodes.length)).toBe(2);
			const request = await send(page, "Use both dropped files");
			expect(request.params.attachments).toEqual([
				{ kind: "text", name: "notes.md", text },
				{ kind: "image", name: "capture.png", mimeType: "image/png", data: png },
			]);
		} finally {
			await cdp.detach();
			await closeFixture(context, page);
			await fs.rm(directory, { recursive: true, force: true });
		}
	}, 30000);

	test("filesystem drops cannot change a disconnected draft or navigate away", async () => {
		const { context, page } = await fixture();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-locked-drop-"));
		const file = path.join(directory, "locked.txt");
		await Bun.write(file, "must not enter a locked draft");
		const cdp = await page.target().createCDPSession();
		try {
			await select(page);
			await page.type(".composer textarea", "Preserve disconnected draft");
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "Backend disconnected" }));
			await page.waitForSelector(".composer[data-disabled]");
			const box = await page.$eval(".composer textarea", element => {
				const rect = element.getBoundingClientRect();
				return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			});
			const data = { items: [], files: [file], dragOperationsMask: 1 };
			for (const type of ["dragEnter", "dragOver", "drop"] as const)
				await cdp.send("Input.dispatchDragEvent", { type, ...box, data });
			expect(page.url()).toBe(`${origin}/`);
			expect(await page.$(".attachment-chip")).toBeNull();
			expect(await page.$(".attachment-drop-overlay")).toBeNull();
			expect(await page.$eval(".composer textarea", element => (element as HTMLTextAreaElement).value)).toBe("Preserve disconnected draft");
			expect((await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "prompt")).toHaveLength(0);
		} finally {
			await cdp.detach();
			await closeFixture(context, page);
			await fs.rm(directory, { recursive: true, force: true });
		}
	}, 30000);

	test("image attachment requires explicit SDK input capability", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-image-capability-"));
		const file = path.join(directory, "capability.png");
		await Bun.write(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
		try {
			for (const imageInput of [null, { supported: false, blocked: false }, { supported: true, blocked: true }]) {
				const { context, page } = await fixture();
				try {
					await select(page);
					await page.evaluate(imageInput => window.fixture.emit({ type: "session", session: {
						id: "a", title: "Session A", projectId: "p", status: "idle", starred: false,
						imageInput, operatorRunning: false, controlGeneration: 1, messages: [],
					} }), imageInput);
					await page.evaluate(() => {
						const frame = Promise.withResolvers<void>();
						requestAnimationFrame(() => frame.resolve());
						return frame.promise;
					});
					const picker = await page.$('input[type="file"]');
					await picker!.uploadFile(file);
					await page.waitForSelector(".attachment-error");
					expect(await page.$eval(".attachment-error", element => element.textContent)).toContain(
						imageInput?.blocked ? "blocked in the SDK settings" : "does not support image input",
					);
					expect(await page.$eval('.composer button[aria-label="Send"]', element => (element as HTMLButtonElement).disabled)).toBe(true);
					expect((await page.evaluate(() => window.fixture.requests())).some(request => request.method === "prompt")).toBe(false);
				} finally { await closeFixture(context, page); }
			}
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	}, 30000);

	test("a pasted document attaches while pasted text stays text", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			const paste = (kind: "file" | "text") =>
				page.evaluate(pasted => {
					const textarea = document.querySelector(".composer textarea") as HTMLTextAreaElement;
					const transfer = new DataTransfer();
					if (pasted === "file") {
						// A Finder copy arrives as a file item with no plain text beside it.
						transfer.items.add(new File(["# pasted notes"], "notes.md", { type: "text/markdown" }));
					} else {
						transfer.setData("text/plain", "pasted words");
					}
					textarea.dispatchEvent(
						new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
					);
				}, kind);
			await paste("file");
			await page.waitForSelector(".attachment-ready");
			expect(await page.$eval(".attachment-ready", node => node.textContent)).toContain("notes.md");
			// The clipboard still belongs to text when it carries text: no attachment, no swallow.
			await paste("text");
			await Bun.sleep(150);
			expect(await page.$$eval(".attachment-ready", nodes => nodes.length)).toBe(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("the font size setting is the size of the conversation text and survives a relaunch", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() => {
				const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
					item => item.textContent?.trim() === "Settings",
				);
				button?.click();
			});
			await page.waitForSelector(".font-size-control");
			// The setting names the size of the reply text, not the root: 14 has to mean that the
			// conversation itself reads at 14 pixels.
			expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("14px");
			expect(await page.$eval(".font-size-input", input => (input as HTMLInputElement).value)).toBe("14");
			expect(await page.$eval(".font-size-input", input => input.closest(".settings-section")?.textContent)).not.toContain(
				"Scales the whole app",
			);
			await page.click('.font-size-control button[aria-label="Larger text"]');
			await page.waitForFunction(() => getComputedStyle(document.body).fontSize === "15px");
			// Typing sets the value directly, and an out-of-range value waits for the field to be left.
			await page.click(".font-size-input", { clickCount: 3 });
			await page.type(".font-size-input", "18");
			await page.waitForFunction(() => getComputedStyle(document.body).fontSize === "18px");
			await page.click(".font-size-input", { clickCount: 3 });
			await page.type(".font-size-input", "99");
			expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("18px");
			await page.$eval(".font-size-input", input => (input as HTMLInputElement).blur());
			await page.waitForFunction(() => getComputedStyle(document.body).fontSize === "20px");
			await page.waitForFunction(
				() => localStorage.getItem("gjc.desktop.font-size") === "20",
			);
			await page.reload();
			await select(page);
			expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("20px");
		} finally { await closeFixture(context, page); }
	}, 40000);

	test("folds a workspace's conversations away and back", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.waitForSelector(".project-group .project-toggle");
			expect(await page.$$eval(".project-group .session-row", rows => rows.length)).toBeGreaterThan(0);
			const toggle = await page.$eval(".project-group .project-toggle", button => ({
				label: button.getAttribute("aria-label"),
				expanded: button.getAttribute("aria-expanded"),
			}));
			expect(toggle).toEqual({ label: "Hide the conversations of Project", expanded: "true" });
			await page.click(".project-group .project-toggle");
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length === 0);
			expect(
				await page.$eval(".project-group .project-toggle", button => button.getAttribute("aria-expanded")),
			).toBe("false");
			// The heading keeps its own controls while folded, so the list can be reopened.
			expect(await page.$(".project-group .project-heading")).not.toBeNull();
			await page.click(".project-group .project-toggle");
			await page.waitForFunction(() => document.querySelectorAll(".project-group .session-row").length > 0);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("closes a workspace from its context menu and asks the host to reorder lists", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => {
				const make = (id: string, title: string): DesktopSession => ({
					id,
					title,
					projectId: "p",
					status: "idle",
					starred: false,
					imageInput: { supported: true, blocked: false },
					operatorRunning: false,
					controlGeneration: 1,
					messages: [],
				});
				window.fixture.emit({
					type: "snapshot",
					snapshot: {
						protocolVersion: 1,
						projects: [
							{ id: "p", name: "Project", path: "/project" },
							{ id: "q", name: "Second", path: "/second" },
						],
						sessions: [make("s1", "One"), make("s2", "Two")],
						models: [],
						capabilities: [],
						deliveries: [],
					},
				});
			});
			await page.waitForFunction(() => document.querySelectorAll(".project-group").length === 2);
			// Use native pointer input: HTML5 drag events are not a project reorder API.
			const points = await page.evaluate(() => {
				const start = document.querySelector('.project-heading h2')!.getBoundingClientRect();
				const target = document.querySelectorAll('.project-group')[1]!.getBoundingClientRect();
				return { x: start.left + start.width / 2, y: start.top + start.height / 2, targetX: target.left + target.width / 2, targetY: target.bottom - 8 };
			});
			await page.mouse.move(points.x, points.y);
			await page.mouse.down();
			await page.mouse.move(points.targetX, points.targetY, { steps: 12 });
			await page.waitForSelector('.project-group.drop-after');
			// A downward drag inserts after the target, and the cue says so before the drop.
			expect(
				await page.evaluate(() =>
					[...document.querySelectorAll(".project-group")].map(group => ({
						dragging: group.classList.contains("dragging"),
						after: group.classList.contains("drop-after"),
						before: group.classList.contains("drop-before"),
					})),
				),
			).toEqual([
				{ dragging: true, after: false, before: false },
				{ dragging: false, after: true, before: false },
			]);
			// The actual insertion line paints without changing the group's layout.
			expect(await page.$eval('.project-group.drop-after', node => getComputedStyle(node, '::after').height)).toBe("3px");
			await page.mouse.up();
			await page.waitForFunction(() =>
				window.fixture.requests().some(request => request.method === "project.reorder"),
			);
			expect(
				await page.evaluate(
					() => window.fixture.requests().find(request => request.method === "project.reorder")?.params,
				),
			).toEqual({ ids: ["q", "p"] });
			await page.click(".project-group:first-child .project-heading", { button: "right" });
			await page.waitForSelector('.context-menu [role="menuitem"]');
			const items = await page.evaluate(() =>
				[...document.querySelectorAll('.context-menu [role="menuitem"]')].map(item => item.textContent),
			);
			expect(items).toEqual(["Move workspace up", "Move workspace down", "Close workspace"]);
			// The first workspace cannot move up, and Escape dismisses without acting.
			const bounds = await page.evaluate(() => {
				const buttons = [...document.querySelectorAll('.context-menu [role="menuitem"]')];
				return buttons.map(button => (button as HTMLButtonElement).disabled);
			});
			expect(bounds).toEqual([true, false, false]);
			await page.keyboard.press("Escape");
			expect(await page.$(".context-menu")).toBeNull();
			// The same menu opens from the keyboard, which is the non-pointer reorder path.
			await page.focus(".project-group:first-child .project-heading");
			await page.keyboard.down("Shift");
			await page.keyboard.press("F10");
			await page.keyboard.up("Shift");
			await page.waitForSelector(".context-menu");
			const menuBox = await page.evaluate(() => {
				const menu = document.querySelector(".context-menu")?.getBoundingClientRect();
				return menu ? { left: menu.left, top: menu.top, right: menu.right } : null;
			});
			expect(menuBox?.left ?? -1).toBeGreaterThanOrEqual(8);
			expect((menuBox?.right ?? 0) <= 1400).toBe(true);
			await page.evaluate(() => {
				const close = [...document.querySelectorAll('.context-menu [role="menuitem"]')].find(
					item => item.textContent === "Close workspace",
				);
				(close as HTMLElement | undefined)?.click();
			});
			await page.waitForFunction(() =>
				window.fixture.requests().some(request => request.method === "project.close"),
			);
			const closed = await page.evaluate(
				() => window.fixture.requests().find(request => request.method === "project.close")?.params,
			);
			expect(closed).toEqual({ projectId: "p" });
			expect(await page.$(".context-menu")).toBeNull();

			// Conversations have no reorder surface or move menu; pointer movement must not
			// reach either project or session reorder.
			const reorderBefore = await page.evaluate(
				() => window.fixture.requests().filter(request => request.method === "session.reorder").length,
			);
			const firstRow = await page.evaluate(() => {
				const rect = document.querySelector(".project-group .session-item")!.getBoundingClientRect();
				return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			});
			await page.mouse.move(firstRow.x, firstRow.y);
			await page.mouse.down();
			await page.mouse.move(firstRow.x + 4, firstRow.y + 40, { steps: 5 });
			await page.mouse.up();
			await Bun.sleep(150);
			expect(
				await page.evaluate(
					() => window.fixture.requests().filter(request => request.method === "session.reorder").length,
				),
			).toBe(reorderBefore);
			expect(await page.$(".project-group .session-item.dragging")).toBeNull();
		} finally {
			await closeFixture(context, page);
		}
	}, 30000);

	test("a running turn stays stoppable when its draft cannot be steered", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			// An operator-owned run keeps the draft: sending is blocked, so the slot must be stop.
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a",
						title: "Session A",
						projectId: "p",
						status: "running",
						starred: false,
						imageInput: { supported: true, blocked: false },
						operatorRunning: true,
						controlGeneration: 1,
						messages: [],
					},
				}),
			);
			await page.type(".composer textarea", "typed while the operator owns the turn");
			await page.waitForFunction(
				() => document.querySelector(".composer-actions button")?.getAttribute("aria-label") === "Stop",
			);
			const slot = await page.evaluate(() => {
				const button = document.querySelector(".composer-actions button");
				return { type: button?.getAttribute("type"), disabled: (button as HTMLButtonElement | null)?.disabled, label: button?.getAttribute("aria-label") };
			});
			expect(slot.type).toBe("button");
			expect(slot.disabled).toBe(false);
			expect(slot.label).toBe("Stop");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("the send-to-stop swap ignores an immediate second click", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() =>
				window.fixture.emit({
					type: "session",
					session: {
						id: "a",
						title: "Session A",
						projectId: "p",
						status: "running",
						starred: false,
						imageInput: { supported: true, blocked: false },
						operatorRunning: false,
						controlGeneration: 1,
						messages: [],
					},
				}),
			);
			await page.type(".composer textarea", "steer once");
			// Click send, then the same pixel again before the slot finishes becoming stop.
			await page.click(".composer-actions button");
			await page.waitForFunction(
				() => document.querySelector(".composer-actions button")?.getAttribute("aria-label") === "Stop",
			);
			await page.click(".composer-actions button");
			expect(await page.evaluate(() => window.fixture.requests().some(request => request.method === "abort"))).toBe(false);
			expect(await page.evaluate(() => window.fixture.requests().filter(request => request.method === "prompt").length)).toBe(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("settings dialog opens on the first tab and switches panels without losing the dialog", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".desktop-sidebar button")]
					.find(button => button.textContent?.trim() === "Settings")
					?.click(),
			);
			await page.waitForSelector(".settings-tabs");
			const initial = await page.evaluate(() => ({
				tabs: [...document.querySelectorAll(".settings-tab")].map(tab => tab.textContent?.trim()),
				selected: [...document.querySelectorAll('.settings-tab[aria-selected="true"]')].map(tab => tab.textContent?.trim()),
				panels: document.querySelectorAll(".settings-panel").length,
			}));
			expect(initial.tabs).toEqual(["General", "Account", "Runtime", "Updates", "Capabilities"]);
			expect(initial.selected).toEqual(["General"]);
			// All five panels stay mounted so every tab's aria-controls resolves; only one is visible.
			expect(initial.panels).toBe(5);
			expect(
				await page.evaluate(() => document.querySelectorAll(".settings-panel:not([hidden])").length),
			).toBe(1);
			expect(
				await page.evaluate(() =>
					[...document.querySelectorAll(".settings-tab")].every(
						tab => document.getElementById(tab.getAttribute("aria-controls") ?? "") !== null,
					),
				),
			).toBe(true);
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".settings-tab")]
					.find(tab => tab.textContent?.trim() === "Capabilities")
					?.click(),
			);
			await page.waitForFunction(
				() => document.querySelector('.settings-tab[aria-selected="true"]')?.textContent?.trim() === "Capabilities",
			);
			expect(
				await page.$eval(".settings-panel:not([hidden])", panel => panel.textContent?.includes("Capability")),
			).toBe(true);
			expect(await page.$("dialog[open]")).not.toBeNull();
			// The Account panel shows the sign-in section's own heading once, and the dialog's
			// generic section/form margin does not stack inside the panel.
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".settings-tab")]
					.find(tab => tab.textContent?.trim() === "Account")
					?.click(),
			);
			await page.waitForFunction(
				() => document.querySelector('.settings-tab[aria-selected="true"]')?.textContent?.trim() === "Account",
			);
			const account = await page.evaluate(() => {
				const panel = document.querySelector(".settings-panel:not([hidden])");
				const headings = [...(panel?.querySelectorAll("h3") ?? [])].map(heading => heading.textContent?.trim());
				const section = panel?.querySelector("section");
				const form = panel?.querySelector("form");
				return {
					headings,
					marginTop: section ? getComputedStyle(section).marginTop : null,
					formMarginTop: form ? getComputedStyle(form).marginTop : null,
				};
			});
			expect(account.headings.filter(heading => heading === "Account connections")).toHaveLength(1);
			expect(account.marginTop).toBe("0px");
			expect(account.formMarginTop).toBe("0px");
			// Panels are hidden, not unmounted: the same DOM node comes back, which is what keeps
			// panel-local state (an OAuth provider choice, an unsaved setting draft) alive.
			await page.evaluate(() => {
				(window as unknown as { __settingsPanel?: Element | null }).__settingsPanel = document.getElementById(
					document.querySelector(".settings-tab")?.getAttribute("aria-controls") ?? "",
				);
			});
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".settings-tab")]
					.find(tab => tab.textContent?.trim() === "Runtime")
					?.click(),
			);
			await page.waitForFunction(
				() => document.querySelector('.settings-tab[aria-selected="true"]')?.textContent?.trim() === "Runtime",
			);
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".settings-tab")]
					.find(tab => tab.textContent?.trim() === "General")
					?.click(),
			);
			await page.waitForFunction(
				() =>
					(window as unknown as { __settingsPanel?: Element | null }).__settingsPanel ===
					document.getElementById(document.querySelector(".settings-tab")?.getAttribute("aria-controls") ?? ""),
			);
			// Reopening returns to the first tab instead of resuming a previous panel.
			await page.evaluate(() => document.querySelector<HTMLButtonElement>(".modal-close")?.click());
			await page.waitForFunction(() => !document.querySelector("dialog[open]"));
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".desktop-sidebar button")]
					.find(button => button.textContent?.trim() === "Settings")
					?.click(),
			);
			await page.waitForSelector(".settings-tabs");
			expect(
				await page.evaluate(() => document.querySelector('.settings-tab[aria-selected="true"]')?.textContent?.trim()),
			).toBe("General");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("fatal and post-accept failure retain payload without automatic replay, including restart", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const request = await send(page, "uncertain"); await receipt(page, request, "accepted");
			await receipt(page, request, "failed");
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("delivery failed")));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("");
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await page.reload(); await select(page);
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("delivery failed")));
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("a refusal frame during bootstrap restores once across another restart", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await attach(page); const request = await send(page, "bootstrap payload");
			await page.evaluate((request: PromptRequest) => window.fixture.bootstrapReceipt({ id: request.id, sessionId: request.params.sessionId, disposition: "refused" }), request);
			await page.reload(); await select(page);
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "bootstrap payload");
			await page.waitForFunction(() => window.fixture.requests().some(r => r.method === "delivery.ack"));
			await page.reload(); await select(page);
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "bootstrap payload");
			expect(await page.$$(".attachment-ready")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("unknown record can only be cleared after durable restore", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await send(page, "unknown disposable");
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await page.reload(); await select(page);
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("the outcome is unknown")));
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Discard restored record"))?.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Restore draft"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "unknown disposable");
			await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent?.includes("Discard restored record"))?.disabled);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Discard restored record"))?.click());
			await page.waitForFunction(() => !document.body.textContent?.includes("Delivery recovery:"));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("unknown disposable");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("fatal uncertainty is retained across restart without automatic resend", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await send(page, "unknown payload");
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await page.reload(); await select(page);
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("the outcome is unknown")));
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("removed restores while explicit queue cancellation discards without rearming", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const first = await send(page, "removed message"); await receipt(page, first, "removed");
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "removed message");
			await page.evaluate((id: string) => window.fixture.response(id, true), first.id);
			await page.waitForFunction(() => !(document.querySelector('.composer button[type="submit"]') as HTMLButtonElement).disabled);
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], queued: [] } }));
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction((id: string) => window.fixture.lastPrompt()?.id !== id, {}, first.id);
			const second = await page.evaluate(() => window.fixture.lastPrompt());
			if (!second) throw new Error("Second prompt was not recorded");
			await page.evaluate((id: string) => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], queued: [{ id, text: "removed message", deliverAs: "steer", cancelable: true }] } }), second.id);
			await page.waitForSelector(".queued-input button"); await page.click(".queued-input button");
			await page.waitForFunction(() => window.fixture.requests().some(r => r.method === "queue.cancel"));
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "");
		} finally { await closeFixture(context, page); }
	}, 30000);
});
