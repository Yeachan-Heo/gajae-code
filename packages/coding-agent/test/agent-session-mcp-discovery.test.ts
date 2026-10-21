import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { attachExactMcpControls } from "../src/runtime-mcp/redaction";
import { AgentSession } from "../src/session/agent-session";
import { buildSessionContext, SessionManager } from "../src/session/session-manager";
import { ToolContextStore } from "../src/tools/context";

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

	function createMcpActivationRaceSession(
		rebuildSystemPrompt: (toolNames: string[]) => Promise<{ systemPrompt: string[] }>,
	) {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", [
			"query",
		]);
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map<string, AgentTool>([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt,
		});
		sessions.push(session);
		return { session, docsSearchTool };
	}

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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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

		await session.replaceNamedCustomTools(
			["mcp__pager_list"],
			[createMcpCustomTool("mcp__docs_lookup", "docs", "lookup", "Lookup internal docs", ["query"])],
			{ mandatoryMCPToolNames: ["mcp__docs_lookup"] },
		);
		expect(session.getToolByName("mcp__pager_list")).toBeUndefined();
		expect(session.getActiveToolNames()).toContain("mcp__docs_lookup");
		expect(session.getDiscoverableTools({ source: "mcp" })).toEqual([]);
		const swappedIndex = session.getDiscoverableToolSearchIndex();
		expect(swappedIndex).not.toBe(refreshedIndex);
		expect(swappedIndex.documents).toEqual([]);
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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

	it("retains a committed MCP activation in live authority across a catalog retry", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a message", [
			"channel",
			"text",
		]);
		const docsSearchCustomTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]);
		const slackSendCustomTool = createMcpCustomTool(
			"mcp__slack_send_message",
			"slack",
			"send_message",
			"Send a message",
			["channel", "text"],
		);
		let session: AgentSession;
		let removeAfterActivation = false;
		let catalogRemoval: Promise<void> | undefined;
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool, docsSearchTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[docsSearchTool.name, docsSearchTool],
				[slackSendTool.name, slackSendTool],
			]),
			mcpDiscoveryEnabled: true,
			onToolNamesChanged: names => {
				if (removeAfterActivation && names.includes(slackSendTool.name)) {
					removeAfterActivation = false;
					catalogRemoval = session.refreshMCPTools([docsSearchCustomTool], { persistMCPSelection: false });
				}
			},
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName([readTool.name, docsSearchTool.name]);
		removeAfterActivation = true;
		await session.activateDiscoveredTools([slackSendTool.name]);
		if (!catalogRemoval) throw new Error("Expected activation to trigger the catalog removal");
		await catalogRemoval;
		expect(session.getActiveMCPToolNames()).toEqual([docsSearchTool.name]);

		await session.refreshMCPTools([docsSearchCustomTool, slackSendCustomTool], { persistMCPSelection: false });
		expect(session.getActiveMCPToolNames()).toEqual([docsSearchTool.name, slackSendTool.name]);
	});

	it("does not adopt a pending MCP selection during catalog replacement", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchToolName = "mcp__docs_search";
		const docsSearchCustomTool = createMcpCustomTool(docsSearchToolName, "docs", "search", "Search docs", ["query"]);
		const replacementDocsSearchTool = createMcpCustomTool(
			docsSearchToolName,
			"docs",
			"search",
			"Search docs with refreshed metadata",
			["query"],
		);
		const explicitRebuildStarted = Promise.withResolvers<void>();
		const releaseExplicitRebuild = Promise.withResolvers<void>();
		let blockExplicitRebuild = true;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (blockExplicitRebuild && toolNames.includes(docsSearchToolName)) {
					blockExplicitRebuild = false;
					explicitRebuildStarted.resolve();
					await releaseExplicitRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		await session.refreshMCPTools([docsSearchCustomTool], { persistMCPSelection: false });
		const explicitSelection = session.setActiveToolsByName([readTool.name, docsSearchToolName], {
			persistMCPSelection: false,
		});
		try {
			await explicitRebuildStarted.promise;
			const replacement = session.replaceNamedCustomTools([docsSearchToolName], [replacementDocsSearchTool], {
				activateNewTools: false,
				persistMCPSelection: false,
			});
			releaseExplicitRebuild.resolve();
			await Promise.all([explicitSelection, replacement]);
		} finally {
			releaseExplicitRebuild.resolve();
		}

		expect(session.getActiveToolNames()).toEqual([readTool.name]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.hasMCPToolSelectionAuthority()).toBe(false);
		expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
	});

	it("keeps a pending explicit MCP selection out of a concurrent discovery activation", async () => {
		const readTool = createBasicTool("read", "Read");
		const tentativeTool = createMcpCustomTool("mcp__tentative_search", "docs", "tentative", "Tentative", ["query"]);
		const activatedTool = createMcpCustomTool("mcp__activated_search", "docs", "activated", "Activated", ["query"]);
		const tentativeRebuildStarted = Promise.withResolvers<void>();
		const releaseTentativeRebuild = Promise.withResolvers<void>();
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (toolNames.includes(tentativeTool.name)) {
					tentativeRebuildStarted.resolve();
					await releaseTentativeRebuild.promise;
					throw new Error("tentative selection rebuild failed");
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		await session.refreshMCPTools([tentativeTool, activatedTool], { persistMCPSelection: false });
		const pendingSelection = session.setActiveToolsByName([readTool.name, tentativeTool.name]);
		try {
			await tentativeRebuildStarted.promise;
			expect(session.hasMCPToolSelectionAuthority()).toBe(true);
			expect(session.hasCommittedMCPToolSelectionAuthority()).toBe(false);

			expect(await session.activateDiscoveredTools([activatedTool.name])).toEqual([activatedTool.name]);
			expect(session.getActiveMCPToolNames()).toEqual([activatedTool.name]);
			expect(session.getSelectedMCPToolNames()).toEqual([activatedTool.name]);
			expect(session.hasCommittedMCPToolSelectionAuthority()).toBe(true);

			releaseTentativeRebuild.resolve();
			await expect(pendingSelection).rejects.toThrow("tentative selection rebuild failed");
		} finally {
			releaseTentativeRebuild.resolve();
		}

		expect(session.getSelectedMCPToolNames()).toEqual([activatedTool.name]);
		expect(session.buildDisplaySessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: [activatedTool.name],
		});
		await session.refreshMCPTools([tentativeTool, activatedTool], { persistMCPSelection: false });
		expect(session.getActiveMCPToolNames()).toEqual([activatedTool.name]);
		expect(session.getActiveToolNames()).not.toContain(tentativeTool.name);
	});

	it("keeps configured MCP defaults after explicit tool application fails", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]);
		let failDeselection = false;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPServerNames: ["docs"],
			rebuildSystemPrompt: async toolNames => {
				if (failDeselection && !toolNames.includes(docsSearchTool.name)) {
					throw new Error("injected tool application failure");
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		await session.refreshMCPTools([docsSearchTool]);
		expect(session.getActiveToolNames()).toEqual(["read", docsSearchTool.name]);
		expect(session.hasMCPToolSelectionAuthority()).toBe(false);

		failDeselection = true;
		await expect(session.setActiveToolsByName(["read"])).rejects.toThrow("injected tool application failure");
		expect(session.getActiveToolNames()).toEqual(["read", docsSearchTool.name]);
		expect(session.hasMCPToolSelectionAuthority()).toBe(false);

		failDeselection = false;
		await session.refreshMCPTools([docsSearchTool]);
		expect(session.getSelectedMCPToolNames()).toEqual([docsSearchTool.name]);
		expect(session.getActiveToolNames()).toEqual(["read", docsSearchTool.name]);
		expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
	});

	it("does not restore an uncommitted MCP selection after overlapping explicit requests fail", async () => {
		const readTool = createBasicTool("read", "Read");
		const findTool = createBasicTool("find", "Find");
		const searchTool = createBasicTool("search", "Search");
		const firstRebuildStarted = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		const secondRebuildStarted = Promise.withResolvers<void>();
		const releaseSecondRebuild = Promise.withResolvers<void>();
		const lateTool = createMcpCustomTool("mcp__late_search", "docs", "search", "Search docs", ["query"]);
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[findTool.name, findTool],
				[searchTool.name, searchTool],
			]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (toolNames.includes(findTool.name)) {
					firstRebuildStarted.resolve();
					await releaseFirstRebuild.promise;
					throw new Error("first rebuild failed");
				}
				if (toolNames.includes(searchTool.name)) {
					secondRebuildStarted.resolve();
					await releaseSecondRebuild.promise;
					throw new Error("second rebuild failed");
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		const firstSelection = session.setActiveToolsByName(["read", "find", "mcp__late_search"]);
		await firstRebuildStarted.promise;
		const secondSelection = session.setActiveToolsByName(["read", "search", "mcp__other_late"]);
		await secondRebuildStarted.promise;

		releaseSecondRebuild.resolve();
		await expect(secondSelection).rejects.toThrow("second rebuild failed");
		releaseFirstRebuild.resolve();
		await expect(firstSelection).rejects.toThrow("first rebuild failed");

		expect(session.hasMCPToolSelectionAuthority()).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		await session.refreshMCPTools([lateTool], { persistMCPSelection: false });
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getActiveToolNames()).not.toContain(lateTool.name);
	});

	it("does not apply a catalog retry after a new session commits", async () => {
		const readTool = createBasicTool("read", "Read");
		const findTool = createBasicTool("find", "Find");
		const firstRebuildStarted = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		const retryRebuildStarted = Promise.withResolvers<void>();
		const releaseRetryRebuild = Promise.withResolvers<void>();
		let findRebuildCount = 0;
		const lateTool = createMcpCustomTool("mcp__late_search", "docs", "search", "Search docs", ["query"]);
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[findTool.name, findTool],
			]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (toolNames.includes(findTool.name)) {
					findRebuildCount += 1;
					if (findRebuildCount === 1) {
						firstRebuildStarted.resolve();
						await releaseFirstRebuild.promise;
					} else {
						retryRebuildStarted.resolve();
						await releaseRetryRebuild.promise;
					}
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		const pendingSelection = session.setActiveToolsByName(["read", "find"], {
			explicit: false,
			persistMCPSelection: false,
			retryOnMcpCatalogChange: true,
		});
		await firstRebuildStarted.promise;
		await session.refreshMCPTools([lateTool], { persistMCPSelection: false });
		releaseFirstRebuild.resolve();
		await retryRebuildStarted.promise;

		await expect(session.newSession()).resolves.toBe(true);
		releaseRetryRebuild.resolve();
		await expect(pendingSelection).rejects.toThrow(/superseded/);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("does not persist catalog pruning of a non-persisting live MCP selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const persistedTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]);
		const liveTool = createMcpCustomTool("mcp__pager_list", "pager", "list", "List alerts", ["service"]);
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		await session.refreshMCPTools([persistedTool, liveTool]);
		await session.setActiveToolsByName(["read", persistedTool.name]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: [persistedTool.name],
		});

		await session.setActiveToolsByName(["read", liveTool.name], { persistMCPSelection: false });
		expect(session.getSelectedMCPToolNames()).toEqual([liveTool.name]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([persistedTool.name]);

		await session.refreshMCPTools([persistedTool]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: [persistedTool.name],
		});
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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

	it("serializes concurrent discovery activations and persists both selections", async () => {
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
		const sessionManager = SessionManager.inMemory();
		const firstRebuildStarted = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		const rebuiltToolNames: string[][] = [];
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				rebuiltToolNames.push([...toolNames]);
				if (toolNames.includes("mcp__docs_search")) {
					firstRebuildStarted.resolve();
					await releaseFirstRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		const firstActivation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await firstRebuildStarted.promise;
		const secondActivation = session.activateDiscoveredTools(["mcp__slack_send_message"]);
		releaseFirstRebuild.resolve();

		expect(await Promise.all([firstActivation, secondActivation])).toEqual([
			["mcp__docs_search"],
			["mcp__slack_send_message"],
		]);
		expect(rebuiltToolNames).toEqual([
			["read", "mcp__docs_search"],
			["read", "mcp__docs_search", "mcp__slack_send_message"],
		]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search,mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
		});
	});

	it("preserves queued discovery activations when a new-session hook cancels", async () => {
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
		const sessionManager = SessionManager.inMemory();
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry: {} as never,
			model: createModel(),
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated(),
		}));
		const firstRebuildStarted = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_switch",
			emit: async () => ({ cancel: true }),
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			onToolNamesChanged: names => toolContextStore.setToolNames(names),
			mcpDiscoveryEnabled: true,
			extensionRunner,
			rebuildSystemPrompt: async toolNames => {
				if (toolNames.includes("mcp__docs_search")) {
					firstRebuildStarted.resolve();
					await releaseFirstRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);
		const originalSessionId = session.sessionId;
		const originalSessionFile = session.sessionFile;

		const rebuildingActivation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await firstRebuildStarted.promise;
		const queuedActivation = session.activateDiscoveredTools(["mcp__slack_send_message"]);

		expect(await session.newSession()).toBe(false);
		expect(session.sessionId).toBe(originalSessionId);
		expect(session.sessionFile).toBe(originalSessionFile);
		expect(session.getActiveToolNames()).toEqual(["read"]);

		releaseFirstRebuild.resolve();
		expect(await Promise.all([rebuildingActivation, queuedActivation])).toEqual([
			["mcp__docs_search"],
			["mcp__slack_send_message"],
		]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search,mcp__slack_send_message"]);
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
		});
	});

	it("preserves a rebuilding discovery activation when a session-switch hook cancels", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry: {} as never,
			model: createModel(),
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated(),
		}));
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		const beforeSwitchStarted = Promise.withResolvers<void>();
		const releaseSwitchHook = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_switch",
			emit: async () => {
				beforeSwitchStarted.resolve();
				await releaseSwitchHook.promise;
				return { cancel: true };
			},
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			onToolNamesChanged: names => toolContextStore.setToolNames(names),
			mcpDiscoveryEnabled: true,
			extensionRunner,
			rebuildSystemPrompt: async toolNames => {
				if (toolNames.includes("mcp__docs_search")) {
					rebuildStarted.resolve();
					await releaseRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);
		const originalSessionId = session.sessionId;
		const originalSessionFile = session.sessionFile;

		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await rebuildStarted.promise;
		const switchResult = session.switchSession("cancelled-target.jsonl");
		await beforeSwitchStarted.promise;
		releaseSwitchHook.resolve();

		expect(await switchResult).toBe(false);
		expect(session.sessionId).toBe(originalSessionId);
		expect(session.sessionFile).toBe(originalSessionFile);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		releaseRebuild.resolve();
		expect(await activation).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: ["mcp__docs_search"],
		});
	});

	it("preserves pending discovery activation while reading exact MCP status", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry: {} as never,
			model: createModel(),
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated(),
		}));
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exact-mcp-status-"));
		tempDirs.push(tempDir);
		const configPath = path.join(tempDir, "mcp.json");
		await Bun.write(configPath, JSON.stringify({ mcpServers: {} }));
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			onToolNamesChanged: names => toolContextStore.setToolNames(names),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (toolNames.includes("mcp__docs_search")) {
					rebuildStarted.resolve();
					await releaseRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);
		expect(toolContextStore.getContext().toolNames).toEqual(["read"]);
		attachExactMcpControls(session, { grantSource: "root-interactive-exact-config", configPath });

		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await rebuildStarted.promise;
		expect(await session.getExactMcpStatusSnapshot()).toEqual({
			startup: "no-servers-declared",
			servers: [],
		});

		releaseRebuild.resolve();
		expect(await activation).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: ["mcp__docs_search"],
		});
	});

	it("restores execution-context tool names when an exact MCP control commit fails", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", [
			"query",
		]);
		const toolRegistry = new Map([[readTool.name, readTool]]);
		const sessionManager = SessionManager.inMemory();
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry: {} as never,
			model: createModel(),
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated(),
		}));
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exact-mcp-rollback-"));
		tempDirs.push(tempDir);
		const configPath = path.join(tempDir, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://127.0.0.1:1" } } }),
		);
		const ownedMcpManager = {
			releaseLeases: async () => {},
			prepareExactServerControl: async () => ({
				result: { status: "suspended", toolCount: 0 },
				tools: [],
				commit: async () => {
					throw new Error("MCP commit failed");
				},
				abort: async () => {},
			}),
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			ownedMcpManager,
			onToolNamesChanged: names => toolContextStore.setToolNames(names),
			mcpDiscoveryEnabled: true,
		});
		sessions.push(session);
		attachExactMcpControls(session, { grantSource: "root-interactive-exact-config", configPath });
		await session.refreshMCPTools([docsSearchTool], {
			selectedMCPToolNames: ["mcp__docs_search"],
			activeMCPToolNames: ["mcp__docs_search"],
		});
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());

		await expect(session.controlExactMcpServer("suspend", "docs")).rejects.toThrow("MCP commit failed");
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
	});

	it("fences activation when exact MCP retirement fails after new-session adoption", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", [
			"query",
		]);
		const sessionManager = SessionManager.inMemory();
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry: {} as never,
			model: createModel(),
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated(),
		}));
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		let blockFirstSearchRebuild = true;
		const ownedMcpManager = {
			releaseLeases: async () => {},
			prepareExactServerControlReset: async () => ({
				canCommit: () => true,
				tools: [],
				commit: async () => {
					throw new Error("MCP retirement commit failed");
				},
				abort: async () => {},
			}),
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			ownedMcpManager,
			onToolNamesChanged: names => toolContextStore.setToolNames(names),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (blockFirstSearchRebuild && toolNames.includes("mcp__docs_search")) {
					blockFirstSearchRebuild = false;
					rebuildStarted.resolve();
					await releaseRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);
		attachExactMcpControls(session, {
			grantSource: "root-interactive-exact-config",
			configPath: "/tmp/exact-mcp.json",
		});
		await session.refreshMCPTools([docsSearchTool], { selectedMCPToolNames: [], activeMCPToolNames: [] });
		const originalSessionId = session.sessionId;

		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await rebuildStarted.promise;
		await expect(session.newSession()).rejects.toThrow("MCP retirement commit failed");
		expect(session.sessionId).not.toBe(originalSessionId);
		releaseRebuild.resolve();

		expect(await activation).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(toolContextStore.getContext().toolNames).toEqual(["read"]);
	});

	it("fences activation when exact MCP retirement fails after branch adoption", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", [
			"query",
		]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		let blockFirstSearchRebuild = true;
		const ownedMcpManager = {
			releaseLeases: async () => {},
			prepareExactServerControlReset: async () => ({
				canCommit: () => true,
				tools: [],
				commit: async () => {
					throw new Error("MCP retirement commit failed");
				},
				abort: async () => {},
			}),
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			ownedMcpManager,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (blockFirstSearchRebuild && toolNames.includes("mcp__docs_search")) {
					blockFirstSearchRebuild = false;
					rebuildStarted.resolve();
					await releaseRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);
		attachExactMcpControls(session, {
			grantSource: "root-interactive-exact-config",
			configPath: "/tmp/exact-mcp.json",
		});
		await session.refreshMCPTools([docsSearchTool], { selectedMCPToolNames: [], activeMCPToolNames: [] });
		const originalSessionId = session.sessionId;

		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await rebuildStarted.promise;
		await expect(session.branch(userEntryId)).rejects.toThrow("MCP retirement commit failed");
		expect(session.sessionId).not.toBe(originalSessionId);
		releaseRebuild.resolve();

		expect(await activation).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
	});

	it("preserves pending discovery activation through compaction", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		for (const content of ["older conversation", "recent conversation"]) {
			sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() });
		}
		const compactionStarted = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async (event: { type: string; preparation?: { firstKeptEntryId: string; tokensBefore: number } }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				compactionStarted.resolve();
				await releaseCompaction.promise;
				return {
					compaction: {
						summary: "compacted summary",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true, "compaction.keepRecentTokens": 1 }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[docsSearchTool.name, docsSearchTool],
			]),
			mcpDiscoveryEnabled: true,
			extensionRunner,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const compaction = session.compact();
		await compactionStarted.promise;
		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		releaseCompaction.resolve();

		await compaction;
		expect(await activation).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
	});

	it("preserves pending discovery activation through automatic compaction", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		for (const content of ["older conversation", "recent conversation"]) {
			sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() });
		}
		const compactionStarted = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async (event: { type: string; preparation?: { firstKeptEntryId: string; tokensBefore: number } }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				compactionStarted.resolve();
				await releaseCompaction.promise;
				return {
					compaction: {
						summary: "compacted summary",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry: {
				getAvailable: () => [createModel()],
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[docsSearchTool.name, docsSearchTool],
			]),
			mcpDiscoveryEnabled: true,
			extensionRunner,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const compaction = session.runIdleCompaction();
		await compactionStarted.promise;
		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		releaseCompaction.resolve();

		await compaction;
		expect(await activation).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
	});

	it("revalidates activation against a replaced MCP catalog after prompt rebuild", async () => {
		const readTool = createBasicTool("read", "Read");
		const oldSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Old docs search", ["query"]);
		const refreshedSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Refreshed docs search", [
			"query",
			"scope",
		]);
		const sessionManager = SessionManager.inMemory();
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry: {} as never,
			model: createModel(),
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated(),
		}));
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		let blockFirstSearchRebuild = true;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			onToolNamesChanged: names => toolContextStore.setToolNames(names),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (blockFirstSearchRebuild && toolNames.includes("mcp__docs_search")) {
					blockFirstSearchRebuild = false;
					rebuildStarted.resolve();
					await releaseRebuild.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);
		await session.refreshMCPTools([oldSearchTool], { selectedMCPToolNames: [], activeMCPToolNames: [] });

		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await rebuildStarted.promise;
		await session.refreshMCPTools([refreshedSearchTool], { selectedMCPToolNames: [], activeMCPToolNames: [] });
		releaseRebuild.resolve();

		expect(await activation).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
		expect(session.agent.state.tools.find(tool => tool.name === "mcp__docs_search")?.description).toBe(
			"Refreshed docs search",
		);
	});

	it("rebuilds discovery activation after a concurrent base prompt refresh", async () => {
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		let blockFirstDiscoveryRebuild = true;
		const { session, docsSearchTool } = createMcpActivationRaceSession(async toolNames => {
			if (blockFirstDiscoveryRebuild && toolNames.includes("mcp__docs_search")) {
				blockFirstDiscoveryRebuild = false;
				rebuildStarted.resolve();
				await releaseRebuild.promise;
			}
			return { systemPrompt: [`tools:${toolNames.join(",")}`] };
		});
		await session.refreshMCPTools([docsSearchTool], { selectedMCPToolNames: [], activeMCPToolNames: [] });

		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await rebuildStarted.promise;
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt).toEqual(["tools:read"]);
		releaseRebuild.resolve();

		expect(await activation).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
	});

	it("does not restore discovered tools after a newer explicit active-tool selection", async () => {
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		let blockFirstDiscoveryRebuild = true;
		const { session, docsSearchTool } = createMcpActivationRaceSession(async toolNames => {
			if (blockFirstDiscoveryRebuild && toolNames.includes("mcp__docs_search")) {
				blockFirstDiscoveryRebuild = false;
				rebuildStarted.resolve();
				await releaseRebuild.promise;
			}
			return { systemPrompt: [`tools:${toolNames.join(",")}`] };
		});
		await session.refreshMCPTools([docsSearchTool], { selectedMCPToolNames: [], activeMCPToolNames: [] });

		const activation = session.activateDiscoveredTools(["mcp__docs_search"]);
		await rebuildStarted.promise;
		await session.setActiveToolsByName(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
		releaseRebuild.resolve();

		expect(await activation).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("revalidates discoverable activation when an SSH registry entry is replaced", async () => {
		const readTool = createBasicTool("read", "Read");
		const oldSshTool = createBasicTool("ssh", "Old SSH");
		oldSshTool.loadMode = "discoverable";
		const refreshedSshTool = createBasicTool("ssh", "Refreshed SSH");
		refreshedSshTool.loadMode = "discoverable";
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-activation-race-"));
		tempDirs.push(tempDir);
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		let blockFirstSshRebuild = true;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[oldSshTool.name, oldSshTool],
			]),
			reloadSshTool: async () => refreshedSshTool,
			rebuildSystemPrompt: async (toolNames, tools) => {
				if (blockFirstSshRebuild && toolNames.includes("ssh")) {
					blockFirstSshRebuild = false;
					rebuildStarted.resolve();
					await releaseRebuild.promise;
				}
				return { systemPrompt: toolNames.map(name => `${name}:${tools.get(name)?.description ?? ""}`) };
			},
		});
		sessions.push(session);

		const activation = session.activateDiscoveredTools(["ssh"]);
		await rebuildStarted.promise;
		await session.refreshSshTool();
		releaseRebuild.resolve();

		expect(await activation).toEqual(["ssh"]);
		expect(session.getActiveToolNames()).toEqual(["read", "ssh"]);
		expect(session.agent.state.tools.find(tool => tool.name === "ssh")?.description).toBe("Refreshed SSH tool");
		expect(session.systemPrompt).toEqual(["read:Read tool", "ssh:Refreshed SSH tool"]);
	});

	for (const outcome of ["cancel", "commit"] as const) {
		it(`queues activation requested during transition preflight until ${outcome}`, async () => {
			const readTool = createBasicTool("read", "Read");
			const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", [
				"query",
			]);
			const toolRegistry = new Map([[readTool.name, readTool]]);
			const sessionManager = SessionManager.inMemory();
			const toolContextStore = new ToolContextStore(() => ({
				sessionManager,
				modelRegistry: {} as never,
				model: createModel(),
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
				settings: Settings.isolated(),
			}));
			const beforeSwitchStarted = Promise.withResolvers<void>();
			const releaseSwitchHook = Promise.withResolvers<void>();
			const extensionRunner = {
				hasHandlers: (event: string) => event === "session_before_switch",
				emit: async (event: { type: string }) => {
					if (event.type === "session_before_switch") {
						beforeSwitchStarted.resolve();
						await releaseSwitchHook.promise;
						return outcome === "cancel" ? { cancel: true } : undefined;
					}
					return undefined;
				},
			} as never;
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: createModel(),
						systemPrompt: ["initial"],
						tools: [readTool],
						messages: [],
					},
				}),
				sessionManager,
				settings: Settings.isolated({ "mcp.discoveryMode": true }),
				modelRegistry: {
					withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
				} as never,
				toolRegistry,
				onToolNamesChanged: names => toolContextStore.setToolNames(names),
				mcpDiscoveryEnabled: true,
				extensionRunner,
				rebuildSystemPrompt: async toolNames => ({
					systemPrompt: [`tools:${toolNames.join(",")}`],
				}),
			});
			sessions.push(session);
			const originalSessionId = session.sessionId;

			const transition = session.newSession();
			await beforeSwitchStarted.promise;
			await session.refreshMCPTools([docsSearchTool]);

			let activationSettled = false;
			const activation = session.activateDiscoveredTools(["mcp__docs_search"]).then(names => {
				activationSettled = true;
				return names;
			});
			await Promise.resolve();
			expect(activationSettled).toBe(false);

			releaseSwitchHook.resolve();
			expect(await transition).toBe(outcome === "commit");
			expect(await activation).toEqual(outcome === "cancel" ? ["mcp__docs_search"] : []);

			if (outcome === "cancel") {
				expect(session.sessionId).toBe(originalSessionId);
				expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
				expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
				expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
				expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
				expect(sessionManager.buildSessionContext()).toMatchObject({
					hasPersistedMCPToolSelection: true,
					selectedMCPToolNames: ["mcp__docs_search"],
				});
			} else {
				expect(session.sessionId).not.toBe(originalSessionId);
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(session.getSelectedMCPToolNames()).toEqual([]);
				expect(session.systemPrompt.join(" ")).not.toContain("mcp__docs_search");
				expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
				expect(sessionManager.buildSessionContext()).toMatchObject({
					hasPersistedMCPToolSelection: false,
					selectedMCPToolNames: [],
				});
			}
		});
	}

	it("does not reactivate predecessor MCP tools from a catalog swap after /new", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]);
		const replacementDocsSearchTool = createMcpCustomTool(
			"mcp__docs_search",
			"docs",
			"search",
			"Updated search docs",
			["query"],
		);
		const defaultTool = createMcpTool("mcp__default_lookup", "default", "lookup", "Lookup default data", ["query"]);
		const replacementPromptStarted = Promise.withResolvers<void>();
		const releaseReplacementPrompt = Promise.withResolvers<void>();
		const beforeSwitchStarted = Promise.withResolvers<void>();
		const releaseSwitchHook = Promise.withResolvers<void>();
		let blockReplacementPrompt = false;
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_switch",
			emit: async (event: { type: string }) => {
				if (event.type === "session_before_switch") {
					beforeSwitchStarted.resolve();
					await releaseSwitchHook.promise;
				}
			},
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool, docsSearchTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map<string, AgentTool>([
				[readTool.name, readTool],
				[docsSearchTool.name, docsSearchTool],
				[defaultTool.name, defaultTool],
			]),
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPServerNames: ["default"],
			extensionRunner,
			rebuildSystemPrompt: async toolNames => {
				if (blockReplacementPrompt && toolNames.includes(docsSearchTool.name)) {
					blockReplacementPrompt = false;
					replacementPromptStarted.resolve();
					await releaseReplacementPrompt.promise;
				}
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		await session.setActiveToolsByName([readTool.name, docsSearchTool.name], { persistMCPSelection: false });
		blockReplacementPrompt = true;
		const replacement = session.replaceNamedCustomTools([docsSearchTool.name], [replacementDocsSearchTool], {
			activateNewTools: false,
			persistMCPSelection: false,
		});
		await replacementPromptStarted.promise;

		const transition = session.newSession();
		await beforeSwitchStarted.promise;
		releaseSwitchHook.resolve();
		expect(await transition).toBe(true);
		expect(session.getActiveToolNames()).toContain(defaultTool.name);
		expect(session.getActiveMCPToolNames()).not.toContain(docsSearchTool.name);

		releaseReplacementPrompt.resolve();
		await replacement;
		expect(session.getActiveToolNames()).toContain(defaultTool.name);
		expect(session.getActiveMCPToolNames()).not.toContain(docsSearchTool.name);
	});

	it("recomputes configured MCP defaults after a new-session catalog refresh", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", [
			"query",
		]);
		const beforeSwitchStarted = Promise.withResolvers<void>();
		const releaseSwitchHook = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_switch",
			emit: async (event: { type: string }) => {
				if (event.type === "session_before_switch") {
					beforeSwitchStarted.resolve();
					await releaseSwitchHook.promise;
				}
			},
		} as never;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPServerNames: ["docs"],
			extensionRunner,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read"], { persistMCPSelection: false });
		const transition = session.newSession();
		await beforeSwitchStarted.promise;
		await session.refreshMCPTools([docsSearchTool]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);

		releaseSwitchHook.resolve();
		expect(await transition).toBe(true);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
	});

	it("restores live MCP selection authority and active tools after a failed session switch", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-session-mcp-rollback-"));
		tempDirs.push(tempDir);
		const readTool = createBasicTool("read", "Read");
		const bashTool = createBasicTool("bash", "Bash");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[bashTool.name, bashTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		const targetSessionManager = SessionManager.create(tempDir, tempDir);
		targetSessionManager.appendMessage({ role: "user", content: "target session", timestamp: Date.now() });
		await targetSessionManager.flush();
		const targetSessionFile = targetSessionManager.getSessionFile();
		expect(previousSessionFile).toBeString();
		expect(targetSessionFile).toBeString();
		let targetMCPPromptRebuilt = false;
		let failTargetEnsureOnDisk = true;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool, bashTool, docsSearchTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => {
				if (sessionManager.getSessionFile() === targetSessionFile && toolNames.includes("mcp__docs_search"))
					targetMCPPromptRebuilt = true;
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (
				failTargetEnsureOnDisk &&
				targetMCPPromptRebuilt &&
				sessionManager.getSessionFile() === targetSessionFile
			) {
				failTargetEnsureOnDisk = false;
				throw new Error("injected post-tool session switch failure");
			}
			await ensureOnDisk();
		});
		const permissionRequests: string[] = [];
		session.setSdkPermissionMode("prompt");
		session.setClientBridge({
			capabilities: { requestPermission: true },
			async requestPermission(toolCall: { toolCallId: string }) {
				permissionRequests.push(toolCall.toolCallId);
				return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
			},
		} as never);

		await session.setActiveToolsByName(["read", "bash"], { persistMCPSelection: false });
		expect(session.hasMCPToolSelectionAuthority()).toBe(true);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		const preparedBash = session.agent.state.tools.find(tool => tool.name === "bash");
		expect(preparedBash).toBeDefined();
		await expect(session.switchSession(targetSessionFile!)).rejects.toThrow(
			"injected post-tool session switch failure",
		);

		expect(session.sessionFile).toBe(previousSessionFile);
		expect(session.hasMCPToolSelectionAuthority()).toBe(true);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
		const restoredBash = session.agent.state.tools.find(tool => tool.name === "bash");
		expect(restoredBash).toBe(preparedBash);
		await restoredBash!.execute(
			"rollback-permission-check",
			{ command: "echo safe" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(permissionRequests).toEqual(["rollback-permission-check"]);
		await session.setActiveToolsByName(["read", "mcp__docs_search"], { persistMCPSelection: false });
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]),
		]);
		expect(session.hasMCPToolSelectionAuthority()).toBe(true);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		await session.setActiveToolsByName(["read"], { persistMCPSelection: false });
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("fences in-flight search activation across new sessions and keeps tool context on committed tools", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const searchTool = createBasicTool("search", "Search");
		searchTool.loadMode = "discoverable";
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
			[searchTool.name, searchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry: {} as never,
			model: createModel(),
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated(),
		}));
		const firstRebuildStarted = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		let successorRebuildStarted = false;
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
			settings: Settings.isolated({ "mcp.discoveryMode": true, "tools.discoveryMode": "all" }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			onToolNamesChanged: names => toolContextStore.setToolNames(names),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => {
				if (toolNames.includes("search")) {
					firstRebuildStarted.resolve();
					await releaseFirstRebuild.promise;
				}
				if (toolNames.includes("mcp__slack_send_message")) successorRebuildStarted = true;
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		sessions.push(session);

		const staleActivation = session.activateDiscoveredTools(["search"]);
		await firstRebuildStarted.promise;
		await session.newSession();

		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual([]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: false,
			hasPersistedDiscoveredBuiltinToolSelection: false,
		});

		const successorActivation = session.activateDiscoveredTools(["mcp__slack_send_message"]);
		await Promise.resolve();
		const successorActivationStartedBeforeStaleRebuild = successorRebuildStarted;
		releaseFirstRebuild.resolve();

		expect(await Promise.all([staleActivation, successorActivation])).toEqual([[], ["mcp__slack_send_message"]]);
		expect(successorActivationStartedBeforeStaleRebuild).toBe(true);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__slack_send_message"]);
		expect(toolContextStore.getContext().toolNames).toEqual(session.getActiveToolNames());
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__slack_send_message"]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(["mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: ["mcp__slack_send_message"],
			hasPersistedDiscoveredBuiltinToolSelection: false,
		});
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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

	it("preserves unavailable persisted MCP names during additive discovery activation", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const refreshedSlackSendTool = createMcpCustomTool(
			slackSendTool.name,
			"slack",
			"send_message",
			"Send a Slack message",
			["channel", "text"],
		);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMCPToolSelection([docsSearchTool.name]);
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[slackSendTool.name, slackSendTool],
			]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: [docsSearchTool.name],
		});

		await session.activateDiscoveredTools([slackSendTool.name]);
		expect(session.getActiveMCPToolNames()).toEqual([slackSendTool.name]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: [docsSearchTool.name, slackSendTool.name],
		});

		await session.refreshMCPTools([docsSearchTool, refreshedSlackSendTool]);
		expect(session.getActiveMCPToolNames()).toEqual([docsSearchTool.name, slackSendTool.name]);
		expect(session.getSelectedMCPToolNames()).toEqual([docsSearchTool.name, slackSendTool.name]);
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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

	it("persists an explicit empty MCP selection when tool application is a no-op", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-session-mcp-empty-selection-"));
		tempDirs.push(tempDir);
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpCustomTool("mcp__docs_search", "docs", "search", "Search docs", ["query"]);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({ role: "user", content: "original session", timestamp: Date.now() });
		await sessionManager.flush();
		const originalSessionFile = sessionManager.getSessionFile();
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: createModel(),
					systemPrompt: ["initial"],
					tools: [readTool],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPServerNames: ["docs"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read"]);
		expect(sessionManager.buildSessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: [],
		});

		await sessionManager.flush();
		await sessionManager.ensureOnDisk();
		const targetSessionManager = SessionManager.create(tempDir, tempDir);
		targetSessionManager.appendMessage({ role: "user", content: "target session", timestamp: Date.now() });
		await targetSessionManager.flush();
		await targetSessionManager.ensureOnDisk();
		const targetSessionFile = targetSessionManager.getSessionFile();
		await targetSessionManager.close();
		expect(originalSessionFile).toBeString();
		expect(targetSessionFile).toBeString();

		await session.switchSession(targetSessionFile!);
		await session.refreshMCPTools([docsSearchTool]);
		expect(session.getActiveToolNames()).toEqual(["read", docsSearchTool.name]);

		await session.switchSession(originalSessionFile!);
		expect(session.sessionFile).toBe(originalSessionFile);
		expect(session.buildDisplaySessionContext()).toMatchObject({
			hasPersistedMCPToolSelection: true,
			selectedMCPToolNames: [],
		});
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("removes newly mandatory MCP tools from persisted user selections during refresh", async () => {
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([
			"mcp__docs_search",
			"mcp__slack_send_message",
		]);

		await session.refreshMCPTools(
			[createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"])],
			{ mandatoryMCPToolNames: ["mcp__docs_search"] },
		);

		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([]);
	});

	it("persists named replacement removal from MCP user selection", async () => {
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredTools(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([
			"mcp__docs_search",
			"mcp__slack_send_message",
		]);

		await session.replaceNamedCustomTools(
			["mcp__docs_search"],
			[createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"])],
			{ mandatoryMCPToolNames: ["mcp__docs_search"] },
		);

		expect(session.getActiveToolNames()).toContain("mcp__docs_search");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__slack_send_message"]);
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			compat: { supportsReasoningEffort: true },
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
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
