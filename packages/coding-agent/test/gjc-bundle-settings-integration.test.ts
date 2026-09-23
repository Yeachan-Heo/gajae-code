import { beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { logger } from "@gajae-code/utils";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import { installGjcBundle } from "../src/extensibility/gjc-plugins";
import { bundleIdentity } from "../src/extensibility/gjc-plugins/lifecycle-reconciliation";
import { GjcRuntimeSnapshotStore } from "../src/extensibility/gjc-plugins/runtime-quarantine";
import { SettingsSelectorComponent } from "../src/modes/components/settings-selector";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import { type MCPLoadResult, MCPManager } from "../src/runtime-mcp";
import { createAgentSession } from "../src/sdk/session";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const sixSurfaceBundle = path.join(import.meta.dir, "fixtures", "gjc-plugins", "valid-six-surface-bundle");

/**
 * The source-text wiring test proves the production chain is connected, but it
 * cannot prove the connection carries data: a semantically broken rewiring that
 * kept the same identifiers would still pass it.
 *
 * This drives the REAL `SettingsSelectorComponent` with a real
 * `GjcRuntimeSnapshotStore`, switches to the GJC Bundles tab exactly as the
 * production controller does, and asserts the component actually received the
 * provider and generation rather than silently defaulting to unavailable.
 */

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load test theme");
	setThemeInstance(theme);
});

function baseContext(cwd: string): {
	availableThinkingLevels: [];
	thinkingLevel: undefined;
	availableThemes: string[];
	availableModelProfiles: string[];
	cwd: string;
} {
	return {
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: ["red-claw"],
		availableModelProfiles: [],
		cwd,
	};
}

describe("GJC Bundles settings integration through the production selector", () => {
	test("the published provider and generation reach the tab component", () => {
		const store = new GjcRuntimeSnapshotStore();
		const epoch = store.beginPass();
		store.publish(
			{
				generation: 7,
				findings: [
					{
						identity: bundleIdentity("project", "seeded-bundle"),
						surfaceId: "tool:seeded",
						code: "runtime_mismatch",
						message: "drifted",
					},
				],
			},
			epoch,
		);

		const selector = new SettingsSelectorComponent(
			{ ...baseContext("/tmp/does-not-need-to-exist"), gjcRuntimeSnapshot: store, gjcActivationGeneration: 7 },
			{ onCancel: () => {}, onChange: () => {} },
		);

		// Switch tabs the way the production tab bar does.
		selector.handleInput("\u001b[C");
		selector.handleInput("\u001b[C");

		// Prove the tab is actually reached, otherwise this test would pass
		// vacuously while never constructing the GJC component at all.
		const frame = selector.render(80).join("\n");
		expect(frame).toContain("GJC Bundles");

		// The store the component holds must be the very one the session published,
		// carrying the published generation — not a default-constructed empty one.
		expect(store.current()).toMatchObject({ status: "current", snapshot: { generation: 7 } });

		// Rendering with a real provider bound must not leak finding internals.
		expect(frame).not.toContain("runtime_mismatch");
		expect(frame).not.toContain("/tmp/does-not-need-to-exist");
	});

	test.skipIf(process.platform !== "linux")(
		"publishes a bundle-owned plugin MCP error alongside a conventional failure without false tools",
		async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-runtime-finding-"));
			const hiddenCauseTail = "CAUSE_TAIL_NOT_DISPLAYED";
			const primarySecret = "primary-secret-value";
			const cause = `connection refused \u001b[31munsafe\u001b[0m\t detail\ncontinued ${"cause ".repeat(30)}api_key=${primarySecret} ${hiddenCauseTail}`;
			const failedTool = {
				name: "mcp__domain_docs_false_success",
				label: "domain_docs/false_success",
				description: "A tool returned alongside a failed connection.",
				mcpServerName: "domain_docs",
				mcpToolName: "false_success",
				parameters: z.object({}),
				async execute() {
					return { content: [{ type: "text" as const, text: "must not be registered" }] };
				},
			} as unknown as MCPLoadResult["tools"][number];
			let session: AgentSession | undefined;
			let selector: SettingsSelectorComponent | undefined;
			let restoreConnectServers: (() => void) | undefined;
			let restorePluginErrorLog: (() => void) | undefined;
			let restoreConventionalWarningLog: (() => void) | undefined;
			try {
				const installed = await installGjcBundle({ cwd }, "project", sixSurfaceBundle);
				expect(installed.ok).toBe(true);
				const connectServers = vi.spyOn(MCPManager.prototype, "connectServers").mockResolvedValue({
					tools: [failedTool],
					errors: new Map([
						["domain_docs", cause],
						["conventional_docs", "conventional MCP server failed"],
					]),
					connectedServers: [],
					exaApiKeys: [],
				});
				restoreConnectServers = () => connectServers.mockRestore();
				const pluginErrorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
				restorePluginErrorLog = () => pluginErrorLog.mockRestore();
				const conventionalWarningLog = vi.spyOn(logger, "warn").mockImplementation(() => {});
				restoreConventionalWarningLog = () => conventionalWarningLog.mockRestore();
				const created = await createAgentSession({
					cwd,
					agentDir: cwd,
					sessionManager: SessionManager.inMemory(cwd),
					settings: Settings.isolated(),
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					extensions: [],
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				session = created.session;
				expect(connectServers).toHaveBeenCalledTimes(1);
				expect(pluginErrorLog).toHaveBeenCalledWith(
					"GJC plugin MCP connection failed",
					expect.objectContaining({ path: "mcp:domain_docs" }),
				);
				expect(JSON.stringify(pluginErrorLog.mock.calls)).not.toContain(primarySecret);
				expect(conventionalWarningLog).toHaveBeenCalledWith(
					"MCP server connection failed",
					expect.objectContaining({ path: "mcp:conventional_docs" }),
				);
				expect(created.mcpManager).toBeUndefined();

				const runtimeSnapshot = created.gjcRuntimeSnapshot;
				if (!runtimeSnapshot) throw new Error("Expected a GJC runtime snapshot provider");
				const runtime = runtimeSnapshot.current();
				expect(runtime.status).toBe("current");
				if (runtime.status !== "current") throw new Error("Expected a published GJC runtime snapshot");
				const finding = runtime.snapshot.findings.find(
					item => item.surfaceId === "mcp:domain_docs" && item.identity.name === "valid-six-surface-bundle",
				);
				expect(finding).toMatchObject({
					identity: { kind: "gjc-bundle", scope: "project", name: "valid-six-surface-bundle" },
					surfaceId: "mcp:domain_docs",
					code: "runtime_mismatch",
					decision: "error",
					provenance: { source: "plugin-bundle", plugin: "valid-six-surface-bundle", scope: "project" },
				});
				expect(finding?.message).toContain("connection refused");
				expect(finding?.message).toContain(hiddenCauseTail);
				expect(finding?.message).toContain("api_key=«redacted»");
				expect(finding?.message).not.toContain(primarySecret);
				expect(finding?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
				expect(finding?.message).not.toContain("unsafe\t detail");

				const falseSuccessName = "mcp__domain_docs_false_success";
				expect(session.getAllToolNames()).not.toContain(falseSuccessName);
				expect(session.getActiveToolNames()).not.toContain(falseSuccessName);
				expect(session.getSelectedMCPToolNames()).not.toContain(falseSuccessName);
				expect(session.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).not.toContain(
					falseSuccessName,
				);

				selector = new SettingsSelectorComponent(
					{
						...baseContext(cwd),
						gjcRuntimeSnapshot: runtimeSnapshot,
						gjcActivationGeneration: created.session.gjcActivationGeneration,
					},
					{ onCancel: () => {}, onChange: () => {} },
				);
				for (let tabIndex = 0; tabIndex < 11; tabIndex++) selector.handleInput("\u001b[C");
				let frame = "";
				for (let attempt = 0; attempt < 100; attempt++) {
					frame = selector.render(120).join("\n");
					if (frame.includes("valid-six-surface-bundle")) break;
					await Bun.sleep(5);
				}
				expect(frame).toContain("GJC Bundles");
				expect(frame).toContain("valid-six-surface-bundle");
				selector.handleInput("\n");
				frame = Bun.stripANSI(selector.render(120).join("\n"));
				expect(frame).toContain("Runtime error");
				expect(frame).toContain("connection refused");
				expect(frame).not.toContain(primarySecret);
				expect(frame).not.toContain(hiddenCauseTail);
				expect(frame).not.toContain("unsafe\t detail");
			} finally {
				selector?.dispose();
				await session?.dispose();
				restoreConnectServers?.();
				restorePluginErrorLog?.();
				restoreConventionalWarningLog?.();
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test.skipIf(process.platform !== "linux")(
		"retains the startup finding and successful tools when cleanup of an unsettled plugin fails",
		async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-runtime-cleanup-failure-"));
			let session: AgentSession | undefined;
			let restoreConnectServers: (() => void) | undefined;
			let restoreConnectionStatus: (() => void) | undefined;
			let restoreDisconnectServer: (() => void) | undefined;
			let restorePluginErrorLog: (() => void) | undefined;
			try {
				const installed = await installGjcBundle({ cwd }, "project", sixSurfaceBundle);
				expect(installed.ok).toBe(true);
				const failedTool = {
					name: "mcp__domain_docs_unsettled",
					label: "domain_docs/unsettled",
					description: "An unsettled plugin server tool.",
					mcpServerName: "domain_docs",
					mcpToolName: "unsettled",
					parameters: z.object({}),
					async execute() {
						return { content: [{ type: "text" as const, text: "must not be registered" }] };
					},
				} as unknown as MCPLoadResult["tools"][number];
				const successfulTool = {
					name: "mcp__conventional_docs_ready",
					label: "conventional_docs/ready",
					description: "A successful tool from another server.",
					mcpServerName: "conventional_docs",
					mcpToolName: "ready",
					parameters: z.object({}),
					async execute() {
						return { content: [{ type: "text" as const, text: "ready" }] };
					},
				} as unknown as MCPLoadResult["tools"][number];
				const connectServers = vi.spyOn(MCPManager.prototype, "connectServers").mockResolvedValue({
					tools: [failedTool, successfulTool],
					errors: new Map(),
					connectedServers: ["conventional_docs"],
					exaApiKeys: [],
				});
				restoreConnectServers = () => connectServers.mockRestore();
				const connectionStatus = vi
					.spyOn(MCPManager.prototype, "getConnectionStatus")
					.mockImplementation(name => (name === "domain_docs" ? "connecting" : "disconnected"));
				restoreConnectionStatus = () => connectionStatus.mockRestore();
				const cleanupSecret = "cleanup-secret-value";
				const cleanupError = new Error(`synthetic plugin MCP cleanup failure api_key=${cleanupSecret}\u001b[31m`);
				const disconnectServer = vi.spyOn(MCPManager.prototype, "disconnectServer").mockRejectedValue(cleanupError);
				restoreDisconnectServer = () => disconnectServer.mockRestore();
				const pluginErrorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
				restorePluginErrorLog = () => pluginErrorLog.mockRestore();

				const created = await createAgentSession({
					cwd,
					agentDir: cwd,
					sessionManager: SessionManager.inMemory(cwd),
					settings: Settings.isolated(),
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					extensions: [],
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				session = created.session;
				expect(disconnectServer).toHaveBeenCalledWith("domain_docs");
				expect(pluginErrorLog).toHaveBeenCalledWith(
					"GJC plugin MCP startup did not settle",
					expect.objectContaining({
						path: "mcp:domain_docs",
						cleanupDiagnostic: expect.stringContaining("api_key=«redacted»"),
					}),
				);
				expect(JSON.stringify(pluginErrorLog.mock.calls)).not.toContain(cleanupSecret);
				expect(created.mcpManager).toBeDefined();
				const runtimeSnapshot = created.gjcRuntimeSnapshot;
				if (!runtimeSnapshot) throw new Error("Expected a GJC runtime snapshot provider");
				const runtime = runtimeSnapshot.current();
				expect(runtime.status).toBe("current");
				if (runtime.status !== "current") throw new Error("Expected a published GJC runtime snapshot");
				const finding = runtime.snapshot.findings.find(item => item.surfaceId === "mcp:domain_docs");
				expect(finding?.message).toContain("synthetic plugin MCP cleanup failure");
				expect(finding?.message).toContain("api_key=«redacted»");
				expect(finding?.message).not.toContain(cleanupSecret);
				expect(finding?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
				expect(session.getAllToolNames()).not.toContain(failedTool.name);
				expect(session.getAllToolNames()).toContain(successfulTool.name);
			} finally {
				await session?.dispose();
				restoreConnectServers?.();
				restoreConnectionStatus?.();
				restoreDisconnectServer?.();
				restorePluginErrorLog?.();
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test.skipIf(process.platform !== "linux")(
		"retries owned MCP cleanup after a startup failure without dropping manager ownership",
		async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-runtime-cleanup-retry-"));
			let restoreConnectServers: (() => void) | undefined;
			let restoreDisconnectAll: (() => void) | undefined;
			try {
				const installed = await installGjcBundle({ cwd }, "project", sixSurfaceBundle);
				expect(installed.ok).toBe(true);
				const startupError = new Error("synthetic plugin MCP startup failure");
				const connectServers = vi.spyOn(MCPManager.prototype, "connectServers").mockRejectedValue(startupError);
				restoreConnectServers = () => connectServers.mockRestore();
				let cleanupAttempts = 0;
				const disconnectAll = vi.spyOn(MCPManager.prototype, "disconnectAll").mockImplementation(async () => {
					cleanupAttempts++;
					if (cleanupAttempts === 1) throw new Error("synthetic first cleanup failure");
				});
				restoreDisconnectAll = () => disconnectAll.mockRestore();

				await expect(
					createAgentSession({
						cwd,
						agentDir: cwd,
						sessionManager: SessionManager.inMemory(cwd),
						settings: Settings.isolated(),
						model: getBundledModel("openai", "gpt-4o-mini"),
						disableExtensionDiscovery: true,
						extensions: [],
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMCP: false,
						enableLsp: false,
					}),
				).rejects.toThrow("synthetic plugin MCP startup failure");
				expect(cleanupAttempts).toBe(2);
			} finally {
				restoreConnectServers?.();
				restoreDisconnectAll?.();
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test("a missing provider degrades honestly instead of crashing", () => {
		const selector = new SettingsSelectorComponent(baseContext("/tmp/does-not-need-to-exist"), {
			onCancel: () => {},
			onChange: () => {},
		});
		selector.handleInput("\u001b[C");
		selector.handleInput("\u001b[C");
		const frame = selector.render(80).join("\n");
		expect(frame).toContain("GJC Bundles");
	});
});
