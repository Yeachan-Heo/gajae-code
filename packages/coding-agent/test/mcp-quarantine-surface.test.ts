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

	it("keeps MCP runtime discovery opt-in and quarantined from subagent sessions", async () => {
		const sdk = await source("sdk.ts");
		const taskExecutor = await source("task", "executor.ts");
		const taskIndex = await source("task", "index.ts");

		// User/project MCP discovery is allowed for top-level sessions but must
		// stay gated behind the explicit enableMCP option (the CLI surface opts
		// in; embedders, ACP, and subagents stay off by default).
		expect(sdk).toContain("options.enableMCP ?? false");
		expect(sdk).not.toContain("discoverMCPServers");
		// Subagents inherit the parent's manager and never proxy or discover.
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
});
