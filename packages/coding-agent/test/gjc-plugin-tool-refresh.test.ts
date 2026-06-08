import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { syncSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;
let sessionManager: SessionManager;

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: name }] }),
	};
}

async function writeCustomTool(fileName: string, toolName: string): Promise<string> {
	const toolsDir = path.join(tempDir.path(), "tools");
	await fs.mkdir(toolsDir, { recursive: true });
	const toolPath = path.join(toolsDir, fileName);
	await fs.writeFile(
		toolPath,
		`import type { CustomToolFactory } from "@gajae-code/coding-agent/extensibility/custom-tools/types";

const factory: CustomToolFactory = pi => ({
	name: ${JSON.stringify(toolName)},
	label: ${JSON.stringify(toolName)},
	description: "refresh fixture tool",
	parameters: pi.zod.object({}),
	async execute() {
		return { content: [{ type: "text", text: ${JSON.stringify(toolName)} }] };
	},
});

export default factory;
`,
	);
	return toolPath;
}

async function activateSubskill(toolPaths: string[], phase = "planner"): Promise<void> {
	await syncSkillActiveState({
		cwd: tempDir.path(),
		skill: "ralplan",
		active: true,
		phase,
		sessionId: sessionManager.getSessionId(),
		active_subskills: [
			{
				plugin: "refresh-plugin",
				subskillName: "design",
				parent: "ralplan",
				bindsTo: "ralplan",
				phase,
				activationArg: "design",
				filePath: path.join(tempDir.path(), "subskills", "design", "SKILL.md"),
				toolPaths,
			},
		],
	});
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@gjc-plugin-tool-refresh-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const readTool = makeTool("read");
	const bashTool = makeTool("bash");
	sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [readTool, bashTool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		toolRegistry: new Map([
			[readTool.name, readTool],
			[bashTool.name, bashTool],
		]),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

describe("AgentSession GJC plugin sub-skill tool refresh", () => {
	test("adds and removes sub-skill tools as the active phase changes", async () => {
		const toolPath = await writeCustomTool("domain-note.ts", "domain_note");
		await activateSubskill([toolPath], "planner");

		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).toContain("domain_note");
		expect(session.getActiveToolNames()).toContain("domain_note");

		await syncSkillActiveState({
			cwd: tempDir.path(),
			skill: "ralplan",
			active: true,
			phase: "critic",
			sessionId: sessionManager.getSessionId(),
			active_subskills: [],
		});

		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).not.toContain("domain_note");
		expect(session.getActiveToolNames()).not.toContain("domain_note");
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
	});

	test("rejects sub-skill tools whose names conflict with existing tools", async () => {
		const toolPath = await writeCustomTool("read.ts", "read");
		await activateSubskill([toolPath], "planner");

		await session.refreshGjcSubskillTools();

		expect(session.getAllToolNames().filter(name => name === "read")).toHaveLength(1);
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
	});
});
