import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { BigIntStats } from "node:fs";
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
function isHardLinkUnavailable(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
		return false;
	}
	return ["EACCES", "EINVAL", "EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(error.code);
}

async function canCreateHardLink(): Promise<boolean> {
	const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-hard-link-probe-"));
	const targetPath = path.join(probeDir, "target.json");
	const linkPath = path.join(probeDir, "link.json");
	try {
		await fs.writeFile(targetPath, "{}");
		await fs.link(targetPath, linkPath);
		return true;
	} catch (error) {
		if (isHardLinkUnavailable(error)) return false;
		throw error;
	} finally {
		await fs.rm(probeDir, { recursive: true, force: true });
	}
}

const exactConfigFileTest = test.skipIf(!(await canCreateFileSymlink()));
const exactConfigDirectoryTest = test.skipIf(!(await canCreateDirectoryLink()));
const exactConfigHardLinkTest = test.skipIf(!(await canCreateHardLink()));

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

interface ExactConfigDescriptorReader {
	readFile(): Promise<Buffer>;
	read(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number | null,
	): Promise<{ bytesRead: number; buffer: Buffer }>;
}

interface BigIntStatReader {
	stat(options: { bigint: true }): Promise<BigIntStats>;
}

interface BigIntPathStatReader {
	lstat(file: string, options: { bigint: true }): Promise<BigIntStats>;
}

function interceptNextExactConfigOpen(afterOpen: (handle: fs.FileHandle) => Promise<void>): void {
	const openFile = fs.open;
	vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
		const handle = await openFile(file, flags, mode);
		await afterOpen(handle);
		return handle;
	});
}

function interceptNextExactConfigOpenAttempt(beforeOpen: () => Promise<void>): void {
	const openFile = fs.open;
	vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
		await beforeOpen();
		return openFile(file, flags, mode);
	});
}

function interceptNextExactConfigRead(afterRead: () => Promise<void>): void {
	interceptNextExactConfigOpen(async handle => {
		const reader = handle as unknown as ExactConfigDescriptorReader;
		const readFile = reader.readFile.bind(reader);
		vi.spyOn(reader, "readFile").mockImplementationOnce(async () => {
			const content = await readFile();
			await afterRead();
			return content;
		});
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
	test("reports unavailable exact config paths with the generic warning", async () => {
		const result = await loadMCPJsonFile(path.join(tempDir, "missing.json"), "project", {
			quiet: true,
			useCache: false,
		});

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	test("reports ENAMETOOLONG exact config paths with the generic warning", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const error = Object.assign(new Error("path too long"), { code: "ENAMETOOLONG" });
		vi.spyOn(fs, "lstat").mockRejectedValueOnce(error);

		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	for (const [reservedName, safeName] of [
		["__proto__", "__proto__-safe"],
		["prototype", "prototype-safe"],
		["constructor", "constructor-safe"],
	] as const) {
		test(`rejects ${reservedName} while loading the adjacent safe exact config server`, async () => {
			const configPath = path.join(tempDir, `${safeName}.json`);
			await fs.writeFile(
				configPath,
				JSON.stringify({
					mcpServers: {
						[reservedName]: {
							type: "stdio",
							command: "exact-mcp",
						},
						[safeName]: {
							type: "stdio",
							command: "exact-mcp",
						},
					},
				}),
			);

			const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

			expect(result.items.map(server => server.name)).toEqual([safeName]);
			expect(result.warnings).toEqual(["MCP configuration unavailable"]);
			expect(result.disabledServers).toEqual([]);
		});
	}

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
	exactConfigHardLinkTest("rejects multi-link exact configs with the generic warning", async () => {
		const targetPath = path.join(tempDir, "target.json");
		const configPath = path.join(tempDir, "exact.json");
		await fs.writeFile(targetPath, exactConfigText("target"));
		await fs.link(targetPath, configPath);
		expect((await fs.lstat(configPath, { bigint: true })).nlink).toBeGreaterThan(1n);

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
	test("fails closed when an exact config leaf is replaced between path validation and descriptor open", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const replacementPath = path.join(tempDir, "replacement.json");
		await fs.writeFile(configPath, exactConfigText("original"));
		await fs.writeFile(replacementPath, exactConfigText("replacement"));

		interceptNextExactConfigOpenAttempt(async () => {
			await fs.rename(replacementPath, configPath);
		});
		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	test("fails closed when an exact config ancestor is replaced between path validation and descriptor open", async () => {
		const activeDirectory = path.join(tempDir, "active");
		const replacementDirectory = path.join(tempDir, "replacement");
		const retiredDirectory = path.join(tempDir, "retired");
		await fs.mkdir(activeDirectory);
		await fs.mkdir(replacementDirectory);
		const configPath = path.join(activeDirectory, "exact.json");
		await fs.writeFile(configPath, exactConfigText("original"));
		await fs.writeFile(path.join(replacementDirectory, "exact.json"), exactConfigText("replacement"));

		interceptNextExactConfigOpenAttempt(async () => {
			await fs.rename(activeDirectory, retiredDirectory);
			await fs.rename(replacementDirectory, activeDirectory);
		});
		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	test("fails closed before reading when an opened exact config leaf is replaced", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const replacementPath = path.join(tempDir, "replacement.json");
		let readCalls = 0;
		await fs.writeFile(configPath, exactConfigText("original"));
		await fs.writeFile(replacementPath, exactConfigText("replacement"));

		interceptNextExactConfigOpen(async handle => {
			const reader = handle as unknown as ExactConfigDescriptorReader;
			const readFile = reader.readFile.bind(reader);
			vi.spyOn(reader, "readFile").mockImplementation(async () => {
				readCalls += 1;
				return readFile();
			});
			await fs.rename(replacementPath, configPath);
		});
		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(readCalls).toBe(0);
		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	test("fails closed before reading when an opened exact config ancestor is replaced", async () => {
		const activeDirectory = path.join(tempDir, "active");
		const replacementDirectory = path.join(tempDir, "replacement");
		const retiredDirectory = path.join(tempDir, "retired");
		let readCalls = 0;
		await fs.mkdir(activeDirectory);
		await fs.mkdir(replacementDirectory);
		const configPath = path.join(activeDirectory, "exact.json");
		await fs.writeFile(configPath, exactConfigText("original"));
		await fs.writeFile(path.join(replacementDirectory, "exact.json"), exactConfigText("replacement"));

		interceptNextExactConfigOpen(async handle => {
			const reader = handle as unknown as ExactConfigDescriptorReader;
			const readFile = reader.readFile.bind(reader);
			vi.spyOn(reader, "readFile").mockImplementation(async () => {
				readCalls += 1;
				return readFile();
			});
			await fs.rename(activeDirectory, retiredDirectory);
			await fs.rename(replacementDirectory, activeDirectory);
		});
		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(readCalls).toBe(0);
		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	test("rethrows unexpected exact config open failures", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const failure = new Error("unexpected exact config open failure");
		await fs.writeFile(configPath, exactConfigText("exact"));
		vi.spyOn(fs, "open").mockRejectedValueOnce(failure);

		await expect(loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false })).rejects.toBe(failure);
	});
	test("rethrows unexpected exact config lstat failures", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const failure = new Error("unexpected exact config lstat failure");
		vi.spyOn(fs, "lstat").mockRejectedValueOnce(failure);

		await expect(loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false })).rejects.toBe(failure);
	});
	test("rethrows unexpected descriptor read failures without masking them during cleanup", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const readFailure = new Error("unexpected exact config read failure");
		const closeFailure = new Error("unexpected exact config close failure");
		let closeOriginal: (() => Promise<void>) | undefined;
		let closeCalls = 0;
		await fs.writeFile(configPath, exactConfigText("exact"));

		interceptNextExactConfigOpen(async handle => {
			closeOriginal = handle.close.bind(handle);
			vi.spyOn(handle, "close").mockImplementation(async () => {
				closeCalls += 1;
				throw closeFailure;
			});
			const reader = handle as unknown as ExactConfigDescriptorReader;
			vi.spyOn(reader, "readFile").mockRejectedValueOnce(readFailure);
		});

		try {
			await expect(loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false })).rejects.toBe(
				readFailure,
			);
			expect(closeCalls).toBe(1);
		} finally {
			if (closeOriginal) await closeOriginal();
		}
	});
	test("rethrows unexpected descriptor revalidation failures after closing exactly once", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const failure = new Error("unexpected descriptor revalidation failure");
		let closeOriginal: (() => Promise<void>) | undefined;
		let descriptorClosed = false;
		let closeCalls = 0;
		await fs.writeFile(configPath, exactConfigText("exact"));

		interceptNextExactConfigOpen(async handle => {
			const close = handle.close.bind(handle);
			closeOriginal = close;
			vi.spyOn(handle, "close").mockImplementation(async () => {
				closeCalls += 1;
				await close();
				descriptorClosed = true;
			});
			const reader = handle as unknown as ExactConfigDescriptorReader;
			vi.spyOn(reader, "read").mockRejectedValueOnce(failure);
		});

		try {
			await expect(loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false })).rejects.toBe(failure);
			expect(closeCalls).toBe(1);
		} finally {
			if (!descriptorClosed && closeOriginal) await closeOriginal();
		}
	});
	test("rethrows unexpected descriptor stat failures after closing exactly once", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const failure = new Error("unexpected exact config stat failure");
		let closeOriginal: (() => Promise<void>) | undefined;
		let descriptorClosed = false;
		let closeCalls = 0;
		await fs.writeFile(configPath, exactConfigText("exact"));

		interceptNextExactConfigOpen(async handle => {
			const close = handle.close.bind(handle);
			closeOriginal = close;
			vi.spyOn(handle, "close").mockImplementation(async () => {
				closeCalls += 1;
				await close();
				descriptorClosed = true;
			});
			vi.spyOn(handle, "stat").mockRejectedValueOnce(failure);
		});

		try {
			await expect(loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false })).rejects.toBe(failure);
			expect(closeCalls).toBe(1);
		} finally {
			if (!descriptorClosed && closeOriginal) await closeOriginal();
		}
	});
	test("propagates an exact config close failure when no prior failure occurred", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const closeFailure = new Error("unexpected exact config close failure");
		let closeOriginal: (() => Promise<void>) | undefined;
		let closeCalls = 0;
		await fs.writeFile(configPath, exactConfigText("exact"));

		interceptNextExactConfigOpen(async handle => {
			closeOriginal = handle.close.bind(handle);
			vi.spyOn(handle, "close").mockImplementation(async () => {
				closeCalls += 1;
				throw closeFailure;
			});
		});

		try {
			await expect(loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false })).rejects.toBe(
				closeFailure,
			);
			expect(closeCalls).toBe(1);
		} finally {
			if (closeOriginal) await closeOriginal();
		}
	});
	test("fails closed on a same-size descriptor mutation when file metadata is restored", async () => {
		const configPath = path.join(tempDir, "exact.json");
		const originalConfig = exactConfigText("original");
		const mutatedConfig = exactConfigText("changed!");
		const revalidationPositions: (number | null)[] = [];
		expect(Buffer.byteLength(mutatedConfig)).toBe(Buffer.byteLength(originalConfig));
		await fs.writeFile(configPath, originalConfig);
		const originalState = await fs.lstat(configPath, { bigint: true });
		let concealMutation = false;

		interceptNextExactConfigOpen(async handle => {
			const reader = handle as unknown as ExactConfigDescriptorReader;
			const statReader = handle as unknown as BigIntStatReader;
			const pathStatReader = fs as unknown as BigIntPathStatReader;
			const readFile = reader.readFile.bind(reader);
			const read = reader.read.bind(reader);
			const stat = statReader.stat.bind(statReader);
			const lstat = pathStatReader.lstat.bind(pathStatReader);
			vi.spyOn(reader, "read").mockImplementation(async (buffer, offset, length, position) => {
				revalidationPositions.push(position);
				return read(buffer, offset, length, position);
			});
			vi.spyOn(reader, "readFile").mockImplementationOnce(async () => {
				const content = await readFile();
				await fs.writeFile(configPath, mutatedConfig);
				await fs.utimes(configPath, originalState.atime, originalState.mtime);
				concealMutation = true;
				return content;
			});
			vi.spyOn(statReader, "stat").mockImplementation(async options =>
				concealMutation ? originalState : stat(options),
			);
			vi.spyOn(pathStatReader, "lstat").mockImplementation(async (file, options) => {
				const actualState = await lstat(file, options);
				return concealMutation && file === configPath ? originalState : actualState;
			});
		});

		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(revalidationPositions).toEqual([0]);
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
	test("fails closed when an exact config ancestor is replaced after reading", async () => {
		const activeDirectory = path.join(tempDir, "active");
		const replacementDirectory = path.join(tempDir, "replacement");
		const retiredDirectory = path.join(tempDir, "retired");
		await fs.mkdir(activeDirectory);
		await fs.mkdir(replacementDirectory);
		const configPath = path.join(activeDirectory, "exact.json");
		await fs.writeFile(configPath, exactConfigText("original"));
		await fs.writeFile(path.join(replacementDirectory, "exact.json"), exactConfigText("replacement"));

		interceptNextExactConfigRead(async () => {
			await fs.rename(activeDirectory, retiredDirectory);
			await fs.rename(replacementDirectory, activeDirectory);
		});
		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
	test("fails closed when an ancestor directory is replaced while the descriptor leaf is retained", async () => {
		const activeDirectory = path.join(tempDir, "active");
		const replacementDirectory = path.join(tempDir, "replacement");
		const retiredDirectory = path.join(tempDir, "retired");
		const configPath = path.join(activeDirectory, "exact.json");
		await fs.mkdir(activeDirectory);
		await fs.mkdir(replacementDirectory);
		await fs.writeFile(configPath, exactConfigText("original"));
		const originalState = await fs.lstat(configPath, { bigint: true });
		let concealLeafMutation = false;

		interceptNextExactConfigOpen(async handle => {
			const reader = handle as unknown as ExactConfigDescriptorReader;
			const statReader = handle as unknown as BigIntStatReader;
			const pathStatReader = fs as unknown as BigIntPathStatReader;
			const readFile = reader.readFile.bind(reader);
			const stat = statReader.stat.bind(statReader);
			const lstat = pathStatReader.lstat.bind(pathStatReader);
			vi.spyOn(statReader, "stat").mockImplementation(async options =>
				concealLeafMutation ? originalState : stat(options),
			);
			vi.spyOn(pathStatReader, "lstat").mockImplementation(async (file, options) => {
				const actualState = await lstat(file, options);
				return concealLeafMutation && file === configPath ? originalState : actualState;
			});
			vi.spyOn(reader, "readFile").mockImplementationOnce(async () => {
				const content = await readFile();
				await fs.rename(configPath, path.join(replacementDirectory, "exact.json"));
				await fs.rename(activeDirectory, retiredDirectory);
				await fs.rename(replacementDirectory, activeDirectory);
				concealLeafMutation = true;
				return content;
			});
		});

		const result = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });

		expect(result).toEqual({
			items: [],
			warnings: ["MCP configuration unavailable"],
			disabledServers: [],
		});
	});
});
