import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertStrictActivateThreadInvocation,
	assertStrictBindThreadInvocation,
	type NotifyCommandArgs,
	parseNotifyArgs,
	runNotifyCommand,
} from "../src/cli/notify-cli";
import { Settings } from "../src/config/settings";

const ROOT_TS = "1785573662.132329";

/** Settings bound to a temp agent directory: the suite never resolves the real one. */
async function isolatedSettings(): Promise<{ settings: Settings; cleanup: () => Promise<void> }> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-notify-thread-"));
	const base = Settings.isolated({});
	const settings = new Proxy(base, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
	return { settings, cleanup: async () => await fs.rm(agentDir, { recursive: true, force: true }) };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
	let output = "";
	const spy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		output += String(chunk);
		return true;
	});
	try {
		await run();
	} finally {
		spy.mockRestore();
	}
	return output;
}

describe("notify bind-thread / activate-thread grammar", () => {
	test("the exact flag pair parses and anything else is rejected", () => {
		expect(parseNotifyArgs(["notify", "bind-thread", "--session-id", "s1", "--thread-ts", ROOT_TS])).toMatchObject({
			action: "bind-thread",
			sessionId: "s1",
			threadTs: ROOT_TS,
		});
		expect(parseNotifyArgs(["notify", "activate-thread", "--session-id", "s1"])).toMatchObject({
			action: "activate-thread",
			sessionId: "s1",
		});
		for (const argv of [
			["notify", "bind-thread"],
			["notify", "bind-thread", "--session-id", "s1"],
			["notify", "bind-thread", "--thread-ts", ROOT_TS],
			["notify", "bind-thread", "--session-id", "s1", "--thread-ts", ROOT_TS, "--redact"],
			["notify", "bind-thread", "s1", ROOT_TS],
			["notify", "activate-thread"],
			["notify", "activate-thread", "--session-id", "s1", "--thread-ts", ROOT_TS],
			["notify", "activate-thread", "s1"],
		])
			expect(parseNotifyArgs(argv)).toBeUndefined();
	});

	test("target and credential inputs are rejected rather than silently ignored", () => {
		const base: NotifyCommandArgs = {
			action: "bind-thread",
			rawArgs: ["--session-id", "s1", "--thread-ts", ROOT_TS],
			sessionId: "s1",
			threadTs: ROOT_TS,
		};
		expect(assertStrictBindThreadInvocation(base)).toEqual({ sessionId: "s1", threadTs: ROOT_TS });
		expect(() => assertStrictBindThreadInvocation({ ...base, slackChannelId: "C9" })).toThrow(/slackChannelId/);
		expect(() => assertStrictBindThreadInvocation({ ...base, provider: "slack" })).toThrow(/provider/);
		expect(() => assertStrictBindThreadInvocation({ ...base, rawArgs: [...base.rawArgs, "extra"] })).toThrow(
			/additional arguments/,
		);
		expect(() => assertStrictBindThreadInvocation({ ...base, threadTs: "nope", rawArgs: [] })).toThrow(
			/bounded <seconds>\.<fraction>/,
		);
	});

	test("activation names one session and nothing else", () => {
		const base: NotifyCommandArgs = { action: "activate-thread", rawArgs: ["--session-id", "s1"], sessionId: "s1" };
		expect(assertStrictActivateThreadInvocation(base)).toEqual({ sessionId: "s1" });
		expect(() => assertStrictActivateThreadInvocation({ ...base, threadTs: ROOT_TS })).toThrow(/threadTs/);
		expect(() => assertStrictActivateThreadInvocation({ ...base, message: "hi" })).toThrow(/message/);
		expect(() => assertStrictActivateThreadInvocation({ action: "activate-thread", rawArgs: [] })).toThrow(
			/requires --session-id/,
		);
	});

	test("a confirmed binding prints identifiers only", async () => {
		const { settings, cleanup } = await isolatedSettings();
		try {
			const calls: Array<{ sessionId: string; threadTs: string }> = [];
			const output = await captureStdout(async () => {
				await runNotifyCommand(
					{
						action: "bind-thread",
						rawArgs: ["--session-id", "s1", "--thread-ts", ROOT_TS],
						sessionId: "s1",
						threadTs: ROOT_TS,
					},
					{
						settings,
						bindSlackThread: async input => {
							calls.push({ sessionId: input.sessionId, threadTs: input.threadTs });
							return {
								sessionId: input.sessionId,
								endpointGeneration: 3,
								teamId: "T1",
								channelId: "C1",
								rootTs: input.threadTs,
								ownerId: "slack-owner-1",
								daemonGeneration: 25,
							};
						},
					},
				);
			});
			expect(calls).toEqual([{ sessionId: "s1", threadTs: ROOT_TS }]);
			expect(output).toContain("s1");
			expect(output).toContain(ROOT_TS);
			expect(output).toContain("T1/C1");
			expect(output).not.toContain("xoxb-");
			expect(output).not.toContain("token");
		} finally {
			await cleanup();
		}
	});

	test("activation prints the settled status and session generation only", async () => {
		const { settings, cleanup } = await isolatedSettings();
		try {
			const output = await captureStdout(async () => {
				await runNotifyCommand(
					{ action: "activate-thread", rawArgs: ["--session-id", "s1"], sessionId: "s1" },
					{
						settings,
						activatePreparedSession: async input => ({
							sessionId: input.sessionId,
							endpointGeneration: 3,
							status: "already",
						}),
					},
				);
			});
			expect(output).toContain("s1");
			expect(output).toContain("already");
			expect(output).toContain("3");
			expect(output).not.toContain("ws://");
		} finally {
			await cleanup();
		}
	});
});
