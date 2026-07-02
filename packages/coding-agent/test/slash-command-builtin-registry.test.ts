import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	executeBuiltinSlashCommand,
} from "@gajae-code/coding-agent/slash-commands/builtin-registry";

function createTuiRuntime() {
	const handleCopyCommand = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();
	const ctx = {
		handleCopyCommand,
		showError,
		editor: { setText },
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx, handleBackgroundCommand: () => undefined },
		handleCopyCommand,
		showError,
		setText,
	};
}

describe("builtin /copy slash command", () => {
	it("is discoverable as a TUI builtin without public subcommands and does not register /clear", () => {
		const copyCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "copy");

		expect(copyCommand).toBeDefined();
		expect(copyCommand?.description).toBe("Copy last response as markdown");
		expect(copyCommand?.subcommands).toBeUndefined();
		expect(copyCommand?.inlineHint).toBeUndefined();
		expect(BUILTIN_SLASH_COMMAND_DEFS.some(command => command.name === "clear")).toBe(false);
		expect(BUILTIN_SLASH_COMMANDS_INTERNAL.some(command => command.name === "clear")).toBe(false);
	});

	it("surfaces beginner session commands with clear labels", () => {
		const helpCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "help");
		const newCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "new");
		const sessionCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "session");

		expect(helpCommand?.description).toContain("beginner help");
		expect(helpCommand?.priority).toBeGreaterThan(newCommand?.priority ?? 0);
		expect(newCommand?.description).toBe("Start a new session");
		expect(sessionCommand?.description).toBe("Show session info or delete the current session");
		expect(sessionCommand?.subcommands?.map(command => command.name)).toEqual(["info", "delete"]);
	});

	it("dispatches zero-argument /copy to the existing copy controller path", async () => {
		const { runtime, handleCopyCommand, showError, setText } = createTuiRuntime();

		const result = await executeBuiltinSlashCommand("/copy", runtime);

		expect(result).toBe(true);
		expect(handleCopyCommand).toHaveBeenCalledWith(undefined);
		expect(showError).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
	});

	it("rejects /copy arguments locally instead of falling through", async () => {
		const { runtime, handleCopyCommand, showError, setText } = createTuiRuntime();

		const result = await executeBuiltinSlashCommand("/copy last", runtime);

		expect(result).toBe(true);
		expect(handleCopyCommand).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("Usage: /copy");
		expect(setText).toHaveBeenCalledWith("");
	});

	it("rejects colon-form /copy arguments locally", async () => {
		const { runtime, handleCopyCommand, showError, setText } = createTuiRuntime();

		const result = await executeBuiltinSlashCommand("/copy:last", runtime);

		expect(result).toBe(true);
		expect(handleCopyCommand).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("Usage: /copy");
		expect(setText).toHaveBeenCalledWith("");
	});
});

function createGoalTuiRuntime(goalModeEnabled: boolean) {
	const handleGoalModeCommand = vi.fn(async () => {});
	const addToHistory = vi.fn();
	const setText = vi.fn();
	const ctx = {
		goalModeEnabled,
		handleGoalModeCommand,
		editor: { addToHistory, setText },
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx, handleBackgroundCommand: () => undefined },
		handleGoalModeCommand,
		addToHistory,
		setText,
	};
}

describe("builtin /goal slash command", () => {
	it("records the first-time /goal set in input history even when goal mode was inactive", async () => {
		const { runtime, handleGoalModeCommand, addToHistory } = createGoalTuiRuntime(false);

		const result = await executeBuiltinSlashCommand("/goal set Ship the release", runtime);

		expect(result).toBe(true);
		expect(handleGoalModeCommand).toHaveBeenCalledWith("set Ship the release");
		expect(addToHistory).toHaveBeenCalledWith("/goal set Ship the release");
	});

	it("records a replacement /goal set in input history when goal mode is active", async () => {
		const { runtime, addToHistory } = createGoalTuiRuntime(true);

		const result = await executeBuiltinSlashCommand("/goal set Replace the objective", runtime);

		expect(result).toBe(true);
		expect(addToHistory).toHaveBeenCalledWith("/goal set Replace the objective");
	});

	it("does not record an argument-less /goal in input history", async () => {
		const { runtime, addToHistory } = createGoalTuiRuntime(false);

		const result = await executeBuiltinSlashCommand("/goal", runtime);

		expect(result).toBe(true);
		expect(addToHistory).not.toHaveBeenCalled();
	});
});
