import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { TaskTool } from "../../src/task";
import { loadBundledAgents } from "../../src/task/agents";
import * as discoveryModule from "../../src/task/discovery";
import { discoverAgents } from "../../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const temporaryRoots: string[] = [];

async function writeAgent(root: string, name: string): Promise<void> {
	const dir = path.join(root, "agents");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`);
}

function createSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function createProfileSession(agentDir: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(
			{
				"async.enabled": false,
				"task.isolation.mode": "none",
			},
			{ agentDir },
		),
		getSessionAgentDir: () => agentDir,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("task agent visibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	it("ships exactly the four canonical role agents, all visible", () => {
		const agents = loadBundledAgents();
		const names = agents.map(agent => agent.name).sort();
		expect(names).toEqual(["architect", "critic", "executor", "planner"]);
		for (const agent of agents) {
			expect(agent.hide).toBeUndefined();
		}
	});

	it("omits hidden agents from task tool descriptions and unknown-agent hints", async () => {
		const visible: AgentDefinition = {
			name: "public_agent",
			description: "Public agent",
			systemPrompt: "public",
			source: "bundled",
		};
		const hidden: AgentDefinition = {
			name: "support_agent",
			description: "Support agent",
			systemPrompt: "support",
			source: "bundled",
			hide: true,
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [visible, hidden],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession());
		expect(tool.description).toContain("public_agent");
		expect(tool.description).not.toContain("support_agent");

		const unknownResult = await tool.execute("tool-call", {
			agent: "missing_agent",
			tasks: [{ id: "One", description: "one", assignment: "Do it." }],
		} as TaskParams);
		const unknownText = getFirstText(unknownResult);
		expect(unknownText).toContain("Available: public_agent");
		expect(unknownText).not.toContain("support_agent");
	});

	it("keeps hidden agents resolvable for direct task invocations", async () => {
		const hidden: AgentDefinition = {
			name: "support_agent",
			description: "Support agent",
			systemPrompt: "support",
			source: "bundled",
			hide: true,
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [hidden],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", { agent: "support_agent", tasks: [] } as TaskParams);
		expect(getFirstText(result)).toContain("No tasks provided");
	});

	it("passes the resolved session profile to task discovery at create and execution time", async () => {
		const agentDir = "/tmp/gjc-task-profile";
		const discover = vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: loadBundledAgents(),
			projectAgentsDir: null,
		});
		const session = createProfileSession(agentDir);
		const tool = await TaskTool.create(session);
		expect(discover).toHaveBeenLastCalledWith(session.cwd, undefined, session.settings, agentDir);

		discover.mockClear();
		await tool.execute("profile-refresh", { agent: "executor", tasks: [] } as TaskParams);
		expect(discover).toHaveBeenLastCalledWith(session.cwd, undefined, session.settings, agentDir);
	});

	it("isolates settings-owned and explicit task agent profiles without cross-session bleed", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-task-profile-"));
		temporaryRoots.push(root);
		const profileA = path.join(root, "profile-a");
		const profileB = path.join(root, "profile-b");
		const decoy = path.join(root, "process-profile");
		await Promise.all([
			writeAgent(profileA, "profile-a-agent"),
			writeAgent(profileB, "profile-b-agent"),
			writeAgent(decoy, "process-decoy-agent"),
		]);
		const settingsA = Settings.isolated({}, { agentDir: profileA });
		const settingsB = Settings.isolated({}, { agentDir: profileB });
		const [fromSettings, explicitWins, isolatedA, isolatedB] = await Promise.all([
			discoverAgents(root, root, settingsA, settingsA.getAgentDir()),
			discoverAgents(root, root, settingsA, profileB),
			discoverAgents(root, root, settingsA, profileA),
			discoverAgents(root, root, settingsB, profileB),
		]);

		expect(fromSettings.agents.map(agent => agent.name)).toContain("profile-a-agent");
		expect(fromSettings.agents.map(agent => agent.name)).not.toContain("process-decoy-agent");
		expect(explicitWins.agents.map(agent => agent.name)).toContain("profile-b-agent");
		expect(explicitWins.agents.map(agent => agent.name)).not.toContain("profile-a-agent");
		expect(isolatedA.agents.map(agent => agent.name)).not.toContain("profile-b-agent");
		expect(isolatedB.agents.map(agent => agent.name)).not.toContain("profile-a-agent");
	});
});
