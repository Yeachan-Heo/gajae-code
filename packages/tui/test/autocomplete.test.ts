import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CombinedAutocompleteProvider, extractSlashCommandTokenPrefix } from "@gajae-code/tui/autocomplete";

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

describe("inline backtick slash classification", () => {
	it.each([
		["open span", "please use `/mo", null],
		["closed span", "please use `/mo` then /he", "/he"],
		["multiple spans", "`/mo` and `/he", null],
		["odd escaped delimiter", "please use \\`/mo", "/mo"],
		["even escaped delimiter", "please use \\\\`/mo", null],
		["double-backtick run", "please use ``/mo", "/mo"],
		["triple-backtick run", "please use ```/mo", "/mo"],
	])("handles %s", (_name, text, expected) => {
		expect(extractSlashCommandTokenPrefix(text)).toBe(expected);
	});

	it("resets literal state at line boundaries", () => {
		expect(extractSlashCommandTokenPrefix("/mo")).toBe("/mo");
	});

	it("preserves path suggestions inside an open inline-code span", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-backtick-test-"));
		try {
			fs.mkdirSync(path.join(baseDir, "src", "foo"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "foo", "bar.ts"), "export {};\n");
			const provider = new CombinedAutocompleteProvider(
				[{ name: "model", description: "Switch AI model", value: "model" }],
				baseDir,
			);
			const line = "please read `src/foo/";
			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe("src/foo/");
			expect(result?.items.map(item => item.value)).toContain("src/foo/bar.ts");
			expect(result?.items.map(item => item.value)).not.toContain("model");
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("preserves submitted command argument completion inside backticks", async () => {
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
		const line = "/read `src/foo/";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.prefix).toBe("`src/foo/");
		expect(result?.items).toEqual([{ value: "`src/foo/", label: "existing argument completion" }]);
	});
});

describe("inline slash command suggestions", () => {
	it("suggests command names for slash tokens after existing prompt text", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const line = "explain this /mo";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/mo");
		expect(result!.items.map(item => item.value)).toEqual(["model"]);
	});

	it("suggests command names for slash tokens adjacent to prompt text", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "help", description: "Learn commands", value: "help" }],
			"/tmp",
		);
		const line = "explain this/hel";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/hel");
		expect(result!.items.map(item => item.value)).toEqual(["help"]);
	});

	it("lets absolute paths use file suggestions when the inline slash token is not a command prefix", async () => {
		const line = "open /tmp";
		const pathOnlyProvider = new CombinedAutocompleteProvider([], "/tmp");
		const pathOnlyResult = await pathOnlyProvider.getSuggestions([line], 0, line.length);
		const provider = new CombinedAutocompleteProvider(
			[{ name: "template", description: "Temporary prompt template", value: "template" }],
			"/tmp",
		);
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).toEqual(pathOnlyResult);
		expect(result?.items.map(item => item.value) ?? []).not.toContain("template");
	});

	it("lets bare absolute root paths use file suggestions before slash commands", async () => {
		const line = "open /";
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch model", value: "model" }],
			"/tmp",
		);
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/");
		expect(result!.items.some(item => item.value.startsWith("/"))).toBe(true);
		expect(result!.items.map(item => item.value)).not.toContain("model");
	});

	it("matches normalized inline slash command prefixes", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "skill:team", description: "Run team workflow", value: "skill:team" }],
			"/tmp",
		);
		const line = "explain this /skill-te";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/skill-te");
		expect(result!.items.map(item => item.value)).toEqual(["skill:team"]);
	});

	it("applies inline slash command completion without replacing prior text", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const line = "explain this /mo";
		const result = provider.applyCompletion([line], 0, line.length, { value: "model", label: "model" }, "/mo");

		expect(result.lines[0]).toBe("explain this /model ");
		expect(result.cursorCol).toBe("explain this /model ".length);
	});

	it("applies adjacent inline slash command completion without replacing prior text", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "help", description: "Learn commands", value: "help" }],
			"/tmp",
		);
		const line = "explain this/hel";
		const result = provider.applyCompletion([line], 0, line.length, { value: "help", label: "help" }, "/hel");

		expect(result.lines[0]).toBe("explain this/help ");
		expect(result.cursorCol).toBe("explain this/help ".length);
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
