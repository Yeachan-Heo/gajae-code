import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

function srcPath(...parts: string[]): string {
	return path.join(repoRoot, "packages", "coding-agent", "src", ...parts);
}

async function source(...parts: string[]): Promise<string> {
	return await Bun.file(srcPath(...parts)).text();
}

describe("GJC MCP quarantine surface", () => {
	it("does not register MCP as a public internal URL protocol", async () => {
		const router = await source("internal-urls", "router.ts");
		const barrel = await source("internal-urls", "index.ts");
		expect(router).not.toContain("McpProtocolHandler");
		expect(router).not.toContain("mcp-protocol");
		expect(barrel).not.toContain("mcp-protocol");
	});

	it("preserves default MCP quarantine without blocking exact SDK opt-in", async () => {
		const sdk = await source("sdk", "session.ts");
		const taskExecutor = await source("task", "executor.ts");
		const taskIndex = await source("task", "index.ts");

		expect(sdk).toContain("mcpConfigPath?: string");
		expect(sdk).toContain("discoverAndConnect({ configPath: explicitMcpConfigPath })");
		expect(sdk).not.toContain("StandaloneMcpStartupStatus");
		expect(sdk).not.toContain("mcpStartupStatus");
		expect(sdk).not.toContain("mcp-warning.json");
		expect(sdk).not.toContain("discoverAndLoadMCPTools");
		expect(sdk).not.toContain("discoverMCPServers");
		expect(taskExecutor).not.toContain("createMCPProxyTools");
		expect(taskExecutor).not.toContain("runtime-mcp/client");
		expect(taskIndex).not.toContain("MCPManager.instance()");
	});

	it("hides MCP configuration and read-tool resource hints from the public UI", async () => {
		const settingsSchema = await source("config", "settings-schema.ts");
		const readPrompt = await source("prompts", "tools", "read.md");
		const systemPrompt = await source("prompts", "system", "system-prompt.md");
		const interactiveMode = await source("modes", "interactive-mode.ts");

		expect(settingsSchema).not.toContain("MCP Project Config");
		expect(settingsSchema).not.toContain("MCP Tool Discovery");
		expect(settingsSchema).not.toContain('"mcp-only"');
		expect(readPrompt).not.toContain("mcp://");
		expect(systemPrompt).not.toContain("mcp://");
		expect(interactiveMode).not.toContain("MCPCommandController");
	});

	it("keeps public MCP guidance aligned with the slash-command quarantine", async () => {
		const schema = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "config", "mcp-schema.json"),
		).text();
		const standaloneMcp = await Bun.file(path.join(repoRoot, "docs", "standalone-mcp.md")).text();
		const normalizedStandaloneMcp = standaloneMcp.replace(/\s+/g, " ");

		expect(schema).not.toContain("for example /mcp reauth");
		expect(schema).toContain("no public MCP OAuth authorization or reauthorization entry path is provided");
		expect(normalizedStandaloneMcp).toContain("do not register a top-level `/mcp` command");
		expect(normalizedStandaloneMcp).toContain("they do not initiate MCP OAuth authorization");
		expect(normalizedStandaloneMcp).toContain(
			"there is no public MCP OAuth authorization or reauthorization entry path",
		);
		expect(normalizedStandaloneMcp).toContain("nor a public `/mcp` reconnection or reload contract");
		expect(normalizedStandaloneMcp).not.toContain("except `/mcp reload`");
	});
});
