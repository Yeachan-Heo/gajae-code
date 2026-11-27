import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SkillTool } from "@gajae-code/coding-agent/tools/skill";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

/**
 * The skill tool's callee prompt must reach the model in the same run, right
 * after the tool result. A streaming session queues an unrouted custom message
 * as a follow-up, which the loop only drains once the agent would otherwise
 * stop: the prompt then lands after the caller's final answer and starts an
 * extra turn that re-runs the callee workflow.
 */
describe("SkillTool delivery through a live AgentSession", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@skill-same-turn-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	it("delivers the callee prompt before the next model call and adds no trailing turn", async () => {
		const skillDir = path.join(tempDir.path(), "ultragoal");
		await fs.mkdir(skillDir, { recursive: true });
		const skillContent = "---\nname: ultragoal\n---\n# Ultragoal\nTrack execution.";
		const filePath = path.join(skillDir, "SKILL.md");
		await fs.writeFile(filePath, skillContent, "utf8");
		const skill: Skill = {
			name: "ultragoal",
			description: "ultragoal test skill",
			filePath,
			baseDir: skillDir,
			source: "test",
			content: skillContent,
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				if (calls === 1)
					return { content: [{ type: "toolCall", name: "skill", arguments: { name: "ultragoal" } }] };
				if (calls === 2) return { content: [{ type: "toolCall", name: "work", arguments: {} }] };
				return { content: [`answer ${calls}`] };
			},
		});

		const toolSession: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			skills: [skill],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			sendCustomMessage: (message, options) => session!.sendCustomMessage(message, options),
		};
		const skillTool = SkillTool.createIf(toolSession);
		if (!skillTool) throw new Error("Expected skill tool");
		const workTool = {
			name: "work",
			label: "Work",
			description: "Keeps the run going after the chain",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		} as AgentTool;

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [skillTool as unknown as AgentTool, workTool],
				messages: [],
			},
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		await session.prompt("go");
		await session.waitForIdle();

		const messages = session.agent.state.messages;
		const skillIndex = messages.findIndex(
			m => m.role === "custom" && (m as { customType?: string }).customType === SKILL_PROMPT_MESSAGE_TYPE,
		);
		const assistantIndexes = messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
		expect(skillIndex).toBeGreaterThan(-1);
		// The prompt sits between the chaining call's result and the second model call.
		expect(skillIndex).toBeGreaterThan(assistantIndexes[0]!);
		expect(skillIndex).toBeLessThan(assistantIndexes[1]!);
		// Exactly three model calls: no extra turn spawned by a late callee prompt.
		expect(calls).toBe(3);
		expect(assistantIndexes).toHaveLength(3);
	});

	it("drops a callee prompt whose preparation outlives a terminal abort of the source run", async () => {
		const skillDir = path.join(tempDir.path(), "ultragoal");
		await fs.mkdir(skillDir, { recursive: true });
		const skillContent = "---\nname: ultragoal\n---\n# Ultragoal\nTrack execution.";
		const filePath = path.join(skillDir, "SKILL.md");
		await fs.writeFile(filePath, skillContent, "utf8");
		const skill: Skill = {
			name: "ultragoal",
			description: "ultragoal test skill",
			filePath,
			baseDir: skillDir,
			source: "test",
			content: skillContent,
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				if (calls === 1)
					return { content: [{ type: "toolCall", name: "skill", arguments: { name: "ultragoal" } }] };
				return { content: [`answer ${calls}`] };
			},
		});

		// The terminal abort lands while the tool callback is mid-preparation: the
		// session id is read once before the activation await and again after it,
		// right before the prompt is built. The callback outlives the abort and
		// resumes toward the send on its own.
		let sessionIdReads = 0;
		let sendAttempts = 0;
		let abortDone: Promise<void> | undefined;
		const toolSession: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			skills: [skill],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getSessionId: () => {
				sessionIdReads += 1;
				if (sessionIdReads === 2) abortDone = session!.abort({ cause: "user_interrupt" });
				return "skill-abort-race";
			},
			sendCustomMessage: (message, options) => {
				sendAttempts += 1;
				return session!.sendCustomMessage(message, options);
			},
		};
		const skillTool = SkillTool.createIf(toolSession);
		if (!skillTool) throw new Error("Expected skill tool");

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [skillTool as unknown as AgentTool], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		await session.prompt("go").catch(() => undefined);
		// The abort really landed mid-preparation, not before or after the tool ran.
		expect(abortDone).toBeDefined();
		await abortDone;
		await session.waitForIdle();
		// Give the orphaned callback a bounded window to finish preparing and reach
		// its send point; a regression exits the wait as soon as it sends.
		const deadline = Date.now() + 1000;
		while (sendAttempts === 0 && Date.now() < deadline) await Bun.sleep(10);
		await session.waitForIdle();

		const skillPrompts = session.agent.state.messages.filter(
			m => m.role === "custom" && (m as { customType?: string }).customType === SKILL_PROMPT_MESSAGE_TYPE,
		);
		expect(sendAttempts).toBe(0);
		expect(skillPrompts).toHaveLength(0);
		// The aborted run made one model call; nothing restarted it.
		expect(calls).toBe(1);
	});
});
