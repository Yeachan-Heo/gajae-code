/**
 * Project `.gjc/mcp.json` stdio must not spawn without a user opt-in, and a
 * project settings file cannot override that opt-out. A user mcp.json server
 * still spawns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../../scripts/safe-cleanup";
import { MCPManager } from "../../src/runtime-mcp";

const originalAgentDir = getAgentDir();

function serverScript(marker: string): string {
	return `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(marker)}, '1');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hello', description: 'Demo', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
}

describe("project MCP stdio approval", () => {
	let root: string;
	let projectDir: string;
	let agentDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		MCPManager.resetForTests();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-stdio-approval-"));
		projectDir = path.join(root, "project");
		agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(root);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		await safeRm(root, { recursive: true, force: true });
	});

	function sessionOptions(settings: Settings) {
		return {
			cwd: projectDir,
			agentDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			toolNames: ["read"],
		};
	}

	async function writeProjectStdio(name: string, marker: string): Promise<void> {
		await fs.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					[name]: { type: "stdio", command: process.execPath, args: ["-e", serverScript(marker)], timeout: 5000 },
				},
			}),
		);
	}

	it("does not spawn a project stdio server when the user has not approved it", async () => {
		const marker = path.join(root, "unapproved");
		await writeProjectStdio("project", marker);
		const { session, mcpManager } = await createAgentSession(sessionOptions(Settings.isolated({})));
		try {
			expect(mcpManager?.getConnectedServers() ?? []).not.toContain("project");
			expect(await Bun.file(marker).exists()).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("does not let project settings override a user opt-out", async () => {
		const marker = path.join(root, "override");
		await writeProjectStdio("project", marker);
		await fs.writeFile(path.join(agentDir, "config.yml"), "mcp:\n  enableProjectConfig: false\n");
		await fs.writeFile(
			path.join(projectDir, ".gjc", "settings.json"),
			JSON.stringify({ mcp: { enableProjectConfig: true } }),
		);
		const settings = await Settings.loadReadonly({ cwd: projectDir, agentDir });
		expect(settings.get("mcp.enableProjectConfig")).toBe(true);
		expect(settings.getGlobal("mcp.enableProjectConfig")).toBe(false);

		const { session, mcpManager } = await createAgentSession(sessionOptions(settings));
		try {
			expect(mcpManager?.getConnectedServers() ?? []).not.toContain("project");
			expect(await Bun.file(marker).exists()).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("still spawns a user mcp.json stdio server without project approval", async () => {
		const marker = path.join(root, "user");
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					user: { type: "stdio", command: process.execPath, args: ["-e", serverScript(marker)], timeout: 5000 },
				},
			}),
		);
		const { session, mcpManager } = await createAgentSession(sessionOptions(Settings.isolated({})));
		try {
			expect(mcpManager?.getConnectedServers()).toContain("user");
			expect(await Bun.file(marker).exists()).toBe(true);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("still spawns a project stdio server when the user config opts in", async () => {
		const marker = path.join(root, "approved");
		await writeProjectStdio("project", marker);
		const { session, mcpManager } = await createAgentSession(
			sessionOptions(Settings.isolated({ "mcp.enableProjectConfig": true })),
		);
		try {
			expect(mcpManager?.getConnectedServers()).toContain("project");
			expect(await Bun.file(marker).exists()).toBe(true);
		} finally {
			await session.dispose();
		}
	}, 30_000);
});
