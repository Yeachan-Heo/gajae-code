import { describe, expect, it } from "bun:test";
import type { KeybindingsManager } from "../src/config/keybindings";
import { createPromptActionAutocompleteProvider } from "../src/modes/prompt-action-autocomplete";

function createProvider() {
	return createPromptActionAutocompleteProvider({
		commands: [
			{ name: "fast", description: "Built-in fast mode" },
			{ name: "model", description: "Select model" },
			{ name: "skill:deep-interview", description: "Deep interview" },
			{ name: "skill:ralplan", description: "Consensus planning" },
			{ name: "skill:ultragoal", description: "Durable goal execution" },
			{ name: "skill:fast", description: "Colliding skill" },
			{ name: "skill:mode", description: "Mode skill" },
			{ name: "skill:team", description: "Multi-worker team orchestration" },
			{ name: "init", description: "Generate team AGENTS.md for current codebase" },
			{ name: "goal", description: "Toggle team goal mode for this session" },
		],
		basePath: "/tmp",
		keybindings: { getKeys: () => [], getDisplayString: () => "" } as unknown as KeybindingsManager,
		copyCurrentLine: () => {},
		copyPrompt: () => {},
		pasteImage: () => {},
		pasteText: () => {},
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

	it.each([
		"please use /ra",
		"/skill:deep-interview first /skill-deep",
	])("does not offer skill completions after existing prompt text: %s", async line => {
		const provider = createProvider();

		expect(await provider.getSuggestions([line], 0, line.length)).toBeNull();
	});

	it("does not offer skill completions from a bare top-level slash token", async () => {
		const provider = createProvider();
		const suggestions = await provider.getSuggestions(["/"], 0, 1);
		const values = suggestions?.items.map(item => item.value) ?? [];
		expect(suggestions?.prefix).toBe("/");
		expect(values).toEqual(expect.arrayContaining(["fast", "model"]));
		expect(values.some(value => value.startsWith("skill:"))).toBe(false);
	});

	it.each([
		"please use/",
		"please use /skill",
	])("keeps skill autocomplete closed for inline slash tokens: %s", async line => {
		const provider = createProvider();

		expect(await provider.getSuggestions([line], 0, line.length)).toBeNull();
	});

	it("does not rewrite a nested filesystem path as a skill command", async () => {
		const provider = createProvider();
		const line = "/chromium/src";
		expect(await provider.getSuggestions([line], 0, line.length)).toBeNull();
		expect(provider.trySyncSlashCompletion(line)).toBeNull();
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
