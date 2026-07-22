import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { getNotificationConfig, tokenFingerprint } from "../src/sdk/bus/config";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import { ensureConfiguredProviderDaemons } from "../src/sdk/bus/index";
import type {
	NotificationEndpointFileIdentity,
	NotificationExactUnlinkResult,
	NotificationServiceFs,
} from "../src/sdk/bus/notification-service";
import {
	buildNotificationStatusReport,
	checkNotificationHealth,
	formatNotificationHealthReport,
	formatNotificationRecoveryReport,
	formatNotificationStatusReport,
	recoverNotifications,
	sanitizeDiagnostic,
	sendNotificationTest,
} from "../src/sdk/bus/notification-service";
import { DAEMON_GENERATION } from "../src/sdk/bus/telegram-daemon-contract";

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
		/** Fires immediately before identity-bound endpoint deletion. */
		onExactUnlink?: (file: string, store: Map<string, string>) => void;
		exactUnlinkResult?: (file: string) => NotificationExactUnlinkResult | undefined;
		rejectEndpointFiles?: Set<string>;
	} = {},
): { fs: NotificationServiceFs; unlinked: string[]; created: string[]; store: Map<string, string> } {
	const store = new Map(Object.entries(files));
	const revisions = new Map<string, number>([...store.keys()].map(file => [file, 1]));
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
		async readEndpointFile(file) {
			if (opts.rejectEndpointFiles?.has(file)) throw new Error("Endpoint changed while it was read");
			const value = store.get(file);
			if (value === undefined) throw enoent();
			const bytes = Buffer.from(value);
			const revision = revisions.get(file) ?? 0;
			return {
				bytes,
				identity: {
					dev: 1n,
					ino: BigInt(revision),
					size: BigInt(bytes.length),
					mtimeNs: BigInt(revision),
					sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
				},
			};
		},
		async exactUnlink(file, identity: NotificationEndpointFileIdentity) {
			opts.onExactUnlink?.(file, store);
			const configured = opts.exactUnlinkResult?.(file);
			if (configured) return configured;
			if (opts.failUnlink?.has(file)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			const value = store.get(file);
			if (value === undefined) throw enoent();
			const bytes = Buffer.from(value);
			const revision = revisions.get(file) ?? 0;
			const matches =
				identity.dev === 1n &&
				identity.ino === BigInt(revision) &&
				identity.size === BigInt(bytes.length) &&
				identity.mtimeNs === BigInt(revision) &&
				identity.sha256 === crypto.createHash("sha256").update(bytes).digest("hex");
			if (!matches) return { ok: false, code: "identity_mismatch" };
			store.delete(file);
			unlinked.push(file);
			return { ok: true };
		},
		async unlink(file) {
			if (opts.failUnlink?.has(file)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			if (!store.has(file)) throw enoent();
			store.delete(file);
			unlinked.push(file);
		},
		async writeFile(file, data, writeOpts) {
			const exclusive =
				typeof writeOpts === "object" && writeOpts !== null && "flag" in writeOpts && writeOpts.flag === "wx";
			if (exclusive && store.has(file)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
			store.set(file, data.toString());
			revisions.set(file, (revisions.get(file) ?? 0) + 1);
			if (exclusive) {
				created.push(file);
				opts.onAcquireExclusive?.(file, store);
			}
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

describe("configured chat daemon readiness", () => {
	test("awaits every configured provider before startup can publish identity", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "channel",
			"notifications.slack.botToken": "slack-bot-token",
			"notifications.slack.appToken": "slack-app-token",
			"notifications.slack.workspaceId": "workspace",
			"notifications.slack.channelId": "channel",
		});
		const calls: string[] = [];

		await ensureConfiguredProviderDaemons(settings, getNotificationConfig(settings), async provider => {
			calls.push(provider);
		});

		expect(calls).toEqual(["discord", "slack"]);
	});

	test("propagates configured provider readiness failures instead of reporting startup success", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "channel",
			"notifications.slack.botToken": "slack-bot-token",
			"notifications.slack.appToken": "slack-app-token",
			"notifications.slack.workspaceId": "workspace",
			"notifications.slack.channelId": "channel",
		});
		const calls: string[] = [];

		await expect(
			ensureConfiguredProviderDaemons(settings, getNotificationConfig(settings), async provider => {
				calls.push(provider);
				if (provider === "discord") throw new Error("Discord gateway authentication failed");
			}),
		).rejects.toThrow("Discord gateway authentication failed");
		expect(calls).toEqual(["discord"]);
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
			[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490, generation: DAEMON_GENERATION }),
			[path.join("/tmp/gjc-none", "sdk", "session-a.json")]: JSON.stringify({
				sessionId: "session-a",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 1000,
			}),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.identityMatches).toBe(true);
		expect(report.daemon.heartbeatAt).toBe(1_490);
		expect(report.daemon.heartbeatAgeMs).toBe(10);
		expect(report.daemon.generation).toBe(DAEMON_GENERATION);
		expect(report.daemon.currentGeneration).toBe(DAEMON_GENERATION);
		expect(report.daemon.generationRelation).toBe("current");
		expect(report.overall).toBe("ok");
		expect(report.checks.some(check => check.name === "local_endpoint")).toBe(false);
		expect(formatNotificationHealthReport(report)).toBe(
			[
				"Notification health: OK",
				"  [ok] config: enabled with at least one configured adapter",
				"  [ok] daemon: daemon pid 1000 alive with a fresh heartbeat",
				"  [ok] endpoints: 1 live, 0 unverified endpoint file(s)",
			].join("\n"),
		);
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
	test("ignores shared lifecycle, ready, and broker records when discovering endpoints", async () => {
		const stateRoot = "/tmp/gjc-shared-sdk-state";
		const { fs } = mockFs({
			[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }),
			[path.join(stateRoot, "sdk", "session-a.lifecycle.json")]: JSON.stringify({
				pid: 1000,
				effectMarker: "request-a",
				incarnation: "incarnation-a",
			}),
			[path.join(stateRoot, "sdk", "session-b.lifecycle.ready.json")]: JSON.stringify({
				pid: 999,
				effectMarker: "request-b",
				incarnation: "incarnation-b",
			}),
			[path.join(stateRoot, "sdk", "partial.lifecycle.ready.json")]: "{",
			[path.join(stateRoot, "sdk", "partial.lifecycle.failure.request.json")]: "{",
			[path.join(stateRoot, "sdk", "broker.json")]: JSON.stringify({
				url: "ws://127.0.0.1:4000",
				token: "broker-token",
				pid: 999,
			}),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot,
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});

		expect(report.endpoints).toEqual({ total: 0, live: 0, dead: 0, unknown: 0, unreadable: 0 });
		expect(report.checks.some(check => check.name === "local_endpoint")).toBe(true);
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
		[
			"live endpoint",
			daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }),
			{ sessionId: "s", url: "ws://127.0.0.1:3000", token: "endpoint-token", pid: 1000 },
			true,
		],
		[
			"dead endpoint",
			daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }),
			{ sessionId: "s", url: "ws://127.0.0.1:3000", token: "endpoint-token", pid: 999 },
			true,
		],
		[
			"unknown endpoint",
			daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }),
			{ sessionId: "s", url: "ws://127.0.0.1:3000", token: "endpoint-token" },
			true,
		],
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
		const endpointPath = path.join("/tmp/gjc-none", "sdk", "session-a.json");
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

	test("reports normalized daemon generation relations and heartbeat age", async () => {
		const cases = [
			{ state: { generation: DAEMON_GENERATION }, generation: DAEMON_GENERATION, relation: "current" },
			{ state: { generation: DAEMON_GENERATION - 1 }, generation: DAEMON_GENERATION - 1, relation: "older" },
			{ state: {}, generation: undefined, relation: "pre_generation" },
			{ state: { generation: DAEMON_GENERATION + 1 }, generation: DAEMON_GENERATION + 1, relation: "newer" },
		] as const;

		for (const testCase of cases) {
			const { fs } = mockFs({
				[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490, ...testCase.state }),
			});
			const report = await checkNotificationHealth({
				settings,
				stateRoot: "/tmp/gjc-none",
				deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
			});
			expect(report.daemon.heartbeatAt).toBe(1_490);
			expect(report.daemon.heartbeatAgeMs).toBe(10);
			expect(report.daemon.heartbeatFresh).toBe(true);
			expect(report.daemon.currentGeneration).toBe(DAEMON_GENERATION);
			expect(report.daemon.generation).toBe(testCase.generation);
			expect(report.daemon.generationRelation).toBe(testCase.relation);
		}
	});

	test("normalizes malformed heartbeat and generation metadata without changing warning output", async () => {
		const malformedHeartbeatValues: unknown[] = [undefined, -1, "1490", null];
		const malformedGenerationValues: unknown[] = [-1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1];
		for (const heartbeatAt of malformedHeartbeatValues) {
			const { fs } = mockFs({
				[statePath]: daemonStateJson({ pid: 1000, heartbeatAt, generation: DAEMON_GENERATION }),
			});
			const report = await checkNotificationHealth({
				settings,
				stateRoot: "/tmp/gjc-none",
				deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
			});
			expect(report.daemon.heartbeatAt).toBeUndefined();
			expect(report.daemon.heartbeatAgeMs).toBeUndefined();
			expect(report.daemon.heartbeatFresh).toBe(false);
			expect(report.overall).toBe("warn");
			expect(formatNotificationHealthReport(report)).toBe(
				[
					"Notification health: WARN",
					"  [ok] config: enabled with at least one configured adapter",
					"  [warn] daemon: daemon pid 1000 heartbeat is stale",
					"  [ok] endpoints: 0 live, 0 unverified endpoint file(s)",
				].join("\n"),
			);
		}
		for (const generation of malformedGenerationValues) {
			const { fs } = mockFs({
				[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490, generation }),
				[path.join("/tmp/gjc-none", "sdk", "session-a.json")]: JSON.stringify({
					sessionId: "session-a",
					url: "ws://127.0.0.1:3000",
					token: "endpoint-token",
					pid: 1000,
				}),
			});
			const report = await checkNotificationHealth({
				settings,
				stateRoot: "/tmp/gjc-none",
				deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
			});
			expect(report.daemon.generation).toBeUndefined();
			expect(report.daemon.generationRelation).toBe("unknown");
			expect(report.daemon.heartbeatFresh).toBe(true);
			expect(report.overall).toBe("ok");
		}
	});

	test("accepts finite timestamp floats and clamps future heartbeat age for display", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({
				pid: 1000,
				startedAt: 0.5,
				heartbeatAt: 1_500.5,
				stoppedAt: 1.5,
				generation: DAEMON_GENERATION,
			}),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.heartbeatAt).toBe(1_500.5);
		expect(report.daemon.heartbeatAgeMs).toBe(0);
		expect(report.daemon.heartbeatFresh).toBe(true);
		expect(report.daemon.stopped).toBe(true);
	});

	test("rejects malformed identity metadata before matching and keeps its warning semantics", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({
				pid: 1000,
				heartbeatAt: 1_490,
				tokenFingerprint: [tokenFingerprint(TOKEN)],
				chatId: 12345,
				roots: ["/safe", 1],
				generation: DAEMON_GENERATION,
			}),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.identityMatches).toBe(false);
		expect(report.overall).toBe("warn");
		expect(report.checks.find(check => check.name === "daemon")?.detail).toBe(
			"a live daemon owns a different bot token or chat id",
		);
	});

	test("rejects malformed required daemon ownership metadata before liveness checks", async () => {
		const invalidStates: Record<string, unknown>[] = [
			{ pid: 0 },
			{ pid: -1 },
			{ pid: 1.5 },
			{ pid: "1000" },
			{ ownerId: "" },
		];
		for (const state of invalidStates) {
			let pidAliveCalls = 0;
			const { fs } = mockFs({ [statePath]: daemonStateJson(state) });
			const report = await checkNotificationHealth({
				settings,
				stateRoot: "/tmp/gjc-none",
				deps: {
					fs,
					now: () => 1_500,
					pidAlive: () => {
						pidAliveCalls += 1;
						return true;
					},
				},
			});
			expect(report.daemon.present).toBe(false);
			expect(report.daemon.alive).toBe(false);
			expect(report.daemon.generationRelation).toBe("unknown");
			expect(pidAliveCalls).toBe(0);
		}
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
	const epDir = path.join(stateRoot, "sdk");

	test("removes only dead/stale endpoints and never a live owner's lock", async () => {
		const { fs, unlinked } = mockFs({
			[path.join(epDir, "live.json")]: JSON.stringify({
				sessionId: "live",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 1000,
				stale: false,
			}),
			[path.join(epDir, "stale.json")]: JSON.stringify({
				sessionId: "stale",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 1000,
				stale: true,
			}),
			[path.join(epDir, "dead.json")]: JSON.stringify({
				sessionId: "dead",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 777,
				stale: false,
			}),
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
	test("keeps a live endpoint that replaces a dead endpoint before identity-bound deletion", async () => {
		const endpoint = path.join(epDir, "replaced.json");
		const liveReplacement = JSON.stringify({
			sessionId: "replacement",
			url: "ws://127.0.0.1:3000",
			token: "endpoint-token",
			pid: 1000,
		});
		const { fs, store, unlinked } = mockFs(
			{
				[endpoint]: JSON.stringify({
					sessionId: "dead",
					url: "ws://127.0.0.1:3000",
					token: "endpoint-token",
					pid: 999,
				}),
			},
			{
				onExactUnlink: file => {
					if (file === endpoint) store.set(file, liveReplacement);
				},
			},
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: pid => pid === 1000 },
		});

		expect(report.endpointsRemoved).toEqual([]);
		expect(report.endpointsKept).toBe(1);
		expect(unlinked).toEqual([]);
		expect(store.get(endpoint)).toBe(liveReplacement);
	});
	test("leaves shared lifecycle records untouched while recovering endpoint candidates", async () => {
		const lifecycle = path.join(epDir, "session-a.lifecycle.json");
		const ready = path.join(epDir, "session-b.lifecycle.ready.json");
		const broker = path.join(epDir, "broker.json");
		const failure = path.join(epDir, "session-c.lifecycle.failure.request-c.json");
		const partialReady = path.join(epDir, "partial.lifecycle.ready.json");
		const partialFailure = path.join(epDir, "partial.lifecycle.failure.request.json");
		const deadEndpoint = path.join(epDir, "dead-endpoint.json");
		const liveEndpoint = path.join(epDir, "live-endpoint.json");
		const malformedEndpoint = path.join(epDir, "malformed-endpoint.json");
		const dottedLifecycleEndpoint = path.join(epDir, "dotted.lifecycle.json");
		const dottedReadyEndpoint = path.join(epDir, "dotted.ready.json");
		const { fs, store, unlinked } = mockFs({
			[lifecycle]: JSON.stringify({ pid: 999, effectMarker: "request-a", incarnation: "incarnation-a" }),
			[ready]: JSON.stringify({ pid: 1000, effectMarker: "request-b", incarnation: "incarnation-b" }),
			[failure]: JSON.stringify({
				pid: 999,
				effectMarker: "request-c",
				incarnation: "incarnation-c",
				phase: "startup",
				reason: "failed",
				message: "failed",
				rollback: {},
			}),
			[partialReady]: "{",
			[partialFailure]: "{",
			[broker]: JSON.stringify({
				url: "ws://127.0.0.1:4000",
				token: "broker-token",
				pid: 999,
			}),
			[deadEndpoint]: JSON.stringify({
				sessionId: "dead-endpoint",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 999,
			}),
			[liveEndpoint]: JSON.stringify({
				sessionId: "live-endpoint",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 1000,
			}),
			[malformedEndpoint]: "{",
			[dottedLifecycleEndpoint]: JSON.stringify({
				sessionId: "dotted.lifecycle",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 999,
			}),
			[dottedReadyEndpoint]: JSON.stringify({
				sessionId: "dotted.ready",
				url: "ws://127.0.0.1:3000",
				token: "endpoint-token",
				pid: 1000,
			}),
		});
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: pid => pid === 1000 },
		});

		expect(report.endpointsScanned).toBe(5);
		expect(report.endpointsRemoved.map(endpoint => endpoint.sessionId).sort()).toEqual([
			"dead-endpoint",
			"dotted.lifecycle",
		]);
		expect(report.endpointsKept).toBe(2);
		expect(report.endpointsUnreadable).toBe(1);
		expect(unlinked.sort()).toEqual([deadEndpoint, dottedLifecycleEndpoint].sort());
		expect(store.has(lifecycle)).toBe(true);
		expect(store.has(ready)).toBe(true);
		expect(store.has(failure)).toBe(true);
		expect(store.has(partialReady)).toBe(true);
		expect(store.has(partialFailure)).toBe(true);
		expect(store.has(broker)).toBe(true);
		expect(store.has(liveEndpoint)).toBe(true);
		expect(store.has(dottedReadyEndpoint)).toBe(true);
		expect(store.has(malformedEndpoint)).toBe(true);
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
	test("does not count or remove a rejected link or replacement endpoint", async () => {
		const endpoint = path.join(epDir, "link.json");
		const { fs, store, unlinked } = mockFs(
			{
				[endpoint]: JSON.stringify({ sessionId: "link", url: "ws://x", token: "t", pid: 999 }),
			},
			{ rejectEndpointFiles: new Set([endpoint]) },
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: () => false },
		});

		expect(report.endpointsUnreadable).toBe(1);
		expect(report.endpointsRemoved).toEqual([]);
		expect(unlinked).toEqual([]);
		expect(store.has(endpoint)).toBe(true);
	});
	test("reports a detached endpoint after native post-detach failure for retry", async () => {
		const endpoint = path.join(epDir, "detached.json");
		const detached = path.join(epDir, ".gjc-delete-notification-endpoint-retry.json");
		const { fs, store, unlinked } = mockFs(
			{
				[endpoint]: JSON.stringify({ sessionId: "detached", url: "ws://x", token: "t", pid: 999 }),
				[detached]: JSON.stringify({ retained: true }),
			},
			{
				exactUnlinkResult: file =>
					file === endpoint ? { ok: false, code: "io_error", detachedPath: detached } : undefined,
			},
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: () => false },
		});

		expect(report.endpointsDetached).toEqual([detached]);
		expect(report.endpointsKept).toBe(0);
		expect(report.endpointsScanned).toBe(1);
		expect(formatNotificationRecoveryReport(report)).toContain(`retained detached endpoint ${detached}`);
		expect(unlinked).toEqual([]);
		expect(store.has(detached)).toBe(true);
	});
	test("reports detached stale endpoints and retained successors as separate recovery paths", async () => {
		const endpoint = path.join(epDir, "raced.json");
		const detached = path.join(epDir, ".gjc-delete-notification-endpoint-raced.json");
		const successor = path.join(epDir, ".gjc-exact-unlink-placeholder-raced.json");
		const { fs, unlinked } = mockFs(
			{
				[endpoint]: JSON.stringify({ sessionId: "raced", url: "ws://x", token: "t", pid: 999 }),
				[detached]: JSON.stringify({ stale: true }),
				[successor]: JSON.stringify({ live: true }),
			},
			{
				exactUnlinkResult: file =>
					file === endpoint
						? {
								ok: false,
								code: "identity_mismatch",
								detachedPath: detached,
								retainedSuccessorPath: successor,
							}
						: undefined,
			},
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: () => false },
		});

		expect(report.endpointsDetached).toEqual([detached]);
		expect(report.endpointsRetainedSuccessors).toEqual([successor]);
		expect(report.endpointsRetainedPlaceholders).toEqual([]);
		expect(report.endpointsKept).toBe(0);
		expect(formatNotificationRecoveryReport(report)).toContain(`retained detached endpoint ${detached}`);
		expect(formatNotificationRecoveryReport(report)).toContain(`retained successor endpoint ${successor}`);
		expect(unlinked).toEqual([]);
	});
	test("reports a retained internal exchange placeholder separately from stale objects and live successors", async () => {
		const endpoint = path.join(epDir, "placeholder.json");
		const placeholder = path.join(epDir, ".gjc-exact-unlink-placeholder-verified");
		const { fs, unlinked } = mockFs(
			{
				[endpoint]: JSON.stringify({ sessionId: "placeholder", url: "ws://x", token: "t", pid: 999 }),
				[placeholder]: JSON.stringify({ internal: true }),
			},
			{
				exactUnlinkResult: file =>
					file === endpoint ? { ok: false, code: "io_error", retainedPlaceholderPath: placeholder } : undefined,
			},
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: () => false },
		});

		expect(report.endpointsScanned).toBe(1);
		expect(report.endpointsDetached).toEqual([]);
		expect(report.endpointsRetainedSuccessors).toEqual([]);
		expect(report.endpointsRetainedPlaceholders).toEqual([placeholder]);
		expect(report.endpointsKept).toBe(0);
		expect(formatNotificationRecoveryReport(report)).toContain(
			`retained exchange placeholder cleanup path ${placeholder}`,
		);
		expect(unlinked).toEqual([]);
	});
	test("reports an unverified retained cleanup entry separately from stale objects and verified placeholders", async () => {
		const endpoint = path.join(epDir, "unknown.json");
		const unknown = path.join(epDir, ".gjc-exact-unlink-placeholder-mismatch");
		const { fs, unlinked } = mockFs(
			{
				[endpoint]: JSON.stringify({ sessionId: "unknown", url: "ws://x", token: "t", pid: 999 }),
				[unknown]: JSON.stringify({ unverified: true }),
			},
			{
				exactUnlinkResult: file =>
					file === endpoint ? { ok: false, code: "identity_mismatch", retainedUnknownPath: unknown } : undefined,
			},
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, pidAlive: () => false },
		});

		expect(report.endpointsDetached).toEqual([]);
		expect(report.endpointsRetainedSuccessors).toEqual([]);
		expect(report.endpointsRetainedPlaceholders).toEqual([]);
		expect(report.endpointsRetainedUnknown).toEqual([unknown]);
		expect(formatNotificationRecoveryReport(report)).toContain(`retained unverified cleanup path ${unknown}`);
		expect(unlinked).toEqual([]);
	});

	test("leaves a lock untouched when required daemon ownership metadata is invalid", async () => {
		const { fs, unlinked } = mockFs({
			[paths.state]: daemonStateJson({ pid: 0 }),
			[paths.lock]: "lock",
		});
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-empty",
			deps: { fs, pidAlive: () => false },
		});
		expect(report.daemon.action).toBe("orphan-lock-left");
		expect(unlinked).not.toContain(paths.lock);
	});
});
describe("notification-service endpoint liveness (owner-proof)", () => {
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const stateRoot = "/tmp/gjc-liveness-state";
	const epDir = path.join(stateRoot, "sdk");

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
	test.each([
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])("recovery keeps invalid pid %p without probing liveness", async pid => {
		const endpoint = path.join(epDir, `invalid-${pid}.json`);
		const { fs, unlinked } = mockFs({
			[endpoint]: JSON.stringify({ url: "ws://x", token: "t", pid }),
		});
		let pidAliveCalls = 0;
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: {
				fs,
				pidAlive: () => {
					pidAliveCalls += 1;
					return false;
				},
			},
		});

		expect(report.endpointsRemoved).toEqual([]);
		expect(report.endpointsKept).toBe(1);
		expect(unlinked).toEqual([]);
		expect(pidAliveCalls).toBe(0);
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
