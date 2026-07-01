import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import type { BrowserHandle, BrowserKindTag } from "../../src/tools/browser/registry";
import {
	clearTabsForTest,
	dropDefaultBackendTabs,
	getTab,
	setTabForTest,
	type TabSession,
} from "../../src/tools/browser/tab-supervisor";

let counter = 0;

function fakeBrowser(): Browser {
	return {
		connected: true,
		close: vi.fn(async () => {}),
		disconnect: vi.fn(() => {}),
		process: () => null,
		targets: () => [],
	} as unknown as Browser;
}

function fakeWorker(): TabSession["worker"] {
	const handlers = new Set<(m: { type: string }) => void>();
	return {
		send: (msg: { type: string }) => {
			if (msg.type === "close") {
				queueMicrotask(() => {
					handlers.forEach(h => {
						h({ type: "closed" });
					});
				});
			}
		},
		onMessage: (h: (m: { type: string }) => void) => {
			handlers.add(h);
			return () => handlers.delete(h);
		},
		onError: () => () => {},
		terminate: vi.fn(async () => {}),
		mode: "worker" as const,
	} as unknown as TabSession["worker"];
}

function install(name: string, kindTag: BrowserKindTag, pendingCount = 0): void {
	const pending = new Map<string, unknown>();
	for (let i = 0; i < pendingCount; i++) pending.set(`p${i}`, { reject() {}, resolve() {}, toolCalls: new Map() });
	const handle = {
		driver: "native",
		key: `k-${counter++}`,
		kind: { kind: kindTag },
		browser: fakeBrowser(),
		refCount: 1,
		stealth: { browserSession: null, override: null },
	} as unknown as BrowserHandle;
	const tab = {
		name,
		browser: handle,
		targetId: "t1",
		worker: fakeWorker(),
		state: "alive",
		info: { targetId: "t1" },
		pending,
		kindTag,
		defaultBackend: kindTag === "headless" || kindTag === "aside",
		lastUsedAt: Date.now(),
	} as unknown as TabSession;
	setTabForTest(tab);
}

describe("dropDefaultBackendTabs (backend switch)", () => {
	beforeEach(() => clearTabsForTest());
	afterEach(() => {
		clearTabsForTest();
		vi.restoreAllMocks();
	});

	it("drops default-backend tabs (headless, aside) and keeps explicit app.* tabs", async () => {
		install("headless-default", "headless");
		install("aside-default", "aside");
		install("spawned-app", "spawned");
		install("connected-app", "connected");

		const dropped = await dropDefaultBackendTabs();
		expect(dropped).toBe(2);
		expect(getTab("headless-default")).toBeUndefined();
		expect(getTab("aside-default")).toBeUndefined();
		expect(getTab("spawned-app")).toBeDefined();
		expect(getTab("connected-app")).toBeDefined();
	});

	it("blocks the switch when a default-backend tab is busy", async () => {
		install("busy-default", "headless", 1);
		install("app-tab", "connected");
		await expect(dropDefaultBackendTabs()).rejects.toThrow(/busy/i);
		// Nothing dropped; the busy guard runs before any release.
		expect(getTab("busy-default")).toBeDefined();
		expect(getTab("app-tab")).toBeDefined();
	});

	it("forced includeBusy drops busy default tabs too", async () => {
		install("busy-default", "aside", 1);
		const dropped = await dropDefaultBackendTabs({ includeBusy: true });
		expect(dropped).toBe(1);
		expect(getTab("busy-default")).toBeUndefined();
	});

	it("is a no-op when only explicit app.* tabs exist", async () => {
		install("spawned-app", "spawned");
		const dropped = await dropDefaultBackendTabs();
		expect(dropped).toBe(0);
		expect(getTab("spawned-app")).toBeDefined();
	});
});
