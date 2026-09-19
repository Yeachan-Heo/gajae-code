import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import { MCPManager } from "../../src/runtime-mcp/manager";

const IMMEDIATE_MCP_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'autoload-fixture', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ready', inputSchema: { type: 'object' } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("waitFor timed out");
}

async function writeNativeProjectConfig(projectDir: string, mcpServers: Record<string, unknown>): Promise<void> {
	const configDir = path.join(projectDir, ".gjc");
	await fs.mkdir(configDir, { recursive: true });
	await fs.writeFile(path.join(configDir, "mcp.json"), JSON.stringify({ mcpServers }));
}

describe("MCP autoload issue #5702", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
		);
	});

	it("loads every eligible registration when the batch exceeds the old startup threshold", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-5702-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-5702-agent-"));
		temporaryDirectories.push(projectDir, agentDir);

		const mcpServers = Object.fromEntries(
			Array.from({ length: 24 }, (_, index) => [
				`autoload-${index}`,
				{ type: "stdio", command: process.execPath, args: ["-e", IMMEDIATE_MCP_SERVER] },
			]),
		);
		await writeNativeProjectConfig(projectDir, mcpServers);

		const loaded = await loadAllMCPConfigs(projectDir, {
			agentDir,
			filterExa: false,
			nativeOnly: true,
			autoloadOnly: true,
		});
		expect(Object.keys(loaded.configs)).toHaveLength(24);

		const manager = new MCPManager(projectDir);
		try {
			const result = await manager.connectServers(loaded.configs, loaded.sources);
			expect(result.errors).toEqual(new Map());
			await waitFor(() => manager.getConnectedServers().length === 24);
			await waitFor(() => manager.getTools().length === 24);
			expect(manager.getConnectedServers().sort()).toEqual(Object.keys(mcpServers).sort());
			expect(manager.getTools()).toHaveLength(24);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("logs the server and reason when autoload intentionally skips a registration", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-5702-skip-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-5702-skip-agent-"));
		temporaryDirectories.push(projectDir, agentDir);
		await writeNativeProjectConfig(projectDir, {
			kept: { type: "stdio", command: process.execPath, args: ["-e", IMMEDIATE_MCP_SERVER] },
			skipped: { type: "stdio", command: process.execPath, args: ["-e", IMMEDIATE_MCP_SERVER], autoload: false },
		});

		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const loaded = await loadAllMCPConfigs(projectDir, {
				agentDir,
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});

			expect(Object.keys(loaded.configs)).toEqual(["kept"]);
			expect(
				warn.mock.calls.some(
					([message, metadata]) =>
						message === "Skipping MCP autoload registration" &&
						metadata?.serverName === "skipped" &&
						String(metadata.reason).includes("autoload"),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});
