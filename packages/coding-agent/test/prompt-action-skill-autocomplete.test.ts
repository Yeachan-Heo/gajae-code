import { describe, expect, it } from "bun:test";
import type { KeybindingsManager } from "../src/config/keybindings";
import { createPromptActionAutocompleteProvider } from "../src/modes/prompt-action-autocomplete";

function createProvider() {
	return createPromptActionAutocompleteProvider({
		commands: [
			{ name: "fast", description: "Built-in fast mode" },
			{ name: "model", description: "Select model" },
			{ name: "skill:deep-interview", description: "Deep interview" },
			{ name: "skill:fast", description: "Colliding skill" },
			{ name: "skill:mode", description: "Mode skill" },
			{ name: "skill:team", description: "Multi-worker team orchestration" },
			{ name: "init", description: "Generate team AGENTS.md for current codebase" },
			{ name: "goal", description: "Toggle team goal mode for this session" },
		],
		basePath: "/tmp",
		keybindings: { getKeys: () => [] } as unknown as KeybindingsManager,
		copyCurrentLine: () => {},
		copyPrompt: () => {},
		pasteImage: () => {},
		newSession: () => {},
		showHelp: () => {},
		scrollTmuxToPreviousUserInput: () => {},
		undo: () => {},
		moveCursorToMessageEnd: () => {},
		moveCursorToMessageStart: () => {},
		moveCursorToLineStart: () => {},
		moveCursorToLineEnd: () => {},
	});
}

describe("prompt action skill autocomplete", () => {
	it("normalizes direct skill-name typing to the canonical skill command", async () => {
		const provider = createProvider();
		const suggestions = await provider.getSuggestions(["/deep"], 0, 5);
		expect(suggestions?.prefix).toBe("/deep");
		expect(suggestions?.items[0]?.value).toBe("skill:deep-interview");
		const applied = provider.applyCompletion(["/deep"], 0, 5, suggestions!.items[0]!, suggestions!.prefix);
		expect(applied.lines[0]).toBe("/skill:deep-interview ");
	});

	it("normalizes slash-skill-name typing at intermediate positions", async () => {
		const provider = createProvider();
		const line = "/skill:deep-interview first /skill-deep";
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		expect(suggestions?.prefix).toBe("/skill-deep");
		expect(suggestions?.items[0]?.value).toBe("skill:deep-interview");
		const applied = provider.applyCompletion([line], 0, line.length, suggestions!.items[0]!, suggestions!.prefix);
		expect(applied.lines[0]).toBe("/skill:deep-interview first /skill:deep-interview ");
	});

	it("does not offer skill completions from a bare slash token after prompt text", async () => {
		const provider = createProvider();
		const line = "please use /";
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		expect(suggestions).toBeNull();
	});

	it("offers skill completions from an inline /skill token after prompt text", async () => {
		const provider = createProvider();
		const line = "please use /skill";
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		expect(suggestions?.prefix).toBe("/skill");
		expect(suggestions?.items.map(item => item.value)).toContain("skill:team");
		expect(suggestions?.items.map(item => item.value)).not.toContain("model");
	});

	it("does not let direct-name normalization shadow an exact non-skill command", async () => {
		const provider = createProvider();
		const suggestions = await provider.getSuggestions(["/fast"], 0, 5);
		expect(suggestions?.items.some(item => item.value === "fast")).toBe(true);
		expect(suggestions?.items.some(item => item.value === "skill:fast")).toBe(false);
	});

	it("keeps fuzzy builtin slash candidates when a skill command also matches", async () => {
		const provider = createProvider();
		const suggestions = await provider.getSuggestions(["/mode"], 0, 5);
		expect(suggestions?.prefix).toBe("/mode");
		expect(suggestions?.items.some(item => item.value === "model")).toBe(true);
		expect(suggestions?.items.some(item => item.value === "skill:mode")).toBe(true);
	});
	it("ranks skill word matches before weaker merged slash candidates", async () => {
		const provider = createProvider();
		const suggestions = await provider.getSuggestions(["/team"], 0, 5);
		expect(suggestions?.prefix).toBe("/team");
		expect(suggestions?.items[0]?.value).toBe("skill:team");
		expect(suggestions?.items.map(item => item.value)).toEqual(
			expect.arrayContaining(["init", "goal", "skill:team"]),
		);
	});

	it("ranks normalized skill prefixes before weaker merged slash candidates", async () => {
		const provider = createProvider();
		const suggestions = await provider.trySyncSlashCompletion("/skill-te");
		expect(suggestions?.prefix).toBe("/skill-te");
		expect(suggestions?.items[0]?.value).toBe("skill:team");
	});
});
