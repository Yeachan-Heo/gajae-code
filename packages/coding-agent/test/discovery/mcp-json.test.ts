import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@gajae-code/coding-agent/discovery";
import { type MCPServer, mcpCapability } from "../../src/capability/mcp";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

async function loadNativeMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["native"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("standalone mcp.json project env trust boundary", () => {
	let tempDir = "";
	const originalEnv = {
		PI_OAUTH_TOKEN_URL: process.env.PI_OAUTH_TOKEN_URL,
		PI_OAUTH_CLIENT_ID: process.env.PI_OAUTH_CLIENT_ID,
		PI_OAUTH_CLIENT_SECRET: process.env.PI_OAUTH_CLIENT_SECRET,
		PI_OAUTH_REDIRECT_URI: process.env.PI_OAUTH_REDIRECT_URI,
		PI_OAUTH_CALLBACK_PATH: process.env.PI_OAUTH_CALLBACK_PATH,
		PI_MCP_HEADER: process.env.PI_MCP_HEADER,
		PI_MCP_URL: process.env.PI_MCP_URL,
		PI_MCP_ENV: process.env.PI_MCP_ENV,
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-json-"));
		process.env.PI_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.PI_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.PI_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.PI_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.PI_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.PI_MCP_HEADER = "Bearer test-token";
		process.env.PI_MCP_URL = "https://mcp.example.com";
		process.env.PI_MCP_ENV = "env-value";
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("preserves project auth and oauth env placeholders literally", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						url: `${envPlaceholder("PI_MCP_URL")}/mcp`,
						headers: { Authorization: envPlaceholder("PI_MCP_HEADER") },
						env: { MCP_VALUE: envPlaceholder("PI_MCP_ENV") },
						auth: {
							type: "oauth",
							tokenUrl: envPlaceholder("PI_OAUTH_TOKEN_URL"),
							clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
						},
						oauth: {
							clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
							redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
							callbackPort: 4317,
							callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.url).toBe(`${envPlaceholder("PI_MCP_URL")}/mcp`);
		expect(server?.headers).toEqual({ Authorization: envPlaceholder("PI_MCP_HEADER") });
		expect(server?.env).toEqual({ MCP_VALUE: envPlaceholder("PI_MCP_ENV") });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: envPlaceholder("PI_OAUTH_TOKEN_URL"),
			clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
			clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
		});
		expect(server?.oauth).toEqual({
			clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
			clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
			redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
			callbackPort: 4317,
			callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
		});
	});

	test("preserves partial project oauth env placeholders literally", async () => {
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						url: "https://slack.example.com/mcp",
						oauth: {
							redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
							callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
			callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
		});
		expect(server?.auth).toBeUndefined();
	});
});

describe("native .gjc project env trust boundary", () => {
	let tempDir = "";
	const originalEnv = {
		PI_MCP_HEADER: process.env.PI_MCP_HEADER,
		PI_MCP_COMMAND: process.env.PI_MCP_COMMAND,
		PI_MCP_ENV: process.env.PI_MCP_ENV,
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-mcp-"));
		process.env.PI_MCP_HEADER = "Bearer native-secret";
		process.env.PI_MCP_COMMAND = "native-secret-command";
		process.env.PI_MCP_ENV = "native-env-value";
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("preserves project placeholders loaded from .gjc/mcp.json literally", async () => {
		await fs.mkdir(path.join(tempDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(tempDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					native: {
						command: envPlaceholder("PI_MCP_COMMAND"),
						args: [envPlaceholder("PI_MCP_ENV")],
						env: { MCP_VALUE: envPlaceholder("PI_MCP_ENV") },
						headers: { Authorization: envPlaceholder("PI_MCP_HEADER") },
					},
				},
			}),
		);

		const [server] = await loadNativeMcpConfig(tempDir);

		expect(server).toBeDefined();
		expect(server?.command).toBe(envPlaceholder("PI_MCP_COMMAND"));
		expect(server?.args).toEqual([envPlaceholder("PI_MCP_ENV")]);
		expect(server?.env).toEqual({ MCP_VALUE: envPlaceholder("PI_MCP_ENV") });
		expect(server?.headers).toEqual({ Authorization: envPlaceholder("PI_MCP_HEADER") });
	});
});
