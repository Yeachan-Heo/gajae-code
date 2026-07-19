import { describe, expect, test } from "bun:test";
import { parseNotifyArgs, runNotifyCommand } from "../src/cli/notify-cli";
import { Settings } from "../src/config/settings";
import {
	parseInThreadConfigCommand,
	parseRichToggleCommand,
	parseTelegramControlCommand,
	parseToolActivityToggleCommand,
} from "../src/sdk/bus/config-commands";

describe("parseInThreadConfigCommand", () => {
	test("/verbose and /lean toggle verbosity", () => {
		expect(parseInThreadConfigCommand("/verbose")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/lean")).toEqual({ verbosity: "lean" });
	});

	test("/verbosity <arg> sets verbosity, rejects bad args", () => {
		expect(parseInThreadConfigCommand("/verbosity verbose")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/verbosity lean")).toEqual({ verbosity: "lean" });
		expect(parseInThreadConfigCommand("/verbosity loud")).toBeUndefined();
	});

	test("/redact on|off|true|false|1|0 toggles redaction", () => {
		expect(parseInThreadConfigCommand("/redact on")).toEqual({ redact: true });
		expect(parseInThreadConfigCommand("/redact off")).toEqual({ redact: false });
		expect(parseInThreadConfigCommand("/redact true")).toEqual({ redact: true });
		expect(parseInThreadConfigCommand("/redact 0")).toEqual({ redact: false });
		expect(parseInThreadConfigCommand("/redact maybe")).toBeUndefined();
	});

	test("non-commands and free text return undefined (treated as injection)", () => {
		expect(parseInThreadConfigCommand("keep going")).toBeUndefined();
		expect(parseInThreadConfigCommand("/answer s1 yes")).toBeUndefined();
		expect(parseInThreadConfigCommand("/unknown")).toBeUndefined();
		expect(parseInThreadConfigCommand("")).toBeUndefined();
	});

	test("is case-insensitive and tolerant of extra whitespace", () => {
		expect(parseInThreadConfigCommand("  /VERBOSE  ")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/Redact   ON")).toEqual({ redact: true });
	});
});

describe("parseRichToggleCommand", () => {
	test("/rich on|true|1 -> true", () => {
		expect(parseRichToggleCommand("/rich on")).toBe(true);
		expect(parseRichToggleCommand("/rich true")).toBe(true);
		expect(parseRichToggleCommand("/rich 1")).toBe(true);
	});

	test("/rich off|false|0 -> false", () => {
		expect(parseRichToggleCommand("/rich off")).toBe(false);
		expect(parseRichToggleCommand("/rich false")).toBe(false);
		expect(parseRichToggleCommand("/rich 0")).toBe(false);
	});

	test("case-insensitive and whitespace-tolerant", () => {
		expect(parseRichToggleCommand("  /RICH   On ")).toBe(true);
		expect(parseRichToggleCommand("/Rich OFF")).toBe(false);
	});

	test("accepts the /rich@botname group form", () => {
		expect(parseRichToggleCommand("/rich@GajaeCodeBot off")).toBe(false);
		expect(parseRichToggleCommand("/rich@GajaeCodeBot on")).toBe(true);
		expect(parseRichToggleCommand("/RICH@GajaeCodeBot ON")).toBe(true);
	});

	test("missing/invalid arg and non-rich commands -> undefined", () => {
		expect(parseRichToggleCommand("/rich")).toBeUndefined();
		expect(parseRichToggleCommand("/rich maybe")).toBeUndefined();
		expect(parseRichToggleCommand("/richfoo on")).toBeUndefined();
		expect(parseRichToggleCommand("/verbose")).toBeUndefined();
		expect(parseRichToggleCommand("rich on")).toBeUndefined();
		expect(parseRichToggleCommand("")).toBeUndefined();
	});
});

describe("parseToolActivityToggleCommand", () => {
	test("parses on/off aliases and bot suffixes", () => {
		expect(parseToolActivityToggleCommand("/tools on")).toBe(true);
		expect(parseToolActivityToggleCommand("/tools true")).toBe(true);
		expect(parseToolActivityToggleCommand("/tools 1")).toBe(true);
		expect(parseToolActivityToggleCommand("/tools off")).toBe(false);
		expect(parseToolActivityToggleCommand("/tools false")).toBe(false);
		expect(parseToolActivityToggleCommand("/tools 0")).toBe(false);
		expect(parseToolActivityToggleCommand("/TOOLS@GajaeCodeBot OFF")).toBe(false);
	});

	test("rejects missing, invalid, and unrelated commands", () => {
		expect(parseToolActivityToggleCommand("/tools")).toBeUndefined();
		expect(parseToolActivityToggleCommand("/tools maybe")).toBeUndefined();
		expect(parseToolActivityToggleCommand("/tool off")).toBeUndefined();
		expect(parseToolActivityToggleCommand("tools off")).toBeUndefined();
	});
});

describe("parseTelegramControlCommand", () => {
	test("parses command roots and bot suffixes", () => {
		expect(parseTelegramControlCommand("/context@GajaeCodeBot", "GajaeCodeBot")).toEqual({
			kind: "command",
			command: { name: "context" },
		});
		expect(parseTelegramControlCommand("/usage", "GajaeCodeBot")).toEqual({
			kind: "command",
			command: { name: "usage" },
		});
		expect(parseTelegramControlCommand("/compact keep architecture notes", "GajaeCodeBot")).toEqual({
			kind: "command",
			command: { name: "compact", instructions: "keep architecture notes" },
		});
	});

	test("parses reasoning status, cycle, and levels", () => {
		expect(parseTelegramControlCommand("/reasoning")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "status" },
		});
		expect(parseTelegramControlCommand("/reasoning cycle")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "cycle" },
		});
		expect(parseTelegramControlCommand("/reasoning HIGH")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "set", level: "high" },
		});
	});

	test("normalizes reasoning aliases and accepts global set and display mutations", () => {
		expect(parseTelegramControlCommand("/reasoning NONE --global")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "set", level: "off", global: true },
		});
		expect(parseTelegramControlCommand("/reasoning reset --global")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "set", level: "inherit", global: true },
		});
		expect(parseTelegramControlCommand("/reasoning show")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "show" },
		});
		expect(parseTelegramControlCommand("/reasoning hide --global")).toEqual({
			kind: "command",
			command: { name: "reasoning", action: "hide", global: true },
		});
	});

	test("parses model lists and exact model selectors", () => {
		expect(parseTelegramControlCommand("/model")).toEqual({
			kind: "command",
			command: { name: "model", action: "list" },
		});
		expect(parseTelegramControlCommand("/model OpenAI/GPT-5")).toEqual({
			kind: "command",
			command: { name: "model", action: "set", selector: "OpenAI/GPT-5" },
		});
	});

	test("recognized invalid forms fail closed", () => {
		expect(parseTelegramControlCommand("/usage now")).toMatchObject({ kind: "invalid", commandName: "usage" });
		expect(parseTelegramControlCommand("/context extra")).toMatchObject({ kind: "invalid", commandName: "context" });
		expect(parseTelegramControlCommand("/reasoning enormous")).toMatchObject({
			kind: "invalid",
			commandName: "reasoning",
		});
		for (const text of [
			"/reasoning cycle --global",
			"/reasoning --global high",
			"/reasoning show later",
			"/reasoning high --global extra",
			"/model provider/model extra",
		]) {
			expect(parseTelegramControlCommand(text)).toMatchObject({ kind: "invalid" });
		}
	});

	test("unknown commands and wrong bot suffix fall through", () => {
		expect(parseTelegramControlCommand("/unknown")).toEqual({ kind: "none" });
		expect(parseTelegramControlCommand("/btw why is this happening?")).toEqual({ kind: "none" });
		expect(parseTelegramControlCommand("/context@OtherBot", "GajaeCodeBot")).toEqual({
			kind: "ignored",
			commandName: "context",
		});
		expect(parseTelegramControlCommand("/context@OtherBot")).toEqual({ kind: "ignored", commandName: "context" });
		expect(parseTelegramControlCommand("plain text")).toEqual({ kind: "none" });
	});
});

describe("notify Discord and Slack setup", () => {
	test("parses provider-specific setup flags while bare setup remains Telegram", () => {
		expect(parseNotifyArgs(["notify", "setup"])?.provider).toBeUndefined();
		expect(
			parseNotifyArgs([
				"notify",
				"setup",
				"discord",
				"--discord-bot-token",
				"discord-secret",
				"--discord-application-id",
				"app",
				"--discord-guild-id",
				"guild",
				"--discord-parent-channel-id",
				"parent",
			]),
		).toMatchObject({ provider: "discord", discordBotToken: "discord-secret", discordApplicationId: "app" });
	});

	test("saves complete providers, preserves unrelated settings, rejects partial config, and masks status tokens", async () => {
		const settings = Settings.isolated({ "modelProfile.default": "preserve" });
		const discordToken = "discord-secret-token";
		await runNotifyCommand(
			{
				action: "setup",
				rawArgs: ["discord"],
				provider: "discord",
				discordBotToken: discordToken,
				discordApplicationId: "app",
				discordGuildId: "guild",
				discordParentChannelId: "parent",
			},
			{
				settings,
				ensureProviderDaemon: async provider => {
					expect(provider).toBe("discord");
					return "owner_spawned";
				},
			},
		);
		expect(settings.get("notifications.discord.botToken")).toBe(discordToken);
		expect(settings.get("notifications.enabled")).toBe(true);
		expect(settings.get("modelProfile.default")).toBe("preserve");

		const slackBotToken = "xoxb-slack-secret-token";
		const slackAppToken = "xapp-slack-app-secret-token";
		const setupWrites: string[] = [];
		const originalSetupWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			setupWrites.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			await runNotifyCommand(
				{
					action: "setup",
					rawArgs: ["slack"],
					provider: "slack",
					slackBotToken,
					slackAppToken,
					slackWorkspaceId: "workspace",
					slackChannelId: "channel",
				},
				{
					settings,
					ensureProviderDaemon: async provider => {
						expect(provider).toBe("slack");
						return "owner_spawned";
					},
				},
			);
		} finally {
			process.stdout.write = originalSetupWrite;
		}
		expect(settings.get("notifications.slack.botToken")).toBe(slackBotToken);
		expect(settings.get("notifications.slack.authorizedUserId")).toBeUndefined();
		expect(setupWrites.join("")).toContain("authorizedUserId=(unset; inbound denied)");
		expect(setupWrites.join("")).toContain("daemon=owner_spawned");
		expect(setupWrites.join("")).not.toContain(slackBotToken);
		expect(setupWrites.join("")).not.toContain(slackAppToken);

		const partialSettings = Settings.isolated({ "modelProfile.default": "preserve" });
		await expect(
			runNotifyCommand(
				{ action: "setup", rawArgs: ["slack"], provider: "slack", slackBotToken: "bot" },
				{ settings: partialSettings },
			),
		).rejects.toThrow("--slack-app-token is required");
		expect(partialSettings.get("notifications.slack.botToken")).toBeUndefined();

		const writes: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			await runNotifyCommand({ action: "status", rawArgs: [] }, { settings });
		} finally {
			process.stdout.write = originalWrite;
		}
		expect(writes.join("")).toContain("discord.botToken: disc…(len 20)");
		expect(writes.join("")).not.toContain(discordToken);
	});
});
