import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@gajae-code/utils";
import { getAgentDir, getConfigDirName, setAgentDir, TempDir } from "@gajae-code/utils";
import { registerOwnedDeletionRoot, safeRm, safeRmSync } from "../../../../scripts/safe-cleanup";
import * as discoveryHelpers from "../../src/discovery/helpers";
import { createLspWritethrough, LspTool } from "../../src/lsp";
import { getOrCreateClient, shutdownAll } from "../../src/lsp/client";
import { loadConfig } from "../../src/lsp/config";
import { detectLspmux, getLspmuxCommand, resetLspmuxStateForTesting } from "../../src/lsp/lspmux";
import { isProjectControlledPath } from "../../src/lsp/path-trust";
import type { ToolSession } from "../../src/tools";

const ORIGINAL_DISABLE_LSPMUX = Bun.env.PI_DISABLE_LSPMUX;
const ORIGINAL_GJC_DISABLE_LSPMUX = Bun.env.GJC_DISABLE_LSPMUX;
const ORIGINAL_CONFIG_DIR = process.env.GJC_CONFIG_DIR;

async function writeCanaryLspServer(directory: string): Promise<string> {
	const scriptPath = path.join(directory, "canary-lsp.ts");
	await Bun.write(
		scriptPath,
		`import { writeFileSync } from "node:fs";
const canaryPath = process.argv[2];
writeFileSync(canaryPath, "repository command executed");
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body, "utf8")}\\r\\n\\r\\n\${body}\`);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: message.params.textDocument.uri,
        version: message.params.textDocument.version,
        diagnostics: [],
      },
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString();
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(start, end).toString());
    buffer = buffer.subarray(end);
    handle(message);
  }
});
setInterval(() => {}, 1_000);
`,
	);
	return scriptPath;
}

async function writeLspmuxBinary(directory: string, canaryPath?: string): Promise<string> {
	const binaryPath = path.join(directory, "lspmux");
	const canaryWrite = canaryPath ? `echo lspmux-status-ran > ${JSON.stringify(canaryPath)}\n` : "";
	await Bun.write(binaryPath, `#!/bin/sh\n${canaryWrite}exit 0\n`);
	await fs.promises.chmod(binaryPath, 0o755);
	return binaryPath;
}

afterEach(async () => {
	await shutdownAll();
	vi.restoreAllMocks();
	resetLspmuxStateForTesting();
	if (ORIGINAL_DISABLE_LSPMUX === undefined) {
		delete Bun.env.PI_DISABLE_LSPMUX;
	} else {
		Bun.env.PI_DISABLE_LSPMUX = ORIGINAL_DISABLE_LSPMUX;
	}
	if (ORIGINAL_GJC_DISABLE_LSPMUX === undefined) {
		delete Bun.env.GJC_DISABLE_LSPMUX;
	} else {
		Bun.env.GJC_DISABLE_LSPMUX = ORIGINAL_GJC_DISABLE_LSPMUX;
	}
	if (ORIGINAL_CONFIG_DIR === undefined) {
		delete process.env.GJC_CONFIG_DIR;
	} else {
		process.env.GJC_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	}
});

describe("LSP repository command trust", () => {
	it("does not execute a repository-configured command on the first LSP-backed write", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-command-trust-");
		const cwd = tempDir.path();
		const canaryPath = path.join(cwd, "repository-command-ran");
		const scriptPath = await writeCanaryLspServer(cwd);
		const targetPath = path.join(cwd, "example.ts");

		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"typescript-language-server": {
						command: process.execPath,
						args: [scriptPath, canaryPath],
						fileTypes: [".ts"],
						rootMarkers: ["package.json"],
					},
				},
			}),
		);
		Bun.env.PI_DISABLE_LSPMUX = "1";

		const writethrough = createLspWritethrough(cwd, {
			enableFormat: false,
			enableDiagnostics: true,
		});
		await writethrough(targetPath, "export const value = 1;\n");

		expect(fs.existsSync(canaryPath)).toBe(false);
		expect(await Bun.file(targetPath).text()).toBe("export const value = 1;\n");
	});

	it("does not add a repository-defined custom server with launch fields", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-custom-command-trust-");
		const cwd = tempDir.path();
		vi.spyOn(piUtils, "$which").mockReturnValue(null);

		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"repository-custom-server": {
						command: process.execPath,
						args: ["malicious-script.ts"],
						fileTypes: [".custom"],
						rootMarkers: ["package.json"],
					},
				},
			}),
		);

		expect(loadConfig(cwd).servers["repository-custom-server"]).toBeUndefined();
	});

	it("loads user LSP configuration from the selected agent profile only", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-profile-config-");
		const cwd = path.join(tempDir.path(), "workspace");
		const profileRoot = path.join("/var/tmp", `.gjc-lsp-profile-${process.pid}-${Date.now()}`);
		const forgetProfileRoot = registerOwnedDeletionRoot(profileRoot);
		const profileA = path.join(profileRoot, "profile-a");
		const profileB = path.join(profileRoot, "profile-b");
		const serverDir = path.join("/var/tmp", `.gjc-lsp-server-${process.pid}-${Date.now()}`);
		const forgetServerRoot = registerOwnedDeletionRoot(serverDir);
		const serverA = path.join(serverDir, "server-a");
		const serverB = path.join(serverDir, "server-b");
		try {
			await Promise.all([
				fs.promises.mkdir(cwd, { recursive: true }),
				fs.promises.mkdir(profileA, { recursive: true }),
				fs.promises.mkdir(profileB, { recursive: true }),
				fs.promises.mkdir(serverDir, { recursive: true }),
				Bun.write(serverA, ""),
				Bun.write(serverB, ""),
			]);
			await Promise.all([
				Bun.write(
					path.join(profileA, "lsp.json"),
					JSON.stringify({
						servers: {
							"profile-a-server": {
								command: serverA,
								fileTypes: [".profile-a"],
								rootMarkers: ["."],
							},
						},
					}),
				),
				Bun.write(
					path.join(profileB, "lsp.json"),
					JSON.stringify({
						servers: {
							"profile-b-server": {
								command: serverB,
								fileTypes: [".profile-b"],
								rootMarkers: ["."],
							},
						},
					}),
				),
			]);

			const configA = loadConfig(cwd, profileA);
			const configB = loadConfig(cwd, profileB);
			expect(configA.servers["profile-a-server"]?.command).toBe(serverA);
			expect(configA.servers["profile-b-server"]).toBeUndefined();
			expect(configB.servers["profile-b-server"]?.command).toBe(serverB);
			expect(configB.servers["profile-a-server"]).toBeUndefined();
		} finally {
			await safeRm(profileRoot, { recursive: true, force: true });
			forgetProfileRoot();
			await safeRm(serverDir, { recursive: true, force: true });
			forgetServerRoot();
		}
	});

	it("preloads plugin LSP configuration from the selected custom agent profile", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-profile-plugin-");
		const cwd = path.join(tempDir.path(), "workspace");
		const profile = path.join("/var/tmp", `.gjc-lsp-profile-plugin-${process.pid}-${Date.now()}`);
		const pluginRoot = path.join(profile, "plugins", "profile-plugin");
		const forgetProfileRoot = registerOwnedDeletionRoot(profile);
		const originalAgentDir = getAgentDir();
		const originalAgentDirEnv = process.env.GJC_CODING_AGENT_DIR;
		try {
			await Promise.all([
				fs.promises.mkdir(cwd, { recursive: true }),
				fs.promises.mkdir(pluginRoot, { recursive: true }),
			]);
			await Bun.write(
				path.join(pluginRoot, "lsp.json"),
				JSON.stringify({
					servers: {
						"profile-plugin-server": {
							command: process.execPath,
							fileTypes: [".profile-plugin"],
							rootMarkers: ["."],
						},
					},
				}),
			);
			await Bun.write(
				path.join(profile, "plugins", "installed_plugins.json"),
				JSON.stringify({
					version: 2,
					plugins: {
						"profile-plugin@local": [
							{
								scope: "user",
								installPath: pluginRoot,
								version: "1.0.0",
							},
						],
					},
				}),
			);

			setAgentDir(profile);
			await discoveryHelpers.preloadPluginRoots(os.homedir(), cwd, profile, "custom");
			const config = loadConfig(cwd);
			expect(config.servers["profile-plugin-server"]?.command).toBe(process.execPath);
		} finally {
			setAgentDir(originalAgentDir);
			if (originalAgentDirEnv === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = originalAgentDirEnv;
			discoveryHelpers.clearClaudePluginRootsCache();
			await safeRm(profile, { recursive: true, force: true });
			forgetProfileRoot();
		}
	});

	it("keeps no-argument LSP config scoped to a custom setAgentDir profile", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-no-arg-profile-");
		const cwd = path.join(tempDir.path(), "workspace");
		const profile = path.join("/var/tmp", `.gjc-lsp-no-arg-profile-${process.pid}-${Date.now()}`);
		const ambientHome = path.join("/var/tmp", `.gjc-lsp-no-arg-home-${process.pid}-${Date.now()}`);
		const forgetProfileRoot = registerOwnedDeletionRoot(profile);
		const forgetAmbientRoot = registerOwnedDeletionRoot(ambientHome);
		const originalAgentDir = getAgentDir();
		const originalAgentDirEnv = process.env.GJC_CODING_AGENT_DIR;
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(ambientHome);
		try {
			await fs.promises.mkdir(cwd, { recursive: true });
			await fs.promises.mkdir(profile, { recursive: true });
			await fs.promises.mkdir(ambientHome, { recursive: true });
			await Promise.all([
				Bun.write(
					path.join(profile, "lsp.json"),
					JSON.stringify({
						servers: {
							"custom-profile-server": {
								command: process.execPath,
								fileTypes: [".custom-profile"],
								rootMarkers: ["."],
							},
						},
					}),
				),
				Bun.write(
					path.join(ambientHome, "lsp.json"),
					JSON.stringify({
						servers: {
							"ambient-home-server": {
								command: process.execPath,
								fileTypes: [".ambient-home"],
								rootMarkers: ["."],
							},
						},
					}),
				),
			]);

			setAgentDir(profile);
			const config = loadConfig(cwd);
			expect(config.servers["custom-profile-server"]?.command).toBe(process.execPath);
			expect(config.servers["ambient-home-server"]).toBeUndefined();
		} finally {
			homeSpy.mockRestore();
			setAgentDir(originalAgentDir);
			if (originalAgentDirEnv === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = originalAgentDirEnv;
			await safeRm(profile, { recursive: true, force: true });
			await safeRm(ambientHome, { recursive: true, force: true });
			forgetProfileRoot();
			forgetAmbientRoot();
		}
	});

	it("keeps a custom profile scoped when HOME refresh makes its path canonical", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-sticky-profile-");
		const cwd = path.join(tempDir.path(), "workspace");
		const firstHome = path.join(tempDir.path(), "first-home");
		const secondHome = path.join(tempDir.path(), "second-home");
		const configDirName = getConfigDirName();
		const profile = path.join(secondHome, configDirName, "agent");
		const originalAgentDir = getAgentDir();
		const originalAgentDirEnv = process.env.GJC_CODING_AGENT_DIR;
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(firstHome);
		try {
			await fs.promises.mkdir(cwd, { recursive: true });
			await fs.promises.mkdir(profile, { recursive: true });
			await Bun.write(
				path.join(profile, "lsp.json"),
				JSON.stringify({
					servers: {
						"sticky-profile-server": {
							command: process.execPath,
							fileTypes: [".sticky"],
							rootMarkers: ["."],
						},
					},
				}),
			);
			await Bun.write(
				path.join(secondHome, "lsp.json"),
				JSON.stringify({
					servers: {
						"ambient-home-server": {
							command: process.execPath,
							fileTypes: [".ambient"],
							rootMarkers: ["."],
						},
					},
				}),
			);

			// The selected profile is custom under firstHome. After HOME moves, its
			// path coincides with the canonical default, but resolver authority stays
			// custom and must keep ambient home-root config excluded.
			setAgentDir(profile);
			homeSpy.mockReturnValue(secondHome);
			const config = loadConfig(cwd, profile);
			expect(config.servers["sticky-profile-server"]?.command).toBe(process.execPath);
			expect(config.servers["ambient-home-server"]).toBeUndefined();
		} finally {
			homeSpy.mockRestore();
			setAgentDir(originalAgentDir);
			if (originalAgentDirEnv === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = originalAgentDirEnv;
		}
	});

	it("does not share same-cwd LSP clients across effective agent profiles", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-profile-client-");
		const cwd = tempDir.path();
		const profileA = path.join(cwd, "profile-a");
		const profileB = path.join(cwd, "profile-b");
		const script = await writeCanaryLspServer(cwd);
		const canaryPath = path.join(cwd, "client-started");
		const config = {
			command: process.execPath,
			args: [script, canaryPath],
			fileTypes: [".ts"],
			rootMarkers: [],
		};

		const first = await getOrCreateClient(config, cwd, 1_000, profileA);
		const second = await getOrCreateClient(config, cwd, 1_000, profileB);
		expect(second).not.toBe(first);
		expect(second.name).not.toBe(first.name);
	});

	it("does not trust project-scoped plugin launch fields even when the root claims user scope", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-plugin-command-trust-");
		const cwd = path.join(tempDir.path(), "repo");
		const projectPlugin = path.join(cwd, "project-plugin");
		await fs.promises.mkdir(projectPlugin, { recursive: true });
		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(
			path.join(projectPlugin, "lsp.json"),
			JSON.stringify({
				servers: {
					"project-plugin-server": {
						command: process.execPath,
						args: ["--untrusted-plugin-argument"],
						fileTypes: [".plugin"],
						rootMarkers: ["package.json"],
					},
				},
			}),
		);
		const roots: discoveryHelpers.ClaudePluginRoot[] = [
			{
				id: "forged-project-plugin@__local__",
				marketplace: "__local__",
				plugin: "project-plugin",
				version: "local",
				path: projectPlugin,
				scope: "user",
			},
		];
		vi.spyOn(discoveryHelpers, "getPreloadedPluginRoots").mockImplementation(() => roots);

		expect(loadConfig(cwd).servers["project-plugin-server"]).toBeUndefined();
	});

	it("does not execute repository-contained lspmux binaries discovered directly or through a PATH symlink", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lspmux-command-trust-");
		const repositoryRoot = path.join(tempDir.path(), "repo");
		const cwd = path.join(repositoryRoot, "packages", "nested");
		const externalBinDir = path.join(tempDir.path(), "bin");
		const trustedBinDir = path.join(tempDir.path(), "trusted-bin");
		const canaryPath = path.join(repositoryRoot, "lspmux-status-ran");
		await fs.promises.mkdir(path.join(repositoryRoot, ".git"), { recursive: true });
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(externalBinDir, { recursive: true });
		await fs.promises.mkdir(trustedBinDir, { recursive: true });
		const repositoryBinary = await writeLspmuxBinary(repositoryRoot, canaryPath);
		const pathSymlink = path.join(externalBinDir, "lspmux");
		await fs.promises.symlink(repositoryBinary, pathSymlink);
		const trustedBinary = await writeLspmuxBinary(trustedBinDir);
		const repositorySymlink = path.join(repositoryRoot, "external-lspmux");
		await fs.promises.symlink(trustedBinary, repositorySymlink);
		const which = vi.spyOn(piUtils, "$which");
		which.mockReturnValue(repositoryBinary);
		expect((await detectLspmux(cwd)).available).toBe(false);
		expect(fs.existsSync(canaryPath)).toBe(false);

		resetLspmuxStateForTesting();
		which.mockReturnValue(pathSymlink);
		const state = await detectLspmux(cwd);
		expect(state.available).toBe(false);
		expect(await getLspmuxCommand("rust-analyzer", [], cwd)).toEqual({ command: "rust-analyzer", args: [] });
		expect(fs.existsSync(canaryPath)).toBe(false);

		resetLspmuxStateForTesting();
		which.mockReturnValue(repositorySymlink);
		expect((await detectLspmux(cwd)).available).toBe(false);
	});

	it("uses the session cwd when the LSP status action probes lspmux", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lspmux-status-command-trust-");
		const repositoryRoot = path.join(tempDir.path(), "repo");
		const sessionCwd = path.join(repositoryRoot, "packages", "nested");
		const canaryPath = path.join(repositoryRoot, "lspmux-status-ran");
		await fs.promises.mkdir(path.join(repositoryRoot, ".git"), { recursive: true });
		await fs.promises.mkdir(sessionCwd, { recursive: true });
		const repositoryBinary = await writeLspmuxBinary(repositoryRoot, canaryPath);
		vi.spyOn(piUtils, "$which").mockReturnValue(repositoryBinary);

		const tool = new LspTool({ cwd: sessionCwd } as ToolSession);
		await tool.execute("status-command-trust", { action: "status" });

		expect(fs.existsSync(canaryPath)).toBe(false);
	});

	it("wraps supported servers with an external lspmux and honors both disable variables", async () => {
		using tempDir = TempDir.createSync("@gjc-lspmux-external-");
		const cwd = path.join(tempDir.path(), "repo");
		// Issue #4794: trusted user-scope resolution only honors the REAL home
		// (resolvers capture os.homedir at import time, so a mock cannot
		// redirect it). This test therefore still creates its fixture under the
		// real home, but the deletion is explicitly granted for exactly this
		// process-created directory and still refuses the home itself.
		const externalBinDir = path.join(os.homedir(), `.gjc-lspmux-external-${process.pid}-${Date.now()}`);
		const forgetGrant = registerOwnedDeletionRoot(externalBinDir);
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(externalBinDir, { recursive: true });
		try {
			const externalBinary = await writeLspmuxBinary(externalBinDir);
			vi.spyOn(piUtils, "$which").mockReturnValue(externalBinary);

			const state = await detectLspmux(cwd);
			expect(state.available).toBe(true);
			expect(state.running).toBe(true);
			expect(await getLspmuxCommand("rust-analyzer", [], cwd)).toEqual({
				command: fs.realpathSync(externalBinary),
				args: [],
			});

			Bun.env.GJC_DISABLE_LSPMUX = "1";
			expect((await detectLspmux(cwd)).available).toBe(false);
			delete Bun.env.GJC_DISABLE_LSPMUX;
			resetLspmuxStateForTesting();
			expect((await detectLspmux(cwd)).available).toBe(true);
			Bun.env.PI_DISABLE_LSPMUX = "1";
			expect((await detectLspmux(cwd)).available).toBe(false);
		} finally {
			await safeRm(externalBinDir, { recursive: true, force: true });
			forgetGrant();
		}
	});

	it("rejects a repository-owned executable symlink while preserving an external symlink", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-server-symlink-trust-");
		const repositoryRoot = path.join(tempDir.path(), "repo");
		const externalBinDir = path.join(tempDir.path(), "bin");
		const userBinDir = path.join(tempDir.path(), "user-bin");
		const externalServer = path.join(externalBinDir, "typescript-language-server");
		const repositorySymlink = path.join(repositoryRoot, "typescript-language-server");
		const externalSymlink = path.join(userBinDir, "typescript-language-server");
		await fs.promises.mkdir(path.join(repositoryRoot, ".git"), { recursive: true });
		await fs.promises.mkdir(externalBinDir, { recursive: true });
		await fs.promises.mkdir(userBinDir, { recursive: true });
		await Bun.write(path.join(repositoryRoot, "package.json"), "{}\n");
		await Bun.write(externalServer, "");
		await fs.promises.symlink(externalServer, repositorySymlink);
		await fs.promises.symlink(externalServer, externalSymlink);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "typescript-language-server" ? repositorySymlink : null));

		expect(loadConfig(repositoryRoot).servers["typescript-language-server"]).toBeUndefined();

		which.mockImplementation(command => (command === "typescript-language-server" ? externalSymlink : null));
		expect(loadConfig(repositoryRoot).servers["typescript-language-server"]?.resolvedCommand).toBe(
			fs.realpathSync(externalServer),
		);
	});

	it("finds repository-root executables through a symlinked nested session cwd", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-symlinked-cwd-trust-");
		const repositoryRoot = path.join(tempDir.path(), "repo");
		const nestedCwd = path.join(repositoryRoot, "packages", "nested");
		const sessionCwd = path.join(tempDir.path(), "session-cwd");
		const serverBinary = path.join(repositoryRoot, "typescript-language-server");
		const lspmuxCanary = path.join(repositoryRoot, "lspmux-status-ran");
		await fs.promises.mkdir(path.join(repositoryRoot, ".git"), { recursive: true });
		await fs.promises.mkdir(nestedCwd, { recursive: true });
		await fs.promises.symlink(nestedCwd, sessionCwd);
		await Bun.write(path.join(nestedCwd, "package.json"), "{}\n");
		await Bun.write(serverBinary, "");
		const repositoryLspmux = await writeLspmuxBinary(repositoryRoot, lspmuxCanary);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "typescript-language-server" ? serverBinary : null));

		expect(loadConfig(sessionCwd).servers["typescript-language-server"]).toBeUndefined();

		resetLspmuxStateForTesting();
		which.mockImplementation(command => (command === "lspmux" ? repositoryLspmux : null));
		expect((await detectLspmux(sessionCwd)).available).toBe(false);
		expect(fs.existsSync(lspmuxCanary)).toBe(false);
	});

	it("anchors non-Git nested sessions to the nearest parent .gjc project", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-project-config-root-trust-");
		const projectRoot = path.join(tempDir.path(), "project");
		const nestedCwd = path.join(projectRoot, "packages", "nested");
		const symlinkedCwd = path.join(tempDir.path(), "symlinked-session");
		const serverBinary = path.join(projectRoot, "typescript-language-server");
		const lspmuxCanary = path.join(projectRoot, "lspmux-status-ran");
		await fs.promises.mkdir(path.join(projectRoot, ".gjc"), { recursive: true });
		await fs.promises.mkdir(nestedCwd, { recursive: true });
		await fs.promises.symlink(nestedCwd, symlinkedCwd);
		await Bun.write(path.join(nestedCwd, "package.json"), "{}\n");
		await Bun.write(serverBinary, "");
		const projectLspmux = await writeLspmuxBinary(projectRoot, lspmuxCanary);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "typescript-language-server" ? serverBinary : null));

		expect(loadConfig(nestedCwd).servers["typescript-language-server"]).toBeUndefined();
		expect(loadConfig(symlinkedCwd).servers["typescript-language-server"]).toBeUndefined();

		resetLspmuxStateForTesting();
		which.mockImplementation(command => (command === "lspmux" ? projectLspmux : null));
		expect((await detectLspmux(nestedCwd)).available).toBe(false);
		resetLspmuxStateForTesting();
		expect((await detectLspmux(symlinkedCwd)).available).toBe(false);
		expect(fs.existsSync(lspmuxCanary)).toBe(false);
	});

	it("lets a Git root outrank a nearer project .gjc marker", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-git-root-precedence-");
		const repositoryRoot = path.join(tempDir.path(), "repo");
		const nestedProject = path.join(repositoryRoot, "packages", "nested-project");
		const cwd = path.join(nestedProject, "src");
		const serverBinary = path.join(repositoryRoot, "typescript-language-server");
		const lspmuxCanary = path.join(repositoryRoot, "lspmux-status-ran");
		await fs.promises.mkdir(repositoryRoot, { recursive: true });
		await Bun.write(path.join(repositoryRoot, ".git"), "gitdir: ../metadata.git\n");
		await fs.promises.mkdir(path.join(nestedProject, ".gjc"), { recursive: true });
		await fs.promises.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(serverBinary, "");
		const repositoryLspmux = await writeLspmuxBinary(repositoryRoot, lspmuxCanary);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "typescript-language-server" ? serverBinary : null));

		expect(loadConfig(cwd).servers["typescript-language-server"]).toBeUndefined();
		resetLspmuxStateForTesting();
		which.mockImplementation(command => (command === "lspmux" ? repositoryLspmux : null));
		expect((await detectLspmux(cwd)).available).toBe(false);
		expect(fs.existsSync(lspmuxCanary)).toBe(false);
	});

	it("stops before lexical and canonical home paths when finding project roots", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-home-root-guard-");
		const canonicalHome = path.join(tempDir.path(), "home");
		const lexicalHome = path.join(tempDir.path(), "home-link");
		const cwd = path.join(canonicalHome, "workspace", "nested");
		const userBinDir = path.join(lexicalHome, ".gjc", "bin");
		const userServer = path.join(userBinDir, "typescript-language-server");
		await fs.promises.mkdir(userBinDir.replace(lexicalHome, canonicalHome), { recursive: true });
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.symlink(canonicalHome, lexicalHome);
		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(userServer, "");
		const userLspmux = await writeLspmuxBinary(userBinDir);
		vi.spyOn(os, "homedir").mockReturnValue(lexicalHome);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "typescript-language-server" ? userServer : null));

		expect(isProjectControlledPath(userServer, cwd)).toBe(false);
		expect(loadConfig(cwd).servers["typescript-language-server"]?.resolvedCommand).toBe(fs.realpathSync(userServer));
		resetLspmuxStateForTesting();
		which.mockImplementation(command => (command === "lspmux" ? userLspmux : null));
		expect((await detectLspmux(cwd)).available).toBe(true);
	});

	it("does not treat lexical or canonical home cwd as project authority", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-home-cwd-guard-");
		const canonicalHome = path.join(tempDir.path(), "home");
		const lexicalHome = path.join(tempDir.path(), "home-link");
		const userBinDir = path.join(lexicalHome, ".gjc", "bin");
		const userServer = path.join(userBinDir, "typescript-language-server");
		await fs.promises.mkdir(path.join(canonicalHome, ".git"), { recursive: true });
		await fs.promises.mkdir(path.join(canonicalHome, ".gjc", "bin"), { recursive: true });
		await fs.promises.symlink(canonicalHome, lexicalHome);
		await Bun.write(userServer, "");
		const userLspmux = await writeLspmuxBinary(userBinDir);
		await Bun.write(path.join(lexicalHome, "package.json"), "{}\n");
		vi.spyOn(os, "homedir").mockReturnValue(lexicalHome);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "typescript-language-server" ? userServer : null));

		for (const cwd of [lexicalHome, canonicalHome]) {
			expect(isProjectControlledPath(userServer, cwd)).toBe(false);
			const server = loadConfig(cwd).servers["typescript-language-server"];
			expect(server?.resolvedCommand).toBe(fs.realpathSync(userServer));

			resetLspmuxStateForTesting();
			which.mockImplementation(command => (command === "lspmux" ? userLspmux : null));
			expect((await detectLspmux(cwd)).available).toBe(true);
			which.mockImplementation(command => (command === "typescript-language-server" ? userServer : null));
		}
	});

	it("treats a repository ..bin child as contained while preserving external executables", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-dotdot-child-trust-");
		const repositoryRoot = path.join(tempDir.path(), "repo");
		const repositoryBinDir = path.join(repositoryRoot, "..bin");
		const externalBinDir = path.join(tempDir.path(), "external-bin");
		const repositoryServer = path.join(repositoryBinDir, "typescript-language-server");
		const externalServer = path.join(externalBinDir, "typescript-language-server");
		const lspmuxCanary = path.join(repositoryRoot, "dotdot-lspmux-status-ran");
		await fs.promises.mkdir(path.join(repositoryRoot, ".git"), { recursive: true });
		await fs.promises.mkdir(repositoryBinDir, { recursive: true });
		await fs.promises.mkdir(externalBinDir, { recursive: true });
		await Bun.write(path.join(repositoryRoot, "package.json"), "{}\n");
		await Bun.write(repositoryServer, "");
		await Bun.write(externalServer, "");
		const repositoryLspmux = await writeLspmuxBinary(repositoryBinDir, lspmuxCanary);
		const externalLspmux = await writeLspmuxBinary(externalBinDir);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "typescript-language-server" ? repositoryServer : null));

		expect(loadConfig(repositoryRoot).servers["typescript-language-server"]).toBeUndefined();
		which.mockImplementation(command => (command === "typescript-language-server" ? externalServer : null));
		expect(loadConfig(repositoryRoot).servers["typescript-language-server"]?.resolvedCommand).toBe(
			fs.realpathSync(externalServer),
		);

		resetLspmuxStateForTesting();
		which.mockImplementation(command => (command === "lspmux" ? repositoryLspmux : null));
		expect((await detectLspmux(repositoryRoot)).available).toBe(false);
		expect(fs.existsSync(lspmuxCanary)).toBe(false);

		resetLspmuxStateForTesting();
		which.mockImplementation(command => (command === "lspmux" ? externalLspmux : null));
		expect((await detectLspmux(repositoryRoot)).available).toBe(true);
	});

	it("does not trust a user config symlink that resolves into the repository", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-config-symlink-trust-");
		const cwd = path.join(tempDir.path(), "repo");
		const home = path.join(tempDir.path(), "home");
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(home, { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(piUtils, "$which").mockReturnValue(null);

		const repositoryConfig = path.join(cwd, "repository-owned-lsp.json");
		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(
			repositoryConfig,
			JSON.stringify({
				servers: {
					"symlink-server": {
						command: process.execPath,
						args: ["malicious-script.ts"],
						fileTypes: [".symlink"],
						rootMarkers: ["package.json"],
					},
				},
			}),
		);
		await fs.promises.symlink(repositoryConfig, path.join(home, "lsp.json"));

		expect(loadConfig(cwd).servers["symlink-server"]).toBeUndefined();
	});

	it("keeps trusted user launch fields when repository config overrides server behavior", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-command-fields-");
		const cwd = tempDir.path();
		const configDirName = `.gjc-lsp-command-trust-${process.pid}-${Date.now()}`;
		// Issue #4794: user-scope config resolution goes through the trusted
		// home resolver, which only honors the REAL home (the os.homedir
		// binding is captured at import time and cannot be redirected by a
		// mock). The fixture stays under the real home, but its recursive
		// deletion is granted for exactly this process-created directory.
		const userConfigDir = path.join(os.homedir(), configDirName);
		const forgetGrant = registerOwnedDeletionRoot(userConfigDir);
		const userAgentDir = path.join(userConfigDir, "agent");
		const trustedServer = path.join(userConfigDir, "typescript-language-server");
		const originalAgentDir = getAgentDir();
		const originalAgentDirEnv = process.env.GJC_CODING_AGENT_DIR;
		fs.mkdirSync(userAgentDir, { recursive: true });
		fs.writeFileSync(trustedServer, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(trustedServer, 0o755);
		process.env.GJC_CONFIG_DIR = configDirName;
		setAgentDir(userAgentDir);
		await Bun.write(
			path.join(userAgentDir, "lsp.json"),
			JSON.stringify({
				servers: {
					"typescript-language-server": {
						command: trustedServer,
						args: ["--trusted-user-argument"],
						initOptions: { trustedInitialization: true },
						settings: { trustedSettings: true },
					},
				},
			}),
		);
		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"typescript-language-server": {
						command: process.execPath,
						args: ["malicious-script.ts"],
						resolvedCommand: process.execPath,
						fileTypes: [".secure-ts"],
						initializationOptions: { executeRepositoryCommand: true },
						settings: { executeRepositoryCommand: true },
					},
				},
			}),
		);

		try {
			const server = loadConfig(cwd).servers["typescript-language-server"];
			expect(server?.command).toBe(trustedServer);
			expect(server?.args).toEqual(["--trusted-user-argument"]);
			expect(server?.resolvedCommand).toBe(trustedServer);
			expect(server?.fileTypes).toEqual([".secure-ts"]);
			expect(server?.initOptions).toEqual({ trustedInitialization: true });
			expect(server?.settings).toEqual({ trustedSettings: true });
		} finally {
			safeRmSync(userConfigDir, { recursive: true, force: true });
			forgetGrant();
			setAgentDir(originalAgentDir);
			if (originalAgentDirEnv === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = originalAgentDirEnv;
		}
	});
});
