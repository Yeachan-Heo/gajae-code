import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Settings } from "../../src/config/settings";
import { TaskTool } from "../../src/task";
import { loadBundledAgents } from "../../src/task/agents";
import * as discoveryModule from "../../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

function createSession(
	cwd = "/tmp",
	settingsOverrides: Record<string, unknown> = {},
	spawns: string | null = "*",
): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			...settingsOverrides,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("task agent visibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ships exactly the four canonical role agents, all visible", () => {
		const agents = loadBundledAgents();
		const names = agents.map(agent => agent.name).sort();
		expect(names).toEqual(["architect", "critic", "executor", "planner"]);
		for (const agent of agents) {
			expect(agent.hide).toBeUndefined();
		}
	});

	it("keeps configured agent names out of the task description and hidden agents out of hints", async () => {
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
		const description = tool.description;
		expect(description).toContain(
			"Other configured agents (project, user, plugin) may also be available; calling with an unknown `agent` lists the agents callable in this session.",
		);
		expect(description).toContain("Bundled role names: executor, architect, planner, critic.");
		expect(description).toContain("A configured agent may override a bundled role name and takes precedence.");
		for (const agent of loadBundledAgents()) {
			expect(description).not.toContain(agent.description);
		}
		expect(description).not.toContain("public_agent");
		expect(description).not.toContain("support_agent");

		const unknownResult = await tool.execute("tool-call", {
			agent: "missing_agent",
			tasks: [{ id: "One", description: "one", assignment: "Do it." }],
		} as TaskParams);
		const unknownText = getFirstText(unknownResult);
		expect(unknownText).toContain("Available: public_agent");
		expect(unknownText).not.toContain("support_agent");
	});
	it("lists a project agent and all bundled roles when the requested agent is unknown", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-agent-visibility-"));
		try {
			const agentsDir = path.join(cwd, ".gjc", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await fs.writeFile(
				path.join(agentsDir, "reviewer-lite.md"),
				"---\nname: reviewer-lite\ndescription: Lightweight project reviewer\n---\nYou review code.\n",
			);
			const tool = await TaskTool.create(createSession(cwd));
			const description = tool.description;
			expect(description).toContain(
				"Other configured agents (project, user, plugin) may also be available; calling with an unknown `agent` lists the agents callable in this session.",
			);
			expect(description).not.toContain("reviewer-lite");

			const result = await tool.execute("tool-unknown-agent", {
				agent: "missing_agent",
				tasks: [{ id: "One", description: "one", assignment: "Do it." }],
			} as TaskParams);
			const unknownText = getFirstText(result);
			expect(unknownText).toContain('Unknown agent "missing_agent"');
			expect(unknownText).toContain("Available:");
			for (const name of ["reviewer-lite", "architect", "critic", "executor", "planner"]) {
				expect(unknownText).toContain(name);
			}
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("excludes disabled and non-allowlisted agents from unknown-agent hints", async () => {
		const projectAgent: AgentDefinition = {
			name: "project_agent",
			description: "Project agent",
			systemPrompt: "project",
			source: "project",
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [...loadBundledAgents(), projectAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(
			createSession("/tmp", { "task.disabledAgents": ["critic"] }, "executor,project_agent"),
		);
		const result = await tool.execute("tool-callable-agents", {
			agent: "missing_agent",
			tasks: [{ id: "One", description: "one", assignment: "Do it." }],
		} as TaskParams);
		const unknownText = getFirstText(result);

		const syncResult = await tool.execute("tool-callable-agents-sync", {
			agent: "missing_agent",
			tasks: [],
		} as TaskParams);
		expect(getFirstText(syncResult)).toContain("Available: executor, project_agent");
		expect(unknownText).toContain("Available: executor, project_agent");
		for (const name of ["critic", "architect", "planner"]) {
			expect(unknownText).not.toContain(name);
		}
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
});
