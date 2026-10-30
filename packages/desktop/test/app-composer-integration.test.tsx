import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import type { DesktopPreferences } from "../../desktop-host/src/preferences-protocol";
import type { DesktopDeliveryReceipt, DesktopFrame, DesktopModel, DesktopRequest, DesktopSession } from "../../desktop-host/src/protocol";

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
	holdPreferences(method: "preferences.get" | "preferences.apply", hold: boolean): void;
	setModels(models: DesktopModel[]): void;
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
				if ([...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 복구")))
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
			requests: () => stored().requests,
			lastPrompt: () => stored().requests.filter((r): r is PromptRequest => r.method === "prompt" && typeof r.params.sessionId === "string").at(-1),
			bootstrapReceipt: (receipt: DesktopDeliveryReceipt) => { const state = stored(); state.bootReceipt = receipt; state.receipts = []; save(state); },
			failNextAck: (mode: "lost" | "error") => { const state = stored(); state.ackMode = mode; save(state); },
			failPostHandoffDraftSave: (count = 1) => { failDraftAfterHandoff = count; sawHandoff = false; },
			holdPreferences: (method, hold) => { if (hold) heldPreferences.add(method); else heldPreferences.delete(method); },
			setModels: value => { models = value; },
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
				if (request.method === "prompt" || heldPreferences.has(request.method)) return;
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
				if (request.method === "models.list") result = models;
				if (request.method === "settings.get" || request.method === "auth.keyProviders" || request.method === "auth.providers") result = [];
				if (request.method === "auth.state") result = null;
				if (request.method === "preferences.get") result = { profiles: [], roles: [], sampling: [] };
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
	}, observeRecoveryNotices);
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

const available = { available: true, reason: null };
const profilePreferences: DesktopPreferences = {
	profiles: [{
		id: "focused",
		name: "Focused profile",
		description: null,
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
const refreshedPreferences: DesktopPreferences = {
	...profilePreferences,
	roles: [{ id: "executor", name: "Executor", configured: true, model: { id: "model-one", provider: "fixture", name: "Model One" }, thinkingLevel: null, configurationResolution: { origin: "runtime", layers: ["runtime"] }, canApply: available, scope: "session", canClear: available }],
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

async function openPreferences(page: Page) {
	await page.click('button[title="대화 작업 메뉴"]');
	await page.waitForSelector('[aria-label="현재 대화 작업"]');
	await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="현재 대화 작업"] button')].find(button => button.textContent?.includes("모델 프로필과 실행 설정"))?.click());
	await page.waitForSelector(".preferences-panel");
}

describe("mounted preference ownership", () => {
	test("late preferences from a retired generation cannot expose capabilities", async () => {
		const { context, page } = await fixture();
		try {
			await select(page);
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "preferences.get"));
			await page.evaluate(() => window.fixture.holdPreferences("preferences.get", true));
			const before = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").length;
			await openPreferences(page);
			await page.waitForFunction(count => window.fixture.requests().filter(request => request.method === "preferences.get").length === count + 1, {}, before);
			const old = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").at(-1)!;
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "idle", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 2, messages: [] } }));
			await page.waitForFunction(count => window.fixture.requests().filter(request => request.method === "preferences.get").length >= count + 3, {}, before);
			const current = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").slice(before + 1);
			expect(current.every(request => request.params.sessionId === "a" && request.id !== old.id)).toBe(true);
			await page.evaluate(({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }), { id: old.id, result: profilePreferences });
			await page.evaluate(() => {
				const committed = Promise.withResolvers<void>();
				requestAnimationFrame(() => requestAnimationFrame(() => committed.resolve()));
				return committed.promise;
			});
			expect(await page.$(".profile-option")).toBeNull();
			await page.evaluate(() => document.querySelector<HTMLButtonElement>('.profile-option button[aria-label="Focused profile (focused): 이 대화에 적용"]')?.click());
			expect((await page.evaluate(() => window.fixture.requests())).some(request => request.method === "preferences.apply")).toBe(false);
			for (const request of current) await page.evaluate(({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }), { id: request.id, result: profilePreferences });
			await page.waitForSelector('.profile-option button[aria-label="Focused profile (focused): 이 대화에 적용"]:not([disabled])');
			expect(await page.$eval(".profile-option h4", element => element.textContent)).toBe("Focused profile");
		} finally { await closeFixture(context, page); }
	}, 30000);

	test("profile apply refreshes model roles without selecting a default model", async () => {
		const { context, page } = await fixture();
		try {
			await page.evaluate(() => window.fixture.setModels([{ id: "fixture/model-one", name: "Model One", provider: "fixture", contextWindow: 128000, reasoning: false, thinking: { options: [] } }]));
			await select(page);
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "models.list") && window.fixture.requests().some(request => request.method === "preferences.get"));
			await page.waitForSelector(".model-trigger:not([disabled])");
			await page.evaluate(() => { window.fixture.holdPreferences("preferences.get", true); window.fixture.holdPreferences("preferences.apply", true); });
			const before = await page.evaluate(() => window.fixture.requests());
			await openPreferences(page);
			await page.waitForFunction(count => window.fixture.requests().filter(request => request.method === "preferences.get").length > count, {}, before.filter(request => request.method === "preferences.get").length);
			const read = (await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.get").at(-1)!;
			await page.evaluate(({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }), { id: read.id, result: profilePreferences });
			await page.waitForSelector('.profile-option button[aria-label="Focused profile (focused): 이 대화에 적용"]:not([disabled])');
			await page.click('.profile-option button[aria-label="Focused profile (focused): 이 대화에 적용"]');
			await page.waitForFunction(() => window.fixture.requests().some(request => request.method === "preferences.apply"));
			const apply = (await page.evaluate(() => window.fixture.requests())).find(request => request.method === "preferences.apply")!;
			expect(apply.params).toEqual({ sessionId: "a", action: { type: "profile.select", name: "focused", scope: "session" } });
			const beforeRefresh = await page.evaluate(() => window.fixture.requests());
			await page.evaluate(({ id, preferences }) => window.fixture.emit({ type: "response", id, ok: true, result: { applied: "profile.select", profileId: "focused", scope: "session", durability: "session", preferences } }), { id: apply.id, preferences: refreshedPreferences });
			await page.waitForFunction(({ models, preferences }) => window.fixture.requests().filter(request => request.method === "models.list").length > models && window.fixture.requests().filter(request => request.method === "preferences.get").length > preferences, {}, { models: beforeRefresh.filter(request => request.method === "models.list").length, preferences: beforeRefresh.filter(request => request.method === "preferences.get").length });
			const refreshRequests = (await page.evaluate(() => window.fixture.requests())).slice(beforeRefresh.length);
			const refreshModel = refreshRequests.find(request => request.method === "models.list")!;
			const refreshRead = refreshRequests.find(request => request.method === "preferences.get")!;
			expect(refreshModel.params.sessionId).toBe("a");
			expect(refreshRead.params.sessionId).toBe("a");
			await page.evaluate(({ id, result }) => window.fixture.emit({ type: "response", id, ok: true, result }), { id: refreshRead.id, result: refreshedPreferences });
			await page.click('.modal-close[aria-label="닫기"]');
			await page.waitForSelector(".model-trigger:not([disabled])");
			await page.click(".model-trigger");
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")].find(tab => tab.textContent?.includes("모델"))?.click());
			await page.waitForFunction(() => document.querySelector('.model-option-hit[data-model-id="fixture/model-one"] .model-role-tags')?.textContent?.includes("Executor"));
			await page.click('.model-option-hit[data-model-id="fixture/model-one"]');
			await page.waitForSelector(".model-role-choice");
			expect((await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set")).toHaveLength(0);
			expect((await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "preferences.apply")).toHaveLength(1);
		} finally { await closeFixture(context, page); }
	}, 30000);
});


describe("mounted model selection deferral", () => {
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
			await page.waitForFunction(() => document.body.textContent?.includes("작업 중"));
			await page.click(".model-trigger");
			await page.waitForSelector(".model-dialog");
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-tab")].find(tab => tab.textContent?.includes("모델"))?.click(),
			);
			await page.click('.model-option-hit[data-model-id="fixture/model-two"]');
			await page.waitForSelector(".model-role-choice");
			await page.waitForFunction(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-role-option")].some(button => !button.disabled),
			);
			await page.click(".model-role-option");
			await page.waitForFunction(() => document.body.textContent?.includes("작업이 끝난 뒤 적용합니다"));
			expect(
				(await page.evaluate(() => window.fixture.requests())).filter(request => request.method === "model.set"),
			).toHaveLength(0);
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
			expect(applied[0]!.params).toEqual({ sessionId: "a", modelId: "fixture/model-two" });
			await page.evaluate(({ id }) => window.fixture.response(id, true), { id: applied[0]!.id });
			await page.waitForFunction(() => !document.body.textContent?.includes("작업이 끝난 뒤 적용합니다"));
		} finally { await closeFixture(context, page); }
	}, 30000);
});

describe("mounted deferred selection intent", () => {
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
							thinking: { level: "low", options: [{ value: "low", label: "낮음" }, { value: "high", label: "높음" }], available: true, scope: "session", mode: "effort" },
							messages: [],
							queued,
						},
					}) as unknown as Promise<void>,
				{ status, queued },
			);
		try {
			await page.evaluate(() =>
				window.fixture.setModels([
					{ id: "fixture/model-one", name: "Model One", provider: "fixture", contextWindow: 128000, reasoning: true, thinking: { options: [{ value: "low", label: "낮음" }, { value: "high", label: "높음" }] } },
					{ id: "fixture/model-two", name: "Model Two", provider: "fixture", contextWindow: 128000, reasoning: true, thinking: { options: [{ value: "low", label: "낮음" }, { value: "high", label: "높음" }] } },
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
			await page.waitForFunction(() => document.body.textContent?.includes("작업 중"));
			await page.click(".model-trigger");
			await page.waitForSelector(".model-dialog");
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-tab")].find(tab => tab.textContent?.includes("모델"))?.click(),
			);
			await page.click('.model-option-hit[data-model-id="fixture/model-two"]');
			await page.waitForSelector(".model-role-choice");
			await page.waitForFunction(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-role-option")].some(button => !button.disabled),
			);
			await page.click(".model-role-option");
			await page.waitForFunction(() => document.body.textContent?.includes("작업이 끝난 뒤 적용합니다"));
			// A reasoning choice made while busy must merge, not replace, the model choice.
			await page.click(".reasoning-control .select-trigger");
			await page.waitForSelector(".select-menu .select-option:not([disabled])");
			await page.evaluate(() => {
				const option = [...document.querySelectorAll<HTMLButtonElement>(".select-menu .select-option")].find(
					item => item.textContent?.includes("높음"),
				);
				option?.click();
			});
			await page.waitForFunction(() => document.body.textContent?.includes("추론 수준을 작업이 끝난 뒤 적용합니다"));
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
			expect(applied[0]!.params).toEqual({ sessionId: "a", modelId: "fixture/model-two", thinkingLevel: "high" });
			await page.evaluate(({ id }) => window.fixture.response(id, true), { id: applied[0]!.id });
			await page.waitForFunction(() => !document.body.textContent?.includes("작업이 끝난 뒤 적용합니다"));
		} finally { await closeFixture(context, page); }
	}, 30000);
});


describe("mounted composer delivery recovery", () => {
	test("short workspace keeps queued inputs and recovery controls reachable", async () => {
		const { context, page } = await fixture();
		try {
			await page.setViewport({ width: 1000, height: 480 });
			await select(page);
			const prompt = await send(page, "recover this payload");
			await receipt(page, prompt, "failed");
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"] button')].some(button => button.textContent?.includes("초안 복원")));
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], queued: Array.from({ length: 30 }, (_, index) => ({ id: `queue-${index}`, text: `queued ${index} ${"long".repeat(100)}`, deliverAs: "followUp" as const, cancelable: true })) } }));
			await page.waitForSelector(".queued-input:nth-child(31)");
			const layout = await page.evaluate(() => {
				const queue = document.querySelector<HTMLElement>(".queued-inputs")!;
				const pane = document.querySelector<HTMLElement>(".main-pane")!;
				const recovery = [...document.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent?.includes("초안 복원"))!;
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 결과를 확인할 수 없습니다")));
			expect(await page.evaluate(() => document.body.textContent?.includes("초안 복원"))).toBe(true);
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 결과를 확인할 수 없습니다")));
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("초안 복원"))?.click());
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 처리에 실패했습니다")));
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 결과를 확인할 수 없습니다")));
			expect(await page.evaluate(() => document.body.textContent?.includes("저장 복구 다시 시도"))).toBe(false);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("초안 복원"))?.click());
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 결과를 확인할 수 없습니다")));
			expect(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].filter(el => el.textContent?.includes("전송 복구")).length)).toBe(1);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("초안 복원"))?.click());
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "exact missing payload");
			expect((await page.evaluate(() => window.fixture.requests())).filter(r => r.method === "prompt")).toHaveLength(0);
			expect(await page.evaluate(() => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === "c-accepted"))).toBe(false);
			await select(page, 1);
			await page.waitForFunction(() => document.body.textContent?.includes("저장 복구 다시 시도"));
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("복구 항목 버리기"))?.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("저장 복구 다시 시도"))?.click());
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
			await waitStoredDisposition(page, first.id, "accepted");
			await page.evaluate(() => window.fixture.emit({ type: "session", session: { id: "a", title: "Session A", projectId: "p", status: "running", starred: false, imageInput: { supported: true, blocked: false }, operatorRunning: false, controlGeneration: 1, messages: [], queued: [] } }));
			await page.type(".composer textarea", "unsent second");
			await page.evaluate(() => window.fixture.failPostHandoffDraftSave(2));
			await page.click('.composer button[type="submit"]');
			await page.waitForFunction(() => document.body.textContent?.includes("저장 복구 다시 시도"));
			const panels = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')]
				.filter(el => el.textContent?.includes("전송 복구"))
				.map(el => ({ text: el.textContent ?? "", repairs: [...el.querySelectorAll("button")].filter(button => button.textContent?.includes("저장 복구 다시 시도")).length })));
			expect(panels).toHaveLength(1);
			expect(panels[0]?.repairs).toBe(1);
			expect(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("복구 항목 버리기"))?.disabled)).toBe(true);
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("저장 복구 다시 시도"))?.click());
			await page.waitForFunction(() => !document.body.textContent?.includes("저장 복구 다시 시도"));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("unsent second");
			expect(await page.evaluate((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), first.id)).toBe(false);
			expect(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 복구")))).toBe(false);
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
				await page.waitForFunction(copy => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes(copy)), {}, disposition === "failed" ? "전송 처리에 실패했습니다" : "전송 결과를 확인할 수 없습니다");
				expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("");
				const panel = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].find(el => el.textContent?.includes("전송 복구"))?.textContent ?? "");
				expect(panel).toContain("이미 실행되었을 수 있습니다");
				expect(panel).toContain("초안 복원");
				expect(panel).toContain(disposition === "failed" ? "복구 항목 버리기" : "자동으로 다시 보내지 않습니다");
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
				expect(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 복구")))).toBe(false);
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
			await page.waitForSelector(".composer-delivery select");
			await page.select(".composer-delivery select", "followUp");
			const request = await send(page, "queued disconnect payload");
			expect(request.params.deliverAs).toBe("followUp");
			await receipt(page, request, "queued");
			await waitStoredDisposition(page, request.id, "queued");
			await page.evaluate((id: string) => window.fixture.response(id, true), request.id);
			await page.type(".composer textarea", "newer draft");
			await page.waitForFunction(() => !(document.querySelector('.composer button[type="submit"]') as HTMLButtonElement).disabled);
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await waitStoredDisposition(page, request.id, "unknown");
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 결과를 확인할 수 없습니다")));
			expect(await page.evaluate((id: string) => window.fixture.requests().some(r => r.method === "delivery.ack" && r.params.deliveryId === id), request.id)).toBe(false);
			await page.evaluate(() => window.fixture.failNextAck("error"));
			await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("초안 복원"))?.click());
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
			await page.waitForFunction(() => document.body.textContent?.includes("전송 확인 오류"));
			await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "ack failure payload");
			expect(await page.evaluate(() => document.body.textContent?.includes("저장 복구 다시 시도"))).toBe(false);
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
				await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 처리에 실패했습니다")));
			}
			await receipt(page, request, "accepted");
			await page.reload(); await select(page);
			await page.waitForFunction(() => window.fixture.requests().filter(r => r.method === "delivery.ack").length >= 2);
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe(mode === "lost" ? "" : "restore once");
			if (mode === "lost") {
				await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 처리에 실패했습니다")));
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 처리에 실패했습니다")));
			expect(await page.$eval(".composer textarea", (el: HTMLTextAreaElement) => el.value)).toBe("");
			await page.evaluate(() => window.fixture.emit({ type: "fatal", error: "disconnected" }));
			await page.reload(); await select(page);
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 처리에 실패했습니다")));
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 결과를 확인할 수 없습니다")));
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
			await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("전송 결과를 확인할 수 없습니다")));
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
