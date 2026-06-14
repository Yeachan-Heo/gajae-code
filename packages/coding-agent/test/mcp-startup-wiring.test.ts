import { describe, expect, it, mock } from "bun:test";
import { MCPManager } from "../src/runtime-mcp/manager";
import {
	adoptStartupMCPDiscovery,
	cleanupStartupMCPDiscovery,
	prepareStartupMCPDiscovery,
	redactMCPStartupError,
	type StartupMCPDiscovery,
} from "../src/runtime-mcp/startup-wiring";

describe("runtime MCP startup wiring", () => {
	const settings = (notifications = false, debounceMs = 5) => ({
		get: mock((key: string) => {
			if (key === "mcp.notifications") return notifications;
			if (key === "mcp.notificationDebounceMs") return debounceMs;
			return undefined;
		}),
	});

	it("keeps runtime discovery default-off by constructing nothing", async () => {
		const discover = mock(async () => {
			throw new Error("must not discover");
		});

		const startup = await prepareStartupMCPDiscovery({
			cwd: process.cwd(),
			enabled: false,
			discover: discover as any,
		});

		expect(startup).toBeUndefined();
		expect(discover).not.toHaveBeenCalled();
	});

	it("opt-in discovery refreshes the session with connected tools and prompt commands", async () => {
		const manager = new MCPManager(process.cwd());
		const tool = {
			name: "mcp__codegraph_search",
			label: "codegraph/search",
			description: "Search CodeGraph",
			parameters: {},
			execute: mock(async () => "ok"),
		};
		const discover = mock(async () => ({
			manager,
			tools: [tool],
			errors: [],
			connectedServers: ["codegraph"],
			exaApiKeys: [],
		}));

		const startup = await prepareStartupMCPDiscovery({
			cwd: "/repo",
			enabled: true,
			enableProjectConfig: false,
			discover: discover as any,
		});
		const session = {
			refreshMCPTools: mock(async (_tools: unknown[]) => undefined),
			setMCPPromptCommands: mock((_commands: unknown[]) => undefined),
		};

		await adoptStartupMCPDiscovery({ session: session as any, settings: settings() as any, startup: startup! });

		expect(discover).toHaveBeenCalledWith("/repo", expect.objectContaining({ enableProjectConfig: false }));
		expect(session.refreshMCPTools).toHaveBeenCalledWith([tool]);
		expect(session.setMCPPromptCommands).toHaveBeenCalledTimes(1);
	});

	it("cleans up and clears the singleton when adoption fails after manager assignment", async () => {
		const manager = new MCPManager(process.cwd());
		const disconnectAll = mock(async () => undefined);
		(manager as any).disconnectAll = disconnectAll;
		MCPManager.setInstance(manager);
		const startup: StartupMCPDiscovery = {
			manager,
			tools: [],
			connectedServers: [],
			errors: [],
		};

		await expect(
			(async () => {
				try {
					await adoptStartupMCPDiscovery({
						session: {
							refreshMCPTools: mock(async () => {
								throw new Error("adoption failed");
							}),
							setMCPPromptCommands: mock(() => undefined),
						} as any,
						settings: settings() as any,
						startup,
					});
				} catch (error) {
					await cleanupStartupMCPDiscovery(startup);
					throw error;
				}
			})(),
		).rejects.toThrow("adoption failed");

		expect(disconnectAll).toHaveBeenCalledTimes(1);
		expect(MCPManager.instance()).toBeUndefined();
	});

	it("unchanged reconnects use refreshMCPTools without rebuilding prompt commands", async () => {
		const tool = { name: "mcp__codegraph_search" };
		let onToolsChanged: ((tools: unknown[]) => void) | undefined;
		const manager = {
			getConnectedServers: () => [],
			setOnToolsChanged: (handler: (tools: unknown[]) => void) => {
				onToolsChanged = handler;
			},
			setOnPromptsChanged: mock(() => undefined),
			setOnResourcesChanged: mock(() => undefined),
		};
		const session = {
			refreshMCPTools: mock(async (_tools: unknown[]) => undefined),
			setMCPPromptCommands: mock((_commands: unknown[]) => undefined),
		};

		await adoptStartupMCPDiscovery({
			session: session as any,
			settings: settings() as any,
			startup: { manager: manager as any, tools: [tool] as any, connectedServers: [], errors: [] },
		});
		onToolsChanged?.([tool]);

		expect(session.refreshMCPTools).toHaveBeenCalledTimes(2);
		expect(session.refreshMCPTools).toHaveBeenLastCalledWith([tool]);
		expect(session.setMCPPromptCommands).toHaveBeenCalledTimes(1);
	});
	it("debounces resource notifications and respects the notification setting", async () => {
		let onResourcesChanged: ((serverName: string, uri: string) => void) | undefined;
		const manager = {
			getConnectedServers: () => [],
			setOnToolsChanged: mock(() => undefined),
			setOnPromptsChanged: mock(() => undefined),
			setOnResourcesChanged: (handler: (serverName: string, uri: string) => void) => {
				onResourcesChanged = handler;
			},
		};
		const enqueue = mock((_type: string, _entry: unknown) => undefined);
		const session = {
			refreshMCPTools: mock(async (_tools: unknown[]) => undefined),
			setMCPPromptCommands: mock((_commands: unknown[]) => undefined),
			yieldQueue: { enqueue },
			dispose: mock(async () => undefined),
		};

		await adoptStartupMCPDiscovery({
			session: session as any,
			settings: settings(true, 5) as any,
			startup: { manager: manager as any, tools: [], connectedServers: [], errors: [] },
		});

		onResourcesChanged?.("codegraph", "file:///a");
		onResourcesChanged?.("codegraph", "file:///a");
		await Bun.sleep(15);

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenLastCalledWith("mcp-notification", { serverName: "codegraph", uri: "file:///a" });

		enqueue.mockClear();
		await adoptStartupMCPDiscovery({
			session: session as any,
			settings: settings(false, 5) as any,
			startup: { manager: manager as any, tools: [], connectedServers: [], errors: [] },
		});
		onResourcesChanged?.("codegraph", "file:///b");
		await Bun.sleep(15);

		expect(enqueue).not.toHaveBeenCalled();
	});

	it("emits redacted non-fatal warnings with mcp logger paths for partial failures", async () => {
		const manager = new MCPManager(process.cwd());
		const warn = mock((_message: string, _details: Record<string, unknown>) => undefined);
		const startup = await prepareStartupMCPDiscovery({
			cwd: process.cwd(),
			enabled: true,
			warn,
			discover: mock(async () => ({
				manager,
				tools: [],
				errors: [
					{
						path: "mcp:codegraph",
						error: "failed with Authorization=Bearer sk-secret123 and api_key=topsecret --arg raw",
					},
				],
				connectedServers: [],
				exaApiKeys: [],
			})) as any,
		});

		expect(startup).toBeDefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				path: "mcp:codegraph",
				serverName: "codegraph",
			}),
		);
		expect(String(warn.mock.calls[0][1].error)).not.toContain("sk-secret123");
		expect(String(warn.mock.calls[0][1].error)).not.toContain("topsecret");
	});

	it("redacts common token, api key, and authorization fragments", () => {
		expect(redactMCPStartupError("token=abc api_key=def Authorization=Bearer ghi")).not.toMatch(/abc|def|ghi/);
		expect(
			redactMCPStartupError('{"apiKey":"jsonsecret","token": "tokensecret"} --api-key sk-space --token cli-secret'),
		).not.toMatch(/jsonsecret|tokensecret|sk-space|cli-secret/);
	});
});
