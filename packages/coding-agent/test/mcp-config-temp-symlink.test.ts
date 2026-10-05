import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMCPConfigFile } from "../src/runtime-mcp/config-writer";

describe("writeMCPConfigFile", () => {
	it("writes a normal config", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "mcp-config-"));
		const configPath = path.join(dir, "mcp.json");
		await writeMCPConfigFile(configPath, { mcpServers: { local: { command: "echo" } } });
		const written = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: { local: { command: string } } };
		expect(written.mcpServers.local.command).toBe("echo");
	});

	it("does not follow a planted .tmp symlink", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "mcp-config-"));
		const secret = path.join(dir, "secret.txt");
		await writeFile(secret, "keep");
		const configPath = path.join(dir, "mcp.json");
		await symlink(secret, `${configPath}.tmp`);
		await writeMCPConfigFile(configPath, { mcpServers: {} });
		expect(await readFile(secret, "utf8")).toBe("keep");
		const written = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
		expect(written.mcpServers).toEqual({});
	});
});
