import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { checkNotificationHealth } from "../src/sdk/bus/notification-service";
import { daemonPaths } from "../src/sdk/bus/telegram-daemon";
import { DAEMON_GENERATION, SERVING_EPOCH } from "../src/sdk/bus/telegram-daemon-contract";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";

function mockFs(files: Record<string, string>) {
	const store = new Map(Object.entries(files));
	return {
		readdir: async (dir: string) => {
			const prefix = dir.endsWith("/") ? dir : `${dir}/`;
			const names = new Set<string>();
			for (const key of store.keys()) {
				if (key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);
					const slash = rest.indexOf("/");
					names.add(slash >= 0 ? rest.slice(0, slash) : rest);
				}
			}
			if (names.size === 0) {
				const err = Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
				throw err;
			}
			return [...names];
		},
		readFile: async (file: string, _encoding: string) => {
			const val = store.get(file);
			if (val === undefined) {
				const err = Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
				throw err;
			}
			return val;
		},
	} as any;
}

function daemonStateJson(pid: number, opts: Record<string, unknown> = {}) {
	return JSON.stringify({
		version: 1,
		ownerId: "test-owner",
		pid,
		acquisitionId: "test-acq",
		heartbeatAt: 1_490,
		generation: DAEMON_GENERATION,
		servingEpoch: SERVING_EPOCH,
		ownershipPhase: "ready",
		incarnation: "linux:1:1",
		tokenFingerprint: "abc",
		chatId: "123",
		...opts,
	});
}

describe("notify health stale-lock diagnostic (#5227 secondary)", () => {
	test("does not advise recovery when dead owner has no lock", async () => {
		const agentDir = "/tmp/gjc-health-test";
		const stateRoot = "/tmp/gjc-health-state";
		const paths = daemonPaths(agentDir);
		const deadPid = 999999;
		const stateJson = daemonStateJson(deadPid);
		const files: Record<string, string> = {
			[paths.state]: stateJson,
		};
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "123",
		} as any);
		(settings as any).getAgentDir = () => agentDir;
		const report = await checkNotificationHealth({
			settings,
			stateRoot,
			deps: { fs: mockFs(files), now: () => 1_500, pidAlive: () => false },
		});
		const daemonCheck = report.checks.find(c => c.name === "daemon");
		expect(daemonCheck).toBeDefined();
		expect(daemonCheck!.detail).not.toContain("run recovery to clear the stale lock");
		expect(daemonCheck!.detail).toContain("no lock present");
	});

	test("advises recovery when dead owner has a lock", async () => {
		const agentDir = "/tmp/gjc-health-test2";
		const stateRoot = "/tmp/gjc-health-state2";
		const paths = daemonPaths(agentDir);
		const deadPid = 999999;
		const stateJson = daemonStateJson(deadPid);
		const lockFile = `${paths.lock}/owner.json`;
		const files: Record<string, string> = {
			[paths.state]: stateJson,
			[lockFile]: JSON.stringify({ ownerId: "test-owner", pid: deadPid }),
		};
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "123",
		} as any);
		(settings as any).getAgentDir = () => agentDir;
		const report = await checkNotificationHealth({
			settings,
			stateRoot,
			deps: { fs: mockFs(files), now: () => 1_500, pidAlive: () => false },
		});
		const daemonCheck = report.checks.find(c => c.name === "daemon");
		expect(daemonCheck).toBeDefined();
		expect(daemonCheck!.detail).toContain("run recovery to clear the stale lock");
	});
});
