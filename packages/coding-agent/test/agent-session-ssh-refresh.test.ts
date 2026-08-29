import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { getSSHConfigPath, TempDir } from "@gajae-code/utils";
import { reset as resetCapabilities } from "../src/capability";
import { type SSHHost, sshCapability } from "../src/capability/ssh";
import { Settings } from "../src/config/settings";
import { loadCapability } from "../src/discovery";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { addSSHHost, removeSSHHost, updateSSHHost } from "../src/ssh/config-writer";
import * as connectionManager from "../src/ssh/connection-manager";
import type { ToolSession } from "../src/tools";
import { loadSshTool } from "../src/tools/implementations";

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

describe("AgentSession SSH tool refresh", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		vi.restoreAllMocks();
		for (const tempDir of tempDirs.splice(0)) {
			tempDir.removeSync();
		}
		resetCapabilities();
	});

	function createSession(
		cwd: string,
		initialTools: AgentTool[] = [],
		registryTools = initialTools,
		options?: {
			reloadSshTool?: () => Promise<AgentTool | null>;
			requestedToolNames?: ReadonlySet<string>;
			agentDir?: string;
		},
	): AgentSession {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory(cwd);
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		};
		const toolRegistry = new Map(registryTools.map(tool => [tool.name, tool]));
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: initialTools,
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			agentDir: options?.agentDir,
			modelRegistry: { getAuthStorageOwner: () => ({}) } as never,
			toolRegistry,
			reloadSshTool:
				options?.reloadSshTool ?? (async () => (await loadSshTool(toolSession)) as unknown as AgentTool | null),
			requestedToolNames: options?.requestedToolNames,
			rebuildSystemPrompt: async (toolNames, tools) => ({
				systemPrompt: toolNames.map(name => `${name}:${tools.get(name)?.description ?? ""}`),
			}),
		});
		sessions.push(session);
		return session;
	}

	it("scopes refresh discovery to the session agent directory", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-profile-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const agentDir = path.join(cwd, "selected-profile");
		await addSSHHost(getSSHConfigPath("user", cwd, agentDir), "profile-host", { host: "192.0.2.30" });

		const sshTool: AgentTool = {
			name: "ssh",
			label: "SSH",
			description: "profile host",
			parameters: { type: "object", properties: {} },
			strict: true,
			execute: async () => ({ content: [] }),
		};
		const invalidateSpy = spyOn(connectionManager, "invalidateHostMetadata").mockResolvedValue(undefined);
		const session = createSession(cwd, [sshTool], [sshTool], {
			agentDir,
			reloadSshTool: async () => sshTool,
		});

		await session.refreshSshTool();

		expect(invalidateSpy).toHaveBeenCalledWith(new Set(["profile-host"]));
	});

	it("adds the ssh tool after a first host is written over a cached missing config", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		const preWrite = await loadCapability<SSHHost>(sshCapability.id, { cwd });
		expect(preWrite.items).toHaveLength(0);

		const session = createSession(cwd);
		await addSSHHost(getSSHConfigPath("project", cwd), "staging", { host: "192.0.2.10" });
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("staging (192.0.2.10)");
		expect(session.agent.state.systemPrompt.join("\n")).toContain("staging (192.0.2.10)");
	});

	it("removes ssh from registry and active tools when the last host is removed", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "prod", { host: "203.0.113.9" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		const session = createSession(cwd, [sshTool as unknown as AgentTool]);
		await removeSSHHost(configPath, "prod");
		await session.refreshSshTool();

		expect(session.getAllToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
	});

	it("does not activate an existing inactive ssh tool during reload refresh", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "dev", { host: "192.0.2.20" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		await addSSHHost(configPath, "dev2", { host: "192.0.2.21" });
		const session = createSession(cwd, [], [sshTool as unknown as AgentTool]);
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("dev2 (192.0.2.21)");
	});

	it("reloads ssh from the session's current cwd after move", async () => {
		const oldProject = TempDir.createSync("@pi-ssh-refresh-old-");
		const newProject = TempDir.createSync("@pi-ssh-refresh-new-");
		tempDirs.push(oldProject, newProject);
		await SessionManager.inMemory(oldProject.path()).moveTo?.(newProject.path());
		await addSSHHost(getSSHConfigPath("project", newProject.path()), "moved", { host: "198.51.100.8" });
		const movedTool = await loadSshTool({
			cwd: newProject.path(),
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(movedTool).not.toBeNull();

		const refreshedSession = createSession(oldProject.path(), [], [], {
			reloadSshTool: async () => movedTool as unknown as AgentTool,
		});
		await refreshedSession.refreshSshTool({ activateIfAvailable: true });

		expect(refreshedSession.getAllToolNames()).toContain("ssh");
		expect(refreshedSession.getToolByName("ssh")?.description).toContain("moved (198.51.100.8)");
	});

	it("invalidates cached host metadata before rebuilding descriptions when a host config changes", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "prod", { host: "203.0.113.9" });
		const initialTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(initialTool).not.toBeNull();
		const session = createSession(cwd, [initialTool as unknown as AgentTool]);

		const invalidateSpy = spyOn(connectionManager, "invalidateHostMetadata").mockResolvedValue(undefined);
		await updateSSHHost(configPath, "prod", { host: "203.0.113.10" });
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(invalidateSpy).toHaveBeenNthCalledWith(1, new Set(["prod"]));
		expect(session.getToolByName("ssh")?.description).toContain("prod (203.0.113.10)");
	});

	it("invalidates newly added host names before rebuilding the ssh tool", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);

		await addSSHHost(configPath, "fresh", { host: "203.0.113.11" });
		const session = createSession(cwd);
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getToolByName("ssh")?.description).toContain("fresh (203.0.113.11)");
		expect(session.getToolByName("ssh")?.description).toContain("fresh (203.0.113.11)");
	});

	it("does not activate ssh when it was excluded from the requested tool allowlist", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);
		const blockedTool: AgentTool = {
			name: "ssh",
			label: "SSH",
			description: "blocked",
			parameters: { type: "object", properties: {} },
			strict: true,
			execute: async () => ({ content: [{ type: "text", text: "" }] }),
		};

		await addSSHHost(configPath, "hidden", { host: "203.0.113.12" });
		const session = createSession(cwd, [], [blockedTool], {
			reloadSshTool: async () => blockedTool,
			requestedToolNames: new Set(["read"]),
		});
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
	});
});
