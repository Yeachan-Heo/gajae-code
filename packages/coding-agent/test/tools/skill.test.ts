import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@gajae-code/coding-agent/session/messages";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SkillTool } from "@gajae-code/coding-agent/tools/skill";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";

async function makeSkill(name: string, content: string): Promise<Skill> {
	const dir = await mkdtemp(path.join(os.tmpdir(), `skill-tool-${name}-`));
	const filePath = path.join(dir, "SKILL.md");
	await writeFile(filePath, content, "utf8");
	return {
		name,
		description: `${name} test skill`,
		filePath,
		baseDir: dir,
		source: "test",
		content,
	};
}

interface CapturedSend {
	message: { customType: string; content: unknown; details?: unknown; attribution?: string };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

function createSession(skills: Skill[], capture: CapturedSend[]): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sendCustomMessage: async (message, options) => {
			capture.push({ message, options });
		},
	};
}

describe("SkillTool", () => {
	it("createIf returns null when no skills are loaded", () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			sendCustomMessage: async () => {},
		};
		expect(SkillTool.createIf(session)).toBeNull();
	});

	it("createIf returns null when session lacks sendCustomMessage", async () => {
		const ultragoal = await makeSkill("ultragoal", "# Ultragoal\nBody");
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			skills: [ultragoal],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		expect(SkillTool.createIf(session)).toBeNull();
	});

	it("queues the chained skill as a next-turn user message", async () => {
		const ultragoal = await makeSkill("ultragoal", "---\nname: ultragoal\n---\n# Ultragoal\nTrack execution.");
		const captured: CapturedSend[] = [];
		const session = createSession([ultragoal], captured);
		const tool = SkillTool.createIf(session);
		expect(tool).not.toBeNull();

		const result = await tool!.execute("call-1", { name: "ultragoal", args: "go" });
		const firstBlock = result.content[0];
		expect(firstBlock?.type).toBe("text");
		expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("ultragoal");
		expect(result.details?.name).toBe("ultragoal");
		expect(result.details?.args).toBe("go");

		expect(captured).toHaveLength(1);
		const sent = captured[0]!;
		expect(sent.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(sent.message.attribution).toBe("user");
		expect(sent.options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });

		const content = sent.message.content as string;
		expect(content).toContain("# Ultragoal");
		expect(content).toContain("Track execution.");
		expect(content).toContain("User: go");
	});

	it("omits the User: line when args are absent or whitespace", async () => {
		const di = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
		const captured: CapturedSend[] = [];
		const session = createSession([di], captured);
		const tool = SkillTool.createIf(session)!;
		await tool.execute("call-1", { name: "deep-interview", args: "   " });
		const content = captured[0]!.message.content as string;
		expect(content).not.toContain("User:");
	});

	it("throws a ToolError naming the available skills when the name is unknown", async () => {
		const a = await makeSkill("ralplan", "ralplan body");
		const b = await makeSkill("team", "team body");
		const captured: CapturedSend[] = [];
		const session = createSession([a, b], captured);
		const tool = SkillTool.createIf(session)!;
		await expect(tool.execute("call-1", { name: "does-not-exist" })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("call-1", { name: "does-not-exist" })).rejects.toThrow(/Available: ralplan, team/);
		expect(captured).toHaveLength(0);
	});

	it("rejects empty name", async () => {
		const a = await makeSkill("ralplan", "body");
		const captured: CapturedSend[] = [];
		const session = createSession([a], captured);
		const tool = SkillTool.createIf(session)!;
		await expect(tool.execute("call-1", { name: "   " })).rejects.toBeInstanceOf(ToolError);
		expect(captured).toHaveLength(0);
	});
});
