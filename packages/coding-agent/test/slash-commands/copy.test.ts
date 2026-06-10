import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness() {
	const setText = vi.fn();
	const handleCopyCommand = vi.fn();

	return {
		setText,
		handleCopyCommand,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleCopyCommand,
			} as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/copy slash command", () => {
	it("dispatches to handleCopyCommand with no subcommand", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/copy", harness.runtime)).toBe(true);

		expect(harness.handleCopyCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleCopyCommand).toHaveBeenCalledWith(undefined);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("passes each documented subcommand through", async () => {
		for (const sub of ["last", "code", "all", "cmd"]) {
			const harness = createRuntimeHarness();

			expect(await executeBuiltinSlashCommand(`/copy ${sub}`, harness.runtime)).toBe(true);

			expect(harness.handleCopyCommand).toHaveBeenCalledWith(sub);
			expect(harness.setText).toHaveBeenCalledWith("");
		}
	});

	it("normalizes subcommand casing before dispatch", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/copy CODE", harness.runtime)).toBe(true);

		expect(harness.handleCopyCommand).toHaveBeenCalledWith("code");
	});
});
