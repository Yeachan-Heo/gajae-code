import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function skill(name: string): Skill {
	return {
		name,
		description: `${name} skill`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
	};
}

describe("AgentSession skill reload", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("rolls back the catalog and publication when prompt refresh fails", async () => {
		const cwd = "/tmp/gjc-skill-reload-transaction";
		const settings = Settings.isolated({ "compaction.enabled": false });
		const oldSkill = skill("old-skill");
		const newSkill = skill("new-skill");
		let failPromptRefresh = false;
		let publicationCount = 0;
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			skills: [oldSkill],
			skillWarnings: [{ skillPath: oldSkill.filePath, message: "old warning" }],
			reloadSkills: async () => ({
				skills: [newSkill],
				warnings: [{ skillPath: newSkill.filePath, message: "new warning" }],
			}),
			onSkillsReloaded: () => {
				publicationCount++;
			},
			rebuildSystemPrompt: async () => {
				if (failPromptRefresh) throw new Error("prompt refresh failed");
				return { systemPrompt: ["stable"] };
			},
		});
		sessions.push(session);

		failPromptRefresh = true;
		await expect(session.reloadSkills()).rejects.toThrow("prompt refresh failed");
		expect(session.skills.map(item => item.name)).toEqual(["old-skill"]);
		expect(session.skillWarnings.map(item => item.message)).toEqual(["old warning"]);
		expect(publicationCount).toBe(0);

		failPromptRefresh = false;
		await session.reloadSkills();
		expect(session.skills.map(item => item.name)).toEqual(["new-skill"]);
		expect(session.skillWarnings.map(item => item.message)).toEqual(["new warning"]);
		expect(publicationCount).toBe(1);
	});
});
