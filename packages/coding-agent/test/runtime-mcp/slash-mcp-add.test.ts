import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, getMCPConfigPath, setAgentDir } from "@gajae-code/utils";
import { readMCPConfigFile } from "../../src/runtime-mcp/config-writer";
import { handleMcpAcp } from "../../src/slash-commands/helpers/mcp";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

let tmpDir = "";
let agentDir = "";
let projectDir = "";

const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function runtime(): SlashCommandRuntime {
	return {
		cwd: projectDir,
		settings: { get: () => false },
		output: () => undefined,
		refreshCommands: () => undefined,
		reloadPlugins: async () => undefined,
	} as unknown as SlashCommandRuntime;
}

describe("ACP MCP add trust boundaries", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-acp-add-"));
		agentDir = path.join(tmpDir, "agent");
		projectDir = path.join(tmpDir, "project");
		await fs.mkdir(projectDir, { recursive: true });
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.GJC_CODING_AGENT_DIR;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("stores token-bearing quick add in user scope by default", async () => {
		await handleMcpAcp(
			{
				name: "mcp",
				args: "add remote --url https://example.test/mcp --token secret-token",
				text: "/mcp add remote --url https://example.test/mcp --token secret-token",
			},
			runtime(),
		);

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		const projectConfig = await readMCPConfigFile(getMCPConfigPath("project", projectDir));

		expect(userConfig.mcpServers?.remote).toEqual({
			type: "http",
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer secret-token" },
		});
		expect(projectConfig.mcpServers?.remote).toBeUndefined();
	});

	test("honors explicit project scope for token-bearing quick add", async () => {
		await handleMcpAcp(
			{
				name: "mcp",
				args: "add remote --scope project --url https://example.test/mcp --token secret-token",
				text: "/mcp add remote --scope project --url https://example.test/mcp --token secret-token",
			},
			runtime(),
		);

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		const projectConfig = await readMCPConfigFile(getMCPConfigPath("project", projectDir));

		expect(userConfig.mcpServers?.remote).toBeUndefined();
		expect(projectConfig.mcpServers?.remote).toEqual({
			type: "http",
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer secret-token" },
		});
	});
});
