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
	test("disabled by default: oversized output passes through untouched, no artifact saved", async () => {
		const full = bigText(40);
		const saved: Array<{ content: string; toolType: string }> = [];
		const tool = wrapToolWithMetaNotice(makeTool("mytool", { content: [{ type: "text", text: full }] }));
		const ctx = makeContext(Settings.isolated(), saved);

		const result = await tool.execute("c1", {}, undefined, undefined, ctx);

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
});
