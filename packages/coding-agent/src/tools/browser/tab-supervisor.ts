import { getPuppeteerDir, isCompiledBinary, logger, Snowflake } from "@gajae-code/utils";
import type { Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import type { ToolSession } from "../../sdk";
import { expandPath } from "../path-utils";
import { ToolAbortError, ToolError } from "../tool-errors";
import { pickElectronTarget } from "./attach";
import {
	consumeDeadTabRecovery,
	discardDeadTabRecovery,
	isDeadTabRecoveryLive,
	peekDeadTabRecovery,
	registerDeadTabRecovery,
} from "./dead-tab-recovery";
import { type BrowserHandle, type BrowserKindTag, holdBrowser, releaseBrowser } from "./registry";
import type {
	ReadyInfo,
	RunErrorPayload,
	RunResultOk,
	SessionSnapshot,
	Transferable,
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "./tab-protocol";

// Worker entry. The literal string in `new Worker("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts", …)`
// below is what Bun's `--compile` static analyzer needs to bundle the worker
// (registered as an additional entrypoint in `scripts/build-binary.ts`); in
// dev we resolve the same source via `import.meta.url`. Replaces the older
// `with { type: "file" }` pattern, which only copied the entry as a raw
// asset and could not resolve the worker's relative imports inside a
// compiled binary (issue #1011 was a false-positive fix — the regression
// test only checked emission, not actual worker startup).

interface WorkerHandle {
	send(msg: WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	onClose(handler: () => void): () => void;
	terminate(): Promise<void>;
}

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
}

export interface TabSession {
	name: string;
	browser: BrowserHandle;
	targetId: string;
	worker: WorkerHandle;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;
	/** Immutable inputs needed to recreate this worker after an unexpected exit. */
	recoveryOpts: AcquireTabOptions;
	/** Session that acquired this tab; used for session-scoped teardown (F13). */
	ownerId?: string;
	/** Unix-ms timestamp of the last acquire/run activity; drives GC idle + LRU ordering. */
	lastUsedAt: number;
	/** Set synchronously by the shared begin-release guard so concurrent release is a no-op. */
	releasing?: boolean;
}

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	dialogs?: DialogPolicy;
	/** Owning session id so dispose can release only this session's tabs (F13). */
	ownerId?: string;
	/** Internal recovery-only target id; makes a headless replacement attach, not open a page. */
	recoveryTargetId?: string;
	/** Recovery fence: replacement must not overwrite a tab installed after dead teardown. */
	requireVacantName?: boolean;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

export interface ReleaseTabOptions {
	kill?: boolean;
	/**
	 * Absolute end-to-end deadline (`Date.now()`-based, ms) for the whole teardown chain.
	 * Shared across a `releaseAllTabs` loop so close/close-all honors ONE aggregate budget.
	 * Omitted (the GC/session-teardown callers) keeps the original unbounded behavior.
	 */
	deadlineAt?: number;
}

const tabs = new Map<string, TabSession>();
const recoveringTabs = new Map<string, { ownerId: string | undefined; promise: Promise<TabSession> }>();
let afterWorkerInitializationForTest: ((name: string) => void) | undefined;
let workerFactoryForTest: (() => Promise<WorkerHandle>) | undefined;
let workerInitializerForTest:
	| ((worker: WorkerHandle, payload: WorkerInitPayload, timeoutMs: number) => Promise<ReadyInfo>)
	| undefined;
const GRACE_MS = 750;
const TAB_WORKER_MODE = "native-free";

function startupError(stage: string): ToolError {
	return new ToolError(
		`Tab worker startup failed (stage=${stage}, mode=${TAB_WORKER_MODE}, platform=${process.platform}).`,
	);
}

interface DeadTabDescriptor {
	tab: TabSession;
	browser: BrowserHandle;
	opts: AcquireTabOptions;
}

/**
 * Remaining time (ms) until an absolute teardown deadline, or +Infinity when no deadline
 * is set (the GC / session-teardown callers). A non-positive result means the shared
 * close budget is already spent.
 */
function remainingBudget(deadlineAt: number | undefined): number {
	if (deadlineAt === undefined) return Number.POSITIVE_INFINITY;
	return deadlineAt - Date.now();
}

/**
 * Await `op` but never longer than `remainingMs` (#2027). On timeout — or when the budget
 * is already exhausted — the operation is detached and kept alive best-effort with its
 * rejection swallowed, so a dying CDP target cannot wedge the close teardown or leak an
 * unhandled rejection. Returns true when `op` settled within budget, false when detached.
 */
async function awaitWithinBudget(op: Promise<unknown>, remainingMs: number, label: string): Promise<boolean> {
	const settled = Promise.resolve(op).then(
		() => true,
		() => true,
	);
	if (remainingMs === Number.POSITIVE_INFINITY) return await settled;
	if (remainingMs <= 0) {
		void settled;
		logger.debug("close teardown budget already spent; detaching step", { label });
		return false;
	}
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<boolean>(resolve => {
		timer = setTimeout(() => resolve(false), remainingMs);
	});
	try {
		const ok = await Promise.race([settled, timedOut]);
		if (!ok) logger.debug("close teardown step exceeded deadline; detached", { label });
		return ok;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

/**
 * Shared synchronous begin-release guard. Returns true for the first caller (which then
 * owns teardown) and false for any concurrent/repeat caller, so `releaseBrowser` and the
 * `BrowserHandle.refCount` decrement happen exactly once even when the idle sweep, the RSS
 * sweep, a manual close, and `forceKillTab` race on the same tab.
 */
function beginRelease(tab: TabSession): boolean {
	if (tab.releasing) return false;
	tab.releasing = true;
	return true;
}

async function withTemporaryBrowserHold<T>(browser: BrowserHandle, work: () => Promise<T>): Promise<T> {
	holdBrowser(browser);
	try {
		return await work();
	} finally {
		await releaseBrowser(browser, { kill: false });
	}
}

/** Test-only: exercise the same hold-transfer primitive used by replacement recovery. */
export async function withTemporaryBrowserHoldForTest<T>(browser: BrowserHandle, work: () => Promise<T>): Promise<T> {
	return await withTemporaryBrowserHold(browser, work);
}

/** Test-only: close exactly the target belonging to the supplied dead session. */
export async function closeOrphanTargetForTest(tab: TabSession): Promise<void> {
	await closeOrphanTarget(tab);
}

function recoveryPromiseForOwner(name: string, ownerId: string | undefined): Promise<TabSession> | undefined {
	const existing = recoveringTabs.get(name);
	if (!existing || existing.ownerId !== ownerId) return undefined;
	return existing.promise;
}

/** Test-only: install an in-flight recovery and observe owner isolation. */
export function __setRecoveringTabForTest(
	name: string,
	ownerId: string | undefined,
	promise: Promise<TabSession>,
): void {
	recoveringTabs.set(name, { ownerId, promise });
}

export function recoveryPromiseForOwnerForTest(
	name: string,
	ownerId: string | undefined,
): Promise<TabSession> | undefined {
	return recoveryPromiseForOwner(name, ownerId);
}
/** Read-only, GC-facing projection of a live tab. Never exposes the mutable `tabs` map. */
export interface TabGcSnapshot {
	name: string;
	ownerId?: string;
	state: TabSession["state"];
	pendingCount: number;
	kindTag: BrowserKindTag;
	lastUsedAt: number;
	browserRefCount: number;
}

export interface BrowserGcEligibilityPolicy {
	now: () => number;
	idleMs: number;
}

/** Snapshot every live tab for GC ordering/diagnostics. */
export function listTabsForGc(): TabGcSnapshot[] {
	return [...tabs.values()].map(tab => ({
		name: tab.name,
		ownerId: tab.ownerId,
		state: tab.state,
		pendingCount: tab.pending.size,
		kindTag: tab.kindTag,
		lastUsedAt: tab.lastUsedAt,
		browserRefCount: tab.browser.refCount,
	}));
}

/**
 * Evict a tab only if it is still GC-eligible against the LIVE supervisor state. The full
 * predicate is checked synchronously and `releaseTab` is invoked with no intervening await,
 * so a tab that became busy after a GC snapshot cannot be closed (its run rejected). Returns
 * true only when the tab was actually released.
 */
export async function releaseTabIfGcEligible(name: string, policy: BrowserGcEligibilityPolicy): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab || tab.releasing) return false;
	if (tab.state === "dead") {
		if (recoveringTabs.has(name) || isDeadTabRecoveryLive(name, policy.now())) return false;
		return await releaseDeadTabForRecovery(name, tab, tab.ownerId);
	}
	if (tab.pending.size !== 0) return false;
	if (tab.kindTag !== "headless" && tab.kindTag !== "spawned") return false;
	if (policy.now() - tab.lastUsedAt <= policy.idleMs) return false;
	return await releaseTab(name, { kill: false });
}

/** Test-only: install a fabricated tab session. */
export function setTabForTest(tab: TabSession): void {
	tabs.set(tab.name, tab);
}

/** Test-only: clear the tab registry between cases. */
export function clearTabsForTest(): void {
	tabs.clear();
	recoveringTabs.clear();
	afterWorkerInitializationForTest = undefined;
	workerFactoryForTest = undefined;
	workerInitializerForTest = undefined;
}

export function __setAfterWorkerInitializationForTest(callback: ((name: string) => void) | undefined): void {
	afterWorkerInitializationForTest = callback;
}
export function __setAcquireTabWorkerDepsForTest(
	factory: (() => Promise<WorkerHandle>) | undefined,
	initializer:
		| ((worker: WorkerHandle, payload: WorkerInitPayload, timeoutMs: number) => Promise<ReadyInfo>)
		| undefined,
): void {
	workerFactoryForTest = factory;
	workerInitializerForTest = initializer;
}

async function initializeAcquireWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	return await (workerInitializerForTest?.(worker, payload, timeoutMs) ??
		initializeTabWorker(worker, payload, timeoutMs));
}

async function spawnAcquireWorker(): Promise<WorkerHandle> {
	return await (workerFactoryForTest?.() ?? spawnTabWorker());
}

export async function acquireTab(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const existing = tabs.get(name);
	if (opts.requireVacantName && existing)
		throw new ToolError(`Tab ${JSON.stringify(name)} was replaced during recovery.`);
	let replacementHold = false;
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				await releaseTab(name, { kill: false });
			} else {
				existing.lastUsedAt = Date.now();
				if (opts.url) {
					await runInTabWithSnapshot(
						name,
						{
							code: `await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "networkidle2")} });`,
							timeoutMs: opts.timeoutMs,
							signal: opts.signal,
						},
						{ cwd: process.cwd() },
					);
				}
				return { tab: tabs.get(name)!, created: false };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				replacementHold = true;
			}
			try {
				await releaseTab(name, { kill: false });
			} catch (error) {
				if (replacementHold) await releaseBrowser(browser, { kill: false });
				throw error;
			}
		}
	}

	let initPayload: WorkerInitPayload;
	try {
		initPayload = await buildInitPayload(browser, opts);
	} catch (error) {
		if (replacementHold) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	let worker: WorkerHandle;
	try {
		worker = await spawnAcquireWorker();
	} catch {
		if (replacementHold) await releaseBrowser(browser, { kill: false });
		else if (browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw startupError("spawn");
	}
	let registeredTab: TabSession | undefined;
	let startupFailure: Error | undefined;
	let browserHeld = false;
	const observeFailure = (error: Error): void => {
		if (registeredTab) markTabDead(registeredTab, error);
		else startupFailure ??= error;
	};
	const unlistenLifetimeMessages = worker.onMessage(msg => {
		if (msg.type === "closed") observeFailure(startupError("protocol-closed"));
	});
	const unlistenLifetimeErrors = worker.onError(() => observeFailure(startupError("error")));
	const unlistenLifetimeClose = worker.onClose(() => observeFailure(startupError("physical-close")));
	try {
		const info = await initializeAcquireWorker(worker, initPayload, opts.timeoutMs + GRACE_MS);
		afterWorkerInitializationForTest?.(name);
		if (startupFailure) throw startupFailure;
		if (opts.requireVacantName && tabs.has(name))
			throw new ToolError(`Tab ${JSON.stringify(name)} was replaced during recovery.`);

		holdBrowser(browser);
		browserHeld = true;
		if (replacementHold) {
			await releaseBrowser(browser, { kill: false });
			replacementHold = false;
		}
		if (startupFailure) throw startupFailure;

		const tab: TabSession = {
			name,
			browser,
			targetId: info.targetId,
			worker,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			ownerId: opts.ownerId,
			lastUsedAt: Date.now(),
			recoveryOpts: freezeRecoveryOptions(opts),
		};
		registeredTab = tab;
		worker.onMessage(msg => handleTabMessage(tab, msg));
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		unlistenLifetimeMessages();
		unlistenLifetimeErrors();
		unlistenLifetimeClose();
		await worker.terminate().catch(() => undefined);
		if (browserHeld) await releaseBrowser(browser, { kill: false });
		if (replacementHold) await releaseBrowser(browser, { kill: false });
		else if (!browserHeld && browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{ cwd: opts.session.cwd, browserScreenshotDir: expandBrowserScreenshotDir(opts.session) },
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession },
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	let tab = tabs.get(name);
	if (tab?.state === "dead") tab = await recoverDeadTab(name, opts.session);
	if (tab?.state !== "alive") throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Reopen it.`);
	if (tab.pending.size > 0) throw new ToolError(`Tab ${JSON.stringify(name)} is busy`);
	tab.lastUsedAt = Date.now();
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
	};
	tab.pending.set(id, pending);
	const abort = (): void => {
		tab.worker.send({ type: "abort", id });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
	};
	if (opts.signal?.aborted) abort();
	else opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		tab.worker.send({ type: "run", id, name, code: opts.code, timeoutMs: opts.timeoutMs, session: snapshot });
		return await raceWithTimeout(
			promise,
			opts.timeoutMs + GRACE_MS,
			"Browser code execution hung past grace; tab killed",
			async reason => await forceKillTab(name, reason),
		);
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
	}
}
function markTabDead(tab: TabSession, error: Error): void {
	if (tabs.get(tab.name) !== tab || tab.state !== "alive" || tab.releasing) return;
	tab.state = "dead";
	const closeError = new ToolError(`Browser tab worker stopped: ${error.message}`);
	for (const pending of tab.pending.values()) pending.reject(closeError);
	tab.pending.clear();
	registerDeadTabRecovery(tab.name, tab.ownerId, Object.freeze({ tab, browser: tab.browser, opts: tab.recoveryOpts }));
}
function freezeRecoveryOptions(opts: AcquireTabOptions): AcquireTabOptions {
	return Object.freeze({
		...opts,
		signal: undefined,
		viewport: opts.viewport ? Object.freeze({ ...opts.viewport }) : undefined,
	});
}

async function recoverDeadTab(name: string, session: ToolSession | undefined): Promise<TabSession | undefined> {
	const ownerId = session?.getSessionId?.() ?? undefined;
	const existing = recoveryPromiseForOwner(name, ownerId);
	if (existing) return await existing;
	if (recoveringTabs.has(name)) return undefined;
	const peeked = peekDeadTabRecovery<DeadTabDescriptor>(name, ownerId);
	if (peeked.status !== "consumed" || !peeked.descriptor) return undefined;
	const descriptor = peeked.descriptor;
	const consumed = consumeDeadTabRecovery<DeadTabDescriptor>(name, ownerId);
	if (consumed.status === "owner_mismatch") return undefined;
	if (consumed.status === "expired_or_missing") {
		await releaseDeadTabForRecovery(name, descriptor.tab, ownerId);
		return undefined;
	}
	const recovery = withTemporaryBrowserHold(descriptor.browser, async (): Promise<TabSession> => {
		if (!(await releaseDeadTabForRecovery(name, descriptor.tab, ownerId, true))) {
			throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Reopen it.`);
		}
		try {
			return (
				await acquireTab(name, descriptor.browser, {
					...descriptor.opts,
					recoveryTargetId: descriptor.tab.targetId,
					requireVacantName: true,
				})
			).tab;
		} catch (error) {
			if (descriptor.tab.kindTag === "headless") await closeOrphanTarget(descriptor.tab).catch(() => undefined);
			throw error;
		}
	});
	recoveringTabs.set(name, { ownerId, promise: recovery });
	try {
		return await recovery;
	} finally {
		if (recoveringTabs.get(name)?.promise === recovery) recoveringTabs.delete(name);
	}
}

/**
 * Claim and release exactly the dead tab that produced a recovery descriptor. Every
 * predicate and the release election run synchronously before teardown can await.
 */
export async function releaseDeadTabForRecovery(
	name: string,
	expected: TabSession,
	ownerId: string | undefined,
	preserveHeadlessTarget = false,
): Promise<boolean> {
	if (
		tabs.get(name) !== expected ||
		expected.state !== "dead" ||
		expected.ownerId !== ownerId ||
		!beginRelease(expected)
	) {
		return false;
	}
	await releaseClaimedTab(expected, { kill: false }, false, preserveHeadlessTarget);
	return true;
}

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	if (!beginRelease(tab)) {
		logger.debug("releaseTab: already releasing", { name });
		return false;
	}
	await releaseClaimedTab(tab, opts, tab.state === "alive");
	return true;
}

async function releaseClaimedTab(
	tab: TabSession,
	opts: ReleaseTabOptions,
	wasAlive: boolean,
	preserveHeadlessTarget = false,
): Promise<void> {
	tab.state = "dead";
	discardDeadTabRecovery(tab.name);
	const closeError = new ToolError(`Tab ${JSON.stringify(tab.name)} was closed`);
	for (const [id, pending] of tab.pending) {
		try {
			tab.worker.send({ type: "abort", id });
		} catch {}
		pending.reject(closeError);
	}
	tab.pending.clear();
	let forced = false;
	const deadlineAt = opts.deadlineAt;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab, remainingBudget(deadlineAt));
		} catch {
			forced = true;
		}
	}
	try {
		await awaitWithinBudget(
			Promise.resolve().then(() => tab.worker.terminate()),
			remainingBudget(deadlineAt),
			"worker.terminate",
		);
		if (!preserveHeadlessTarget && (forced || !wasAlive) && tab.kindTag === "headless") {
			await awaitWithinBudget(
				Promise.resolve().then(() => closeOrphanTarget(tab)),
				remainingBudget(deadlineAt),
				"closeOrphanTarget",
			);
		}
	} finally {
		await awaitWithinBudget(
			Promise.resolve().then(() => releaseBrowser(tab.browser, { kill: opts.kill ?? false })),
			remainingBudget(deadlineAt),
			"releaseBrowser",
		);
		// Only delete if the map still holds THIS tab: a same-name reacquire during our async
		// teardown may have installed a fresh tab that we must not evict.
		if (tabs.get(tab.name) === tab) tabs.delete(tab.name);
	}
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

/**
 * Release only the tabs owned by `ownerId` (F13 session-scoped teardown). Tabs acquired
 * by other sessions (or with no owner) are left untouched. No-op for a null/empty owner.
 */
export async function releaseTabsForOwner(
	ownerId: string | null | undefined,
	opts: ReleaseTabOptions = {},
): Promise<number> {
	if (!ownerId) return 0;
	const ownedTabs = [...tabs.values()].filter(tab => tab.ownerId === ownerId);
	let count = 0;
	for (const tab of ownedTabs) {
		if (await releaseOwnedTab(tab, ownerId, opts)) count++;
	}
	return count;
}

async function releaseOwnedTab(expected: TabSession, ownerId: string, opts: ReleaseTabOptions): Promise<boolean> {
	if (tabs.get(expected.name) !== expected || expected.ownerId !== ownerId || !beginRelease(expected)) return false;
	await releaseClaimedTab(expected, opts, expected.state === "alive");
	return true;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

async function buildInitPayload(browser: BrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const safeDir = getPuppeteerDir();
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (opts.recoveryTargetId) {
		return {
			mode: "attach",
			browserWSEndpoint,
			safeDir,
			targetId: opts.recoveryTargetId,
			dialogs: opts.dialogs,
		};
	}
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			browserWSEndpoint,
			safeDir,
			viewport: opts.viewport,
			...(browser.geo ? { geo: browser.geo } : {}),
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	const page = await pickElectronTarget(browser.browser, opts.target);
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		browserWSEndpoint,
		safeDir,
		targetId,
		dialogs: opts.dialogs,
	};
}
export async function buildInitPayloadForTest(
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<WorkerInitPayload> {
	return await buildInitPayload(browser, opts);
}

function handleTabMessage(tab: TabSession, msg: WorkerOutbound): void {
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		tab.pending.delete(msg.id);
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		pending.reject(errorFromPayload(msg.error));
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}

async function dispatchToolCall(tab: TabSession, msg: Extract<WorkerOutbound, { type: "tool-call" }>): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: TabSession, msg: WorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	if (!beginRelease(tab)) return;
	tab.state = "dead";
	discardDeadTabRecovery(name);
	const error = new ToolError(reason);
	for (const pending of tab.pending.values()) pending.reject(error);
	tab.pending.clear();
	try {
		await tab.worker.terminate().catch(() => undefined);
		if (tab.kindTag === "headless") await closeOrphanTarget(tab).catch(() => undefined);
	} finally {
		await releaseBrowser(tab.browser, { kill: false }).catch(() => undefined);
		if (tabs.get(name) === tab) tabs.delete(name);
	}
}

async function closeOrphanTarget(tab: TabSession): Promise<void> {
	for (const target of tab.browser.browser.targets()) {
		if ((await targetIdForTarget(target).catch(() => "")) !== tab.targetId) continue;
		const page = await target.page().catch(() => null);
		await page?.close().catch(() => undefined);
		return;
	}
}

async function waitForClosed(tab: TabSession, remainingMs: number = Number.POSITIVE_INFINITY): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(
			promise,
			Math.max(0, Math.min(GRACE_MS, remainingMs)),
			"Timed out closing browser tab worker",
		);
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
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

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.isAbort
		? new ToolAbortError()
		: payload.isToolError
			? new ToolError(payload.message)
			: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	onTimeout?: (reason: string) => Promise<void>,
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	const worker = isCompiledBinary()
		? new Worker("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts", { type: "module" })
		: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
	return wrapBunWorker(worker);
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (): void => handler(startupError("error"));
			const onMessageError = (): void => handler(startupError("messageerror"));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		onClose(handler) {
			const onClose = (): void => handler();
			worker.addEventListener("close", onClose);
			return () => worker.removeEventListener("close", onClose);
		},
		async terminate() {
			worker.terminate();
		},
	};
}

async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	type StartupPhase = "await-bootstrap" | "bootstrap-confirmed" | "await-init";
	let phase: StartupPhase = "await-bootstrap";
	const { promise: bootstrap, resolve: bootstrapReady, reject: rejectBootstrap } = Promise.withResolvers<void>();
	const { promise: initialized, resolve: ready, reject: rejectInitialized } = Promise.withResolvers<ReadyInfo>();
	void initialized.catch(() => undefined);
	const fail = (stage: string): void => {
		const error = startupError(stage);
		rejectBootstrap(error);
		rejectInitialized(error);
	};
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "log") {
			logWorkerMessage(msg);
			return;
		}
		if (phase === "await-bootstrap") {
			if (msg.type === "bootstrap-ready" && msg.version === 1 && msg.mode === TAB_WORKER_MODE) {
				phase = "bootstrap-confirmed";
				bootstrapReady();
			} else if (msg.type === "bootstrap-failed") {
				fail("bootstrap");
			} else if (msg.type === "closed") {
				fail("protocol-closed");
			} else {
				fail("protocol-phase");
			}
			return;
		}
		if (phase !== "await-init") {
			fail("protocol-phase");
			return;
		}
		if (msg.type === "ready") {
			ready(msg.info);
		} else if (msg.type === "init-failed") {
			fail("init");
		} else if (msg.type === "closed") {
			fail("protocol-closed");
		} else {
			fail("protocol-phase");
		}
	});
	const unlistenError = worker.onError(() => fail("error"));
	const unlistenClose = worker.onClose(() => fail("physical-close"));
	try {
		worker.send({ type: "bootstrap", version: 1, mode: TAB_WORKER_MODE });
		await raceWithTimeout(bootstrap, timeoutMs, startupError("bootstrap-timeout").message);
		phase = "await-init";
		worker.send({ type: "init", payload });
		return await raceWithTimeout(initialized, timeoutMs, startupError("init-timeout").message);
	} finally {
		unlisten();
		unlistenError();
		unlistenClose();
	}
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs);
}
