import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import type { BrowserParams } from "../../src/tools/browser";
import { BrowserTool } from "../../src/tools/browser";
import type { BrowserHandle, BrowserKindTag } from "../../src/tools/browser/registry";
import {
	clearTabsForTest,
	getTab,
	releaseAllTabs,
	releaseTab,
	setTabForTest,
	type TabSession,
} from "../../src/tools/browser/tab-supervisor";

const NEVER = (): Promise<never> => new Promise<never>(() => {});
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface FakeTabOptions {
	name: string;
	kindTag?: BrowserKindTag;
	kind?: BrowserHandle["kind"];
	refCount?: number;
	state?: "alive" | "dead";
	/** Worker never emits "closed" for waitForClosed. */
	silentClose?: boolean;
	/** worker.terminate() never resolves. */
	hangTerminate?: boolean;
	/** browser.close() never resolves (headless graceful-close hang). */
	hangBrowserClose?: boolean;
	/** browser.disconnect() throws (dying CDP target). */
	throwDisconnect?: boolean;
}

interface FakeTab {
	terminate: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	handle: BrowserHandle;
}

function installFakeTab(opts: FakeTabOptions): FakeTab {
	const close = vi.fn(opts.hangBrowserClose ? () => NEVER() : async () => {});
	const disconnect = vi.fn(() => {
		if (opts.throwDisconnect) throw new Error("CDP target already gone");
	});
	const browser = {
		connected: true,
		close,
		disconnect,
		process: () => null,
		targets: () => [],
	} as unknown as Browser;
	const handle = {
		key: `close-deadline:${opts.name}`,
		kind: opts.kind ?? { kind: "headless", headless: true },
		browser,
		refCount: opts.refCount ?? 1,
		stealth: { browserSession: null, override: null },
	} as BrowserHandle;

	const handlers = new Set<(m: { type: string }) => void>();
	const terminate = vi.fn(opts.hangTerminate ? () => NEVER() : async () => {});
	const worker = {
		send: (msg: { type: string }) => {
			if (msg.type === "close" && !opts.silentClose) {
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

	const tab = {
		name: opts.name,
		browser: handle,
		targetId: `target-${opts.name}`,
		worker,
		state: opts.state ?? "alive",
		info: { targetId: `target-${opts.name}` },
		pending: new Map(),
		kindTag: opts.kindTag ?? "headless",
		lastUsedAt: Date.now(),
	} as unknown as TabSession;
	setTabForTest(tab);
	return { terminate, close, disconnect, handle };
}

function makeCloseParams(overrides: Partial<BrowserParams> = {}): BrowserParams {
	return { action: "close", timeout: 1, ...overrides } as BrowserParams;
}

function newTool(): BrowserTool {
	return new BrowserTool({} as never);
}

describe("browser close/close-all end-to-end deadline (#2027)", () => {
	afterEach(() => {
		clearTabsForTest();
		vi.restoreAllMocks();
	});

	describe("repro: tool call must settle within the timeout budget", () => {
		it("close-all settles even when worker.terminate() never resolves", async () => {
			installFakeTab({ name: "a", hangTerminate: true });
			installFakeTab({ name: "b", hangTerminate: true });
			const tool = newTool();

			const started = Date.now();
			const settled = await Promise.race([
				tool.execute("t1", makeCloseParams({ all: true }), undefined).then(r => ({ kind: "settled", r }) as const),
				delay(3_000).then(() => ({ kind: "hung" }) as const),
			]);

			expect(settled.kind).toBe("settled");
			// One end-to-end budget (~1s), not unbounded.
			expect(Date.now() - started).toBeLessThan(3_000);
			expect(getTab("a")).toBeUndefined();
			expect(getTab("b")).toBeUndefined();
		});

		it("single-tab close settles even when headless browser.close() hangs (kill:false)", async () => {
			installFakeTab({ name: "main", hangBrowserClose: true });
			const tool = newTool();

			const settled = await Promise.race([
				tool.execute("t2", makeCloseParams({ name: "main" }), undefined).then(() => "settled" as const),
				delay(3_000).then(() => "hung" as const),
			]);

			expect(settled).toBe("settled");
			expect(getTab("main")).toBeUndefined();
		});
	});

	describe("control: normal (live-target) semantics are preserved", () => {
		it("close-all returns the exact close count and tears everything down", async () => {
			const a = installFakeTab({ name: "a" });
			const b = installFakeTab({ name: "b" });
			const tool = newTool();

			const result = await tool.execute("t3", makeCloseParams({ all: true }), undefined);

			expect(result.details?.result).toBe("Closed 2 tab(s)");
			expect(a.terminate).toHaveBeenCalledTimes(1);
			expect(b.terminate).toHaveBeenCalledTimes(1);
			expect(getTab("a")).toBeUndefined();
			expect(getTab("b")).toBeUndefined();
		});

		it("single-tab close returns the named-tab message", async () => {
			installFakeTab({ name: "main" });
			const tool = newTool();
			const result = await tool.execute("t4", makeCloseParams({ name: "main" }), undefined);
			expect(result.details?.result).toBe('Closed tab "main"');
		});

		it("close of an unknown tab reports no tab", async () => {
			const tool = newTool();
			const result = await tool.execute("t5", makeCloseParams({ name: "ghost" }), undefined);
			expect(result.details?.result).toBe('No tab named "ghost"');
		});
	});

	describe("attack matrix (releaseTab/releaseAllTabs with a shared deadline)", () => {
		it("bounds worker.terminate() to the deadline and still removes the tab", async () => {
			const { terminate } = installFakeTab({ name: "a", hangTerminate: true });
			const ok = await releaseTab("a", { kill: false, deadlineAt: Date.now() + 40 });
			expect(ok).toBe(true);
			expect(terminate).toHaveBeenCalledTimes(1);
			expect(getTab("a")).toBeUndefined();
		});

		it("bounds a hanging headless browser.close() to the deadline", async () => {
			installFakeTab({ name: "a", hangBrowserClose: true });
			const ok = await releaseTab("a", { kill: false, deadlineAt: Date.now() + 40 });
			expect(ok).toBe(true);
			expect(getTab("a")).toBeUndefined();
		});

		it("closes one dead-among-live tab and still counts every removal within one budget", async () => {
			installFakeTab({ name: "live1" });
			installFakeTab({ name: "dead", hangTerminate: true });
			installFakeTab({ name: "live2" });
			const started = Date.now();
			const count = await releaseAllTabs({ kill: false, deadlineAt: Date.now() + 60 });
			expect(count).toBe(3);
			expect(Date.now() - started).toBeLessThan(1_500);
			expect(getTab("live1")).toBeUndefined();
			expect(getTab("dead")).toBeUndefined();
			expect(getTab("live2")).toBeUndefined();
		});

		it("shares one aggregate budget across the serial multi-tab loop", async () => {
			for (const name of ["a", "b", "c", "d"]) installFakeTab({ name, hangTerminate: true });
			const started = Date.now();
			const count = await releaseAllTabs({ kill: false, deadlineAt: Date.now() + 50 });
			expect(count).toBe(4);
			// Not 4 x per-tab timeout: the shared deadline collapses later tabs to fast-bail.
			expect(Date.now() - started).toBeLessThan(1_500);
		});

		it("honors kill:true through the bounded path", async () => {
			const killSpy = installFakeTab({ name: "a" });
			await releaseTab("a", { kill: true, deadlineAt: Date.now() + 200 });
			expect(killSpy.close).toHaveBeenCalledTimes(1);
			expect(getTab("a")).toBeUndefined();
		});

		it("preserves the never-terminated worker's terminate call while settling", async () => {
			const { terminate } = installFakeTab({ name: "a", silentClose: true, hangTerminate: true });
			const ok = await releaseTab("a", { kill: false, deadlineAt: Date.now() + 40 });
			expect(ok).toBe(true);
			expect(terminate).toHaveBeenCalledTimes(1);
		});

		it("does not leak an unhandled rejection when a detached teardown step later rejects", async () => {
			const rejections: unknown[] = [];
			const onRejection = (err: unknown): void => {
				rejections.push(err);
			};
			process.on("unhandledRejection", onRejection);
			try {
				const worker = installFakeTab({ name: "a" });
				worker.terminate.mockImplementation(() =>
					delay(120).then(() => Promise.reject(new Error("late terminate"))),
				);
				const ok = await releaseTab("a", { kill: false, deadlineAt: Date.now() + 20 });
				expect(ok).toBe(true);
				await delay(200);
				expect(rejections).toHaveLength(0);
			} finally {
				process.off("unhandledRejection", onRejection);
			}
		});

		it("does not restart teardown when a concurrent release races the same tab", async () => {
			const { terminate } = installFakeTab({ name: "a" });
			const [r1, r2] = await Promise.all([
				releaseTab("a", { kill: false, deadlineAt: Date.now() + 200 }),
				releaseTab("a", { kill: false, deadlineAt: Date.now() + 200 }),
			]);
			expect([r1, r2].filter(Boolean)).toHaveLength(1);
			expect(terminate).toHaveBeenCalledTimes(1);
		});

		it("keeps unbounded teardown semantics for callers without a deadline (GC path)", async () => {
			const { terminate } = installFakeTab({ name: "a" });
			const ok = await releaseTab("a");
			expect(ok).toBe(true);
			expect(terminate).toHaveBeenCalledTimes(1);
			expect(getTab("a")).toBeUndefined();
		});
	});

	describe("abort interaction", () => {
		it("aborts promptly and lets abort win over the deadline", async () => {
			installFakeTab({ name: "main", hangTerminate: true });
			const tool = newTool();
			const controller = new AbortController();
			controller.abort();
			await expect(tool.execute("t6", makeCloseParams({ name: "main" }), controller.signal)).rejects.toThrow();
		});
	});
});
