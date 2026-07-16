import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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
	__setResourceGcDepsForTest,
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
