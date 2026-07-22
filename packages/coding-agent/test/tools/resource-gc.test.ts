import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectAgentDir, Snowflake } from "@gajae-code/utils";
import { YAML } from "bun";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import type { TabGcSnapshot } from "../../src/tools/browser/tab-supervisor";
import {
	__getResourceGcStateForTest,
	__resetResourceGcForTest,
	__runResourceGcTickForTest,
	__runResourceGcTimerCallbackForTest,
	__setResourceGcDepsForTest,
	__setResourceGcSchedulerNowForTest,
	type ResourceGcDeps,
	registerResourceGcSession,
	resolveBrowserGcPolicy,
	resolveComputerGcPolicy,
	resolveSweepIntervalMs,
	sweepOnce,
} from "../../src/tools/resource-gc";

const MB = 1024 * 1024;
const NOW = 5_000_000;

function snapshot(name: string, ownerId: string, lastUsedAt: number, over: Partial<TabGcSnapshot> = {}): TabGcSnapshot {
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

function gcSettings(interval: number): Settings {
	return Settings.isolated({
		"resourceGc.sweepIntervalMs": interval,
		"browser.gc.enabled": true,
		"browser.gc.idleMs": 1,
		"browser.gc.rssLimitMb": 1_000_000,
		"computer.screenshotGc.enabled": false,
	});
}
async function flushMicrotasks(turns = 6): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await Promise.resolve();
	}
}
function controlledScheduler(): { advance: (ms: number) => Promise<void> } {
	let now = 1000;
	vi.useFakeTimers({ now });
	__setResourceGcSchedulerNowForTest(() => now);
	return {
		advance: async (ms: number) => {
			now += ms;
			vi.advanceTimersByTime(ms);
			await flushMicrotasks();
			expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
		},
	};
}

function expectSchedulerStopped(): void {
	expect(__getResourceGcStateForTest()).toMatchObject({
		sessionCount: 0,
		timerActive: false,
		pendingDeadline: null,
		pendingOwner: null,
		deferredDeadline: null,
		deferredGeneration: null,
		activeGeneration: null,
		inProgress: false,
	});
	expect(vi.getTimerCount()).toBe(0);
}

function controlledReleases(): { releaseTab: Mock<ResourceGcDeps["releaseTab"]>; resolve: (call: number) => void } {
	const resolvers: Array<() => void> = [];
	const releaseTab = vi.fn(() => {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		resolvers.push(() => resolve(true));
		return promise;
	});
	return {
		releaseTab,
		resolve: call => {
			const resolve = resolvers[call];
			expect(resolve).toBeDefined();
			resolve?.();
		},
	};
}

describe("resource GC controller", () => {
	afterEach(() => {
		__resetResourceGcForTest();
		vi.restoreAllMocks();
	});

	it("idle sweep evicts idle tabs oldest-first and spares recent ones", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": 1000,
			"browser.gc.rssLimitMb": 1_000_000,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });

		const releaseTab = vi.fn(async (_name: string) => true);
		await sweepOnce(
			baseDeps({
				releaseTab,
				listTabs: () => [
					snapshot("recent", "s1", NOW - 100),
					snapshot("old", "s1", NOW - 5000),
					snapshot("mid", "s1", NOW - 3000),
				],
			}),
		);

		expect(releaseTab.mock.calls.map(c => c[0])).toEqual(["old", "mid"]);
	});

	it("forwards expired dead managed tabs to the authoritative supervisor recheck", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": 1000,
			"browser.gc.rssLimitMb": 1_000_000,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });
		const releaseTab = vi.fn(async () => true);
		await sweepOnce(
			baseDeps({ releaseTab, listTabs: () => [snapshot("dead", "s1", NOW - 5000, { state: "dead" })] }),
		);
		expect(releaseTab).toHaveBeenCalledWith("dead", expect.objectContaining({ idleMs: 1000 }));
	});

	it("skips tabs owned by no registered session", async () => {
		const settings = Settings.isolated({ "browser.gc.idleMs": 1000, "browser.gc.rssLimitMb": 1_000_000 });
		registerResourceGcSession({ sessionId: "s1", settings });
		const releaseTab = vi.fn(async (_name: string) => true);
		await sweepOnce(
			baseDeps({
				releaseTab,
				listTabs: () => [snapshot("orphan", "ghost-session", NOW - 5000), snapshot("mine", "s1", NOW - 5000)],
			}),
		);
		expect(releaseTab.mock.calls.map(c => c[0])).toEqual(["mine"]);
	});

	it("warns under RSS pressure when only a recovery-held dead tab remains", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": 1000,
			"browser.gc.rssLimitMb": 100,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });
		const logWarn = vi.fn();
		await sweepOnce(
			baseDeps({
				logWarn,
				rssBytes: () => 200 * MB,
				listTabs: () => [snapshot("recovering", "s1", NOW - 5000, { state: "dead" })],
			}),
		);
		expect(logWarn).toHaveBeenCalledTimes(1);
	});

	it("never evicts non-idle tabs under RSS pressure (IR-1) and warns once instead", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": 10_000_000, // huge: nothing is idle-eligible
			"browser.gc.rssLimitMb": 100,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });

		const releaseTab = vi.fn(async (_name: string) => true);
		const logWarn = vi.fn();
		await sweepOnce(
			baseDeps({
				releaseTab,
				logWarn,
				rssBytes: () => 200 * MB,
				listTabs: () => [snapshot("recent", "s1", NOW - 100)],
			}),
		);

		expect(releaseTab).not.toHaveBeenCalled();
		expect(logWarn).toHaveBeenCalledTimes(1);
	});

	it("evicts idle tabs LRU under pressure, then warns once if still over limit", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": 1000,
			"browser.gc.rssLimitMb": 100,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });

		const removed = new Set<string>();
		const releaseTab = vi.fn(async (name: string) => {
			removed.add(name);
			return true;
		});
		const logWarn = vi.fn();
		const tabs = [snapshot("c", "s1", NOW - 2000), snapshot("a", "s1", NOW - 5000), snapshot("b", "s1", NOW - 3000)];
		await sweepOnce(
			baseDeps({
				releaseTab,
				logWarn,
				rssBytes: () => 200 * MB, // stays over limit even after reclamation
				listTabs: () => tabs.filter(t => !removed.has(t.name)),
			}),
		);

		expect(releaseTab.mock.calls.map(c => c[0])).toEqual(["a", "b", "c"]);
		expect(logWarn).toHaveBeenCalledTimes(1);
	});

	it("warns exactly once per continuous no-evictable RSS-pressure episode", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": 10_000_000,
			"browser.gc.rssLimitMb": 100,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });

		const logWarn = vi.fn();
		let rss = 200 * MB;
		const deps = baseDeps({ logWarn, rssBytes: () => rss, listTabs: () => [] });

		await sweepOnce(deps);
		await sweepOnce(deps);
		expect(logWarn).toHaveBeenCalledTimes(1);

		rss = 50 * MB; // recovery resets the episode
		await sweepOnce(deps);
		rss = 200 * MB;
		await sweepOnce(deps);
		expect(logWarn).toHaveBeenCalledTimes(2);
	});

	it("reference-counts the shared timer across sessions", () => {
		const settings = Settings.isolated({});
		const unregister1 = registerResourceGcSession({ sessionId: "s1", settings });
		expect(__getResourceGcStateForTest()).toMatchObject({ timerActive: true, sessionCount: 1 });

		const unregister2 = registerResourceGcSession({ sessionId: "s2", settings });
		expect(__getResourceGcStateForTest()).toMatchObject({ timerActive: true, sessionCount: 2 });

		unregister1();
		expect(__getResourceGcStateForTest()).toMatchObject({ timerActive: true, sessionCount: 1 });

		unregister2();
		expect(__getResourceGcStateForTest()).toMatchObject({ timerActive: false, sessionCount: 0 });

		expect(() => unregister1()).not.toThrow(); // idempotent
		expect(__getResourceGcStateForTest().sessionCount).toBe(0);
	});

	it("does not run overlapping ticks", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": true,
			"browser.gc.idleMs": 1000,
			"browser.gc.rssLimitMb": 1_000_000,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });

		let resolveRelease: (() => void) | undefined;
		const releaseTab = vi.fn(
			() =>
				new Promise<boolean>(resolve => {
					resolveRelease = () => resolve(true);
				}),
		);
		__setResourceGcDepsForTest({
			releaseTab,
			listTabs: () => [snapshot("a", "s1", NOW - 5000)],
		});

		const first = __runResourceGcTickForTest(); // enters sweep, blocks on releaseTab
		await Promise.resolve();
		await __runResourceGcTickForTest(); // guard: returns immediately
		expect(releaseTab).toHaveBeenCalledTimes(1);

		resolveRelease?.();
		await first;
	});

	it("lazy-arms and throttles stale screenshot cleanup", async () => {
		const settings = Settings.isolated({
			"browser.gc.enabled": false,
			"computer.screenshotGc.enabled": true,
			"computer.screenshotGc.staleMs": 43_200_000,
			"computer.screenshotGc.scanIntervalMs": 1000,
		});
		registerResourceGcSession({ sessionId: "s1", settings });

		let armed = false;
		let clock = NOW;
		const cleanupScreenshots = vi.fn(async () => ({ scanned: 0, removed: 0 }));
		const deps = baseDeps({ cleanupScreenshots, screenshotArmed: () => armed, now: () => clock });

		await sweepOnce(deps);
		expect(cleanupScreenshots).not.toHaveBeenCalled(); // not armed yet

		armed = true;
		await sweepOnce(deps);
		expect(cleanupScreenshots).toHaveBeenCalledTimes(1);

		await sweepOnce(deps); // within scan interval → throttled
		expect(cleanupScreenshots).toHaveBeenCalledTimes(1);

		clock += 2000; // past scan interval
		await sweepOnce(deps);
		expect(cleanupScreenshots).toHaveBeenCalledTimes(2);
	});

	it("resolves documented defaults from settings", () => {
		const settings = Settings.isolated({});
		expect(resolveBrowserGcPolicy(settings)).toEqual({ enabled: true, idleMs: 300_000, rssLimitBytes: 1536 * MB });
		expect(resolveComputerGcPolicy(settings)).toEqual({
			enabled: true,
			staleMs: 43_200_000,
			scanIntervalMs: 1_800_000,
		});
		expect(resolveSweepIntervalMs(settings)).toBe(30_000);
	});
});

describe("resource GC monotonic scheduler", () => {
	afterEach(() => {
		__resetResourceGcForTest();
		expectSchedulerStopped();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("A: rearms only for an earlier distinct registration", async () => {
		const clock = controlledScheduler();
		const sweepStarts = vi.fn();
		const sweepCompletions = vi.fn();
		const releaseTab = vi.fn(async () => {
			sweepStarts();
			sweepCompletions();
			return true;
		});
		__setResourceGcDepsForTest({
			now: () => NOW,
			releaseTab,
			listTabs: () => [snapshot("short", "short", NOW - 5000)],
		});
		const unregisterLong = registerResourceGcSession({ sessionId: "long", settings: gcSettings(1000) });
		await clock.advance(100);
		const unregisterShort = registerResourceGcSession({ sessionId: "short", settings: gcSettings(100) });
		expect(__getResourceGcStateForTest()).toMatchObject({ pendingDeadline: 1200, timerActive: true });
		expect(vi.getTimerCount()).toBe(1);
		await clock.advance(99);
		expect(sweepStarts).toHaveBeenCalledTimes(0);
		expect(sweepCompletions).toHaveBeenCalledTimes(0);
		await clock.advance(1);
		expect(sweepStarts).toHaveBeenCalledTimes(1);
		expect(sweepCompletions).toHaveBeenCalledTimes(1);
		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 1300,
			timerActive: true,
			inProgress: false,
		});
		unregisterShort();
		unregisterLong();
		expectSchedulerStopped();
	});

	it("keeps unsupported duplicate session IDs from advancing the pending deadline", async () => {
		const clock = controlledScheduler();
		const unregisterOriginal = registerResourceGcSession({ sessionId: "same", settings: gcSettings(1000) });
		const originalState = __getResourceGcStateForTest();
		await clock.advance(100);
		const unregisterReplacement = registerResourceGcSession({ sessionId: "same", settings: gcSettings(100) });
		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 2000,
			pendingOwner: originalState.pendingOwner,
			sessionCount: 1,
		});
		expect(vi.getTimerCount()).toBe(1);
		unregisterReplacement();
		unregisterOriginal();
		expectSchedulerStopped();
	});

	it("B: equal and later registrations preserve the existing timer", async () => {
		const clock = controlledScheduler();
		const releaseTab = vi.fn(async () => true);
		__setResourceGcDepsForTest({
			now: () => NOW,
			releaseTab,
			listTabs: () => [snapshot("fast", "fast", NOW - 5000)],
		});
		const unregisterFast = registerResourceGcSession({ sessionId: "fast", settings: gcSettings(100) });
		const owner = __getResourceGcStateForTest().pendingOwner;
		await clock.advance(20);
		const unregisterEqual = registerResourceGcSession({ sessionId: "equal", settings: gcSettings(100) });
		await clock.advance(10);
		const unregisterSlow = registerResourceGcSession({ sessionId: "slow", settings: gcSettings(500) });
		expect(__getResourceGcStateForTest()).toMatchObject({ pendingDeadline: 1100, pendingOwner: owner });
		expect(vi.getTimerCount()).toBe(1);
		await clock.advance(70);
		expect(releaseTab).toHaveBeenCalledTimes(1);
		expect(__getResourceGcStateForTest().pendingDeadline).toBe(1200);
		unregisterSlow();
		unregisterEqual();
		unregisterFast();
		expectSchedulerStopped();
	});

	it("C: unregistering the shortest session never postpones pending work", async () => {
		const clock = controlledScheduler();
		const releaseTab = vi.fn(async () => true);
		__setResourceGcDepsForTest({
			now: () => NOW,
			releaseTab,
			listTabs: () => [snapshot("slow", "slow", NOW - 5000)],
		});
		const unregisterFast = registerResourceGcSession({ sessionId: "fast", settings: gcSettings(100) });
		const unregisterSlow = registerResourceGcSession({ sessionId: "slow", settings: gcSettings(1000) });
		await clock.advance(50);
		unregisterFast();
		expect(__getResourceGcStateForTest().pendingDeadline).toBe(1100);
		await clock.advance(50);
		expect(releaseTab).toHaveBeenCalledTimes(1);
		expect(__getResourceGcStateForTest().pendingDeadline).toBe(2100);
		unregisterSlow();
		expectSchedulerStopped();
	});

	it("D: retains an expired deferred deadline from timer-owned blocked work", async () => {
		const clock = controlledScheduler();
		const controlled = controlledReleases();
		__setResourceGcDepsForTest({
			now: () => NOW,
			releaseTab: controlled.releaseTab,
			listTabs: () => [snapshot("a", "a", NOW - 5000)],
		});
		const unregisterA = registerResourceGcSession({ sessionId: "a", settings: gcSettings(100) });
		await clock.advance(100);
		expect(controlled.releaseTab).toHaveBeenCalledTimes(1);
		await clock.advance(20);
		const unregisterB = registerResourceGcSession({ sessionId: "b", settings: gcSettings(25) });
		await clock.advance(80);
		expect(__getResourceGcStateForTest()).toMatchObject({
			deferredDeadline: 1145,
			timerActive: false,
			inProgress: true,
		});
		expect(vi.getTimerCount()).toBe(0);
		controlled.resolve(0);
		await flushMicrotasks();
		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 1145,
			deferredDeadline: null,
			inProgress: false,
		});
		expect(vi.getTimerCount()).toBe(1);
		await clock.advance(0);
		expect(controlled.releaseTab).toHaveBeenCalledTimes(2);
		expect(__getResourceGcStateForTest()).toMatchObject({
			inProgress: true,
			timerActive: false,
			deferredDeadline: null,
		});
		expect(vi.getTimerCount()).toBe(0);
		controlled.resolve(1);
		await flushMicrotasks();
		expect(__getResourceGcStateForTest()).toMatchObject({
			inProgress: false,
			deferredDeadline: null,
			pendingDeadline: 1225,
		});
		unregisterB();
		unregisterA();
		expectSchedulerStopped();
	});

	it("E: defers a consumed timer while externally initiated work owns the lock", async () => {
		const clock = controlledScheduler();
		const controlled = controlledReleases();
		__setResourceGcDepsForTest({
			now: () => NOW,
			releaseTab: controlled.releaseTab,
			listTabs: () => [snapshot("a", "a", NOW - 5000)],
		});
		const unregister = registerResourceGcSession({ sessionId: "a", settings: gcSettings(100) });
		await clock.advance(50);
		const external = __runResourceGcTickForTest();
		await flushMicrotasks();
		expect(controlled.releaseTab).toHaveBeenCalledTimes(1);
		await clock.advance(50);
		expect(__getResourceGcStateForTest()).toMatchObject({
			deferredDeadline: 1100,
			timerActive: false,
			inProgress: true,
		});
		expect(vi.getTimerCount()).toBe(0);
		await clock.advance(100);
		controlled.resolve(0);
		await external;
		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 1100,
			deferredDeadline: null,
			inProgress: false,
		});
		await clock.advance(0);
		expect(controlled.releaseTab).toHaveBeenCalledTimes(2);
		expect(__getResourceGcStateForTest()).toMatchObject({
			inProgress: true,
			timerActive: false,
			deferredDeadline: null,
		});
		expect(vi.getTimerCount()).toBe(0);
		controlled.resolve(1);
		await flushMicrotasks();
		expect(__getResourceGcStateForTest()).toMatchObject({
			inProgress: false,
			deferredDeadline: null,
			pendingDeadline: 1300,
		});
		unregister();
		expectSchedulerStopped();
	});

	it("F: preserves a short registration deadline during external work", async () => {
		const clock = controlledScheduler();
		const controlled = controlledReleases();
		__setResourceGcDepsForTest({
			now: () => NOW,
			releaseTab: controlled.releaseTab,
			listTabs: () => [snapshot("long", "long", NOW - 5000)],
		});
		const unregisterLong = registerResourceGcSession({ sessionId: "long", settings: gcSettings(1000) });
		await clock.advance(50);
		const external = __runResourceGcTickForTest();
		await flushMicrotasks();
		expect(controlled.releaseTab).toHaveBeenCalledTimes(1);
		await clock.advance(50);
		const unregisterShort = registerResourceGcSession({ sessionId: "short", settings: gcSettings(100) });
		expect(__getResourceGcStateForTest().pendingDeadline).toBe(1200);
		await clock.advance(100);
		expect(__getResourceGcStateForTest()).toMatchObject({
			deferredDeadline: 1200,
			timerActive: false,
			inProgress: true,
		});
		await clock.advance(100);
		controlled.resolve(0);
		await external;
		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 1200,
			deferredDeadline: null,
			inProgress: false,
		});
		await clock.advance(0);
		expect(controlled.releaseTab).toHaveBeenCalledTimes(2);
		expect(__getResourceGcStateForTest()).toMatchObject({
			inProgress: true,
			timerActive: false,
			deferredDeadline: null,
		});
		expect(vi.getTimerCount()).toBe(0);
		controlled.resolve(1);
		await flushMicrotasks();
		expect(__getResourceGcStateForTest()).toMatchObject({
			inProgress: false,
			deferredDeadline: null,
			pendingDeadline: 1400,
		});
		unregisterShort();
		unregisterLong();
		expectSchedulerStopped();
	});

	it("G: fences stale completion after stop and re-registration", async () => {
		const clock = controlledScheduler();
		const controlled = controlledReleases();
		let ownerId = "old";
		__setResourceGcDepsForTest({
			now: () => NOW,
			releaseTab: controlled.releaseTab,
			listTabs: () => [snapshot(ownerId, ownerId, NOW - 5000)],
		});
		const unregisterOld = registerResourceGcSession({ sessionId: "old", settings: gcSettings(100) });
		await clock.advance(50);
		const oldWork = __runResourceGcTickForTest();
		await flushMicrotasks();
		expect(controlled.releaseTab).toHaveBeenCalledTimes(1);
		const oldGeneration = __getResourceGcStateForTest().generation;
		expect(__getResourceGcStateForTest().activeGeneration).toBe(oldGeneration);
		unregisterOld();
		const newGeneration = __getResourceGcStateForTest().generation;
		expect(newGeneration).toBe(oldGeneration + 1);
		expect(__getResourceGcStateForTest().activeGeneration).toBe(oldGeneration);
		await clock.advance(20);
		ownerId = "new";
		const unregisterNew = registerResourceGcSession({ sessionId: "new", settings: gcSettings(200) });
		expect(__getResourceGcStateForTest()).toMatchObject({
			generation: newGeneration,
			pendingDeadline: 1270,
			pendingOwner: expect.objectContaining({ generation: newGeneration }),
		});
		await clock.advance(200);
		expect(__getResourceGcStateForTest()).toMatchObject({
			deferredDeadline: 1270,
			deferredGeneration: newGeneration,
			timerActive: false,
			inProgress: true,
		});
		expect(vi.getTimerCount()).toBe(0);
		await clock.advance(30);
		controlled.resolve(0);
		await oldWork;
		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 1270,
			pendingOwner: expect.objectContaining({ generation: newGeneration }),
			activeGeneration: null,
			deferredDeadline: null,
		});
		await clock.advance(0);
		expect(controlled.releaseTab).toHaveBeenCalledTimes(2);
		expect(controlled.releaseTab.mock.calls.map(call => call[0])).toEqual(["old", "new"]);
		expect(__getResourceGcStateForTest()).toMatchObject({
			activeGeneration: newGeneration,
			inProgress: true,
			timerActive: false,
			deferredDeadline: null,
		});
		expect(vi.getTimerCount()).toBe(0);
		controlled.resolve(1);
		await flushMicrotasks();
		expect(__getResourceGcStateForTest()).toMatchObject({
			activeGeneration: null,
			inProgress: false,
			deferredDeadline: null,
			pendingDeadline: 1500,
		});
		unregisterNew();
		expectSchedulerStopped();
	});

	it("H: ignores a queued callback from a superseded same-generation timer", async () => {
		const clock = controlledScheduler();
		const releaseTab = vi.fn(async () => true);
		const sweepStarts = vi.fn(() => [snapshot("short", "short", NOW - 5000)]);
		__setResourceGcDepsForTest({ now: () => NOW, releaseTab, listTabs: sweepStarts });
		const unregisterLong = registerResourceGcSession({ sessionId: "long", settings: gcSettings(1000) });
		const staleOwner = __getResourceGcStateForTest().pendingOwner;
		await clock.advance(100);
		const unregisterShort = registerResourceGcSession({ sessionId: "short", settings: gcSettings(100) });
		const replacement = __getResourceGcStateForTest();
		expect(staleOwner).not.toBeNull();
		await __runResourceGcTimerCallbackForTest(staleOwner!, 2000);
		await flushMicrotasks();
		expect(releaseTab).not.toHaveBeenCalled();
		expect(sweepStarts).not.toHaveBeenCalled();
		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 1200,
			pendingOwner: replacement.pendingOwner,
			deferredDeadline: null,
		});
		expect(vi.getTimerCount()).toBe(1);
		unregisterShort();
		unregisterLong();
		expectSchedulerStopped();
	});

	it("keeps scheduler time separate from eligibility time and resets all scheduler state", async () => {
		const clock = controlledScheduler();
		const releaseTab = vi.fn(async () => true);
		__setResourceGcDepsForTest({
			now: () => NOW - 10_000,
			releaseTab,
			listTabs: () => [snapshot("a", "a", NOW - 5000)],
		});
		const unregister = registerResourceGcSession({ sessionId: "a", settings: gcSettings(100) });
		await clock.advance(100);
		expect(releaseTab).not.toHaveBeenCalled();
		unregister();
		__resetResourceGcForTest();
		expect(__getResourceGcStateForTest()).toMatchObject({
			sessionCount: 0,
			timerActive: false,
			pendingDeadline: null,
			deferredDeadline: null,
			activeGeneration: null,
		});
	});
});

describe("resource GC settings precedence", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		resetSettingsForTest();
		testDir = path.join(os.tmpdir(), "test-resource-gc-settings", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".gjc"), { recursive: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("lets project .gjc/settings.json override the user config.yml", async () => {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify({ browser: { gc: { idleMs: 111_111 } } }));
		fs.writeFileSync(
			path.join(projectDir, ".gjc", "settings.json"),
			JSON.stringify({ browser: { gc: { idleMs: 222_222 } } }),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("browser.gc.idleMs")).toBe(222_222);
	});
});
