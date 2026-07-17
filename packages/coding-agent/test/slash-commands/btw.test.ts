import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwRCommand = vi.fn(async () => {});
	const setText = vi.fn();
	return {
		handleBtwCommand,
		handleBtwRCommand,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleBtwCommand,
				handleBtwRCommand,
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/btw slash command", () => {
	it("routes the full question through the interactive btw handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/btw why is it doing that?", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
	});

	it("preserves the raw multi-word suffix after /btw", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand(
			"/btw    explain why the cache reuse matters here",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(harness.handleBtwCommand).toHaveBeenCalledWith("explain why the cache reuse matters here");
	});
	it("registers /btw-r and preserves its full question suffix", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/btw-r explain this in more detail", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleBtwRCommand).toHaveBeenCalledWith("explain this in more detail");
	});
});
