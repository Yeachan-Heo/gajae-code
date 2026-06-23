import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as zlib from "node:zlib";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { DEFAULT_BASH_INTERCEPTOR_RULES, Settings } from "@gajae-code/coding-agent/config/settings";
import { EditTool } from "@gajae-code/coding-agent/edit";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { BashTool } from "@gajae-code/coding-agent/tools/bash";
import { FindTool } from "@gajae-code/coding-agent/tools/find";
import { JobTool } from "@gajae-code/coding-agent/tools/job";
import { wrapToolWithMetaNotice } from "@gajae-code/coding-agent/tools/output-meta";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import { DEFAULT_FILE_LIMIT, MULTI_FILE_PER_FILE_MATCHES, SearchTool } from "@gajae-code/coding-agent/tools/search";
import { WriteTool } from "@gajae-code/coding-agent/tools/write";
import { $which, Snowflake } from "@gajae-code/utils";
import { unzipSync } from "fflate";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	const mtime = new Date(mtimeMs);
	fs.utimesSync(filePath, mtime, mtime);
}

function createFifoOrSkip(fifoPath: string): boolean {
	if (process.platform === "win32") {
		return false;
	}

	const mkfifoPath = $which("mkfifo");
	if (!mkfifoPath) {
		return false;
	}

	const result = Bun.spawnSync([mkfifoPath, fifoPath], { stdout: "ignore", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const errorText = result.stderr.toString("utf-8").trim();
		throw new Error(`mkfifo failed${errorText ? `: ${errorText}` : ""}`);
	}

	return true;
}

interface ArchiveFixtureEntry {
	path: string;
	content: string;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
	const valueBuffer = Buffer.from(value, "utf-8");
	valueBuffer.copy(buffer, offset, 0, Math.min(valueBuffer.length, length));
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
	const octal = value.toString(8).padStart(length - 1, "0");
	buffer.write(octal, offset, length - 1, "ascii");
	buffer[offset + length - 1] = 0;
}

function createTarArchive(entries: ArchiveFixtureEntry[]): Buffer {
	const parts: Buffer[] = [];

	for (const entry of entries) {
		const header = Buffer.alloc(512, 0);
		const content = Buffer.from(entry.content, "utf-8");

		writeTarString(header, 0, 100, entry.path);
		writeTarOctal(header, 100, 8, 0o644);
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, content.length);
		writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
		header.fill(0x20, 148, 156);
		header[156] = "0".charCodeAt(0);
		writeTarString(header, 257, 6, "ustar");
		writeTarString(header, 263, 2, "00");

		let checksum = 0;
		for (const byte of header) checksum += byte;
		const checksumText = checksum.toString(8).padStart(6, "0");
		header.write(checksumText, 148, 6, "ascii");
		header[154] = 0;
		header[155] = 0x20;

		parts.push(header, content);
		const remainder = content.length % 512;
		if (remainder !== 0) {
			parts.push(Buffer.alloc(512 - remainder, 0));
		}
	}

	parts.push(Buffer.alloc(1024, 0));
	return Buffer.concat(parts);
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
	}
	return (value ^ 0xffffffff) >>> 0;
}

function createZipArchive(entries: ArchiveFixtureEntry[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const pathBuffer = Buffer.from(entry.path.replace(/\\/g, "/"), "utf-8");
		const content = Buffer.from(entry.content, "utf-8");
		const compressed = zlib.deflateRawSync(content);
		const checksum = crc32(content);

		const localHeader = Buffer.alloc(30, 0);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x0800, 6);
		localHeader.writeUInt16LE(8, 8);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(content.length, 22);
		localHeader.writeUInt16LE(pathBuffer.length, 26);

		localParts.push(localHeader, pathBuffer, compressed);

		const centralHeader = Buffer.alloc(46, 0);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x0800, 8);
		centralHeader.writeUInt16LE(8, 10);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(content.length, 24);
		centralHeader.writeUInt16LE(pathBuffer.length, 28);
		centralHeader.writeUInt32LE(localOffset, 42);

		centralParts.push(centralHeader, pathBuffer);
		localOffset += localHeader.length + pathBuffer.length + compressed.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const endOfCentralDirectory = Buffer.alloc(22, 0);
	endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
	endOfCentralDirectory.writeUInt16LE(entries.length, 8);
	endOfCentralDirectory.writeUInt16LE(entries.length, 10);
	endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
	endOfCentralDirectory.writeUInt32LE(localOffset, 16);

	return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

let artifactCounter = 0;
function createTestToolSession(
	cwd: string,
	settings: Settings = Settings.isolated(),
	overrides: Partial<ToolSession> = {},
): ToolSession {
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
		...overrides,
	};
}

function createTestToolContext(toolNames: string[]): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		toolNames,
	} as AgentToolContext;
}

describe("Coding Agent Tools", () => {
	let testDir: string;
	let session: ToolSession;
	let readTool: ReadTool;
	let writeTool: WriteTool;
	let editTool: EditTool;
	let bashTool: BashTool;
	let searchTool: SearchTool;
	let findTool: FindTool;
	let originalEditVariant: string | undefined;

	beforeEach(() => {
		// Force replace mode for edit tool tests using old_text/new_text
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "replace";

		// Create a unique temporary directory for each test
		testDir = path.join(os.tmpdir(), `coding-agent-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });

		// Create tools for this test directory
		session = createTestToolSession(testDir);
		readTool = wrapToolWithMetaNotice(new ReadTool(session));
		writeTool = wrapToolWithMetaNotice(new WriteTool(session));
		editTool = wrapToolWithMetaNotice(new EditTool(session));
		bashTool = wrapToolWithMetaNotice(new BashTool(session));
		searchTool = wrapToolWithMetaNotice(new SearchTool(session));
		findTool = wrapToolWithMetaNotice(new FindTool(session));
	});

	afterEach(() => {
		vi.restoreAllMocks();

		// Clean up test directory
		fs.rmSync(testDir, { recursive: true, force: true });

		// Restore original edit variant
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
		AsyncJobManager.resetForTests();
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = path.join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			fs.writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			const output = getTextOutput(result);
			expect(output).toContain("Hello, world!");
			expect(output).toContain("Line 2");
			expect(output).toContain("Line 3");
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Use :");
			expect(result.details?.truncation).toBeUndefined();
		});

		it("truncates lines wider than the read column cap, leaving narrow lines untouched", async () => {
			const wideLine = "x".repeat(1500);
			const testFile = path.join(testDir, "wide.txt");
			fs.writeFileSync(testFile, `header\n${wideLine}\nfooter`);

			const result = await readTool.execute("test-call-column-truncate", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("header");
			expect(output).toContain("footer");
			expect(output).not.toContain(wideLine); // verbatim wide line is gone
			expect(output).toContain("…"); // ellipsis marker
			expect(output).toContain("Some lines truncated to 768 chars");
		});

		it("returns wide lines verbatim with the :raw selector", async () => {
			const wideLine = "y".repeat(1500);
			const testFile = path.join(testDir, "wide-raw.txt");
			fs.writeFileSync(testFile, `head\n${wideLine}\ntail`);

			const result = await readTool.execute("test-call-column-raw", { path: `${testFile}:raw` });
			const output = getTextOutput(result);

			expect(output).toContain(wideLine);
			expect(output).not.toContain("Some lines truncated to 768 chars");
		});

		it("should read ipynb files as editable cell text", async () => {
			const notebookPath = path.join(testDir, "notebook.ipynb");
			const notebook = {
				cells: [
					{
						cell_type: "markdown",
						metadata: { keep: true },
						source: ["# Notebook Title\n", "\n", "Notebook body\n"],
					},
					{
						cell_type: "code",
						metadata: {},
						source: ["print('hello')\n"],
						execution_count: 7,
						outputs: [{ output_type: "stream", name: "stdout", text: "hello\n" }],
					},
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5,
			};
			fs.writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await readTool.execute("test-call-ipynb", { path: notebookPath });
			const output = getTextOutput(result);

			expect(output).toContain("# %% [markdown] cell:0");
			expect(output).toContain("# Notebook Title");
			expect(output).toContain("Notebook body");
			expect(output).toContain("# %% [code] cell:1");
			expect(output).toContain("print('hello')");
			expect(output).not.toContain('"cell_type"');
		});

		it("should apply edits to the ipynb editable representation", async () => {
			const notebookPath = path.join(testDir, "editable.ipynb");
			const notebook = {
				cells: [
					{
						cell_type: "markdown",
						metadata: { keep: true },
						source: ["Original title\n"],
					},
					{
						cell_type: "code",
						metadata: { trusted: true },
						source: ["print('old')\n"],
						execution_count: 3,
						outputs: [{ output_type: "stream", name: "stdout", text: "old\n" }],
					},
				],
				metadata: { kernelspec: { name: "python3" } },
				nbformat: 4,
				nbformat_minor: 5,
			};
			fs.writeFileSync(notebookPath, JSON.stringify(notebook));
			const noLspEditTool = wrapToolWithMetaNotice(new EditTool({ ...session, enableLsp: false }));

			await noLspEditTool.execute("test-edit-ipynb", {
				path: notebookPath,
				edits: [{ old_text: "print('old')", new_text: "print('new')" }],
			});

			const updated = JSON.parse(fs.readFileSync(notebookPath, "utf-8"));
			expect(updated.cells).toHaveLength(2);
			expect(updated.cells[1].source).toEqual(["print('new')\n"]);
			expect(updated.cells[1].metadata).toEqual({ trusted: true });
			expect(updated.cells[1].execution_count).toBe(3);
			expect(updated.cells[1].outputs).toEqual([{ output_type: "stream", name: "stdout", text: "old\n" }]);
			expect(updated.metadata).toEqual({ kernelspec: { name: "python3" } });
		});

		it("should handle non-existent files", async () => {
			const testFile = path.join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should read local files passed as file:// URLs", async () => {
			const testFile = path.join(testDir, "file-url.txt");
			fs.writeFileSync(testFile, "Hello from file URL");

			const result = await readTool.execute("test-call-file-url", { path: url.pathToFileURL(testFile).href });
			const output = getTextOutput(result);

			expect(output).toContain("Hello from file URL");
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = path.join(testDir, "large.txt");
			const lines = Array.from({ length: 3500 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));
			const defaultLimit = session.settings.get("read.defaultLimit");

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain(`Line ${defaultLimit}`);
			expect(output).not.toContain(`Line ${defaultLimit + 1}`);
			expect(output).toContain(`[Showing lines 1-${defaultLimit} of 3500. Use :${defaultLimit + 1} to continue]`);
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = path.join(testDir, "large-bytes.txt");
			// Create file with long lines so the byte budget triggers before the line limit.
			const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}: ${"x".repeat(600)}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 1000 \(\d+(\.\d+)?\s*KB limit\)\. Use :\d+ to continue\]/);
		});

		it("should handle offset parameter (with leading context expansion)", async () => {
			const testFile = path.join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: `${testFile}:L51` });
			const output = getTextOutput(result);

			// Read tool widens by 1 leading + 3 trailing unanchored context lines
			// so anchors at the boundary stay fresh. Line 50 is the single leading
			// context line; lines 47..49 are NOT included.
			expect(output).not.toContain("Line 49");
			expect(output).toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use :");
		});

		it("should handle limit parameter (with trailing context expansion)", async () => {
			const testFile = path.join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: `${testFile}:L1-L10` });
			const output = getTextOutput(result);

			// Trailing context: lines 11..13 included so an edit anchored at
			// the boundary stays fresh.
			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).toContain("Line 13");
			expect(output).not.toContain("Line 14");
			expect(output).toContain("[Showing lines 1-13 of 100. Use :14 to continue]");
		});

		it("does not expand on the leading side when offset is 1 or unspecified", async () => {
			const testFile = path.join(testDir, "no-leading.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			// :L1-L5 has offset=1 → no leading context (already at the top).
			// Trailing context still applies.
			const result = await readTool.execute("test-no-leading", {
				path: `${testFile}:L1-L5`,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 5");
			expect(output).toContain("Line 8");
			expect(output).not.toContain("Line 9");
			expect(output).toContain("[Showing lines 1-8 of 50. Use :9 to continue]");
		});

		it("clamps leading context at file start without errors", async () => {
			const testFile = path.join(testDir, "leading-clamp.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			// :L2-L5: offset=2 → expand by min(1, 1) = 1 leading line.
			const result = await readTool.execute("test-leading-clamp", {
				path: `${testFile}:L2-L5`,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2");
			expect(output).toContain("Line 5");
			expect(output).toContain("Line 8");
			expect(output).not.toContain("Line 9");
		});

		it("should handle offset + limit together (1 leading + 3 trailing)", async () => {
			const testFile = path.join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: `${testFile}:L41-L60`,
			});
			const output = getTextOutput(result);

			// Both endpoints are user-constrained: 1 leading + 3 trailing.
			expect(output).not.toContain("Line 39");
			expect(output).toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).toContain("Line 63");
			expect(output).not.toContain("Line 64");
			expect(output).toContain("[Showing lines 40-63 of 100. Use :64 to continue]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = path.join(testDir, "short.txt");
			fs.writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("test-call-8", { path: `${testFile}:L100` });
			const output = getTextOutput(result);

			expect(output).toContain("Line 100 is beyond end of file (3 lines total)");
			expect(output).toContain("Use :1 to read from the start, or :3 to read the last line.");
		});

		it("should include truncation details when truncated", async () => {
			const testFile = path.join(testDir, "large-file.txt");
			const lines = Array.from({ length: 3500 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));
			const defaultLimit = session.settings.get("read.defaultLimit");

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(3500);
			expect(result.details?.truncation?.outputLines).toBe(defaultLimit);
		});

		it("should render directories as a two-level tree without capping root entries", async () => {
			const childDir = path.join(testDir, "child");
			const base = Date.now() - 60_000;
			fs.mkdirSync(childDir, { recursive: true });
			writeFileWithMtime(path.join(testDir, ".hidden-root"), "hidden", base + 20_000);
			writeFileWithMtime(path.join(testDir, ".DS_Store"), "mac metadata", base + 25_000);
			writeFileWithMtime(path.join(testDir, "node_modules", "pkg", "index.js"), "ignored", base + 24_000);
			for (let i = 0; i < 13; i += 1) {
				const fileName = `root-${String(i).padStart(2, "0")}.txt`;
				writeFileWithMtime(path.join(testDir, fileName), fileName, base + i);
			}
			for (let i = 0; i < 13; i += 1) {
				const fileName = `child-${String(i).padStart(2, "0")}.txt`;
				writeFileWithMtime(path.join(childDir, fileName), fileName, base + i);
			}
			writeFileWithMtime(path.join(childDir, "nested", "deep.txt"), "deep", base + 30_000);

			const result = await readTool.execute("test-call-directory-tree", { path: testDir });
			const output = getTextOutput(result);

			expect(result.details?.isDirectory).toBe(true);
			expect(output).toContain(".");
			expect(output).toContain(".hidden-root");
			expect(output).not.toContain(".DS_Store");
			expect(output).not.toContain("node_modules");
			expect(output).toContain("root-00.txt");
			expect(output).toContain("root-01.txt");
			expect(output).toContain("root-12.txt");
			expect(output).toContain("child/");
			expect(output).toContain("nested/");
			expect(output).toContain("… 2 more");
			expect(output).not.toContain("child-01.txt");
			expect(output).toContain("child-00.txt");
			expect(output).not.toContain("deep.txt");
		});

		it("should treat .tar archives like directories", async () => {
			const archivePath = path.join(testDir, "fixture.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "pkg/README.md", content: "# Tar README\nLine 2\n" },
					{ path: "pkg/src/index.ts", content: "export const tarValue = 1;\n" },
					{ path: "top.txt", content: "top level\n" },
				]),
			);

			const result = await readTool.execute("test-call-tar-root", { path: archivePath });
			const output = getTextOutput(result);

			expect(output).toContain("pkg/");
			expect(output).toContain("top.txt");
			expect(result.details?.isDirectory).toBe(true);
		});

		it("should list archive subdirectories", async () => {
			const archivePath = path.join(testDir, "fixture.zip");
			fs.writeFileSync(
				archivePath,
				createZipArchive([
					{ path: "pkg/README.md", content: "# Zip README\n" },
					{ path: "pkg/src/index.ts", content: "export const zipValue = 2;\n" },
					{ path: "pkg/src/util.ts", content: "export const utilValue = 3;\n" },
				]),
			);

			const result = await readTool.execute("test-call-zip-dir", { path: `${archivePath}:pkg/src` });
			const output = getTextOutput(result);

			expect(output).toContain("index.ts");
			expect(output).toContain("util.ts");
			expect(result.details?.isDirectory).toBe(true);
		});

		for (const archiveCase of [
			{
				label: ".tar",
				path: "fixture-subpath.tar",
				create: (entries: ArchiveFixtureEntry[]) => createTarArchive(entries),
			},
			{
				label: ".tar.gz",
				path: "fixture-subpath.tar.gz",
				create: (entries: ArchiveFixtureEntry[]) => zlib.gzipSync(createTarArchive(entries)),
			},
			{
				label: ".tgz",
				path: "fixture-subpath.tgz",
				create: (entries: ArchiveFixtureEntry[]) => zlib.gzipSync(createTarArchive(entries)),
			},
			{
				label: ".zip",
				path: "fixture-subpath.zip",
				create: (entries: ArchiveFixtureEntry[]) => createZipArchive(entries),
			},
		]) {
			it(`should read ${archiveCase.label} subpaths`, async () => {
				const archivePath = path.join(testDir, archiveCase.path);
				fs.writeFileSync(
					archivePath,
					archiveCase.create([
						{ path: "pkg/README.md", content: "# Archive README\nLine 2\nLine 3\n" },
						{ path: "pkg/src/index.ts", content: "export const archiveValue = 4;\n" },
					]),
				);

				const result = await readTool.execute("test-call-archive-subpath", {
					path: `${archivePath}:pkg/README.md:L1-L2`,
				});
				const output = getTextOutput(result);

				expect(output).toContain("# Archive README");
				expect(output).toContain("Line 2");
				// Trailing context (±3) keeps Line 3 visible when present.
				expect(output).toContain("Line 3");
			});
		}

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = path.join(testDir, "image.txt");
			fs.writeFileSync(testFile, pngBuffer);

			const legacyReadTool = wrapToolWithMetaNotice(
				new ReadTool(createTestToolSession(testDir, Settings.isolated({ "inspect_image.enabled": false }))),
			);
			const result = await legacyReadTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("returns metadata guidance (no image blocks) when inspect_image is enabled", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");
			const testFile = path.join(testDir, "image-guidance.png");
			fs.writeFileSync(testFile, pngBuffer);

			const inspectModeReadTool = wrapToolWithMetaNotice(
				new ReadTool(createTestToolSession(testDir, Settings.isolated({ "inspect_image.enabled": true }))),
			);
			const result = await inspectModeReadTool.execute("test-call-img-guidance", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Image metadata:");
			expect(output).toContain("MIME: image/png");
			expect(output).toContain("Bytes:");
			expect(output).toContain("Dimensions:");
			expect(output).toContain("inspect_image");
			expect(output).toContain(`path="${path.basename(testFile)}"`);
			expect(output).toContain("question");
			expect(output).not.toContain("optional context");
			expect(result.content.some(c => c.type === "image")).toBe(false);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = path.join(testDir, "not-an-image.png");
			fs.writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = path.join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(path.basename(testFile));
		});

		it("should create parent directories", async () => {
			const testFile = path.join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
		it("should write to a new local:// path under the session local root", async () => {
			const localPath = "local://handoffs/new-output.json";
			const content = '{"ok":true}\n';
			const expectedPath = path.join(testDir, "session", "local", "handoffs", "new-output.json");

			const result = await writeTool.execute("test-call-4-local", { path: localPath, content });

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to session/local/handoffs/new-output.json`,
			);
			expect(fs.existsSync(expectedPath)).toBe(true);
			expect(fs.readFileSync(expectedPath, "utf-8")).toBe(content);
		});

		it("should write to an existing archive entry", async () => {
			const archivePath = path.join(testDir, "write-existing.zip");
			fs.writeFileSync(
				archivePath,
				createZipArchive([
					{ path: "pkg/README.md", content: "# Original\n" },
					{ path: "pkg/src/index.ts", content: "export const archiveValue = 1;\n" },
				]),
			);

			const content = "# Updated\nLine 2\n";
			const result = await writeTool.execute("test-call-archive-write-existing", {
				path: `${archivePath}:pkg/README.md`,
				content,
			});

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to ${path.basename(archivePath)}:pkg/README.md`,
			);

			const unzipped = unzipSync(new Uint8Array(fs.readFileSync(archivePath)));
			expect(new TextDecoder().decode(unzipped["pkg/README.md"])).toBe(content);
			expect(new TextDecoder().decode(unzipped["pkg/src/index.ts"])).toBe("export const archiveValue = 1;\n");
		});

		it("should create a new archive when writing to an archive subpath", async () => {
			const archivePath = path.join(testDir, "nested", "created.tar.gz");
			const content = "created inside archive\n";

			const result = await writeTool.execute("test-call-archive-write-create", {
				path: `${archivePath}:pkg/new.txt`,
				content,
			});

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to nested/${path.basename(archivePath)}:pkg/new.txt`,
			);
			expect(fs.existsSync(archivePath)).toBe(true);

			const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
			const files = await archive.files();
			expect(await files.get("pkg/new.txt")?.text()).toBe(content);
		});

		it("should treat a plain archive filename as a regular file write", async () => {
			const archivePath = path.join(testDir, "literal.zip");
			const content = "plain file contents\n";

			const result = await writeTool.execute("test-call-archive-plain-file", {
				path: archivePath,
				content,
			});

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to ${path.basename(archivePath)}`,
			);
			expect(fs.readFileSync(archivePath, "utf-8")).toBe(content);
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = path.join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			fs.writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ old_text: "world", new_text: "testing" }],
			});
			const details = result.details as { diff?: string } | undefined;

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(details).toBeDefined();
			expect(details?.diff).toBeDefined();
			expect(typeof details?.diff).toBe("string");
			expect(details?.diff).toContain("testing");
		});

		it("should fail if text not found", async () => {
			const testFile = path.join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			fs.writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ old_text: "nonexistent", new_text: "testing" }],
				}),
			).rejects.toThrow(/Could not find/);
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = path.join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			fs.writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ old_text: "foo", new_text: "bar" }],
				}),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it("should replace all occurrences with all: true", async () => {
			const testFile = path.join(testDir, "edit-all-test.txt");
			fs.writeFileSync(testFile, "foo bar foo baz foo");

			const result = await editTool.execute("test-all-1", {
				path: testFile,
				edits: [{ old_text: "foo", new_text: "qux", all: true }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 3 occurrences");
			const content = await Bun.file(testFile).text();
			expect(content).toBe("qux bar qux baz qux");
		});

		it("should reject all: true when multiple fuzzy matches are ambiguous", async () => {
			const testFile = path.join(testDir, "edit-all-fuzzy.txt");
			// File has two similar blocks with different indentation
			fs.writeFileSync(
				testFile,
				`function a() {
  if (x) {
    doThing();
  }
}
function b() {
    if (x) {
        doThing();
    }
}
`,
			);

			// With multiple fuzzy matches, the tool rejects for safety to avoid ambiguous replacements
			await expect(
				editTool.execute("test-all-fuzzy", {
					path: testFile,
					edits: [
						{
							old_text: "if (x) {\n  doThing();\n}",
							new_text: "if (y) {\n  doOther();\n}",
							all: true,
						},
					],
				}),
			).rejects.toThrow(/Found 2 high-confidence matches/);
		});

		it("should fail with all: true if no matches found", async () => {
			const testFile = path.join(testDir, "edit-all-nomatch.txt");
			fs.writeFileSync(testFile, "hello world");

			await expect(
				editTool.execute("test-all-nomatch", {
					path: testFile,
					edits: [{ old_text: "nonexistent", new_text: "bar", all: true }],
				}),
			).rejects.toThrow(/Could not find/);
		});

		it("should replace multiline text with all: true", async () => {
			const testFile = path.join(testDir, "edit-all-multiline.txt");
			fs.writeFileSync(testFile, "start\nfoo\nbar\nend\nstart\nfoo\nbar\nend");

			const result = await editTool.execute("test-all-multiline", {
				path: testFile,
				edits: [{ old_text: "foo\nbar", new_text: "replaced", all: true }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 2 occurrences");
			const content = await Bun.file(testFile).text();
			expect(content).toBe("start\nreplaced\nend\nstart\nreplaced\nend");
		});

		it("should work with all: true when only one occurrence exists", async () => {
			const testFile = path.join(testDir, "edit-all-single.txt");
			fs.writeFileSync(testFile, "hello world");

			const result = await editTool.execute("test-all-single", {
				path: testFile,
				edits: [{ old_text: "world", new_text: "universe", all: true }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced text");
			const content = await Bun.file(testFile).text();
			expect(content).toBe("hello universe");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details?.timeoutSeconds).toBe(300);
		});

		it("should expose built-in interceptor defaults truthfully", () => {
			const defaultSettings = Settings.isolated({ "bashInterceptor.enabled": true });
			const explicitEmptySettings = Settings.isolated({
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": [],
			});

			expect(defaultSettings.get("bashInterceptor.patterns")).toEqual(DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(defaultSettings.getBashInterceptorRules()).toEqual(DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(explicitEmptySettings.get("bashInterceptor.patterns")).toEqual([]);
			expect(explicitEmptySettings.getBashInterceptorRules()).toEqual([]);
		});

		it("should block built-in interceptor commands when enabled with default patterns", async () => {
			const interceptedBashTool = wrapToolWithMetaNotice(
				new BashTool(createTestToolSession(testDir, Settings.isolated({ "bashInterceptor.enabled": true }))),
			);

			await expect(
				interceptedBashTool.execute(
					"test-call-8-intercept-default",
					{ command: "cat test.txt" },
					undefined,
					undefined,
					createTestToolContext(["read"]),
				),
			).rejects.toThrow(/Use the `read` tool instead of cat\/head\/tail/);
		});

		it("should allow an explicit empty interceptor pattern list", async () => {
			const allowedFile = path.join(testDir, "allow-empty.txt");
			fs.writeFileSync(allowedFile, "empty means empty\n");

			const interceptedBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bashInterceptor.enabled": true,
							"bashInterceptor.patterns": [],
						}),
					),
				),
			);

			const result = await interceptedBashTool.execute(
				"test-call-8-intercept-empty",
				{ command: `cat ${allowedFile}` },
				undefined,
				undefined,
				createTestToolContext(["read"]),
			);

			expect(getTextOutput(result)).toContain("empty means empty");
		});

		it("should honor custom bash interceptor patterns", async () => {
			const interceptedBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bashInterceptor.enabled": true,
							"bashInterceptor.patterns": [
								{
									pattern: "^\\s*customcmd\\s+",
									tool: "grep",
									message: "Use the `grep` tool for customcmd.",
								},
							],
						}),
					),
				),
			);
			await expect(
				interceptedBashTool.execute(
					"test-call-8-intercept-custom",
					{ command: "customcmd foo" },
					undefined,
					undefined,
					createTestToolContext(["grep"]),
				),
			).rejects.toThrow(/Use the `grep` tool for customcmd\./);
		});

		it("should expose env values without shell re-parsing", async () => {
			const mermaid = [
				"flowchart TD",
				'N0["attack"]',
				'N1["[target] cluster"]',
				'N2["diff-review"]',
				'N3["extract"]',
				'N4["report"]',
				'N5["setup"]',
				"N3 --> N0",
				"N0 --> N1",
				"N2 --> N1",
				"N3 --> N2",
				"N5 --> N3",
				"N1 --> N4",
			].join("\n");
			const result = await bashTool.execute("test-call-8-env", {
				command: "printf '%s' \"$MERMAID\"",
				env: { MERMAID: mermaid },
			});
			const output = getTextOutput(result);
			expect(output).toContain('N0["attack"]');
			expect(output).toContain("N1 --> N4");
			expect(fs.existsSync(path.join(testDir, "N0"))).toBe(false);
			expect(fs.existsSync(path.join(testDir, "N4"))).toBe(false);
		});

		it("should resolve local:// destination paths for mv commands", async () => {
			const sourcePath = path.join(testDir, "move-source.json");
			const targetPath = path.join(testDir, "session", "local", "moved-via-bash.json");
			fs.writeFileSync(sourcePath, '{"move":true}\n');

			await bashTool.execute("test-call-8-local-mv", { command: `mv ${sourcePath} local://moved-via-bash.json` });

			expect(fs.existsSync(sourcePath)).toBe(false);
			expect(fs.existsSync(targetPath)).toBe(true);
			expect(fs.readFileSync(targetPath, "utf-8")).toBe('{"move":true}\n');
		});

		it("should stream output updates", async () => {
			const updates: string[] = [];
			const result = await bashTool.execute(
				"test-call-8-stream",
				{ command: "for i in 1 2 3; do echo $i; sleep 0.05; done" },
				undefined,
				update => {
					const text = update.content?.find(c => c.type === "text")?.text ?? "";
					updates.push(text);
				},
			);

			expect(updates.length).toBeGreaterThan(1);
			expect(getTextOutput(result)).toContain("1");
			expect(getTextOutput(result)).toContain("3");
		});

		it("should persist environment variables between commands", async () => {
			if (process.platform === "win32" || Bun.env.PI_SHELL_PERSIST !== "1") {
				return;
			}

			await bashTool.execute("test-call-8-env-set", { command: "export PI_TEST_VAR=hello" });
			const result = await bashTool.execute("test-call-8-env-get", { command: "echo $PI_TEST_VAR" });
			expect(getTextOutput(result)).toContain("hello");
		});

		it("should write truncated output to artifacts", async () => {
			const result = await bashTool.execute("test-call-8-artifact", {
				command: "printf 'a%.0s' {1..60000}",
			});

			const artifactId = result.details?.meta?.truncation?.artifactId;
			expect(artifactId).toBeDefined();
			if (artifactId) {
				const artifactPath = path.join(testDir, "session", `${artifactId}.bash.log`);
				expect(fs.existsSync(artifactPath)).toBe(true);
			}
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it("should keep short commands inline when auto-background is enabled", async () => {
			const deliveries: string[] = [];
			const asyncJobManager = new AsyncJobManager({
				onJobComplete: async (_jobId, text) => {
					deliveries.push(text);
				},
			});
			AsyncJobManager.setInstance(asyncJobManager);
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							// Generous threshold so a trivial `echo` always finishes inline; a tight
							// budget (e.g. 50ms) races process-spawn overhead under full-suite load
							// and flakily backgrounds an instant command.
							"bash.autoBackground.thresholdMs": 30_000,
						}),
						{
							getSessionId: () => "test-session",
						},
					),
				),
			);

			const result = await autoBackgroundBashTool.execute("test-call-9-auto-inline", { command: "echo short" });

			expect(getTextOutput(result)).toContain("short");
			expect(result.details?.timeoutSeconds).toBe(300);
			expect(result.details?.async).toBeUndefined();
			await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
			expect(deliveries).toEqual([]);
			await asyncJobManager.dispose();
		});

		it("should auto-background long-running commands when enabled", async () => {
			const deliveries: Array<{ jobId: string; text: string }> = [];
			const asyncJobManager = new AsyncJobManager({
				onJobComplete: async (jobId, text) => {
					deliveries.push({ jobId, text });
				},
			});
			AsyncJobManager.setInstance(asyncJobManager);
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							"bash.autoBackground.thresholdMs": 10,
						}),
						{
							getSessionId: () => "test-session",
						},
					),
				),
			);

			const result = await autoBackgroundBashTool.execute("test-call-9-auto-running", {
				command: "printf 'start\\n'; sleep 0.05; printf 'done\\n'",
			});

			expect(result.details?.async?.state).toBe("running");
			expect(result.details?.async?.type).toBe("bash");
			expect(getTextOutput(result)).toContain("Background job");
			expect(getTextOutput(result)).toContain("start");

			const jobId = result.details?.async?.jobId;
			if (!jobId) {
				throw new Error("expected an auto-backgrounded job id");
			}
			const runningJob = asyncJobManager.getJob(jobId);
			expect(runningJob?.status).toBe("running");
			await runningJob?.promise;
			await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]?.jobId).toBe(jobId);
			expect(deliveries[0]?.text).toContain("done");
			await asyncJobManager.dispose();
		});

		it("should fold a managed foreground command into a background job when requested", async () => {
			const deliveries: Array<{ jobId: string; text: string }> = [];
			const updates: Array<{ text: string; asyncState?: string }> = [];
			const asyncJobManager = new AsyncJobManager({
				onJobComplete: async (jobId, text) => {
					deliveries.push({ jobId, text });
				},
			});
			AsyncJobManager.setInstance(asyncJobManager);
			let backgroundRequestHandler: (() => void) | undefined;
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							"bash.autoBackground.thresholdMs": 30_000,
						}),
						{
							getSessionId: () => "test-session",
							registerForegroundBashBackgroundRequestHandler: handler => {
								backgroundRequestHandler = handler;
								return () => {
									if (backgroundRequestHandler === handler) backgroundRequestHandler = undefined;
								};
							},
						},
					),
				),
			);

			const resultPromise = autoBackgroundBashTool.execute(
				"test-call-9-fold-foreground",
				{
					command: "printf 'start\\n'; sleep 0.05; printf 'after-fold\\n'; sleep 0.2; printf 'done\\n'",
				},
				undefined,
				partialResult => {
					updates.push({
						text: getTextOutput(partialResult),
						asyncState: partialResult.details?.async?.state,
					});
				},
			);

			for (let i = 0; i < 50 && !backgroundRequestHandler; i++) {
				await Bun.sleep(10);
			}
			expect(backgroundRequestHandler).toBeDefined();
			backgroundRequestHandler?.();

			const result = await resultPromise;
			expect(result.details?.async?.state).toBe("running");
			expect(result.details?.async?.type).toBe("bash");
			expect(getTextOutput(result)).toContain("Background job");
			expect(getTextOutput(result)).toContain("start");
			expect(backgroundRequestHandler).toBeUndefined();

			const jobId = result.details?.async?.jobId;
			if (!jobId) {
				throw new Error("expected a folded background job id");
			}
			const runningJob = asyncJobManager.getJob(jobId);
			expect(runningJob?.status).toBe("running");
			await runningJob?.promise;
			await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
			const postFoldProgress = updates.filter(update => update.text.includes("after-fold"));
			expect(postFoldProgress.length).toBeGreaterThan(0);
			expect(postFoldProgress.every(update => update.asyncState !== undefined)).toBe(true);
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]?.jobId).toBe(jobId);
			expect(deliveries[0]?.text).toContain("done");
			await asyncJobManager.dispose();
		});

		it("should background instead of timing out when auto-background wait exceeds the effective timeout", async () => {
			const deliveries: Array<{ jobId: string; text: string }> = [];
			const asyncJobManager = new AsyncJobManager({
				onJobComplete: async (jobId, text) => {
					deliveries.push({ jobId, text });
				},
			});
			AsyncJobManager.setInstance(asyncJobManager);
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							"bash.autoBackground.thresholdMs": 60_000,
						}),
						{
							getSessionId: () => "test-session",
						},
					),
				),
			);

			const result = await autoBackgroundBashTool.execute("test-call-9-auto-timeout-background", {
				command: "printf 'start\\n'; sleep 1.2; printf 'done\\n'",
				timeout: 1,
			});

			expect(result.details?.timeoutSeconds).toBe(1);
			expect(result.details?.async?.state).toBe("running");
			expect(getTextOutput(result)).toContain("Background job");
			const jobId = result.details?.async?.jobId;
			if (!jobId) {
				throw new Error("expected an auto-backgrounded job id");
			}
			const runningJob = asyncJobManager.getJob(jobId);
			expect(runningJob?.status).toBe("running");
			await runningJob?.promise;
			await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]?.jobId).toBe(jobId);
			expect(deliveries[0]?.text).toContain("Command timed out after 1 seconds");
			await asyncJobManager.dispose();
		});

		it("should surface clamped timeout in results", async () => {
			const result = await bashTool.execute("test-call-timeout-clamp", { command: "echo ok", timeout: 7200 });

			const output = getTextOutput(result);
			expect(output).toContain("ok");
			expect(output).toContain("Timeout clamped to 3600s (requested 7200s; allowed range 1-3600s).");
			expect(result.details?.timeoutSeconds).toBe(3600);
			expect(result.details?.requestedTimeoutSeconds).toBe(7200);
		});

		it("should respect timeout", async () => {
			await expect(bashTool.execute("test-call-10", { command: "sleep 5", timeout: 1 })).rejects.toThrow(
				/timed out/i,
			);
		});

		it("should abort and recover for subsequent commands", async () => {
			const controller = new AbortController();
			const promise = bashTool.execute(
				"test-call-10-abort",
				{ command: "printf 'started\\n'; sleep 60", timeout: 3 },
				controller.signal,
				update => {
					if (update.content?.some(content => content.type === "text" && content.text.includes("started"))) {
						controller.abort("test abort");
					}
				},
			);
			await expect(promise).rejects.toThrow(/abort|cancel|timed out/i);

			const result = await bashTool.execute("test-call-10-after-abort", { command: "echo ok" });
			expect(getTextOutput(result)).toContain("ok");
		}, 15_000);

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = new BashTool(createTestToolSession(nonexistentCwd));

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should not pull cwd from a later-line `&&` when the command is multiline", async () => {
			// Regression for #?: the `^cd ... && ...` extractor used `\s` and `[^&\\]`,
			// which let the lazy match cross newlines and capture the whole script as the
			// "cwd" when any later line contained `&&`. The model intended `cd` to run as
			// part of a multiline script, not to relocate the entire command.
			const command = [
				"cd /this/directory/definitely/does/not/exist/12345",
				"echo first-line",
				"echo second && echo third",
			].join("\n");
			const result = await bashTool.execute("test-call-multiline-cd", { command });
			const output = getTextOutput(result);
			expect(output).toContain("first-line");
			expect(output).toContain("second");
			expect(output).toContain("third");
		});

		it("should expose background-job tools when bash auto-background is enabled", () => {
			const autoBackgroundSession = createTestToolSession(
				testDir,
				Settings.isolated({ "bash.autoBackground.enabled": true }),
			);

			expect(JobTool.createIf(autoBackgroundSession)).not.toBeNull();
		});
	});

	describe("JobTool", () => {
		it("should wait for jobs and acknowledge deliveries to prevent race conditions", async () => {
			const manager = new AsyncJobManager({
				onJobComplete: async () => {},
			});
			const session = createTestToolSession(testDir, Settings.isolated({ "bash.autoBackground.enabled": true }), {});
			AsyncJobManager.setInstance(manager);
			const jobTool = JobTool.createIf(session)!;

			const jobId = manager.register("bash", "test job", async () => "success");

			// Job is running, call poll
			const resultPromise = jobTool.execute("test-call-poll-1", { poll: [jobId] });

			// Ensure poll finished
			const result = await resultPromise;
			expect(getTextOutput(result)).toContain("Completed");

			// Wait for deliveries to be processed
			await manager.drainDeliveries({ timeoutMs: 100 });

			// If it correctly acknowledged, the delivery is suppressed.
			expect(manager.hasPendingDeliveries()).toBe(false);
		});

		it("should show retained output for a running job without waiting", async () => {
			const manager = new AsyncJobManager({
				onJobComplete: async () => {},
			});
			const session = createTestToolSession(testDir, Settings.isolated({ "bash.autoBackground.enabled": true }), {});
			AsyncJobManager.setInstance(manager);
			const jobTool = JobTool.createIf(session)!;

			const jobId = manager.register("bash", "long job", async ({ signal }) => {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return "done";
			});
			manager.appendOutput(jobId, "line one\n");
			manager.appendOutput(jobId, "line two\n");

			const result = await jobTool.execute("test-call-tail-1", { tail: [jobId] });
			const output = getTextOutput(result);

			expect(output).toContain("Still Running");
			expect(output).toContain("Retained Output");
			expect(output).toContain("line one");
			expect(output).toContain("line two");
			expect(result.details?.output?.[0]).toMatchObject({
				id: jobId,
				text: "line one\nline two\n",
				truncated: false,
			});

			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 100 });
		});

		it("should scope retained output tails to the calling owner", async () => {
			const manager = new AsyncJobManager({
				onJobComplete: async () => {},
			});
			const ownerSession = createTestToolSession(
				testDir,
				Settings.isolated({ "bash.autoBackground.enabled": true }),
				{
					getAgentId: () => "0-Owner",
				},
			);
			const otherSession = createTestToolSession(
				testDir,
				Settings.isolated({ "bash.autoBackground.enabled": true }),
				{
					getAgentId: () => "0-Other",
				},
			);
			AsyncJobManager.setInstance(manager);
			const ownerTool = JobTool.createIf(ownerSession)!;
			const otherTool = JobTool.createIf(otherSession)!;

			const jobId = manager.register(
				"bash",
				"private job",
				async ({ signal }) => {
					await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
					return "done";
				},
				{ ownerId: "0-Owner" },
			);
			manager.appendOutput(jobId, "owner-only\n");

			const ownerResult = await ownerTool.execute("test-call-tail-owner", { tail: [jobId] });
			const otherResult = await otherTool.execute("test-call-tail-other", { tail: [jobId] });

			expect(ownerResult.details?.output?.[0]?.text).toBe("owner-only\n");
			expect(otherResult.details?.output).toBeUndefined();
			expect(getTextOutput(otherResult)).not.toContain("owner-only");

			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 100 });
		});
	});

	describe("search tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = path.join(testDir, "example.txt");
			fs.writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await searchTool.execute("test-call-11", {
				pattern: "match",
				paths: [testFile],
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("# example.txt");
			// PI_EDIT_VARIANT=replace in beforeEach disables hashlines; expect line-number mode
			expect(output).toMatch(/\*2\|match line/);
		});

		it("should accept wildcard patterns in paths", async () => {
			fs.writeFileSync(path.join(testDir, "schema-review-alpha.test.ts"), "review target\n");
			fs.writeFileSync(path.join(testDir, "schema-review-beta.test.ts"), "review target\n");
			fs.writeFileSync(path.join(testDir, "schema-other.test.ts"), "review target\n");

			const result = await searchTool.execute("test-call-11-path-glob", {
				pattern: "review target",
				paths: [`${testDir}/schema-review-*.test.ts`],
			});

			const output = getTextOutput(result);
			expect(output).toContain("# schema-review-alpha.test.ts");
			expect(output).toContain("# schema-review-beta.test.ts");
			expect(output).not.toContain("schema-other.test.ts");
			expect(result.details?.fileCount).toBe(2);
		});
		it("should accept nested wildcard filters in paths", async () => {
			const packageDir = path.join(testDir, "node_modules", ".bun");
			const aiDir = path.join(packageDir, "ai@6.0.119+build123", "node_modules", "ai");
			const nestedDir = path.join(aiDir, "nested");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(aiDir, "root.ts"), "providerOptions\n");
			fs.writeFileSync(path.join(nestedDir, "child.d.ts"), "providerOptions\n");
			fs.writeFileSync(path.join(aiDir, "ignore.js"), "providerOptions\n");
			fs.writeFileSync(path.join(testDir, "outside.ts"), "providerOptions\n");

			const result = await searchTool.execute("test-call-11-path-and-glob", {
				pattern: "providerOptions",
				paths: [`${packageDir}/ai@6.0.119+*/node_modules/ai/**/*.{d.ts,ts}`],
				gitignore: false,
			});

			const output = getTextOutput(result);
			expect(output).toContain("## root.ts");
			expect(output).toContain("## child.d.ts");
			expect(output).not.toContain("ignore.js");
			expect(output).not.toContain("outside.ts");
			expect(result.details?.fileCount).toBe(2);
		});

		it("should include configured context lines", async () => {
			const testFile = path.join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			fs.writeFileSync(testFile, content);

			const contextSettings = Settings.isolated({ "search.contextBefore": 1, "search.contextAfter": 1 });
			const contextSearchTool = wrapToolWithMetaNotice(
				new SearchTool(createTestToolSession(testDir, contextSettings)),
			);
			const result = await contextSearchTool.execute("test-call-12", {
				pattern: "match",
				paths: [testFile],
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("# context.txt");
			expect(output).toMatch(/ 1\|before/);
			expect(output).toMatch(/\*2\|match one/);
			expect(output).toMatch(/ 3\|after/);
			expect(output).toMatch(/\*5\|match two/);
		});

		it("inserts a gap separator between non-contiguous match blocks", async () => {
			const testFile = path.join(testDir, "gaps.txt");
			const lines = Array.from({ length: 10 }, (_, idx) => (idx === 0 || idx === 5 ? "match" : `filler ${idx}`));
			fs.writeFileSync(testFile, lines.join("\n"));

			const noContextSettings = Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 });
			const noContextSearchTool = wrapToolWithMetaNotice(
				new SearchTool(createTestToolSession(testDir, noContextSettings)),
			);
			const result = await noContextSearchTool.execute("test-call-12-gap", {
				pattern: "match",
				paths: [testFile],
			});

			const output = getTextOutput(result);
			expect(output).toMatch(/\*1\|match\n\.\.\.\n\*6\|match/);
		});

		it("should paginate files via the skip parameter", async () => {
			const skipDir = path.join(testDir, "skip-dir");
			fs.mkdirSync(skipDir, { recursive: true });
			for (let i = 1; i <= 4; i++) {
				fs.writeFileSync(path.join(skipDir, `file-${i}.txt`), `needle ${i}`);
			}

			const first = await searchTool.execute("test-call-12-skip-first", {
				pattern: "needle",
				paths: [skipDir],
			});
			expect(first.details?.fileCount).toBe(4);

			const second = await searchTool.execute("test-call-12-skip-page", {
				pattern: "needle",
				paths: [skipDir],
				skip: 2,
			});
			const secondOutput = getTextOutput(second);
			expect(second.details?.fileCount).toBe(2);
			expect(secondOutput).not.toContain("# file-1.txt");
			expect(secondOutput).not.toContain("# file-2.txt");
			expect(secondOutput).toContain("# file-3.txt");
			expect(secondOutput).toContain("# file-4.txt");
		});

		it("should group multi-file matches", async () => {
			for (let i = 1; i <= 3; i++) {
				fs.writeFileSync(path.join(testDir, `file-${i}.txt`), `needle in file ${i}\nextra needle ${i}`);
			}
			fs.writeFileSync(path.join(testDir, "dominant.txt"), "needle a\nneedle b\nneedle c\nneedle d");

			const result = await searchTool.execute("test-call-13-round-robin", {
				pattern: "needle",
				paths: [testDir],
			});

			const output = getTextOutput(result);
			expect(output).toContain("# file-1.txt");
			expect(output).toContain("# file-2.txt");
			expect(output).toContain("# file-3.txt");
			expect(output).toContain("# dominant.txt");
			expect(output).not.toContain("# .");
			expect(output).not.toContain("Result limit reached");
			expect(result.details?.fileCount).toBe(4);
			expect(result.details?.matchCount).toBe(10);
		});

		it("should not repeat file headings for multiple matches per file", async () => {
			fs.writeFileSync(path.join(testDir, "alpha.txt"), "needle a1\nneedle a2\nneedle a3");
			fs.writeFileSync(path.join(testDir, "beta.txt"), "needle b1\nneedle b2\nneedle b3");

			const result = await searchTool.execute("test-call-14-grouped-headings", {
				pattern: "needle",
				paths: [testDir],
			});

			const output = getTextOutput(result);
			const alphaHeadings = output.match(/# alpha\.txt/g)?.length ?? 0;
			const betaHeadings = output.match(/# beta\.txt/g)?.length ?? 0;
			expect(alphaHeadings).toBe(1);
			expect(betaHeadings).toBe(1);
			expect(result.details?.fileMatches).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "alpha.txt", count: 3 }),
					expect.objectContaining({ path: "beta.txt", count: 3 }),
				]),
			);
		});

		it("should group files under directory headings", async () => {
			const nestedDir = path.join(testDir, "packages", "ai");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(nestedDir, "CHANGELOG.md"), "Claude Opus\n");
			fs.writeFileSync(path.join(nestedDir, "models.json"), '{ "name": "Claude Opus" }\n');

			const result = await searchTool.execute("test-call-15-directory-headings", {
				pattern: "Claude Opus",
				paths: [testDir],
			});

			const output = getTextOutput(result);
			expect(output).toContain("# packages/ai");
			expect(output).toContain("## CHANGELOG.md");
			expect(output).toContain("## models.json");
			expect(result.details?.fileCount).toBeGreaterThanOrEqual(2);
		});

		it("should respect .gitignore by default", async () => {
			const scenarioDir = path.join(testDir, "grep-gitignore-default");
			fs.mkdirSync(path.join(scenarioDir, ".git"), { recursive: true });
			fs.writeFileSync(path.join(scenarioDir, ".gitignore"), "ignored.txt\n");
			fs.writeFileSync(path.join(scenarioDir, "ignored.txt"), "needle ignored\n");
			fs.writeFileSync(path.join(scenarioDir, "kept.txt"), "needle kept\n");

			const result = await searchTool.execute("test-call-15-gitignore-default", {
				pattern: "needle",
				paths: [scenarioDir],
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
			expect(result.details?.fileCount).toBe(1);
			expect(result.details?.matchCount).toBe(1);
		});

		it("should include ignored files when gitignore is false", async () => {
			const scenarioDir = path.join(testDir, "grep-gitignore-off");
			fs.mkdirSync(path.join(scenarioDir, ".git"), { recursive: true });
			fs.writeFileSync(path.join(scenarioDir, ".gitignore"), "ignored.txt\n");
			fs.writeFileSync(path.join(scenarioDir, "ignored.txt"), "needle ignored\n");

			const result = await searchTool.execute("test-call-16-gitignore-off", {
				pattern: "needle",
				paths: [scenarioDir],
				gitignore: false,
			});

			const output = getTextOutput(result);
			expect(output).toContain("ignored.txt");
			expect(result.details?.fileCount).toBe(1);
			expect(result.details?.matchCount).toBe(1);
		});

		it("should ignore FIFOs when searching a directory with gitignore disabled", async () => {
			const scenarioDir = path.join(testDir, "grep-fifo-dir");
			fs.mkdirSync(scenarioDir, { recursive: true });
			fs.writeFileSync(path.join(scenarioDir, "match.txt"), "needle kept\n");
			const fifoPath = path.join(scenarioDir, "blocked.fifo");

			if (!createFifoOrSkip(fifoPath)) {
				return;
			}

			const result = await searchTool.execute("test-call-16-fifo-dir", {
				pattern: "needle",
				paths: [scenarioDir],
				gitignore: false,
			});

			const output = getTextOutput(result);
			expect(output).toContain("match.txt");
			expect(output).toContain("needle kept");
			expect(output).not.toContain("blocked.fifo");
			expect(output).not.toContain("## blocked.fifo");
			expect(result.details?.fileCount).toBe(1);
			expect(result.details?.matchCount).toBe(1);
		});
		it("should cap distinct files and surface pagination", async () => {
			const limitDir = path.join(testDir, "file-limit-dir");
			fs.mkdirSync(limitDir, { recursive: true });
			const totalFiles = DEFAULT_FILE_LIMIT + 4;
			for (let i = 1; i <= totalFiles; i++) {
				fs.writeFileSync(path.join(limitDir, `f-${String(i).padStart(2, "0")}.txt`), `needle ${i}`);
			}

			const result = await searchTool.execute("test-call-14-file-limit", {
				pattern: "needle",
				paths: [limitDir],
			});

			const output = getTextOutput(result);
			expect(result.details?.fileCount).toBe(DEFAULT_FILE_LIMIT);
			expect(result.details?.matchCount).toBe(DEFAULT_FILE_LIMIT);
			expect(result.details?.fileLimitReached).toBe(DEFAULT_FILE_LIMIT);
			expect(output).toContain(`Showing files 1-${DEFAULT_FILE_LIMIT} of ${totalFiles}`);
			expect(output).toContain(`Use skip=${DEFAULT_FILE_LIMIT}`);
		});

		it("should cap matches per file in multi-file scopes", async () => {
			const concDir = path.join(testDir, "concentration-dir");
			fs.mkdirSync(concDir, { recursive: true });
			const hotMatches = MULTI_FILE_PER_FILE_MATCHES + 30;
			fs.writeFileSync(
				path.join(concDir, "hot.txt"),
				Array.from({ length: hotMatches }, (_, i) => `needle ${i + 1}`).join("\n"),
			);
			fs.writeFileSync(path.join(concDir, "cool.txt"), "needle cool");

			const result = await searchTool.execute("test-call-14-per-file-cap", {
				pattern: "needle",
				paths: [concDir],
			});

			const hotCount = result.details?.fileMatches?.find(entry => entry.path.endsWith("hot.txt"))?.count ?? 0;
			expect(hotCount).toBe(MULTI_FILE_PER_FILE_MATCHES);
			expect(result.details?.perFileLimitReached).toBe(MULTI_FILE_PER_FILE_MATCHES);
		});

		it("should let a single-file scope exceed the multi-file per-file cap", async () => {
			const single = path.join(testDir, "single-file.txt");
			const count = MULTI_FILE_PER_FILE_MATCHES + 30;
			fs.writeFileSync(single, Array.from({ length: count }, (_, i) => `needle ${i + 1}`).join("\n"));

			const result = await searchTool.execute("test-call-14-single-file-cap", {
				pattern: "needle",
				paths: [single],
			});

			expect(result.details?.matchCount).toBe(count);
			expect(result.details?.fileLimitReached).toBeUndefined();
			expect(result.details?.perFileLimitReached).toBeUndefined();
		});
	});

	describe("find tool", () => {
		it("should return a single file when given a file path", async () => {
			const testFile = path.join(testDir, "single.txt");
			fs.writeFileSync(testFile, "single");

			const result = await findTool.execute("test-call-13a", {
				paths: [testFile],
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean);

			expect(outputLines).toEqual(["single.txt"]);
		});

		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = path.join(testDir, ".secret");
			fs.mkdirSync(hiddenDir);
			fs.writeFileSync(path.join(hiddenDir, "hidden.txt"), "hidden");
			fs.writeFileSync(path.join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				paths: [`${testDir}/**/*.txt`],
				hidden: true,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			fs.mkdirSync(path.join(testDir, ".git"));
			fs.writeFileSync(path.join(testDir, ".gitignore"), "ignored.txt\n");
			fs.writeFileSync(path.join(testDir, "ignored.txt"), "ignored");
			fs.writeFileSync(path.join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				paths: [`${testDir}/**/*.txt`],
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should sort exact recursive filename matches by mtime", async () => {
			const olderDir = path.join(testDir, "a");
			const newerDir = path.join(testDir, "z");
			fs.mkdirSync(olderDir, { recursive: true });
			fs.mkdirSync(newerDir, { recursive: true });

			const olderFile = path.join(olderDir, "auth-actions.spec.ts");
			const newerFile = path.join(newerDir, "auth-actions.spec.ts");
			fs.writeFileSync(olderFile, "old\n");
			fs.writeFileSync(newerFile, "new\n");

			const olderTime = new Date(Date.now() - 60_000);
			const newerTime = new Date();
			fs.utimesSync(olderFile, olderTime, olderTime);
			fs.utimesSync(newerFile, newerTime, newerTime);

			const result = await findTool.execute("test-call-14b", {
				paths: [`${testDir}/**/auth-actions.spec.ts`],
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean);

			expect(outputLines).toEqual(["z/auth-actions.spec.ts", "a/auth-actions.spec.ts"]);
		});

		it("should render nested glob results relative to the session cwd", async () => {
			const nestedDir = path.join(testDir, "apps", "daemon", "src", "telemetry");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(nestedDir, "daemon-telemetry.ts"), "telemetry\n");

			const result = await findTool.execute("test-call-14c", {
				paths: ["apps/daemon/src/**/daemon-telemetry.ts"],
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean);

			expect(outputLines).toEqual(["apps/daemon/src/telemetry/daemon-telemetry.ts"]);
		});

		it("should not double-prefix multi-pattern results under a shared base", async () => {
			const daemonDir = path.join(testDir, "apps", "daemon", "src");
			const clientDir = path.join(testDir, "apps", "client", "src");
			fs.mkdirSync(daemonDir, { recursive: true });
			fs.mkdirSync(clientDir, { recursive: true });
			fs.writeFileSync(path.join(daemonDir, "daemon.ts"), "daemon\n");
			fs.writeFileSync(path.join(clientDir, "client.ts"), "client\n");

			const result = await findTool.execute("test-call-14e", {
				paths: ["apps/daemon/src/**/*.ts", "apps/client/src/**/*.ts"],
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean)
				.sort();

			expect(outputLines).toEqual(["apps/client/src/client.ts", "apps/daemon/src/daemon.ts"]);
		});

		it("should not disable gitignore after an ignored broad hidden-file search finds no matches", async () => {
			fs.mkdirSync(path.join(testDir, ".git"));
			fs.writeFileSync(path.join(testDir, ".gitignore"), ".env*\nignored-generated/\n");
			fs.writeFileSync(path.join(testDir, ".env.local"), "SECRET=value\n");
			fs.mkdirSync(path.join(testDir, "ignored-generated"));
			fs.writeFileSync(path.join(testDir, "ignored-generated", ".env.generated"), "SECRET=value\n");

			const startedAt = performance.now();
			const result = await findTool.execute("test-call-14d", {
				paths: ["**/.env*"],
			});
			const elapsedMs = performance.now() - startedAt;

			const output = getTextOutput(result);
			expect(output).toContain("No files found matching pattern");
			expect(output).not.toContain(".env.local");
			expect(output).not.toContain(".env.generated");
			expect(elapsedMs).toBeLessThan(1000);
		});
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;
	let editTool: EditTool;
	let originalEditVariant: string | undefined;

	beforeEach(() => {
		// Force replace mode for edit tool tests using old_text/new_text
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "replace";

		testDir = path.join(os.tmpdir(), `coding-agent-crlf-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		editTool = new EditTool(createTestToolSession(testDir));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });

		// Restore original edit variant
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
	});

	it("should match LF old_text against CRLF file content", async () => {
		const testFile = path.join(testDir, "crlf-test.txt");

		fs.writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ old_text: "line two\n", new_text: "replaced line\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = path.join(testDir, "crlf-preserve.txt");
		fs.writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ old_text: "second\n", new_text: "REPLACED\n" }],
		});

		const content = await Bun.file(testFile).text();
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = path.join(testDir, "lf-preserve.txt");
		fs.writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ old_text: "second\n", new_text: "REPLACED\n" }],
		});

		const content = await Bun.file(testFile).text();
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = path.join(testDir, "mixed-endings.txt");

		fs.writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ old_text: "hello\nworld\n", new_text: "replaced\n" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	// TODO: CRLF preservation broken by LSP formatting - fix later
	it.skip("should preserve UTF-8 BOM after edit", async () => {
		const testFile = path.join(testDir, "bom-test.txt");
		fs.writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ old_text: "second\n", new_text: "REPLACED\n" }],
		});

		const content = await Bun.file(testFile).text();
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});
});
