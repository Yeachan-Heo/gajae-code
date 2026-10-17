import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@gajae-code/utils";
import { TempDir } from "@gajae-code/utils";
import { registerOwnedDeletionRoot, safeRm, safeRmSync } from "../../../../scripts/safe-cleanup";
import * as discoveryHelpers from "../../src/discovery/helpers";
import { createLspWritethrough, LspTool } from "../../src/lsp";
import { shutdownAll } from "../../src/lsp/client";
import { loadConfig } from "../../src/lsp/config";
import { detectLspmux, getLspmuxCommand, resetLspmuxStateForTesting } from "../../src/lsp/lspmux";
import { isProjectControlledPath } from "../../src/lsp/path-trust";
import {
	getCurrentSessionLaunchEnvironment,
	setCurrentSessionLaunchEnvironment,
} from "../../src/sdk/session-environment";
import type { ToolSession } from "../../src/tools";

const ORIGINAL_DISABLE_LSPMUX = Bun.env.PI_DISABLE_LSPMUX;
const ORIGINAL_GJC_DISABLE_LSPMUX = Bun.env.GJC_DISABLE_LSPMUX;
const ORIGINAL_CONFIG_DIR = process.env.GJC_CONFIG_DIR;

/** Ancestors of `start` (inclusive) carrying a `.git` or `.gjc` project marker. */
function ancestorProjectMarkers(start: string): string[] {
	const markers: string[] = [];
	let current = path.resolve(start);
	for (;;) {
		for (const marker of [".git", ".gjc"]) {
			if (fs.existsSync(path.join(current, marker))) markers.push(path.join(current, marker));
		}
		const parent = path.dirname(current);
		if (parent === current) return markers;
		current = parent;
	}
}

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

	it("resolves built-in linter commands from the session PATH but rejects project binaries", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-session-path-");
		const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
		const cwd = path.join(repositoryRoot, "artifacts", `lsp-session-path-${process.pid}-${Date.now()}`);
		const sessionBin = path.join(tempDir.path(), "session-bin");
		const projectBin = path.join(cwd, "node_modules", ".bin");
		const executableName = process.platform === "win32" ? "biome.exe" : "biome";
		const sessionBiome = path.join(sessionBin, executableName);
		const projectBiome = path.join(projectBin, executableName);
		const sessionSwiftLint = path.join(sessionBin, process.platform === "win32" ? "swiftlint.exe" : "swiftlint");
		const projectSwiftLint = path.join(projectBin, process.platform === "win32" ? "swiftlint.exe" : "swiftlint");
		const forgetProjectGrant = registerOwnedDeletionRoot(cwd);
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(sessionBin, { recursive: true });
		await fs.promises.mkdir(projectBin, { recursive: true });
		await Bun.write(path.join(cwd, "biome.json"), "{}\n");
		await Bun.write(path.join(cwd, ".swiftlint.yml"), "{}\n");
		await Bun.write(sessionBiome, "#!/bin/sh\nexit 0\n");
		await Bun.write(projectBiome, "#!/bin/sh\nexit 0\n");
		await Bun.write(sessionSwiftLint, "#!/bin/sh\nexit 0\n");
		await Bun.write(projectSwiftLint, "#!/bin/sh\nexit 0\n");
		if (process.platform !== "win32") {
			await fs.promises.chmod(sessionBiome, 0o755);
			await fs.promises.chmod(projectBiome, 0o755);
			await fs.promises.chmod(sessionSwiftLint, 0o755);
			await fs.promises.chmod(projectSwiftLint, 0o755);
		}

		const previousSessionEnvironment = getCurrentSessionLaunchEnvironment();
		try {
			setCurrentSessionLaunchEnvironment({ env: { PATH: sessionBin } });
			expect(loadConfig(cwd).servers.biome?.resolvedCommand).toBe(sessionBiome);
			expect(loadConfig(cwd).servers.swiftlint?.resolvedCommand).toBe(sessionSwiftLint);

			setCurrentSessionLaunchEnvironment({ env: { PATH: projectBin } });
			expect(loadConfig(cwd).servers.biome).toBeUndefined();
			expect(loadConfig(cwd).servers.swiftlint).toBeUndefined();
		} finally {
			setCurrentSessionLaunchEnvironment(previousSessionEnvironment);
			safeRmSync(cwd, { recursive: true, force: true });
			forgetProjectGrant();
		}
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

	it("reports configured language servers before a client starts", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-configured-status-");
		const cwd = path.join(tempDir.path(), "repo");
		const externalBinDir = path.join(os.homedir(), `.gjc-lsp-configured-status-${process.pid}-${Date.now()}`);
		const rustAnalyzer = path.join(externalBinDir, "rust-analyzer");
		const forgetExternalGrant = registerOwnedDeletionRoot(externalBinDir);
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(externalBinDir, { recursive: true });
		try {
			await Bun.write(path.join(cwd, "Cargo.toml"), "[package]\n");
			await Bun.write(rustAnalyzer, "");
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "rust-analyzer" ? rustAnalyzer : null));

			const tool = new LspTool({ cwd } as ToolSession);
			const result = await tool.execute("configured-status", { action: "status" });

			expect(result.content).toEqual([{ type: "text", text: "Configured language servers: rust-analyzer" }]);
			expect(result.details?.success).toBe(true);
		} finally {
			await safeRm(externalBinDir, { recursive: true, force: true });
			forgetExternalGrant();
		}
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
		expect(loadConfig(repositoryRoot).servers["typescript-language-server"]?.resolvedCommand).toBe(externalSymlink);
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
		expect(loadConfig(cwd).servers["typescript-language-server"]?.resolvedCommand).toBe(userServer);
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
			expect(server?.resolvedCommand).toBe(userServer);

			resetLspmuxStateForTesting();
			which.mockImplementation(command => (command === "lspmux" ? userLspmux : null));
			expect((await detectLspmux(cwd)).available).toBe(true);
			which.mockImplementation(command => (command === "typescript-language-server" ? userServer : null));
		}
	});

	it("keeps the invocation path for a trusted symlinked launcher so rustup-style proxies see argv[0]", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-symlink-launcher-");
		const home = path.join(tempDir.path(), "home");
		const cwd = path.join(home, "workspace");
		const cargoBin = path.join(home, ".cargo", "bin");
		const rustup = path.join(cargoBin, "rustup");
		const rustAnalyzer = path.join(cargoBin, "rust-analyzer");
		await fs.promises.mkdir(cargoBin, { recursive: true });
		await fs.promises.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(cwd, "Cargo.toml"), "[package]\n");
		await Bun.write(rustup, "#!/bin/sh\nexit 0\n");
		await fs.promises.chmod(rustup, 0o755);
		await fs.promises.symlink("rustup", rustAnalyzer);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "rust-analyzer" ? rustAnalyzer : null));

		const server = loadConfig(cwd).servers["rust-analyzer"];
		expect(fs.realpathSync(rustAnalyzer)).toBe(rustup);
		expect(server?.resolvedCommand).toBe(rustAnalyzer);
	});

	it("still rejects a symlinked launcher whose invocation path is project-controlled", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-symlink-project-");
		const home = path.join(tempDir.path(), "home");
		const cwd = path.join(home, "workspace");
		const cargoBin = path.join(home, ".cargo", "bin");
		const rustup = path.join(cargoBin, "rustup");
		const projectLink = path.join(cwd, "bin", "rust-analyzer");
		await fs.promises.mkdir(cargoBin, { recursive: true });
		await fs.promises.mkdir(path.join(cwd, "bin"), { recursive: true });
		await fs.promises.mkdir(path.join(cwd, ".git"), { recursive: true });
		await Bun.write(path.join(cwd, "Cargo.toml"), "[package]\n");
		await Bun.write(rustup, "#!/bin/sh\nexit 0\n");
		await fs.promises.chmod(rustup, 0o755);
		await fs.promises.symlink(rustup, projectLink);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "rust-analyzer" ? projectLink : null));

		expect(loadConfig(cwd).servers["rust-analyzer"]).toBeUndefined();
	});

	it("keeps HOME executables exempt from an ancestor cwd when HOME is a symlink, under either spelling", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-home-alias-trust-");
		const canonicalHome = path.join(tempDir.path(), "home");
		const lexicalHome = path.join(tempDir.path(), "home-link");
		const userBin = path.join(canonicalHome, ".gjc", "bin");
		await fs.promises.mkdir(userBin, { recursive: true });
		await fs.promises.symlink(canonicalHome, lexicalHome);
		const server = path.join(userBin, "typescript-language-server");
		await Bun.write(server, "");
		const lexicalServer = path.join(lexicalHome, ".gjc", "bin", "typescript-language-server");

		// cwd is HOME's parent with no project marker: its fallback trust root
		// contains HOME, so only the home exemption keeps user executables trusted.
		// Both homedir spellings must accept both candidate spellings.
		const cwd = tempDir.path();
		expect(ancestorProjectMarkers(cwd)).toEqual([]);
		const projectFile = path.join(cwd, "typescript-language-server");
		await Bun.write(projectFile, "");
		for (const homedir of [lexicalHome, canonicalHome]) {
			vi.spyOn(os, "homedir").mockReturnValue(homedir);
			expect(isProjectControlledPath(lexicalServer, cwd)).toBe(false);
			expect(isProjectControlledPath(server, cwd)).toBe(false);
			// A project file directly under that same ancestor cwd is still owned.
			expect(isProjectControlledPath(projectFile, cwd)).toBe(true);
		}
	});

	it("keeps owning a project directory that links into HOME from a canonically spelled cwd", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-home-alias-project-link-");
		const canonicalHome = path.join(tempDir.path(), "home");
		const lexicalHome = path.join(tempDir.path(), "home-link");
		const userBin = path.join(canonicalHome, ".gjc", "bin");
		const repo = path.join(canonicalHome, "repo");
		await fs.promises.mkdir(userBin, { recursive: true });
		await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
		await fs.promises.symlink(canonicalHome, lexicalHome);
		await Bun.write(path.join(userBin, "typescript-language-server"), "");
		// repo/bin is a project-owned directory symlink into HOME.
		await fs.promises.symlink(userBin, path.join(repo, "bin"));
		const projectCandidate = path.join(repo, "bin", "typescript-language-server");

		for (const homedir of [lexicalHome, canonicalHome]) {
			vi.spyOn(os, "homedir").mockReturnValue(homedir);
			for (const cwd of [repo, path.join(lexicalHome, "repo")]) {
				expect(isProjectControlledPath(projectCandidate, cwd)).toBe(true);
				expect(
					isProjectControlledPath(path.join(lexicalHome, "repo", "bin", "typescript-language-server"), cwd),
				).toBe(true);
			}
		}
	});

	it("rejects home-crossing symlinks in both directions when the repository is a sibling of HOME", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-sibling-home-trust-");
		const home = path.join(tempDir.path(), "home");
		const repo = path.join(tempDir.path(), "repo");
		const cargoBin = path.join(home, ".cargo", "bin");
		const rustup = path.join(cargoBin, "rustup");
		await fs.promises.mkdir(cargoBin, { recursive: true });
		await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
		await fs.promises.mkdir(path.join(repo, "bin"), { recursive: true });
		await Bun.write(path.join(repo, "Cargo.toml"), "[package]\n");
		await Bun.write(rustup, "#!/bin/sh\nexit 0\n");
		await fs.promises.chmod(rustup, 0o755);
		vi.spyOn(os, "homedir").mockReturnValue(home);

		// Project-owned link whose target is a trusted HOME executable: the link
		// itself is project-writable, so it must be rejected.
		const projectLink = path.join(repo, "bin", "rust-analyzer");
		await fs.promises.symlink(rustup, projectLink);
		expect(isProjectControlledPath(projectLink, repo)).toBe(true);
		const which = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "rust-analyzer" ? projectLink : null));
		expect(loadConfig(repo).servers["rust-analyzer"]).toBeUndefined();

		// HOME-owned link whose target is project content: the executable bytes
		// are project-controlled, so it must be rejected as well.
		const evilTarget = path.join(repo, "evil-rustup");
		await Bun.write(evilTarget, "#!/bin/sh\nexit 0\n");
		await fs.promises.chmod(evilTarget, 0o755);
		const homeLink = path.join(home, ".local", "bin", "rust-analyzer");
		await fs.promises.mkdir(path.dirname(homeLink), { recursive: true });
		await fs.promises.symlink(evilTarget, homeLink);
		expect(isProjectControlledPath(homeLink, repo)).toBe(true);
		which.mockImplementation(command => (command === "rust-analyzer" ? homeLink : null));
		expect(loadConfig(repo).servers["rust-analyzer"]).toBeUndefined();

		// A genuinely external HOME link to a HOME target stays trusted.
		const goodLink = path.join(home, ".local", "bin", "rust-analyzer-good");
		await fs.promises.symlink(rustup, goodLink);
		expect(isProjectControlledPath(goodLink, repo)).toBe(false);

		// A project-owned directory alias to HOME itself is project content: the
		// invocation path stays under the repository, so it is still owned.
		const homeAlias = path.join(repo, "home-link");
		await fs.promises.symlink(home, homeAlias);
		const aliasedCandidate = path.join(homeAlias, ".cargo", "bin", "rustup");
		expect(isProjectControlledPath(aliasedCandidate, repo)).toBe(true);
		which.mockImplementation(command => (command === "rust-analyzer" ? aliasedCandidate : null));
		expect(loadConfig(repo).servers["rust-analyzer"]).toBeUndefined();
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
		fs.mkdirSync(userAgentDir, { recursive: true });
		fs.writeFileSync(trustedServer, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(trustedServer, 0o755);
		process.env.GJC_CONFIG_DIR = configDirName;
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
		}
	});
});
