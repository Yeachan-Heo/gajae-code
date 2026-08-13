/**
 * Fail-closed chat-daemon isolation (regression for "the Telegram daemon
 * blocks ACP session opens entirely").
 *
 * The chat daemons are optional notification adapters, never session
 * authority. Session startup must publish the core SDK endpoint without
 * acquiring, awaiting, or verifying any daemon ownership:
 * - a WEDGED daemon (ensure that never settles) must not delay endpoint
 *   publication, and
 * - a BLOCKED daemon identity must degrade notification delivery only,
 *   never fail session startup (previously it hard-failed lifecycle
 *   startup with "Telegram daemon ownership is blocked").
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getNotificationConfig } from "../src/sdk/bus/config";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { NotificationSessionController } from "../src/sdk/bus/session-control";
import {
	cleanupFixtureRoot,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";
type Handler = (event: unknown, ctx: unknown) => unknown;

const cleanups: FixtureRootCleanup[] = [];
let restoreEnv: (() => void) | undefined;
afterEach(async () => {
	restoreEnv?.();
	restoreEnv = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanupFixtureRoot(cleanup);
});

function enableNotificationsEnv(): void {
	const prev = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	restoreEnv = () => {
		if (prev === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prev;
	};
}

async function createIsolationHarness(input: {
	prefix: string;
	ensureTelegramDaemon?: (input: {
		settings: unknown;
	}) => Promise<"owner_spawned" | "attached" | "disabled" | "blocked">;
	ensureProviderDaemon?: (provider: "discord" | "slack", settings: unknown) => Promise<unknown>;
	settingsOverrides?: Record<string, unknown>;
}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), input.prefix));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanups.push(cleanup);
	const settings = isolatedNotificationSettings(
		agentDir,
		input.settingsOverrides ?? {
			"notifications.enabled": true,
			"notifications.telegram.botToken": TOKEN,
			"notifications.telegram.chatId": "12345",
		},
	);
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: async () => {},
	} as never;
	const controller = new NotificationSessionController({
		eligible: true,
		getConfig: () => getNotificationConfig(settings),
	});
	createNotificationsExtension(api, {
		settings,
		controller,
		...(input.ensureTelegramDaemon ? { ensureTelegramDaemon: input.ensureTelegramDaemon as never } : {}),
		...(input.ensureProviderDaemon ? { ensureProviderDaemon: input.ensureProviderDaemon as never } : {}),
	});
	const sid = `${input.prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Isolation",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;
	registerNotificationRuntime(cleanup, {
		key: "daemon-isolation-session",
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		},
	});
	return {
		handlers,
		ctx,
		settings,
		controller,
		endpoint: path.join(cwd, ".gjc", "state", "sdk", `${sid}.json`),
	};
}

test("an awaited session_start settles while the telegram daemon ensure stays wedged", async () => {
	enableNotificationsEnv();
	let ensureCalls = 0;
	// A daemon whose lock recovery is wedged: this ensure NEVER settles, for the
	// whole lifetime of the test. Nothing on a session-lifecycle path may await
	// it — not publication, not the awaited handler, not shutdown.
	const wedge = Promise.withResolvers<"attached">();
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-wedge-",
		ensureTelegramDaemon: () => {
			ensureCalls += 1;
			return wedge.promise;
		},
	});

	// The handler is AWAITED here, exactly as the lifecycle command awaits it.
	const started = await Promise.race([
		Promise.resolve(harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx)).then(
			() => "settled" as const,
			() => "settled" as const,
		),
		Bun.sleep(15_000).then(() => "hung" as const),
	]);
	expect(started).toBe("settled");
	expect(fs.existsSync(harness.endpoint)).toBe(true);
	expect(ensureCalls).toBeGreaterThan(0);

	// Shutdown must not join the detached ownership ensure either.
	const shutdown = await Promise.race([
		Promise.resolve(harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx)).then(
			() => "settled" as const,
			() => "settled" as const,
		),
		Bun.sleep(15_000).then(() => "hung" as const),
	]);
	expect(shutdown).toBe("settled");
	// The wedge is still unresolved: nothing ever waited on it.
	wedge.resolve("attached");
}, 60_000);

test("a blocked telegram daemon identity degrades delivery only, never session startup", async () => {
	enableNotificationsEnv();
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-blocked-",
		ensureTelegramDaemon: async () => "blocked",
	});
	// Previously this hard-failed lifecycle startup pre-publication with
	// "Telegram daemon ownership is blocked."; the handler must now settle
	// cleanly with the endpoint published.
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	expect(fs.existsSync(harness.endpoint)).toBe(true);
});

test("a same-length credential rotation re-proves ownership instead of reusing the settled outcome", async () => {
	enableNotificationsEnv();
	// Keying a secret by length (or omitting it) would let a rotation reuse a
	// stale "ready" and authorize adapters for an unproved configuration.
	const rotated = `9876543210:${"Z".repeat(TOKEN.length - "9876543210:".length)}`;
	expect(rotated).toHaveLength(TOKEN.length);
	let ensureCalls = 0;
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-rotate-",
		ensureTelegramDaemon: async () => {
			ensureCalls += 1;
			return "attached";
		},
	});
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	const deadline = Date.now() + 8_000;
	while (ensureCalls < 1 && Date.now() < deadline) await Bun.sleep(25);
	const afterStart = ensureCalls;
	expect(afterStart).toBeGreaterThanOrEqual(1);

	// Same-length rotation: a fresh ensure MUST run.
	harness.settings.set("notifications.telegram.botToken", rotated);
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	const rotateDeadline = Date.now() + 8_000;
	while (ensureCalls <= afterStart && Date.now() < rotateDeadline) await Bun.sleep(25);
	expect(ensureCalls).toBeGreaterThan(afterStart);
}, 60_000);

test("a delivery-only change reuses the settled ownership outcome instead of re-ensuring", async () => {
	enableNotificationsEnv();
	let ensureCalls = 0;
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-delivery-only-",
		ensureTelegramDaemon: async () => {
			ensureCalls += 1;
			return "attached";
		},
	});
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	const deadline = Date.now() + 8_000;
	while (ensureCalls < 1 && Date.now() < deadline) await Bun.sleep(25);
	const settledCalls = ensureCalls;

	// Redaction/verbosity are delivery policy, not ownership identity.
	harness.settings.set("notifications.redact", true);
	harness.settings.set("notifications.verbosity", "verbose");
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	await Bun.sleep(200);
	expect(ensureCalls).toBe(settledCalls);
}, 60_000);

test("an ownership-identity change withholds active adapters until the new configuration is proved", async () => {
	enableNotificationsEnv();
	// Delivery must never continue under a configuration ownership has not
	// proved: on an ownership-identity change the runtime is demoted and its
	// adapters are torn down BEFORE the new ensure starts, then restored only
	// after that ensure settles ready.
	let defer = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-reproof-",
		ensureTelegramDaemon: async () => {
			if (!defer) return "attached";
			entered.resolve();
			await release.promise;
			return "attached";
		},
	});
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	const readyDeadline = Date.now() + 8_000;
	while (!harness.controller.query(harness.ctx).running && Date.now() < readyDeadline) await Bun.sleep(25);
	expect(harness.controller.query(harness.ctx).running).toBe(true);

	// Rotate the destination: ownership identity changes.
	defer = true;
	harness.settings.set("notifications.telegram.chatId", "99999");
	const settled = await Promise.race([
		harness.controller.reconcileCurrentSession(harness.ctx).then(() => "settled" as const),
		Bun.sleep(8_000).then(() => "hung" as const),
	]);
	// Reconciliation still must not block on the daemon...
	expect(settled).toBe("settled");
	await Promise.race([
		entered.promise,
		Bun.sleep(5_000).then(() => {
			throw new Error("re-proof ensure was not entered");
		}),
	]);
	// ...and delivery is withheld while the new configuration is unproved.
	expect(harness.controller.query(harness.ctx).running).toBe(false);

	// Once the new configuration is proved, adapters come back.
	release.resolve();
	const restoreDeadline = Date.now() + 8_000;
	while (!harness.controller.query(harness.ctx).running && Date.now() < restoreDeadline) await Bun.sleep(25);
	expect(harness.controller.query(harness.ctx).running).toBe(true);
}, 60_000);

/**
 * Ownership identity is provider-neutral. A Discord-only or Slack-only
 * configuration has no Telegram preflight at all, so a credential, destination,
 * or actor-authorization rotation there must still withhold adapters until the
 * new identity is proved — otherwise the previous identity keeps delivery and,
 * for Slack, inbound command authority.
 */
for (const scenario of [
	{
		name: "a Discord-only credential rotation",
		prefix: "gjc-daemon-discord-rotate-",
		overrides: {
			"notifications.enabled": true,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "parent",
		},
		rotate: "notifications.discord.botToken",
		rotated: "discord-token-rotated",
	},
	{
		name: "a Slack-only credential rotation",
		prefix: "gjc-daemon-slack-rotate-",
		overrides: {
			"notifications.enabled": true,
			"notifications.slack.botToken": "slack-bot-token",
			"notifications.slack.appToken": "slack-app-token",
			"notifications.slack.workspaceId": "workspace",
			"notifications.slack.channelId": "channel",
		},
		rotate: "notifications.slack.botToken",
		rotated: "slack-bot-token-rotated",
	},
	{
		name: "a Slack authorized-actor rotation",
		prefix: "gjc-daemon-slack-actor-",
		overrides: {
			"notifications.enabled": true,
			"notifications.slack.botToken": "slack-bot-token",
			"notifications.slack.appToken": "slack-app-token",
			"notifications.slack.workspaceId": "workspace",
			"notifications.slack.channelId": "channel",
			"notifications.slack.authorizedUserId": "U-original",
		},
		rotate: "notifications.slack.authorizedUserId",
		rotated: "U-rotated",
	},
] as const) {
	test(`${scenario.name} re-proves ownership without a Telegram preflight`, async () => {
		enableNotificationsEnv();
		let ensureCalls = 0;
		const harness = await createIsolationHarness({
			prefix: scenario.prefix,
			settingsOverrides: { ...scenario.overrides },
			ensureProviderDaemon: async () => {
				ensureCalls += 1;
				return "attached";
			},
		});
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		const deadline = Date.now() + 8_000;
		while (ensureCalls < 1 && Date.now() < deadline) await Bun.sleep(25);
		const afterStart = ensureCalls;
		expect(afterStart).toBeGreaterThanOrEqual(1);

		harness.settings.set(scenario.rotate, scenario.rotated);
		await harness.controller.reconcileCurrentSession(harness.ctx);
		const rotateDeadline = Date.now() + 8_000;
		while (ensureCalls <= afterStart && Date.now() < rotateDeadline) await Bun.sleep(25);
		expect(ensureCalls).toBeGreaterThan(afterStart);
	}, 60_000);
}

test("a redaction transition re-proves ownership when a chat daemon is effective", async () => {
	enableNotificationsEnv();
	// Discord/Slack daemons snapshot redaction into their presentation engine at
	// construction and carry it in their durable identity, so a false->true
	// transition must re-prove ownership; otherwise a live presenter keeps
	// rendering unredacted payloads.
	let ensureCalls = 0;
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-redact-chat-",
		settingsOverrides: {
			"notifications.enabled": true,
			"notifications.redact": false,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "parent",
		},
		ensureProviderDaemon: async () => {
			ensureCalls += 1;
			return "attached";
		},
	});
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	const deadline = Date.now() + 8_000;
	while (ensureCalls < 1 && Date.now() < deadline) await Bun.sleep(25);
	const afterStart = ensureCalls;
	expect(afterStart).toBeGreaterThanOrEqual(1);

	harness.settings.set("notifications.redact", true);
	await harness.controller.reconcileCurrentSession(harness.ctx);
	const rotateDeadline = Date.now() + 8_000;
	while (ensureCalls <= afterStart && Date.now() < rotateDeadline) await Bun.sleep(25);
	expect(ensureCalls).toBeGreaterThan(afterStart);
}, 60_000);

test("a telegram-only redaction change is applied in-process without re-proving ownership", async () => {
	enableNotificationsEnv();
	// Telegram applies redaction through the in-process presentation policy, so
	// keying it would churn ownership (and briefly withhold adapters) for the
	// most common configuration with nothing to re-prove.
	let ensureCalls = 0;
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-redact-tg-",
		ensureTelegramDaemon: async () => {
			ensureCalls += 1;
			return "attached";
		},
	});
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	const deadline = Date.now() + 8_000;
	while (ensureCalls < 1 && Date.now() < deadline) await Bun.sleep(25);
	const afterStart = ensureCalls;

	harness.settings.set("notifications.redact", true);
	await harness.controller.reconcileCurrentSession(harness.ctx);
	await Bun.sleep(200);
	expect(ensureCalls).toBe(afterStart);
}, 60_000);
