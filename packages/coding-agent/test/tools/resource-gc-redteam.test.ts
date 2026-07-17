import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import { Settings } from "../../src/config/settings";
import type { BrowserHandle, BrowserKindTag } from "../../src/tools/browser/registry";
import {
	clearTabsForTest,
	getTab,
	listTabsForGc,
	releaseTabIfGcEligible,
	setTabForTest,
	type TabGcSnapshot,
	type TabSession,
} from "../../src/tools/browser/tab-supervisor";
import {
	__resetResourceGcForTest,
	type ResourceGcDeps,
	registerResourceGcSession,
	sweepOnce,
} from "../../src/tools/resource-gc";

const MB = 1024 * 1024;
const NOW = 7_000_000;
const IDLE_MS = 1000;

function snapshot(
	name: string,
	ownerId: string | undefined,
	lastUsedAt: number,
	over: Partial<TabGcSnapshot> = {},
): TabGcSnapshot {
	return {
		name,
		ownerId,
		state: "alive",
		pendingCount: 0,
		kindTag: "headless",
		lastUsedAt,
		browserRefCount: 1,
		...over,
	};
}

function baseDeps(over: Partial<ResourceGcDeps> = {}): ResourceGcDeps {
	return {
		now: () => NOW,
		rssBytes: () => 1,
		logWarn: vi.fn(),
		listTabs: () => [],
		releaseTab: vi.fn(async () => true),
		cleanupScreenshots: vi.fn(async () => ({ scanned: 0, removed: 0 })),
		screenshotArmed: () => false,
		...over,
	};
}

let browserCounter = 0;

function makeFakeBrowser(refCount: number): { handle: BrowserHandle; close: ReturnType<typeof vi.fn> } {
	const close = vi.fn(async () => {});
	const browser = {
		connected: true,
		close,
		disconnect: vi.fn(() => {}),
		process: () => null,
		targets: () => [],
	} as unknown as Browser;
	const handle = {
		key: `headless:redteam-${browserCounter++}`,
		kind: { kind: "headless", headless: true },
		browser,
		refCount,
		stealth: { browserSession: null, override: null },
	} as BrowserHandle;
	return { handle, close };
}

function makeFakeWorker(): { worker: TabSession["worker"]; terminate: ReturnType<typeof vi.fn> } {
	const handlers = new Set<(m: { type: string }) => void>();
	const terminate = vi.fn(async () => {});
	const worker = {
		send: (msg: { type: string }) => {
			if (msg.type === "close") {
				queueMicrotask(() => {
					for (const handler of [...handlers]) handler({ type: "closed" });
				});
			}
		},
		onMessage: (handler: (m: { type: string }) => void) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		onError: () => () => {},
		terminate,
		mode: "worker" as const,
	} as unknown as TabSession["worker"];
	return { worker, terminate };
}

interface InstallOpts {
	name: string;
	ownerId?: string;
	kindTag?: BrowserKindTag;
	lastUsedAt: number;
	pendingCount?: number;
	refCount?: number;
}

function installTab(opts: InstallOpts): { close: ReturnType<typeof vi.fn>; handle: BrowserHandle } {
	const { handle, close } = makeFakeBrowser(opts.refCount ?? 1);
	const { worker } = makeFakeWorker();
	const pending = new Map<string, unknown>();
	for (let i = 0; i < (opts.pendingCount ?? 0); i++) {
		pending.set(`p${i}`, { reject: () => {}, resolve: () => {}, toolCalls: new Map() });
	}
	setTabForTest({
		name: opts.name,
		browser: handle,
		targetId: "target-1",
		worker,
		state: "alive",
		info: { targetId: "target-1" },
		pending,
		kindTag: opts.kindTag ?? "headless",
		ownerId: opts.ownerId,
		lastUsedAt: opts.lastUsedAt,
	} as unknown as TabSession);
	return { close, handle };
}

function registerSession(overrides: Record<string, unknown> = {}): void {
	registerResourceGcSession({
		sessionId: "s1",
		settings: Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": IDLE_MS,
			"browser.gc.rssLimitMb": 100,
			"computer.screenshotGc.enabled": false,
			...overrides,
		}),
	});
}

describe("resource GC red-team safety invariants", () => {
	beforeEach(() => {
		clearTabsForTest();
		__resetResourceGcForTest();
	});
	afterEach(() => {
		clearTabsForTest();
		__resetResourceGcForTest();
		vi.restoreAllMocks();
	});

	it("never evicts ownerless tabs under RSS pressure and warns once", async () => {
		registerSession({ "browser.gc.idleMs": 10_000_000 });
		const release = vi.fn(async () => true);
		const logWarn = vi.fn();

		await sweepOnce(
			baseDeps({
				rssBytes: () => 200 * MB,
				logWarn,
				releaseTab: release,
				listTabs: () => [snapshot("ownerless", undefined, NOW - 50_000)],
			}),
		);

		expect(release).not.toHaveBeenCalled();
		expect(logWarn).toHaveBeenCalledTimes(1);
	});

	it("does not close a tab that flips in-flight between snapshot and eviction", async () => {
		const { close } = installTab({ name: "a", ownerId: "s1", lastUsedAt: NOW - 50_000 });
		const snap = listTabsForGc();
		expect(snap.find(tab => tab.name === "a")?.pendingCount).toBe(0);
		getTab("a")?.pending.set("late-run", { reject: () => {}, resolve: () => {}, toolCalls: new Map() } as never);

		expect(await releaseTabIfGcEligible("a", { now: () => NOW, idleMs: IDLE_MS })).toBe(false);
		expect(close).not.toHaveBeenCalled();
		expect(getTab("a")?.state).toBe("alive");
	});

	it("does not double-release tabs eligible for both idle and RSS pressure", async () => {
		registerSession();
		const first = installTab({ name: "a", ownerId: "s1", lastUsedAt: NOW - 50_000 });
		const second = installTab({ name: "b", ownerId: "s1", lastUsedAt: NOW - 40_000 });

		await sweepOnce(
			baseDeps({
				rssBytes: () => 200 * MB,
				listTabs: () => listTabsForGc(),
				releaseTab: (name, policy) => releaseTabIfGcEligible(name, policy),
			}),
		);

		expect(first.close).toHaveBeenCalledTimes(1);
		expect(second.close).toHaveBeenCalledTimes(1);
		expect(getTab("a")).toBeUndefined();
		expect(getTab("b")).toBeUndefined();
	});

	it("RSS oscillation re-warns exactly once per over-limit episode", async () => {
		registerSession({ "browser.gc.idleMs": 10_000_000 });
		const logWarn = vi.fn();
		let rss = 200 * MB;
		const deps = baseDeps({
			logWarn,
			rssBytes: () => rss,
			listTabs: () => [snapshot("ownerless", undefined, NOW - 50_000)],
		});

		await sweepOnce(deps);
		await sweepOnce(deps);
		expect(logWarn).toHaveBeenCalledTimes(1);

		rss = 50 * MB;
		await sweepOnce(deps);
		rss = 200 * MB;
		await sweepOnce(deps);
		await sweepOnce(deps);
		expect(logWarn).toHaveBeenCalledTimes(2);
	});

	it("disabled browser GC performs no eviction even when idle and over limit", async () => {
		registerSession({ "browser.gc.enabled": false, "browser.gc.idleMs": IDLE_MS, "browser.gc.rssLimitMb": 100 });
		const release = vi.fn(async () => true);
		const logWarn = vi.fn();

		await sweepOnce(
			baseDeps({
				rssBytes: () => 200 * MB,
				logWarn,
				releaseTab: release,
				listTabs: () => [snapshot("disabled", "s1", NOW - IDLE_MS - 1)],
			}),
		);

		expect(release).not.toHaveBeenCalled();
		expect(logWarn).not.toHaveBeenCalled();
	});

	it("does not evict a tab idle exactly at the configured threshold", async () => {
		registerSession({ "browser.gc.rssLimitMb": 1_000_000 });
		const release = vi.fn(async () => true);

		await sweepOnce(
			baseDeps({
				releaseTab: release,
				listTabs: () => [snapshot("boundary", "s1", NOW - IDLE_MS)],
			}),
		);

		expect(release).not.toHaveBeenCalled();
	});
});
