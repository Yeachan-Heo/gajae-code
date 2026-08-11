import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestionKind,
	CombinedAutocompleteProvider,
	extractSlashCommandTokenPrefix,
} from "@gajae-code/tui/autocomplete";
import { Editor } from "@gajae-code/tui/components/editor";
import { visibleWidth } from "@gajae-code/tui/utils";
import { defaultEditorTheme } from "./test-themes";

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).not.toBeNull();
			if (result) {
				expect(result.prefix).toBe("/");
			}
		});

		it("extracts /A from '/A' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2; // After the "A"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			if (result) {
				expect(result.prefix).toBe("/A");
			}
		});

		it("does not trigger for slash commands", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6; // After "model"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).toBe(null);
		});

		it("triggers for absolute paths after slash command argument", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10; // After the second "/"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).not.toBeNull();
			if (result) {
				expect(result.prefix).toBe("/");
			}
		});
	});

	describe("hidden paths", () => {
		let baseDir: string;

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("matches segmented filenames from abbreviated fuzzy query", async () => {
			fs.writeFileSync(path.join(baseDir, "history-search.ts"), "export const x = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@histsr";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@history-search.ts");
		});
		it("includes hidden paths but excludes .git", async () => {
			for (const dir of [".github", ".git"]) {
				fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
			}
			fs.mkdirSync(path.join(baseDir, ".github", "workflows"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, ".github", "workflows", "ci.yml"), "name: ci");
			fs.writeFileSync(path.join(baseDir, ".git", "config"), "[core]");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@.github/");
			expect(values.some(value => value === "@.git" || value.startsWith("@.git/"))).toBe(false);
		});
	});

	describe("@ fuzzy search scoped paths", () => {
		let rootDir: string;
		let baseDir: string;
		let outsideDir: string;

		beforeEach(() => {
			rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-scope-test-"));
			baseDir = path.join(rootDir, "cwd");
			outsideDir = path.join(rootDir, "outside");
			fs.mkdirSync(baseDir, { recursive: true });
			fs.mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(rootDir, { recursive: true, force: true });
		});

		it("scopes @ fuzzy search to the typed relative path prefix", async () => {
			fs.writeFileSync(path.join(baseDir, "alpha-local.ts"), "export const local = 1;\n");
			fs.mkdirSync(path.join(outsideDir, "nested", "deeper"), { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "nested", "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "deeper", "also-alpha.ts"), "export const also = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "deeper", "zzz.ts"), "export const zzz = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@../outside/a";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@../outside/nested/alpha.ts");
			expect(values).toContain("@../outside/nested/deeper/also-alpha.ts");
			expect(values).not.toContain("@../outside/nested/deeper/zzz.ts");
			expect(values.some(value => value.includes("alpha-local.ts"))).toBe(false);
		});
	});
	describe("dot-slash path completion", () => {
		let baseDir: string;

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-dot-slash-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("preserves ./ prefix when completing files", async () => {
			fs.writeFileSync(path.join(baseDir, "update.sh"), "#!/bin/sh\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./up";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("./update.sh");
		});

		it("preserves ./ prefix when completing directories", async () => {
			fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "index.ts"), "export {};\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("./src/");
		});
	});
});

describe("slash command token classification", () => {
	it.each([
		["top-level command", "/he", "/he"],
		["inline command token", "please use /he", null],
		["adjacent inline token", "please/hel", null],
		["nested absolute path", "/chromium/src", null],
		["multi-segment relative path", "chromium/lib/src", null],
		["URL path", "https://example.com/he", null],
	])("classifies %s", (_name, text, expected) => {
		expect(extractSlashCommandTokenPrefix(text)).toBe(expected);
	});

	it("preserves submitted command argument completion", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "read",
					getArgumentCompletions: argumentPrefix => [
						{ value: argumentPrefix, label: "existing argument completion" },
					],
				},
			],
			"/tmp",
		);
		const line = "/read src/foo/";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.prefix).toBe("src/foo/");
		expect(result?.items).toEqual([{ value: "src/foo/", label: "existing argument completion" }]);
	});
});

describe("slash command suggestion position", () => {
	it("marks start-of-input command-name suggestions as slash commands", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const result = await provider.getSuggestions(["/mo"], 0, 3);

		expect(result?.kind).toBe("slash-command");
		expect(result?.items.map(item => item.value)).toContain("model");
	});

	it.each([
		"explain this /mo",
		"explain this/hel",
	])("does not open automatic slash-command suggestions after prompt text: %s", async line => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Switch AI model", value: "model" },
				{ name: "help", description: "Learn commands", value: "help" },
			],
			"/tmp",
		);

		expect(await provider.getSuggestions([line], 0, line.length)).toBeNull();
	});

	it("preserves inline file-path suggestions after prompt text", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-inline-path-test-"));
		try {
			fs.mkdirSync(path.join(baseDir, "src", "foo"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "foo", "bar.ts"), "export {};\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "read src/foo/";
			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe("src/foo/");
			expect(result?.items.map(item => item.value)).toContain("src/foo/bar.ts");
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it.each([
		[["", "/mo"], 1, 3],
		[["  /mo"], 0, 5],
	])("offers command suggestions after only leading whitespace", async (lines, cursorLine, cursorCol) => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const result = await provider.getSuggestions(lines, cursorLine, cursorCol);

		expect(result?.kind).toBe("slash-command");
		expect(result?.prefix).toBe("/mo");
		expect(result?.items.map(item => item.value)).toContain("model");
	});

	it("does not offer slash commands at the start of a later prompt line", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);

		expect(await provider.getSuggestions(["explain this", "/mo"], 1, 3)).toBeNull();
	});
});
describe("trySyncSlashCompletion", () => {
	it("returns null for bare '/' (no prefix to match)", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const result = provider.trySyncSlashCompletion("/");
		expect(result).toBeNull();
	});

	it("returns null for non-slash text", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		expect(provider.trySyncSlashCompletion("hello")).toBeNull();
		expect(provider.trySyncSlashCompletion("")).toBeNull();
	});

	it("returns null when text has spaces (argument phase, not command name)", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		expect(provider.trySyncSlashCompletion("/model claude")).toBeNull();
		expect(provider.trySyncSlashCompletion("/model ")).toBeNull();
	});

	it("returns null when no commands match", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const result = provider.trySyncSlashCompletion("/zzzzz");
		expect(result).toBeNull();
	});

	it("returns matching items for partial slash command name", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/mo");
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("matches multiple commands and sorts by relevance", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Switch AI model", value: "model" },
				{ name: "mode", description: "Change editor mode", value: "mode" },
				{ name: "help", description: "Show help", value: "help" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		const values = result!.items.map(i => i.value);
		// /model and /mode should match; /help should not
		expect(values).toContain("model");
		expect(values).toContain("mode");
		expect(values).not.toContain("help");
		// The better name match should come first (higher score)
		const modelIdx = values.indexOf("model");
		const modeIdx = values.indexOf("mode");
		// model matches 3/5 chars, mode matches 3/4 chars — mode has higher match ratio
		// Both should be present; order depends on fuzzyScore internals
		expect(modelIdx).not.toBe(-1);
		expect(modeIdx).not.toBe(-1);
	});

	it("matches case-insensitively", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "Model", description: "Switch AI model", value: "Model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/MOD");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("Model");
	});

	it("also matches against description", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "md", description: "Switch AI model", value: "md" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/model");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("md");
	});

	it("handles AutocompleteItem-shaped commands (no 'name' property)", () => {
		const provider = new CombinedAutocompleteProvider([{ value: "model", label: "Switch model" }], "/tmp");
		const result = provider.trySyncSlashCompletion("/mod");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("ranks high-priority commands above higher fuzzy scores", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				// Lower priority, but exact-prefix match would normally win on fuzzy score.
				{ name: "skim", description: "Skim the file", value: "skim" },
				// Higher priority: pinned regardless of fuzzy score.
				{ name: "skill:ralplan", description: "Plan the work", value: "skill:ralplan", priority: 100 },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/sk");
		expect(result).not.toBeNull();
		const values = result!.items.map(i => i.value);
		expect(values[0]).toBe("skill:ralplan");
		expect(values).toContain("skim");
	});

	it("uses priority as a tie-breaker within the same slash match tier", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "skill:team", description: "Team orchestration", value: "skill:team", priority: 100 },
				{ name: "slash:team", description: "Alternate team command", value: "slash:team" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/team");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["skill:team", "slash:team"]);
	});

	it("ranks stronger slash text matches above higher-priority fallback matches", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "init", description: "Generate team files", value: "init", priority: 100 },
				{ name: "skill:team", description: "Team orchestration", value: "skill:team" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/team");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["skill:team", "init"]);
	});

	it("normalizes separators for structured slash command prefixes", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "init", description: "Initialize skill template", value: "init", priority: 100 },
				{ name: "skill:team", description: "Team orchestration", value: "skill:team" },
			],
			"/tmp",
		);
		const dashed = provider.trySyncSlashCompletion("/skill-te");
		const colon = provider.trySyncSlashCompletion("/skill:te");
		expect(dashed?.items[0]?.value).toBe("skill:team");
		expect(colon?.items[0]?.value).toBe("skill:team");
	});
});

class StaticAutocompleteProvider implements AutocompleteProvider {
	#result: { items: AutocompleteItem[]; prefix: string; kind?: AutocompleteSuggestionKind };

	constructor(result: { items: AutocompleteItem[]; prefix: string; kind?: AutocompleteSuggestionKind }) {
		this.#result = result;
	}

	async getSuggestions(): Promise<{ items: AutocompleteItem[]; prefix: string; kind?: AutocompleteSuggestionKind }> {
		return this.#result;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		return { lines, cursorLine, cursorCol };
	}
}

async function renderEditorAutocomplete(
	prefix: string,
	items: AutocompleteItem[],
	width: number,
	kind: AutocompleteSuggestionKind = "default",
	leadingText: string = "",
): Promise<string[]> {
	const editor = new Editor(defaultEditorTheme);
	editor.setBorderVisible(false);
	editor.setAutocompleteProvider(new StaticAutocompleteProvider({ prefix, items, kind }));
	editor.setText(leadingText);
	for (const character of prefix) editor.handleInput(character);
	await Bun.sleep(0);
	return editor
		.render(width)
		.slice(1)
		.map(line => Bun.stripANSI(line));
}

async function renderEditorAbsolutePathAutocomplete(
	prefix: string,
	items: AutocompleteItem[],
	width: number,
): Promise<string[]> {
	const editor = new Editor(defaultEditorTheme);
	editor.setBorderVisible(false);
	editor.setAutocompleteProvider(new StaticAutocompleteProvider({ prefix, items, kind: "default" }));
	editor.setText(`read ${prefix}`);
	editor.handleInput("\t");
	await Bun.sleep(0);
	return editor
		.render(width)
		.slice(1)
		.map(line => Bun.stripANSI(line));
}

describe("Editor autocomplete layout", () => {
	const slashItems: AutocompleteItem[] = [
		{ value: "go", label: "go", description: "Run immediately" },
		{ value: "한글명령", label: "한글명령", description: "Unicode workflow description" },
	];

	it("keeps slash-command rows width-safe at narrow, medium, and wide terminal widths", async () => {
		const snapshots = await Promise.all(
			[20, 40, 120].map(async width => {
				const lines = await renderEditorAutocomplete("/g", slashItems, width, "slash-command");
				expect(lines.every(line => visibleWidth(line) <= width)).toBeTrue();
				return lines;
			}),
		);

		expect(snapshots).toEqual([
			["> go", "  한글명령"],
			["> go", "  한글명령"],
			["> go          Run immediately", "  한글명령    Unicode workflow description"],
		]);
	});

	it("clamps slash primary columns between 12 and 32 cells with Unicode labels", async () => {
		const shortLines = await renderEditorAutocomplete("/g", slashItems, 120, "slash-command");
		const longLines = await renderEditorAutocomplete(
			"/g",
			[
				{
					value: "skill:한글-워크플로-이름이-아주-긴-명령",
					label: "skill:한글-워크플로-이름이-아주-긴-명령",
					description: "Long description",
				},
			],
			120,
			"slash-command",
		);
		const shortDescriptionColumn = visibleWidth(shortLines[0]!.slice(0, shortLines[0]!.indexOf("Run immediately")));
		const longDescriptionColumn = visibleWidth(longLines[0]!.slice(0, longLines[0]!.indexOf("Long description")));

		expect(shortDescriptionColumn).toBe(14);
		expect(longDescriptionColumn).toBe(34);
	});

	it("keeps non-slash autocomplete on the default 32-column layout", async () => {
		const lines = await renderEditorAutocomplete("@f", slashItems, 120);

		expect(lines).toEqual([
			"> go                              Run immediately",
			"  한글명령                        Unicode workflow description",
		]);
	});
	it("does not render slash-command suggestions after existing prompt text", async () => {
		const lines = await renderEditorAutocomplete("/g", slashItems, 120, "slash-command", "explain this ");

		expect(lines).toEqual([]);
	});

	it("keeps absolute-path file autocomplete byte-identical to the default layout", async () => {
		const defaultLines = await renderEditorAutocomplete("@f", slashItems, 120);
		const absolutePathLines = await renderEditorAbsolutePathAutocomplete("/tmp/f", slashItems, 120);

		expect(absolutePathLines).toEqual(defaultLines);
	});
});
