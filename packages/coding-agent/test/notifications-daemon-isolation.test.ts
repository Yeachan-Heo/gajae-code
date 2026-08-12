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
import { createNotificationsExtension } from "../src/sdk/bus/index";
import {
	cleanupFixtureRoot,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, ms = 8_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${label}`);
}

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
	ensureTelegramDaemon: (input: {
		settings: unknown;
	}) => Promise<"owner_spawned" | "attached" | "disabled" | "blocked">;
}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), input.prefix));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanups.push(cleanup);
	const settings = isolatedNotificationSettings(agentDir, {
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: async () => {},
	} as never;
	createNotificationsExtension(api, {
		settings,
		ensureTelegramDaemon: input.ensureTelegramDaemon as never,
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
		endpoint: path.join(cwd, ".gjc", "state", "sdk", `${sid}.json`),
	};
}

test("a wedged telegram daemon never delays SDK endpoint publication", async () => {
	enableNotificationsEnv();
	let ensureCalls = 0;
	const wedge = Promise.withResolvers<"attached">();
	const harness = await createIsolationHarness({
		prefix: "gjc-daemon-wedge-",
		ensureTelegramDaemon: () => {
			ensureCalls += 1;
			// Simulates a daemon whose lock recovery is wedged: the ensure call
			// never settles for the lifetime of the assertion window.
			return wedge.promise;
		},
	});
	// Fire session_start WITHOUT awaiting it: the handler's post-start
	// reconcile legitimately waits on daemon ensure, but core publication
	// (what broker session.new consumes) must not.
	const startTask = Promise.resolve(
		harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx),
	).catch(() => {});
	await waitFor(() => fs.existsSync(harness.endpoint), 8_000, "endpoint publication under a wedged daemon");
	expect(ensureCalls).toBeGreaterThan(0);
	// Release the wedge so shutdown can join the tracked lifecycle tasks.
	wedge.resolve("attached");
	await startTask;
});

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
