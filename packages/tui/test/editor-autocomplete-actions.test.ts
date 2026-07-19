import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
} from "@gajae-code/tui/autocomplete";
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

class DelayedSlashProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		await Bun.sleep(30);
		const textBeforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
		const prefix = textBeforeCursor.slice(textBeforeCursor.lastIndexOf("/"));
		return { prefix, items: [{ value: "model", label: "/model" }] };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		this.applyCalls += 1;
		const line = lines[cursorLine] || "";
		const beforePrefix = line.slice(0, cursorCol - prefix.length);
		const nextLines = [...lines];
		nextLines[cursorLine] = `${beforePrefix}/${item.value}`;
		return { lines: nextLines, cursorLine, cursorCol: beforePrefix.length + item.value.length + 1 };
	}

	applyCalls = 0;
}

class DelayedFileProvider implements AutocompleteProvider {
	async getSuggestions(): Promise<null> {
		return null;
	}

	async getForceFileSuggestions(): Promise<{ items: AutocompleteItem[]; prefix: string }> {
		await Bun.sleep(30);
		return { prefix: "src/", items: [{ value: "src/file.ts", label: "file.ts" }] };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		this.applyCalls += 1;
		const line = lines[cursorLine] || "";
		const beforePrefix = line.slice(0, cursorCol - prefix.length);
		const nextLines = [...lines];
		nextLines[cursorLine] = beforePrefix + item.value + line.slice(cursorCol);
		return { lines: nextLines, cursorLine, cursorCol: beforePrefix.length + item.value.length };
	}

	applyCalls = 0;
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
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		this.syncCallCount += 1;
		const prefix = textBeforeCursor.slice(textBeforeCursor.lastIndexOf("/"));
		if (!prefix.startsWith("/skill")) return null;
		return { prefix, items: [{ value: "skill:team", label: "skill:team" }] };
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
	syncCallCount = 0;
}
describe("Editor Enter handler sync slash completion", () => {
	it("auto-triggers slash command autocomplete from an inline slash after prompt text", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "model", description: "Switch model", value: "model" }], "/tmp"),
		);

		editor.handleInput("explain this/");
		await Bun.sleep(0);

		expect(editor.isShowingAutocomplete()).toBe(true);
	});

	it("auto-triggers slash command autocomplete from an adjacent slash after prompt text", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "help", description: "Learn commands", value: "help" }], "/tmp"),
		);

		editor.handleInput("explain this/");
		await Bun.sleep(0);

		expect(editor.isShowingAutocomplete()).toBe(true);
	});
	it("opens path-only autocomplete inside inline code", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-backtick-path-"));
		try {
			fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "file.ts"), "export {};\n");
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider([{ name: "model", description: "Switch model", value: "model" }], baseDir),
			);
			let submitted = "";
			editor.onSubmit = text => {
				submitted = text;
			};
			editor.setText("please read `src");

			editor.handleInput("/");
			await Bun.sleep(20);

			expect(editor.isShowingAutocomplete()).toBe(true);
			editor.handleInput("\r");
			editor.handleInput("\r");
			expect(submitted).toBe("please read `src/file.ts");
			expect(submitted).not.toContain("model");
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("does not submit a forced absolute-path popup on the first Enter", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-backtick-absolute-"));
		try {
			fs.mkdirSync(path.join(baseDir, "child"), { recursive: true });
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], baseDir));
			let submitted = "";
			editor.onSubmit = text => {
				submitted = text;
			};
			editor.setText(`please read \`${baseDir}`);

			editor.handleInput("/");
			await Bun.sleep(20);
			expect(editor.isShowingAutocomplete()).toBe(true);
			editor.handleInput("\r");

			expect(submitted).toBe("");
			expect(editor.getText()).toBe(`please read \`${baseDir}/child/`);
			editor.handleInput("\r");
			expect(submitted).toBe(`please read \`${baseDir}/child/`);
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("rejects a forced absolute-path popup after cursor relocation", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-backtick-absolute-origin-"));
		try {
			fs.mkdirSync(path.join(baseDir, "child"), { recursive: true });
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], baseDir));
			let submitted = "";
			editor.onSubmit = text => {
				submitted = text;
			};
			const original = `please read \`${baseDir}/`;
			editor.setText(`please read \`${baseDir}`);

			editor.handleInput("/");
			await Bun.sleep(20);
			expect(editor.isShowingAutocomplete()).toBe(true);
			editor.moveToLineStart();
			editor.handleInput("\r");

			expect(submitted).toBe("");
			expect(editor.getText()).toBe(original);
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("rejects a settled forced relative-path popup after cursor relocation", async () => {
		const provider = new DelayedFileProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		editor.setText("please read `src");

		editor.handleInput("/");
		await Bun.sleep(50);
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.moveToLineStart();
		editor.handleInput("\t");

		expect(provider.applyCalls).toBe(0);
		expect(editor.getText()).toBe("please read `src/");
	});

	it("discards a delayed forced path result after cursor relocation", async () => {
		const provider = new DelayedFileProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		editor.setText("please read `src");

		editor.handleInput("/");
		editor.moveToLineStart();
		await Bun.sleep(50);

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(provider.applyCalls).toBe(0);
		expect(editor.getText()).toBe("please read `src/");
	});

	it("restores command autocomplete after a closed inline-code span", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "model", description: "Switch model", value: "model" }], "/tmp"),
		);

		editor.setText("`/literal` then /m");
		editor.handleInput("o");
		await Bun.sleep(20);

		expect(editor.isShowingAutocomplete()).toBe(true);
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
	it("submits an inline-code skill token without synchronous Enter completion", () => {
		const provider = new InlineSkillProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("please use `/skill-te");
		editor.handleInput("\r");

		expect(submitted).toBe("please use `/skill-te");
		expect(provider.syncCallCount).toBe(0);
	});
	it("preserves submitted-command argument completion inside inline code", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{
						name: "read",
						getArgumentCompletions: () => [{ value: "argument-choice", label: "argument choice" }],
					},
				],
				"/tmp",
			),
		);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};
		editor.setText("/read `src/foo");

		editor.handleInput("/");
		await Bun.sleep(20);
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput("\r");
		editor.handleInput("\r");

		expect(submitted).toBe("/read argument-choice");
	});
	it("rejects a stale command selection after an opening backtick is inserted", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "model", description: "Switch model", value: "model" }], "/tmp"),
		);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.setText("/m");
		editor.handleInput("o");
		await Bun.sleep(20);
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.moveToLineStart();
		editor.handleInput("`");
		editor.moveToLineEnd();
		editor.handleInput("\r");

		expect(submitted).toBe("`/mo");
	});
	it("rejects a stale command selection on Tab after a backtick insertion", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "model", description: "Switch model", value: "model" }], "/tmp"),
		);

		editor.setText("/m");
		editor.handleInput("o");
		await Bun.sleep(20);
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.moveToLineStart();
		editor.handleInput("`");
		editor.moveToLineEnd();
		editor.handleInput("\t");
		await Bun.sleep(20);

		expect(editor.getText()).toBe("`/mo");
	});

	it("rejects a command popup that resolves after literal context changes", async () => {
		const provider = new DelayedSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.setText("/m");
		editor.handleInput("o");
		editor.moveToLineStart();
		editor.handleInput("`");
		editor.moveToLineEnd();
		await Bun.sleep(50);
		expect(editor.isShowingAutocomplete()).toBe(false);

		expect(provider.applyCalls).toBe(0);
		expect(editor.getText()).toBe("`/mo");
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
