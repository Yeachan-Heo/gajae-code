import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import type { NotificationServiceFs } from "../src/sdk/bus/notification-service";
import {
	buildNotificationStatusReport,
	checkNotificationHealth,
	formatNotificationRecoveryReport,
	formatNotificationStatusReport,
	recoverNotifications,
	sanitizeDiagnostic,
	sendNotificationTest,
} from "../src/sdk/bus/notification-service";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";

/** In-memory NotificationServiceFs backed by an absolute-path -> content map. */
function mockFs(
	files: Record<string, string>,
	opts: {
		failUnlink?: Set<string>;
		/**
		 * Fires the instant the steal-mutex file is exclusively created, letting a
		 * test simulate a concurrent daemon takeover happening mid-recovery.
		 */
		onAcquireExclusive?: (file: string, store: Map<string, string>) => void;
	} = {},
): { fs: NotificationServiceFs; unlinked: string[]; created: string[]; store: Map<string, string> } {
	const store = new Map(Object.entries(files));
	const unlinked: string[] = [];
	const created: string[] = [];
	const enoent = (): NodeJS.ErrnoException => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	const fs: NotificationServiceFs = {
		async readdir(dir) {
			const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
			const names = new Set<string>();
			let exists = false;
			for (const key of store.keys()) {
				if (!key.startsWith(prefix)) continue;
				exists = true;
				const rest = key.slice(prefix.length);
				if (!rest.includes(path.sep)) names.add(rest);
			}
			if (!exists) throw enoent();
			return [...names];
		},
		async readFile(file) {
			const value = store.get(file);
			if (value === undefined) throw enoent();
			return value;
		},
		async unlink(file) {
			if (opts.failUnlink?.has(file)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			if (!store.has(file)) throw enoent();
			store.delete(file);
			unlinked.push(file);
		},
		async createExclusive(file) {
			if (store.has(file)) return false;
			store.set(file, "");
			created.push(file);
			opts.onAcquireExclusive?.(file, store);
			return true;
		},
	};
	return { fs, unlinked, created, store };
}

function daemonStateJson(over: Record<string, unknown>): string {
	return JSON.stringify({
		pid: 4242,
		ownerId: "owner-a",
		tokenFingerprint: tokenFingerprint(TOKEN),
		chatId: "12345",
		startedAt: 0,
		heartbeatAt: 1_000,
		roots: [],
		version: 1,
		...over,
	});
}

describe("notification-service status", () => {
	test("status report is secret-safe and shows a fingerprint", () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
			"notifications.redact": true,
		});
		const report = buildNotificationStatusReport(settings);
		const text = formatNotificationStatusReport(report);

		expect(text).not.toContain(TOKEN);
		expect(report.telegram.tokenFingerprint).toBe(tokenFingerprint(TOKEN));
		expect(report.telegram.configured).toBe(true);
		expect(text).toContain("redact: true");
		expect(text).toContain(`telegram.fingerprint: ${tokenFingerprint(TOKEN)}`);
	});
});

describe("notification-service health", () => {
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const statePath = daemonPaths(settings.getAgentDir()).state;

	test("dead daemon owner is flagged and recommends recovery", async () => {
		const { fs } = mockFs({ [statePath]: daemonStateJson({ pid: 999 }) });
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: () => false },
		});
		expect(report.daemon.present).toBe(true);
		expect(report.daemon.alive).toBe(false);
		expect(report.overall).toBe("warn");
		expect(report.checks.find(c => c.name === "daemon")?.detail).toContain("recovery");
	});

	test("a live daemon owning a different identity is flagged", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({ pid: 1000, chatId: "99999", heartbeatAt: 1_490 }),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.alive).toBe(true);
		expect(report.daemon.identityMatches).toBe(false);
		expect(report.checks.find(c => c.name === "daemon")?.detail).toContain("different bot token or chat");
	});

	test("healthy daemon with fresh heartbeat and matching identity is ok", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }),
			[path.join("/tmp/gjc-none", "notifications", "session-a.json")]: JSON.stringify({
				sessionId: "session-a",
				pid: 1000,
			}),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.identityMatches).toBe(true);
		expect(report.overall).toBe("ok");
		expect(report.checks.some(check => check.name === "local_endpoint")).toBe(false);
	});
	test("reports a current-root unavailable endpoint hint only for an active matching daemon", async () => {
		const { fs } = mockFs({ [statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }) });
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		const hint = report.checks.find(check => check.name === "local_endpoint");
		expect(report.endpoints.total).toBe(0);
		expect(report.overall).toBe("warn");
		expect(hint).toEqual({
			name: "local_endpoint",
			level: "warn",
			detail:
				"No local notification endpoint for this working directory. In this GJC terminal run /notify on; if it does not report notifications enabled, start a new local GJC session. Do not re-pair Telegram.",
		});
		expect(report.checks.indexOf(hint!)).toBe(report.checks.findIndex(check => check.name === "endpoints") + 1);
	});

	test("suppresses the unavailable endpoint hint for a stopped daemon", async () => {
		const { fs } = mockFs({ [statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490, stoppedAt: 1_495 }) });
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.checks.some(check => check.name === "local_endpoint")).toBe(false);
	});
	test.each([
		["absent", undefined, undefined, true],
		["dead", daemonStateJson({ pid: 999, heartbeatAt: 1_490 }), undefined, true],
		["stale", daemonStateJson({ pid: 1000, heartbeatAt: 0 }), undefined, true],
		["mismatched", daemonStateJson({ pid: 1000, chatId: "other", heartbeatAt: 1_490 }), undefined, true],
		["stopped", daemonStateJson({ pid: 1000, heartbeatAt: 1_490, stoppedAt: 1_495 }), undefined, true],
		["unconfigured", daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }), undefined, false],
		["live endpoint", daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }), { sessionId: "s", pid: 1000 }, true],
		["dead endpoint", daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }), { sessionId: "s", pid: 999 }, true],
		["unknown endpoint", daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }), { sessionId: "s" }, true],
		["unreadable endpoint", daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }), "not-json", true],
	])("suppresses the local endpoint hint for %s state", async (_name, state, endpoint, configured) => {
		const rowSettings = Settings.isolated(
			configured
				? {
						"notifications.enabled": true,
						"notifications.telegram.botToken": TOKEN,
						"notifications.telegram.chatId": "12345",
					}
				: { "notifications.enabled": false },
		);
		const rowStatePath = daemonPaths(rowSettings.getAgentDir()).state;
		const endpointPath = path.join("/tmp/gjc-none", "notifications", "session-a.json");
		const { fs } = mockFs({
			...(state ? { [rowStatePath]: state } : {}),
			...(endpoint ? { [endpointPath]: typeof endpoint === "string" ? endpoint : JSON.stringify(endpoint) } : {}),
		});
		const report = await checkNotificationHealth({
			settings: rowSettings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => (_name === "stale" ? 1_000_000 : 1_500), pidAlive: pid => pid === 1000 },
		});
		expect(report.checks.some(check => check.name === "local_endpoint")).toBe(false);
	});
});

describe("notification-service test delivery", () => {
	test("reports not-configured without touching the network", async () => {
		const settings = Settings.isolated({ "notifications.enabled": false });
		let called = false;
		const fetchImpl = (async (_url: string | URL | Request) => {
			called = true;
			return new Response("{}");
		}) as typeof fetch;
		const result = await sendNotificationTest({ settings, deps: { fetchImpl } });
		expect(result.ok).toBe(false);
		expect(called).toBe(false);
		expect(result.detail).toContain("not configured");
	});

	test("delivers through the configured Telegram adapter", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
		});
		const calls: string[] = [];
		const fetchImpl = (async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const result = await sendNotificationTest({
			settings,
			text: "hi",
			deps: { fetchImpl, apiBase: "https://api.telegram.org" },
		});
		expect(result.ok).toBe(true);
		expect(result.chatId).toBe("12345");
		expect(calls[0]).toContain(`/bot${TOKEN}/sendMessage`);
	});
});

describe("notification-service recovery", () => {
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const paths = daemonPaths(settings.getAgentDir());
	const stateRoot = "/tmp/gjc-recovery-state";
	const epDir = path.join(stateRoot, "notifications");

	test("removes only dead/stale endpoints and never a live owner's lock", async () => {
		const { fs, unlinked } = mockFs({
			[path.join(epDir, "live.json")]: JSON.stringify({ sessionId: "live", pid: 1000, stale: false }),
			[path.join(epDir, "stale.json")]: JSON.stringify({ sessionId: "stale", pid: 1000, stale: true }),
			[path.join(epDir, "dead.json")]: JSON.stringify({ sessionId: "dead", pid: 777, stale: false }),
			[path.join(epDir, "broken.json")]: "not json",
			[paths.state]: daemonStateJson({ pid: 1000 }),
			[paths.lock]: "lock",
		});
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: pid => pid === 1000 },
		});

		const removedSessions = report.endpointsRemoved.map(e => e.sessionId).sort();
		expect(removedSessions).toEqual(["dead", "stale"]);
		expect(report.endpointsKept).toBe(1);
		expect(report.endpointsUnreadable).toBe(1);
		// Live owner is protected: its lock must survive.
		expect(report.daemon.action).toBe("left-active");
		expect(unlinked).not.toContain(paths.lock);
		expect(formatNotificationRecoveryReport(report)).toContain("left-active");
	});

	test("clears the lock of a confirmed-dead owner", async () => {
		const { fs, unlinked } = mockFs({
			[paths.state]: daemonStateJson({ pid: 555 }),
			[paths.lock]: "lock",
		});
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-empty",
			deps: { fs, pidAlive: () => false },
		});
		expect(report.daemon.action).toBe("cleared-dead-owner-lock");
		expect(unlinked).toContain(paths.lock);
	});
});
describe("notification-service endpoint liveness (owner-proof)", () => {
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const stateRoot = "/tmp/gjc-liveness-state";
	const epDir = path.join(stateRoot, "notifications");

	test("health treats a PID-less endpoint as unknown, never dead", async () => {
		const { fs } = mockFs({
			[path.join(epDir, "pidless.json")]: JSON.stringify({ url: "ws://x", token: "t" }),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot,
			deps: { fs, now: () => 1_500, pidAlive: () => false },
		});
		expect(report.endpoints.dead).toBe(0);
		expect(report.endpoints.unknown).toBe(1);
		expect(report.checks.find(c => c.name === "endpoints")?.level).toBe("ok");
	});

	test("recovery keeps a PID-less endpoint (no positive proof of death)", async () => {
		const { fs, unlinked } = mockFs({
			[path.join(epDir, "pidless.json")]: JSON.stringify({ url: "ws://x", token: "t" }),
		});
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: () => false },
		});
		expect(report.endpointsRemoved).toEqual([]);
		expect(report.endpointsKept).toBe(1);
		expect(unlinked).toEqual([]);
	});
});

describe("notification-service recovery lock TOCTOU (owner-bound)", () => {
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const paths = daemonPaths(settings.getAgentDir());

	test("leaves the lock when the steal-mutex is already held (contended)", async () => {
		const { fs, unlinked } = mockFs({
			[paths.state]: daemonStateJson({ pid: 555, ownerId: "owner-a" }),
			[paths.lock]: "lock",
			[paths.steal]: "held-by-another",
		});
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-contended",
			deps: { fs, pidAlive: () => false },
		});
		expect(report.daemon.action).toBe("left-contended");
		expect(unlinked).not.toContain(paths.lock);
	});

	test("never clobbers a new owner that took over during recovery (superseded)", async () => {
		// The dead owner A is observed first; while recovery holds the steal-mutex
		// a fresh live owner B has already rewritten the ownership record. The
		// owner-bound re-check must abort rather than unlink B's live lock.
		const { fs, unlinked } = mockFs(
			{
				[paths.state]: daemonStateJson({ pid: 555, ownerId: "owner-a" }),
				[paths.lock]: "lock",
			},
			{
				onAcquireExclusive: (file, store) => {
					if (file === paths.steal) {
						store.set(paths.state, daemonStateJson({ pid: 1000, ownerId: "owner-b" }));
					}
				},
			},
		);
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-superseded",
			deps: { fs, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.action).toBe("owner-superseded");
		expect(unlinked).not.toContain(paths.lock);
	});
});

describe("notification-service diagnostic sanitization (secret-safe)", () => {
	test("sanitizeDiagnostic redacts the exact token and token-shaped substrings", () => {
		expect(sanitizeDiagnostic(`fetch failed: https://api.telegram.org/bot${TOKEN}/getMe`, TOKEN)).not.toContain(
			TOKEN,
		);
		// Redacts a token-shaped substring even without the exact token supplied.
		expect(sanitizeDiagnostic("leaked 998877665:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toContain("<redacted>");
	});

	test("test delivery never leaks the token in an error detail", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
		});
		const fetchImpl = (async (_url: string | URL | Request) => {
			throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
		}) as unknown as typeof fetch;
		const result = await sendNotificationTest({ settings, deps: { fetchImpl } });
		expect(result.ok).toBe(false);
		expect(result.detail).not.toContain(TOKEN);
		expect(result.detail).toContain("<redacted>");
	});

	test("health probe never leaks the token in a reachability error", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
		});
		const fetchImpl = (async (_url: string | URL | Request) => {
			throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`);
		}) as unknown as typeof fetch;
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-probe",
			probe: true,
			deps: { fs: mockFs({}).fs, now: () => 1, pidAlive: () => false, fetchImpl },
		});
		expect(report.reachability.detail).not.toContain(TOKEN);
		expect(report.reachability.detail).toContain("<redacted>");
	});
});
