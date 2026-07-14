import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@gajae-code/coding-agent/discovery";
import { type MCPServer, mcpCapability } from "../../src/capability/mcp";
import { loadMCPJsonFile } from "../../src/discovery/mcp-json";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}
function isSymlinkUnavailable(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
		return false;
	}
	return ["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(error.code);
}

async function canCreateFileSymlink(): Promise<boolean> {
	const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-symlink-probe-"));
	const targetPath = path.join(probeDir, "target.json");
	const symlinkPath = path.join(probeDir, "link.json");
	try {
		await fs.writeFile(targetPath, "{}");
		await fs.symlink(targetPath, symlinkPath, "file");
		return true;
	} catch (error) {
		if (isSymlinkUnavailable(error)) return false;
		throw error;
	} finally {
		await fs.rm(probeDir, { recursive: true, force: true });
	}
}
async function canCreateDirectoryLink(): Promise<boolean> {
	const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-directory-link-probe-"));
	const targetPath = path.join(probeDir, "target");
	const linkPath = path.join(probeDir, "link");
	try {
		await fs.mkdir(targetPath);
		await fs.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch (error) {
		if (isSymlinkUnavailable(error)) return false;
		throw error;
	} finally {
		await fs.rm(probeDir, { recursive: true, force: true });
	}
}

const exactConfigFileTest = test.skipIf(!(await canCreateFileSymlink()));
const exactConfigDirectoryTest = test.skipIf(!(await canCreateDirectoryLink()));

function exactConfigText(name: string): string {
	return JSON.stringify({
		mcpServers: {
			[name]: {
				type: "stdio",
				command: "exact-mcp",
			},
		},
	});
}

interface Utf8FileReader {
	readFile(options: { encoding: "utf8" }): Promise<string>;
}

function interceptNextExactConfigRead(afterRead: () => Promise<void>): void {
	const openFile = fs.open;
	vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
		const handle = await openFile(file, flags, mode);
		const reader = handle as unknown as Utf8FileReader;
		const readFile = reader.readFile.bind(reader);
		vi.spyOn(reader, "readFile").mockImplementationOnce(async options => {
			const content = await readFile(options);
			await afterRead();
			return content;
		});
		return handle;
	});
}

describe("standalone mcp.json oauth env expansion", () => {
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

	test("expands standalone auth and oauth fields alongside existing env-expanded fields", async () => {
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
		expect(server?.url).toBe("https://mcp.example.com/mcp");
		expect(server?.headers).toEqual({ Authorization: "Bearer test-token" });
		expect(server?.env).toEqual({ MCP_VALUE: "env-value" });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: "https://provider.example/token",
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
		});
		expect(server?.oauth).toEqual({
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
			redirectUri: "https://public.example/oauth/callback",
			callbackPort: 4317,
			callbackPath: "/oauth/callback",
		});
	});

	test("expands only the standalone oauth fields that are present", async () => {
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
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});

	test("preserves noInheritEnv for explicit stdio runtime consumers", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					isolated: {
						type: "stdio",
						command: "isolated-mcp",
						noInheritEnv: true,
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.noInheritEnv).toBe(true);
		const loaded = await loadAllMCPConfigs(tempDir, { filterExa: false });
		expect(loaded.configs.isolated).toMatchObject({ noInheritEnv: true });
	});
});
describe("explicit MCP JSON exact-file trust", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-exact-file-")));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	test("loads a regular exact config through the descriptor-bound reader", async () => {
		const configPath = path.join(tempDir, "exact.json");
		await fs.writeFile(configPath, exactConfigText("exact"));

		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(result.items.map(server => server.name)).toEqual(["exact"]);
		expect(result.warnings).toEqual([]);
	});

	exactConfigFileTest("rejects symbolic-link exact configs with the generic warning", async () => {
		const targetPath = path.join(tempDir, "target.json");
		const configPath = path.join(tempDir, "exact.json");
		await fs.writeFile(targetPath, exactConfigText("target"));
		await fs.symlink(targetPath, configPath, "file");

		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	exactConfigDirectoryTest("rejects symbolic-link/junction parent directories with the generic warning", async () => {
		const targetDirectory = path.join(tempDir, "target");
		const linkedDirectory = path.join(tempDir, "linked");
		await fs.mkdir(targetDirectory);
		await fs.writeFile(path.join(targetDirectory, "exact.json"), exactConfigText("target"));
		await fs.symlink(targetDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

		const result = await loadMCPJsonFile(path.join(linkedDirectory, "exact.json"), "project", {
			quiet: true,
			useCache: false,
		});

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});

	test("fails closed when a descriptor-backed exact config is mutated or replaced after reading", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const originalConfig = exactConfigText("original");
		const mutatedConfig = exactConfigText("changed!");
		expect(Buffer.byteLength(mutatedConfig)).toBe(Buffer.byteLength(originalConfig));
		await fs.writeFile(configPath, originalConfig);

		interceptNextExactConfigRead(async () => {
			await fs.writeFile(configPath, mutatedConfig);
		});
		const mutationResult = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });
		expect(mutationResult).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
		vi.restoreAllMocks();

		await fs.writeFile(configPath, originalConfig);
		const replacementPath = path.join(tempDir, "replacement.json");
		await fs.writeFile(replacementPath, originalConfig);

		interceptNextExactConfigRead(async () => {
			await fs.rename(replacementPath, configPath);
		});
		const replacementResult = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });
		expect(replacementResult).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
});
