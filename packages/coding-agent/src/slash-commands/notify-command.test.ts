import { describe, expect, test } from "bun:test";
import { lookupBuiltinSlashCommand } from "./builtin-registry";

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
	test("consumes on/off with disabled state when no lazy command is installed", async () => {
		const command = lookupBuiltinSlashCommand("notify");
		if (!command?.handle) throw new Error("notify builtin handler missing");
		const { runtime, output } = runtimeWithExtension(false);
		expect(await command.handle({ name: "notify", args: "on", text: "/notify on" }, runtime)).toEqual({ consumed: true });
		expect(output[0]).toContain("unavailable");
		output.length = 0;
		expect(await command.handle({ name: "notify", args: "off", text: "/notify off" }, runtime)).toEqual({ consumed: true });
		expect(output[0]).toContain("already disabled");
	});

	test("delegates to the registered native/session command when present", async () => {
		const command = lookupBuiltinSlashCommand("notify");
		if (!command?.handle) throw new Error("notify builtin handler missing");
		const { runtime, output } = runtimeWithExtension(true);
		expect(await command.handle({ name: "notify", args: "on", text: "/notify on" }, runtime)).toEqual({
			prompt: "/notify on",
		});
		expect(output).toEqual([]);
	});
});
