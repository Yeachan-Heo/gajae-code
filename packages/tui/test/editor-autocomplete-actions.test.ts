import { describe, expect, it } from "bun:test";
import type { AutocompleteItem, AutocompleteProvider } from "@gajae-code/tui/autocomplete";
import { Editor } from "@gajae-code/tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

class HashActionProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		_cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const prefix = (lines[0] || "").slice(0, cursorCol);
		if (prefix !== "#") {
			return null;
		}

		return {
			prefix,
			items: [{ value: "action", label: "Do action" }],
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void } {
		const line = lines[cursorLine] || "";
		return {
			lines: [line.slice(0, cursorCol - prefix.length) + line.slice(cursorCol)],
			cursorLine,
			cursorCol: cursorCol - prefix.length,
			onApplied: () => {
				this.calls += 1;
			},
		};
	}

	calls = 0;
}

describe("Editor hash autocomplete actions", () => {
	it("auto-triggers # suggestions and runs autocomplete callbacks on selection", async () => {
		const provider = new HashActionProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.handleInput("#");
		await Bun.sleep(0);
		editor.handleInput("\r");

		expect(editor.getText()).toBe("");
		expect(provider.calls).toBe(1);
	});
});
class SyncSlashProvider implements AutocompleteProvider {
	async getSuggestions(
		_lines: string[],
		_cursorLine: number,
		_cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		return null;
	}

	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		this.callCount += 1;
		if (!textBeforeCursor.startsWith("/")) return null;
		if (textBeforeCursor.length <= 1) return null;
		if (textBeforeCursor.includes(" ")) return null;
		// Only match known slash commands: /mo or /model
		const prefix = textBeforeCursor.slice(1);
		if (prefix === "mo" || prefix === "model") {
			return {
				prefix: textBeforeCursor,
				items: [{ value: "model", label: "/model" }],
			};
		}
		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void } {
		const line = lines[cursorLine] || "";
		const beforePrefix = line.slice(0, cursorCol - prefix.length);
		const afterCursor = line.slice(cursorCol);
		const nextLines = [...lines];
		nextLines[cursorLine] = `${beforePrefix}/${_item.value} ${afterCursor}`;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: beforePrefix.length + _item.value.length + 2,
		};
	}

	callCount = 0;
}

class InlineSkillProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		this.suggestionCalls += 1;
		const line = lines[cursorLine] || "";
		const textBeforeCursor = line.slice(0, cursorCol);
		const match = textBeforeCursor.match(/(?:^|\s)(\/[^\s]*)$/);
		const prefix = match?.[1];
		if (!prefix) return null;
		if (prefix !== "/" && !"/skill:team".startsWith(prefix) && !"/skill-team".startsWith(prefix)) {
			return null;
		}
		return {
			prefix,
			items: [{ value: "skill:team", label: "skill:team" }],
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void } {
		const line = lines[cursorLine] || "";
		const beforePrefix = line.slice(0, cursorCol - prefix.length);
		const afterCursor = line.slice(cursorCol);
		const nextLines = [...lines];
		nextLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length + 2,
		};
	}

	suggestionCalls = 0;
}
describe("Editor Enter handler sync slash completion", () => {
	it("does not auto-trigger slash autocomplete from a bare slash after prior prompt text", async () => {
		let suggestionCalls = 0;
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider({
			async getSuggestions(lines, cursorLine, cursorCol) {
				suggestionCalls += 1;
				const currentLine = lines[cursorLine] ?? "";
				return { prefix: currentLine.slice(0, cursorCol), items: [{ value: "model", label: "/model" }] };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});

		editor.setText("explain this\n");
		editor.handleInput("/");
		await Bun.sleep(0);

		expect(suggestionCalls).toBe(0);
		expect(editor.isShowingAutocomplete()).toBe(false);
	});

	it("auto-triggers inline slash skill autocomplete after prompt text", async () => {
		const provider = new InlineSkillProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.handleInput("explain with /skill-te");
		await Bun.sleep(0);

		expect(provider.suggestionCalls).toBeGreaterThan(0);
		expect(editor.isShowingAutocomplete()).toBe(true);
	});

	it("applies inline slash skill completion before submitting", async () => {
		const provider = new InlineSkillProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("explain with /skill-te");
		await Bun.sleep(0);
		editor.handleInput("\r");

		expect(submitted).toBe("explain with /skill:team");
	});

	it("completes slash command synchronously before async resolves and submits", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("/mo");
		editor.handleInput("\r");

		expect(submitted).toBe("/model");
	});

	it("completes slash command after leading blank lines", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.setText("\n/mo");
		editor.handleInput("\r");

		expect(submitted).toBe("/model");
		expect(provider.callCount).toBe(1);
	});

	it("does not complete slash command after prior prompt text", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.setText("explain this\n/mo");
		editor.handleInput("\r");

		expect(submitted).toBe("explain this\n/mo");
		expect(provider.callCount).toBe(0);
	});

	it("submits raw text when slash command has no sync match", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("/xyz");
		editor.handleInput("\r");

		expect(submitted).toBe("/xyz");
	});

	it("does not interfere with non-slash text submission", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("hello");
		editor.handleInput("\r");

		expect(submitted).toBe("hello");
	});

	it("applies completion from autocomplete list when autocomplete is already showing, then submits", async () => {
		// Create a provider that returns results from getSuggestions too,
		// so after a yield the autocomplete state is set and the autocomplete
		// block in the Enter handler applies the completion before submitting.
		let suggestionsCallCount = 0;
		const provider = new SyncSlashProvider();
		provider.getSuggestions = async (lines, _cursorLine, cursorCol) => {
			suggestionsCallCount++;
			const line = lines[0] || "";
			const textBeforeCursor = line.slice(0, cursorCol);
			if (textBeforeCursor.startsWith("/")) {
				return { prefix: textBeforeCursor, items: [{ value: "model", label: "/model" }] };
			}
			return null;
		};

		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("/mo");
		await Bun.sleep(0); // Let async autocomplete resolve and set state
		editor.handleInput("\r");

		// When autocomplete shows a slash command, Enter applies the completion
		// (turning /mo into /model via the autocomplete block at line ~1005)
		// then cancels autocomplete and submits the completed text.
		expect(submitted).toBe("/model");
		expect(suggestionsCallCount).toBeGreaterThan(0);
	});
});
