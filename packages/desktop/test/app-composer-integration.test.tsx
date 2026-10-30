import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import type { DesktopDeliveryReceipt, DesktopFrame, DesktopRequest, DesktopSession } from "../../desktop-host/src/protocol";

type PromptRequest = DesktopRequest & { method: "prompt"; params: { sessionId: string; attachments?: unknown[] } };
interface FixtureState {
	receipts: DesktopDeliveryReceipt[];
	requests: DesktopRequest[];
	bootReceipt?: DesktopDeliveryReceipt;
	ackMode?: "lost" | "error";
}
interface FixtureControl {
	emit(frame: DesktopFrame): void;
	requests(): DesktopRequest[];
	lastPrompt(): PromptRequest | undefined;
	bootstrapReceipt(receipt: DesktopDeliveryReceipt): void;
	failNextAck(mode: "lost" | "error"): void;
	failPostHandoffDraftSave(count?: number): void;
	receipt(id: string, sessionId: string, disposition: DesktopDeliveryReceipt["disposition"]): void;
	response(id: string, ok: boolean, error?: string, deliveryDisposition?: "refused" | "failed" | "unknown"): void;
}
interface FixtureWindow extends Window {
	fixture: FixtureControl;
	isTauri: boolean;
	__TAURI_INTERNALS__: {
		transformCallback(callback: (event: unknown) => void): number;
		unregisterCallback(id: number): void;
		invoke(command: string, args?: { handler?: number; eventId?: number; request?: DesktopRequest }): Promise<void | number>;
	};
	__TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener(): void };
}
declare global {
	interface Window { fixture: FixtureControl; }
}

// A real Vite/Chromium app with a page-owned Tauri transport. No process-global mocks.
const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) break; } catch { /* server is starting */ }
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
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

async function fixture(): Promise<{ context: BrowserContext; page: Page }> {
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
	await page.evaluateOnNewDocument(() => {
		const w = window as unknown as FixtureWindow;
		const callbacks = new Map<number, (event: unknown) => void>();
		const listeners = new Map<number, number>();
		let serial = 0;
		let failDraftAfterHandoff = 0;
		let sawHandoff = false;
		const transaction = IDBDatabase.prototype.transaction;
		IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
			const names = Array.isArray(storeNames) ? storeNames : [storeNames];
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
			requests: () => stored().requests,
			lastPrompt: () => stored().requests.filter((r): r is PromptRequest => r.method === "prompt" && typeof r.params.sessionId === "string").at(-1),
			bootstrapReceipt: (receipt: DesktopDeliveryReceipt) => { const state = stored(); state.bootReceipt = receipt; state.receipts = []; save(state); },
			failNextAck: (mode: "lost" | "error") => { const state = stored(); state.ackMode = mode; save(state); },
			failPostHandoffDraftSave: (count = 1) => { failDraftAfterHandoff = count; sawHandoff = false; },
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
				if (command !== "engine_request" || !args.request) throw new Error(command);
				const request = args.request;
				const state = stored(); state.requests.push(request); save(state);
				if (request.method === "prompt") return;
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
				if (request.method === "models.list" || request.method === "settings.get" || request.method === "auth.keyProviders" || request.method === "auth.providers") result = [];
				if (request.method === "auth.state") result = null;
				if (request.method === "queue.cancel") {
					const prompt = state.requests.find(item => item.id === request.params.queueId);
					if (prompt && typeof prompt.params.sessionId === "string") emit({ type: "delivery", receipt: { id: prompt.id, sessionId: prompt.params.sessionId, disposition: "cancelled" } });
					result = { removed: true };
				}
				if (request.method === "activity.get") result = { sessionId: request.params.sessionId, revision: 1, activity: { available: false, reason: "Fixture has no activity backend", sessionGeneration: "fixture-session", connectionGeneration: "fixture-connection" } };
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
	});
	await step(page, "open app", () => page.goto(origin));
	await step(page, "bootstrap session list", () => page.waitForSelector(".session-select"));
	await step(page, "bootstrap connection", () => page.waitForFunction(() => !document.body.textContent?.includes("호스트에 연결하는 중")));
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
		const buttons = await page.$$(".desktop-sidebar .session-select");
		await buttons[index]!.click();
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

describe("mounted composer delivery recovery", () => {
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
				Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "x".repeat(8 * 1024 * 1024));
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
			await page.waitForFunction(() => document.body.textContent?.includes("저장 복구 다시 시도"));
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("복구 항목 버리기"))?.disabled)).toBe(true);
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
			expect(await page.$eval('.composer button[type="submit"]', (el: HTMLButtonElement) => el.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("저장 복구 다시 시도"))?.click());
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
			await page.waitForFunction(() => document.body.textContent?.includes(": accepted."));
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], queued: [] } }));
			await page.type(".composer textarea", "unsent second");
			await page.evaluate(() => window.fixture.failPostHandoffDraftSave(2));
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction(() => document.body.textContent?.includes("저장 복구 다시 시도"));
			const panels = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')]
				.filter(el => el.textContent?.includes("전송 복구"))
				.map(el => ({ text: el.textContent ?? "", repairs: [...el.querySelectorAll("button")].filter(button => button.textContent?.includes("저장 복구 다시 시도")).length })));
			expect(panels).toHaveLength(2);
			expect(panels.find(panel => panel.text.includes(": accepted."))?.repairs).toBe(0);
			expect(panels.find(panel => panel.text.includes(": refused."))?.repairs).toBe(1);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("저장 복구 다시 시도"))?.click());
			await page.waitForFunction(() => !document.body.textContent?.includes("저장 복구 다시 시도"));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("unsent second");
			expect(await page.evaluate((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), first.id)).toBe(false);
			expect(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes(": accepted.")))).toBe(true);
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
				await page.waitForFunction(status => document.body.textContent?.includes(`: ${status}.`), {}, disposition ?? "unknown");
				expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("");
			} finally { await closeFixture(context, page); }
		}
	}, 30000);

	test("active deliveries cannot be discarded before their final outcome", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const request = await send(page, "retain active");
			for (const disposition of ["pending", "accepted", "queued"] as const) {
				await receipt(page, request, disposition);
				await page.waitForFunction(status => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes(`: ${status}.`)), {}, disposition);
				const disabled = await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("복구 항목 버리기"))?.disabled);
				expect(disabled).toBe(true);
			}
			await receipt(page, request, "removed");
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "retain active");
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
				await page.waitForFunction(() => document.body.textContent?.includes("failed"));
			}
			await receipt(page, request, "accepted");
			await page.reload(); await select(page);
			await page.waitForFunction(() => window.fixture.requests().filter(r => r.method === "delivery.ack").length >= 2);
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe(mode === "lost" ? "" : "restore once");
			if (mode === "lost") {
				await page.waitForFunction(() => document.body.textContent?.includes("failed"));
				await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("초안 복원"))?.click());
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
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.desktop-sidebar button')].find(button => button.textContent?.trim() === '설정')?.click());
			await page.waitForSelector('dialog[open]');
			expect(await page.evaluate(() => [...document.querySelectorAll('.error-banner')].filter(el => el.textContent?.includes('same error')).length)).toBe(1);
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("fatal and post-accept failure retain payload without automatic replay, including restart", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); const request = await send(page, "uncertain"); await receipt(page, request, "accepted");
			await receipt(page, request, "failed");
			await page.waitForFunction(() => document.body.textContent?.includes("failed"));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("");
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await page.reload(); await select(page);
			await page.waitForFunction(() => document.body.textContent?.includes("failed"));
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
			await page.waitForFunction(() => document.body.textContent?.includes("unknown"));
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("복원한 기록 지우기"))?.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("초안 복원"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "unknown disposable");
			await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent?.includes("복원한 기록 지우기"))?.disabled);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("복원한 기록 지우기"))?.click());
			await page.waitForFunction(() => !document.body.textContent?.includes("전송 복구"));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("unknown disposable");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("fatal uncertainty is retained across restart without automatic resend", async () => {
		const { context, page } = await fixture();
		try {
			await select(page); await send(page, "unknown payload");
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await page.reload(); await select(page);
			await page.waitForFunction(() => document.body.textContent?.includes("unknown"));
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
