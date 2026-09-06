import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { formatOutputNotice } from "../../src/tools/output-meta";
import { ReadTool, streamLinesFromFile } from "../../src/tools/read";
import { pathDefault, type ReadRoute, resolveEffectiveDirection } from "../../src/tools/read-internals";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text ?? "")
		.join("\n");
}

function displayLines(result: { details?: { displayContent?: { text: string } } }): string[] {
	return result.details?.displayContent?.text?.split("\n") ?? [];
}

function expectedContextRange(
	totalLines: number,
	requestedStart: number,
	requestedEnd: number,
): { start: number; end: number } {
	const start = Math.max(1, requestedStart - 1);
	const end = Math.min(totalLines, requestedEnd + 3);
	return { start, end };
}
function createSession(
	cwd: string,
	settings: Settings,
	bridge?: { readTextFile: (params: { path: string }) => Promise<string> },
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async (toolType: string) => ({
			id: `direction-${toolType}`,
			path: path.join(cwd, `direction-${toolType}.log`),
		}),
		settings,
		getClientBridge: bridge
			? () => ({ capabilities: { readTextFile: true }, readTextFile: bridge.readTextFile })
			: undefined,
	} as unknown as ToolSession;
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-direction-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

test("tail streaming preserves ordinary and oversized UTF-8 line suffixes", async () => {
	for (const oversized of [false, true]) {
		const file = path.join(tempDir, `utf8-${oversized}.txt`);
		const lastLine = `${"한".repeat(oversized ? 20_000 : 10)}끝`;
		await Bun.write(file, `first\n${lastLine}`);
		const result = await streamLinesFromFile(file, 0, 50, 101, null, undefined, "tail");
		if (oversized) {
			expect(result.tailPartial).toEqual({
				text: `${"한".repeat(32)}끝`,
				bytes: 99,
				sourceIndex: 1,
				sourceLineBytes: 60_003,
			});
		} else {
			expect(result.lines).toEqual(["first", lastLine]);
			expect(result.tailPartial).toBeUndefined();
		}
	}
});

const routes: ReadRoute[] = [
	"local-bare-stream",
	"local-bare-acp",
	"archive-member-bare",
	"local-range",
	"local-multi-range",
	"local-raw",
	"local-summary",
	"url-reader",
	"url-cache-page",
	"dir-local",
	"dir-archive",
	"sqlite-list",
	"sqlite-rows",
	"converted",
];

describe("read truncation direction resolution", () => {
	test("uses the read.truncation setting only for bare local/archive routes", () => {
		const settings = Settings.isolated({ "read.truncation": "both" });
		for (const route of routes) {
			expect(pathDefault(route, settings)).toBe(
				route === "local-bare-stream" || route === "local-bare-acp" || route === "archive-member-bare"
					? "both"
					: "head",
			);
		}
	});

	test("uses last as the factory default for bare routes when the key is absent", () => {
		const settings = Settings.isolated();
		expect(pathDefault("local-bare-stream", settings)).toBe("last");
		expect(pathDefault("local-bare-acp", settings)).toBe("last");
		expect(pathDefault("archive-member-bare", settings)).toBe("last");
	});

	test("explicit direction wins on every route", () => {
		const settings = Settings.isolated({ "read.truncation": "head" });
		for (const route of routes) {
			for (const explicit of ["head", "last", "both"] as const) {
				expect(resolveEffectiveDirection(explicit, route, settings)).toBe(explicit);
			}
		}
	});
	test("renders the configured truncation direction and bare receipt budgets", () => {
		const headDescription = new ReadTool(createSession(tempDir, Settings.isolated({ "read.truncation": "head" })))
			.description;
		const lastDescription = new ReadTool(createSession(tempDir, Settings.isolated({ "read.truncation": "last" })))
			.description;
		const factoryDescription = new ReadTool(createSession(tempDir, Settings.isolated())).description;

		expect(headDescription).toContain("Configured default: head");
		expect(lastDescription).toContain("Configured default: last");
		expect(lastDescription).toContain("50 lines");
		expect(factoryDescription).toContain("Configured default: last");
		expect(headDescription).toContain("configured truncation direction is head");
		expect(lastDescription).toContain("configured truncation direction is last");
		expect(factoryDescription).toContain("configured truncation direction is last");
		expect(headDescription).not.toContain("taken from the **end** of the file by default");
		expect(lastDescription).not.toContain("taken from the **end** of the file by default");
		expect(factoryDescription).not.toContain("taken from the **end** of the file by default");
		expect(lastDescription).toContain("10 KiB");
		expect(headDescription).not.toContain("current no-parameter path retains the head");
		expect(lastDescription).not.toContain("current no-parameter path retains the head");
	});

	test("applies explicit disk directions for range, raw, and bare streams", async () => {
		const file = path.join(tempDir, "source.txt");
		const wide = Array.from({ length: 900 }, (_, index) => `line-${index + 1} ${"x".repeat(1100)}`).join("\n");
		await fs.writeFile(file, wide);
		const settings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		const tool = new ReadTool(createSession(tempDir, settings));

		const defaultRange = textOf(await tool.execute("direction-range-default", { path: `${file}:50-200` }));
		const explicitHeadRange = textOf(
			await tool.execute("direction-range-head", { path: `${file}:50-200`, truncation: "head" }),
		);
		expect(explicitHeadRange).toBe(defaultRange);
		const defaultRaw = textOf(await tool.execute("direction-raw-default", { path: `${file}:raw` }));
		const explicitHeadRaw = textOf(
			await tool.execute("direction-raw-head", { path: `${file}:raw`, truncation: "head" }),
		);
		expect(explicitHeadRaw).toBe(defaultRaw);
		const defaultBare = textOf(await tool.execute("direction-bare-default", { path: file }));
		const explicitHeadBare = textOf(await tool.execute("direction-bare-head", { path: file, truncation: "head" }));
		expect(explicitHeadBare).not.toBe(defaultBare);

		// The suffix-aware streaming collector makes non-head directions real on
		// the disk path: `last` must surface the final source lines, which head
		// never shows, and `both` must keep the first and last lines with a
		// single elision marker between them.
		const firstRenderedLine = (text: string) => text.split("\n").find(line => line.startsWith("line-")) ?? "";
		const lastRenderedLine = (text: string) =>
			[...text.split("\n")].reverse().find(line => line.startsWith("line-")) ?? "";
		expect(lastRenderedLine(defaultBare).startsWith("line-900 ")).toBe(true);
		expect(firstRenderedLine(defaultBare).startsWith("line-892 ")).toBe(true);

		const bareLast = textOf(await tool.execute("direction-bare-last", { path: file, truncation: "last" }));
		expect(lastRenderedLine(bareLast).startsWith("line-900 ")).toBe(true);
		expect(firstRenderedLine(bareLast)).toBe(firstRenderedLine(defaultBare));

		const bareBoth = textOf(await tool.execute("direction-bare-both", { path: file, truncation: "both" }));
		expect(firstRenderedLine(bareBoth).startsWith("line-1 ")).toBe(true);
		expect(lastRenderedLine(bareBoth).startsWith("line-900 ")).toBe(true);
		expect((bareBoth.match(/lines elided/g) ?? []).length).toBe(1);

		const rangeLast = textOf(
			await tool.execute("direction-range-last", { path: `${file}:50-200`, truncation: "last" }),
		);
		expect(firstRenderedLine(rangeLast)).not.toBe(firstRenderedLine(defaultRange));
	});

	test("routes middle partial tails through the oversized-line warning instead of a false middle footer", async () => {
		const file = path.join(tempDir, "middle-partial-tail.txt");
		await fs.writeFile(file, `short\n${"Z".repeat(60_000)}`);
		const settings = Settings.isolated({
			"read.summarize.enabled": false,
			"read.receiptBudgetLines": 50,
			"read.receiptBudgetBytes": 10,
			readHashLines: true,
		});
		const result = await new ReadTool(createSession(tempDir, settings)).execute("middle-partial-tail", {
			path: file,
			truncation: "both",
		});
		const text = textOf(result);

		expect(text).toContain("Line 2 is");
		expect(text).not.toContain("0 lines elided");
		expect(text).not.toContain("omitted lines 2-1");
		expect(result.details?.meta?.truncation?.headRange).toBeUndefined();
		expect(result.details?.meta?.truncation?.tailRange).toBeUndefined();
		expect(result.details?.meta?.truncation?.partialLine).toMatchObject({ line: 2 });
		expect(result.details?.spillEligible).not.toBe(true);
	});

	test("describes a middle partial tail as a byte suffix when hashlines are disabled", async () => {
		const file = path.join(tempDir, "middle-partial-tail-plain.txt");
		await fs.writeFile(file, `short\n${"Z".repeat(60_000)}`);
		const settings = Settings.isolated({
			"read.summarize.enabled": false,
			"read.receiptBudgetLines": 50,
			"read.receiptBudgetBytes": 10,
			readHashLines: false,
		});
		const result = await new ReadTool(createSession(tempDir, settings)).execute("middle-partial-tail-plain", {
			path: file,
			truncation: "both",
		});
		const text = textOf(result);
		expect(text).toContain("line is");

		expect(text).toContain("Showing last");
		expect(text).toContain("of line 2");
		expect(text).not.toContain("Showing lines 1-1 and 2-2");
		expect(text).not.toContain("omitted lines 2-1");
	});

	test("rejects explicit directions for structural summaries", async () => {
		const file = path.join(tempDir, "summary.ts");
		const source = Array.from(
			{ length: 20 },
			(_, index) => `export function fn${index}(): number {\n\treturn ${index};\n}`,
		).join("\n\n");
		await fs.writeFile(file, source);
		const settings = Settings.isolated({ readHashLines: false });
		const tool = new ReadTool(createSession(tempDir, settings));

		await expect(tool.execute("direction-summary", { path: file, truncation: "both" })).rejects.toThrow(
			/structural summaries.*not yet supported/,
		);
	});

	test("passes explicit head through unchanged on every unsupported-direction route", async () => {
		const settings = Settings.isolated({ readHashLines: false });
		const tool = new ReadTool(createSession(tempDir, settings));
		const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
			result.content
				.filter(block => block.type === "text")
				.map(block => block.text ?? "")
				.join("\n");

		const summaryFile = path.join(tempDir, "head-summary.ts");
		const summaryBodies = Array.from({ length: 40 }, (_, i) => {
			const body = Array.from({ length: 20 }, (_, j) => `\tconst value${j} = ${i + j};`).join("\n");
			return `export function g${i}(): number {\n${body}\n\treturn ${i};\n}`;
		});
		await fs.writeFile(summaryFile, summaryBodies.join("\n\n"));
		const conflictFile = path.join(tempDir, "head-conflicts.txt");
		await fs.writeFile(
			conflictFile,
			Array.from({ length: 30 }, (_, i) => `<<<<<<< ours\no${i}\n=======\nt${i}\n>>>>>>> theirs`).join("\n"),
		);
		const wideFile = path.join(tempDir, "head-wide.txt");
		await fs.writeFile(wideFile, Array.from({ length: 400 }, (_, i) => `L${i} ${"x".repeat(600)}`).join("\n"));

		// `head` is the existing behavior on all of these routes, so an explicit
		// `head` must never be rejected and must be byte-identical to no-param.
		for (const readPath of [summaryFile, `${conflictFile}:conflicts`, `${wideFile}:50-200`]) {
			const base = await tool.execute("head-base", { path: readPath }, undefined, undefined, undefined);
			const explicit = await tool.execute(
				"head-explicit",
				{ path: readPath, truncation: "head" },
				undefined,
				undefined,
				undefined,
			);
			expect(textOf(explicit)).toBe(textOf(base));
		}
	});

	test("applies direction to the rendered local directory listing only", async () => {
		const directory = path.join(tempDir, "listing");
		await fs.mkdir(directory);
		for (let index = 0; index < 12; index++) {
			await fs.writeFile(path.join(directory, `entry-${String(index).padStart(2, "0")}-${"x".repeat(80)}.txt`), "x");
		}
		const settings = Settings.isolated({
			"read.summarize.enabled": false,
			"read.receiptBudgetLines": 3,
			"read.receiptBudgetBytes": 1,
			readHashLines: false,
		});
		const tool = new ReadTool(createSession(tempDir, settings));
		const head = await tool.execute("direction-dir-head", { path: directory, truncation: "head" });
		const last = await tool.execute("direction-dir-last", { path: directory, truncation: "last" });
		const both = await tool.execute("direction-dir-both", { path: directory, truncation: "both" });
		const headText = textOf(head);
		const lastText = textOf(last);
		const bothText = textOf(both);

		expect(lastText).not.toBe(headText);
		expect(lastText).toMatch(/entry-\d{2}-/);

		expect(bothText).not.toBe(headText);
		expect(bothText).toContain("[…");
		expect(bothText).toMatch(/entry-\d{2}-/);
	});

	test("keeps ACP explicit-head at the baseline budget while disk bare reads retain receipt budget", async () => {
		const file = path.join(tempDir, "acp.txt");
		const source = Array.from({ length: 4_000 }, (_, index) => `line-${index + 1}`).join("\n");
		await fs.writeFile(file, source);
		const settings = Settings.isolated({
			"read.summarize.enabled": false,
			"read.receiptBudgetLines": 50,
			"read.receiptBudgetBytes": 10,
			readHashLines: false,
		});
		const disk = await new ReadTool(createSession(tempDir, settings)).execute("direction-disk-head", {
			path: file,
			truncation: "head",
		});
		const acp = await new ReadTool(createSession(tempDir, settings, { readTextFile: async () => source })).execute(
			"direction-acp-head",
			{ path: file, truncation: "head" },
		);

		expect(displayLines(acp)).toHaveLength(3_000);
		expect(displayLines(acp)[0]).toBe("line-1");
		expect(displayLines(acp).at(-1)).toBe("line-3000");
		expect(displayLines(disk)).toHaveLength(50);
		expect(displayLines(disk)[0]).toBe("line-1");
		expect(displayLines(disk).at(-1)).toBe("line-50");
		expect(textOf(acp)).not.toBe(textOf(disk));
	});

	test("retains a giant first-line head preview on ACP and disk routes", async () => {
		const file = path.join(tempDir, "giant-first-line.txt");
		const source = `${"G".repeat(60_000)}\nsecond\nthird`;
		await fs.writeFile(file, source);
		const settings = Settings.isolated({
			"read.summarize.enabled": false,
			"read.truncation": "head",
			readHashLines: false,
		});
		const disk = await new ReadTool(createSession(tempDir, settings)).execute("giant-disk-head", {
			path: file,
			truncation: "head",
		});
		const acp = await new ReadTool(createSession(tempDir, settings, { readTextFile: async () => source })).execute(
			"giant-acp-head",
			{ path: file, truncation: "head" },
		);

		const diskText = textOf(disk);
		const acpText = textOf(acp);
		for (const resultText of [diskText, acpText]) {
			expect(resultText.length).toBeGreaterThan(0);
			expect(resultText.startsWith("G")).toBe(true);
		}
		expect(disk.details?.truncation?.firstLineExceedsLimit).toBe(true);
		expect(acp.details?.truncation?.firstLineExceedsLimit).toBe(true);
		// ACP head keeps the historical 50 KiB UTF-8 snippet byte-for-byte.
		expect(acpText).toBe("G".repeat(50 * 1024));
		expect(formatOutputNotice(acp.details?.meta)).toContain("Showing 0 of 3 lines");
		expect(formatOutputNotice(disk.details?.meta)).toContain("Showing 0 of 3 lines");
	});

	test("keeps explicit range context windows bounded and EOF-clamped across disk and ACP directional reads", async () => {
		const file = path.join(tempDir, "acp-range-context.txt");
		const settings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		for (const totalLines of [300, 202]) {
			const source = Array.from({ length: totalLines }, (_, index) => `line-${index + 1}`).join("\n");
			await fs.writeFile(file, source);
			const expected = expectedContextRange(totalLines, 50, 200);
			for (const truncation of ["last", "both"] as const) {
				const disk = await new ReadTool(createSession(tempDir, settings)).execute("range-disk", {
					path: `${file}:50-200`,
					truncation,
				});
				const acp = await new ReadTool(
					createSession(tempDir, settings, { readTextFile: async () => source }),
				).execute("range-acp", { path: `${file}:50-200`, truncation });

				for (const result of [disk, acp]) {
					const lines = displayLines(result);
					expect(lines).toHaveLength(expected.end - expected.start + 1);
					expect(lines[0]).toBe(`line-${expected.start}`);
					expect(lines.at(-1)).toBe(`line-${expected.end}`);
				}
			}
		}
	});

	test("keeps ranged directional metadata in selected-window coordinates", async () => {
		const file = path.join(tempDir, "ranged-direction-metadata.txt");
		const source = Array.from({ length: 900 }, (_, index) => `line-${index + 1} ${"x".repeat(1100)}`).join("\n");
		await fs.writeFile(file, source);
		const settings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		for (const truncationDirection of ["last", "both"] as const) {
			const result = await new ReadTool(createSession(tempDir, settings)).execute("ranged-direction-metadata", {
				path: `${file}:100-200`,
				truncation: truncationDirection,
			});
			const truncation = result.details?.meta?.truncation as
				| {
						totalLines: number;
						shownRange?: { start: number; end: number };
						headRange?: { start: number; end: number };
						tailRange?: { start: number; end: number };
						rangeBase?: "file" | "window";
				  }
				| undefined;
			expect(truncation).toBeDefined();
			expect(truncation?.rangeBase).toBe("window");
			const ranges = [truncation?.shownRange, truncation?.headRange, truncation?.tailRange].filter(
				(range): range is { start: number; end: number } => range !== undefined,
			);
			expect(ranges.length).toBeGreaterThan(0);
			for (const range of ranges) expect(range.end).toBeLessThanOrEqual(truncation?.totalLines ?? 0);
			const notice = formatOutputNotice(result.details?.meta);
			expect(notice).toContain(`of the selected ${truncation?.totalLines}-line range`);
			for (const match of notice.matchAll(/(\d+)-(\d+)/g)) {
				expect(Number(match[2])).toBeLessThanOrEqual(truncation?.totalLines ?? 0);
			}
		}
		const hashSettings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: true });
		const hashResult = await new ReadTool(createSession(tempDir, hashSettings)).execute(
			"ranged-direction-hashlines",
			{
				path: `${file}:100-200`,
				truncation: "last",
			},
		);
		const anchors = textOf(hashResult)
			.split("\n")
			.map(line => /^(\d+)[a-z]{2}\|/.exec(line)?.[1])
			.filter((line): line is string => line !== undefined)
			.map(Number);
		expect(anchors[0]).toBe(156);
		expect(anchors.at(-1)).toBe(203);
	});

	test("applies direction to archive directory listings", async () => {
		const archivePath = path.join(tempDir, "entries.tar.gz");
		const archiveEntries: Record<string, string> = {};
		for (let index = 0; index < 600; index++) {
			archiveEntries[`dir/entry-${String(index).padStart(4, "0")}-${"x".repeat(90)}.txt`] = "x";
		}
		await Bun.write(archivePath, await new Bun.Archive(archiveEntries, { compress: "gzip" }).bytes());
		const settings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		const tool = new ReadTool(createSession(tempDir, settings));
		const head = await tool.execute("direction-archive-head", { path: `${archivePath}:dir`, truncation: "head" });
		const last = await tool.execute("direction-archive-last", { path: `${archivePath}:dir`, truncation: "last" });
		const both = await tool.execute("direction-archive-both", { path: `${archivePath}:dir`, truncation: "both" });

		expect(textOf(last)).not.toBe(textOf(head));
		expect(textOf(both)).not.toBe(textOf(head));
		expect(textOf(both)).toContain("[…");
	});

	test("uses the configured direction for bare archive members and honors explicit head", async () => {
		const archivePath = path.join(tempDir, "bare-member.tar.gz");
		const member = Array.from({ length: 3_200 }, (_, index) => `member-${String(index + 1).padStart(4, "0")}`).join(
			"\n",
		);
		await Bun.write(archivePath, await new Bun.Archive({ "docs/member.txt": member }, { compress: "gzip" }).bytes());

		const tailSettings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		const tailTool = new ReadTool(createSession(tempDir, tailSettings));
		const defaultTail = textOf(
			await tailTool.execute("archive-default-tail", { path: `${archivePath}:docs/member.txt` }),
		);
		expect(defaultTail).toContain("member-3200");
		expect(defaultTail).not.toContain("member-0001");

		const headSettings = Settings.isolated({
			"read.summarize.enabled": false,
			"read.truncation": "head",
			readHashLines: false,
		});
		const configuredHead = textOf(
			await new ReadTool(createSession(tempDir, headSettings)).execute("archive-configured-head", {
				path: `${archivePath}:docs/member.txt`,
			}),
		);
		const explicitHead = textOf(
			await tailTool.execute("archive-explicit-head", {
				path: `${archivePath}:docs/member.txt`,
				truncation: "head",
			}),
		);
		expect(configuredHead).toBe(explicitHead);
		expect(configuredHead).toContain("member-0001");
		expect(configuredHead).not.toContain("member-3200");
	});

	test("applies direction to the rendered SQLite table list", async () => {
		const databasePath = path.join(tempDir, "tables.sqlite");
		const db = new Database(databasePath);
		try {
			// Batch the 600 schema writes into one commit: per-statement
			// autocommit fsyncs blow the bun test timeout under CI disk load,
			// which then lets afterEach delete the fixture while the read is
			// still in flight and surfaces a spurious `Path not found`.
			db.run("BEGIN");
			try {
				for (let index = 0; index < 600; index++) {
					const name = `table_${String(index).padStart(4, "0")}_${"x".repeat(90)}`;
					db.run(`CREATE TABLE "${name}" (id INTEGER)`);
				}
			} catch (error) {
				db.run("ROLLBACK");
				throw error;
			}
			db.run("COMMIT");
		} finally {
			db.close();
		}
		const settings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		const tool = new ReadTool(createSession(tempDir, settings));
		const head = await tool.execute("direction-sqlite-head", { path: databasePath, truncation: "head" });
		const last = await tool.execute("direction-sqlite-last", { path: databasePath, truncation: "last" });
		const both = await tool.execute("direction-sqlite-both", { path: databasePath, truncation: "both" });

		expect(textOf(last)).not.toBe(textOf(head));
		expect(textOf(both)).not.toBe(textOf(head));
		expect(textOf(both)).toContain("[…");
	});

	test("rejects explicit directions for conflicts indexes to preserve their preamble", async () => {
		const file = path.join(tempDir, "conflicts.txt");
		await fs.writeFile(file, "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs");
		const settings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		const tool = new ReadTool(createSession(tempDir, settings));

		await expect(
			tool.execute("direction-conflicts-last", { path: `${file}:conflicts`, truncation: "last" }),
		).rejects.toThrow(/:conflicts indexes.*preamble.*bulk-resolve/);
		await expect(
			tool.execute("direction-conflicts-both", { path: `${file}:conflicts`, truncation: "both" }),
		).rejects.toThrow(/:conflicts indexes.*preamble.*bulk-resolve/);
	});

	test("documents approved SQLite row/query/raw no-op directions", async () => {
		const databasePath = path.join(tempDir, "rows.sqlite");
		const db = new Database(databasePath);
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
			db.run("INSERT INTO users (id, name) VALUES (1, 'Ada')");
		} finally {
			db.close();
		}
		const settings = Settings.isolated({ "read.summarize.enabled": false, readHashLines: false });
		const tool = new ReadTool(createSession(tempDir, settings));
		for (const pathSelector of [
			`${databasePath}:users:1`,
			`${databasePath}:users?limit=1`,
			`${databasePath}?q=${encodeURIComponent("SELECT id, name FROM users")}`,
		]) {
			const head = textOf(
				await tool.execute("direction-sqlite-row-head", { path: pathSelector, truncation: "head" }),
			);
			const last = textOf(
				await tool.execute("direction-sqlite-row-last", { path: pathSelector, truncation: "last" }),
			);
			const both = textOf(
				await tool.execute("direction-sqlite-row-both", { path: pathSelector, truncation: "both" }),
			);
			expect(last).toBe(head);
			expect(both).toBe(head);
		}
	});
});
