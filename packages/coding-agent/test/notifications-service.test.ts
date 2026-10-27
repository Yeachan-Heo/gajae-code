import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
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
	NOTIFICATION_DEBRIS_MIN_AGE_MS,
	recoverNotifications,
	sanitizeDiagnostic,
	sendNotificationTest,
	sweepNotificationDebris,
	writeNotificationDiagnostic,
} from "../src/sdk/bus/notification-service";
import type { DaemonState } from "../src/sdk/bus/telegram-daemon";
import { isCurrentCompatibleOwner, isFreshLiveOwner } from "../src/sdk/bus/telegram-daemon";
import { DAEMON_GENERATION, SERVING_EPOCH } from "../src/sdk/bus/telegram-daemon-contract";

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
		/** Fires immediately before identity-bound direct debris deletion. */
		onUnlinkExact?: (file: string, store: Map<string, string>) => void;
		exactUnlinkResult?: (file: string) => NotificationExactUnlinkResult | undefined;
		rejectEndpointFiles?: Set<string>;
		/** Per-file mtimeMs for the optional `stat` capability; absent files throw ENOENT. */
		mtimes?: Record<string, number>;
		/**
		 * Fires inside `readEndpointFile` with the zero-based per-file read index
		 * (the first read of a file is `0`). Lets a test replace a debris object's
		 * bytes between the sweep's staleness snapshot and its before-unlink
		 * identity re-check, proving a successor is retained, not unlinked.
		 */
		onReadEndpointFile?: (file: string, store: Map<string, string>, readIndex: number) => void;
	} = {},
): { fs: NotificationServiceFs; unlinked: string[]; created: string[]; store: Map<string, string> } {
	const store = new Map(Object.entries(files));
	for (const [file, value] of [...store]) {
		if (!file.endsWith("telegram-daemon.state.json")) continue;
		const state = JSON.parse(value) as Record<string, unknown>;
		if (typeof state.pid !== "number" || typeof state.incarnation !== "string" || typeof state.ownerId !== "string")
			continue;
		const lock = file.replace("telegram-daemon.state.json", "telegram-daemon.lock");
		if (!store.has(lock))
			store.set(
				lock,
				JSON.stringify({
					pid: state.pid,
					incarnation: state.incarnation,
					ownerId: state.ownerId,
					acquisitionId: state.acquisitionId ?? state.ownerId,
					startedAt: state.startedAt,
				}),
			);
	}
	const revisions = new Map<string, number>([...store.keys()].map(file => [file, 1]));
	const readEndpointCounts = new Map<string, number>();
	const unlinked: string[] = [];
	const created: string[] = [];
	const enoent = (): NodeJS.ErrnoException => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	// The sweep derives candidate age from the SAME no-follow snapshot it binds
	// the delete to, so the mock's identity must carry the configured mtime.
	// `ino`/`size`/`sha256` still change on replacement, so an identity mismatch
	// is still detected when the mtime is pinned.
	const mtimeNsFor = (file: string): bigint => {
		const configured = opts.mtimes?.[file];
		if (configured !== undefined) return BigInt(Math.round(configured * 1_000_000));
		return BigInt(revisions.get(file) ?? 0);
	};
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
			const original = store.get(file);
			if (original === undefined) throw enoent();
			const readIndex = readEndpointCounts.get(file) ?? 0;
			readEndpointCounts.set(file, readIndex + 1);
			opts.onReadEndpointFile?.(file, store, readIndex);
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
					mtimeNs: mtimeNsFor(file),
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
				identity.mtimeNs === mtimeNsFor(file) &&
				identity.sha256 === crypto.createHash("sha256").update(bytes).digest("hex");
			if (!matches) return { ok: false, code: "identity_mismatch" };
			store.delete(file);
			unlinked.push(file);
			return { ok: true };
		},
		async unlinkExact(file, identity) {
			opts.onUnlinkExact?.(file, store);
			if (opts.failUnlink?.has(file)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			const value = store.get(file);
			if (value === undefined) throw enoent();
			const bytes = Buffer.from(value);
			const revision = revisions.get(file) ?? 0;
			const matches =
				identity.dev === 1n &&
				identity.ino === BigInt(revision) &&
				identity.size === BigInt(bytes.length) &&
				identity.mtimeNs === mtimeNsFor(file) &&
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
		async stat(file) {
			const mtimeMs = opts.mtimes?.[file];
			if (mtimeMs === undefined) throw enoent();
			return { mtimeMs };
		},
	};
	return { fs, unlinked, created, store };
}

function daemonStateJson(over: Record<string, unknown>): string {
	return JSON.stringify({
		pid: 4242,
		incarnation: "linux:100",
		ownerId: "owner-a",
		acquisitionId: "owner-a",
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
	test("writes bounded secret-safe daemon diagnostics", async () => {
		const settings = Settings.isolated();
		await writeNotificationDiagnostic(settings, {
			operation: "notify.setup",
			phase: "activation",
			outcome: "failed",
			reason: "network_error",
			pid: 123,
			incarnation: "linux:1",
			detail: `token ${TOKEN} chat 999 raw exception text`,
		});
		const diagnostic = JSON.parse(await Bun.file(daemonPaths(settings.getAgentDir()).diagnostic).text()) as {
			events: Array<{ detail?: string; pid?: number }>;
		};
		const event = diagnostic.events.at(-1);
		expect(event).toMatchObject({ pid: 123 });
		expect(diagnostic.events.every(item => !item.detail?.includes(TOKEN))).toBe(true);
		expect(event?.detail).toContain("<redacted>");
	});
});

describe("configured chat daemon readiness", () => {
	test("awaits every configured provider before the ownership ensure can settle", async () => {
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

	test("propagates configured provider readiness failures to the ownership ensure", async () => {
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

	test("corrupt daemon state degrades to a health warning", async () => {
		const { fs, store } = mockFs({});
		store.set(statePath, '{"pid":1000');
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: () => true },
		});
		expect(report.daemon.present).toBe(false);
		expect(report.overall).toBe("warn");
		expect(report.checks.find(check => check.name === "daemon")).toEqual({
			name: "daemon",
			level: "warn",
			detail: "daemon ownership record is corrupt or unreadable",
		});
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
				"  [ok] config: telegram is effective",
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

	const heartbeatPath = daemonPaths(settings.getAgentDir()).heartbeat;
	// Matches the owner tag daemonStateJson() writes, so the sidecar is accepted as this owner's own.
	const ownerSidecarTag = { pid: 1000, incarnation: "linux:100", ownerId: "owner-a", acquisitionId: "owner-a" };
	const attachStateRoot = "/tmp/gjc-attachment";
	const attachEndpoint = JSON.stringify({
		sessionId: "session-a",
		url: "ws://127.0.0.1:3000",
		token: "endpoint-token",
		pid: 1000,
	});

	test("warns when endpoint files are registered but a live daemon reports zero attachments", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }),
			[heartbeatPath]: JSON.stringify({ ...ownerSidecarTag, heartbeatAt: 1_490, attachedEndpoints: 0 }),
			[path.join(attachStateRoot, "sdk", "session-a.json")]: attachEndpoint,
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: attachStateRoot,
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.attachedEndpoints).toBe(0);
		expect(report.endpoints.total).toBe(1);
		expect(report.checks.find(check => check.name === "endpoint_attachment")).toEqual({
			name: "endpoint_attachment",
			level: "warn",
			detail:
				"1 endpoint file(s) registered but daemon pid 1000 reports 0 attached session(s); the daemon cannot deliver to any registered endpoint",
		});
		expect(report.overall).toBe("warn");
	});

	test("stays clean when the live daemon reports at least one attached endpoint", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490, generation: DAEMON_GENERATION }),
			[heartbeatPath]: JSON.stringify({ ...ownerSidecarTag, heartbeatAt: 1_490, attachedEndpoints: 1 }),
			[path.join(attachStateRoot, "sdk", "session-a.json")]: attachEndpoint,
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: attachStateRoot,
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.attachedEndpoints).toBe(1);
		expect(report.checks.some(check => check.name === "endpoint_attachment")).toBe(false);
		expect(report.overall).toBe("ok");
	});

	test("treats a sidecar without an attachment count as unknown rather than zero", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490, generation: DAEMON_GENERATION }),
			[heartbeatPath]: JSON.stringify({ ...ownerSidecarTag, heartbeatAt: 1_490 }),
			[path.join(attachStateRoot, "sdk", "session-a.json")]: attachEndpoint,
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: attachStateRoot,
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.daemon.attachedEndpoints).toBeUndefined();
		expect(report.checks.some(check => check.name === "endpoint_attachment")).toBe(false);
		expect(report.overall).toBe("ok");
	});

	test("flags a live daemon whose generation this build refuses to attach a transport to", async () => {
		const servedGeneration = DAEMON_GENERATION - 1;
		const stateJson = daemonStateJson({
			pid: 1000,
			heartbeatAt: 1_490,
			generation: servedGeneration,
			ownershipPhase: "ready",
			servingEpoch: SERVING_EPOCH,
		});
		const attachInput = {
			state: JSON.parse(stateJson) as DaemonState,
			now: 1_500,
			tokenFingerprint: tokenFingerprint(TOKEN),
			chatId: "12345",
			pidAlive: (pid: number) => pid === 1000,
			pidIncarnation: () => "linux:100",
		};
		// The runtime's own predicates are what make this owner undeliverable: it is a
		// fresh live owner, so nothing replaces it, but it is not a current compatible
		// owner, so `acquireDaemonOwnership` answers `provisional` and no session ever
		// binds a transport. The generation is the sole discriminator between the two.
		expect(isFreshLiveOwner(attachInput)).toBe(true);
		expect(isCurrentCompatibleOwner(attachInput)).toBe(false);
		expect(
			isCurrentCompatibleOwner({
				...attachInput,
				state: { ...attachInput.state, generation: DAEMON_GENERATION },
			}),
		).toBe(true);

		const { fs } = mockFs({
			[statePath]: stateJson,
			[heartbeatPath]: JSON.stringify({ ...ownerSidecarTag, heartbeatAt: 1_490 }),
			[path.join(attachStateRoot, "sdk", "session-a.json")]: attachEndpoint,
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: attachStateRoot,
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		// Every other signal is green: the process is alive, the heartbeat is fresh, the
		// identity matches, a live endpoint file is registered, and an owner older than
		// generation 59 publishes no attachment count, so #4128's detector stays silent.
		expect(report.daemon.alive).toBe(true);
		expect(report.daemon.heartbeatFresh).toBe(true);
		expect(report.daemon.identityMatches).toBe(true);
		expect(report.endpoints.live).toBe(1);
		expect(report.daemon.attachedEndpoints).toBeUndefined();
		expect(report.checks.some(check => check.name === "endpoint_attachment")).toBe(false);
		expect(report.checks.find(check => check.name === "daemon")).toEqual({
			name: "daemon",
			level: "warn",
			detail: `daemon pid 1000 serves generation ${servedGeneration} but this build attaches only to generation ${DAEMON_GENERATION}; it cannot attach a session transport — inspect daemon lifecycle status before attempting recovery`,
		});
		expect(report.overall).toBe("warn");
	});

	test("keeps the no-endpoint-file hint and skips the attachment warn when nothing is registered", async () => {
		const { fs } = mockFs({
			[statePath]: daemonStateJson({ pid: 1000, heartbeatAt: 1_490 }),
			[heartbeatPath]: JSON.stringify({ ...ownerSidecarTag, heartbeatAt: 1_490, attachedEndpoints: 0 }),
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-none",
			deps: { fs, now: () => 1_500, pidAlive: pid => pid === 1000 },
		});
		expect(report.endpoints.total).toBe(0);
		expect(report.checks.find(check => check.name === "local_endpoint")).toEqual({
			name: "local_endpoint",
			level: "warn",
			detail:
				"No local notification endpoint for this working directory. In this GJC terminal run /notify on; if it does not report notifications enabled, start a new local GJC session. Do not re-pair Telegram.",
		});
		expect(report.checks.some(check => check.name === "endpoint_attachment")).toBe(false);
		expect(report.overall).toBe("warn");
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
					"  [ok] config: telegram is effective",
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
			expect(report.daemon.heartbeatFresh).toBe(false);
			expect(report.overall).toBe("warn");
		}
	});

	test("reports stopped modern owners without freshness when no stable owner tag exists", async () => {
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
		expect(report.daemon.heartbeatAt).toBeUndefined();
		expect(report.daemon.heartbeatAgeMs).toBeUndefined();
		expect(report.daemon.heartbeatFresh).toBe(false);
		expect(report.daemon.stopped).toBe(true);
	});

	test("treats malformed modern owner identity metadata as stale", async () => {
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
		expect(report.checks.find(check => check.name === "daemon")?.detail).toBe("daemon pid 1000 heartbeat is stale");
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
		expect(result.detail).toContain("No notification provider is effective");
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
			deps: {
				fetchImpl,
				apiBase: "https://api.telegram.org",
				providerRuntimeStatus: () => "ready",
			},
		});
		expect(result.ok).toBe(true);
		expect(result.destination).toBe("12345");
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
		expect(report.daemon.blockingReason).toBe("transition-marker-unavailable-or-contended");
		expect(report.daemon.forceCommand).toBe("gjc notify recovery --force-daemon-lock");
		const text = formatNotificationRecoveryReport(report);
		expect(text).toContain("blocking reason: transition-marker-unavailable-or-contended");
		expect(text).toContain("safe escape: gjc notify recovery --force-daemon-lock");
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

describe("notification-service stale debris sweep", () => {
	const dir = "/tmp/gjc-debris/notifications";
	const NOW = 10 * NOTIFICATION_DEBRIS_MIN_AGE_MS;
	const OLD = NOW - NOTIFICATION_DEBRIS_MIN_AGE_MS - 1;
	const YOUNG = NOW - 1_000;

	test("removes stale quarantine, placeholder, and dead-writer staging files only", async () => {
		const staleTransition = path.join(dir, "transition-005aa822-3f0b-45c9-bd39-e7047b1d3be4");
		const youngTransition = path.join(dir, "transition-11111111-2222-4333-8444-555555555555");
		const stalePlaceholder = path.join(dir, ".gjc-exact-unlink-placeholder-abc.json");
		const deadWriterTmp = path.join(dir, "telegram-callback-aliases.json.777.1786499330704.2o3rwhj5qax.tmp");
		const liveWriterTmp = path.join(dir, "telegram-presentation-state.json.1000.1786546900647.sucg48nr9uk.tmp");
		const canonical = path.join(dir, "telegram-daemon.state.json");
		const { fs, unlinked } = mockFs(
			{
				[staleTransition]: "",
				[youngTransition]: "",
				[stalePlaceholder]: "",
				[deadWriterTmp]: "{}",
				[liveWriterTmp]: "{}",
				[canonical]: daemonStateJson({ pid: 1000 }),
			},
			{
				mtimes: {
					[staleTransition]: OLD,
					[youngTransition]: YOUNG,
					[stalePlaceholder]: OLD,
					[deadWriterTmp]: YOUNG,
					[liveWriterTmp]: YOUNG,
					[canonical]: OLD,
				},
			},
		);
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: pid => pid === 1000 },
		});
		expect(report.removed.sort()).toEqual(
			[path.basename(staleTransition), path.basename(stalePlaceholder), path.basename(deadWriterTmp)].sort(),
		);
		// Young quarantine and a live writer's young staging file are retained.
		expect(report.kept).toBe(2);
		// Canonical files never match the debris patterns even when old.
		expect(unlinked).not.toContain(canonical);
	});

	test("a stale staging file of a live writer is removed by age", async () => {
		const oldLiveTmp = path.join(dir, "telegram-callback-aliases.json.1000.1786000000000.abcdef.tmp");
		const { fs } = mockFs({ [oldLiveTmp]: "{}" }, { mtimes: { [oldLiveTmp]: OLD } });
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => true },
		});
		expect(report.removed).toEqual([path.basename(oldLiveTmp)]);
	});

	test("a dead-writer staging file is swept on pid proof alone, without any age proof", async () => {
		// Age and identity come from one snapshot; a dead recorded writer is
		// independent positive proof and needs no mtime at all.
		const transition = path.join(dir, "transition-005aa822-3f0b-45c9-bd39-e7047b1d3be4");
		const deadTmp = path.join(dir, "telegram-seen-updates.json.777.1786000000000.abcdef.tmp");
		const { fs } = mockFs(
			{ [transition]: "", [deadTmp]: "{}" },
			{ mtimes: { [transition]: YOUNG, [deadTmp]: YOUNG } },
		);
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.removed).toEqual([path.basename(deadTmp)]);
		expect(report.kept).toBe(1);
	});

	test("a successor published immediately before direct debris deletion is retained as a failure", async () => {
		// The successor lands after the sweep's inspection and immediately before
		// the identity-bound delete operation. The direct operation must refuse the
		// replacement rather than unlinking the live publication.
		const debris = path.join(dir, "transition-005aa822-3f0b-45c9-bd39-e7047b1d3be4");
		const { fs, store, unlinked } = mockFs(
			{ [debris]: "stale-quarantine" },
			{
				mtimes: { [debris]: OLD },
				onUnlinkExact: (file, files) => {
					if (file === debris) files.set(file, "live-successor-content");
				},
			},
		);
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.removed).toEqual([]);
		expect(report.failures).toBe(1);
		expect(unlinked).toEqual([]);
		expect(store.get(debris)).toBe("live-successor-content");
	});

	test("an unlink failure is reported as a failure, not silently kept", async () => {
		const debris = path.join(dir, ".gjc-exact-unlink-placeholder-locked.json");
		const { fs } = mockFs({ [debris]: "" }, { mtimes: { [debris]: OLD }, failUnlink: new Set([debris]) });
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.removed).toEqual([]);
		expect(report.failures).toBe(1);
		expect(report.kept).toBe(0);
	});

	test("a failed directory listing is reported instead of looking like a clean sweep", async () => {
		const { fs } = mockFs({});
		const report = await sweepNotificationDebris({
			dir: "/tmp/gjc-debris-missing-dir",
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report).toMatchObject({ removed: [], kept: 0, failures: 0, scanFailed: true });
	});

	test("an unreadable candidate is a failure and is never pathname-unlinked", async () => {
		const debris = path.join(dir, "transition-11111111-2222-4333-8444-555555555555");
		const { fs, unlinked } = mockFs(
			{ [debris]: "" },
			{ mtimes: { [debris]: OLD }, rejectEndpointFiles: new Set([debris]) },
		);
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.removed).toEqual([]);
		expect(report.failures).toBe(1);
		expect(unlinked).toEqual([]);
	});

	test("an unreadable candidate snapshot is reported as a failure, not laundered into kept", async () => {
		// The snapshot read is the only source of age, scrub proof, and delete
		// identity, so an operational read failure must surface as `failures`
		// rather than as ordinary policy retention.
		const debris = path.join(dir, "transition-22222222-3333-4444-8555-666666666666");
		const { fs, unlinked } = mockFs(
			{ [debris]: "" },
			{ mtimes: { [debris]: OLD }, rejectEndpointFiles: new Set([debris]) },
		);
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.failures).toBe(1);
		expect(report.kept).toBe(0);
		expect(unlinked).toEqual([]);
	});

	test("age and delete identity come from one snapshot, so a post-snapshot successor survives", async () => {
		// Regression for the stat-then-read window: proving age on one pathname
		// and then capturing identity separately would bind the delete to a
		// successor that was never proved stale.
		const debris = path.join(dir, "transition-33333333-4444-4555-8666-777777777777");
		const { fs, store, unlinked } = mockFs(
			{ [debris]: "aged-quarantine" },
			{
				mtimes: { [debris]: OLD },
				onReadEndpointFile: (file, files, readIndex) => {
					if (file === debris && readIndex === 1) files.set(file, "fresh-live-successor");
				},
			},
		);
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.removed).toEqual([]);
		expect(report.failures).toBe(1);
		expect(unlinked).toEqual([]);
		expect(store.get(debris)).toBe("fresh-live-successor");
	});

	test("a nonempty exchange placeholder is retained even when old", async () => {
		// A nonempty placeholder can still carry retained cleanup evidence for an
		// endpoint whose verified removal failed; only the terminal scrubbed
		// (zero-length) remnant is inert.
		const evidence = path.join(dir, ".gjc-exact-unlink-placeholder-with-evidence.json");
		const scrubbed = path.join(dir, ".gjc-exact-unlink-placeholder-scrubbed");
		const { fs, unlinked } = mockFs(
			{ [evidence]: '{"retained":"cleanup-evidence"}', [scrubbed]: "" },
			{ mtimes: { [evidence]: OLD, [scrubbed]: OLD } },
		);
		const report = await sweepNotificationDebris({
			dir,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.removed).toEqual([path.basename(scrubbed)]);
		expect(report.kept).toBe(1);
		expect(unlinked).not.toContain(evidence);
	});

	test("the recovery report renders debris failures and a failed scan", () => {
		const rendered = formatNotificationRecoveryReport({
			endpointsScanned: 0,
			endpointsRemoved: [],
			endpointsKept: 0,
			endpointsUnreadable: 0,
			debrisRemoved: [],
			debrisKept: 2,
			debrisFailures: 3,
			debrisScanFailed: true,
			daemon: { action: "none", detail: "no daemon ownership record", ownerId: undefined, pid: undefined },
		});
		expect(rendered).toContain("debris: removed 0, kept 2, failed 3, scan failed");
	});

	test("recovery sweeps debris in both the endpoint and daemon dirs and reports it", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
		});
		const paths = daemonPaths(settings.getAgentDir());
		const stateRoot = "/tmp/gjc-debris-recovery";
		const daemonDebris = path.join(paths.dir, "transition-005aa822-3f0b-45c9-bd39-e7047b1d3be4");
		const endpointDebris = path.join(
			stateRoot,
			"sdk",
			".gjc-delete-notification-endpoint-005aa822-3f0b-45c9-bd39-e7047b1d3be4.json",
		);
		const { fs } = mockFs(
			{ [daemonDebris]: "", [endpointDebris]: "{}" },
			{ mtimes: { [daemonDebris]: OLD, [endpointDebris]: OLD } },
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.debrisRemoved?.sort()).toEqual([path.basename(daemonDebris), path.basename(endpointDebris)].sort());
		expect(formatNotificationRecoveryReport(report)).toContain("debris: removed 2, kept 0");
	});
});

describe("notification-service bounded notify recovery (#4701)", () => {
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const stateRoot = "/tmp/gjc-4701";
	const epDir = path.join(stateRoot, "sdk");
	const NOW = 10 * NOTIFICATION_DEBRIS_MIN_AGE_MS;
	const OLD = NOW - NOTIFICATION_DEBRIS_MIN_AGE_MS - 1;

	const liveEndpoint = path.join(epDir, "01a01743-2dd0-7000-8552-27f75f298517.json");
	const liveEndpointBody = JSON.stringify({
		version: 1,
		sessionId: "01a01743-2dd0-7000-8552-27f75f298517",
		pid: 1000,
		host: "127.0.0.1",
		port: 32975,
		url: "ws://127.0.0.1:32975",
		token: "endpoint-token",
		stale: false,
	});
	const quarantineA = path.join(epDir, ".gjc-delete-notification-endpoint-005aa822-3f0b-45c9-bd39-e7047b1d3be4.json");
	const quarantineB = path.join(epDir, ".gjc-delete-notification-endpoint-11111111-2222-4333-8444-555555555555.json");
	const placeholder = path.join(epDir, ".gjc-exact-unlink-placeholder-1-1");
	const DEBRIS_BASENAME = /^\.gjc-(?:delete-notification-endpoint-[0-9a-f-]{36}\.json|exact-unlink-placeholder-)/;

	function debrisCount(store: Map<string, string>): number {
		let count = 0;
		for (const key of store.keys()) {
			if (key.startsWith(epDir + path.sep) && DEBRIS_BASENAME.test(path.basename(key))) count += 1;
		}
		return count;
	}

	test("a live endpoint is never removed or quarantined while adjacent debris is swept", async () => {
		const { fs, store, unlinked } = mockFs(
			{
				[liveEndpoint]: liveEndpointBody,
				// A failed first scrub left a quarantine target still holding the
				// detached endpoint's bytes and a scrubbed zero-length remnant, plus
				// a retained exchange placeholder.
				[quarantineA]: JSON.stringify({ sessionId: "q1", url: "ws://x", token: "t", pid: 999 }),
				[quarantineB]: "",
				[placeholder]: "",
			},
			{ mtimes: { [quarantineA]: OLD, [quarantineB]: OLD, [placeholder]: OLD } },
		);
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, now: () => NOW, pidAlive: pid => pid === 1000 },
		});

		// The live owner's canonical endpoint is still matchable/usable and was not
		// detached to a quarantine path.
		expect(store.get(liveEndpoint)).toBe(liveEndpointBody);
		expect(unlinked).not.toContain(liveEndpoint);
		expect(report.endpointsKept).toBe(1);
		// The three inert debris objects were removed in place, not re-quarantined
		// (no fresh quarantine/placeholder debris is created).
		expect(report.debrisRemoved?.sort()).toEqual(
			[path.basename(quarantineA), path.basename(quarantineB), path.basename(placeholder)].sort(),
		);
		expect(debrisCount(store)).toBe(0);
	});

	test("a live endpoint successor cannot be hidden by a quarantine-shaped basename", async () => {
		const successorSessionId = path.basename(quarantineB, ".json");
		const successor = JSON.stringify({
			version: 1,
			sessionId: successorSessionId,
			url: "ws://127.0.0.1:32976",
			token: "successor-token",
			pid: 1000,
		});
		const { fs, store, unlinked } = mockFs(
			{
				[liveEndpoint]: liveEndpointBody,
				// This object is genuine detached endpoint bytes and is not a successor:
				// its session identity does not match the quarantine pathname.
				[quarantineA]: JSON.stringify({ sessionId: "detached-session", url: "ws://x", token: "t", pid: 999 }),
				[quarantineB]: successor,
				[placeholder]: "",
			},
			{ mtimes: { [quarantineA]: OLD, [quarantineB]: OLD, [placeholder]: OLD } },
		);
		const health = await checkNotificationHealth({
			settings,
			stateRoot,
			deps: { fs, now: () => NOW, pidAlive: pid => pid === 1000 },
		});
		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, now: () => NOW, pidAlive: pid => pid === 1000 },
		});

		expect(health.endpoints).toMatchObject({ total: 2, live: 2, dead: 0, unknown: 0, unreadable: 0 });
		expect(report.endpointsKept).toBe(2);
		expect(report.endpointsRemoved).toEqual([]);
		expect(store.get(quarantineB)).toBe(successor);
		expect(unlinked).not.toContain(quarantineB);
		expect(report.debrisRemoved?.sort()).toEqual([path.basename(quarantineA), path.basename(placeholder)].sort());
	});

	test("unreadable/unknown endpoint handling is bounded and not inflated by debris", async () => {
		const unreadable = path.join(epDir, "broken.json");
		const pidless = path.join(epDir, "pidless.json");
		const quarantineB = path.join(
			epDir,
			".gjc-delete-notification-endpoint-11111111-2222-4333-8444-555555555555.json",
		);
		const { fs, unlinked } = mockFs(
			{
				// A debris quarantine target must never count as an unreadable endpoint
				// that health flags as "run recovery".
				[unreadable]: "{",
				[pidless]: JSON.stringify({ url: "ws://x", token: "t" }),
				[quarantineB]: "",
			},
			{ rejectEndpointFiles: new Set([unreadable]) },
		);
		const health = await checkNotificationHealth({
			settings,
			stateRoot,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		// Debris is excluded from the endpoint census: only the genuine unreadable
		// and unknown endpoint count, each exactly once (a debris quarantine target
		// no longer inflates unreadable). Health still flags the one real unreadable.
		expect(health.endpoints.unreadable).toBe(1);
		expect(health.endpoints.unknown).toBe(1);
		expect(health.endpoints.total).toBe(2);
		expect(health.checks.find(check => check.name === "endpoints")?.detail).toContain("1 unreadable of 2");

		const report = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.endpointsUnreadable).toBe(1);
		expect(report.endpointsKept).toBe(1);
		expect(report.endpointsRemoved).toEqual([]);
		// Only the inert debris object is swept; the unreadable and unknown endpoints
		// are left untouched (the mock records full paths in `unlinked`).
		expect(unlinked).toEqual([quarantineB]);
		expect(unlinked).not.toContain(unreadable);
		expect(unlinked).not.toContain(pidless);
		expect(report.debrisRemoved).toEqual([path.basename(quarantineB)]);
	});

	test("repeated recovery does not increase the quarantine/placeholder count", async () => {
		// Model the native exact-unlink exchange re-manufacturing debris: any time
		// recovery routes a debris path back through `exactUnlink`, the native
		// exchange would detach it into a fresh quarantine destination and leave a
		// fresh retained placeholder.
		let debrisExactUnlinkCalls = 0;
		const seeds: Record<string, string> = {
			[liveEndpoint]: liveEndpointBody,
			[quarantineA]: JSON.stringify({ sessionId: "q1", url: "ws://x", token: "t", pid: 999 }),
			[quarantineB]: "",
			[placeholder]: "",
		};
		const { fs, store, unlinked } = mockFs(seeds, {
			mtimes: { [quarantineA]: OLD, [quarantineB]: OLD, [placeholder]: OLD },
			onExactUnlink: (file, files) => {
				if (DEBRIS_BASENAME.test(path.basename(file))) {
					debrisExactUnlinkCalls += 1;
					const uuid = crypto.randomUUID();
					files.set(path.join(epDir, `.gjc-delete-notification-endpoint-${uuid}.json`), "");
					files.set(path.join(epDir, `.gjc-exact-unlink-placeholder-${uuid}`), "");
				}
			},
		});

		let lastCount = debrisCount(store);
		let lastCountAfterFirst = -1;
		for (let run = 1; run <= 5; run += 1) {
			const report = await recoverNotifications({
				settings,
				stateRoot,
				deps: { fs, now: () => NOW, pidAlive: pid => pid === 1000 },
			});
			const count = debrisCount(store);
			// The count never increases across repeated recovery; after the first pass
			// it is a fixed point.
			expect(count).toBeLessThanOrEqual(lastCount);
			expect(count).toBeLessThanOrEqual(seedsDebrisCount());
			if (run === 1) lastCountAfterFirst = count;
			expect(count).toBe(lastCountAfterFirst);
			lastCount = count;
			expect(report.endpointsRemoved).toEqual([]);
		}
		// The live endpoint stayed published and matchable across every pass.
		expect(store.get(liveEndpoint)).toBe(liveEndpointBody);
		expect(unlinked).not.toContain(liveEndpoint);
		// Recovery never routed a debris object back through the re-quarantining
		// exchange, so it could not regenerate quarantine/placeholder artifacts.
		expect(debrisExactUnlinkCalls).toBe(0);

		function seedsDebrisCount(): number {
			return Object.keys(seeds).filter(key => DEBRIS_BASENAME.test(path.basename(key))).length;
		}
	});

	test("startup ensure recovery terminates and reaches a fixed point without a spin", async () => {
		// A single bounded recovery run against a noisy dir must terminate and, on
		// repeat, do no further work — the resident daemon's startup ensure cannot
		// re-arm a never-settling reconciliation loop.
		const { fs, store } = mockFs(
			{
				[liveEndpoint]: liveEndpointBody,
				[quarantineA]: JSON.stringify({ sessionId: "q1", url: "ws://x", token: "t", pid: 999 }),
				[quarantineB]: "",
				[placeholder]: "",
			},
			{ mtimes: { [quarantineA]: OLD, [quarantineB]: OLD, [placeholder]: OLD } },
		);
		const first = await recoverNotifications({
			settings,
			stateRoot,
			deps: { fs, now: () => NOW, pidAlive: pid => pid === 1000 },
		});
		expect(first.debrisRemoved?.length).toBe(3);
		for (let run = 0; run < 5; run += 1) {
			const again = await recoverNotifications({
				settings,
				stateRoot,
				deps: { fs, now: () => NOW, pidAlive: pid => pid === 1000 },
			});
			expect(again.debrisRemoved ?? []).toEqual([]);
			expect(again.endpointsRemoved).toEqual([]);
			expect(store.get(liveEndpoint)).toBe(liveEndpointBody);
		}
	});
});

describe("notification-service forced stale-marker recovery", () => {
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const paths = daemonPaths(settings.getAgentDir());
	const NOW = 1_000_000_000;

	test("force reclaims an old provenance-less steal marker and clears the dead-owner lock", async () => {
		const { fs, unlinked } = mockFs(
			{
				[paths.state]: daemonStateJson({ pid: 555, ownerId: "owner-a" }),
				[paths.lock]: "lock",
				[paths.steal]: "not json at all",
			},
			{ mtimes: { [paths.steal]: NOW - 120_000 } },
		);
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-forced",
			deps: { fs, now: () => NOW, pidAlive: () => false },
			forceDaemonLock: true,
		});
		expect(report.daemon.action).toBe("cleared-dead-owner-lock");
		expect(unlinked).toContain(paths.lock);
	});

	test("without force the same provenance-less marker stays blocking", async () => {
		const { fs, unlinked } = mockFs(
			{
				[paths.state]: daemonStateJson({ pid: 555, ownerId: "owner-a" }),
				[paths.lock]: "lock",
				[paths.steal]: "not json at all",
			},
			{ mtimes: { [paths.steal]: NOW - 120_000 } },
		);
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-unforced",
			deps: { fs, now: () => NOW, pidAlive: () => false },
		});
		expect(report.daemon.action).toBe("left-contended");
		expect(unlinked).not.toContain(paths.lock);
	});

	test("force never detaches a young marker", async () => {
		const { fs, unlinked } = mockFs(
			{
				[paths.state]: daemonStateJson({ pid: 555, ownerId: "owner-a" }),
				[paths.lock]: "lock",
				[paths.steal]: "not json at all",
			},
			{ mtimes: { [paths.steal]: NOW - 1_000 } },
		);
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-forced-young",
			deps: { fs, now: () => NOW, pidAlive: () => false },
			forceDaemonLock: true,
		});
		expect(report.daemon.action).toBe("left-contended");
		expect(unlinked).not.toContain(paths.lock);
	});

	test("force never detaches a valid marker even when old", async () => {
		// A live same-incarnation owner: the normal reclaim path must refuse it
		// (owner alive), and force must refuse it too (valid provenance).
		const validMarker = JSON.stringify({
			pid: process.pid,
			incarnation: processIncarnation(process.pid),
			createdAt: NOW - 120_000,
			token: "live-token",
		});
		const { fs, unlinked } = mockFs(
			{
				[paths.state]: daemonStateJson({ pid: 555, ownerId: "owner-a" }),
				[paths.lock]: "lock",
				[paths.steal]: validMarker,
			},
			{ mtimes: { [paths.steal]: NOW - 120_000 } },
		);
		const report = await recoverNotifications({
			settings,
			stateRoot: "/tmp/gjc-forced-valid",
			deps: { fs, now: () => NOW, pidAlive: pid => pid === process.pid },
			forceDaemonLock: true,
		});
		expect(report.daemon.action).toBe("left-contended");
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
		const result = await sendNotificationTest({
			settings,
			deps: { fetchImpl, providerRuntimeStatus: () => "ready" },
		});
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
	test("one-shot delivery fails closed without runtime readiness evidence", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
		});
		let called = false;
		const result = await sendNotificationTest({
			settings,
			deps: {
				fetchImpl: (async () => {
					called = true;
					return new Response();
				}) as unknown as typeof fetch,
			},
		});
		expect(result).toMatchObject({ ok: false, adapter: "telegram" });
		expect(result.detail).toContain("runtime is not ready");
		expect(called).toBe(false);
	});

	test("Discord health and one-shot diagnostics redact the selected provider token", async () => {
		const secret = "discord-secret-value";
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.discord.enabled": true,
			"notifications.discord.botToken": secret,
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "parent",
		});
		const diagnostic = {
			probeConfiguration: async () => ({ ok: false, detail: `probe rejected ${secret}` }),
			sendOneShotTest: async () => ({ ok: false, detail: `send rejected ${secret}` }),
		};
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-discord-probe",
			provider: "discord",
			probe: true,
			deps: { fs: mockFs({}).fs, createDiscordDiagnostic: () => diagnostic },
		});
		expect(report.reachability.detail).toBe("probe rejected <redacted>");
		const result = await sendNotificationTest({
			settings,
			provider: "discord",
			deps: {
				createDiscordDiagnostic: () => diagnostic,
				providerRuntimeStatus: () => "ready",
			},
		});
		expect(result.detail).toBe("send rejected <redacted>");
	});

	test("Slack health and one-shot diagnostics redact both selected provider tokens", async () => {
		const botToken = "xoxb-slack-secret";
		const appToken = "xapp-slack-secret";
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.slack.enabled": true,
			"notifications.slack.botToken": botToken,
			"notifications.slack.appToken": appToken,
			"notifications.slack.workspaceId": "workspace",
			"notifications.slack.channelId": "channel",
		});
		const diagnostic = {
			probeConfiguration: async () => ({ ok: false, detail: `probe ${botToken} ${appToken}` }),
			sendOneShotTest: async () => ({ ok: false, detail: `send ${botToken} ${appToken}` }),
		};
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-slack-probe",
			provider: "slack",
			probe: true,
			deps: { fs: mockFs({}).fs, createSlackDiagnostic: () => diagnostic },
		});
		expect(report.reachability.detail).toBe("probe <redacted> <redacted>");
		const result = await sendNotificationTest({
			settings,
			provider: "slack",
			deps: {
				createSlackDiagnostic: () => diagnostic,
				providerRuntimeStatus: () => "ready",
			},
		});
		expect(result.detail).toBe("send <redacted> <redacted>");
	});
	test("Slack health rejects credentials bound to a different workspace", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.slack.enabled": true,
			"notifications.slack.botToken": "xoxb-secret",
			"notifications.slack.appToken": "xapp-secret",
			"notifications.slack.workspaceId": "expected-workspace",
			"notifications.slack.channelId": "channel",
		});
		const report = await checkNotificationHealth({
			settings,
			stateRoot: "/tmp/gjc-slack-workspace-probe",
			provider: "slack",
			probe: true,
			deps: {
				fs: mockFs({}).fs,
				createSlackDiagnostic: () => ({
					probeConfiguration: async () => ({
						ok: true,
						detail: "valid",
						teamId: "foreign-workspace",
						userId: "bot",
					}),
					sendOneShotTest: async () => ({ ok: true, detail: "unused" }),
				}),
			},
		});
		expect(report.reachability).toEqual({
			probed: true,
			ok: false,
			detail: "Slack workspace identity does not match the configured workspace ID.",
		});
	});

	test("one-shot readiness and factory failures are sanitized", async () => {
		const secret = "discord-secret-value";
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.discord.enabled": true,
			"notifications.discord.botToken": secret,
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "parent",
		});
		let factoryCalled = false;
		const readiness = await sendNotificationTest({
			settings,
			provider: "discord",
			deps: {
				providerRuntimeStatus: async () => {
					throw new Error(`readiness rejected ${secret}`);
				},
				createDiscordDiagnostic: () => {
					factoryCalled = true;
					throw new Error("unused");
				},
			},
		});
		expect(readiness.detail).toBe("readiness rejected <redacted>");
		expect(factoryCalled).toBe(false);

		const factory = await sendNotificationTest({
			settings,
			provider: "discord",
			deps: {
				providerRuntimeStatus: () => "ready",
				createDiscordDiagnostic: () => {
					throw new Error(`factory rejected ${secret}`);
				},
			},
		});
		expect(factory).toMatchObject({ ok: false, adapter: "discord", uncertain: true });
		expect(factory.detail).toBe("factory rejected <redacted>");
	});

	test("Telegram treats an accepted response without a message receipt as uncertain", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
		});
		const result = await sendNotificationTest({
			settings,
			deps: {
				providerRuntimeStatus: () => "ready",
				fetchImpl: (async () =>
					new Response(JSON.stringify({ ok: true }), {
						headers: { "content-type": "application/json" },
					})) as unknown as typeof fetch,
			},
		});
		expect(result).toMatchObject({ ok: false, adapter: "telegram", uncertain: true });
		expect(result.detail).toContain("no usable message receipt");
	});
});
