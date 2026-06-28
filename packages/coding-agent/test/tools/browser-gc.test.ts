import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import type { BrowserHandle, BrowserKindTag } from "../../src/tools/browser/registry";
import {
	clearTabsForTest,
	getTab,
	listTabsForGc,
	releaseTab,
	releaseTabIfGcEligible,
	setTabForTest,
	type TabSession,
} from "../../src/tools/browser/tab-supervisor";

const NOW = 1_000_000;
const IDLE_MS = 1000;
const policy = { now: () => NOW, idleMs: IDLE_MS };

let counter = 0;

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
		key: `headless:test-${counter++}`,
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
			if (msg.type === "close")
				queueMicrotask(() => {
					for (const handler of [...handlers]) handler({ type: "closed" });
				});
		},
		onMessage: (handler: (m: { type: string }) => void) => {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		onError: () => () => {},
		terminate,
		mode: "worker" as const,
	} as unknown as TabSession["worker"];
	return { worker, terminate };
}

interface InstallOpts {
	name: string;
	kindTag: BrowserKindTag;
	lastUsedAt: number;
	state?: "alive" | "dead";
	pendingCount?: number;
	refCount?: number;
}

function installTab(opts: InstallOpts): {
	close: ReturnType<typeof vi.fn>;
	terminate: ReturnType<typeof vi.fn>;
	handle: BrowserHandle;
} {
	const { handle, close } = makeFakeBrowser(opts.refCount ?? 1);
	const { worker, terminate } = makeFakeWorker();
	const pending = new Map<string, unknown>();
	for (let i = 0; i < (opts.pendingCount ?? 0); i++) {
		pending.set(`p${i}`, { reject: () => {}, resolve: () => {}, toolCalls: new Map() });
	}
	const tab = {
		name: opts.name,
		browser: handle,
		targetId: "target-1",
		worker,
		state: opts.state ?? "alive",
		info: { targetId: "target-1" },
		pending,
		kindTag: opts.kindTag,
		lastUsedAt: opts.lastUsedAt,
	} as unknown as TabSession;
	setTabForTest(tab);
	return { close, terminate, handle };
}

describe("tab-supervisor GC primitives", () => {
	beforeEach(() => {
		clearTabsForTest();
	});
	afterEach(() => {
		clearTabsForTest();
		vi.restoreAllMocks();
	});

	it("evicts an idle headless tab: worker terminated, browser closed, tab removed", async () => {
		const { close, terminate } = installTab({ name: "a", kindTag: "headless", lastUsedAt: NOW - 5000 });
		const released = await releaseTabIfGcEligible("a", policy);
		expect(released).toBe(true);
		expect(terminate).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(getTab("a")).toBeUndefined();
	});

	it("evicts an idle spawned tab", async () => {
		const { close } = installTab({ name: "a", kindTag: "spawned", lastUsedAt: NOW - 5000 });
		expect(await releaseTabIfGcEligible("a", policy)).toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
	});

	const protectedCases: Array<{ label: string; opts: InstallOpts }> = [
		{ label: "connected", opts: { name: "a", kindTag: "connected", lastUsedAt: NOW - 5000 } },
		{ label: "chrome-profile", opts: { name: "a", kindTag: "chrome-profile", lastUsedAt: NOW - 5000 } },
		{ label: "in-flight", opts: { name: "a", kindTag: "headless", lastUsedAt: NOW - 5000, pendingCount: 1 } },
		{ label: "recently used", opts: { name: "a", kindTag: "headless", lastUsedAt: NOW } },
		{ label: "idle exactly at threshold", opts: { name: "a", kindTag: "headless", lastUsedAt: NOW - IDLE_MS } },
		{ label: "dead", opts: { name: "a", kindTag: "headless", lastUsedAt: NOW - 5000, state: "dead" } },
	];

	for (const { label, opts } of protectedCases) {
		it(`never evicts a ${label} tab`, async () => {
			const { close } = installTab(opts);
			expect(await releaseTabIfGcEligible("a", policy)).toBe(false);
			expect(close).not.toHaveBeenCalled();
			expect(getTab("a")).toBeDefined();
		});
	}

	it("does not evict a tab that became busy after a GC snapshot", async () => {
		installTab({ name: "a", kindTag: "headless", lastUsedAt: NOW - 5000 });
		const snapshot = listTabsForGc();
		expect(snapshot.find(s => s.name === "a")?.pendingCount).toBe(0); // eligible at snapshot time
		// Tab becomes busy after the snapshot but before eviction.
		getTab("a")?.pending.set("run", { reject: () => {}, resolve: () => {}, toolCalls: new Map() } as never);
		expect(await releaseTabIfGcEligible("a", policy)).toBe(false);
		expect(getTab("a")).toBeDefined();
	});

	it("decrements browser refCount exactly once under concurrent double release", async () => {
		const { close, handle } = installTab({ name: "a", kindTag: "headless", lastUsedAt: NOW - 5000, refCount: 1 });
		const [r1, r2] = await Promise.all([releaseTab("a"), releaseTab("a")]);
		expect([r1, r2].filter(Boolean)).toHaveLength(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(handle.refCount).toBe(0);
		expect(getTab("a")).toBeUndefined();
	});

	it("listTabsForGc reflects live tab fields without exposing the map", () => {
		installTab({ name: "a", kindTag: "headless", lastUsedAt: 4242, refCount: 2 });
		const snap = listTabsForGc();
		expect(snap).toHaveLength(1);
		expect(snap[0]).toMatchObject({
			name: "a",
			state: "alive",
			pendingCount: 0,
			kindTag: "headless",
			lastUsedAt: 4242,
			browserRefCount: 2,
		});
	});
});
