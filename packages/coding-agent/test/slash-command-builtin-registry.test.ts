import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { generateTierChains } from "@gajae-code/coding-agent/config/autorouting-generator";
import { CURATED_TIER_MAP } from "@gajae-code/coding-agent/config/autorouting-tier-map";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { BUILTIN_SLASH_COMMANDS } from "@gajae-code/coding-agent/extensibility/slash-commands";
import { getCurrentThemeName, initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@gajae-code/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@gajae-code/coding-agent/slash-commands/builtin-registry";
import { buildAutoroutingStatusReport } from "@gajae-code/coding-agent/slash-commands/helpers/autorouting-status";
import { ImageProtocol, TERMINAL } from "@gajae-code/tui";

const model = (provider: string, id: string): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		contextWindow: 128000,
		maxTokens: 4096,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		headers: {},
		compat: {},
	}) as unknown as Model;

const mutableTerminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const originalImageProtocol = mutableTerminal.imageProtocol;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

afterEach(() => {
	mutableTerminal.imageProtocol = originalImageProtocol;
});

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

describe("builtin /pet slash command", () => {
	it("exposes the named Gajae choices", () => {
		const petCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "pet");

		expect(petCommand?.subcommands?.map(command => command.name)).toEqual([
			"off",
			"RedGajae",
			"BlueGajae",
			"Ouroboros",
		]);
		expect(petCommand?.inlineHint).toBe("[off|RedGajae|BlueGajae|Ouroboros]");
	});

	it("maps named Gajae commands to their internal modes", async () => {
		mutableTerminal.imageProtocol = ImageProtocol.Kitty;
		const setPetMode = vi.fn((_mode: string) => true);
		const setText = vi.fn();
		const showStatus = vi.fn();
		const ctx = { setPetMode, showStatus, editor: { setText } } as unknown as InteractiveModeContext;
		const runtime = { ctx, handleBackgroundCommand: () => undefined };

		expect(await executeBuiltinSlashCommand("/pet redgajae", runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand("/pet BlueGajae", runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand("/pet Ouroboros", runtime)).toBe(true);

		expect(setPetMode.mock.calls.map(call => call[0])).toEqual(["red", "blue", "ouroboros"]);
	});

	it("keeps deprecated on/red/blue inputs accepted while display stays canonical", async () => {
		mutableTerminal.imageProtocol = ImageProtocol.Kitty;
		const setPetMode = vi.fn((_mode: string) => true);
		const showStatus = vi.fn();
		const ctx = { setPetMode, showStatus, editor: { setText: vi.fn() } } as unknown as InteractiveModeContext;

		for (const token of ["red", "blue", "on"]) {
			expect(
				await executeBuiltinSlashCommand(`/pet ${token}`, { ctx, handleBackgroundCommand: () => undefined }),
			).toBe(true);
		}

		// Deprecated inputs still commit, mapped to their canonical modes.
		expect(setPetMode.mock.calls.map(call => call[0])).toEqual(["red", "blue", "red"]);
		// The public surface stays canonical: no deprecated names in subcommands.
		const petCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "pet");
		expect(petCommand?.subcommands?.map(command => command.name)).toEqual([
			"off",
			"RedGajae",
			"BlueGajae",
			"Ouroboros",
		]);

		// Unknown tokens still fall through to usage guidance.
		expect(await executeBuiltinSlashCommand("/pet purple", { ctx, handleBackgroundCommand: () => undefined })).toBe(
			true,
		);
		expect(showStatus).toHaveBeenLastCalledWith("Usage: /pet [off|RedGajae|BlueGajae|Ouroboros]", { dim: true });
		expect(setPetMode).toHaveBeenCalledTimes(3);
	});

	it("suppresses the success status when the shared commit policy rejects", async () => {
		mutableTerminal.imageProtocol = null;
		const setPetMode = vi.fn((_mode: string) => false);
		const showStatus = vi.fn();
		const ctx = { setPetMode, showStatus, editor: { setText: vi.fn() } } as unknown as InteractiveModeContext;

		expect(await executeBuiltinSlashCommand("/pet RedGajae", { ctx, handleBackgroundCommand: () => undefined })).toBe(
			true,
		);
		// The commit policy owns the rejection warning; the handler must not
		// claim success or bypass the policy with its own capability check.
		expect(setPetMode).toHaveBeenCalledWith("red");
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("completes named pets case-insensitively", async () => {
		const petCommand = BUILTIN_SLASH_COMMANDS.find(command => command.name === "pet");

		for (const prefix of ["r", "R", "ReD"]) {
			const completions = await petCommand?.getArgumentCompletions?.(prefix);
			expect(completions?.map(item => item.label)).toEqual(["RedGajae"]);
		}

		expect(petCommand?.getInlineHint?.("ReD")).toBe("Gajae");
	});
});
describe("builtin session star commands", () => {
	it("exposes star and unstar commands and persists through the session manager", async () => {
		let starred = false;
		const setSessionStarred = vi.fn(async (next: boolean) => {
			if (starred === next) return false;
			starred = next;
			return true;
		});
		const showStatus = vi.fn();
		const setText = vi.fn();
		const ctx = {
			session: {},
			sessionManager: { getCwd: () => "/tmp/project", isPersisted: () => true, setSessionStarred },
			settings: {},
			editor: { setText },
			showStatus,
		} as unknown as InteractiveModeContext;
		const runtime = { ctx, handleBackgroundCommand: () => undefined };

		expect(BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "star")?.description).toContain(
			"easier discovery",
		);
		expect(BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "unstar")).toBeDefined();

		expect(await executeBuiltinSlashCommand("/star", runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand("/star", runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand("/unstar", runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand("/star later", runtime)).toBe(true);

		expect(setSessionStarred.mock.calls.map(call => call[0])).toEqual([true, true, false]);
		expect(showStatus.mock.calls.map(call => call[0])).toEqual([
			"Session starred.",
			"Session is already starred.",
			"Session unstarred.",
			"Usage: /star",
		]);
		expect(setText).toHaveBeenCalledTimes(4);
	});
});
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
		goalModeController: {
			enabled: goalModeEnabled,
			paused: false,
			handleCommand: handleGoalModeCommand,
		},
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

function createHandoffTuiRuntime() {
	const handleHandoffCommand = vi.fn(async (_focus?: string) => {});
	const setText = vi.fn();
	const ctx = {
		handleHandoffCommand,
		editor: { setText },
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx, handleBackgroundCommand: () => undefined },
		handleHandoffCommand,
		setText,
	};
}

describe("builtin /handoff slash command", () => {
	it("is discoverable with focus-instruction completion metadata", () => {
		const handoffCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "handoff");

		expect(handoffCommand).toBeDefined();
		expect(handoffCommand?.description).toBe("Generate a handoff and continue in a new session");
		expect(handoffCommand?.inlineHint).toBe("[focus instructions]");
		expect(handoffCommand?.priority).toBe(71);
	});

	it("dispatches zero-argument /handoff to the handoff controller path", async () => {
		const { runtime, handleHandoffCommand, setText } = createHandoffTuiRuntime();

		const result = await executeBuiltinSlashCommand("/handoff", runtime);

		expect(result).toBe(true);
		expect(handleHandoffCommand).toHaveBeenCalledWith(undefined);
		expect(setText).toHaveBeenCalledWith("");
	});

	it("passes focus instructions through to the handoff controller", async () => {
		const { runtime, handleHandoffCommand, setText } = createHandoffTuiRuntime();

		const result = await executeBuiltinSlashCommand("/handoff preserve failing test name", runtime);

		expect(result).toBe(true);
		expect(handleHandoffCommand).toHaveBeenCalledWith("preserve failing test name");
		expect(setText).toHaveBeenCalledWith("");
	});
});

function createThemeTuiRuntime() {
	const showThemeSelector = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();
	const settingsSet = vi.fn();
	const ctx = {
		showThemeSelector,
		showStatus,
		showError,
		editor: { setText },
		settings: { canWriteDurableConfig: () => true, set: settingsSet },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { invalidate: vi.fn() },
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx, handleBackgroundCommand: () => undefined },
		showThemeSelector,
		showStatus,
		showError,
		setText,
		settingsSet,
	};
}

describe("builtin /theme slash command", () => {
	it("opens the theme selector when no theme name is given", async () => {
		const { runtime, showThemeSelector, setText, settingsSet } = createThemeTuiRuntime();

		const result = await executeBuiltinSlashCommand("/theme", runtime);

		expect(result).toBe(true);
		expect(showThemeSelector).toHaveBeenCalledTimes(1);
		expect(settingsSet).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
	});

	it("changes the theme immediately when a valid theme name is given", async () => {
		const { runtime, showThemeSelector, showStatus, settingsSet } = createThemeTuiRuntime();

		const result = await executeBuiltinSlashCommand("/theme blue-crab", runtime);

		expect(result).toBe(true);
		expect(showThemeSelector).not.toHaveBeenCalled();
		expect(settingsSet).toHaveBeenCalledTimes(1);
		expect(settingsSet.mock.calls[0]?.[1]).toBe("blue-crab");
		expect(getCurrentThemeName()).toBe("blue-crab");
		expect(showStatus).toHaveBeenCalledWith("Theme changed to blue-crab");
	});

	it("rejects an unknown theme name without touching settings", async () => {
		const { runtime, showError, settingsSet } = createThemeTuiRuntime();

		const result = await executeBuiltinSlashCommand("/theme not-a-theme", runtime);

		expect(result).toBe(true);
		expect(settingsSet).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledTimes(1);
		expect(String(showError.mock.calls[0]?.[0])).toContain('Unknown theme "not-a-theme"');
	});
});

describe("builtin /routing slash command", () => {
	function createRoutingTuiRuntime(settingsValues: Record<string, unknown> = {}) {
		const showModelSelector = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const setText = vi.fn();
		const settings = Settings.isolated(settingsValues as never);
		// Mirrors SelectorController.setAutoroutingEnabled: the only writer the
		// command is allowed to use, so scoped/read-only guards stay in one place.
		const setAutoroutingEnabled = vi.fn(async (enabled: boolean) => {
			settings.set("task.autorouting.enabled", enabled);
		});
		const chatContainer = { addChild: vi.fn() };
		const ctx = {
			showModelSelector,
			showStatus,
			showError,
			settings,
			setAutoroutingEnabled,
			chatContainer,
			ui: { requestRender: vi.fn() },
			editor: { setText },
		} as unknown as InteractiveModeContext;

		return {
			runtime: { ctx, handleBackgroundCommand: () => undefined },
			showModelSelector,
			setAutoroutingEnabled,
			settings,
			setText,
		};
	}

	it("opens the smart-routing panel directly when invoked without arguments", async () => {
		const { runtime, showModelSelector, setText } = createRoutingTuiRuntime();

		expect(await executeBuiltinSlashCommand("/routing", runtime)).toBe(true);

		expect(showModelSelector).toHaveBeenCalledWith({ smartRoutingOnly: true });
		expect(setText).toHaveBeenCalledWith("");
	});

	it("routes the toggle through the guarded controller entry point", async () => {
		const { runtime, showModelSelector, setAutoroutingEnabled, settings } = createRoutingTuiRuntime();

		expect(await executeBuiltinSlashCommand("/routing on", runtime)).toBe(true);
		expect(setAutoroutingEnabled).toHaveBeenLastCalledWith(true);
		expect(settings.get("task.autorouting.enabled")).toBe(true);

		expect(await executeBuiltinSlashCommand("/routing off", runtime)).toBe(true);
		expect(setAutoroutingEnabled).toHaveBeenLastCalledWith(false);
		expect(settings.get("task.autorouting.enabled")).toBe(false);
		expect(showModelSelector).not.toHaveBeenCalled();
	});

	it("reports settings-derived status labels", () => {
		const base = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: ["anthropic/model"] },
		});
		const snapshot = () => ({
			effective: base.getEffectiveAutorouting(),
			tiers: base.get("task.autorouting.tiers"),
			provenance: base.get("task.autorouting.provenance"),
		});
		expect(buildAutoroutingStatusReport(snapshot())).toContain("Autorouting: on (hand-authored tiers)");
		expect(buildAutoroutingStatusReport({ ...snapshot(), provenance: undefined })).toContain("hand-authored tiers");
		const catalog = [
			model("anthropic", "claude-haiku-4-5"),
			model("anthropic", "claude-sonnet-5"),
			model("anthropic", "claude-opus-5"),
		];
		const generated = generateTierChains({ schema: 1, providers: ["anthropic"] }, CURATED_TIER_MAP, catalog);
		const generatedSettings = Settings.isolated({
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": generated.tiers,
			"task.autorouting.provenance": {
				schema: 1,
				source: generated.sourceIdentity,
				declarationFingerprint: generated.declarationFingerprint,
				tiersFingerprint: generated.tiersFingerprint,
			},
		});
		const generatedSnapshot = {
			effective: generatedSettings.getEffectiveAutorouting(),
			tiers: generatedSettings.get("task.autorouting.tiers"),
			provenance: generatedSettings.get("task.autorouting.provenance"),
		};
		const generatedReport = buildAutoroutingStatusReport(generatedSnapshot);
		expect(generatedReport).toContain("Autorouting: on (generated)");
		expect(
			buildAutoroutingStatusReport({
				...generatedSnapshot,
				provenance: { ...generatedSnapshot.provenance!, tiersFingerprint: "0".repeat(64) },
			}),
		).toContain("generated, hand-edited");
		expect(
			buildAutoroutingStatusReport({
				...generatedSnapshot,
				provenance: { ...generatedSnapshot.provenance!, tiersFingerprint: "bad" },
			}),
		).toContain("hand-authored tiers");
		expect(
			buildAutoroutingStatusReport({
				effective: Settings.isolated().getEffectiveAutorouting(),
				tiers: undefined,
				provenance: undefined,
			}),
		).toContain("Autorouting: off");
	});

	it("strips terminal control sequences from hand-edited selectors", () => {
		// The selector grammar rejects control bytes before they can reach status
		// rendering, so malformed hand-edited tiers fail closed.
		const settings = Settings.isolated({ "task.autorouting.enabled": true } as never);
		settings.set("task.autorouting.tiers", {
			balanced: ["anthropic/\x1b]0;pwned\x07evil-model"],
		} as never);

		const report = buildAutoroutingStatusReport({
			effective: settings.getEffectiveAutorouting(),
			tiers: settings.get("task.autorouting.tiers"),
			provenance: settings.get("task.autorouting.provenance"),
		});

		expect(report).toContain("Autorouting: off");
		expect(report).not.toContain("\x1b");
		expect(report).not.toContain("\x07");
	});

	it("bounds a pathologically long chain", () => {
		const settings = Settings.isolated({ "task.autorouting.enabled": true } as never);
		settings.set("task.autorouting.tiers", {
			fast: Array.from({ length: 40 }, (_, index) => `anthropic/model-${index}`),
		} as never);

		const fastLine = buildAutoroutingStatusReport({
			effective: settings.getEffectiveAutorouting(),
			tiers: settings.get("task.autorouting.tiers"),
			provenance: settings.get("task.autorouting.provenance"),
		})
			.split("\n")
			.find(line => line.trimStart().startsWith("fast:"));

		expect(fastLine).toBeDefined();
		expect(fastLine?.length).toBeLessThanOrEqual(220);
	});
});

describe("builtin /aside slash command", () => {
	it("is discoverable with Aside CLI completion metadata", () => {
		const asideCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "aside");

		expect(asideCommand).toBeDefined();
		expect(asideCommand?.description).toContain("Aside CLI");
		expect(asideCommand?.inlineHint).toBe("[exec|repl|mcp|account|help|<prompt>]");
		expect(asideCommand?.subcommands?.map(command => command.name)).toEqual([
			"exec",
			"repl",
			"mcp",
			"account",
			"help",
		]);
		expect(lookupBuiltinSlashCommand("aside")?.allowArgs).toBe(true);
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "aside")).toBe(true);
	});
});
