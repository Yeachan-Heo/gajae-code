import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { getDefault, Settings } from "@gajae-code/coding-agent/config/settings";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { wrapToolWithMetaNotice } from "@gajae-code/coding-agent/tools/output-meta";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import { Snowflake } from "@gajae-code/utils";

let artifactCounter = 0;

function createSession(cwd: string): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function createContext(settings: Settings): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		settings,
		toolNames: ["read"],
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as AgentToolContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("\n");
}

describe("read-tool artifact spill (Finding 4)", () => {
	it("keeps the read spill rollout default off", () => {
		expect(getDefault("tools.readArtifactSpillThreshold")).toBe(0);
	});

	let testDir: string;
	let bigFile: string;
	const fullBytes = 80 * 1024;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-spill-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		bigFile = path.join(testDir, "big.txt");
		const line = `${"A".repeat(96)}`;
		const lines: string[] = [];
		let bytes = 0;
		let i = 0;
		while (bytes < fullBytes) {
			const l = `${i} ${line}`;
			lines.push(l);
			bytes += l.length + 1;
			i++;
		}
		fs.writeFileSync(bigFile, lines.join("\n"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("spills a large read to an artifact with a bounded head+tail snippet", async () => {
		const tool = wrapToolWithMetaNotice(new ReadTool(createSession(testDir)));
		const ctx = createContext(
			Settings.isolated({
				"tools.readArtifactSpillThreshold": 5,
				"tools.maxInlineResultBytes": 0,
				"tools.artifactHeadBytes": 2,
				"tools.artifactTailBytes": 2,
			}),
		);

		const result = await tool.execute("r1", { path: bigFile }, undefined, undefined, ctx);
		const text = textOf(result);

		// Bounded inline text (well below the full file) + artifact reference.
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(fullBytes);
		expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
		expect(text).toContain("artifact://");
	});

	it("caps a multi-range read exceeding the combined threshold", async () => {
		const tool = wrapToolWithMetaNotice(new ReadTool(createSession(testDir)));
		const ctx = createContext(
			Settings.isolated({
				"tools.readArtifactSpillThreshold": 5,
				"tools.maxInlineResultBytes": 0,
				"tools.artifactHeadBytes": 2,
				"tools.artifactTailBytes": 2,
			}),
		);

		// Two ranges that together exceed the 5KB combined cap.
		const result = await tool.execute("r2", { path: `${bigFile}:1-300,400-700` }, undefined, undefined, ctx);
		const text = textOf(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(fullBytes);
		expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
		expect(text).toContain("artifact://");
	});

	it("leaves reads within the read threshold inline (no spill)", async () => {
		const tool = wrapToolWithMetaNotice(new ReadTool(createSession(testDir)));
		// Default read threshold is off, leaving the 80KB read fully inline.
		const ctx = createContext(Settings.isolated({ "tools.maxInlineResultBytes": 0 }));

		const result = await tool.execute("r3", { path: bigFile }, undefined, undefined, ctx);

		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});
});
