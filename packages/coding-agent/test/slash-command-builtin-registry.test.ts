import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
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

function createClearTuiRuntime() {
	const handleContextClearCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const ctx = {
		handleContextClearCommand,
		editor: { setText },
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx, handleBackgroundCommand: () => undefined },
		handleContextClearCommand,
		setText,
	};
}

describe("builtin /copy slash command", () => {
	it("is discoverable as a TUI builtin without public subcommands", () => {
		const copyCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "copy");
		const clearCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "clear");

		expect(copyCommand).toBeDefined();
		expect(copyCommand?.description).toBe("Copy the last response for review or sharing");
		expect(copyCommand?.subcommands).toBeUndefined();
		expect(copyCommand?.inlineHint).toBeUndefined();
		expect(clearCommand?.description).toBe("Clear context while preserving this session ID");
		expect(BUILTIN_SLASH_COMMANDS_INTERNAL.some(command => command.name === "clear")).toBe(true);
	});

	it("surfaces beginner session commands with clear labels", () => {
		const helpCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "help");
		const newCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "new");
		const sessionCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "session");

		expect(helpCommand?.description).toContain("beginner workflows");
		expect(helpCommand?.priority).toBeGreaterThan(newCommand?.priority ?? 0);
		expect(newCommand?.description).toBe("Start a new session");
		expect(sessionCommand?.description).toBe("Show session info or delete the current session transcript/artifacts");
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

function createChangelogTuiRuntime() {
	const handleChangelogCommand = vi.fn(async (_showFull?: boolean) => {});
	const showError = vi.fn();
	const setText = vi.fn();
	const ctx = {
		handleChangelogCommand,
		showError,
		editor: { setText },
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx, handleBackgroundCommand: () => undefined },
		handleChangelogCommand,
		showError,
		setText,
	};
}

describe("builtin /changelog slash command", () => {
	it("is discoverable with full-history completion metadata", () => {
		const changelogCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "changelog");

		expect(changelogCommand).toBeDefined();
		expect(changelogCommand?.description).toBe("Show release notes and changelog entries");
		expect(changelogCommand?.inlineHint).toBe("[full|--full]");
		expect(changelogCommand?.subcommands?.map(command => command.name)).toEqual(["full"]);
	});

	it("dispatches /changelog to the existing TUI changelog controller path", async () => {
		const { runtime, handleChangelogCommand, showError, setText } = createChangelogTuiRuntime();

		const result = await executeBuiltinSlashCommand("/changelog", runtime);

		expect(result).toBe(true);
		expect(handleChangelogCommand).toHaveBeenCalledWith(false);
		expect(showError).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
	});

	it("accepts full and --full changelog arguments", async () => {
		const shortForm = createChangelogTuiRuntime();
		const longForm = createChangelogTuiRuntime();

		expect(await executeBuiltinSlashCommand("/changelog full", shortForm.runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand("/changelog --full", longForm.runtime)).toBe(true);

		expect(shortForm.handleChangelogCommand).toHaveBeenCalledWith(true);
		expect(longForm.handleChangelogCommand).toHaveBeenCalledWith(true);
	});

	it("rejects unknown changelog arguments locally instead of falling through", async () => {
		const { runtime, handleChangelogCommand, showError, setText } = createChangelogTuiRuntime();

		const result = await executeBuiltinSlashCommand("/changelog nope", runtime);

		expect(result).toBe(true);
		expect(handleChangelogCommand).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("Usage: /changelog [full|--full]");
		expect(setText).toHaveBeenCalledWith("");
	});
});

describe("builtin /clear slash command", () => {
	it("dispatches to context clear without starting the /new flow", async () => {
		const { runtime, handleContextClearCommand, setText } = createClearTuiRuntime();

		const result = await executeBuiltinSlashCommand("/clear", runtime);

		expect(result).toBe(true);
		expect(handleContextClearCommand).toHaveBeenCalled();
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

describe("builtin /exit shutdown command", () => {
	it("resolves /quit as an alias of /exit (TUI-only shutdown)", () => {
		const exitCommand = lookupBuiltinSlashCommand("exit");
		const quitCommand = lookupBuiltinSlashCommand("quit");

		expect(exitCommand?.name).toBe("exit");
		expect(quitCommand).toBe(exitCommand);
		// Shutdown is a TUI-only action: no ACP text-mode handle.
		expect(exitCommand?.handleTui).toBeDefined();
		expect(exitCommand?.handle).toBeUndefined();
		// The alias is not advertised as its own autocomplete/help entry.
		expect(BUILTIN_SLASH_COMMAND_DEFS.some(command => command.name === "quit")).toBe(false);
	});
});
