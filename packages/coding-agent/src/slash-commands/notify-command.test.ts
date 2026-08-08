import { describe, expect, test } from "bun:test";
import { lookupBuiltinSlashCommand } from "./builtin-registry";

/**
 * Contract: /notify on|off is session-local and extension-owned.
 * The builtin must always pass the raw command text through as a prompt so it
 * cannot shadow the live per-session `api.registerCommand("notify")` control —
 * whether or not a lazy/native command is currently installed in the fixture.
 * See builtin-registry.ts notify handler comments.
 */
function runtimeWithExtension(commandInstalled: boolean) {
	const output: string[] = [];
	return {
		runtime: {
			session: commandInstalled
				? { extensionRunner: { getCommand: () => ({ name: "notify" }) } }
				: { extensionRunner: { getCommand: () => undefined } },
			settings: {},
			cwd: "/tmp",
			output: async (message: string) => {
				output.push(message);
			},
		} as never,
		output,
	};
}

describe("/notify SDK-only routing", () => {
	test("always pass-through on/off when no lazy command is installed", async () => {
		const command = lookupBuiltinSlashCommand("notify");
		if (!command?.handle) throw new Error("notify builtin handler missing");
		const { runtime, output } = runtimeWithExtension(false);
		expect(await command.handle({ name: "notify", args: "on", text: "/notify on" }, runtime)).toEqual({
			prompt: "/notify on",
		});
		expect(output).toEqual([]);
		expect(await command.handle({ name: "notify", args: "off", text: "/notify off" }, runtime)).toEqual({
			prompt: "/notify off",
		});
		expect(output).toEqual([]);
	});

	test("always pass-through on/off when a registered native/session command is present", async () => {
		const command = lookupBuiltinSlashCommand("notify");
		if (!command?.handle) throw new Error("notify builtin handler missing");
		const { runtime, output } = runtimeWithExtension(true);
		expect(await command.handle({ name: "notify", args: "on", text: "/notify on" }, runtime)).toEqual({
			prompt: "/notify on",
		});
		expect(output).toEqual([]);
		expect(await command.handle({ name: "notify", args: "off", text: "/notify off" }, runtime)).toEqual({
			prompt: "/notify off",
		});
		expect(output).toEqual([]);
	});
});
