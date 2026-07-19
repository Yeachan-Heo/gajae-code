import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import type { LifecycleControlServer, LifecycleControlServerFactory } from "../src/sdk/bus/lifecycle-control-runtime";
import {
	acquireDaemonOwnership,
	DAEMON_GENERATION,
	daemonPaths,
	readDaemonState,
	TelegramNotificationDaemon,
} from "../src/sdk/bus/telegram-daemon";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-owner-test-"));
}

function settings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

const fakeBot = { call: async () => ({ ok: true, result: [] }) } as never;

function immediateTimeout(): typeof setTimeout {
	return ((cb: () => void) => {
		cb();
		return 0;
	}) as unknown as typeof setTimeout;
}

interface ControlSpy {
	created: number;
	starts: number;
	stops: number;
	order: string[];
	tokens: string[];
	factory: LifecycleControlServerFactory;
}

function controlSpy(): ControlSpy {
	const spy: ControlSpy = {
		created: 0,
		starts: 0,
		stops: 0,
		tokens: [],
		order: [],
		factory: () => ({}) as LifecycleControlServer,
	};
	spy.factory = ({ token }) => {
		spy.created++;
		spy.tokens.push(token);
		const server: LifecycleControlServer = {
			onLifecycleRequest: () => {
				spy.order.push("register");
			},
			respond: () => {},
			start: async () => {
				spy.starts++;
				spy.order.push("start");
			},
			stop: () => {
				spy.stops++;
			},
		};
		return server;
	};
	return spy;
}

async function ownByOther(s: Settings, ownerId: string): Promise<void> {
	await acquireDaemonOwnership({
		settings: s,
		tokenFingerprint: tokenFingerprint("tok"),
		chatId: "42",
		pid: process.pid,
		randomId: () => ownerId,
	});
}

function makeDaemon(s: Settings, factory: LifecycleControlServerFactory | null): TelegramNotificationDaemon {
	let now = 0;
	return new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: fakeBot,
		idleTimeoutMs: 10,
		now: () => (now += 11),
		setTimeoutImpl: immediateTimeout(),
		createLifecycleControlServer: factory,
	});
}

describe("daemon lifecycle-control ownership (G008)", () => {
	test("owner starts exactly one control server and stops it on idle exit", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		await ownByOther(s, "owner"); // this daemon IS the owner
		const spy = controlSpy();

		await makeDaemon(s, spy.factory).run();

		expect(spy.created).toBe(1);
		expect(spy.starts).toBe(1);
		expect(spy.stops).toBe(1); // stopped in run()'s finally on idle exit
		expect(spy.tokens[0]?.length ?? 0).toBeGreaterThan(20); // high-entropy token
		// Native call-order contract: the lifecycle handler MUST be registered
		// before start(), or forwarded requests never reach the orchestrator.
		expect(spy.order).toEqual(["register", "start"]);
		expect(fs.existsSync(daemonPaths(agentDir).lock)).toBe(false); // ownership released
	});

	test("a non-owner never starts the control server", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		await ownByOther(s, "someone-else"); // a DIFFERENT owner holds ownership
		const spy = controlSpy();

		await makeDaemon(s, spy.factory).run(); // renewDaemonHeartbeat -> false, returns early

		expect(spy.created).toBe(0);
		expect(spy.starts).toBe(0);
		expect(spy.stops).toBe(0);
	});

	test("a null factory disables lifecycle control without breaking the daemon", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		await ownByOther(s, "owner");

		await expect(makeDaemon(s, null).run()).resolves.toBeUndefined();
		expect(fs.existsSync(daemonPaths(agentDir).lock)).toBe(false);
	});

	test("control token is never written to daemon state/discovery on disk", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		await ownByOther(s, "owner");
		const spy = controlSpy();

		await makeDaemon(s, spy.factory).run();

		// The generated control token must not leak into any persisted daemon file.
		const token = spy.tokens[0]!;
		const dir = daemonPaths(agentDir).dir;
		for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isFile()) {
				expect(fs.readFileSync(full, "utf8")).not.toContain(token);
			}
		}
	});
});
test("persists generation 6 for an acquired owner so a current daemon attaches without restart", async () => {
	const agentDir = tempAgentDir();
	const s = settings(agentDir);
	const acquired = await acquireDaemonOwnership({
		settings: s,
		tokenFingerprint: tokenFingerprint("tok"),
		chatId: "42",
		pid: process.pid,
		randomId: () => "generation-six-owner",
	});
	expect(acquired.acquired).toBe(true);
	expect(DAEMON_GENERATION).toBe(6);
	expect((await readDaemonState(s))?.generation).toBe(6);
});
