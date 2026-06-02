import { describe, expect, it } from "bun:test";
import { createAutoresearchExtension } from "../src/autoresearch/index";
import { KeybindingsManager } from "../src/config/keybindings";
import type { ExtensionAPI, RegisteredCommand } from "../src/extensibility/extensions";
import { createPromptActionAutocompleteProvider } from "../src/modes/prompt-action-autocomplete";

const EXPERIMENT_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment", "update_notes"];

function registerAutoresearchForTest(): {
	activeTools: string[];
	commands: Map<string, RegisteredCommand>;
	registeredToolNames: string[];
	setActiveToolsCalls: number;
} {
	const activeTools: string[] = [];
	const commands = new Map<string, RegisteredCommand>();
	const registeredToolNames: string[] = [];
	let setActiveToolsCalls = 0;

	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		getActiveTools(): string[] {
			return [...activeTools];
		},
		on(): void {},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void {
			commands.set(name, { name, ...options });
		},
		registerShortcut(): void {},
		registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]): void {
			registeredToolNames.push(tool.name);
		},
		sendMessage(): void {},
		sendUserMessage(): void {},
		setActiveTools: async (toolNames: string[]): Promise<void> => {
			setActiveToolsCalls += 1;
			activeTools.splice(0, activeTools.length, ...toolNames);
		},
	} as unknown as ExtensionAPI;

	createAutoresearchExtension(api);

	return { activeTools, commands, registeredToolNames, setActiveToolsCalls };
}

describe("autoresearch discovery", () => {
	it("registers the built-in autoresearch slash command for TUI extension discovery", async () => {
		const { activeTools, commands, registeredToolNames, setActiveToolsCalls } = registerAutoresearchForTest();

		const command = commands.get("autoresearch");
		expect(command?.name).toBe("autoresearch");
		expect(command?.description).toContain("autoresearch mode");
		expect(registeredToolNames.sort()).toEqual([...EXPERIMENT_TOOL_NAMES].sort());

		const provider = createPromptActionAutocompleteProvider({
			commands: [...commands.values()].map(entry => ({
				name: entry.name,
				description: entry.description,
				getArgumentCompletions: entry.getArgumentCompletions,
			})),
			basePath: "/tmp",
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});
		const suggestions = await provider.getSuggestions(["/auto"], 0, "/auto".length);
		expect(suggestions?.prefix).toBe("/auto");
		expect(suggestions?.items.map(item => item.value)).toContain("autoresearch");
		expect(setActiveToolsCalls).toBe(0);
		for (const toolName of EXPERIMENT_TOOL_NAMES) {
			expect(activeTools).not.toContain(toolName);
		}
	});
});
