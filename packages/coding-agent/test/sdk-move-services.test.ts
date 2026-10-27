import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { setProjectDir } from "@gajae-code/utils";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";
import { shutdownAll } from "../src/lsp/client";

const fixture = path.join(import.meta.dir, "fixtures", "session-move-service-server.ts");
type LiveSession = AgentSession;
const tempRoots: string[] = [];
const lspConfigRoots: string[] = [];
const lspCleanupGrants: Array<() => void> = [];
const originalCwd = process.cwd();
const originalConfigDir = process.env.GJC_CONFIG_DIR;

afterEach(async () => {
	await shutdownAll();
	if (process.cwd() !== originalCwd) setProjectDir(originalCwd);
	if (originalConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
	else process.env.GJC_CONFIG_DIR = originalConfigDir;
	try {
		for (const root of [...lspConfigRoots.splice(0), ...tempRoots.splice(0)]) {
			await fs.rm(root, { recursive: true, force: true });
		}
	} finally {
		for (const forgetGrant of lspCleanupGrants.splice(0)) forgetGrant();
	}
});

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-move-services-"));
	tempRoots.push(root);
	return root;
}

async function configureTrustedLsp(): Promise<void> {
	const configName = `.gjc-sdk-move-services-${process.pid}-${randomUUID()}`;
	const configRoot = path.join(os.homedir(), configName);
	lspConfigRoots.push(configRoot);
	lspCleanupGrants.push(registerOwnedDeletionRoot(configRoot));
	process.env.GJC_CONFIG_DIR = configName;
	const agentConfig = path.join(configRoot, "agent");
	await fs.mkdir(agentConfig, { recursive: true });
	await Bun.write(
		path.join(agentConfig, "lsp.json"),
		JSON.stringify({
			servers: {
				move_service_fixture: {
					command: process.execPath,
					args: [fixture, "lsp"],
					fileTypes: [".move"],
					rootMarkers: [".move-root"],
					warmupTimeoutMs: 5_000,
				},
			},
		}),
	);
}

async function makeWorkspace(root: string, marker: string, mcp = false): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await Bun.write(path.join(root, ".move-root"), "fixture workspace\n");
	await Bun.write(path.join(root, "workspace.txt"), `${marker}\n`);
	await Bun.write(path.join(root, "probe.move"), "probe_symbol\n");
	await Bun.write(path.join(root, "definition.move"), `${marker}_DEFINITION_MARKER\n`);
	if (!mcp) return;
	await Bun.write(
		path.join(root, ".gjc", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				workspace_probe: {
					type: "stdio",
					command: process.execPath,
					args: [fixture, "mcp"],
					enabled: true,
					autoload: true,
				},
			},
		}),
	);
}

async function makeSession(
	cwd: string,
	agentDir: string,
): Promise<{
	session: LiveSession;
	sessionManager: SessionManager;
}> {
	await fs.mkdir(agentDir, { recursive: true });
	const settings = Settings.isolated({
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
		"lsp.enabled": true,
		"mcp.enableProjectConfig": true,
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager,
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMcpAutoload: true,
		enableLsp: true,
		skipPythonPreflight: true,
		toolNames: ["lsp", "move_session"],
	});
	return { session, sessionManager };
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
			)
			.map(item => item.text)
			.join("\n") ?? ""
	);
}

async function callTool(session: LiveSession, name: string, input: Record<string, unknown>) {
	const tool = session.getToolByName(name);
	if (!tool) throw new Error(`Session tool is unavailable: ${name}`);
	return tool.execute(`sdk-move-${name}`, input as never);
}

async function expectWorkspaceServices(session: LiveSession, root: string, marker: string): Promise<void> {
	const probe = await callTool(session, "mcp__workspace_probe_root_probe", {});
	const probeText = textOf(probe);
	expect(probeText).toContain(`"cwd":"${root}"`);
	expect(probeText).toContain(`"marker":"${marker}"`);
	expect(probeText).toContain(pathToFileURL(root).href);

	const diagnostics = await callTool(session, "lsp", {
		action: "diagnostics",
		file: path.join(root, "probe.move"),
	});
	expect(textOf(diagnostics)).toContain(`fixture workspace ${root}`);

	const definition = await callTool(session, "lsp", {
		action: "definition",
		file: path.join(root, "probe.move"),
		line: 1,
		symbol: "probe_symbol",
	});
	expect(textOf(definition)).toContain(`${marker}_DEFINITION_MARKER`);
}

describe("SDK session moves with real MCP and LSP child processes", () => {
	it("rebinds stdio MCP roots and LSP file services after a guarded descendant move", async () => {
		const tempRoot = await makeTempRoot();
		const rootA = path.join(tempRoot, "root-a");
		const rootB = path.join(rootA, "child-b");
		await makeWorkspace(rootA, "A_WORKSPACE", true);
		await makeWorkspace(rootB, "B_WORKSPACE", true);
		await configureTrustedLsp();
		const { session, sessionManager } = await makeSession(rootA, path.join(tempRoot, "agent"));
		try {
			await expectWorkspaceServices(session, rootA, "A_WORKSPACE");

			await expect(callTool(session, "move_session", { path: ".." })).rejects.toThrow(/only narrows/);
			expect(sessionManager.getCwd()).toBe(rootA);
			await expectWorkspaceServices(session, rootA, "A_WORKSPACE");

			const moved = await callTool(session, "move_session", { path: "child-b" });
			expect(textOf(moved)).toContain(rootB);
			expect(sessionManager.getCwd()).toBe(rootB);
			await expectWorkspaceServices(session, rootB, "B_WORKSPACE");

			await expect(callTool(session, "move_session", { path: ".." })).rejects.toThrow(/already been rescoped/);
			expect(sessionManager.getCwd()).toBe(rootB);
			await expectWorkspaceServices(session, rootB, "B_WORKSPACE");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("keeps SessionManager.moveTo as a direct cwd move while LSP reads its live cwd", async () => {
		const tempRoot = await makeTempRoot();
		const rootA = path.join(tempRoot, "root-a");
		const rootB = path.join(rootA, "child-b");
		await makeWorkspace(rootA, "MANAGER_A");
		await makeWorkspace(rootB, "MANAGER_B");
		await configureTrustedLsp();
		const { session, sessionManager } = await makeSession(rootA, path.join(tempRoot, "agent"));
		const processCwd = process.cwd();
		try {
			const before = await callTool(session, "lsp", {
				action: "diagnostics",
				file: path.join(rootA, "probe.move"),
			});
			expect(textOf(before)).toContain(`fixture workspace ${rootA}`);

			// The manager API accepts an explicit directory and does not apply move_session's
			// descendant authorization or process-cwd transition; LSP resolves the live manager cwd.
			await sessionManager.moveTo(rootB);
			expect(sessionManager.getCwd()).toBe(rootB);
			expect(process.cwd()).toBe(processCwd);
			const after = await callTool(session, "lsp", {
				action: "diagnostics",
				file: path.join(rootB, "probe.move"),
			});
			expect(textOf(after)).toContain(`fixture workspace ${rootB}`);
		} finally {
			await session.dispose();
		}
	}, 30_000);
});
