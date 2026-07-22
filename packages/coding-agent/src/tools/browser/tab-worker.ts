import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { untilAborted } from "@gajae-code/utils/abortable";
import { Snowflake } from "@gajae-code/utils/snowflake";
import type { HTMLElement } from "linkedom";
import type {
	Browser,
	Dialog,
	ElementHandle,
	HTTPResponse,
	KeyInput,
	Page,
	SerializedAXNode,
	Target,
} from "puppeteer-core";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import type { JsDisplayOutput } from "../../eval/js/shared/types";
import { resizeImage } from "../../utils/image-resize";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	loadPuppeteerInWorker,
} from "./launch";
import { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./readable";
import { formatScreenshot } from "./screenshot-format";
import type {
	Observation,
	ObservationEntry,
	ReadyInfo,
	RunErrorPayload,
	RunResultOk,
	ScreenshotResult,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
} from "./tab-protocol";
import { resolveTabWorkerPath } from "./tab-worker-path-resolver";

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
	};
}

const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

type DialogPolicy = "accept" | "dismiss";
type DragTarget = string | { readonly x: number; readonly y: number };
type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string };

interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	save?: string;
	silent?: boolean;
}

interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
	): Promise<void>;
	observe(opts?: { includeAll?: boolean; viewportOnly?: boolean }): Promise<Observation>;
	screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
	extract(format?: ReadableFormat): Promise<ReadableResult | null>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: KeyInput, opts?: { selector?: string }): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string): Promise<ElementHandle>;
	evaluate<TResult, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => TResult | Promise<TResult>),
		...args: TArgs
	): Promise<TResult>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: string[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<HTTPResponse>;
	id(n: number): Promise<ElementHandle>;
}

function normalizeSelector(selector: string): string {
	if (!selector) return selector;
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}

function isInteractiveNode(node: SerializedAXNode): boolean {
	if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
	return (
		node.checked !== undefined ||
		node.pressed !== undefined ||
		node.selected !== undefined ||
		node.expanded !== undefined ||
		node.focused === true
	);
}

function asElementHandle(handle: unknown): ElementHandle | null {
	return handle ? (handle as ElementHandle) : null;
}

function cloneSafe(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		structuredClone(value);
		return value;
	} catch {}
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {}
	return String(value);
}

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: true, isAbort: false };
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const Ctor = payload.isToolError ? ToolError : Error;
	const err = new Ctor(payload.message);
	if (payload.name) err.name = payload.name;
	if (payload.stack) err.stack = payload.stack;
	return err;
}

async function targetIdForTarget(target: Target): Promise<string> {
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

async function collectObservationEntries(
	core: WorkerCore,
	node: SerializedAXNode,
	entries: ObservationEntry[],
	options: { viewportOnly: boolean; includeAll: boolean },
): Promise<void> {
	if (options.includeAll || isInteractiveNode(node)) {
		const handle = await node.elementHandle();
		if (handle) {
			let inViewport = true;
			if (options.viewportOnly) {
				try {
					inViewport = await handle.isIntersectingViewport();
				} catch {
					inViewport = false;
				}
			}
			if (inViewport) {
				const id = core.nextElementId();
				const states: string[] = [];
				if (node.disabled) states.push("disabled");
				if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
				if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
				if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
				if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
				if (node.required) states.push("required");
				if (node.readonly) states.push("readonly");
				if (node.multiselectable) states.push("multiselectable");
				if (node.multiline) states.push("multiline");
				if (node.modal) states.push("modal");
				if (node.focused) states.push("focused");
				core.cacheElement(id, handle as ElementHandle);
				entries.push({
					id,
					role: node.role,
					name: node.name,
					value: node.value,
					description: node.description,
					keyshortcuts: node.keyshortcuts,
					states,
				});
			} else {
				await handle.dispose();
			}
		}
	}
	for (const child of node.children ?? []) {
		await collectObservationEntries(core, child, entries, options);
	}
}

async function resolveActionableQueryHandlerClickTarget(handles: ElementHandle[]): Promise<ElementHandle | null> {
	const candidates: Array<{
		handle: ElementHandle;
		rect: { x: number; y: number; w: number; h: number };
		ownedProxy?: ElementHandle;
	}> = [];
	for (const handle of handles) {
		let clickable: ElementHandle = handle;
		let clickableProxy: ElementHandle | null = null;
		try {
			const proxy = await handle.evaluateHandle(el => {
				const target =
					(el as Element).closest(
						'a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]',
					) ?? el;
				return target;
			});
			clickableProxy = asElementHandle(proxy.asElement());
			if (clickableProxy) clickable = clickableProxy;
		} catch {}
		try {
			const intersecting = await clickable.isIntersectingViewport();
			if (!intersecting) continue;
			const rect = (await clickable.evaluate(el => {
				const r = (el as Element).getBoundingClientRect();
				return { x: r.left, y: r.top, w: r.width, h: r.height };
			})) as { x: number; y: number; w: number; h: number };
			if (rect.w < 1 || rect.h < 1) continue;
			candidates.push({ handle: clickable, rect, ownedProxy: clickableProxy ?? undefined });
		} catch {
		} finally {
			if (clickableProxy && clickableProxy !== handle && clickable !== clickableProxy) {
				await clickableProxy.dispose().catch(() => undefined);
			}
		}
	}
	if (!candidates.length) return null;
	candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const winner = candidates[0]?.handle ?? null;
	for (let i = 1; i < candidates.length; i++) {
		const candidate = candidates[i]!;
		if (candidate.ownedProxy) await candidate.ownedProxy.dispose().catch(() => undefined);
	}
	return winner;
}

async function isClickActionable(handle: ElementHandle): Promise<ActionabilityResult> {
	return (await handle.evaluate(el => {
		const element = el as HTMLElement;
		const style = globalThis.getComputedStyle(element);
		if (style.display === "none") return { ok: false as const, reason: "display:none" };
		if (style.visibility === "hidden") return { ok: false as const, reason: "visibility:hidden" };
		if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
		if (Number(style.opacity) === 0) return { ok: false as const, reason: "opacity:0" };
		const r = element.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return { ok: false as const, reason: "zero-size" };
		const left = Math.max(0, Math.min(globalThis.innerWidth, r.left));
		const right = Math.max(0, Math.min(globalThis.innerWidth, r.right));
		const top = Math.max(0, Math.min(globalThis.innerHeight, r.top));
		const bottom = Math.max(0, Math.min(globalThis.innerHeight, r.bottom));
		if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };
		const x = Math.floor((left + right) / 2);
		const y = Math.floor((top + bottom) / 2);
		const topEl = globalThis.document.elementFromPoint(x, y);
		if (!topEl) return { ok: false as const, reason: "elementFromPoint-null" };
		if (topEl === element || element.contains(topEl) || (topEl as Element).contains(element))
			return { ok: true as const, x, y };
		return { ok: false as const, reason: "obscured" };
	})) as ActionabilityResult;
}

async function clickQueryHandlerText(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const clickSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const start = Date.now();
	let lastSeen = 0;
	let lastReason: string | null = null;
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(clickSignal);
		const handles = (await untilAborted(clickSignal, () => page.$$(selector))) as ElementHandle[];
		try {
			lastSeen = handles.length;
			const target = await resolveActionableQueryHandlerClickTarget(handles);
			if (!target) {
				lastReason = handles.length ? "no-visible-candidate" : "no-matches";
				await Bun.sleep(100);
				continue;
			}
			const actionability = await isClickActionable(target);
			if (!actionability.ok) {
				lastReason = actionability.reason;
				await Bun.sleep(100);
				continue;
			}
			try {
				await untilAborted(clickSignal, () => target.click());
				return;
			} catch (err) {
				lastReason = err instanceof Error ? err.message : String(err);
				await Bun.sleep(100);
			}
		} finally {
			await Promise.all(handles.map(async handle => handle.dispose().catch(() => undefined)));
		}
	}
	throw new ToolError(
		`Timed out clicking ${selector} (seen ${lastSeen} matches; last reason: ${lastReason ?? "unknown"}). ` +
			"If there are multiple matching elements, use observe + tab.id() or a more specific selector.",
	);
}

interface ActiveRun {
	id: string;
	ac: AbortController;
	displays: RunResultOk["displays"];
	screenshots: ScreenshotResult[];
	pendingTools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
}

export class WorkerCore {
	#transport: Transport;
	#browser?: Browser;
	#page?: Page;
	#targetId?: string;
	#elementCache = new Map<number, ElementHandle>();
	#elementCounter = 0;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#mode?: WorkerInitPayload["mode"];
	#dialogPolicy?: DialogPolicy;
	#dialogHandler?: (dialog: Dialog) => void;

	constructor(transport: Transport) {
		this.#transport = transport;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as WorkerInbound);
		});
	}

	nextElementId(): number {
		this.#elementCounter += 1;
		return this.#elementCounter;
	}

	cacheElement(id: number, handle: ElementHandle): void {
		this.#elementCache.set(id, handle);
	}

	async #handleMessage(msg: WorkerInbound): Promise<void> {
		switch (msg.type) {
			case "init":
				await this.#init(msg.payload);
				return;
			case "run":
				await this.#run(msg);
				return;
			case "abort":
				if (this.#active?.id === msg.id) this.#active.ac.abort(new ToolAbortError());
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				await this.#close();
				return;
		}
	}

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			const puppeteer = await loadPuppeteerInWorker(payload.safeDir);
			this.#browser = await puppeteer.connect({
				browserWSEndpoint: payload.browserWSEndpoint,
				defaultViewport: null,
				protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
			});
			if (payload.mode === "headless") {
				this.#page = await this.#browser.newPage();
				await applyStealthPatches(this.#browser, this.#page, { browserSession: null, override: null }, payload.geo);
				await applyViewport(this.#page, payload.viewport);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
				if (payload.url) {
					await this.#page.goto(payload.url, {
						// Default to "load" because dev servers with HMR/WS never reach networkidle.
						waitUntil: payload.waitUntil ?? "load",
						timeout: payload.timeoutMs,
					});
				}
			} else {
				this.#page = await this.#findAttachedPage(payload.targetId);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			this.#targetId = await targetIdForPage(this.#page);
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedPage(targetId: string): Promise<Page> {
		if (!this.#browser) throw new ToolError("Browser is not connected");
		for (const target of this.#browser.targets()) {
			if ((await targetIdForTarget(target).catch(() => "")) !== targetId) continue;
			const page = await target.page();
			if (!page) break;
			return page;
		}
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(page));
		this.#targetId = targetId;
		return {
			url: page.url(),
			title: await page.title().catch(() => undefined),
			viewport: page.viewport() ?? DEFAULT_VIEWPORT,
			targetId,
		};
	}

	#applyDialogPolicy(policy: DialogPolicy): void {
		const page = this.#requirePage();
		if (this.#dialogPolicy === policy && this.#dialogHandler) return;
		if (this.#dialogHandler) page.off("dialog", this.#dialogHandler);
		const handler = (dialog: Dialog): void => {
			const action = policy === "accept" ? dialog.accept() : dialog.dismiss();
			void action.catch(err =>
				this.#log("debug", "Dialog auto-handler failed", {
					policy,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		};
		page.on("dialog", handler);
		this.#dialogPolicy = policy;
		this.#dialogHandler = handler;
	}

	async #postReadyInfo(): Promise<void> {
		try {
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#log("debug", "Failed to refresh tab info", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #run(msg: Extract<WorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(new ToolError("Tab worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(msg.timeoutMs);
		const ac = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal]);
		const displays: RunResultOk["displays"] = [];
		const screenshots: ScreenshotResult[] = [];
		const active: ActiveRun = { id: msg.id, ac, displays, screenshots, pendingTools: new Map() };
		this.#active = active;
		try {
			throwIfAborted(signal);
			const page = this.#requirePage();
			const browser = this.#requireBrowser();
			const tabApi = this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, displays, screenshots);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			runtime.setRunScope({
				page,
				browser,
				tab: tabApi,
				assert: (cond: unknown, text?: string): void => {
					if (!cond) throw new ToolError(text ?? "Assertion failed");
				},
				wait: (ms: number): Promise<void> => Bun.sleep(ms),
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				rejectCancel(
					timeoutSignal.aborted
						? new ToolError(`Browser code execution timed out after ${msg.timeoutMs}ms`)
						: new ToolAbortError(),
				);
				// Cancel in-flight tool calls so user code's awaited proxies reject promptly.
				for (const pending of active.pendingTools.values()) {
					pending.reject(new ToolAbortError());
				}
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				const returnValue = await Promise.race([
					runtime.run(msg.code, `browser-run-${msg.id}.js`),
					cancelRejection,
				]);
				await this.#postReadyInfo();
				this.#transport.send({
					type: "result",
					id: msg.id,
					ok: true,
					payload: { displays, returnValue: cloneSafe(returnValue), screenshots },
				});
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(error) });
		} finally {
			if (this.#active?.id === msg.id) this.#active = null;
		}
	}

	#ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({
			initialCwd: session.cwd,
			sessionId: `browser-tab-${this.#targetId ?? "unknown"}`,
			getHooks: () => this.#hooksForActiveRun(),
		});
		return this.#runtime;
	}

	#hooksForActiveRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		return {
			// console.* output stays on the supervisor log channel — matches pre-runtime behavior
			// where browser cells didn't surface `console.log` to the model.
			onText: chunk => this.#log("debug", chunk.replace(/\n$/, "")),
			onDisplay: output => this.#pushDisplay(active.displays, output),
			callTool: (name, args) => this.#callTool(active, name, args),
		};
	}

	#pushDisplay(displays: RunResultOk["displays"], output: JsDisplayOutput): void {
		if (output.type === "image") {
			displays.push({ type: "image", data: output.data, mimeType: output.mimeType });
			return;
		}
		if (output.type === "json") {
			displays.push({ type: "text", text: safeJsonStringify(output.data) });
			return;
		}
		// status — surface as compact JSON so helper side effects (read/write/tree) appear in
		// the cell result alongside explicit display() output.
		displays.push({ type: "text", text: safeJsonStringify(output.event) });
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tab-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	#createTabApi(
		name: string,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		displays: RunResultOk["displays"],
		screenshots: ScreenshotResult[],
	): TabApi {
		const page = this.#requirePage();
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => page.title(),
			goto: async (url, opts) => {
				this.#clearElementCache();
				await untilAborted(signal, () =>
					// Default to "load" because dev servers with HMR/WS never reach networkidle.
					page.goto(url, { waitUntil: opts?.waitUntil ?? "load", timeout: timeoutMs }),
				);
			},
			observe: opts => this.#collectObservation({ ...opts, signal }),
			screenshot: async opts => await this.#captureScreenshot(session, displays, screenshots, signal, opts),
			extract: async (format = "markdown") => {
				const html = (await untilAborted(signal, () => page.content())) as string;
				return extractReadableFromHtml(html, page.url(), format);
			},
			click: async selector => {
				const resolved = normalizeSelector(selector);
				if (resolved.startsWith("text/")) await clickQueryHandlerText(page, resolved, timeoutMs, signal);
				else await untilAborted(signal, () => page.locator(resolved).setTimeout(timeoutMs).click());
			},
			type: async (selector, text) => {
				const handle = (await untilAborted(signal, () =>
					page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle(),
				)) as ElementHandle;
				try {
					await untilAborted(signal, () => handle.type(text, { delay: 0 }));
				} finally {
					await handle.dispose();
				}
			},
			fill: async (selector, value) => {
				await untilAborted(signal, () =>
					page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).fill(value),
				);
			},
			press: async (key, opts) => {
				const selector = opts?.selector;
				if (selector) await untilAborted(signal, () => page.focus(normalizeSelector(selector)));
				await untilAborted(signal, () => page.keyboard.press(key));
			},
			scroll: async (deltaX, deltaY) => {
				await untilAborted(signal, () => page.mouse.wheel({ deltaX, deltaY }));
			},
			drag: async (from, to) => await this.#drag(from, to, signal),
			waitFor: async selector =>
				(await untilAborted(signal, () =>
					page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle(),
				)) as ElementHandle,
			evaluate: async (fn, ...args) =>
				(await untilAborted(signal, () =>
					typeof fn === "string" ? page.evaluate(fn) : page.evaluate(fn as (...a: unknown[]) => unknown, ...args),
				)) as never,
			scrollIntoView: async selector => {
				const handle = (await untilAborted(signal, () =>
					page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle(),
				)) as ElementHandle;
				try {
					await untilAborted(signal, () =>
						handle.evaluate(el => {
							const target = el as unknown as {
								scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
							};
							target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
						}),
					);
				} finally {
					await handle.dispose().catch(() => undefined);
				}
			},
			select: async (selector, ...values) => await this.#select(selector, values, timeoutMs, signal),
			uploadFile: async (selector, ...filePaths) =>
				await this.#uploadFile(selector, filePaths, timeoutMs, signal, session),
			waitForUrl: async (pattern, opts) => await this.#waitForUrl(pattern, opts?.timeout ?? timeoutMs, signal),
			waitForResponse: async (pattern, opts) =>
				await this.#waitForResponse(pattern, opts?.timeout ?? timeoutMs, signal),
			id: async id => await this.#resolveCachedHandle(id),
		};
	}

	async #collectObservation(options: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		signal?: AbortSignal;
	}): Promise<Observation> {
		const page = this.#requirePage();
		this.#clearElementCache();
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		const snapshot = (await untilAborted(options.signal, () =>
			page.accessibility.snapshot({ interestingOnly: !includeAll }),
		)) as SerializedAXNode | null;
		if (!snapshot) throw new ToolError("Accessibility snapshot unavailable");
		const entries: ObservationEntry[] = [];
		await collectObservationEntries(this, snapshot, entries, { includeAll, viewportOnly });
		const scroll = (await untilAborted(options.signal, () =>
			page.evaluate(() => {
				const win = globalThis as unknown as {
					scrollX: number;
					scrollY: number;
					innerWidth: number;
					innerHeight: number;
					document: { documentElement: { scrollWidth: number; scrollHeight: number } };
				};
				const doc = win.document.documentElement;
				return {
					x: win.scrollX,
					y: win.scrollY,
					width: win.innerWidth,
					height: win.innerHeight,
					scrollWidth: doc.scrollWidth,
					scrollHeight: doc.scrollHeight,
				};
			}),
		)) as Observation["scroll"];
		return {
			url: page.url(),
			title: (await untilAborted(options.signal, () => page.title())) as string,
			viewport: page.viewport() ?? DEFAULT_VIEWPORT,
			scroll,
			elements: entries,
		};
	}

	async #captureScreenshot(
		session: SessionSnapshot,
		displays: RunResultOk["displays"],
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		opts: ScreenshotOptions = {},
	): Promise<ScreenshotResult> {
		const page = this.#requirePage();
		const fullPage = opts.selector ? false : (opts.fullPage ?? false);
		let buffer: Buffer;
		if (opts.selector) {
			const handle = (await untilAborted(signal, () =>
				page.$(normalizeSelector(opts.selector!)),
			)) as ElementHandle | null;
			if (!handle) throw new ToolError("Screenshot selector did not resolve to an element");
			try {
				buffer = (await untilAborted(signal, () => handle.screenshot({ type: "png" }))) as Buffer;
			} finally {
				await handle.dispose().catch(() => undefined);
			}
		} else {
			buffer = (await untilAborted(signal, () => page.screenshot({ type: "png", fullPage }))) as Buffer;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: "image/png" },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
		);
		const explicitPath = opts.save ? resolveTabWorkerPath(opts.save, session.cwd) : undefined;

		const dest =
			explicitPath ??
			(session.browserScreenshotDir
				? path.join(
						session.browserScreenshotDir,
						`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.png`,
					)
				: path.join(os.tmpdir(), `gjc-sshots-${Snowflake.next()}.png`));
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		const saveFullRes = !!(explicitPath || session.browserScreenshotDir);
		const savedBuffer = saveFullRes ? buffer : resized.buffer;
		const savedMimeType = saveFullRes ? "image/png" : resized.mimeType;
		await Bun.write(dest, savedBuffer);
		const info: ScreenshotResult = {
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		};
		screenshots.push(info);
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			displays.push({ type: "text", text: lines.join("\n") });
			displays.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return info;
	}

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (
			target: DragTarget,
			role: "from" | "to",
		): Promise<{ x: number; y: number; handle?: ElementHandle }> => {
			if (typeof target === "string") {
				const handle = (await untilAborted(signal, () =>
					page.$(normalizeSelector(target)),
				)) as ElementHandle | null;
				if (!handle) throw new ToolError(`Drag ${role} selector did not resolve: ${target}`);
				const box = (await untilAborted(signal, () => handle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				if (!box) {
					await handle.dispose().catch(() => undefined);
					throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
				}
				return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
			}
			if (
				target !== null &&
				typeof target === "object" &&
				typeof (target as { x: unknown }).x === "number" &&
				typeof (target as { y: unknown }).y === "number"
			) {
				return { x: (target as { x: number }).x, y: (target as { y: number }).y };
			}
			throw new ToolError(
				`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`,
			);
		};
		const start = await resolveDragPoint(from, "from");
		let end: { x: number; y: number; handle?: ElementHandle } | undefined;
		try {
			end = await resolveDragPoint(to, "to");
			await untilAborted(signal, () => page.mouse.move(start.x, start.y));
			await untilAborted(signal, () => page.mouse.down());
			await untilAborted(signal, () => page.mouse.move(end!.x, end!.y, { steps: 12 }));
			await untilAborted(signal, () => page.mouse.up());
		} finally {
			if (start.handle) await start.handle.dispose().catch(() => undefined);
			if (end?.handle) await end.handle.dispose().catch(() => undefined);
		}
	}

	async #select(selector: string, values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
		const page = this.#requirePage();
		const handle = (await untilAborted(signal, () =>
			page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle(),
		)) as ElementHandle;
		try {
			return (await untilAborted(signal, () =>
				handle.evaluate((el, vals) => {
					interface SelectOption {
						value: string;
						selected: boolean;
					}
					interface SelectLike {
						tagName: string;
						options: ArrayLike<SelectOption>;
						dispatchEvent: (event: unknown) => boolean;
					}
					const select = el as unknown as SelectLike;
					if (select?.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
					const EventCtor = (
						globalThis as unknown as { Event: new (type: string, init?: { bubbles: boolean }) => unknown }
					).Event;
					const wanted = new Set(vals as string[]);
					const selected: string[] = [];
					for (let i = 0; i < select.options.length; i++) {
						const opt = select.options[i] as SelectOption;
						opt.selected = wanted.has(opt.value);
						if (opt.selected) selected.push(opt.value);
					}
					select.dispatchEvent(new EventCtor("input", { bubbles: true }));
					select.dispatchEvent(new EventCtor("change", { bubbles: true }));
					return selected;
				}, values),
			)) as string[];
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const page = this.#requirePage();
		const handle = (await untilAborted(signal, () =>
			page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle(),
		)) as ElementHandle;
		try {
			const absolute = filePaths.map(filePath => resolveTabWorkerPath(filePath, session.cwd));
			const upload = handle as unknown as { uploadFile: (...paths: string[]) => Promise<void> };
			const tagName = (await untilAborted(signal, () =>
				handle.evaluate(el => (el as unknown as { tagName: string }).tagName),
			)) as string;
			if (tagName !== "INPUT")
				throw new ToolError(
					`tab.uploadFile() requires an <input type="file"> element (got <${tagName.toLowerCase()}>)`,
				);
			await untilAborted(signal, () => upload.uploadFile(...absolute));
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async #waitForUrl(pattern: string | RegExp, timeout: number, signal: AbortSignal): Promise<string> {
		const page = this.#requirePage();
		const isRegex = pattern instanceof RegExp;
		const matcher = isRegex ? pattern.source : pattern;
		const flags = isRegex ? pattern.flags : "";
		await untilAborted(signal, () =>
			page.waitForFunction(
				(m: string, isRe: boolean, fl: string) => {
					const url = (globalThis as unknown as { location: { href: string } }).location.href;
					return isRe ? new RegExp(m, fl).test(url) : url.includes(m);
				},
				{ timeout, polling: 200 },
				matcher,
				isRegex,
				flags,
			),
		);
		return page.url();
	}

	async #waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		timeout: number,
		signal: AbortSignal,
	): Promise<HTTPResponse> {
		const page = this.#requirePage();
		const predicate: (response: HTTPResponse) => boolean | Promise<boolean> =
			typeof pattern === "function"
				? pattern
				: pattern instanceof RegExp
					? response => pattern.test(response.url())
					: response => response.url().includes(pattern);
		return (await untilAborted(signal, () => page.waitForResponse(predicate, { timeout }))) as HTTPResponse;
	}

	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const handle = this.#elementCache.get(id);
		if (!handle) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				this.#clearElementCache();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
		} catch (err) {
			if (err instanceof ToolError) throw err;
			this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		return handle;
	}
	#clearElementCache(): void {
		if (this.#elementCache.size === 0) {
			this.#elementCounter = 0;
			return;
		}
		const handles = [...this.#elementCache.values()];
		this.#elementCache.clear();
		this.#elementCounter = 0;
		for (const handle of handles) void handle.dispose().catch(() => undefined);
	}

	async #close(): Promise<void> {
		this.#unsub();
		this.#clearElementCache();
		const page = this.#page;
		if (this.#dialogHandler && page && !page.isClosed()) page.off("dialog", this.#dialogHandler);
		if (this.#mode === "headless" && page && !page.isClosed()) await page.close().catch(() => undefined);
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
