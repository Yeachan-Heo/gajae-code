import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseNotifyArgs, promptForToken, runNotifyCommand } from "../src/cli/notify-cli";
import { Settings } from "../src/config/settings";
import { getNotificationConfig, maskToken } from "../src/notifications/config";
import {
	createLightweightDaemonSettings,
	loadLightweightDaemonSettings,
	ownerPidFromOwnerId,
	runDaemonInternal,
} from "../src/notifications/telegram-daemon-cli";

type FakeCall = { method: string; body: Record<string, unknown> };

function makeFetch(results: Record<string, unknown[]>): { fetchImpl: typeof fetch; calls: FakeCall[] } {
	const calls: FakeCall[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const text = String(url);
		const method = text.slice(text.lastIndexOf("/") + 1);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ method, body });
		const queue = results[method] ?? [];
		const payload =
			queue.length > 0
				? queue.shift()
				: method === "getChat"
					? { ok: true, result: { id: body.chat_id, type: "private" } }
					: { ok: true, result: [] };
		return new Response(JSON.stringify(payload), {
			status: (payload as { ok?: boolean }).ok === false ? 400 : 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchImpl, calls };
}
let captureOutputQueue: Promise<void> = Promise.resolve();
async function captureOutput(run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
	const previous = captureOutputQueue;
	let release!: () => void;
	captureOutputQueue = new Promise<void>(resolve => {
		release = resolve;
	});
	await previous;
	const originalStdout = process.stdout.write.bind(process.stdout);
	const originalStderr = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await run();
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		release();
	}
	return { stdout, stderr };
}

const token = "1234:super-secret-token";

class FakeTokenInput extends EventEmitter {
	isTTY = true;
	isRaw = false;
	resumeCalls = 0;

	setRawMode(mode: boolean): this {
		this.isRaw = mode;
		return this;
	}

	resume(): this {
		this.resumeCalls++;
		return this;
	}
}

class FakeTokenOutput {
	text = "";

	write(chunk: string | Uint8Array): boolean {
		this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}
}

describe("notify setup cli", () => {
	test("parseNotifyArgs recognizes notify subcommands", () => {
		expect(parseNotifyArgs(["shell"])).toBeUndefined();
		expect(parseNotifyArgs(["notify", "setup"])).toEqual({
			action: "setup",
			rawArgs: [],
			token: undefined,
			chatId: undefined,
			redact: false,
		});
		expect(parseNotifyArgs(["notify", "daemon-internal", "--smoke"])).toEqual({
			action: "daemon-internal",
			smoke: true,
			rawArgs: ["--smoke"],
		});
	});

	test("interactive token prompt disables echo and does not write raw token", async () => {
		const input = new FakeTokenInput();
		const output = new FakeTokenOutput();

		const prompt = promptForToken(input as unknown as NodeJS.ReadStream, output);
		expect(input.isRaw).toBe(true);
		input.emit("data", Buffer.from(token));
		input.emit("data", Buffer.from("\n"));

		await expect(prompt).resolves.toBe(token);
		expect(input.isRaw).toBe(false);
		expect(input.resumeCalls).toBe(1);
		expect(output.text).toContain("Telegram BotFather token: ");
		expect(output.text).not.toContain(token);
	});

	test("getMe ok plus private message writes settings and reads via config helper", async () => {
		const settings = Settings.isolated();
		const { fetchImpl } = makeFetch({
			getMe: [{ ok: true, result: { id: 1, username: "bot" } }],
			getUpdates: [
				{ ok: true, result: [] },
				{ ok: true, result: [{ update_id: 10, message: { chat: { id: 987654321, type: "private" } } }] },
			],
		});

		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{
					fetchImpl,
					apiBase: "https://fake.invalid",
					settings,
					setupToken: token,
					pollTimeoutMs: 50,
					pollIntervalMs: 0,
				},
			),
		);

		const cfg = getNotificationConfig(settings);
		expect(cfg.enabled).toBe(true);
		expect(cfg.botToken).toBe(token);
		expect(cfg.chatId).toBe("987654321");
		expect(stdout).toContain(maskToken(token));
		expect(stdout).not.toContain(token);
	});

	test("group supergroup and channel updates are rejected without writing settings", async () => {
		for (const type of ["group", "supergroup", "channel"]) {
			const settings = Settings.isolated();
			const { fetchImpl } = makeFetch({
				getMe: [{ ok: true, result: { id: 1 } }],
				getUpdates: [
					{ ok: true, result: [] },
					{ ok: true, result: [{ update_id: 1, message: { chat: { id: -100, type } } }] },
				],
			});

			await expect(
				captureOutput(() =>
					runNotifyCommand(
						{ action: "setup", rawArgs: [] },
						{ fetchImpl, settings, setupToken: token, pollTimeoutMs: 5, pollIntervalMs: 0 },
					),
				),
			).rejects.toThrow(`Pairing rejected ${type} chat`);
			expect(getNotificationConfig(settings).enabled).toBe(false);
			expect(getNotificationConfig(settings).botToken).toBeUndefined();
			expect(getNotificationConfig(settings).chatId).toBeUndefined();
		}
	});

	test("stale pre-existing updates are skipped by advancing offset", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({
			getMe: [{ ok: true, result: { id: 1 } }],
			getUpdates: [
				{ ok: true, result: [{ update_id: 41, message: { chat: { id: 111, type: "private" } } }] },
				{ ok: true, result: [{ update_id: 42, message: { chat: { id: 222, type: "private" } } }] },
			],
		});

		await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{ fetchImpl, settings, setupToken: token, pollTimeoutMs: 50, pollIntervalMs: 0 },
			),
		);

		expect(getNotificationConfig(settings).chatId).toBe("222");
		expect(calls.filter(call => call.method === "getUpdates")[1]?.body.offset).toBe(42);
	});

	test("setup times out deterministically when no private DM arrives", async () => {
		const settings = Settings.isolated();
		const { fetchImpl } = makeFetch({
			getMe: [{ ok: true, result: { id: 1 } }],
			getUpdates: [
				{ ok: true, result: [] },
				{ ok: true, result: [] },
				{ ok: true, result: [] },
			],
		});

		await expect(
			captureOutput(() =>
				runNotifyCommand(
					{ action: "setup", rawArgs: [] },
					{ fetchImpl, settings, setupToken: token, pollTimeoutMs: 1, pollIntervalMs: 0 },
				),
			),
		).rejects.toThrow("Timed out waiting for a private Telegram message");
		expect(getNotificationConfig(settings).enabled).toBe(false);
	});

	test("status prints masked token and never raw token", async () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": token,
			"notifications.telegram.chatId": "12345",
			"notifications.redact": true,
		});

		const { stdout } = await captureOutput(() => runNotifyCommand({ action: "status", rawArgs: [] }, { settings }));
		expect(stdout).toContain("enabled: true");
		expect(stdout).toContain(maskToken(token));
		expect(stdout).toContain("chatId: 12345");
		expect(stdout).toContain("redact: true");
		expect(stdout).not.toContain(token);
	});
});

test("non-interactive setup with --token and --chat-id verifies private chat without polling", async () => {
	const settings = Settings.isolated({});
	let getUpdatesCalls = 0;
	let getChatCalls = 0;
	const fetchImpl = (async (url: any, init?: RequestInit) => {
		const u = String(url);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		if (u.includes("/getMe"))
			return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }), {
				headers: { "content-type": "application/json" },
			});
		if (u.includes("/getChat")) {
			getChatCalls++;
			return new Response(JSON.stringify({ ok: true, result: { id: body.chat_id, type: "private" } }), {
				headers: { "content-type": "application/json" },
			});
		}
		if (u.includes("/getUpdates")) {
			getUpdatesCalls++;
			return new Response(JSON.stringify({ ok: true, result: [] }), {
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ ok: true, result: {} }), {
			headers: { "content-type": "application/json" },
		});
	}) as any;
	const cmd = parseNotifyArgs(["notify", "setup", "--token", "123:abc", "--chat-id", "999", "--redact"]);
	expect(cmd).toBeTruthy();
	await captureOutput(() => runNotifyCommand(cmd!, { settings, fetchImpl, apiBase: "https://api.telegram.org" }));
	const cfg = getNotificationConfig(settings);
	expect(cfg.enabled).toBe(true);
	expect(cfg.chatId).toBe("999");
	expect(cfg.redact).toBe(true);
	expect(cfg.botToken).toBe("123:abc");
	expect(getChatCalls).toBe(1);
	expect(getUpdatesCalls).toBe(0);
});

test("non-interactive setup rejects non-private chat ids without writing config", async () => {
	for (const type of ["group", "supergroup", "channel"]) {
		const settings = Settings.isolated({});
		const { fetchImpl, calls } = makeFetch({
			getMe: [{ ok: true, result: { id: 1, is_bot: true, has_topics_enabled: true } }],
			getChat: [{ ok: true, result: { id: -100, type } }],
		});
		const cmd = parseNotifyArgs(["notify", "setup", "--token", "123:abc", "--chat-id", "-100"]);

		await expect(
			captureOutput(() => runNotifyCommand(cmd!, { settings, fetchImpl, setupInteractive: false })),
		).rejects.toThrow(`Provided chat id -100 is a ${type} chat`);

		expect(getNotificationConfig(settings).enabled).toBe(false);
		expect(getNotificationConfig(settings).botToken).toBeUndefined();
		expect(getNotificationConfig(settings).chatId).toBeUndefined();
		expect(calls.filter(call => call.method === "getUpdates")).toHaveLength(0);
	}
});

function privateUpdates(chatId = 555111): unknown[] {
	return [
		{ ok: true, result: [] },
		{ ok: true, result: [{ update_id: 7, message: { chat: { id: chatId, type: "private" } } }] },
	];
}

function makePrompt(answers: string[]): { prompt: (message: string) => Promise<string>; asked: string[] } {
	const asked: string[] = [];
	const queue = [...answers];
	const prompt = async (message: string): Promise<string> => {
		asked.push(message);
		return queue.length > 0 ? (queue.shift() as string) : "skip";
	};
	return { prompt, asked };
}

const userOn = { id: 1, username: "bot", has_topics_enabled: true };
const userOff = { id: 1, username: "bot", has_topics_enabled: false };
const userMissing = { id: 1, username: "bot" };

describe("notify setup threaded mode verification", () => {
	test("threaded ON interactive verifies capability and pairs", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({
			getMe: [{ ok: true, result: userOn }],
			getUpdates: privateUpdates(),
		});
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{ fetchImpl, settings, setupToken: token, setupInteractive: true, pollTimeoutMs: 50, pollIntervalMs: 0 },
			),
		);
		expect(stdout).toContain("Threaded Mode capability verified");
		expect(stdout).toContain("threaded=verified");
		expect(stdout).toContain(maskToken(token));
		expect(stdout).not.toContain(token);
		expect(getNotificationConfig(settings).chatId).toBe("555111");
		expect(calls.filter(c => c.method === "getMe")).toHaveLength(1);
	});

	test("threaded ON non-interactive verifies without polling", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({ getMe: [{ ok: true, result: userOn }] });
		const cmd = parseNotifyArgs(["notify", "setup", "--token", "123:abc", "--chat-id", "999", "--redact"]);
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(cmd!, { fetchImpl, settings, setupInteractive: false }),
		);
		expect(stdout).toContain("threaded=verified");
		expect(calls.filter(c => c.method === "getUpdates")).toHaveLength(0);
		expect(getNotificationConfig(settings).enabled).toBe(true);
		expect(getNotificationConfig(settings).chatId).toBe("999");
		expect(stdout).not.toContain("123:abc");
	});

	test("missing field interactive warns unknown and proceeds", async () => {
		const settings = Settings.isolated();
		const { fetchImpl } = makeFetch({
			getMe: [{ ok: true, result: userMissing }],
			getUpdates: privateUpdates(),
		});
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{ fetchImpl, settings, setupToken: token, setupInteractive: true, pollTimeoutMs: 50, pollIntervalMs: 0 },
			),
		);
		expect(stdout).toContain("has_topics_enabled");
		expect(stdout).toContain("threaded=unknown");
		expect(getNotificationConfig(settings).enabled).toBe(true);
		expect(stdout).not.toContain(token);
	});

	test("missing field non-interactive warns unknown without polling", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({ getMe: [{ ok: true, result: userMissing }] });
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{ fetchImpl, settings, setupToken: token, setupChatId: "888", setupInteractive: false },
			),
		);
		expect(stdout).toContain("has_topics_enabled");
		expect(stdout).toContain("threaded=unknown");
		expect(calls.filter(c => c.method === "getUpdates")).toHaveLength(0);
		expect(getNotificationConfig(settings).chatId).toBe("888");
	});

	test("non-boolean has_topics_enabled is unknown, not verified", async () => {
		const settings = Settings.isolated();
		const { fetchImpl } = makeFetch({
			getMe: [{ ok: true, result: { id: 1, username: "bot", has_topics_enabled: "true" } }],
			getUpdates: privateUpdates(),
		});
		const { stdout, stderr } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{ fetchImpl, settings, setupToken: token, setupInteractive: true, pollTimeoutMs: 50, pollIntervalMs: 0 },
			),
		);
		expect(stdout).toContain("threaded=unknown");
		expect(stdout).not.toContain("threaded=verified");
		expect(getNotificationConfig(settings).enabled).toBe(true);
		expect(`${stdout}\n${stderr}`).not.toContain(token);
	});

	test("getMe missing id rejects even when has_topics_enabled is present", async () => {
		const settings = Settings.isolated();
		const { fetchImpl } = makeFetch({ getMe: [{ ok: true, result: { username: "bot", has_topics_enabled: true } }] });
		const { stdout, stderr } = await captureOutput(async () => {
			await expect(
				runNotifyCommand(
					{ action: "setup", rawArgs: [] },
					{ fetchImpl, settings, setupToken: token, setupChatId: "555", setupInteractive: false },
				),
			).rejects.toThrow("invalid Telegram response");
		});
		expect(getNotificationConfig(settings).enabled).toBe(false);
		expect(getNotificationConfig(settings).botToken).toBeUndefined();
		expect(getNotificationConfig(settings).chatId).toBeUndefined();
		expect(`${stdout}\n${stderr}`).not.toContain(token);
	});

	test("malformed getMe result rejects without writing settings", async () => {
		for (const result of [null, {}, { username: "bot" }]) {
			const settings = Settings.isolated();
			const { fetchImpl } = makeFetch({ getMe: [{ ok: true, result }] });
			await expect(
				captureOutput(() =>
					runNotifyCommand(
						{ action: "setup", rawArgs: [] },
						{ fetchImpl, settings, setupToken: token, setupInteractive: false },
					),
				),
			).rejects.toThrow("invalid Telegram response");
			expect(getNotificationConfig(settings).enabled).toBe(false);
			expect(getNotificationConfig(settings).botToken).toBeUndefined();
			expect(getNotificationConfig(settings).chatId).toBeUndefined();
		}
	});

	test("threaded OFF interactive retry then enabled verifies", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({
			getMe: [
				{ ok: true, result: userOff },
				{ ok: true, result: userOn },
			],
			getUpdates: privateUpdates(),
		});
		const { prompt } = makePrompt([""]);
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{
					fetchImpl,
					settings,
					setupToken: token,
					setupInteractive: true,
					threadedModePrompt: prompt,
					pollTimeoutMs: 50,
					pollIntervalMs: 0,
				},
			),
		);
		expect(stdout).toContain("Threaded Mode is OFF");
		expect(stdout).toContain("@BotFather");
		expect(stdout).toContain("threaded=verified");
		expect(calls.filter(c => c.method === "getMe")).toHaveLength(2);
	});

	test("threaded OFF interactive skip completes with unverified warning", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({
			getMe: [{ ok: true, result: userOff }],
			getUpdates: privateUpdates(),
		});
		const { prompt } = makePrompt(["skip"]);
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{
					fetchImpl,
					settings,
					setupToken: token,
					setupInteractive: true,
					threadedModePrompt: prompt,
					pollTimeoutMs: 50,
					pollIntervalMs: 0,
				},
			),
		);
		expect(stdout).toContain("continuing without verified");
		expect(stdout).toContain("threaded=unverified");
		expect(getNotificationConfig(settings).enabled).toBe(true);
		expect(getNotificationConfig(settings).chatId).toBe("555111");
		expect(calls.filter(c => c.method === "getMe")).toHaveLength(1);
		expect(stdout).not.toContain(token);
	});

	test("threaded OFF non-interactive warns and completes unverified", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({ getMe: [{ ok: true, result: userOff }] });
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{ fetchImpl, settings, setupToken: token, setupChatId: "777", setupInteractive: false },
			),
		);
		expect(stdout).toContain("non-interactive");
		expect(stdout).toContain("threaded=unverified");
		expect(calls.filter(c => c.method === "getUpdates")).toHaveLength(0);
		expect(getNotificationConfig(settings).chatId).toBe("777");
		expect(stdout).not.toContain(token);
	});

	test("threaded OFF interactive invalid input then skip does not re-check", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({
			getMe: [{ ok: true, result: userOff }],
			getUpdates: privateUpdates(),
		});
		const { prompt, asked } = makePrompt(["wat", "skip"]);
		const { stdout } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{
					fetchImpl,
					settings,
					setupToken: token,
					setupInteractive: true,
					threadedModePrompt: prompt,
					pollTimeoutMs: 50,
					pollIntervalMs: 0,
				},
			),
		);
		expect(stdout).toContain("Type Enter to retry or skip");
		expect(stdout).toContain("threaded=unverified");
		expect(asked).toHaveLength(2);
		expect(calls.filter(c => c.method === "getMe")).toHaveLength(1);
		expect(getNotificationConfig(settings).enabled).toBe(true);
	});

	test("threaded OFF interactive invalid inputs then retry re-checks once and verifies", async () => {
		const settings = Settings.isolated();
		const { fetchImpl, calls } = makeFetch({
			getMe: [
				{ ok: true, result: userOff },
				{ ok: true, result: userOn },
			],
			getUpdates: privateUpdates(),
		});
		const { prompt, asked } = makePrompt(["wat", "still bad", ""]);
		const { stdout, stderr } = await captureOutput(() =>
			runNotifyCommand(
				{ action: "setup", rawArgs: [] },
				{
					fetchImpl,
					settings,
					setupToken: token,
					setupInteractive: true,
					threadedModePrompt: prompt,
					pollTimeoutMs: 50,
					pollIntervalMs: 0,
				},
			),
		);
		expect(stdout.match(/Type Enter to retry or skip/g)).toHaveLength(2);
		expect(stdout).toContain("threaded=verified");
		expect(asked).toHaveLength(3);
		expect(calls.filter(c => c.method === "getMe")).toHaveLength(2);
		expect(getNotificationConfig(settings).enabled).toBe(true);
		expect(`${stdout}\n${stderr}`).not.toContain(token);
	});

	test("group rejection still holds with threaded enabled bot", async () => {
		const settings = Settings.isolated();
		const { fetchImpl } = makeFetch({
			getMe: [{ ok: true, result: userOn }],
			getUpdates: [
				{ ok: true, result: [] },
				{ ok: true, result: [{ update_id: 1, message: { chat: { id: -100, type: "supergroup" } } }] },
			],
		});
		await expect(
			captureOutput(() =>
				runNotifyCommand(
					{ action: "setup", rawArgs: [] },
					{ fetchImpl, settings, setupToken: token, setupInteractive: true, pollTimeoutMs: 5, pollIntervalMs: 0 },
				),
			),
		).rejects.toThrow("Pairing rejected supergroup chat");
		expect(getNotificationConfig(settings).enabled).toBe(false);
	});
});

describe("notify daemon-internal lightweight startup", () => {
	function tempAgentDir(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notify-daemon-agent-"));
	}

	test("lightweight daemon settings read only notification keys from config.yml", async () => {
		const agentDir = tempAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			`notifications:
  enabled: true
  telegram:
    botToken: 1234:token
    chatId: "999"
  redact: true
  verbosity: verbose
  daemon:
    idleTimeoutMs: 12345
`,
		);

		const settings = await loadLightweightDaemonSettings(agentDir);
		const cfg = getNotificationConfig(settings as Settings);
		expect(settings.getAgentDir()).toBe(agentDir);
		expect(cfg.enabled).toBe(true);
		expect(cfg.botToken).toBe("1234:token");
		expect(cfg.chatId).toBe("999");
		expect(cfg.redact).toBe(true);
		expect(cfg.verbosity).toBe("verbose");
		expect(cfg.idleTimeoutMs).toBe(12345);
	});

	test("lightweight daemon settings fall back to safe notification defaults", () => {
		const settings = createLightweightDaemonSettings({ agentDir: "/tmp/gjc-agent", rawConfig: {} });
		const cfg = getNotificationConfig(settings as Settings);
		expect(cfg.enabled).toBe(false);
		expect(cfg.botToken).toBeUndefined();
		expect(cfg.chatId).toBeUndefined();
		expect(cfg.redact).toBe(false);
		expect(cfg.verbosity).toBe("lean");
		expect(cfg.idleTimeoutMs).toBe(60_000);
	});

	test("daemon-internal exits before loading settings when owner pid is stale", async () => {
		let settingsLoaded = false;
		let daemonConstructed = false;
		const { stderr } = await captureOutput(() =>
			runDaemonInternal(["--owner-id", "12345-dead", "--agent-dir", tempAgentDir()], {
				pidAlive: () => false,
				SettingsImpl: {
					async init() {
						settingsLoaded = true;
						return createLightweightDaemonSettings({ agentDir: "/tmp/gjc-agent", rawConfig: {} });
					},
				},
				DaemonImpl: class {
					constructor() {
						daemonConstructed = true;
					}
					requestStop(): void {}
					async run(): Promise<void> {}
				} as never,
			}),
		);
		expect(stderr).toContain("owner process");
		expect(settingsLoaded).toBe(false);
		expect(daemonConstructed).toBe(false);
	});

	test("owner pid parser accepts pid-prefixed owner ids only", () => {
		expect(ownerPidFromOwnerId("12345-kabc-random")).toBe(12345);
		expect(ownerPidFromOwnerId("12345")).toBe(12345);
		expect(ownerPidFromOwnerId("owner-12345")).toBeUndefined();
		expect(ownerPidFromOwnerId("0-dead")).toBeUndefined();
	});
});
