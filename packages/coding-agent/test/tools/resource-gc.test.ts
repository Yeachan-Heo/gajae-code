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
	__sampleLinuxCgroupHierarchyForTest,
	__selectMemoryPressureDomainForTest,
	__setResourceGcDepsForTest,
	__setResourceGcSchedulerNowForTest,
	type ResourceGcDeps,
	registerResourceGcSession,
	requestMemoryPressureGc,
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
		memorySnapshot: async () => ({
			hardCapBytes: 1024 * MB,
			totalUsageBytes: 1,
			parentBytes: 1,
			source: "host",
		}),
		runGc: vi.fn(),
		logWarn: vi.fn(),
		listTabs: () => [],
		releaseTab: vi.fn(async () => true),
		cleanupScreenshots: vi.fn(async () => ({ scanned: 0, removed: 0 })),
		screenshotArmed: () => false,
		...over,
		monotonicNow: over.monotonicNow ?? over.now ?? (() => NOW),
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

describe("Linux cgroup memory sampling", () => {
	function mountLine(id: number, root: string, mountPoint: string, fsType: "cgroup" | "cgroup2" = "cgroup2"): string {
		const superOptions = fsType === "cgroup" ? "rw,memory" : "rw";
		return `${id} 1 0:${id} ${root} ${mountPoint} rw - ${fsType} cgroup ${superOptions}`;
	}

	function writeCounters(directory: string, limit: string, usage: string): void {
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "memory.max"), limit);
		fs.writeFileSync(path.join(directory, "memory.current"), usage);
	}

	it("fails over from an unreadable containing mount to a later compatible mount", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cgroup-failover-"));
		try {
			const first = path.join(root, "first");
			const second = path.join(root, "second");
			fs.mkdirSync(first);
			writeCounters(path.join(second, "app"), "1000", "700");
			const mountInfo = [mountLine(31, "/", first), mountLine(32, "/", second)].join("\n");

			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountInfo, "/app", "cgroup2", 4000, 100),
			).resolves.toMatchObject({
				hardCapBytes: 1000,
				totalUsageBytes: 700,
				parentBytes: 100,
				source: "linux_cgroup_v2",
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("compares pressure across every compatible containing mount", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cgroup-multi-mount-"));
		try {
			const narrow = path.join(root, "narrow");
			const broad = path.join(root, "broad");
			writeCounters(narrow, "1000", "100");
			writeCounters(path.join(broad, "app"), "1000", "100");
			writeCounters(broad, "2000", "1900");
			const mountInfo = [mountLine(38, "/app", narrow), mountLine(39, "/", broad)].join("\n");

			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountInfo, "/app", "cgroup2", 5000, 50),
			).resolves.toMatchObject({
				hardCapBytes: 2000,
				totalUsageBytes: 1900,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves distinct ancestor chains that resolve to the same leaf path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cgroup-shared-leaf-"));
		try {
			const broad = path.join(root, "shared");
			const leaf = path.join(broad, "parent", "child");
			writeCounters(leaf, "1000", "100");
			writeCounters(broad, "2000", "1900");
			const mountInfo = [mountLine(42, "/parent/child", leaf), mountLine(43, "/", broad)].join("\n");

			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountInfo, "/parent/child", "cgroup2", 5000, 50),
			).resolves.toMatchObject({
				hardCapBytes: 2000,
				totalUsageBytes: 1900,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("uses the namespace-relative fallback after containment candidates are exhausted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cgroup-namespace-"));
		try {
			const mountPoint = path.join(root, "memory");
			writeCounters(path.join(mountPoint, "app"), "2000", "600");
			const mountInfo = mountLine(41, "/docker/container-id", mountPoint);

			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountInfo, "/app", "cgroup2", 5000, 100),
			).resolves.toMatchObject({
				hardCapBytes: 2000,
				totalUsageBytes: 600,
				parentBytes: 100,
				source: "linux_cgroup_v2",
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("samples the mount root and selects the ancestor nearest to pressure", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cgroup-ancestor-"));
		try {
			const mountPoint = path.join(root, "memory");
			const child = path.join(mountPoint, "parent", "child");
			writeCounters(child, "1000", "100");
			writeCounters(path.join(mountPoint, "parent"), "2000", "1900");
			writeCounters(mountPoint, "3000", "600");
			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountLine(45, "/", mountPoint), "/parent/child", "cgroup2", 5000, 50),
			).resolves.toMatchObject({
				hardCapBytes: 2000,
				totalUsageBytes: 1900,
				parentBytes: 50,
				source: "linux_cgroup_v2",
			});

			writeCounters(child, "max", "100");
			writeCounters(path.join(mountPoint, "parent"), "max", "200");
			writeCounters(mountPoint, "1500", "1200");
			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountLine(46, "/", mountPoint), "/parent/child", "cgroup2", 5000, 50),
			).resolves.toMatchObject({
				hardCapBytes: 1500,
				totalUsageBytes: 1200,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("selects ancestor pressure against the configured policy cap", () => {
		expect(
			__selectMemoryPressureDomainForTest(
				{
					hardCapBytes: 1000,
					totalUsageBytes: 600,
					parentBytes: 50,
					source: "linux_cgroup_v2",
					domains: [
						{ hardCapBytes: 1000, totalUsageBytes: 600, source: "linux_cgroup_v2" },
						{ hardCapBytes: 8000, totalUsageBytes: 4000, source: "linux_cgroup_v2" },
					],
				},
				2000,
			),
		).toMatchObject({
			hardCapBytes: 8000,
			totalUsageBytes: 4000,
		});
	});

	it("ignores zero and malformed counters while preserving valid unlimited usage", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cgroup-counters-"));
		try {
			const invalidMount = path.join(root, "invalid");
			writeCounters(path.join(invalidMount, "app"), "0", "malformed");
			writeCounters(invalidMount, "not-a-number", "0");
			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountLine(51, "/", invalidMount), "/app", "cgroup2", 5000, 100),
			).resolves.toBeNull();

			const unlimitedMount = path.join(root, "unlimited");
			writeCounters(path.join(unlimitedMount, "app"), "max", "900");
			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountLine(52, "/", unlimitedMount), "/app", "cgroup2", 5000, 100),
			).resolves.toMatchObject({
				hardCapBytes: 5000,
				totalUsageBytes: 900,
				parentBytes: 100,
				source: "linux_cgroup_v2",
			});
			const zeroMount = path.join(root, "zero");
			writeCounters(path.join(zeroMount, "app"), "0", "0");
			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountLine(53, "/", zeroMount), "/app", "cgroup2", 5000, 100),
			).resolves.toBeNull();
			const clampedMount = path.join(root, "clamped");
			writeCounters(path.join(clampedMount, "app"), "9000", "4500");
			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountLine(54, "/", clampedMount), "/app", "cgroup2", 5000, 100),
			).resolves.toMatchObject({
				hardCapBytes: 5000,
				totalUsageBytes: 4500,
			});

			const v1Mount = path.join(root, "v1");
			const v1Directory = path.join(v1Mount, "app");
			fs.mkdirSync(v1Directory, { recursive: true });
			fs.writeFileSync(path.join(v1Directory, "memory.limit_in_bytes"), "9223372036854771712");
			fs.writeFileSync(path.join(v1Directory, "memory.usage_in_bytes"), "800");
			await expect(
				__sampleLinuxCgroupHierarchyForTest(mountLine(55, "/", v1Mount, "cgroup"), "/app", "cgroup", 5000, 100),
			).resolves.toMatchObject({
				hardCapBytes: 5000,
				totalUsageBytes: 800,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
describe("resource GC controller", () => {
	afterEach(() => {
		__resetResourceGcForTest();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("requests memory-pressure GC without forcing a synchronous collection", () => {
		const gc = vi.spyOn(Bun, "gc").mockImplementation(() => undefined);

		requestMemoryPressureGc();

		expect(gc).toHaveBeenCalledWith(false);
	});

	it("applies enabled memory policy to GC and sustained restart advisory telemetry", async () => {
		const settings = Settings.isolated({
			"memoryGuard.enabled": true,
			"memoryGuard.policyLimitMb": 100,
			"memoryGuard.gcThresholdPercent": 70,
			"memoryGuard.restartThresholdPercent": 85,
			"memoryGuard.restartThresholdWindowMs": 90_000,
			"memoryGuard.cooldownMs": 600_000,
			"browser.gc.enabled": false,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });

		let now = NOW;
		let rss = 75 * MB;
		const runGc = vi.fn();
		const logWarn = vi.fn();
		const deps = baseDeps({
			now: () => now,
			rssBytes: () => rss,
			memorySnapshot: async () => ({
				hardCapBytes: 200 * MB,
				totalUsageBytes: rss,
				parentBytes: rss,
				source: "host",
			}),
			runGc,
			logWarn,
		});

		await sweepOnce(deps);
		await sweepOnce(deps);
		expect(runGc).toHaveBeenCalledTimes(1);

		rss = 60 * MB;
		now += 30_000;
		await sweepOnce(deps);
		rss = 90 * MB;
		now += 30_000;
		await sweepOnce(deps);
		now += 90_000;
		await sweepOnce(deps);

		expect(runGc).toHaveBeenCalledTimes(2);
		expect(logWarn).toHaveBeenCalledWith(
			"Memory guard: restart threshold sustained",
			expect.objectContaining({ sessionId: "s1", effectiveLimitBytes: 100 * MB }),
		);
		settings.set("memoryGuard.enabled", false);
		settings.set("memoryGuard.enabled", true);
		await sweepOnce(deps);
		expect(runGc).toHaveBeenCalledTimes(3);
		now += 90_000;
		await sweepOnce(deps);
		expect(logWarn.mock.calls.filter(call => call[0].includes("restart threshold sustained"))).toHaveLength(2);
	});

	for (const transition of ["disable", "disable-reenable", "unregister", "unregister-reregister"] as const) {
		it(`discards an in-flight memory sample after ${transition} and preserves fresh GC eligibility`, async () => {
			const settings = Settings.isolated({
				"memoryGuard.enabled": true,
				"memoryGuard.checkIntervalMs": 30_000,
				"memoryGuard.policyLimitMb": 100,
				"browser.gc.enabled": false,
				"computer.screenshotGc.enabled": false,
			});
			const snapshot = {
				hardCapBytes: 200 * MB,
				totalUsageBytes: 90 * MB,
				parentBytes: 90 * MB,
				source: "host" as const,
			};
			const pendingSample = Promise.withResolvers<typeof snapshot>();
			let now = NOW;
			let samples = 0;
			const runGc = vi.fn();
			const logWarn = vi.fn();
			const deps = baseDeps({
				now: () => now,
				memorySnapshot: () => (++samples === 1 ? pendingSample.promise : Promise.resolve(snapshot)),
				runGc,
				logWarn,
			});
			const registration = { sessionId: "changing-session", settings };
			let unregister = registerResourceGcSession(registration);
			const staleSweep = sweepOnce(deps);
			try {
				expect(samples).toBe(1);
				if (transition.startsWith("disable")) {
					settings.set("memoryGuard.enabled", false);
					if (transition === "disable-reenable") settings.set("memoryGuard.enabled", true);
				} else {
					unregister();
					if (transition === "unregister-reregister") unregister = registerResourceGcSession(registration);
				}
				pendingSample.resolve(snapshot);
				await staleSweep;
				const staleGcCalls = runGc.mock.calls.length;
				const staleWarnings = logWarn.mock.calls.length;
				runGc.mockClear();
				logWarn.mockClear();

				if (transition === "disable") settings.set("memoryGuard.enabled", true);
				if (transition === "unregister") unregister = registerResourceGcSession(registration);
				// A stale sample must neither latch GC nor start the next lifecycle's restart window.
				now += 120_000;
				await sweepOnce(deps);
				expect(samples).toBe(2);
				expect(runGc).toHaveBeenCalledTimes(1);
				expect(logWarn.mock.calls.map(call => call[0])).toEqual(["Memory guard: GC threshold reached"]);
				now += 90_000;
				await sweepOnce(deps);
				expect(runGc).toHaveBeenCalledTimes(1);
				expect(logWarn.mock.calls.map(call => call[0])).toEqual([
					"Memory guard: GC threshold reached",
					"Memory guard: restart threshold sustained",
				]);
				expect(staleGcCalls).toBe(0);
				expect(staleWarnings).toBe(0);
			} finally {
				pendingSample.resolve(snapshot);
				await staleSweep;
				unregister();
			}
		});
	}

	it("does not fence an in-flight sample for a redundant enabled write", async () => {
		const settings = Settings.isolated({
			"memoryGuard.enabled": true,
			"memoryGuard.checkIntervalMs": 30_000,
			"memoryGuard.policyLimitMb": 100,
			"browser.gc.enabled": false,
			"computer.screenshotGc.enabled": false,
		});
		const snapshot = {
			hardCapBytes: 200 * MB,
			totalUsageBytes: 90 * MB,
			parentBytes: 90 * MB,
			source: "host" as const,
		};
		const pendingSample = Promise.withResolvers<typeof snapshot>();
		let samples = 0;
		const runGc = vi.fn();
		const logWarn = vi.fn();
		const deps = baseDeps({
			memorySnapshot: () => (++samples === 1 ? pendingSample.promise : Promise.resolve(snapshot)),
			runGc,
			logWarn,
		});
		const unregister = registerResourceGcSession({ sessionId: "redundant-enabled", settings });
		const pending = sweepOnce(deps);
		try {
			settings.set("memoryGuard.enabled", true);
			pendingSample.resolve(snapshot);
			await pending;
			expect(runGc).toHaveBeenCalledTimes(1);
			expect(logWarn.mock.calls.map(call => call[0])).toEqual(["Memory guard: GC threshold reached"]);

			await sweepOnce(deps);
			expect(samples).toBe(1);
		} finally {
			pendingSample.resolve(snapshot);
			await pending;
			unregister();
		}
	});

	it("keeps other registered sessions eligible when one guard is disabled during sampling", async () => {
		const settings = () =>
			Settings.isolated({
				"memoryGuard.enabled": true,
				"memoryGuard.policyLimitMb": 100,
				"browser.gc.enabled": false,
				"computer.screenshotGc.enabled": false,
			});
		const disabled = settings();
		const live = settings();
		const snapshot = {
			hardCapBytes: 200 * MB,
			totalUsageBytes: 75 * MB,
			parentBytes: 75 * MB,
			source: "host" as const,
		};
		const pendingSample = Promise.withResolvers<typeof snapshot>();
		const runGc = vi.fn();
		const logWarn = vi.fn();
		const unregisterDisabled = registerResourceGcSession({ sessionId: "disabled", settings: disabled });
		const unregisterLive = registerResourceGcSession({ sessionId: "live", settings: live });
		const pending = sweepOnce(baseDeps({ memorySnapshot: () => pendingSample.promise, runGc, logWarn }));
		try {
			disabled.set("memoryGuard.enabled", false);
			pendingSample.resolve(snapshot);
			await pending;
			expect(runGc).toHaveBeenCalledTimes(1);
			expect(logWarn.mock.calls).toHaveLength(1);
			expect(logWarn.mock.calls[0]?.[1]?.sessionId).toBe("live");
		} finally {
			pendingSample.resolve(snapshot);
			await pending;
			unregisterDisabled();
			unregisterLive();
		}
	});

	it("does not restore a cleared latch when the guard resets during the GC request", async () => {
		const settings = Settings.isolated({
			"memoryGuard.enabled": true,
			"memoryGuard.policyLimitMb": 100,
			"browser.gc.enabled": false,
			"computer.screenshotGc.enabled": false,
		});
		const runGc = vi.fn(() => {
			settings.set("memoryGuard.enabled", false);
			settings.set("memoryGuard.enabled", true);
		});
		const logWarn = vi.fn();
		const deps = baseDeps({
			memorySnapshot: async () => ({
				hardCapBytes: 200 * MB,
				totalUsageBytes: 75 * MB,
				parentBytes: 75 * MB,
				source: "host",
			}),
			runGc,
			logWarn,
		});
		const unregister = registerResourceGcSession({ sessionId: "reset-during-gc", settings });
		try {
			await sweepOnce(deps);
			expect(runGc).toHaveBeenCalledTimes(1);
			expect(logWarn).not.toHaveBeenCalled();
			runGc.mockImplementation(() => undefined);
			await sweepOnce(deps);
			expect(runGc).toHaveBeenCalledTimes(2);
			expect(logWarn.mock.calls.map(call => call[0])).toEqual(["Memory guard: GC threshold reached"]);
		} finally {
			unregister();
		}
	});

	it("does not sample or mutate guard state before the configured check interval", async () => {
		const settings = Settings.isolated({
			"memoryGuard.enabled": true,
			"memoryGuard.checkIntervalMs": 5_000,
			"memoryGuard.policyLimitMb": 100,
			"memoryGuard.gcThresholdPercent": 70,
			"browser.gc.enabled": false,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "interval-guard", settings });

		let monotonicNow = 0;
		let usageBytes = 90 * MB;
		const memorySnapshot = vi.fn(async () => ({
			hardCapBytes: 100 * MB,
			totalUsageBytes: usageBytes,
			parentBytes: 10 * MB,
			source: "linux_cgroup_v2" as const,
		}));
		const runGc = vi.fn();
		const deps = baseDeps({
			monotonicNow: () => monotonicNow,
			memorySnapshot,
			runGc,
		});

		await sweepOnce(deps);
		usageBytes = 10 * MB;
		monotonicNow = 1_000;
		await sweepOnce(deps);

		expect(memorySnapshot).toHaveBeenCalledTimes(1);
		expect(runGc).toHaveBeenCalledTimes(1);

		monotonicNow = 5_000;
		await sweepOnce(deps);
		expect(memorySnapshot).toHaveBeenCalledTimes(2);
	});

	it("uses monotonic time for sustained restart windows when wall time moves backward", async () => {
		const settings = Settings.isolated({
			"memoryGuard.enabled": true,
			"memoryGuard.checkIntervalMs": 1_000,
			"memoryGuard.policyLimitMb": 100,
			"memoryGuard.gcThresholdPercent": 70,
			"memoryGuard.restartThresholdPercent": 85,
			"memoryGuard.restartThresholdWindowMs": 5_000,
			"memoryGuard.cooldownMs": 60_000,
			"browser.gc.enabled": false,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "monotonic-guard", settings });

		let wallNow = 100_000;
		let monotonicNow = 0;
		const logWarn = vi.fn();
		const deps = baseDeps({
			now: () => wallNow,
			monotonicNow: () => monotonicNow,
			logWarn,
			memorySnapshot: async () => ({
				hardCapBytes: 100 * MB,
				totalUsageBytes: 90 * MB,
				parentBytes: 10 * MB,
				source: "linux_cgroup_v2",
			}),
		});

		await sweepOnce(deps);
		wallNow = -100_000;
		monotonicNow = 5_000;
		await sweepOnce(deps);

		expect(logWarn).toHaveBeenCalledWith(
			"Memory guard: restart threshold sustained",
			expect.objectContaining({ sessionId: "monotonic-guard" }),
		);
	});

	it("keeps positive fractional sweep intervals schedulable", () => {
		const unregister = registerResourceGcSession({
			sessionId: "fractional",
			settings: gcSettings(500.5),
		});
		expect(__getResourceGcStateForTest().timerActive).toBe(true);
		unregister();
	});

	it("uses aggregate domain usage and runs process-wide GC once for concurrent sessions", async () => {
		const settings = Settings.isolated({
			"memoryGuard.enabled": true,
			"memoryGuard.policyLimitMb": 100,
			"memoryGuard.gcThresholdPercent": 70,
			"browser.gc.enabled": false,
			"computer.screenshotGc.enabled": false,
		});
		registerResourceGcSession({ sessionId: "s1", settings });
		registerResourceGcSession({ sessionId: "s2", settings });
		const runGc = vi.fn();
		await sweepOnce(
			baseDeps({
				runGc,
				memorySnapshot: async () => ({
					hardCapBytes: 100 * MB,
					totalUsageBytes: 90 * MB,
					parentBytes: 10 * MB,
					source: "linux_cgroup_v2",
				}),
			}),
		);
		expect(runGc).toHaveBeenCalledTimes(1);
	});
	it("schedules an enabled guard at its configured check interval", async () => {
		const clock = controlledScheduler();
		const runGc = vi.fn();
		__setResourceGcDepsForTest({
			runGc,
			memorySnapshot: async () => ({
				hardCapBytes: 100 * MB,
				totalUsageBytes: 90 * MB,
				parentBytes: 10 * MB,
				source: "linux_cgroup_v2",
			}),
		});
		registerResourceGcSession({
			sessionId: "fast-memory-check",
			settings: Settings.isolated({
				"resourceGc.sweepIntervalMs": 30_000,
				"memoryGuard.enabled": true,
				"memoryGuard.checkIntervalMs": 5_000,
				"memoryGuard.policyLimitMb": 100,
				"browser.gc.enabled": false,
				"computer.screenshotGc.enabled": false,
			}),
		});
		await clock.advance(4_999);
		expect(runGc).not.toHaveBeenCalled();
		await clock.advance(1);
		expect(runGc).toHaveBeenCalledTimes(1);
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

		const enteredRelease = Promise.withResolvers<void>();
		let resolveRelease: (() => void) | undefined;
		const releaseTab = vi.fn(
			() =>
				new Promise<boolean>(resolve => {
					resolveRelease = () => resolve(true);
					enteredRelease.resolve();
				}),
		);
		__setResourceGcDepsForTest({
			releaseTab,
			listTabs: () => [snapshot("a", "s1", NOW - 5000)],
		});

		const first = __runResourceGcTickForTest(); // enters sweep, blocks on releaseTab
		await enteredRelease.promise;
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
		expect(__getResourceGcStateForTest().pendingDeadline).toBe(1120);
		unregisterSlow();
		unregisterEqual();
		unregisterFast();
		expectSchedulerStopped();
	});

	it("reschedules an active session after live memory-guard cadence changes", () => {
		controlledScheduler();
		const settings = gcSettings(30_000);
		const unregister = registerResourceGcSession({ sessionId: "live-policy", settings });
		expect(__getResourceGcStateForTest().pendingDeadline).toBe(31_000);

		settings.set("memoryGuard.enabled", true);
		settings.set("memoryGuard.checkIntervalMs", 5_000);

		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 6_000,
			timerActive: true,
		});
		expect(vi.getTimerCount()).toBe(1);
		unregister();
		expectSchedulerStopped();
	});

	it("preserves an earlier shared deadline when another session changes cadence", async () => {
		const clock = controlledScheduler();
		const fast = gcSettings(100);
		const changing = gcSettings(1_000);
		const unregisterFast = registerResourceGcSession({ sessionId: "unchanged-fast", settings: fast });
		const originalOwner = __getResourceGcStateForTest().pendingOwner;
		await clock.advance(90);
		const unregisterChanging = registerResourceGcSession({ sessionId: "changing-slow", settings: changing });

		changing.set("resourceGc.sweepIntervalMs", 500);

		expect(__getResourceGcStateForTest()).toMatchObject({
			pendingDeadline: 1_100,
			pendingOwner: originalOwner,
		});
		unregisterChanging();
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
		expect(__getResourceGcStateForTest().pendingDeadline).toBe(2000);
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
