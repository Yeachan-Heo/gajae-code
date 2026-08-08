import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { loadAllMCPConfigs } from "./config";

test("config loading rejects remote endpoint userinfo with the typed C5 error", async () => {
	const configPath = `${process.cwd()}/.mcp-config-load-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	await Bun.write(
		configPath,
		JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://user:secret@example.test/mcp" } } }),
	);
	try {
		await expect(loadAllMCPConfigs(process.cwd(), { configPath })).rejects.toMatchObject({
			name: "MCPPoolConfigError",
			code: "MCP_USERINFO_NOT_ALLOWED",
		});
	} finally {
		await rm(configPath, { force: true });
	}
});
