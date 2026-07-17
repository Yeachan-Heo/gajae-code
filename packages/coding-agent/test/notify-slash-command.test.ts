import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";
import { parseSlashCommand } from "../src/slash-commands/helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime } from "../src/slash-commands/types";

/**
 * Blocker #1: the builtin `/notify` command must NOT shadow the notifications
 * extension's session-local `on`/`off` controls (registered via
 * `api.registerCommand("notify")`). It passes those through untouched while
 * exclusively owning the config/service diagnostics (status/health/test/
 * recovery/setup), which the extension never implements.
 */

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";

function makeRuntime(): { runtime: SlashCommandRuntime; outputs: string[] } {
	const outputs: string[] = [];
	const settings = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": TOKEN,
		"notifications.telegram.chatId": "12345",
	});
	const runtime = {
		settings,
		cwd: "/tmp/gjc-notify-slash-does-not-exist",
		output: (text: string) => {
			outputs.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, outputs };
}

async function invoke(input: string): Promise<{ result: SlashCommandResult; outputs: string[] }> {
	const spec = lookupBuiltinSlashCommand("notify");
	if (!spec?.handle) throw new Error("notify builtin command or its handle is missing");
	const parsed = parseSlashCommand(input);
	if (!parsed) throw new Error(`could not parse ${input}`);
	const { runtime, outputs } = makeRuntime();
	const result = await spec.handle(parsed, runtime);
	return { result, outputs };
}

describe("/notify builtin dispatch (extension passthrough)", () => {
	test("passes `on` through to the extension without consuming it", async () => {
		const { result, outputs } = await invoke("/notify on");
		expect(result).toEqual({ prompt: "/notify on" });
		expect(outputs).toEqual([]);
	});

	test("passes `off` through to the extension without consuming it", async () => {
		const { result, outputs } = await invoke("/notify off");
		expect(result).toEqual({ prompt: "/notify off" });
		expect(outputs).toEqual([]);
	});

	test("consumes `status` in the builtin (extension never sees it)", async () => {
		const { result, outputs } = await invoke("/notify status");
		expect(result).toEqual({ consumed: true });
		expect(outputs.length).toBe(1);
		expect(outputs[0]).toContain("Notifications");
		expect(outputs[0]).not.toContain(TOKEN);
	});

	test("bare `/notify` defaults to the builtin status (not a passthrough)", async () => {
		const { result, outputs } = await invoke("/notify");
		expect(result).toEqual({ consumed: true });
		expect(outputs.length).toBe(1);
	});

	test("rejects an unknown verb with a usage listing on|off", async () => {
		const { result, outputs } = await invoke("/notify bogus");
		expect(result).toEqual({ consumed: true });
		expect(outputs[0]).toContain("on|off");
	});

	test("advertises on/off/health among its subcommands for discoverability", () => {
		const spec = lookupBuiltinSlashCommand("notify");
		const names = (spec?.subcommands ?? []).map(s => s.name);
		expect(names).toContain("on");
		expect(names).toContain("off");
		expect(names).toContain("health");
	});
});
