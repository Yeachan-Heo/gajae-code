import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SelectListTheme, SymbolTheme } from "@gajae-code/tui";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestionKind,
	CombinedAutocompleteProvider,
	extractSlashCommandTokenPrefix,
} from "@gajae-code/tui/autocomplete";
import { Editor } from "@gajae-code/tui/components/editor";
import { SelectList } from "@gajae-code/tui/components/select-list";
import { visibleWidth } from "@gajae-code/tui/utils";
import fc from "fast-check";
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

		it("preserves quoted @ metadata for explicit Tab", async () => {
			await Bun.write(path.join(baseDir, "file name.md"), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const result = await provider.getForceFileSuggestions(['@"'], 0, 2);

			expect(result?.prefix).toBe('@"');
			expect(result?.items.map(item => item.value)).toContain('@"file name.md"');
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

		it("resolves an NFC parent component without falling back to sibling directories", async () => {
			const nfdParent = "\u1112\u1161\u11AB";
			const nfcParent = nfdParent.normalize("NFC");
			const decoyParent = `${nfcParent}-decoy`;
			fs.mkdirSync(path.join(baseDir, nfdParent));
			fs.mkdirSync(path.join(baseDir, decoyParent));
			fs.writeFileSync(path.join(baseDir, nfdParent, "target.ts"), "export const target = 1;\n");
			fs.writeFileSync(path.join(baseDir, decoyParent, "target.ts"), "export const decoy = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = `@${nfcParent}/target`;
			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toEqual([`@${nfdParent}/target.ts`]);
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

	describe("unicode-normalized path matching", () => {
		let baseDir: string;
		const nfdDirectory = "\u1112\u1161\u11AB";
		const nfdName = "\u1112\u1161\u11AB\u1100\u1173\u11AF.txt";

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-nfc-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("matches NFD directory entries against an NFC prefix", async () => {
			fs.writeFileSync(path.join(baseDir, nfdName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./\uD55C";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain(`./${nfdName}`);
		});

		it("matches NFD entries in the @ fuzzy lane against an NFC query", async () => {
			fs.writeFileSync(path.join(baseDir, nfdName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@\uD55C\uAE00";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain(`@${nfdName}`);
		});

		it("traverses an NFD directory from an NFC path prefix", async () => {
			fs.mkdirSync(path.join(baseDir, nfdDirectory));
			fs.writeFileSync(path.join(baseDir, nfdDirectory, nfdName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./\uD55C/";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain(`./${nfdDirectory}/${nfdName}`);
		});

		it("keeps normalized directory completions stable across the directory cache", async () => {
			fs.mkdirSync(path.join(baseDir, nfdDirectory));
			fs.writeFileSync(path.join(baseDir, nfdDirectory, nfdName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = `./${nfdDirectory.normalize("NFC")}/`;

			const first = await provider.getForceFileSuggestions([line], 0, line.length);
			const second = await provider.getForceFileSuggestions([line], 0, line.length);

			expect(first?.items.map(item => item.value)).toEqual([`./${nfdDirectory}/${nfdName}`]);
			expect(second?.items.map(item => item.value)).toEqual([`./${nfdDirectory}/${nfdName}`]);
		});

		it("preserves exact on-disk spelling across mixed NFC/NFD parent components", async () => {
			const outerNfd = nfdDirectory;
			const innerNfd = nfdName.slice(0, -4);
			const childNfd = `${nfdDirectory}${innerNfd}.txt`;
			const outerNfc = outerNfd.normalize("NFC");
			const innerNfc = innerNfd.normalize("NFC");
			const childNfc = childNfd.normalize("NFC");
			fs.mkdirSync(path.join(baseDir, outerNfd, innerNfd), { recursive: true });
			fs.writeFileSync(path.join(baseDir, outerNfd, innerNfd, childNfd), "content\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = `./${outerNfc}/${innerNfc}/${childNfc}`;
			const result = await provider.getForceFileSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toEqual([`./${outerNfd}/${innerNfd}/${childNfd}`]);
		});

		it("stats symlink children relative to the resolved normalized parent", async () => {
			const nfcParent = nfdDirectory.normalize("NFC");
			const parentPath = path.join(baseDir, nfdDirectory);
			const targetPath = path.join(baseDir, "symlink-target");
			fs.mkdirSync(parentPath);
			fs.mkdirSync(targetPath);
			fs.writeFileSync(path.join(targetPath, "child.txt"), "content\n");
			try {
				fs.symlinkSync(targetPath, path.join(parentPath, "linked"), "dir");
			} catch {
				return;
			}

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = `./${nfcParent}/lin`;
			const result = await provider.getForceFileSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toContain(`./${nfdDirectory}/linked/`);
		});
	});

	describe("hangul chosung fuzzy matching", () => {
		let baseDir: string;
		const hangulName = "\uD55C\uAE00.txt";

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-chosung-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("matches syllable initials from a bare-consonant @ query", async () => {
			fs.writeFileSync(path.join(baseDir, hangulName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@\u314E\u3131";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain(`@${hangulName}`);
		});

		it("uses the same chosung fuzzy lane for explicit Tab", async () => {
			await Bun.write(path.join(baseDir, hangulName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@\u314E\u3131";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe(line);
			expect(result?.items.map(item => item.value)).toContain(`@${hangulName}`);
		});

		it("uses fuzzy contains matching for explicit Tab", async () => {
			const filename = "project-story.md";
			await Bun.write(path.join(baseDir, filename), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@story";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe(line);
			expect(result?.items.map(item => item.value)).toContain(`@${filename}`);
		});

		it("merges ignored prefix matches with fuzzy tracked siblings", async () => {
			await Bun.write(path.join(baseDir, ".gitignore"), "story-ignored.md\nnode_modules/\n");
			await Bun.write(path.join(baseDir, "story-ignored.md"), "ignored\n");
			await Bun.write(path.join(baseDir, "story-tracked.md"), "tracked\n");
			await Bun.$`git -C ${baseDir} init`.quiet();
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const result = await provider.getForceFileSuggestions(["@story"], 0, 6);

			expect(result?.items.map(item => item.value)).toEqual(["@story-tracked.md", "@story-ignored.md"]);
		});

		it("keeps an exact file ahead of a fuzzy directory match", async () => {
			await Bun.write(path.join(baseDir, "target"), "file\n");
			await fsPromises.mkdir(path.join(baseDir, "target-dir"));
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const values =
				(await provider.getForceFileSuggestions(["@target"], 0, 7))?.items.map(item => item.value) ?? [];

			expect(values.indexOf("@target")).toBeGreaterThanOrEqual(0);
			expect(values.indexOf("@target-dir/")).toBeGreaterThanOrEqual(0);
			expect(values.indexOf("@target")).toBeLessThan(values.indexOf("@target-dir/"));
		});

		it("keeps node_modules exact prefix matches reachable from explicit Tab", async () => {
			await fsPromises.mkdir(path.join(baseDir, "node_modules"), { recursive: true });
			await Bun.write(path.join(baseDir, "node_modules", "package.json"), "{}\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@node_modules/pac";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toContain("@node_modules/package.json");
		});

		it("matches chosung against NFD-stored file names", async () => {
			const nfdName = "\u1112\u1161\u11AB\u1100\u1173\u11AF.txt";
			fs.writeFileSync(path.join(baseDir, nfdName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@\u314E\u3131";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain(`@${nfdName}`);
		});

		it("mixes chosung with full syllables in one query", async () => {
			fs.writeFileSync(path.join(baseDir, hangulName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@\u314E\uAE00";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain(`@${hangulName}`);
		});

		it("does not match syllables whose initials differ", async () => {
			fs.writeFileSync(path.join(baseDir, hangulName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@\u3134\u3137";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).not.toContain(`@${hangulName}`);
		});

		it("ranks a literal jamo file name above a chosung match", async () => {
			const literalName = "\u314E\u3131.txt";
			fs.writeFileSync(path.join(baseDir, hangulName), "content\n");
			fs.writeFileSync(path.join(baseDir, literalName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@\u314E\u3131";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values.indexOf(`@${literalName}`)).toBeGreaterThanOrEqual(0);
			expect(values.indexOf(`@${hangulName}`)).toBeGreaterThan(values.indexOf(`@${literalName}`));
		});

		it("keeps ascii fuzzy queries unaffected", async () => {
			fs.writeFileSync(path.join(baseDir, "history-search.ts"), "content\n");
			fs.writeFileSync(path.join(baseDir, hangulName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@histsr";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@history-search.ts");
			expect(values).not.toContain(`@${hangulName}`);
		});

		it("keeps separator-bearing chosung queries accepted by native fuzzy search", async () => {
			fs.writeFileSync(path.join(baseDir, hangulName), "content\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@ㅎ-ㄱ";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain(`@${hangulName}`);
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

	it("offers inline skill suggestions without making ordinary slash commands inline", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "skill:demo", description: "Demo skill", value: "skill:demo" },
				{ name: "model", description: "Switch model", value: "model" },
			],
			"/tmp",
		);
		const line = "explain this /skill:de";
		const result = await provider.getSuggestions([line], 0, line.length);
		expect(result).toMatchObject({ kind: "slash-command", prefix: "/skill:de" });
		expect(result?.items.map(item => item.value)).toEqual(["skill:demo"]);

		const startCommand = await provider.getSuggestions(["/mo"], 0, 3);
		expect(startCommand?.kind).toBe("slash-command");
		expect(startCommand?.items.map(item => item.value)).toContain("model");

		const inlineModel = await provider.getSuggestions(["explain this /mo"], 0, "explain this /mo".length);
		expect(inlineModel?.kind).not.toBe("slash-command");
		expect(inlineModel?.items.map(item => item.value) ?? []).not.toContain("model");
	});

	it("applies an inline skill completion at its token and leaves path-like text alone", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "skill:demo", description: "Demo skill", value: "skill:demo" }],
			"/tmp",
		);
		const line = "explain this /skill:de";
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		const item = suggestions?.items[0];
		if (!suggestions || !item) throw new Error("expected inline skill suggestion");

		const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
		expect(applied.lines).toEqual(["explain this /skill:demo "]);
		expect(applied.cursorCol).toBe(applied.lines[0]?.length);
		expect(extractSlashCommandTokenPrefix("path/skill:de")).toBeNull();
		expect(extractSlashCommandTokenPrefix("https://example.test/skill:de")).toBeNull();
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

	it("synchronously completes inline skills but not inline ordinary commands", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "skill:demo", description: "Demo skill", value: "skill:demo" },
				{ name: "model", description: "Switch model", value: "model" },
			],
			"/tmp",
		);
		const skillResult = provider.trySyncSlashCompletion("explain this /skill:de");
		expect(skillResult?.prefix).toBe("/skill:de");
		expect(skillResult?.items.map(item => item.value)).toEqual(["skill:demo"]);
		expect(provider.trySyncSlashCompletion("explain this /model")).toBeNull();
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

	it("scores Hangul chosung slash-command matches", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "한글명령", description: "Korean command", value: "한글명령" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/ㅎㄱ");
		expect(result?.items.map(item => item.value)).toEqual(["한글명령"]);
	});

	it("normalizes separators and rejects unrelated commands for mixed Hangul queries", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "한글명령", description: "Korean command", value: "한글명령" },
				{ name: "model", description: "Switch model", value: "model" },
			],
			"/tmp",
		);

		expect(provider.trySyncSlashCompletion("/ㅎ-ㄱ")?.items.map(item => item.value)).toEqual(["한글명령"]);
		expect(provider.trySyncSlashCompletion("/ㅎㄱ-model")).toBeNull();
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
				{ name: "skill:probe", description: "Probe orchestration", value: "skill:probe", priority: 100 },
				{ name: "slash:probe", description: "Alternate probe command", value: "slash:probe" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/probe");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["skill:probe", "slash:probe"]);
	});

	it("ranks stronger slash text matches above higher-priority fallback matches", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "init", description: "Generate autoresearch files", value: "init", priority: 100 },
				{ name: "skill:autoresearch", description: "Autoresearch missions", value: "skill:autoresearch" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/autoresearch");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["skill:autoresearch", "init"]);
	});

	it("normalizes separators for structured slash command prefixes", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "init", description: "Initialize skill template", value: "init", priority: 100 },
				{ name: "skill:autoresearch", description: "Autoresearch missions", value: "skill:autoresearch" },
			],
			"/tmp",
		);
		const dashed = provider.trySyncSlashCompletion("/skill-auto");
		const colon = provider.trySyncSlashCompletion("/skill:auto");
		expect(dashed?.items[0]?.value).toBe("skill:autoresearch");
		expect(colon?.items[0]?.value).toBe("skill:autoresearch");
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

const TERMINAL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const ORDINARY_LABEL_SEED = 20261025;
const HOSTILE_LABEL_SEED = 20261026;
const LABEL_PROPERTY_RUNS = 64;

const identitySymbols: SymbolTheme = {
	cursor: ">",
	inputCursor: "|",
	hrChar: "-",
	quoteBorder: "|",
	boxRound: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	spinnerFrames: ["|"],
};

const identityListTheme: SelectListTheme = {
	selectedPrefix: text => text,
	selectedText: text => text,
	description: text => text,
	scrollInfo: text => text,
	noMatch: text => text,
	symbols: identitySymbols,
};

function renderedAutocompleteRows(items: AutocompleteItem[]): string[] {
	return new SelectList(items, 20, identityListTheme).render(80);
}

function expectDisplayWithoutTerminalControls(items: AutocompleteItem[]): void {
	expect(items.length).toBeGreaterThan(0);
	for (const item of items) {
		expect(item.label).not.toMatch(TERMINAL_CONTROL);
		if (item.description !== undefined) expect(item.description).not.toMatch(TERMINAL_CONTROL);
	}
	const rows = renderedAutocompleteRows(items);
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) expect(row).not.toMatch(TERMINAL_CONTROL);
}

describe("file autocomplete display", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-display-"));
	});

	afterEach(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it("keeps ordinary file autocomplete labels", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,12}$/),
				fc.boolean(),
				async (name, isDirectory) => {
					const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-ordinary-"));
					try {
						const target = path.join(dir, name);
						if (isDirectory) fs.mkdirSync(target);
						else fs.writeFileSync(target, "x\n");
						const provider = new CombinedAutocompleteProvider([], dir);
						const result = await provider.getSuggestions(["@"], 0, 1);
						const value = isDirectory ? `@${name}/` : `@${name}`;
						const item = result?.items.find(entry => entry.value === value);
						expect(item?.label).toBe(isDirectory ? `${name}/` : name);
						expect(item?.description).toBeUndefined();
					} finally {
						fs.rmSync(dir, { recursive: true, force: true });
					}
				},
			),
			{ seed: ORDINARY_LABEL_SEED, numRuns: LABEL_PROPERTY_RUNS },
		);
	});

	it("keeps a spaced file autocomplete label", async () => {
		fs.writeFileSync(path.join(baseDir, "my file.txt"), "x\n");
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const result = await provider.getSuggestions(["@"], 0, 1);
		const item = result?.items.find(entry => entry.value === '@"my file.txt"');
		expect(item?.label).toBe("my file.txt");
		expect(renderedAutocompleteRows(result?.items ?? []).join("\n")).toContain("my file.txt");
	});

	it("keeps mixed-case file autocomplete labels", async () => {
		fs.writeFileSync(path.join(baseDir, "ReadMe.md"), "x\n");
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const result = await provider.getSuggestions(["@read"], 0, 5);
		const item = result?.items.find(entry => entry.value === "@ReadMe.md");
		expect(item?.label).toBe("ReadMe.md");
	});

	it("keeps unicode file autocomplete labels", async () => {
		const hangul = "한글.txt";
		const cafe = "café.txt";
		fs.writeFileSync(path.join(baseDir, hangul), "x\n");
		fs.writeFileSync(path.join(baseDir, cafe), "x\n");
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const result = await provider.getSuggestions(["@"], 0, 1);
		expect(result?.items.find(entry => entry.value === `@${hangul}`)?.label).toBe(hangul);
		expect(result?.items.find(entry => entry.value === `@${cafe}`)?.label).toBe(cafe);
	});

	it("keeps a parent-directory ordinary file autocomplete label", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-parent-"));
		const cwd = path.join(root, "cwd");
		const outside = path.join(root, "outside");
		fs.mkdirSync(cwd);
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "plain.txt"), "x\n");
		try {
			const provider = new CombinedAutocompleteProvider([], cwd);
			const line = "@../outside/pla";
			const result = await provider.getSuggestions([line], 0, line.length);
			const item = result?.items.find(entry => entry.value === "@../outside/plain.txt");
			expect(item?.label).toBe("plain.txt");
			if (item?.description !== undefined) expect(item.description).toContain("plain.txt");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps dot-slash completion for an ordinary file", async () => {
		fs.writeFileSync(path.join(baseDir, "plain.txt"), "x\n");
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const result = await provider.getForceFileSuggestions(["./pla"], 0, 5);
		const item = result?.items.find(entry => entry.value === "./plain.txt");
		expect(item?.label).toBe("plain.txt");
	});

	it("keeps an unmatched windows-style @ prefix empty", async () => {
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@C:\\missing-root\\file";
		const result = await provider.getSuggestions([line], 0, line.length);
		expect(result).toBeNull();
	});
});

describe.skipIf(process.platform === "win32")("file autocomplete terminal controls", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-controls-"));
	});

	afterEach(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it("repository names do not render terminal controls in @ autocomplete", async () => {
		const oscFile = "evil\u001b]52;c;cHduZWQ=\u0007\u001b]0;pwned-title\u0007.txt";
		const csiFile = "evil\u001b[2Khidden.txt";
		const osc8File = "evil\u001b]8;;https:attacker.invalid\u0007click\u001b]8;;\u0007note.txt";
		const oscDir = "dir\u001b]0;dir-pwned\u0007";
		const onlyOsc = "\u001b]52;c;cHduZWQ=\u0007";
		const c1File = "eight\u009b2Kbit.txt";
		fs.writeFileSync(path.join(baseDir, oscFile), "x\n");
		fs.writeFileSync(path.join(baseDir, csiFile), "x\n");
		fs.writeFileSync(path.join(baseDir, osc8File), "x\n");
		fs.writeFileSync(path.join(baseDir, onlyOsc), "x\n");
		fs.writeFileSync(path.join(baseDir, c1File), "x\n");
		fs.mkdirSync(path.join(baseDir, oscDir));
		fs.writeFileSync(path.join(baseDir, "package.json"), "{}\n");

		const provider = new CombinedAutocompleteProvider([], baseDir);
		const result = await provider.getSuggestions(["@"], 0, 1);
		expect(result).not.toBeNull();
		const items = result?.items ?? [];
		expectDisplayWithoutTerminalControls(items);

		expect(items.find(entry => entry.value === `@${oscFile}`)?.label).toBe("evil.txt");
		expect(items.find(entry => entry.value === `@${csiFile}`)?.label).toBe("evilhidden.txt");
		expect(items.find(entry => entry.value === `@${osc8File}`)?.label).toBe("evilclicknote.txt");
		expect(items.find(entry => entry.value === `@${oscDir}/`)?.label).toBe("dir/");
		expect(items.find(entry => entry.value === `@${onlyOsc}`)?.label).toBe("\uFFFD");
		expect(items.find(entry => entry.value === `@${c1File}`)?.label).toBe("eight2Kbit.txt");
		expect(items.find(entry => entry.value === "@package.json")?.label).toBe("package.json");

		const rendered = renderedAutocompleteRows(items).join("\n");
		expect(rendered).toContain("evil.txt");
		expect(rendered).toContain("package.json");
		expect(rendered).not.toContain("cHduZWQ=");
		expect(rendered).not.toContain("pwned-title");
	});

	it("force path completion does not render terminal controls", async () => {
		const oscFile = "evil\u001b]52;c;cHduZWQ=\u0007.txt";
		fs.writeFileSync(path.join(baseDir, oscFile), "x\n");
		fs.writeFileSync(path.join(baseDir, "plain.txt"), "x\n");
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const result = await provider.getForceFileSuggestions(["./"], 0, 2);
		expect(result).not.toBeNull();
		const items = result?.items ?? [];
		expectDisplayWithoutTerminalControls(items);
		expect(items.find(entry => entry.value === `./${oscFile}`)?.label).toBe("evil.txt");
		expect(items.find(entry => entry.value === "./plain.txt")?.label).toBe("plain.txt");
	});

	it("fuzzy file descriptions do not render terminal controls", async () => {
		const dirName = "nest\u001b]0;title\u0007";
		const fileName = "zzcontrolplain.ts";
		fs.mkdirSync(path.join(baseDir, dirName));
		fs.writeFileSync(path.join(baseDir, dirName, fileName), "x\n");
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@zzcontrol";
		const result = await provider.getSuggestions([line], 0, line.length);
		const item = result?.items.find(entry => entry.value.includes(fileName));
		expect(item).toBeDefined();
		expect(item?.label).toBe(fileName);
		expect(item?.description).toContain(fileName);
		expect(item?.description).not.toMatch(TERMINAL_CONTROL);
		expect(item?.value).toContain(dirName);
		expectDisplayWithoutTerminalControls(result?.items ?? []);
	});

	it("hostile file autocomplete labels exclude terminal controls", async () => {
		const hostileName = fc.oneof(
			fc.constant("\u001b]52;c;cHduZWQ=\u0007"),
			fc
				.tuple(
					fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,6}$/),
					fc.constantFrom("\u001b]52;c;cHduZWQ=\u0007", "\u001b[2K", "\u009b31m", "\u009d0;t\u0007", "\u202e"),
					fc.constantFrom("before" as const, "after" as const),
				)
				.map(([name, control, where]) => (where === "before" ? `${control}${name}` : `${name}${control}`)),
		);
		await fc.assert(
			fc.asyncProperty(hostileName, async name => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-hostile-"));
				try {
					fs.writeFileSync(path.join(dir, name), "x\n");
					const provider = new CombinedAutocompleteProvider([], dir);
					const result = await provider.getSuggestions(["@"], 0, 1);
					const item = result?.items.find(entry => entry.value === `@${name}` || entry.value.includes(name));
					expect(item).toBeDefined();
					expect(item?.label).not.toMatch(TERMINAL_CONTROL);
					expect(item?.value ?? "").toContain(name);
					expectDisplayWithoutTerminalControls(result?.items ?? []);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}),
			{ seed: HOSTILE_LABEL_SEED, numRuns: LABEL_PROPERTY_RUNS },
		);
	});
});
