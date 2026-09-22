import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getEmbeddedDefaultGjcSkills } from "@gajae-code/coding-agent/defaults/gjc-defaults";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import type { ReadToolDetails } from "@gajae-code/coding-agent/tools/read";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("read of bundled skill identifiers", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-embedded-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("reads the embedded: path reported by the skill tool", async () => {
		const ultragoal = getEmbeddedDefaultGjcSkills().find(skill => skill.name === "ultragoal");
		const body = await ultragoal!.loadContent!();
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("read-embedded", { path: "embedded:gjc/skills/ultragoal/SKILL.md" });
		const text = textOutput(result);
		expect(text).toContain(body.split("\n")[0]);
		expect(text).toContain(body.trimEnd().split("\n").at(-1)!);
		expect(result.details?.truncation).toBeUndefined();
	});

	it("applies a line selector to an embedded: path", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-embedded-sel", {
			path: "embedded:gjc/skills/ultragoal/SKILL.md:1-3",
		});
		const body = await getEmbeddedDefaultGjcSkills().find(skill => skill.name === "ultragoal")!.loadContent!();
		const text = textOutput(result);
		expect(text).toContain(body.split("\n")[0]);
		expect(text).not.toContain(body.split("\n")[20] ?? "\u0000unreachable");
	});
});
