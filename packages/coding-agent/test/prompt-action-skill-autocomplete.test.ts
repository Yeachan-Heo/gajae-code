import { describe, expect, it } from "bun:test";
import type { KeybindingsManager } from "../src/config/keybindings";
import { createPromptActionAutocompleteProvider } from "../src/modes/prompt-action-autocomplete";

function createProvider() {
	return createPromptActionAutocompleteProvider({
		commands: [
			{ name: "fast", description: "Built-in fast mode" },
			{ name: "model", description: "Select model" },
			{ name: "skill:alpha", description: "Alpha skill" },
			{ name: "skill:beta", description: "Beta skill" },
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
	it("keeps per-query ranking and exact-command collision rules across repeated sync and async lookups", async () => {
		const provider = createProvider();
		const cases: Array<[string, string[]]> = [
			["/fast", ["fast"]],
			["/skill:be", ["skill:beta"]],
			["/mode", ["model", "skill:mode", "fast", "goal", "init"]],
			["/deep", ["skill:deep-interview"]],
			["/fast", ["fast"]],
		];
		for (const [query, expected] of cases) {
			expect(provider.trySyncSlashCompletion(query)?.items.map(item => item.value)).toEqual(expected);
			expect((await provider.getSuggestions([query], 0, query.length))?.items.map(item => item.value)).toEqual(
				expected,
			);
		}
	});
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
		"/skill:deep-interview first /model",
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

	it("completes a later same-line skill token and replaces only that token", async () => {
		const provider = createProvider();
		const line = "/skill:alpha x /skill:be";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions?.prefix).toBe("/skill:be");
		expect(suggestions?.items.map(item => item.value)).toEqual(["skill:beta"]);

		const item = suggestions?.items[0];
		if (!suggestions || !item) throw new Error("expected a skill completion");
		const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
		expect(applied.lines).toEqual(["/skill:alpha x /skill:beta "]);
		expect(applied.cursorCol).toBe(applied.lines[0]!.length);

		const tabSeparated = "/skill:alpha x\t/skill:be";
		expect((await provider.getSuggestions([tabSeparated], 0, tabSeparated.length))?.prefix).toBe("/skill:be");
	});

	it("preserves suffixes without duplicating a boundary when the cursor is inside a token", async () => {
		const provider = createProvider();
		const prefix = "/skill:be";
		const item = (await provider.getSuggestions([`${prefix} trailing`], 0, prefix.length))?.items[0];
		if (!item) throw new Error("expected a skill completion");

		const withWhitespace = provider.applyCompletion([`${prefix} trailing`], 0, prefix.length, item, prefix);
		const withTokenSuffix = provider.applyCompletion([`${prefix}XYZ`], 0, prefix.length, item, prefix);

		expect(withWhitespace.lines).toEqual(["/skill:beta trailing"]);
		expect(withWhitespace.cursorCol).toBe("/skill:beta".length);
		expect(withTokenSuffix.lines).toEqual(["/skill:betaXYZ"]);
		expect(withTokenSuffix.cursorCol).toBe("/skill:beta".length);
	});

	it("supports a case-insensitive canonical skill prefix and the skill-hyphen prefix", async () => {
		const provider = createProvider();

		const canonical = await provider.getSuggestions(["/Skill:be"], 0, 9);
		expect(canonical?.prefix).toBe("/Skill:be");
		expect(canonical?.items.map(item => item.value)).toEqual(["skill:beta"]);

		const hyphen = await provider.getSuggestions(["/skill-be"], 0, 9);
		expect(hyphen?.prefix).toBe("/skill-be");
		expect(hyphen?.items.map(item => item.value)).toEqual(["skill:beta"]);
	});

	it("keeps ordinary slash-command completion closed after a prior token", async () => {
		const provider = createProvider();

		expect(await provider.getSuggestions(["/skill:alpha x /mo"], 0, 18)).toBeNull();
		const line = "ordinary text /mo";
		expect(await provider.getSuggestions([line], 0, line.length)).toBeNull();
	});
});
