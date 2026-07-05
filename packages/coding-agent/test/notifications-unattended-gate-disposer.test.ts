import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension } from "../src/notifications/index";

/**
 * Regression for unattended workflow-gate listener leaks: notifications register
 * `workflowGate.onGateEmitted()` so real unattended asks can be answered from
 * Telegram, but the returned disposer must be retained and called when the
 * notification session stops. Otherwise `/notify off`, `session_shutdown`, or a
 * resume restart leaves a stale listener closing over a stopped
 * NotificationServer and future gates try to register duplicate/stale asks.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;
type GateListener = (gate: {
	gate_id: string;
	options?: Array<{ label?: string }>;
	context?: { prompt?: string; title?: string };
}) => void;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function withNotifications<T>(fn: () => Promise<T>): Promise<T> {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		return await fn();
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}

function createGateHarness() {
	const handlers = new Map<string, Handler>();
	const listeners = new Set<GateListener>();
	let disposeCalls = 0;
	const workflowGate = {
		isUnattended: () => true,
		onGateEmitted(listener: GateListener): () => void {
			listeners.add(listener);
			return () => {
				disposeCalls += 1;
				listeners.delete(listener);
			};
		},
		resolveGate: async () => ({ ok: true }),
	};
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-gate-disposer-"));
	tempDirs.push(cwd);
	const sid = `gate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		workflowGate,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Unattended",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;
	return {
		handlers,
		ctx,
		listeners,
		get disposeCalls() {
			return disposeCalls;
		},
	};
}

test("unattended workflow-gate listener is disposed when notifications stop", async () => {
	await withNotifications(async () => {
		const harness = createGateHarness();

		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		expect(harness.listeners.size).toBe(1);

		await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);

		expect(harness.listeners.size).toBe(0);
		expect(harness.disposeCalls).toBe(1);
	});
});
