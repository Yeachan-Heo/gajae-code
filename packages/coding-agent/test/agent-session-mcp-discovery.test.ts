import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { AgentSession } from "../src/session/agent-session";
import { buildSessionContext, SessionManager } from "../src/session/session-manager";

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

function createBasicTool(name: string, label: string): AgentTool {
	const schema = z.object({ value: z.string() });
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: schema,
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	description: string,
	schemaKeys: string[],
): AgentTool {
	const properties = Object.fromEntries(schemaKeys.map(key => [key, z.string()]));
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: z.object(properties),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as AgentTool;
}

function createMcpCustomTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	description: string,
	schemaKeys: string[],
): CustomTool {
	const properties = Object.fromEntries(schemaKeys.map(key => [key, z.string()]));
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: z.object(properties),
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

describe("AgentSession MCP discovery", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("caches discoverable MCP search indexes until MCP tools refresh", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const firstIndex = session.getDiscoverableToolSearchIndex();
		const secondIndex = session.getDiscoverableToolSearchIndex();
		expect(secondIndex).toBe(firstIndex);
		expect(firstIndex.documents.map(document => document.tool.name)).toEqual(["mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__pager_list", "pager", "list", "List pager alerts", ["service"]),
		]);

		const refreshedIndex = session.getDiscoverableToolSearchIndex();
		expect(refreshedIndex).not.toBe(firstIndex);
		expect(refreshedIndex.documents.map(document => document.tool.name)).toEqual(["mcp__pager_list"]);
	});

	it("reports only currently active MCP tools in non-discovery sessions", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);

		await session.setActiveToolsByName(["read"]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("keeps manually deactivated MCP tools off after refresh in non-discovery sessions", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("preserves directly activated MCP tools across refreshes in discovery mode", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
	});

	it("preserves active local mcp__-prefixed tools when MCP bridge tools refresh", async () => {
		const readTool = createBasicTool("read", "Read");
		const localTool = createBasicTool("mcp__local_inline_tool", "Local");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[localTool.name, localTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, localTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__local_inline_tool"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
		]);

		expect(session.getActiveToolNames()).toEqual(["read", "mcp__local_inline_tool"]);
		expect(session.getToolByName("mcp__local_inline_tool")).toBe(localTool);
		expect(session.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toEqual(["mcp__docs_search"]);
	});

	it("keeps MCP tools hidden by default and activates discovered selections additively", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toEqual([
			"mcp__docs_search",
			"mcp__slack_send_message",
		]);

		await session.activateDiscoveredTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);

		await session.activateDiscoveredTools(["mcp__slack_send_message"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search,mcp__slack_send_message"]);
	});

	it("persists mixed discovery activations with independent MCP and built-in authority", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const searchTool = createBasicTool("search", "Search");
		searchTool.loadMode = "discoverable";
		const findTool = createBasicTool("find", "Find");
		findTool.loadMode = "discoverable";
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[searchTool.name, searchTool],
			[findTool.name, findTool],
		]);
		const sessionManager = SessionManager.inMemory();
		let applyCount = 0;
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"tools.essentialOverride": ["read", "bash", "edit"],
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				applyCount++;
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		const entriesBeforeMixedActivation = sessionManager.getBranch().length;
		expect(await session.activateDiscoveredTools(["mcp__docs_search", "search"])).toEqual([
			"mcp__docs_search",
			"search",
		]);
		expect(applyCount).toBe(1);

		const mixedSelectionEntries = sessionManager.getBranch().slice(entriesBeforeMixedActivation);
		expect(mixedSelectionEntries.map(entry => entry.type)).toEqual([
			"mcp_tool_selection",
			"discovered_builtin_tool_selection",
		]);
		const [mcpSelectionEntry, builtinSelectionEntry] = mixedSelectionEntries;
		expect(mcpSelectionEntry.parentId).toBeNull();
		expect(builtinSelectionEntry.parentId).toBe(mcpSelectionEntry.id);
		const mcpMutationCorrelationId =
			mcpSelectionEntry.type === "mcp_tool_selection" ? mcpSelectionEntry.mutationCorrelationId : undefined;
		const builtinMutationCorrelationId =
			builtinSelectionEntry.type === "discovered_builtin_tool_selection"
				? builtinSelectionEntry.mutationCorrelationId
				: undefined;
		expect(mcpMutationCorrelationId).toEqual(expect.any(String));
		expect(builtinMutationCorrelationId).toBe(mcpMutationCorrelationId);
		expect(buildSessionContext(mixedSelectionEntries.slice(0, 1))).toMatchObject({
			hasPersistedMCPToolSelection: true,
			hasPersistedDiscoveredBuiltinToolSelection: false,
			selectedMCPToolNames: ["mcp__docs_search"],
			selectedDiscoveredBuiltinToolNames: undefined,
		});
		expect(buildSessionContext(mixedSelectionEntries)).toMatchObject({
			hasPersistedMCPToolSelection: true,
			hasPersistedDiscoveredBuiltinToolSelection: true,
			selectedMCPToolNames: ["mcp__docs_search"],
			selectedDiscoveredBuiltinToolNames: ["search"],
		});

		const entriesBeforeBuiltinOnlyActivation = sessionManager.getBranch().length;
		expect(await session.activateDiscoveredTools(["find"])).toEqual(["find"]);
		const builtinOnlySelectionEntries = sessionManager.getBranch().slice(entriesBeforeBuiltinOnlyActivation);
		expect(builtinOnlySelectionEntries.filter(entry => entry.type === "mcp_tool_selection")).toHaveLength(0);
		expect(
			builtinOnlySelectionEntries.filter(entry => entry.type === "discovered_builtin_tool_selection"),
		).toHaveLength(1);
	});

	it("leaves mixed discovery activation uncommitted when the unified rebuild fails", async () => {
		const readTool = createBasicTool("read", "Read");
		const mcpTool = createMcpTool("mcp__docs_search", "docs", "search", "Search", ["query"]);
		const builtinTool = createBasicTool("search", "Search");
		builtinTool.loadMode = "discoverable";
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[mcpTool.name, mcpTool],
			[builtinTool.name, builtinTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async () => {
				throw new Error("rebuild failed");
			},
		});
		sessions.push(session);

		const branchBefore = sessionManager.getBranch();
		await expect(session.activateDiscoveredTools(["mcp__docs_search", "search"])).rejects.toThrow("rebuild failed");
		expect(session.systemPrompt).toEqual(["initial"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual([]);
		expect(sessionManager.getBranch()).toEqual(branchBefore);
	});
	it("reapplies default MCP server baselines when refreshed tools reconnect", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPServerNames: ["slack"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([]);
		expect(sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(false);
	});

	it("persists cleared MCP selections when refresh removes a selected tool", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);

		await session.refreshMCPTools([]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([]);
	});

	it("restores unavailable MCP selections in memory without rewriting the persisted session selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMCPToolSelection(["mcp__docs_search"]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);
	});

	it("restores MCP discovery selections when branching to a context without them", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const findTool = createBasicTool("find", "Find");
		findTool.loadMode = "discoverable";
		const searchTool = createBasicTool("search", "Search");
		searchTool.loadMode = "discoverable";
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[findTool.name, findTool],
			[searchTool.name, searchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, searchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"tools.essentialOverride": ["read", "bash", "edit"],
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedDiscoveredBuiltinToolNames: ["search"],
			initialBaselineDiscoveredBuiltinToolNames: ["search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__docs_search", "find"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__docs_search", "search", "find"]);

		const result = await session.branch(userEntryId);

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read", "search"]);
		expect(session.systemPrompt).toEqual(["tools:read,search"]);
	});

	it("restores MCP discovery selections when navigating to a branch without them", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const findTool = createBasicTool("find", "Find");
		findTool.loadMode = "discoverable";
		const searchTool = createBasicTool("search", "Search");
		searchTool.loadMode = "discoverable";
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[findTool.name, findTool],
			[searchTool.name, searchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, searchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"tools.essentialOverride": ["read", "bash", "edit"],
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedDiscoveredBuiltinToolNames: ["search"],
			initialBaselineDiscoveredBuiltinToolNames: ["search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__docs_search", "find"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__docs_search", "search", "find"]);

		const result = await session.navigateTree(userEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read", "search"]);
		expect(session.systemPrompt).toEqual(["tools:read,search"]);
	});

	it("preserves explicit MCP baseline when branching into older history without persisted selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialMCPToolSelectionIsExplicit: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			initialPersistedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const result = await session.branch(userEntryId);

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
	});

	it("preserves explicit MCP baseline when navigating into older history without persisted selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "follow up",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialMCPToolSelectionIsExplicit: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			initialPersistedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const result = await session.navigateTree(userEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
	});

	it("restores session defaults in memory across session switches without rewriting sessions missing persisted metadata", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-session-mcp-switch-"));
		tempDirs.push(tempDir);
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const findTool = createBasicTool("find", "Find");
		findTool.loadMode = "discoverable";
		const searchTool = createBasicTool("search", "Search");
		searchTool.loadMode = "discoverable";
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[findTool.name, findTool],
			[searchTool.name, searchTool],
		]);

		const olderSessionManager = SessionManager.create(tempDir, tempDir);
		olderSessionManager.appendMessage({
			role: "user",
			content: "older session",
			timestamp: Date.now(),
		});
		const olderSessionFile = olderSessionManager.getSessionFile();
		expect(olderSessionFile).toBeString();
		await olderSessionManager.rewriteEntries();
		const olderSessionBeforeSwitch = fs.readFileSync(olderSessionFile!, "utf8");
		const olderSessionMtimeBeforeSwitch = fs.statSync(olderSessionFile!).mtimeMs;

		const sessionManager = SessionManager.create(tempDir, tempDir);
		const originalSessionFile = sessionManager.getSessionFile();
		expect(originalSessionFile).toBeString();
		await sessionManager.flush();

		const reasoningModel: Model<"openai-responses"> = {
			...createModel(),
			reasoning: true,
			thinking: { mode: "effort", minLevel: Effort.Medium, maxLevel: Effort.Medium },
		};

		const agent = new Agent({
			initialState: {
				model: reasoningModel,
				systemPrompt: ["initial"],
				tools: [readTool, searchTool, docsSearchTool, findTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.discoveryMode": "all",
				"tools.essentialOverride": ["read", "bash", "edit"],
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			initialSelectedDiscoveredBuiltinToolNames: ["search", "find"],
			initialBaselineDiscoveredBuiltinToolNames: ["search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__docs_search", "search", "find"]);
		sessionManager.appendThinkingLevelChange(ThinkingLevel.High);
		sessionManager.appendServiceTierChange("flex");
		const legacySelectionContext = buildSessionContext([
			{
				type: "mcp_tool_selection",
				id: "legacy-selection",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				selectedToolNames: ["mcp__docs_search"],
				selectedDiscoveredBuiltinToolNames: ["search", "find"],
			},
		]);
		expect(legacySelectionContext.selectedDiscoveredBuiltinToolNames).toEqual(["search", "find"]);
		sessionManager.appendMCPToolSelection(["mcp__docs_search"]);
		sessionManager.appendDiscoveredBuiltinToolSelection(["search", "find"]);
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.High);
		expect(sessionManager.buildSessionContext().serviceTier).toBe("flex");
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().selectedDiscoveredBuiltinToolNames).toEqual(["search", "find"]);
		expect(sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(true);
		await sessionManager.rewriteEntries();
		const originalSessionBeforeSwitch = fs.readFileSync(originalSessionFile!, "utf8");
		const originalSessionMtimeBeforeSwitch = fs.statSync(originalSessionFile!).mtimeMs;

		await session.switchSession(olderSessionFile!);
		expect(session.sessionFile).toBe(olderSessionFile);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.serviceTier).toBe("priority");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "search", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,search,mcp__docs_search"]);
		expect(fs.readFileSync(olderSessionFile!, "utf8")).toBe(olderSessionBeforeSwitch);
		expect(fs.statSync(olderSessionFile!).mtimeMs).toBe(olderSessionMtimeBeforeSwitch);

		await session.switchSession(originalSessionFile!);
		expect(session.sessionFile).toBe(originalSessionFile);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.serviceTier).toBe("flex");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__docs_search", "search", "find"]);
		expect(session.getActiveToolNames()).toEqual(["read", "search", "mcp__docs_search", "find"]);
		expect(session.systemPrompt).toEqual(["tools:read,search,mcp__docs_search,find"]);
		expect(fs.readFileSync(originalSessionFile!, "utf8")).toBe(originalSessionBeforeSwitch);
		expect(fs.statSync(originalSessionFile!).mtimeMs).toBe(originalSessionMtimeBeforeSwitch);
	});

	it("restores explicit MCP defaults after startup outage once tools recover in a new session", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
			defaultSelectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);

		await session.newSession();

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search,mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([]);
	});

	it("clears discovered MCP selections when starting a brand-new session", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.newSession();

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	// ── Findings #2: unified MCP discovery descriptors ─────────────────────────
	it("getDiscoverableTools returns unified MCP descriptors with description and summary", () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		const discoverable = session.getDiscoverableTools({ source: "mcp" });
		expect(discoverable).toHaveLength(1);
		const entry = discoverable[0]!;
		expect(entry.name).toBe("mcp__docs_search");
		expect(entry.description).toBe("Search internal docs");
		expect(entry.summary).toBe("Search internal docs");
	});

	it("getDiscoverableMCPSearchIndex documents expose tool.summary (legacy shape)", () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		const index = session.getDiscoverableToolSearchIndex();
		expect(index.documents).toHaveLength(1);
		const doc = index.documents[0]!;
		expect(doc.tool.name).toBe("mcp__docs_search");
		expect(doc.tool.summary).toBe("Search internal docs");
	});

	// ── Findings #3: discovery index is invalidated on active-tool changes ─────
	it("setActiveToolsByName invalidates the generic discoverable tool search index", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		// Index built before activation contains the discoverable MCP tool.
		const beforeIndex = session.getDiscoverableToolSearchIndex();
		const beforeNames = beforeIndex.documents.map(d => d.tool.name);
		expect(beforeNames).toContain("mcp__docs_search");

		await session.setActiveToolsByName(["read", "mcp__docs_search"]);

		// After activation the same lookup must return a fresh index that no longer lists the
		// now-active tool. If invalidation regressed, this would still return `beforeIndex`.
		const afterIndex = session.getDiscoverableToolSearchIndex();
		expect(afterIndex).not.toBe(beforeIndex);
		expect(afterIndex.documents.map(d => d.tool.name)).not.toContain("mcp__docs_search");
	});

	// ── Findings #4: built-in discovery is restricted to declared discoverable ─
	it("getDiscoverableTools({source:'builtin'}) excludes hidden and non-declared registry tools", () => {
		const readTool = createBasicTool("read", "Read");
		readTool.loadMode = "essential";
		const findTool = createBasicTool("find", "Find");
		findTool.loadMode = "discoverable";
		findTool.summary = "Find files and directories matching a glob pattern";
		const resolveTool = createBasicTool("resolve", "Resolve"); // hidden — must be excluded
		const customTool = createBasicTool("custom_inactive", "Custom"); // not in metadata — must be excluded
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[findTool.name, findTool],
			[resolveTool.name, resolveTool],
			[customTool.name, customTool],
		]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		const builtin = session.getDiscoverableTools({ source: "builtin" });
		const names = builtin.map(t => t.name);
		expect(names).toContain("find"); // declared discoverable AND present in registry
		expect(names).not.toContain("read"); // already active
		expect(names).not.toContain("resolve"); // hidden — no discoverable loadMode
		expect(names).not.toContain("custom_inactive"); // unknown — no discoverable loadMode
	});
});
