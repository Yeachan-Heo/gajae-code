import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	__resetDeadTabRecoveryForTest,
	__setDeadTabRecoveryDepsForTest,
	consumeDeadTabRecovery,
	peekDeadTabRecovery,
	registerDeadTabRecovery,
} from "../../src/tools/browser/dead-tab-recovery";
import type { BrowserHandle } from "../../src/tools/browser/registry";
import {
	__setAcquireTabWorkerDepsForTest,
	__setAfterWorkerInitializationForTest,
	__setRecoveringTabForTest,
	acquireTab,
	buildInitPayloadForTest,
	clearTabsForTest,
	closeOrphanTargetForTest,
	getTab,
	recoveryPromiseForOwnerForTest,
	setTabForTest,
	type TabSession,
	withTemporaryBrowserHoldForTest,
} from "../../src/tools/browser/tab-supervisor";

describe("dead tab recovery descriptors (#2437)", () => {
	afterEach(() => __resetDeadTabRecoveryForTest());
	afterEach(() => clearTabsForTest());

	it("expires descriptors without consuming a replacement", () => {
		let now = 1_000;
		__setDeadTabRecoveryDepsForTest({ now: () => now });
		registerDeadTabRecovery("tab", "owner", { version: 1 }, 10);
		now += 10;
		expect(consumeDeadTabRecovery<{ version: number }>("tab", "owner").status).toBe("expired_or_missing");
		registerDeadTabRecovery("tab", "owner", { version: 2 }, 10);
		expect(consumeDeadTabRecovery<{ version: number }>("tab", "owner")).toEqual({
			status: "consumed",
			descriptor: { version: 2 },
		});
	});

	it("keeps a descriptor consumable by its rightful owner after an owner mismatch", () => {
		registerDeadTabRecovery("tab", "owner-a", { retained: true });
		expect(peekDeadTabRecovery("tab", "owner-b").status).toBe("owner_mismatch");
		expect(consumeDeadTabRecovery("tab", "owner-b").status).toBe("owner_mismatch");
		expect(consumeDeadTabRecovery<{ retained: boolean }>("tab", "owner-a")).toEqual({
			status: "consumed",
			descriptor: { retained: true },
		});
	});

	it("expires exactly between peek and consume while retaining the observed descriptor", () => {
		let now = 1_000;
		__setDeadTabRecoveryDepsForTest({
			now: () => now,
			onPeek: () => {
				now += 10;
			},
		});
		registerDeadTabRecovery("tab", "owner", { tabIdentity: "dead-tab" }, 10);

		const peeked = peekDeadTabRecovery<{ tabIdentity: string }>("tab", "owner");
		expect(peeked).toEqual({ status: "consumed", descriptor: { tabIdentity: "dead-tab" } });
		expect(consumeDeadTabRecovery("tab", "owner").status).toBe("expired_or_missing");
	});

	it("builds an attach worker payload for a preserved headless recovery target", async () => {
		const browser = {
			browser: { wsEndpoint: () => "ws://browser" },
			kind: { kind: "headless", headless: true },
		} as unknown as BrowserHandle;
		await expect(
			buildInitPayloadForTest(browser, { timeoutMs: 100, recoveryTargetId: "preserved-target" }),
		).resolves.toEqual(expect.objectContaining({ mode: "attach", targetId: "preserved-target" }));
	});

	it("balances temporary holds on success and failure without closing early", async () => {
		const close = vi.fn(async () => {});
		const browser = {
			refCount: 1,
			kind: { kind: "headless", headless: true },
			browser: { connected: true, close },
		} as unknown as BrowserHandle;
		await expect(withTemporaryBrowserHoldForTest(browser, async () => "ok")).resolves.toBe("ok");
		expect(browser.refCount).toBe(1);
		expect(close).not.toHaveBeenCalled();
		await expect(
			withTemporaryBrowserHoldForTest(browser, async () => {
				throw new Error("fail");
			}),
		).rejects.toThrow("fail");
		expect(browser.refCount).toBe(1);
		expect(close).not.toHaveBeenCalled();
	});

	it("closes only the preserved target selected by target id", async () => {
		const selected = vi.fn(async () => {});
		const sibling = vi.fn(async () => {});
		const tab = {
			targetId: "preserved",
			browser: {
				browser: {
					targets: () => [
						{ _targetId: "sibling", page: async () => ({ close: sibling }) },
						{ _targetId: "preserved", page: async () => ({ close: selected }) },
					],
				},
			},
		} as unknown as TabSession;
		await closeOrphanTargetForTest(tab);
		expect(selected).toHaveBeenCalledTimes(1);
		expect(sibling).not.toHaveBeenCalled();
	});

	it("does not expose an in-flight owner recovery to a foreign owner", () => {
		const { promise, resolve } = Promise.withResolvers<TabSession>();
		__setRecoveringTabForTest("tab", "owner-a", promise);
		expect(recoveryPromiseForOwnerForTest("tab", "owner-b")).toBeUndefined();
		expect(recoveryPromiseForOwnerForTest("tab", "owner-a")).toBe(promise);
		resolve({} as TabSession);
	});

	it("fences recovery acquisition when a replacement appears during worker initialization", async () => {
		const terminate = vi.fn(async () => {});
		const worker = {
			mode: "worker" as const,
			send: () => {},
			onMessage: () => () => {},
			onError: () => () => {},
			terminate,
		};
		const browser = {
			refCount: 1,
			kind: { kind: "headless", headless: true },
			browser: { wsEndpoint: () => "ws://browser", connected: true, close: vi.fn(async () => {}) },
		} as unknown as BrowserHandle;
		const replacement = {
			name: "tab",
			browser,
			state: "alive",
			ownerId: "owner-b",
			pending: new Map(),
		} as unknown as TabSession;
		__setAcquireTabWorkerDepsForTest(
			async () => worker,
			async () => ({ targetId: "preserved", url: "", viewport: { width: 1, height: 1 } }),
		);
		__setAfterWorkerInitializationForTest(() => setTabForTest(replacement));
		await expect(
			acquireTab("tab", browser, { timeoutMs: 10, recoveryTargetId: "preserved", requireVacantName: true }),
		).rejects.toThrow("replaced during recovery");
		expect(terminate).toHaveBeenCalledTimes(1);
		expect(getTab("tab")).toBe(replacement);
		expect(browser.refCount).toBe(1);
	});
});
