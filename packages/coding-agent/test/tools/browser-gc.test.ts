import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import {
	__resetDeadTabRecoveryForTest,
	__setDeadTabRecoveryDepsForTest,
	registerDeadTabRecovery,
} from "../../src/tools/browser/dead-tab-recovery";
import type { BrowserHandle, BrowserKindTag } from "../../src/tools/browser/registry";
import {
	clearTabsForTest,
	getTab,
	listTabsForGc,
	releaseDeadTabForRecovery,
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
		__resetDeadTabRecoveryForTest();
	});
	afterEach(() => {
		clearTabsForTest();
		vi.restoreAllMocks();
		__resetDeadTabRecoveryForTest();
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

	it("retains a dead tab during its live recovery TTL, then GC releases that exact tab", async () => {
		let now = NOW;
		__setDeadTabRecoveryDepsForTest({ now: () => now });
		const { close } = installTab({ name: "dead", kindTag: "headless", lastUsedAt: NOW - 5000, state: "dead" });
		const dead = getTab("dead")!;
		registerDeadTabRecovery("dead", dead.ownerId, { dead }, 100);
		expect(await releaseTabIfGcEligible("dead", { now: () => now, idleMs: IDLE_MS })).toBe(false);
		expect(getTab("dead")).toBe(dead);
		now += 100;
		expect(await releaseTabIfGcEligible("dead", { now: () => now, idleMs: IDLE_MS })).toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
		expect(getTab("dead")).toBeUndefined();
	});

	it("closes an orphaned headless target during ordinary dead-tab release", async () => {
		const { handle } = installTab({ name: "dead", kindTag: "headless", lastUsedAt: NOW - 5000, state: "dead" });
		const closeTarget = vi.fn(async () => {});
		(handle.browser as unknown as { targets(): unknown[] }).targets = () => [
			{ _targetId: "target-1", page: async () => ({ close: closeTarget }) },
		];
		expect(await releaseTab("dead")).toBe(true);
		expect(closeTarget).toHaveBeenCalledTimes(1);
	});

	it("exact dead-session release cannot remove a same-name replacement", async () => {
		const { handle } = installTab({ name: "tab", kindTag: "headless", lastUsedAt: NOW, state: "dead" });
		const dead = getTab("tab")!;
		const replacement = { ...dead, state: "alive", releasing: undefined } as TabSession;
		setTabForTest(replacement);
		expect(await releaseDeadTabForRecovery("tab", dead, dead.ownerId)).toBe(false);
		expect(getTab("tab")).toBe(replacement);
		expect(handle.refCount).toBe(1);
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
