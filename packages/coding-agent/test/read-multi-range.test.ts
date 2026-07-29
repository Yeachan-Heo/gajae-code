import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ClientBridge } from "@gajae-code/coding-agent/session/client-bridge";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import type { ReadToolDetails } from "@gajae-code/coding-agent/tools/read";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import { getFileReadCache } from "../src/edit/file-read-cache";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	const settings = Settings.isolated();
	// Disable structural summarization so multi-range tests assert raw line content
	// regardless of language heuristics.
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

function makeNumberedContent(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

function makeWideContent(lines: number): string[] {
	return Array.from({ length: lines }, (_, index) => `${index + 1}|${"x".repeat(1200)}`);
}

describe("read tool multi-range selector", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-multi-range-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns both ranges separated by an elision marker", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-multi", { path: `${filePath}:3-5,20-22` });
		const text = textOutput(result);

		expect(text).toContain("line 3");
		expect(text).toContain("line 4");
		expect(text).toContain("line 5");
		expect(text).toContain("line 20");
		expect(text).toContain("line 21");
		expect(text).toContain("line 22");
		// Lines between the ranges must be elided
		expect(text).not.toContain("line 10");
		expect(text).not.toContain("line 19");
		// Separator marker is present between blocks
		expect(text).toContain("…");
	});

	it("merges overlapping ranges into a single contiguous block", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(20));

		const tool = new ReadTool(createSession(tmpDir));
		// 3-7 and 6-9 overlap → merged into 3-9 (collapses to a single-range read).
		const result = await tool.execute("call-merge", { path: `${filePath}:3-7,6-9` });
		const text = textOutput(result);

		// All lines from the merged range present
		for (const i of [3, 4, 5, 6, 7, 8, 9]) {
			expect(text).toContain(`line ${i}\n`);
		}
		// No separator because ranges merged into one contiguous block
		expect(text).not.toContain("…");
	});

	it("sorts ranges in ascending order regardless of user order", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-sort", { path: `${filePath}:30-32,5-7` });
		const text = textOutput(result);

		const indexEarly = text.indexOf("line 5");
		const indexLate = text.indexOf("line 30");
		expect(indexEarly).toBeGreaterThanOrEqual(0);
		expect(indexLate).toBeGreaterThan(indexEarly);
	});

	it("surfaces an inline notice when a range is past EOF", async () => {
		const filePath = path.join(tmpDir, "small.txt");
		await fs.writeFile(filePath, makeNumberedContent(10));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-oob", { path: `${filePath}:3-5,999-1000` });
		const text = textOutput(result);

		expect(text).toContain("line 3");
		expect(text).toContain("line 5");
		expect(text).toContain("Range 999-1000 is beyond end of file (10 lines total); skipped");
	});

	it("supports the +count syntax in multi-range", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(30));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-plus", { path: `${filePath}:2+2,20+2` });
		const text = textOutput(result);

		expect(text).toContain("line 2");
		expect(text).toContain("line 3");
		expect(text).toContain("line 20");
		expect(text).toContain("line 21");
		expect(text).not.toContain("line 4");
		expect(text).not.toContain("line 19");
	});

	it("rejects multi-range selectors on directories", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		await expect(tool.execute("call-dir", { path: `${tmpDir}:1-2,5-6` })).rejects.toThrow(
			/Multi-range line selectors are not supported for directory listings/,
		);
	});

	it("routes multi-range reads through the ACP bridge when available", async () => {
		const filePath = path.join(tmpDir, "disk.txt");
		await fs.writeFile(filePath, "disk one\ndisk two\ndisk three\ndisk four\ndisk five\n");
		const bridgeText = "bridge one\nbridge two\nbridge three\nbridge four\nbridge five\n";
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => bridgeText,
		};

		const tool = new ReadTool(createSession(tmpDir, bridge));
		const result = await tool.execute("call-bridge", { path: `${filePath}:1-2,4-5` });
		const text = textOutput(result);

		expect(text).toContain("bridge one");
		expect(text).toContain("bridge two");
		expect(text).toContain("bridge four");
		expect(text).toContain("bridge five");
		expect(text).not.toContain("bridge three");
		expect(text).not.toContain("disk");
	});

	it("keeps disk and ACP directional windows and caches byte-identical", async () => {
		const sourceLines = makeWideContent(300);
		const source = sourceLines.join("\n");
		const filePath = path.join(tmpDir, "wide.txt");
		await fs.writeFile(filePath, source);
		for (const truncation of [undefined, "head", "last", "both"] as const) {
			const diskSession = createSession(tmpDir);
			diskSession.settings.set("readLineNumbers", true);
			diskSession.settings.set("readHashLines", false);
			const bridgeSession = createSession(tmpDir, {
				capabilities: { readTextFile: true },
				readTextFile: async () => source,
			});
			bridgeSession.settings.set("readHashLines", false);
			bridgeSession.settings.set("readLineNumbers", true);
			const request = {
				path: `${filePath}:10-20,50-200`,
				...(truncation === undefined ? {} : { truncation }),
			} as { path: string; truncation?: "head" | "last" | "both" };
			const diskResult = await new ReadTool(diskSession).execute("disk-direction", request);
			const bridgeResult = await new ReadTool(bridgeSession).execute("bridge-direction", request);
			expect(textOutput(bridgeResult)).toBe(textOutput(diskResult));
			expect(bridgeResult.details?.meta?.truncation).toEqual(diskResult.details?.meta?.truncation);
			expect(textOutput(diskResult)).toContain(`10|10|${"x".repeat(20)}`);
			if (truncation === "last" || truncation === "both")
				expect(textOutput(diskResult)).toContain(`200|200|${"x".repeat(20)}`);
			else expect(textOutput(diskResult)).not.toContain(`200|200|${"x".repeat(20)}`);
			if (truncation === "last") expect(textOutput(diskResult)).not.toContain(`50|50|${"x".repeat(20)}`);
			else expect(textOutput(diskResult)).toContain(`50|50|${"x".repeat(20)}`);

			const diskSnapshot = getFileReadCache(diskSession).get(filePath);
			const bridgeSnapshot = getFileReadCache(bridgeSession).get(filePath);
			expect(diskSnapshot?.lines).toBeDefined();
			expect(bridgeSnapshot?.lines).toBeDefined();
			expect([...bridgeSnapshot!.lines.keys()]).toEqual([...diskSnapshot!.lines.keys()]);
			for (const [lineNumber, line] of diskSnapshot!.lines) {
				expect(line).toBe(sourceLines[lineNumber - 1]);
				expect(bridgeSnapshot!.lines.get(lineNumber)).toBe(line);
			}
		}
	});

	it("marks multi-range output non-spillable when any block ends in a partial line", async () => {
		const filePath = path.join(tmpDir, "partial-block.txt");
		const source = ["short", "Z".repeat(60_000), "middle", "last"].join("\n");
		await fs.writeFile(filePath, source);

		for (const session of [
			createSession(tmpDir),
			createSession(tmpDir, {
				capabilities: { readTextFile: true },
				readTextFile: async () => source,
			}),
		]) {
			const result = await new ReadTool(session).execute("partial-block", {
				path: `${filePath}:1-2,4-4`,
				truncation: "both",
			});

			expect(result.details?.spillEligible).toBe(false);
		}
	});

	it("discloses partial multi-range segments without anchors across disk, ACP, and archive reads", async () => {
		const source = ["alpha", "Z".repeat(60_000), "gamma", "delta"].join("\n");
		const filePath = path.join(tmpDir, "partial-disclosure.txt");
		await fs.writeFile(filePath, source);
		const archivePath = path.join(tmpDir, "partial-disclosure.tar.gz");
		await fs.writeFile(
			archivePath,
			await new Bun.Archive({ "docs/partial-disclosure.txt": source }, { compress: "gzip" }).bytes(),
		);

		for (const hashline of [false, true]) {
			const configure = (session: ToolSession) => {
				session.settings.set("readHashLines", hashline);
				session.settings.set("readLineNumbers", !hashline);
				return session;
			};
			const diskSession = configure(createSession(tmpDir));
			const acpSession = configure(
				createSession(tmpDir, {
					capabilities: { readTextFile: true },
					readTextFile: async () => source,
				}),
			);
			const archiveSession = configure(createSession(tmpDir));
			const cases = [
				{ name: "disk", session: diskSession, path: `${filePath}:1-2,4-4` },
				{ name: "ACP", session: acpSession, path: `${filePath}:1-2,4-4` },
				{ name: "archive", session: archiveSession, path: `${archivePath}:docs/partial-disclosure.txt:1-2,4-4` },
			] as const;

			for (const testCase of cases) {
				const result = await new ReadTool(testCase.session).execute(`partial-${testCase.name}`, {
					path: testCase.path,
					truncation: "both",
				});
				const text = textOutput(result);
				if (hashline) expect(text).toContain("Hashline output requires full lines");
				else expect(text).toContain("Showing last");
				expect(text).toContain("delta");
				expect(text).not.toContain("0 lines elided");
				expect(text).not.toContain("omitted lines 2-1");
				const omittedRange = /omitted lines (\d+)-(\d+)/.exec(text);
				expect(omittedRange === null || Number(omittedRange[1]) <= Number(omittedRange[2])).toBe(true);
				if (!hashline) {
					const partialLine = text.split("\n").find(line => line.startsWith("Z"));
					expect(partialLine).toBeDefined();
					expect(partialLine).not.toMatch(/^\d+\|/);
				}
				expect(text).not.toMatch(/^\d+[a-z]{2}\|Z/m);
				expect(result.details?.meta?.limits?.columnTruncated?.maxColumn).toBe(768);
				expect(result.details?.spillEligible).toBe(false);
				if (testCase.name !== "archive") {
					const snapshot = getFileReadCache(testCase.session).get(filePath);
					expect(snapshot?.lines.has(2)).toBe(false);
					expect(snapshot?.lines.get(4)).toBe("delta");
				}
			}
		}
	});

	it("applies the same directional windows to archive multi-range reads", async () => {
		const archiveLines = Array.from(
			{ length: 200 },
			(_, index) => `archive-${String(index + 1).padStart(4, "0")} ${"x".repeat(600)}`,
		);
		const archivePath = path.join(tmpDir, "fixture.tar.gz");
		await fs.writeFile(
			archivePath,
			await new Bun.Archive({ "docs/wide.txt": archiveLines.join("\n") }, { compress: "gzip" }).bytes(),
		);
		for (const truncation of ["last", "both"] as const) {
			const result = await new ReadTool(createSession(tmpDir)).execute("archive-direction", {
				path: `${archivePath}:docs/wide.txt:1-10,50-200`,
				truncation,
			});
			const text = textOutput(result);
			expect(text).toContain("archive-0001");
			expect(text).toContain("archive-0200");
			if (truncation === "last") expect(text).not.toContain("archive-0050");
			else expect(text).toContain("archive-0050");
		}
	});
});
