import { describe, expect, test } from "bun:test";
import { parseNotifyArgs, runNotifyCommand } from "../src/cli/notify-cli";
import { Settings } from "../src/config/settings";
import { getNotificationConfig, maskToken } from "../src/notifications/config";

type FakeCall = { method: string; body: Record<string, unknown> };

function makeFetch(results: Record<string, unknown[]>): { fetchImpl: typeof fetch; calls: FakeCall[] } {
	const calls: FakeCall[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const text = String(url);
		const method = text.slice(text.lastIndexOf("/") + 1);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ method, body });
		const queue = results[method] ?? [];
		const payload = queue.length > 0 ? queue.shift() : { ok: true, result: [] };
		return new Response(JSON.stringify(payload), {
			status: (payload as { ok?: boolean }).ok === false ? 400 : 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchImpl, calls };
}

async function captureOutput(run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
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
	}
	return { stdout, stderr };
}

const token = "1234:super-secret-token";

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

test("non-interactive setup with --token and --chat-id writes config without polling", async () => {
	const settings = Settings.isolated({});
	let getUpdatesCalls = 0;
	const fetchImpl = (async (url: any) => {
		const u = String(url);
		if (u.includes("/getMe"))
			return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }), {
				headers: { "content-type": "application/json" },
			});
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
	await runNotifyCommand(cmd!, { settings, fetchImpl, apiBase: "https://api.telegram.org" });
	const cfg = getNotificationConfig(settings);
	expect(cfg.enabled).toBe(true);
	expect(cfg.chatId).toBe("999");
	expect(cfg.redact).toBe(true);
	expect(cfg.botToken).toBe("123:abc");
	expect(getUpdatesCalls).toBe(0);
});
