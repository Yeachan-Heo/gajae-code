import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

function srcPath(...parts: string[]): string {
	return path.join(repoRoot, "packages", "coding-agent", "src", ...parts);
}

async function source(...parts: string[]): Promise<string> {
	return await Bun.file(srcPath(...parts)).text();
}

describe("GJC MCP public surface", () => {
	it("does not register MCP as a public internal URL protocol", async () => {
		const router = await source("internal-urls", "router.ts");
		const barrel = await source("internal-urls", "index.ts");
		expect(router).not.toContain("McpProtocolHandler");
		expect(router).not.toContain("mcp-protocol");
		expect(barrel).not.toContain("mcp-protocol");
	});

	it("discovers MCP tools for top-level agent sessions while keeping subagents isolated", async () => {
		const sdk = await source("sdk.ts");
		const taskExecutor = await source("task", "executor.ts");
		const taskIndex = await source("task", "index.ts");

		expect(sdk).toContain("discoverAndLoadMCPTools");
		expect(sdk).toContain("options.enableMCP !== false");
		expect(taskExecutor).not.toContain("createMCPProxyTools");
		expect(taskExecutor).not.toContain("runtime-mcp/client");
		expect(taskIndex).not.toContain("MCPManager.instance()");
	});

	it("keeps MCP resource URLs out of the public read prompt unless the manager is active", async () => {
		const readPrompt = await source("prompts", "tools", "read.md");
		const systemPrompt = await source("prompts", "system", "system-prompt.md");

		expect(readPrompt).not.toContain("mcp://");
		expect(systemPrompt).not.toContain("mcp://");
	});
});
