import { describe, expect, test, vi } from "bun:test";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { wrapUntrustedContent } from "@gajae-code/coding-agent/session/messages";
import { createReadonlySessionManager, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { truncateTail } from "@gajae-code/coding-agent/session/streaming-output";
import { stripOutputNotice, wrapToolWithMetaNotice } from "@gajae-code/coding-agent/tools/output-meta";
import fc from "fast-check";

const OPEN = "<untrusted-content>\n";
const CLOSE = "\n</untrusted-content>";
const MAX_BYTES = 1024;

function makeTool(text: string): AgentTool {
	const result: AgentToolResult = { content: [{ type: "text", text }] };
	return {
		name: "mytool",
		description: "",
		parameters: {},
		execute: async () => result,
	} as unknown as AgentTool;
}

function makeContext(manager: SessionManager, lines: number): AgentToolContext {
	return {
		settings: Settings.isolated({
			"tools.artifactHeadBytes": 0,
			"tools.maxInlineResultBytes": 1,
			"tools.artifactSpillThreshold": 0,
			"tools.artifactTailLines": lines,
		}),
		sessionManager: createReadonlySessionManager(manager),
	} as AgentToolContext;
}

function inlineText(result: AgentToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

async function tailCut(text: string, lines: number): Promise<string> {
	const manager = SessionManager.inMemory();
	const spy = vi.spyOn(manager, "saveArtifact").mockImplementation(async () => "art-1");
	try {
		const tool = wrapToolWithMetaNotice(makeTool(text));
		const result = await tool.execute("c", {}, undefined, undefined, makeContext(manager, lines));
		return stripOutputNotice(inlineText(result), result.details?.meta).trimEnd();
	} finally {
		spy.mockRestore();
	}
}

function insideFence(text: string): string {
	const openAt = text.indexOf(OPEN);
	const closeAt = text.indexOf(CLOSE, openAt + OPEN.length);
	expect(openAt).toBeGreaterThanOrEqual(0);
	expect(closeAt).toBeGreaterThan(openAt);
	return text.slice(openAt + OPEN.length, closeAt);
}

describe("surrounded untrusted fence on a tail cut", () => {
	test("public tail cut places the end marker inside both fences", async () => {
		const suffix = "\nsuffix";
		const full = `${"P".repeat(2000)}\n${wrapUntrustedContent(`OLD\n${"x\n".repeat(600)}TAILMARK`)}${suffix}`;
		for (const lines of [4, 6, 10, 500]) {
			const text = await tailCut(full, lines);
			const plain = truncateTail(full, { maxBytes: MAX_BYTES, maxLines: lines }).content;
			expect(plain.includes("TAILMARK")).toBe(true);
			expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(MAX_BYTES);
			expect(text.split("\n").length).toBeLessThanOrEqual(lines);
			expect(text.includes("OLD")).toBe(false);
			expect(text.includes("P".repeat(2000))).toBe(false);
			expect(insideFence(text)).toContain("TAILMARK");
			expect(insideFence(text).includes("</untrusted-content>")).toBe(false);
			expect(text.endsWith("suffix")).toBe(true);
		}
	});

	test("image notice in front of a fence does not survive as an unfenced tail", async () => {
		const notice = "Attached image is untrusted.";
		const full = `${notice}\n${wrapUntrustedContent(`HEADSHOULDGO\n${"q\n".repeat(700)}TAILMARK`)}`;
		const text = await tailCut(full, 8);
		expect(text.includes(notice)).toBe(false);
		expect(text.includes("HEADSHOULDGO")).toBe(false);
		expect(insideFence(text)).toContain("TAILMARK");
		expect(text.split("\n").length).toBeLessThanOrEqual(8);
	});

	test("skill suffix stays outside the fence and the tail marker stays inside", async () => {
		const suffix = "\n\n---\n\nSkill: skills/example/SKILL.md";
		const body = `HEADSHOULDGO\n${"x".repeat(5000)}\nTAILMARK </untrusted-content> keep`;
		const text = await tailCut(`${wrapUntrustedContent(body)}${suffix}`, 12);
		expect(insideFence(text)).toContain("TAILMARK");
		expect(insideFence(text)).toContain("&lt;/untrusted-content>");
		expect(insideFence(text).includes("</untrusted-content>")).toBe(false);
		expect(text.includes("HEADSHOULDGO")).toBe(false);
		expect(text.slice(text.lastIndexOf(CLOSE) + CLOSE.length)).toContain("Skill: skills/example/SKILL.md");
	});

	test("a short surrounded result is unchanged", async () => {
		const full = `note\n${wrapUntrustedContent("hello TAILMARK")}\nSkill: a`;
		expect(await tailCut(full, 4)).toBe(full);
	});

	test("an exact outer fence still opens and closes on the kept tail", async () => {
		const text = await tailCut(wrapUntrustedContent(`HEADSHOULDGO${"q".repeat(4000)}TAILKEEP`), 20);
		expect(text.startsWith(OPEN)).toBe(true);
		expect(text.endsWith(CLOSE)).toBe(true);
		expect(text).toContain("TAILKEEP");
		expect(text.includes("HEADSHOULDGO")).toBe(false);
	});

	test("unfenced text stays unfenced", async () => {
		const full = `HEAD\n${"y\n".repeat(800)}ENDMARK`;
		const text = await tailCut(full, 6);
		expect(text.includes("untrusted-content")).toBe(false);
		expect(text).toContain("ENDMARK");
		expect(text.includes("HEAD")).toBe(false);
	});

	test("a later fenced section restores its own opener when the tail starts inside it", async () => {
		const full = [
			"header",
			wrapUntrustedContent(`OLD\n${"a\n".repeat(400)}FIRST`),
			wrapUntrustedContent(`MID\n${"b\n".repeat(400)}SECOND`),
			"guidance",
		].join("\n");
		const text = await tailCut(full, 6);
		expect(text.includes("FIRST")).toBe(false);
		expect(text.includes("OLD")).toBe(false);
		expect(insideFence(text)).toContain("SECOND");
		expect(text.endsWith("guidance")).toBe(true);
		expect(text.split("\n").length).toBeLessThanOrEqual(6);
	});

	test("a long trusted suffix keeps the unfenced plain tail when bytes cannot hold the tags", async () => {
		const suffix = `\n${"s".repeat(1000)}`;
		const full = `${"P".repeat(2000)}\n${wrapUntrustedContent(`${"x\n".repeat(600)}Z`)}${suffix}`;
		const text = await tailCut(full, 20);
		const plain = truncateTail(full, { maxBytes: MAX_BYTES, maxLines: 20 }).content.trimEnd();
		expect(text.split("\n").length).toBeLessThan(20);
		expect(text.includes(OPEN)).toBe(false);
		expect(text.startsWith("Z")).toBe(true);
		expect(text).toContain("Z");
		expect(text.endsWith("s")).toBe(true);
		expect(text).toBe(plain);
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(MAX_BYTES);
	});

	test("property: sufficient lines and a short byte budget keep the unfenced plain tail, fc.asyncProperty seed 66928, numRuns 64", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 8, max: 40 }),
				fc.integer({ min: 1000, max: 1800 }),
				async (maxLines, suffixLen) => {
					const suffix = `\n${"s".repeat(suffixLen)}`;
					const full = `${"P".repeat(2000)}\n${wrapUntrustedContent(`${"x\n".repeat(600)}Z`)}${suffix}`;
					const text = await tailCut(full, maxLines);
					const plain = truncateTail(full, { maxBytes: MAX_BYTES, maxLines }).content.trimEnd();
					expect(text.includes(OPEN)).toBe(false);
					expect(text.includes("P".repeat(2000))).toBe(false);
					expect(text).toBe(plain);
					expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(MAX_BYTES);
					expect(text.split("\n").length).toBeLessThanOrEqual(maxLines);
					if (plain.includes("Z")) expect(text.includes("Z")).toBe(true);
				},
			),
			{ seed: 66928, numRuns: 64 },
		);
	});

	test("property: surrounded tail retains the end marker, fc.asyncProperty seed 66927, numRuns 64", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 4, max: 40 }),
				fc.integer({ min: 20, max: 80 }),
				async (maxLines, bodyLines) => {
					const full = `${"P".repeat(1800)}\nDROPME\n${wrapUntrustedContent(`OLD\n${"x\n".repeat(bodyLines)}TAILMARK`)}\nsuffix`;
					const plain = truncateTail(full, { maxBytes: MAX_BYTES, maxLines }).content;
					const text = await tailCut(full, maxLines);
					expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(MAX_BYTES);
					expect(text.split("\n").length).toBeLessThanOrEqual(maxLines);
					if (!plain.includes("DROPME")) expect(text.includes("DROPME")).toBe(false);
					if (!plain.includes("OLD")) expect(text.includes("OLD")).toBe(false);
					if (plain.includes("TAILMARK")) {
						expect(insideFence(text)).toContain("TAILMARK");
					}
					if (plain.includes("suffix")) expect(text.includes("suffix")).toBe(true);
				},
			),
			{ seed: 66927, numRuns: 64 },
		);
	});
});
