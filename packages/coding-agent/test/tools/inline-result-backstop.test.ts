import { describe, expect, test, vi } from "bun:test";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createReadonlySessionManager, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { wrapToolWithMetaNotice } from "@gajae-code/coding-agent/tools/output-meta";

const HEAD_MARKER = "HEAD_MARKER_START";
const TAIL_MARKER = "TAIL_MARKER_END";

/** Build a multi-line payload of ~`kb` KB with distinctive head/tail markers. */
function bigText(kb: number): string {
	const target = kb * 1024;
	const lines: string[] = [HEAD_MARKER];
	let bytes = HEAD_MARKER.length + 1;
	let i = 0;
	while (bytes < target) {
		const line = `line ${i} ${"x".repeat(64)}`;
		lines.push(line);
		bytes += line.length + 1;
		i++;
	}
	lines.push(TAIL_MARKER);
	return lines.join("\n");
}

function makeTool(name: string, result: AgentToolResult): AgentTool {
	return {
		name,
		description: "",
		parameters: {},
		execute: async () => result,
	} as unknown as AgentTool;
}

function makeContext(settings: Settings, saved: Array<{ content: string; toolType: string }>): AgentToolContext {
	const manager = SessionManager.inMemory();
	vi.spyOn(manager, "saveArtifact").mockImplementation(async (content: string, toolType: string) => {
		saved.push({ content, toolType });
		return `art-${saved.length}`;
	});
	return {
		settings,
		sessionManager: createReadonlySessionManager(manager),
	} as AgentToolContext;
}

function inlineText(result: AgentToolResult): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map(b => b.text)
		.join("\n");
}

describe("inline-result backstop (Finding 12)", () => {
	test("default settings cap a 40KB read below the 50KB spill threshold at 12KB with artifact recovery (#5945)", async () => {
		const full = bigText(40);
		const saved: Array<{ content: string; toolType: string }> = [];
		const tool = wrapToolWithMetaNotice(makeTool("read", { content: [{ type: "text", text: full }] }));
		const ctx = makeContext(Settings.isolated(), saved);

		const result = await tool.execute("c1", {}, undefined, undefined, ctx);
		const text = inlineText(result);

		expect(result.details?.meta?.truncation?.maxBytes).toBe(12 * 1024);
		expect(text).toContain(HEAD_MARKER);
		expect(text).toContain(TAIL_MARKER);
		expect(text).toContain("artifact://art-1");
		expect(saved).toEqual([{ content: full, toolType: "read" }]);
	});

	test("default settings leave results at or below 12KB untouched", async () => {
		const small = bigText(11);
		const saved: Array<{ content: string; toolType: string }> = [];
		const tool = wrapToolWithMetaNotice(makeTool("read", { content: [{ type: "text", text: small }] }));

		const result = await tool.execute("c1b", {}, undefined, undefined, makeContext(Settings.isolated(), saved));

		expect(inlineText(result)).toBe(small);
		expect(saved).toHaveLength(0);
	});

	test("leaves output uncapped when no artifact can be stored (standalone gjc read)", async () => {
		const full = bigText(40);
		const tool = wrapToolWithMetaNotice(makeTool("read", { content: [{ type: "text", text: full }] }));

		const result = await tool.execute("c1d", {}, undefined, undefined, {
			settings: Settings.isolated(),
		} as AgentToolContext);

		expect(inlineText(result)).toBe(full);
		expect(result.details?.meta?.truncation).toBeUndefined();
	});

	test("a 0 cap disables the backstop", async () => {
		const full = bigText(40);
		const saved: Array<{ content: string; toolType: string }> = [];
		const tool = wrapToolWithMetaNotice(makeTool("read", { content: [{ type: "text", text: full }] }));
		const ctx = makeContext(Settings.isolated({ "tools.maxInlineResultBytes": 0 }), saved);

		const result = await tool.execute("c1c", {}, undefined, undefined, ctx);

		expect(inlineText(result)).toBe(full);
		expect(saved).toHaveLength(0);
		expect(result.details?.meta?.truncation).toBeUndefined();
	});

	test("opt-in cap: 40KB (below 50KB spill threshold) spills via backstop retaining head+tail", async () => {
		const full = bigText(40);
		const saved: Array<{ content: string; toolType: string }> = [];
		const tool = wrapToolWithMetaNotice(makeTool("mytool", { content: [{ type: "text", text: full }] }));
		const ctx = makeContext(Settings.isolated({ "tools.maxInlineResultBytes": 10 }), saved);

		const result = await tool.execute("c2", {}, undefined, undefined, ctx);
		const text = inlineText(result);

		// No final tool-result text exceeds the configured inline cap.
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(10 * 1024);
		// Head+tail retained (middle elision).
		expect(text).toContain(HEAD_MARKER);
		expect(text).toContain(TAIL_MARKER);
		// Full output saved exactly once, referenced by the truncation meta.
		expect(saved).toHaveLength(1);
		expect(saved[0]?.content).toBe(full);
		expect(result.details?.meta?.truncation?.artifactId).toBe("art-1");
	});

	test("already-spilled results are not double-artifacted (existing artifactId reused)", async () => {
		const full = bigText(40);
		const saved: Array<{ content: string; toolType: string }> = [];
		const tool = wrapToolWithMetaNotice(
			makeTool("mytool", {
				content: [{ type: "text", text: full }],
				details: {
					meta: {
						truncation: {
							direction: "tail",
							truncatedBy: "bytes",
							totalLines: 1,
							totalBytes: full.length,
							outputLines: 1,
							outputBytes: full.length,
							artifactId: "preexisting",
						},
					},
				},
			}),
		);
		const ctx = makeContext(Settings.isolated({ "tools.maxInlineResultBytes": 10 }), saved);

		const result = await tool.execute("c3", {}, undefined, undefined, ctx);
		const text = inlineText(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(10 * 1024);
		// No new artifact created; the pre-existing one is reused.
		expect(saved).toHaveLength(0);
		expect(result.details?.meta?.truncation?.artifactId).toBe("preexisting");
	});

	test("read-tool spill exemption is still covered by the backstop", async () => {
		const full = bigText(40);
		const saved: Array<{ content: string; toolType: string }> = [];
		// The threshold spill early-returns for `read`; the backstop must still cap it.
		const tool = wrapToolWithMetaNotice(makeTool("read", { content: [{ type: "text", text: full }] }));
		const ctx = makeContext(Settings.isolated({ "tools.maxInlineResultBytes": 10 }), saved);

		const result = await tool.execute("c4", {}, undefined, undefined, ctx);
		const text = inlineText(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(10 * 1024);
		expect(saved).toHaveLength(1);
		expect(result.details?.meta?.truncation?.artifactId).toBe("art-1");
	});

	test("output at or below the cap is left untouched", async () => {
		const small = bigText(5);
		const saved: Array<{ content: string; toolType: string }> = [];
		const tool = wrapToolWithMetaNotice(makeTool("mytool", { content: [{ type: "text", text: small }] }));
		const ctx = makeContext(Settings.isolated({ "tools.maxInlineResultBytes": 10 }), saved);

		const result = await tool.execute("c5", {}, undefined, undefined, ctx);

		expect(inlineText(result)).toBe(small);
		expect(saved).toHaveLength(0);
	});

	test("read-range window metadata (rangeBase: window) with nextOffset survives backstop truncation (#5966 blocker item 2)", async () => {
		// Simulate a read tool that returns a 20KB window of a 3000-line file, with nextOffset indicator.
		const windowText = bigText(20);
		const textWithOffset = `${windowText}\n\n[2700 more lines in file. Use :304 to continue]`;
		const saved: Array<{ content: string; toolType: string }> = [];

		const tool = wrapToolWithMetaNotice(
			makeTool("read", {
				content: [{ type: "text", text: textWithOffset }],
				details: {
					meta: {
						// Simulate read tool's window metadata:
						// totalLines = file lines (3000), totalBytes = window bytes
						// rangeBase: "window" indicates this is tool-owned window metadata, not from spill
						truncation: {
							direction: "tail",
							truncatedBy: "lines",
							totalLines: 3000, // full file
							totalBytes: 3000 * 128, // full file ~384KB
							outputLines: 303, // shown window
							outputBytes: Buffer.byteLength(textWithOffset, "utf-8"),
							shownRange: { start: 1, end: 303 },
							rangeBase: "window", // KEY: tool-owned window, not from spill
						},
					},
				},
			}),
		);
		const ctx = makeContext(Settings.isolated(), saved); // default 12KB backstop

		const result = await tool.execute("c6", {}, undefined, undefined, ctx);
		const text = inlineText(result);

		// The backstop should cap at 12KB
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(12 * 1024);
		// The artifact holds the FULL 20KB window (the original input to backstop),
		// not the 3000-line file (which never existed)
		expect(saved).toHaveLength(1);
		expect(Buffer.byteLength(saved[0]!.content, "utf-8")).toBeGreaterThan(12 * 1024);
		expect(saved[0]!.content).toContain("Use :304 to continue"); // the nextOffset is preserved in the saved artifact
		// The truncation metadata should now reflect the WINDOW dimensions (after backstop truncation),
		// NOT the 3000-line file dimensions, because rangeBase: "window" indicates tool-owned metadata.
		// This prevents mixing file lines with window bytes.
		const truncMeta = result.details?.meta?.truncation;
		expect(truncMeta?.rangeBase).toBeUndefined(); // backstop doesn't inherit rangeBase from tool-owned window
		expect(truncMeta?.totalLines).toBeLessThanOrEqual(303); // window lines after backstop truncation
		expect(truncMeta?.totalBytes).toBeGreaterThan(12 * 1024); // artifact size
		expect(truncMeta?.artifactId).toBe("art-1");
	});

	test("over-50KB non-read tool spill preserves totals through backstop (regression: #5945 part 1/2)", async () => {
		// Simulate spillLargeResultToArtifact followed by backstop:
		// A 100KB non-read tool result spills at 50KB threshold, then backstop applies 12KB cap.
		const full = bigText(100);
		const spilled40KBHeadTail = bigText(20) + "\n...(elided)...\n" + bigText(20);
		const saved: Array<{ content: string; toolType: string }> = [];

		const tool = wrapToolWithMetaNotice(
			makeTool("mytool", {
				content: [{ type: "text", text: spilled40KBHeadTail }],
				details: {
					meta: {
						// Simulate spillLargeResultToArtifact output:
						// This has totalLines/totalBytes from the FULL output (100KB),
						// not from the head+tail view (40KB)
						truncation: {
							direction: "middle",
							truncatedBy: "middle",
							totalLines: 3200, // full output
							totalBytes: full.length, // full output ~100KB
							outputLines: 1600, // head+tail shown
							outputBytes: Buffer.byteLength(spilled40KBHeadTail, "utf-8"),
							artifactId: "art-full-output", // points to the 100KB full output
							headRange: { start: 1, end: 800 },
							tailRange: { start: 2400, end: 3200 },
							// NO rangeBase: "window" - this is from spill, not tool-owned window
						},
					},
				},
			}),
		);
		const ctx = makeContext(Settings.isolated(), saved); // default 12KB backstop

		const result = await tool.execute("c7", {}, undefined, undefined, ctx);
		const text = inlineText(result);

		// The backstop should cap at 12KB
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(12 * 1024);
		// The artifact should be the FULL 100KB output, not re-saved
		expect(saved).toHaveLength(0); // no new artifact (existing one is reused)
		// The truncation metadata should PRESERVE the original spill totals (3200 lines, 100KB),
		// even though the current inline view is much smaller (12KB)
		const truncMeta = result.details?.meta?.truncation;
		expect(truncMeta?.totalLines).toBe(3200); // preserved from spill
		expect(truncMeta?.totalBytes).toBe(full.length); // preserved from spill
		expect(truncMeta?.artifactId).toBe("art-full-output"); // the original artifact
	});
});
