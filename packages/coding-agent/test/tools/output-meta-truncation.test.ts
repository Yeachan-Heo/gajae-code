import { describe, expect, test, vi } from "bun:test";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import { Settings } from "../../src/config/settings";
import { createReadonlySessionManager, SessionManager } from "../../src/session/session-manager";
import { truncateHead, truncateMiddleWindows } from "../../src/session/streaming-output";
import {
	formatOutputNotice,
	formatTruncationMetaNotice,
	outputMeta,
	resolveBashOutputSinkHeadBytes,
	resolveBashOutputSinkTailBytes,
	stripOutputNotice,
	wrapToolWithMetaNotice,
} from "../../src/tools/output-meta";
import { ToolError } from "../../src/tools/tool-errors";

describe("output truncation metadata plumbing", () => {
	test("resolves Bash retention from its own keys: 1 KiB tail and no head by default", () => {
		expect(resolveBashOutputSinkTailBytes(Settings.isolated())).toBe(1024);
		expect(resolveBashOutputSinkTailBytes(Settings.isolated({ "tools.bashOutputTailBytes": 7 }))).toBe(7 * 1024);
		expect(resolveBashOutputSinkHeadBytes(Settings.isolated())).toBe(0);
		expect(resolveBashOutputSinkHeadBytes(Settings.isolated({ "tools.bashOutputHeadBytes": 7 }))).toBe(7 * 1024);
	});
	test("shared artifact budgets no longer leak into Bash retention", () => {
		const shared = Settings.isolated({ "tools.artifactTailBytes": 20, "tools.artifactHeadBytes": 20 });
		expect(resolveBashOutputSinkTailBytes(shared)).toBe(1024);
		expect(resolveBashOutputSinkHeadBytes(shared)).toBe(0);
	});
	test("forwards noticeOwner on ordinary truncation builders", () => {
		const result = truncateHead("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });
		const meta = outputMeta().truncation(result, { direction: "head", noticeOwner: "body" }).get();
		expect(meta?.truncation?.noticeOwner).toBe("body");
	});

	test("preserves designed tool errors through the output wrapper", async () => {
		const expected = new ToolError("Tool call rejected by user (refuse)");
		const tool = wrapToolWithMetaNotice({
			name: "refuse",
			label: "Refuse",
			description: "refuses",
			parameters: z.object({}),
			execute: async (_toolCallId: string, _params: Record<string, never>) => {
				throw expected;
			},
		});

		let thrown: unknown;
		try {
			await tool.execute("call-1", {});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(expected);
	});

	test("uses actual windows for truncationWindows and forwards noticeOwner", () => {
		const windows = truncateMiddleWindows("aaaaa\nb\nc\nd\ne\nf\ng", { maxBytes: 12, maxLines: 10 });
		const meta = outputMeta().truncationWindows(windows, { noticeOwner: "body" }).get();
		expect(meta?.truncation).toMatchObject({
			direction: "middle",
			noticeOwner: "body",
			headRange: { start: 1, end: 1 },
			tailRange: { start: 5, end: 7 },
		});
	});

	test("labels selected-window coordinates in truncation notices", () => {
		const windows = truncateMiddleWindows("a\nb\nc\nd\ne", { maxBytes: 5, maxLines: 3 });
		const meta = outputMeta().truncationWindows(windows, { rangeBase: "window" }).get();
		const notice = formatOutputNotice(meta);
		expect(notice).toContain("of the selected 5-line range");
	});

	test("marks partial middle tails without inventing a complete tail range", () => {
		const windows = truncateMiddleWindows(`short\n${"Z".repeat(60_000)}`, { maxBytes: 10 * 1024, maxLines: 50 });
		const meta = outputMeta().truncationWindows(windows).get();
		const truncation = meta?.truncation;

		expect(truncation?.partialLine).toMatchObject({ line: 2, sourceBytes: 60_000 });
		expect(truncation?.headRange).toBeUndefined();
		expect(truncation?.tailRange).toBeUndefined();
		expect(formatOutputNotice(meta)).toContain("last");
		expect(formatOutputNotice(meta)).toContain("of line 2");
	});

	test("forwards noticeOwner through summary and text option interfaces", () => {
		const summaryMeta = outputMeta()
			.truncationFromSummary(
				{
					output: "one",
					truncated: true,
					totalLines: 2,
					totalBytes: 7,
					outputLines: 1,
					outputBytes: 3,
				},
				{ direction: "head", noticeOwner: "body" },
			)
			.get();
		expect(summaryMeta?.truncation?.noticeOwner).toBe("body");

		const textMeta = outputMeta()
			.truncationFromText("one", { direction: "head", totalLines: 2, noticeOwner: "body" })
			.get();
		expect(textMeta?.truncation?.noticeOwner).toBe("body");
	});

	test("preserves nextOffset pagination hint in middle-direction truncation notice", () => {
		// Regression test for #5966 blocker: when backstop truncates to middle,
		// the nextOffset hint must be preserved in the model-visible notice.
		// Simulate a large text that gets truncated to the middle by backstop.
		const largeText = Array(300)
			.fill(0)
			.map((_, i) => `line ${i} ${"".padEnd(64, "x")}`)
			.join("\n");

		const windows = truncateMiddleWindows(largeText, { maxBytes: 12 * 1024, maxLines: 50 });
		const meta = outputMeta().truncationWindows(windows, { artifactId: "art-full" }).get();

		// Add nextOffset to simulate the read tool adding a pagination hint
		if (meta?.truncation && meta.truncation.direction === "middle") {
			(meta.truncation as any).nextOffset = 304;
			const notice = formatTruncationMetaNotice(meta.truncation);
			// The notice should contain both the middle elision info and the nextOffset pagination hint
			expect(notice).toContain("elided"); // either "bytes" or "lines" depending on actual truncation
			expect(notice).toContain("Use :304 to continue"); // CRITICAL: nextOffset must be in notice
			expect(notice).toContain("artifact://art-full");
		}
	});
});

describe("inline backstop excerpt follows the result's retention policy", () => {
	const HEAD = "HEADMARK";
	const TAIL = "TAILMARK";
	const LINE_BYTES = 32;
	// Bodies stay below the 50 KiB threshold spill so only the backstop reshapes them.
	function bodyOf(lines: number): string {
		const line = (i: number) => `line-${String(i).padStart(5, "0")}${"x".repeat(LINE_BYTES - 11)}`;
		return `${HEAD}\n${Array.from({ length: lines }, (_, i) => line(i)).join("\n")}\n${TAIL}`;
	}

	function tool(name: string, text: string, retention?: "bash"): AgentTool {
		const result: AgentToolResult = {
			content: [{ type: "text", text }],
			...(retention ? { details: { meta: { retention } } } : {}),
		};
		return { name, description: "", parameters: {}, execute: async () => result } as unknown as AgentTool;
	}

	async function excerpt(
		subject: AgentTool,
		overrides: Record<string, number>,
	): Promise<{ text: string; bodyBytes: number }> {
		const manager = SessionManager.inMemory();
		const save = vi.spyOn(manager, "saveArtifact").mockImplementation(async () => "art-backstop");
		try {
			const context = {
				settings: Settings.isolated(overrides),
				sessionManager: createReadonlySessionManager(manager),
			} as AgentToolContext;
			const result = await wrapToolWithMetaNotice(subject).execute("c", {}, undefined, undefined, context);
			expect(save).toHaveBeenCalledTimes(1);
			const text = result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const body = stripOutputNotice(text, result.details?.meta);
			return { text, bodyBytes: Buffer.byteLength(body, "utf-8") };
		} finally {
			save.mockRestore();
		}
	}

	const small = bodyOf(120); // ~4 KiB

	test("bash output keeps a head when tools.bashOutputHeadBytes is set even if the shared head is 0", async () => {
		const { text } = await excerpt(tool("bash", small, "bash"), {
			"tools.maxInlineResultBytes": 1,
			"tools.bashOutputHeadBytes": 1,
			"tools.artifactHeadBytes": 0,
		});
		expect(text).toContain(HEAD);
		expect(text).toContain(TAIL);
	});

	test("bash output stays tail-only by default even if the shared head is 20 KB", async () => {
		const { text } = await excerpt(tool("bash", small, "bash"), {
			"tools.maxInlineResultBytes": 1,
			"tools.artifactHeadBytes": 20,
		});
		expect(text).not.toContain(HEAD);
		expect(text).toContain(TAIL);
	});

	test("a bash result returned under another tool name (recipe) still follows the bash budgets", async () => {
		const { text } = await excerpt(tool("recipe", small, "bash"), {
			"tools.maxInlineResultBytes": 1,
			"tools.artifactHeadBytes": 20,
		});
		expect(text).not.toContain(HEAD);
		expect(text).toContain(TAIL);
	});

	test("results without a retention policy follow the shared head budget regardless of tool name", async () => {
		const tailOnly = await excerpt(tool("search", small), {
			"tools.maxInlineResultBytes": 1,
			"tools.artifactHeadBytes": 0,
			"tools.bashOutputHeadBytes": 1,
		});
		expect(tailOnly.text).not.toContain(HEAD);
		expect(tailOnly.text).toContain(TAIL);
		const middle = await excerpt(tool("search", small), {
			"tools.maxInlineResultBytes": 1,
			"tools.artifactHeadBytes": 1,
			"tools.bashOutputHeadBytes": 0,
		});
		expect(middle.text).toContain(HEAD);
		expect(middle.text).toContain(TAIL);
	});

	const large = bodyOf(500); // ~16 KiB: above an 8 KiB cap, below the threshold spill

	test("the shared cap never widens a bash tail past tools.bashOutputTailBytes", async () => {
		// Default bash policy (1 KB tail, no head) under an 8 KB cap: the cap must
		// not hand the excerpt 8 KB of tail.
		const { text, bodyBytes } = await excerpt(tool("bash", large, "bash"), { "tools.maxInlineResultBytes": 8 });
		expect(text).not.toContain(HEAD);
		expect(text).toContain(TAIL);
		expect(bodyBytes).toBeLessThanOrEqual(1024);
	});

	test("middle elision caps head and tail by their own bash budgets inside the shared cap", async () => {
		const cap = 8 * 1024;
		const markerReserve = 256;
		const headCap = Math.min(4 * 1024, Math.floor((cap - markerReserve) / 2));
		const { text, bodyBytes } = await excerpt(tool("bash", large, "bash"), {
			"tools.maxInlineResultBytes": 8,
			"tools.bashOutputHeadBytes": 4,
			"tools.bashOutputTailBytes": 1,
		});
		expect(text).toContain(HEAD);
		expect(text).toContain(TAIL);
		// head <= 4 KB (further clamped to half the budget), tail <= 1 KB, plus the marker line.
		expect(bodyBytes).toBeLessThanOrEqual(headCap + 1024 + markerReserve);
		expect(bodyBytes).toBeLessThanOrEqual(cap);
	});

	test("shared-policy results keep filling the cap with the shared defaults", async () => {
		const cap = 8 * 1024;
		const { text, bodyBytes } = await excerpt(tool("search", large), { "tools.maxInlineResultBytes": 8 });
		expect(text).toContain(HEAD);
		expect(text).toContain(TAIL);
		expect(bodyBytes).toBeGreaterThan(cap / 2);
		expect(bodyBytes).toBeLessThanOrEqual(cap);
	});
});
