import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { wrapToolWithMetaNotice } from "@gajae-code/coding-agent/tools/output-meta";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import * as markit from "@gajae-code/coding-agent/utils/markit";
import * as native from "@gajae-code/natives";
import { Snowflake } from "@gajae-code/utils";

let markitContent = "";
let summarySegments: Array<{ kind: string; startLine: number; endLine: number; text?: string }> | null = null;
let artifactCounter = 0;

function createSession(cwd: string, settings: Settings = Settings.isolated()): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		hasEditTool: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
	} as unknown as ToolSession;
}

function createContext(settings: Settings, cwd: string): AgentToolContext {
	return {
		sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
		settings,
		toolNames: ["read"],
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as AgentToolContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function bodyOf(result: { details?: { displayContent?: { text: string } } }): string {
	return result.details?.displayContent?.text ?? "";
}

function receiptSettings(extra: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"tools.maxInlineResultBytes": 0,
		"tools.readArtifactSpillThreshold": 1,
		"read.summarize.enabled": false,
		readHashLines: false,
		...extra,
	});
}

describe("read receipt by default", () => {
	let testDir: string;
	let convertFileSpy: { mockRestore(): void } | undefined;
	let convertBufferSpy: { mockRestore(): void } | undefined;
	let summarizeCodeSpy: { mockRestore(): void } | undefined;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-receipt-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		markitContent = "";
		summarySegments = null;

		const convertFileWithMarkit = markit.convertFileWithMarkit;
		convertFileSpy = vi
			.spyOn(markit, "convertFileWithMarkit")
			.mockImplementation((...args) =>
				markitContent ? Promise.resolve({ ok: true, content: markitContent }) : convertFileWithMarkit(...args),
			);
		const convertBufferWithMarkit = markit.convertBufferWithMarkit;
		convertBufferSpy = vi
			.spyOn(markit, "convertBufferWithMarkit")
			.mockImplementation((...args) =>
				markitContent ? Promise.resolve({ ok: true, content: markitContent }) : convertBufferWithMarkit(...args),
			);
		const summarizeCode = native.summarizeCode;
		summarizeCodeSpy = vi.spyOn(native, "summarizeCode").mockImplementation((...args) =>
			summarySegments !== null
				? Promise.resolve({
						parsed: true,
						elided: true,
						totalLines: Math.max(0, ...summarySegments.map(segment => segment.endLine)),
						segments: summarySegments,
					})
				: summarizeCode(...args),
		);
	});

	afterEach(() => {
		summarizeCodeSpy?.mockRestore();
		convertBufferSpy?.mockRestore();
		convertFileSpy?.mockRestore();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	async function read(filePath: string, settings = receiptSettings(), params: Record<string, unknown> = {}) {
		const tool = wrapToolWithMetaNotice(new ReadTool(createSession(testDir, settings)));
		return tool.execute(
			"read-receipt",
			{ path: filePath, ...params },
			undefined,
			undefined,
			createContext(settings, testDir),
		);
	}

	it("returns a bounded, non-spillable receipt for a large prose file", async () => {
		const file = path.join(testDir, "prose.txt");
		const lines = Array.from({ length: 180 }, (_, i) => `${i + 1} ${"prose ".repeat(24)}`);
		fs.writeFileSync(file, lines.join("\n"));

		const result = await read(file);
		const text = textOf(result);
		const body = bodyOf(result);
		expect(body.split("\n")).toHaveLength(50);
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(10 * 1024);
		expect(text).toContain(`re-read ${file}:1-${lines.length} or ${file}:raw`);
		expect(result.details?.spillEligible).not.toBe(true);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});

	it("removes the old byte floor only for bare reads", async () => {
		const file = path.join(testDir, "wide-lines.txt");
		fs.writeFileSync(file, Array.from({ length: 150 }, (_, i) => `${i} ${"x".repeat(395)}`).join("\n"));

		const result = await read(file);
		const body = bodyOf(result);
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(10 * 1024);
		expect(Buffer.byteLength(body, "utf8")).toBeLessThan(20 * 1024);
		expect(body.split("\n").length).toBeLessThan(50);
	});

	it("keeps multibyte receipts on complete UTF-8 line boundaries", async () => {
		const file = path.join(testDir, "unicode.txt");
		const line = "😀".repeat(80);
		fs.writeFileSync(file, Array.from({ length: 80 }, () => line).join("\n"));

		const result = await read(file);
		const body = bodyOf(result);
		expect(body.split("\n").every(value => value === line)).toBe(true);
		expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
		expect(textOf(result)).toContain("re-read");
	});

	it("keeps explicit ranges complete and spill-eligible", async () => {
		const file = path.join(testDir, "range.txt");
		fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n"));

		const result = await read(`${file}:1-40`, receiptSettings({ "tools.maxInlineResultBytes": 0 }));
		const text = textOf(result);
		expect(text).toContain("line-40");
		expect(text).not.toContain("re-read");
		expect(result.details?.spillEligible).toBe(true);
	});

	it("reads raw files through EOF below the raw collector ceiling", async () => {
		const file = path.join(testDir, "raw.txt");
		const source = Array.from({ length: 500 }, (_, i) => `raw-${i} ${"x".repeat(40)}`).join("\n");
		fs.writeFileSync(file, source);

		const result = await read(`${file}:raw`, receiptSettings({ "tools.maxInlineResultBytes": 0 }));
		// A complete raw read is pure verbatim: no footer/anchors appended.
		expect(textOf(result)).not.toContain("Raw read");
		expect(textOf(result)).toContain("raw-0 ");
		expect(textOf(result)).toContain("raw-499");
		expect(result.details?.spillEligible).toBe(true);
	});

	it("bounds an oversized first line at a valid UTF-8 boundary without spilling", async () => {
		const file = path.join(testDir, "single-line.txt");
		fs.writeFileSync(file, "😀".repeat(6_000));

		const result = await read(file);
		const text = textOf(result);
		const body = bodyOf(result);
		expect(body.length).toBeGreaterThan(0);
		expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
		expect(text).toContain("re-read");
		expect(result.details?.spillEligible).not.toBe(true);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});

	it("caps structural summaries by units and retains both recovery footers once", async () => {
		const file = path.join(testDir, "summary.ts");
		fs.writeFileSync(file, "export const placeholder = true;\n");
		const kept = Array.from({ length: 100 }, (_, i) => ({
			kind: "code",
			startLine: i + 1,
			endLine: i + 1,
			text: `const line${i} = "${"x".repeat(300)}";`,
		}));
		summarySegments = [{ kind: "elided", startLine: 101, endLine: 110 }, ...kept];

		const result = await read(file, receiptSettings({ "read.summarize.enabled": true }));
		const text = textOf(result);
		expect(text.match(/elided region/g)?.length).toBe(1);
		expect(text.match(/Summary truncated at 20 KiB/g)?.length).toBe(1);
		expect(text).toContain("elided");
		expect(result.details?.summary?.elidedLines).toBeGreaterThan(10);
		expect(result.details?.spillEligible).not.toBe(true);

		summarySegments = [{ kind: "code", startLine: 1, endLine: 1, text: "export const x = 1;" }];
		const small = await read(file, receiptSettings({ "read.summarize.enabled": true }));
		expect(textOf(small)).not.toContain("Summary truncated at");
	});
	it("stubs summarizeCode as a real async SummaryResult with the full schema", async () => {
		const file = path.join(testDir, "summary-schema-regression.ts");
		fs.writeFileSync(file, "export const x = 1;\n");
		summarySegments = [
			{ kind: "code", startLine: 1, endLine: 1, text: "export const x = 1;" },
			{ kind: "elided", startLine: 2, endLine: 40 },
		];

		// The stub branch must honor the native async contract exactly: it
		// resolves a full SummaryResult (parsed/elided/totalLines/segments).
		// A bare object return, a dropped totalLines, or a cast that hides
		// the sync/async drift fails the type check or these assertions.
		const pending = native.summarizeCode({ path: file, code: "export const x = 1;\n" });
		expect(pending).toBeInstanceOf(Promise);
		const summary = await pending;
		expect(summary).toEqual({
			parsed: true,
			elided: true,
			totalLines: 40,
			segments: summarySegments,
		});

		// The stubbed schema also flows through the tool end to end.
		const result = await read(file, receiptSettings({ "read.summarize.enabled": true }));
		expect(result.details?.summary?.elidedSpans).toBe(1);
		expect(result.details?.summary?.elidedLines).toBe(39);
		expect(textOf(result)).toContain("elided");
	});

	it("bounds directories by bytes and lines without spilling while preserving small listings", async () => {
		const large = path.join(testDir, "large-dir");
		fs.mkdirSync(large);
		for (let i = 0; i < 12; i++) {
			const parent = path.join(large, `${i}-${"d".repeat(200)}`);
			fs.mkdirSync(parent);
			for (let j = 0; j < 12; j++) fs.mkdirSync(path.join(parent, `${j}-${"e".repeat(200)}`));
		}
		const result = await read(large);
		const text = textOf(result);
		const body = text.split("\n\n[")[0] ?? "";
		expect(body.split("\n").length).toBeLessThanOrEqual(50);
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(10 * 1024);
		expect(text).toContain("read a deeper subpath");
		expect(result.details?.spillEligible).not.toBe(true);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();

		const small = path.join(testDir, "small-dir");
		fs.mkdirSync(small);
		fs.writeFileSync(path.join(small, "one.txt"), "x");
		const smallResult = await read(small);
		expect(textOf(smallResult)).not.toContain("Listing truncated");
	});

	it("renders converted documents selector-aware with bare receipts and explicit spill eligibility", async () => {
		const file = path.join(testDir, "document.pdf");
		fs.writeFileSync(file, "not a real pdf");
		markitContent = Array.from({ length: 100 }, (_, i) => `converted-${i + 1}`).join("\n");

		const bare = await read(file);
		expect(bodyOf(bare).split("\n")).toHaveLength(50);
		expect(textOf(bare)).toContain(`re-read ${file}:1-100 or ${file}:raw`);
		expect(bare.details?.spillEligible).not.toBe(true);
		expect(bare.details?.meta?.truncation?.artifactId).toBeUndefined();

		const ranged = await read(`${file}:1-40`, receiptSettings({ "tools.maxInlineResultBytes": 0 }));
		expect(textOf(ranged)).toContain("converted-40");
		expect(textOf(ranged)).not.toContain("re-read");
		expect(ranged.details?.spillEligible).toBe(true);

		const raw = await read(`${file}:raw`, receiptSettings({ "tools.maxInlineResultBytes": 0 }));
		expect(textOf(raw)).toContain("converted-100");
		expect(raw.details?.spillEligible).toBe(true);

		markitContent = "converted-1\nconverted-2";
		const completeBare = await read(file);
		expect(textOf(completeBare)).not.toContain("re-read");
	});

	it("spills complete converted raw content instead of its 50 KiB preview", async () => {
		const file = path.join(testDir, "large-document.pdf");
		fs.writeFileSync(file, "not a real pdf");
		markitContent = Array.from({ length: 3_000 }, (_, i) => `converted-${i} ${"x".repeat(100)}`).join("\n");

		const settings = receiptSettings({ "tools.readArtifactSpillThreshold": 256 });
		const sessionManager = SessionManager.create(testDir, path.join(testDir, "sessions"));
		const tool = wrapToolWithMetaNotice(new ReadTool(createSession(testDir)));
		const result = await tool.execute("read-receipt", { path: `${file}:raw` }, undefined, undefined, {
			...createContext(settings, testDir),
			sessionManager,
		});
		const artifactId = result.details?.meta?.truncation?.artifactId;
		expect(artifactId).toBeDefined();
		const artifactPath = await sessionManager.getArtifactPath(artifactId ?? "");
		expect(artifactPath).not.toBeNull();
		expect(await Bun.file(artifactPath ?? "").text()).toBe(markitContent);
	});
	it("keeps an oversized multibyte first bare line within the receipt byte budget", async () => {
		const file = path.join(testDir, "oversized-first-line.txt");
		fs.writeFileSync(file, "😀".repeat(6_000));

		const result = await read(file, receiptSettings({ "tools.readArtifactSpillThreshold": 1 }));
		const body = bodyOf(result);
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(10 * 1024);
		expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
		expect(textOf(result)).toContain("re-read");
		expect(result.details?.spillEligible).not.toBe(true);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});

	it("keeps all-out-of-bounds multi-range reads notice-only and non-spillable", async () => {
		const file = path.join(testDir, "ten-lines.txt");
		fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n"));

		const result = await read(`${file}:9000-9001,10000-10001`);
		expect(textOf(result)).toContain("Range 9000-9001 is beyond end of file (10 lines total); skipped");
		expect(textOf(result)).toContain("Range 10000-10001 is beyond end of file (10 lines total); skipped");
		expect(result.details?.spillEligible).not.toBe(true);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});

	it("spills explicit multi-ranges above the default 256 KiB threshold", async () => {
		const file = path.join(testDir, "default-threshold-multi-range.txt");
		fs.writeFileSync(file, Array.from({ length: 1_100 }, (_, i) => `${i + 1} ${"x".repeat(400)}`).join("\n"));

		const result = await read(`${file}:1-500,601-1100`, receiptSettings({ "tools.readArtifactSpillThreshold": 256 }));
		expect(result.details?.spillEligible).toBe(true);
		expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
		expect(textOf(result)).toContain("artifact://");
	});

	it("returns a small raw file as exact verbatim bytes without decorations", async () => {
		const file = path.join(testDir, "exact-raw.txt");
		const source = "first\n😀\u200b\u0301\nlast";
		fs.writeFileSync(file, source);

		const result = await read(`${file}:raw`, receiptSettings({ "tools.maxInlineResultBytes": 0 }));
		expect(textOf(result)).toBe(source);
		expect(Buffer.from(textOf(result), "utf8")).toEqual(Buffer.from(source, "utf8"));
		expect(textOf(result)).not.toContain("re-read");
		expect(textOf(result)).not.toContain("|");
	});

	it("uses the universal inline backstop without making bare reads threshold-spillable", async () => {
		const file = path.join(testDir, "backstop-precedence.txt");
		fs.writeFileSync(file, Array.from({ length: 100 }, () => "x".repeat(200)).join("\n"));

		const result = await read(
			file,
			receiptSettings({ "tools.readArtifactSpillThreshold": 1, "tools.maxInlineResultBytes": 1 }),
		);
		expect(result.details?.spillEligible).not.toBe(true);
		// The read-level threshold cannot spill a bare receipt; the separately universal backstop can.
		expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
		expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(1 * 1024);
	});

	it("backstop supersedes a body-owned directional footer instead of duplicating the model notice", async () => {
		const file = path.join(testDir, "directional-backstop.txt");
		fs.writeFileSync(file, Array.from({ length: 120 }, (_, i) => `${i + 1} ${"x".repeat(200)}`).join("\n"));
		const settings = receiptSettings({
			"read.truncation": "both",
			"read.receiptBudgetLines": 50,
			"read.receiptBudgetBytes": 10,
			"tools.maxInlineResultBytes": 1,
		});

		const result = await read(file, settings, { truncation: "both" });
		const text = textOf(result);

		expect((text.match(/\[Showing/g) ?? []).length).toBe(1);
		expect(result.details?.meta?.truncation?.noticeOwner).toBeUndefined();
	});
});
