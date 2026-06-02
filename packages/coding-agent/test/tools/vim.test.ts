import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { resetVimRendererStateForTest, VimTool, vimToolRenderer } from "@gajae-code/coding-agent/tools/vim";
import { VimBuffer } from "@gajae-code/coding-agent/vim/buffer";
import { VimEngine } from "@gajae-code/coding-agent/vim/engine";
import { parseKeySequences } from "@gajae-code/coding-agent/vim/parser";
import type { TUI } from "@gajae-code/tui";

function textResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n");
}

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "lsp.enabled": false }),
		...overrides,
	};
}

function createEngine(text: string): VimEngine {
	return new VimEngine(
		new VimBuffer({
			absolutePath: "/tmp/test.ts",
			displayPath: "test.ts",
			lines: text.split("\n"),
			trailingNewline: false,
			fingerprint: null,
		}),
		{
			beforeMutate: async () => {},
			loadBuffer: async inputPath => ({
				absolutePath: inputPath,
				displayPath: inputPath,
				lines: [""],
				trailingNewline: false,
				fingerprint: null,
			}),
			saveBuffer: async buffer => ({
				loaded: {
					absolutePath: buffer.filePath,
					displayPath: buffer.displayPath,
					lines: [...buffer.lines],
					trailingNewline: buffer.trailingNewline,
					fingerprint: null,
				},
			}),
		},
	);
}

function step(kbd: string[], insert?: string): { kbd: string[]; insert?: string } {
	return insert === undefined ? { kbd } : { kbd, insert };
}

afterEach(() => {
	vi.restoreAllMocks();
	resetVimRendererStateForTest();
});

describe("vim parser", () => {
	it("parses literal and special keys in order", () => {
		const tokens = parseKeySequences(["ciwnewName<Esc>", ":w<CR>"]);
		expect(tokens.map(token => token.value)).toEqual([
			"c",
			"i",
			"w",
			"n",
			"e",
			"w",
			"N",
			"a",
			"m",
			"e",
			"Esc",
			":",
			"w",
			"CR",
		]);
	});

	it("handles literal escape byte and carriage return", () => {
		const tokens = parseKeySequences(["itest\x1b", ":w\r"]);
		expect(tokens.map(token => token.value)).toEqual(["i", "t", "e", "s", "t", "Esc", ":", "w", "CR"]);
	});

	it("handles backslash-r and backslash-e as CR and Esc", () => {
		// Models often send \r as two chars (backslash + r) instead of a real CR byte
		const tokens = parseKeySequences([":w\\r", "ciwnew\\e"]);
		expect(tokens.map(token => token.value)).toEqual([":", "w", "CR", "c", "i", "w", "n", "e", "w", "Esc"]);
	});
});

describe("vim engine", () => {
	it("repeats the last change with dot", async () => {
		const engine = createEngine("foo foo");
		await engine.executeTokens(parseKeySequences(["ciwbar<Esc>", "w", "."]), "ciwbar<Esc> w .");
		expect(engine.buffer.getText()).toBe("bar bar");
	});

	it("streams dot-repeat replays through the step callback", async () => {
		const engine = createEngine("foo foo");
		await engine.executeTokens(parseKeySequences(["ciwbar<Esc>", "w"]), "ciwbar<Esc> w");

		const snapshots: string[] = [];
		await engine.executeTokens(parseKeySequences(["."]), ".", async () => {
			snapshots.push(`${engine.getPublicMode()}|${engine.buffer.cursor.col}|${engine.buffer.getText()}`);
		});

		expect(engine.buffer.getText()).toBe("bar bar");
		expect(snapshots.length).toBeGreaterThan(1);
		expect(snapshots.some(snapshot => snapshot.startsWith("INSERT|"))).toBe(true);
	});

	it("deletes lines and supports undo/redo", async () => {
		const engine = createEngine("one\ntwo\nthree\nfour");
		await engine.executeTokens(parseKeySequences(["2G", "2dd"]), "2G 2dd");
		expect(engine.buffer.getText()).toBe("one\nfour");
		await engine.executeTokens(parseKeySequences(["u"]), "u");
		expect(engine.buffer.getText()).toBe("one\ntwo\nthree\nfour");
		await engine.executeTokens(parseKeySequences(["<C-r>"]), "<C-r>");
		expect(engine.buffer.getText()).toBe("one\nfour");
	});

	it("surfaces undo counts in the status message", async () => {
		const engine = createEngine("alpha beta gamma");
		await engine.executeTokens(parseKeySequences(["dw", "dw"]), "dw dw");
		await engine.executeTokens(parseKeySequences(["2u"]), "2u");
		expect(engine.buffer.getText()).toBe("alpha beta gamma");
		expect(engine.statusMessage).toBe("Undid 2 changes");
	});

	it("accepts doubled indent operators in visual mode", async () => {
		const engine = createEngine("one\ntwo\nthree");
		await engine.executeTokens(parseKeySequences(["Vj>>"]), "Vj>>");
		expect(engine.buffer.getText()).toBe("\tone\n\ttwo\nthree");
	});

	it("applies file-wide substitution through ex commands", async () => {
		const engine = createEngine("alpha beta\nalpha gamma");
		await engine.executeTokens(parseKeySequences([":%s/alpha/delta/g<CR>"]), ":%s/alpha/delta/g<CR>");
		expect(engine.buffer.getText()).toBe("delta beta\ndelta gamma");
		expect(engine.statusMessage).toContain("2 substitution");
	});

	it("deletes all lines with :%d", async () => {
		const engine = createEngine("line one\nline two\nline three");
		await engine.executeTokens(parseKeySequences([":%d<CR>"]), ":%d<CR>");
		expect(engine.buffer.getText()).toBe("");
		expect(engine.statusMessage).toBe("Deleted 3 lines");
	});

	it("supports explicit numeric ex ranges like :4,6d", async () => {
		const engine = createEngine("one\ntwo\nthree\nfour\nfive\nsix\nseven");
		await engine.executeTokens(parseKeySequences([":4,6d<CR>"]), ":4,6d<CR>");
		expect(engine.buffer.getText()).toBe("one\ntwo\nthree\nseven");
		expect(engine.statusMessage).toBe("Deleted 3 lines");
	});

	it("supports current and last-line ex addresses plus ranged :global", async () => {
		const engine = createEngine("alpha\nkeep\nalpha\ntrim alpha\nfinal alpha");
		await engine.executeTokens(parseKeySequences(["2G", ":.,$g/alpha/d<CR>"]), "2G :.,$g/alpha/d<CR>");
		expect(engine.buffer.getText()).toBe("alpha\nkeep");
		expect(engine.statusMessage).toBe("Global: processed alpha");
	});

	it("supports :join aliases with whitespace normalization", async () => {
		const engine = createEngine("alpha \n beta\ngamma");
		await engine.executeTokens(parseKeySequences([":1,2j<CR>"]), ":1,2j<CR>");
		expect(engine.buffer.getText()).toBe("alpha beta\ngamma");
		expect(engine.statusMessage).toBe("Joined 2 lines");
	});

	it("supports :join! aliases without whitespace normalization", async () => {
		const engine = createEngine("alpha \n beta\ngamma");
		await engine.executeTokens(parseKeySequences([":1,2join!<CR>"]), ":1,2join!<CR>");
		expect(engine.buffer.getText()).toBe("alpha  beta\ngamma");
		expect(engine.statusMessage).toBe("Joined 2 lines");
	});
	it("supports destination addresses for :copy", async () => {
		const engine = createEngine("one\ntwo\nthree\nfour");
		await engine.executeTokens(parseKeySequences([":1,2t$<CR>"]), ":1,2t$<CR>");
		expect(engine.buffer.getText()).toBe("one\ntwo\nthree\nfour\none\ntwo");
		expect(engine.statusMessage).toBe("Copied 2 lines");
	});

	it("yanks addressed lines and puts them before or after the anchor line", async () => {
		const engine = createEngine("one\ntwo\nthree\nfour");
		await engine.executeTokens(
			parseKeySequences([":2,3yank<CR>", "1G", ":put<CR>", "G", ":put!<CR>"]),
			":2,3yank<CR> 1G :put<CR> G :put!<CR>",
		);
		expect(engine.buffer.getText()).toBe("one\ntwo\nthree\ntwo\nthree\ntwo\nthree\nfour");
		expect(engine.statusMessage).toBe("Put 2 lines");
	});

	it("treats :update as a no-op for clean buffers and writes modified buffers", async () => {
		const saveBuffer = vi.fn(async (buffer: VimBuffer) => ({
			loaded: {
				absolutePath: buffer.filePath,
				displayPath: buffer.displayPath,
				lines: [...buffer.lines],
				trailingNewline: buffer.trailingNewline,
				fingerprint: null,
			},
		}));
		const engine = new VimEngine(
			new VimBuffer({
				absolutePath: "/tmp/test.ts",
				displayPath: "test.ts",
				lines: ["alpha"],
				trailingNewline: false,
				fingerprint: null,
			}),
			{
				beforeMutate: async () => {},
				loadBuffer: async inputPath => ({
					absolutePath: inputPath,
					displayPath: inputPath,
					lines: [""],
					trailingNewline: false,
					fingerprint: null,
				}),
				saveBuffer,
			},
		);

		await engine.executeTokens(parseKeySequences([":up<CR>"]), ":up<CR>");
		expect(saveBuffer).not.toHaveBeenCalled();
		expect(engine.statusMessage).toBe("test.ts unchanged");

		await engine.executeTokens(parseKeySequences(["ccchanged<Esc>", ":up<CR>"]), "ccchanged<Esc> :up<CR>");
		expect(saveBuffer).toHaveBeenCalledTimes(1);
		expect(engine.buffer.getText()).toBe("changed");
		expect(engine.statusMessage).toBe("Wrote test.ts");
	});

	it("renders literal spaces visibly in unsupported command errors", async () => {
		const engine = createEngine("alpha");
		await expect(engine.executeTokens(parseKeySequences(["z "]), "z ")).rejects.toThrow(/z<Space>/);
	});
});

describe("vim tool", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vim-tool-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	it("opens, edits, saves, and persists content", async () => {
		const filePath = path.join(tmpDir, "sample.ts");
		await Bun.write(filePath, "foo = 1;\nfoo = foo + 1;\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "sample.ts" });
		await tool.execute("edit", { file: "sample.ts", steps: [step(["ciwbar<Esc>", "j", "."])] });
		await tool.execute("save", { file: "sample.ts", steps: [step([":w<CR>"])] });

		const saved = await Bun.file(filePath).text();
		expect(saved).toContain("bar = 1;");
		expect(saved).toContain("bar = foo + 1;");
	});

	it("keeps the cursor line visible after large jumps", async () => {
		const filePath = path.join(tmpDir, "long.ts");
		await Bun.write(filePath, Array.from({ length: 1100 }, (_, index) => `line ${index + 1};`).join("\n"));
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "long.ts" });
		const moved = await tool.execute("jump", { file: "long.ts", steps: [step(["1014G"])] });
		const text = textResult(moved);
		expect(text).toContain(">1014│line 1014;");
		expect(moved.details?.cursor.line).toBe(1014);
	});

	it("centers the viewport on the cursor after a large edit", async () => {
		const filePath = path.join(tmpDir, "center.ts");
		await Bun.write(filePath, Array.from({ length: 500 }, (_, index) => `line ${index + 1};`).join("\n"));
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "center.ts" });
		const edited = await tool.execute("edit", {
			file: "center.ts",
			steps: [step(["386Go"], "inserted")],
			pause: true,
		});
		expect(edited.details?.cursor.line).toBe(387);
		expect(edited.details?.viewport.start).toBe(382);
		expect(edited.details?.viewport.end).toBe(391);
		expect(textResult(edited)).toContain("Diff:");
		expect(textResult(edited)).toContain("+inserted");
	});

	it("recenters the viewport and includes a diff after edits", async () => {
		const filePath = path.join(tmpDir, "long-edit.ts");
		await Bun.write(filePath, Array.from({ length: 1100 }, (_, index) => `line ${index + 1};`).join("\n"));
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "long-edit.ts" });
		const edited = await tool.execute("edit", { file: "long-edit.ts", steps: [step(["1014G", "o"], "inserted")] });
		const text = textResult(edited);
		expect(edited.details?.cursor.line).toBe(1015);
		expect(edited.details?.viewport.start).toBe(1010);
		expect(text).toContain("Diff:");
		expect(text).toContain("+inserted");
	});

	it("supports raw insert payloads after kbd enters insert mode", async () => {
		const filePath = path.join(tmpDir, "replace.ts");
		await Bun.write(filePath, "first\nsecond\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "replace.ts" });
		const replaced = await tool.execute("replace", { file: "replace.ts", steps: [step(["cc"], "alpha\nbeta")] });
		await tool.execute("save", { file: "replace.ts", steps: [step([":w<CR>"])] });

		const saved = await Bun.file(filePath).text();
		expect(saved).toBe("alpha\nbeta\nsecond\n");
		expect(textResult(replaced)).toContain("Diff:");
		expect(textResult(replaced)).toContain("+beta");
	});

	it("applies multi-step inserts at different locations", async () => {
		const filePath = path.join(tmpDir, "multi-step.ts");
		await Bun.write(filePath, "import sys\n\ndef main():\n    pass\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "multi-step.ts" });
		const edited = await tool.execute("edit", {
			file: "multi-step.ts",
			steps: [step(["1Go"], "import os"), step(["G", "o"], "    os.path.exists('tmp')")],
		});

		const saved = await Bun.file(filePath).text();
		expect(saved).toBe("import sys\nimport os\n\ndef main():\n    pass\n    os.path.exists('tmp')\n");
		expect(textResult(edited)).toContain("+import os");
		expect(textResult(edited)).toContain("+    os.path.exists('tmp')");
	});

	it("supports navigation-only steps between inserts", async () => {
		const filePath = path.join(tmpDir, "multi-step-navigation.ts");
		await Bun.write(filePath, "alpha\nbeta\ngamma\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "multi-step-navigation.ts" });
		await tool.execute("edit", {
			file: "multi-step-navigation.ts",
			steps: [step(["1Go"], "between"), step(["/gamma<CR>"]), step(["o"], "tail")],
		});

		const saved = await Bun.file(filePath).text();
		expect(saved).toBe("alpha\nbetween\nbeta\ngamma\ntail\n");
	});

	it("preserves earlier step changes when a later step fails", async () => {
		const filePath = path.join(tmpDir, "multi-step-error.ts");
		await Bun.write(filePath, "alpha\nbeta\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "multi-step-error.ts" });
		await expect(
			tool.execute("bad", {
				file: "multi-step-error.ts",
				steps: [step(["1Go"], "first"), step(["o", "o"])],
			}),
		).rejects.toThrow(/entered INSERT mode/i);

		const viewed = await tool.execute("view", { file: "multi-step-error.ts" });
		expect(textResult(viewed)).toContain("first");
		expect(await Bun.file(filePath).text()).toBe("alpha\nbeta\n");

		await tool.execute("save", { file: "multi-step-error.ts", steps: [step([":w<CR>"])] });
		expect(await Bun.file(filePath).text()).toBe("alpha\nfirst\nbeta\n");
	});

	it("applies pause only to the last step of a multi-step edit", async () => {
		const filePath = path.join(tmpDir, "multi-step-pause.ts");
		await Bun.write(filePath, "first\nsecond\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "multi-step-pause.ts" });
		const paused = await tool.execute("pause", {
			file: "multi-step-pause.ts",
			steps: [step(["1Go"], "alpha"), step(["G", "o"], "omega")],
			pause: true,
		});

		expect(paused.details?.mode).toBe("INSERT");
		expect(textResult(paused)).toContain("Pending: INSERT mode");
		expect(await Bun.file(filePath).text()).toBe("first\nsecond\n");

		await tool.execute("resume", { file: "multi-step-pause.ts", steps: [step([], "!")] });
		expect(await Bun.file(filePath).text()).toBe("first\nalpha\nsecond\nomega!\n");
	});

	it("supports full-file rewrites when models emit a space before i", async () => {
		const filePath = path.join(tmpDir, "full-rewrite.ts");
		await Bun.write(filePath, "first\nsecond\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "full-rewrite.ts" });
		const rewritten = await tool.execute("rewrite", {
			file: "full-rewrite.ts",
			steps: [step(["ggdG i"], "alpha\nbeta\n")],
		});

		const saved = await Bun.file(filePath).text();
		expect(saved).toBe("alpha\nbeta\n");
		expect(textResult(rewritten)).toContain("+alpha");
		expect(rewritten.details?.cursor.line).toBe(2);
	});

	it("rejects another kbd entry after entering insert mode", async () => {
		const filePath = path.join(tmpDir, "ambiguous.ts");
		await Bun.write(filePath, "first\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "ambiguous.ts" });
		await expect(tool.execute("bad", { file: "ambiguous.ts", steps: [step(["o", "o"])] })).rejects.toThrow(
			/entered INSERT mode/i,
		);
	});

	it("rejects additional kbd entries after entering insert mode", async () => {
		const filePath = path.join(tmpDir, "insert-boundary.ts");
		await Bun.write(filePath, "alpha\nbeta\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "insert-boundary.ts" });
		await expect(
			tool.execute("edit", { file: "insert-boundary.ts", steps: [step(["2G", "o", "o"])] }),
		).rejects.toThrow(/insert field|<Esc>/i);
		const saved = await Bun.file(filePath).text();
		expect(saved).toBe("alpha\nbeta\n");
	});

	it("supports paused insert mode and resuming with a later insert payload", async () => {
		const filePath = path.join(tmpDir, "pause.ts");
		await Bun.write(filePath, "first\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "pause.ts" });
		const paused = await tool.execute("pause", { file: "pause.ts", steps: [step(["cc"])], pause: true });
		expect(paused.details?.mode).toBe("INSERT");
		expect(textResult(paused)).toContain("Pending: INSERT mode");

		await tool.execute("resume", { file: "pause.ts", steps: [step([], "replacement")] });
		await tool.execute("save", { file: "pause.ts", steps: [step([":w<CR>"])] });
		const saved = await Bun.file(filePath).text();
		expect(saved).toBe("replacement\n");
	});

	it("rejects insert payloads outside insert mode with a snapshot error", async () => {
		const filePath = path.join(tmpDir, "bad-insert.ts");
		await Bun.write(filePath, "first\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "bad-insert.ts" });
		await expect(tool.execute("bad", { file: "bad-insert.ts", steps: [step([], "nope")] })).rejects.toThrow(
			/Insert payload requires INSERT mode/i,
		);
	});

	it("renders visible tab markers and a caret-focused snapshot", async () => {
		const filePath = path.join(tmpDir, "tabs.ts");
		await Bun.write(filePath, "\treturn value;\n");
		const tool = new VimTool(createSession(tmpDir));

		const opened = await tool.execute("open", { file: "tabs.ts" });
		const text = textResult(opened);
		expect(text).toContain("Focus:");
		expect(text).toContain("→return value;");
		expect(text).toContain("^");
	});

	it("renders the cursor inline in plain text viewport snapshots", async () => {
		const filePath = path.join(tmpDir, "cursor.txt");
		await Bun.write(filePath, "alpha\n");
		const tool = new VimTool(createSession(tmpDir));

		const opened = await tool.execute("open", { file: "cursor.txt" });
		expect(textResult(opened)).toContain(">1│▏alpha");
	});

	it("shows paused search input in the snapshot", async () => {
		const filePath = path.join(tmpDir, "search.ts");
		await Bun.write(filePath, "alpha\nbeta\n");
		const tool = new VimTool(createSession(tmpDir));

		await tool.execute("open", { file: "search.ts" });
		const paused = await tool.execute("search", { file: "search.ts", steps: [step(["/be"])], pause: true });
		expect(paused.details?.pendingInput?.kind).toBe("search-forward");
		expect(textResult(paused)).toContain("Pending: /be");
	});

	it("streams ex command input through onUpdate while typing", async () => {
		const filePath = path.join(tmpDir, "command.ts");
		await Bun.write(filePath, "foo foo\n");
		const tool = new VimTool(createSession(tmpDir));
		const pendingInputs: string[] = [];

		await tool.execute("open", { file: "command.ts" });
		const result = await tool.execute(
			"command",
			{ file: "command.ts", steps: [step([":%s/foo/bar/g<CR>"])] },
			undefined,
			update => {
				const pending = update.details?.pendingInput;
				if (pending?.kind === "command") {
					pendingInputs.push(pending.text);
				}
			},
		);

		expect(pendingInputs).toContain("");
		expect(pendingInputs).toContain("%");
		expect(pendingInputs).toContain("%s/foo/bar/g");
		expect(textResult(result)).toContain("bar bar");
	});

	it("streams large insert payloads through onUpdate in chunks", async () => {
		const filePath = path.join(tmpDir, "stream-insert.ts");
		await Bun.write(filePath, "header\nfooter\n");
		const tool = new VimTool(createSession(tmpDir));
		const visibleMaxItems: number[] = [];

		await tool.execute("open", { file: "stream-insert.ts" });
		await tool.execute(
			"insert",
			{
				file: "stream-insert.ts",
				steps: [step(["2Go"], Array.from({ length: 60 }, (_, index) => `item ${index + 1}`).join("\n"))],
				pause: true,
			},
			undefined,
			update => {
				const viewportText = update.details?.viewportLines?.map(line => line.text).join("\n") ?? "";
				const matches = Array.from(viewportText.matchAll(/item (\d+)/g), match => Number(match[1]));
				if (matches.length > 0) {
					visibleMaxItems.push(Math.max(...matches));
				}
			},
		);

		expect(visibleMaxItems.length).toBeGreaterThan(1);
		expect(visibleMaxItems.some(value => value < 60)).toBe(true);
		expect(Math.max(...visibleMaxItems)).toBe(60);
	});

	it("streams single-line insert payloads through onUpdate in chunks", async () => {
		const filePath = path.join(tmpDir, "stream-single-line.ts");
		await Bun.write(filePath, "alpha\nomega\n");
		const tool = new VimTool(createSession(tmpDir));
		const visibleLengths: number[] = [];
		const insertedText =
			"// Insert a new line after line 7 with a long comment that should render incrementally in the viewport.";

		await tool.execute("open", { file: "stream-single-line.ts" });
		await tool.execute(
			"insert-single-line",
			{
				file: "stream-single-line.ts",
				steps: [step(["2Go"], insertedText)],
				pause: true,
			},
			undefined,
			update => {
				const insertedLine = update.details?.viewportLines?.find(line => line.line === 3)?.text;
				if (typeof insertedLine === "string" && insertedLine.length > 0) {
					visibleLengths.push(insertedLine.length);
				}
			},
		);

		expect(visibleLengths.length).toBeGreaterThan(1);
		expect(visibleLengths.some(length => length < insertedText.length)).toBe(true);
		expect(Math.max(...visibleLengths)).toBe(insertedText.length);
	});

	it("allows navigation in plan mode but blocks mutations", async () => {
		const filePath = path.join(tmpDir, "plan.ts");
		await Bun.write(filePath, "one\ntwo\nthree\n");
		const tool = new VimTool(
			createSession(tmpDir, {
				getPlanModeState: () => ({
					enabled: true,
					planFilePath: path.join(tmpDir, "PLAN.md"),
				}),
			}),
		);

		await tool.execute("open", { file: "plan.ts" });
		const moved = await tool.execute("move", { file: "plan.ts", steps: [step(["2G"])] });
		expect(textResult(moved)).toContain("L2:1");
		await expect(tool.execute("edit", { file: "plan.ts", steps: [step(["dd"])] })).rejects.toThrow(/Plan mode/i);
		await expect(tool.execute("insert", { file: "plan.ts", steps: [step(["cc"], "blocked")] })).rejects.toThrow(
			/Plan mode/i,
		);
	});
});

describe("vim renderer", () => {
	it("reuses the last real vim snapshot while args stream", async () => {
		const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), "vim-render-preview-"));
		const filePath = path.join(previewDir, "preview.ts");
		await Bun.write(filePath, Array.from({ length: 900 }, (_, index) => `line ${index + 1};`).join("\n"));
		const tool = new VimTool(createSession(previewDir));
		const theme = await themeModule.getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		await tool.execute("open", { file: "preview.ts" });

		const component = vimToolRenderer.renderCall(
			{ file: "preview.ts", steps: [step(["643G"])] },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("643G");
		expect(rendered).toContain("line 1;");
		expect(rendered).not.toContain("line 643;");
	});

	it("renders first-call streamed inserts as text instead of priming a preview buffer", async () => {
		const theme = await themeModule.getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const component = vimToolRenderer.renderCall(
			{
				file: "preview.txt",
				steps: [step(["ggdGi"])],
				__partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"replacement',
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(140).join("\n"));
		expect(rendered).toContain("ggdGi");
		expect(rendered).toContain("insert: replacement");
		expect(rendered).not.toContain(">1│replacement");
	});

	it("updates streamed vim args without async preview priming", async () => {
		const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), "vim-render-growing-first-call-component-"));
		const theme = await themeModule.getThemeByName("red-claw");
		expect(theme).toBeDefined();
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
		const uiStub = { requestRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"edit",
			{
				file: "preview.txt",
				steps: [step(["ggdGi"])],
				__partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"rep',
			},
			{},
			undefined,
			uiStub,
			previewDir,
			"growing-first-call-component",
		);

		let rendered = Bun.stripANSI(component.render(140).join("\n"));
		expect(rendered).toContain("insert: rep");

		component.updateArgs(
			{
				file: "preview.txt",
				steps: [step(["ggdGi"])],
				__partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"replacement text',
			},
			"growing-first-call-component",
		);

		rendered = Bun.stripANSI(component.render(140).join("\n"));
		expect(rendered).toContain("insert: replacement text");
	});

	it("caches repeated renders for the same viewport snapshot", async () => {
		const theme = await themeModule.getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");

		const component = vimToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					file: "sample.ts",
					mode: "NORMAL",
					cursor: { line: 1, col: 1 },
					totalLines: 2,
					modified: false,
					viewport: { start: 1, end: 2 },
					viewportLines: [
						{ line: 1, text: "const foo = 1;", isCursor: true, isSelected: false },
						{ line: 2, text: "return foo;", isCursor: false, isSelected: false },
					],
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);

		component.render(120);
		component.render(120);

		expect(highlightSpy).toHaveBeenCalledTimes(1);
	});

	it("renders an inline cursor highlight inside the viewport row", async () => {
		const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), "vim-render-inline-cursor-"));
		const filePath = path.join(previewDir, "cursor.txt");
		await Bun.write(filePath, "Title line\n");
		const tool = new VimTool(createSession(previewDir));
		const theme = await themeModule.getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const opened = await tool.execute("open", { file: "cursor.txt" });
		const rendered = vimToolRenderer
			.renderResult(opened, { expanded: false, isPartial: false, spinnerFrame: 0 }, uiTheme)
			.render(160)
			.join("\n");

		expect(rendered).toMatch(/\x1b\[7mT/);
	});

	it("keeps long cursor rows horizontally centered around the cursor", async () => {
		const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), "vim-render-long-line-cursor-"));
		const filePath = path.join(previewDir, "cursor.txt");
		await Bun.write(filePath, `prefix-${"x".repeat(220)};`);
		const tool = new VimTool(createSession(previewDir));
		const theme = await themeModule.getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		await tool.execute("open", { file: "cursor.txt" });
		const moved = await tool.execute("move", { file: "cursor.txt", steps: [step(["$"])] });
		expect(moved.details?.viewportLines?.[0]?.text.startsWith("…")).toBe(true);

		const rendered = vimToolRenderer
			.renderResult(moved, { expanded: false, isPartial: false, spinnerFrame: 0 }, uiTheme)
			.render(200)
			.join("\n");

		expect(rendered).toMatch(/\x1b\[7m;/);
	});
});
