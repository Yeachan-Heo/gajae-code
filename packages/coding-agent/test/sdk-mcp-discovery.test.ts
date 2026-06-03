import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { AuthStorage, Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { CustomTool } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import * as z from "zod/v4";

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `Tool ${mcpToolName} from ${serverName}`,
		mcpServerName: serverName,
		mcpToolName,
		parameters: z.object({ query: z.string() }),
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

function createLocalCustomTool(name: string): CustomTool {
	return {
		name,
		label: name,
		description: `Local inline tool ${name}`,
		parameters: z.object({ query: z.string() }),
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

function createReasoningModel(): Model<"openai-responses"> {
	return {
		id: "mock-reasoning",
		name: "mock-reasoning",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinking: { mode: "effort", minLevel: Effort.Medium, maxLevel: Effort.High },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

const oldSessionMtime = new Date("2000-01-01T00:00:00.000Z");

describe("createAgentSession MCP discovery prompt gating", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not load project MCP config unless MCP is explicitly enabled", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					local: {
						command: "definitely-missing-mcp-server",
					},
				},
			}),
		);

		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			toolNames: ["read"],
		});

		expect(mcpManager).toBeUndefined();
		expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
		expect(session.getActiveToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
	});

	it("does not advertise MCP discovery when search_tool_bm25 is not active", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			customTools: [createMcpCustomTool("mcp__github_create_issue", "github", "create_issue")],
		});

		expect(session.systemPrompt.join("\n")).not.toContain("### MCP tool discovery");
		expect(session.systemPrompt.join("\n")).not.toContain(
			"call `search_tool_bm25` before concluding no such tool exists",
		);
	});

	it("exposes generic discovery tooling for builtin-only tools.discoveryMode all sessions", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		const prompt = session.systemPrompt.join("\n");
		const searchTool = session.agent.state.tools.find(tool => tool.name === "search_tool_bm25");
		expect(session.getActiveToolNames()).not.toContain("find");
		expect(prompt).toContain("SearchTools: `search_tool_bm25`");
		expect(searchTool?.description).toContain("Search hidden tool metadata");
		expect(searchTool?.description).toContain("total_tools");
	});

	it("preserves explicitly requested MCP tools in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "mcp__github_create_issue", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});

		expect(session.getActiveToolNames()).toContain("mcp__github_create_issue");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
		expect(session.systemPrompt.join("\n")).toContain("mcp__github_create_issue");

		await session.activateDiscoveredMCPTools(["mcp__slack_post_message"]);

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "search_tool_bm25", "mcp__slack_post_message"]),
		);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__slack_post_message"]);
	});

	it("activates configured discovery default servers in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github", "missing"],
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue", "mcp__slack_post_message"]),
			);
		} finally {
			await session.dispose();
		}
	});

	it("keeps inline local mcp__-prefixed custom tools active alongside explicitly supplied MCP tools", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createLocalCustomTool("mcp__local_inline_tool"),
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
			],
		});
		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__local_inline_tool", "mcp__github_create_issue"]),
			);
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__local_inline_tool", "mcp__github_create_issue"]);
			expect(session.getDiscoverableMCPTools().map(tool => tool.name)).toEqual(["mcp__github_create_issue"]);
		} finally {
			await session.dispose();
		}
	});

	it("builds search_tool_bm25 descriptions from the loaded MCP catalog", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [createMcpCustomTool("mcp__github_create_issue", "github", "create_issue")],
		});

		const searchTool = session.agent.state.tools.find(tool => tool.name === "search_tool_bm25");
		expect(searchTool?.description).toContain("total_tools");
		expect(searchTool?.description).toContain("- `server_name`");
	});

	it("prunes deactivated builtin discoveries so they can be rediscovered", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		expect(await session.activateDiscoveredTools(["find"])).toEqual(["find"]);
		expect(session.getSelectedDiscoveredToolNames()).toContain("find");

		await session.setActiveToolsByName(["read", "search_tool_bm25"]);

		expect(session.getActiveToolNames()).not.toContain("find");
		expect(session.getSelectedDiscoveredToolNames()).not.toContain("find");
		expect(await session.activateDiscoveredTools(["find"])).toEqual(["find"]);
		expect(session.getActiveToolNames()).toContain("find");
	}, 30_000);
	it("restores explicit MCP, thinking, and service-tier entries when resuming without rewriting the session file", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: firstManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.activateDiscoveredMCPTools(["mcp__slack_post_message"]);
		firstSession.sessionManager.appendThinkingLevelChange(ThinkingLevel.Off);
		firstSession.sessionManager.appendServiceTierChange("priority");
		expect(firstSession.sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Off);
		expect(firstSession.getSelectedMCPToolNames()).toEqual(["mcp__slack_post_message"]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		fs.utimesSync(sessionFile!, oldSessionMtime, oldSessionMtime);
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		await firstSession.dispose();
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "none",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.thinkingLevel).toBe(ThinkingLevel.Off);
			expect(resumedSession.serviceTier).toBe("priority");
			expect(resumedSession.getSelectedMCPToolNames()).toEqual([
				"mcp__github_create_issue",
				"mcp__slack_post_message",
			]);
			expect(resumedSession.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue", "mcp__slack_post_message"]),
			);
			expect(resumedSession.systemPrompt.join("\n")).toContain("mcp__slack_post_message");
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await resumedSession.dispose();
		}
	}, 30_000);

	it("restores fallback MCP, thinking, and service-tier state in memory without rewriting the session file", async () => {
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({
			role: "user",
			content: "resume me",
			timestamp: Date.now(),
		});
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await sessionManager.rewriteEntries();
		fs.utimesSync(sessionFile!, oldSessionMtime, oldSessionMtime);
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github"],
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(session.serviceTier).toBe("priority");
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue", "mcp__slack_post_message"]),
			);
			expect(session.sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("rebuilds explicit MCP custom-tool selections when resuming with requested MCP tools", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: firstManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp__github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.setActiveToolsByName(["read", "search_tool_bm25"]);
		expect(firstSession.getSelectedMCPToolNames()).toEqual([]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		await firstSession.dispose();

		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp__github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.getSelectedMCPToolNames()).toEqual([
				"mcp__github_create_issue",
				"mcp__slack_post_message",
			]);
			expect(resumedSession.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue", "mcp__slack_post_message"]),
			);
		} finally {
			await resumedSession.dispose();
		}
	}, 30_000);
});
