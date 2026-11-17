import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwHandoff = vi.fn(async () => {});
	const setText = vi.fn();
	const showStatus = vi.fn();
	return {
		handleBtwCommand,
		handleBtwHandoff,
		setText,
		showStatus,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleBtwCommand,
				handleBtwHandoff,
				showStatus,
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

	it("routes /btw-handoff to the handoff handler instead of starting a side chat", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/btw-handoff", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleBtwHandoff).toHaveBeenCalledTimes(1);
		expect(harness.handleBtwCommand).not.toHaveBeenCalled();
	});

	it("refuses /btw-handoff with arguments locally instead of sending them to the main model", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/btw-handoff (1 exchange)", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleBtwHandoff).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /btw-handoff (takes no arguments)");
	});
});
