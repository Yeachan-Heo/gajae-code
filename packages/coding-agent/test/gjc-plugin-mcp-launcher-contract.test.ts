import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	assertMcpInstallPolicy,
	buildPluginMcpConfigs,
	type GjcPluginMcpManifestEntry,
	installGjcBundle,
	readRegistry,
	registryPathForScope,
} from "../src/extensibility/gjc-plugins";
import { MCPExpectedFailure, MCPManager, StdioTransport } from "../src/runtime-mcp";
import type { MCPStdioSpawnLaunch } from "../src/runtime-mcp/types";

const originalAgentDir = getAgentDir();
const tempDirs: string[] = [];
const managers: MCPManager[] = [];
const testOnLinux = test.skipIf(process.platform !== "linux");

beforeEach(async () => {
	setAgentDir(await tempDir("gjc-plugin-launcher-agent-"));
});

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.disconnectAll().catch(() => {});
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function readTextEventually(filePath: string, timeoutMs = 5_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await fs.readFile(filePath, "utf8");
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${filePath}`, { cause: lastError });
}

function stdio(command: "node" | "bun", args: string[], cwd = "."): GjcPluginMcpManifestEntry {
	return { name: "launcher-contract", transport: "stdio", command, args, cwd };
}

function trustedSnapshotBase(): string {
	return process.platform === "win32"
		? path.join(os.tmpdir(), "gjc-plugin-mcp-private")
		: path.join("/tmp", `gjc-plugin-mcp-${process.getuid?.() ?? process.pid}`);
}

async function writeBundle(
	root: string,
	input: {
		name: string;
		command: string;
		args?: string[];
		cwd?: string;
		serverPath?: string;
		server?: string;
		ownedFiles?: Record<string, string>;
	},
): Promise<void> {
	const serverPath = input.serverPath ?? "mcp/server.mjs";
	if (input.server !== undefined) {
		await fs.mkdir(path.dirname(path.join(root, serverPath)), { recursive: true });
		await fs.writeFile(path.join(root, serverPath), input.server);
	}
	for (const [relativePath, content] of Object.entries(input.ownedFiles ?? {})) {
		await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
		await fs.writeFile(path.join(root, relativePath), content);
	}
	await fs.writeFile(
		path.join(root, "gajae-plugin.json"),
		JSON.stringify({
			kind: "gajae-code-plugin",
			name: input.name,
			version: "1.0.0",
			mcps: [
				{
					name: input.name,
					transport: "stdio",
					command: input.command,
					args: input.args ?? [serverPath],
					cwd: input.cwd ?? ".",
				},
			],
			system_appendix: Object.keys(input.ownedFiles ?? {}).map((relativePath, index) => ({
				name: `owned-launch-config-${index}`,
				path: relativePath,
			})),
		}),
	);
}

function mcpServer(reportPath?: string): string {
	const report = reportPath
		? `writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ ambient: process.env.GJC_PLUGIN_AMBIENT ?? null }));`
		: "";
	return `
import { writeFileSync } from "node:fs";
import * as readline from "node:readline";
${report}
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "launcher-contract", version: "1" } } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] } });
  else if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

async function connect(
	cwd: string,
	name: string,
): Promise<{ command: string | undefined; args: string[] | undefined; errors: unknown[] }> {
	const runtime = await buildPluginMcpConfigs({ cwd });
	expect(runtime.quarantine).toEqual([]);
	const manager = new MCPManager(cwd);
	managers.push(manager);
	const connected = await manager.connectServers(runtime.configs, {
		[name]: { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
	} as never);
	return {
		command: runtime.configs[name]?.command,
		args: runtime.configs[name]?.args,
		errors: [...connected.errors.entries()],
	};
}

async function expectBunLaunchRefused(cwd: string, name: string): Promise<void> {
	const runtime = await buildPluginMcpConfigs({ cwd });
	if (process.platform !== "linux") {
		expect(runtime.configs[name]).toBeUndefined();
		expect(runtime.quarantine).toContainEqual(
			expect.objectContaining({
				plugin: name,
				code: "security_policy",
				message: "Authenticated plugin MCP stdio launch capsules are available only on Linux",
			}),
		);
		return;
	}
	const config = runtime.configs[name];
	expect(runtime.quarantine).toEqual([]);
	if (config?.type !== "stdio" || typeof config.prepareSpawn !== "function") {
		throw new Error(`missing Bun refusal config: ${name}`);
	}
	let cleanupRegistered = false;
	await expect(
		config.prepareSpawn({
			command: config.command,
			args: config.args ?? [],
			cwd: config.cwd,
			registerCleanup: () => {
				cleanupRegistered = true;
			},
		}),
	).rejects.toThrow("Authenticated plugin MCP Bun launch capsules are unavailable");
	expect(cleanupRegistered).toBe(false);
}

function runtimeServerArgs(args: readonly string[] | undefined): string[] {
	return (args ?? []).slice(1);
}

describe("bundled plugin MCP launcher contract", () => {
	test("rejects every manifest-controlled pre-entrypoint option and malformed launcher form", () => {
		const root = path.resolve("/tmp/plugin-root");
		const rejected = [
			stdio("bun", ["-r../outside.ts", "server.ts"]),
			stdio("bun", ["--preload=../outside.ts", "server.ts"]),
			stdio("bun", ["--cwd=../outside", "server.ts"]),
			stdio("bun", ["--cwd", "../outside", "server.ts"]),
			stdio("bun", ["--config=../outside.toml", "server.ts"]),
			stdio("bun", ["--env-file=../outside.env", "server.ts"]),
			stdio("bun", ["--tsconfig-override=../outside.json", "server.ts"]),
			stdio("bun", ["--install=force", "server.ts"]),
			stdio("node", ["-r../outside.cjs", "server.mjs"]),
			stdio("node", ["--import=../outside.mjs", "server.mjs"]),
			stdio("node", ["--experimental-config-file=../outside.json", "server.mjs"]),
			stdio("node", ["--env-file=../outside.env", "server.mjs"]),
			stdio("node", ["--run", "server.mjs"]),
			stdio("node", []),
			stdio("bun", ["--"]),
			stdio("node", ["--", "server.mjs"]),
		];
		for (const entry of rejected) {
			expect(() => assertMcpInstallPolicy(entry, { pluginRoot: root })).toThrow();
		}
	});

	test("classifies POSIX and Windows path forms consistently on every host", () => {
		const root = path.resolve("/tmp/plugin-root");
		for (const entry of [
			{ ...stdio("node", ["C:\\outside\\server.mjs"]), command: "node" },
			{ ...stdio("bun", ["..\\outside\\server.ts"]), command: "bun" },
			{ ...stdio("node", ["server.mjs"], "..\\outside"), command: "node" },
			{ ...stdio("node", ["server.mjs"]), command: "C:\\Program Files\\nodejs\\node.exe" },
			{ ...stdio("bun", ["server.ts"]), command: "/usr/bin/bun" },
		]) {
			expect(() => assertMcpInstallPolicy(entry, { pluginRoot: root })).toThrow();
		}
		expect(() =>
			assertMcpInstallPolicy({ ...stdio("bun", [], "bin"), command: ".\\server" }, { pluginRoot: root }),
		).toThrow();
	});

	test("keeps launcher flags after the owned entrypoint as opaque server arguments", () => {
		const root = path.resolve("/tmp/plugin-root");
		for (const command of ["node", "bun"] as const) {
			expect(() =>
				assertMcpInstallPolicy(stdio(command, ["server.mjs", "--config=server-value", "--cwd=server-value"]), {
					pluginRoot: root,
				}),
			).not.toThrow();
		}
	});

	test("requires the direct launcher entrypoint to exist inside the effective manifest cwd", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-project-");
		const missingCwd = await tempDir("gjc-plugin-launcher-missing-cwd-");
		await writeBundle(missingCwd, {
			name: "missing-cwd",
			command: "bun",
			args: ["../server.mjs"],
			cwd: "missing",
			serverPath: "server.mjs",
			server: mcpServer(),
		});
		await expect(installGjcBundle({ cwd }, "project", missingCwd)).rejects.toMatchObject({ code: "missing_file" });

		const missing = await tempDir("gjc-plugin-launcher-missing-");
		await writeBundle(missing, { name: "missing-entry", command: "bun", args: ["server.ts"] });
		await expect(installGjcBundle({ cwd }, "project", missing)).rejects.toMatchObject({ code: "missing_file" });

		const outside = await tempDir("gjc-plugin-launcher-outside-");
		await fs.writeFile(path.join(outside, "server.ts"), mcpServer());
		const symlinked = await tempDir("gjc-plugin-launcher-symlink-");
		await fs.symlink(path.join(outside, "server.ts"), path.join(symlinked, "server.ts"));
		await writeBundle(symlinked, { name: "symlink-entry", command: "bun", args: ["server.ts"] });
		await expect(installGjcBundle({ cwd }, "project", symlinked)).rejects.toMatchObject({ code: "security_policy" });

		const symlinkedCwd = await tempDir("gjc-plugin-launcher-symlink-cwd-");
		await fs.symlink(outside, path.join(symlinkedCwd, "mcp"));
		await writeBundle(symlinkedCwd, {
			name: "symlink-cwd",
			command: "bun",
			args: ["server.ts"],
			cwd: "mcp",
		});
		await expect(installGjcBundle({ cwd }, "project", symlinkedCwd)).rejects.toMatchObject({
			code: "security_policy",
		});
	});

	testOnLinux(
		"copies a cwd-relative bare entrypoint and connects it after the source is removed",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-project-");
			const source = await tempDir("gjc-plugin-launcher-source-");
			await writeBundle(source, {
				name: "direct-entry",
				command: "node",
				args: ["server.mjs", "--config=ordinary-server-arg"],
				cwd: "mcp",
				serverPath: "mcp/server.mjs",
				server: mcpServer(),
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const registry = await readRegistry("project", cwd);
			expect(registry.plugins[0]?.copiedFiles.map(file => file.relativePath)).toContain(
				path.join("mcp", "server.mjs"),
			);
			await fs.rm(source, { recursive: true, force: true });

			const connected = await connect(cwd, "direct-entry");
			expect(connected.errors).toEqual([]);
			expect(path.isAbsolute(connected.command ?? "")).toBe(true);
			expect(path.relative(cwd, connected.command ?? "").startsWith("..")).toBe(true);
			expect(runtimeServerArgs(connected.args)).toEqual(["--config=ordinary-server-arg"]);
		},
		30_000,
	);

	testOnLinux(
		"preserves an otherwise-empty effective cwd for a sibling entrypoint",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-project-");
			const source = await tempDir("gjc-plugin-launcher-empty-cwd-");
			await fs.mkdir(path.join(source, "empty-cwd"));
			await writeBundle(source, {
				name: "empty-cwd",
				command: "node",
				args: ["../server.mjs"],
				cwd: "empty-cwd",
				serverPath: "server.mjs",
				server: mcpServer(),
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const entry = (await readRegistry("project", cwd)).plugins[0];
			await fs.rm(source, { recursive: true, force: true });

			await expect(fs.stat(path.join(entry?.pluginRoot ?? "", "empty-cwd"))).resolves.toMatchObject({});
			const connected = await connect(cwd, "empty-cwd");
			expect(connected.errors).toEqual([]);
		},
		30_000,
	);

	test("refuses authenticated stdio launch capsules explicitly on non-Linux platforms", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-non-linux-project-");
		const source = await tempDir("gjc-plugin-launcher-non-linux-source-");
		await writeBundle(source, { name: "non-linux-refusal", command: "node", server: mcpServer() });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
		try {
			for (const platform of ["darwin", "win32"] as const) {
				Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
				const runtime = await buildPluginMcpConfigs({ cwd });
				expect(runtime.configs["non-linux-refusal"]).toBeUndefined();
				expect(runtime.quarantine).toContainEqual(
					expect.objectContaining({
						plugin: "non-linux-refusal",
						code: "security_policy",
						message: "Authenticated plugin MCP stdio launch capsules are available only on Linux",
					}),
				);
			}
		} finally {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	testOnLinux(
		"preserves direct Node entrypoints while rewriting them to the installed owned file",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-node-project-");
			const source = await tempDir("gjc-plugin-launcher-node-source-");
			await writeBundle(source, {
				name: "node-entry",
				command: "node",
				args: ["server.mjs", "--cwd=ordinary-server-arg"],
				cwd: "mcp",
				server: mcpServer(),
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const entry = (await readRegistry("project", cwd)).plugins[0];
			const connected = await connect(cwd, "node-entry");
			expect(connected.errors).toEqual([]);
			expect(path.basename(connected.command ?? "")).toBe(process.platform === "win32" ? "node.exe" : "node");
			expect(entry?.copiedFiles.map(file => file.relativePath)).toContain(path.join("mcp", "server.mjs"));
			expect(runtimeServerArgs(connected.args)).toEqual(["--cwd=ordinary-server-arg"]);
		},
		30_000,
	);

	testOnLinux(
		"runs relative imports from an authenticated file snapshot",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-import-project-");
			const source = await tempDir("gjc-plugin-launcher-import-source-");
			const reportPath = path.join(await tempDir("gjc-plugin-launcher-import-report-"), "report.json");
			const server = mcpServer().replace(
				'import { writeFileSync } from "node:fs";',
				`import { writeFileSync } from "node:fs";
import { helperValue } from "./helper.mjs";
writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ helperValue, entrypointUrl: import.meta.url, cwd: process.cwd() }));`,
			);
			await writeBundle(source, {
				name: "relative-import",
				command: "node",
				server,
				ownedFiles: { "mcp/helper.mjs": 'export const helperValue = "trusted";\n' },
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const entry = (await readRegistry("project", cwd)).plugins[0];

			const connected = await connect(cwd, "relative-import");
			expect(connected.errors).toEqual([]);
			const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
				helperValue: string;
				entrypointUrl: string;
				cwd: string;
			};
			expect(report.helperValue).toBe("trusted");
			expect(report.entrypointUrl.startsWith("file:")).toBe(true);
			expect(report.entrypointUrl).not.toContain(entry?.pluginRoot ?? "");
			expect(path.basename(new URL(report.entrypointUrl).pathname)).toBe("server.mjs");
			expect(path.basename(path.dirname(report.cwd)).startsWith("gjc-plugin-mcp-")).toBe(true);
			expect(path.basename(report.cwd)).toBe("bundle");
			expect(report.cwd).not.toBe(path.join(entry?.pluginRoot ?? "", "mcp"));
		},
		30_000,
	);

	testOnLinux(
		"serves authenticated bytes when a delayed import follows capsule mutation",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-delayed-import-project-");
			const source = await tempDir("gjc-plugin-launcher-delayed-import-source-");
			const markerDir = await tempDir("gjc-plugin-launcher-delayed-import-marker-");
			const snapshotRootReport = path.join(markerDir, "snapshot-root.txt");
			const releasePath = path.join(markerDir, "release.txt");
			const resultPath = path.join(markerDir, "result.txt");
			const replacementMarker = path.join(markerDir, "replacement-ran.txt");
			const server = mcpServer().replace(
				'import { writeFileSync } from "node:fs";',
				`import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(snapshotRootReport)}, process.cwd());
void (async () => {
  for (;;) {
    try {
      readFileSync(${JSON.stringify(releasePath)});
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    const { helperValue } = await import("./helper.mjs");
    writeFileSync(${JSON.stringify(resultPath)}, helperValue);
  } catch {
    writeFileSync(${JSON.stringify(resultPath)}, "failclosed");
  }
})();`,
			);
			await writeBundle(source, {
				name: "delayed-import-mutation",
				command: "node",
				server,
				ownedFiles: { "mcp/helper.mjs": 'export const helperValue = "trusted";\n' },
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const runtime = await buildPluginMcpConfigs({ cwd });
			const config = runtime.configs["delayed-import-mutation"];
			if (!config || config.type === "http" || config.type === "sse") throw new Error("missing stdio config");
			const manager = new MCPManager(cwd);
			managers.push(manager);
			const connected = await manager.connectServers(runtime.configs, {
				"delayed-import-mutation": {
					provider: "gjc-plugins",
					providerName: "GJC plugin bundle",
					level: "project",
				},
			} as never);
			expect([...connected.errors.entries()]).toEqual([]);

			const snapshotRoot = await readTextEventually(snapshotRootReport);
			const snapshotHelper = path.join(snapshotRoot, "mcp/helper.mjs");
			const replacement = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(replacementMarker)}, "ran"); export const helperValue = "replacement";\n`;
			const replacementPath = `${snapshotHelper}.replacement`;
			await fs.writeFile(replacementPath, replacement, { mode: 0o400 });
			await fs.rename(replacementPath, snapshotHelper);
			expect(await fs.readFile(snapshotHelper, "utf8")).toBe(replacement);
			await fs.writeFile(releasePath, "release\n");

			expect(["trusted", "failclosed"]).toContain(await readTextEventually(resultPath));
			await expect(fs.readFile(replacementMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		},
		30_000,
	);

	testOnLinux(
		"rejects bare package resolution outside the authenticated snapshot",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-package-project-");
			const source = await tempDir("gjc-plugin-launcher-package-source-");
			const snapshotBase = trustedSnapshotBase();
			const marker = path.join(await tempDir("gjc-plugin-launcher-package-marker-"), "outside-package-ran.txt");
			const packageRoot = path.join(snapshotBase, "node_modules", "outside-package");
			await fs.mkdir(packageRoot, { recursive: true });
			await fs.chmod(snapshotBase, 0o700);
			await fs.writeFile(path.join(packageRoot, "package.json"), '{"type":"module","exports":"./index.mjs"}\n');
			await fs.writeFile(
				path.join(packageRoot, "index.mjs"),
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
			);
			await writeBundle(source, {
				name: "outside-package",
				command: "node",
				server: `import "outside-package";\n${mcpServer()}`,
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			try {
				const connected = await connect(cwd, "outside-package");
				expect(connected.errors).toHaveLength(1);
				await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.rm(packageRoot, { recursive: true, force: true });
			}
		},
		30_000,
	);

	testOnLinux(
		"rejects createRequire before CommonJS can escape the authenticated snapshot",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-require-project-");
			const source = await tempDir("gjc-plugin-launcher-require-source-");
			const outside = await tempDir("gjc-plugin-launcher-require-outside-");
			const marker = path.join(outside, "commonjs-ran.txt");
			const commonJs = path.join(outside, "outside.cjs");
			await fs.writeFile(commonJs, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
			await writeBundle(source, {
				name: "outside-commonjs",
				command: "node",
				server: `import { createRequire } from "node:module"; createRequire(import.meta.url)(${JSON.stringify(commonJs)});\n${mcpServer()}`,
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const connected = await connect(cwd, "outside-commonjs");
			expect(connected.errors).toHaveLength(1);
			await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		},
		30_000,
	);

	test("rejects Bun createRequire and direct require before external CommonJS runs", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-bun-require-project-");
		const outside = await tempDir("gjc-plugin-launcher-bun-require-outside-");
		for (const [name, expression] of [
			["bun-create-require", 'import { createRequire } from "node:module"; createRequire(import.meta.url)'],
			["bun-direct-require", "require"],
		] as const) {
			const source = await tempDir(`gjc-plugin-launcher-${name}-`);
			const marker = path.join(outside, `${name}.txt`);
			const commonJs = path.join(outside, `${name}.cjs`);
			await fs.writeFile(commonJs, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
			await writeBundle(source, {
				name,
				command: "bun",
				server: `${expression}(${JSON.stringify(commonJs)});\n${mcpServer()}`,
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			await expectBunLaunchRefused(cwd, name);
			await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		}
	}, 30_000);

	testOnLinux(
		"reaps a dead owner's bounded launch capsule before creating a new one",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-reap-project-");
			const source = await tempDir("gjc-plugin-launcher-reap-source-");
			await writeBundle(source, { name: "stale-reap", command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const base = trustedSnapshotBase();
			await fs.mkdir(base, { recursive: true, mode: 0o700 });
			await fs.chmod(base, 0o700);
			const stale = path.join(base, "gjc-plugin-mcp-99999999-00000000000000000000000000000000");
			await fs.mkdir(stale, { mode: 0o700 });
			await fs.writeFile(path.join(stale, "orphan.txt"), "orphan\n");

			const connected = await connect(cwd, "stale-reap");
			expect(connected.errors).toEqual([]);
			await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
		},
		30_000,
	);

	testOnLinux(
		"supports concurrent launches from one authenticated config without sharing snapshots",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-concurrent-project-");
			const source = await tempDir("gjc-plugin-launcher-concurrent-source-");
			await writeBundle(source, { name: "concurrent-snapshot", command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const runtime = await buildPluginMcpConfigs({ cwd });
			const config = runtime.configs["concurrent-snapshot"];
			if (!config || config.type === "http" || config.type === "sse" || !config.prepareSpawn) {
				throw new Error("missing stdio preparation");
			}
			const prepareSpawn = config.prepareSpawn;
			const snapshotRoots = new Set<string>();
			let registeredCleanups = 0;
			config.prepareSpawn = async (launch: MCPStdioSpawnLaunch) => {
				const prepared = await prepareSpawn({
					...launch,
					registerCleanup: (cleanup: () => Promise<void>) => {
						registeredCleanups++;
						launch.registerCleanup?.(cleanup);
					},
				});
				snapshotRoots.add(path.dirname(prepared.command));
				return prepared;
			};
			const provenance = {
				"concurrent-snapshot": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
			} as never;
			const first = new MCPManager(cwd);
			const second = new MCPManager(cwd);
			managers.push(first, second);
			const [firstResult, secondResult] = await Promise.all([
				first.connectServers(runtime.configs, provenance),
				second.connectServers(runtime.configs, provenance),
			]);
			expect([...firstResult.errors.entries()]).toEqual([]);
			expect([...secondResult.errors.entries()]).toEqual([]);
			expect(registeredCleanups).toBe(2);
			expect(snapshotRoots.size).toBe(2);
			await Promise.all([first.disconnectAll(), second.disconnectAll()]);
			for (const snapshotRoot of snapshotRoots) {
				await expect(fs.stat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
			}
		},
		30_000,
	);

	testOnLinux(
		"preserves an unclaimed colliding capsule root when mkdir reports EEXIST",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-capsule-eexist-project-");
			const source = await tempDir("gjc-plugin-launcher-capsule-eexist-source-");
			await writeBundle(source, { name: "capsule-eexist", command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const runtime = await buildPluginMcpConfigs({ cwd });
			const config = runtime.configs["capsule-eexist"];
			if (!config || config.type === "http" || config.type === "sse" || !config.prepareSpawn) {
				throw new Error("missing stdio preparation");
			}
			const prepareSpawn = config.prepareSpawn;
			let registeredCleanups = 0;
			let cleanupAttempts = 0;
			config.prepareSpawn = (launch: MCPStdioSpawnLaunch) => {
				const registerCleanup = launch.registerCleanup;
				if (!registerCleanup) throw new Error("missing stdio cleanup registrar");
				return prepareSpawn({
					...launch,
					registerCleanup: (cleanup: () => Promise<void>) => {
						registeredCleanups++;
						registerCleanup(async () => {
							cleanupAttempts++;
							await cleanup();
						});
					},
				});
			};

			const originalMkdir = fs.mkdir.bind(fs);
			let sentinelRoot: string | undefined;
			const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
				const targetPath = String(target);
				if (/^gjc-plugin-mcp-\d+-[a-f0-9]{32}$/u.test(path.basename(targetPath))) {
					sentinelRoot = targetPath;
					await originalMkdir(target, options);
					await fs.writeFile(path.join(targetPath, "unrelated-sentinel.txt"), "unrelated authority\n");
					throw Object.assign(new Error("synthetic capsule root collision"), { code: "EEXIST" });
				}
				await originalMkdir(target, options);
			});
			const spawnSpy = vi.spyOn(Bun, "spawn");
			const transport = new StdioTransport(config);
			try {
				await expect(transport.connect()).rejects.toThrow("synthetic capsule root collision");
				expect(registeredCleanups).toBe(1);
				expect(cleanupAttempts).toBe(1);
				expect(spawnSpy).not.toHaveBeenCalled();
				const preservedRoot = sentinelRoot;
				if (!preservedRoot) throw new Error("missing colliding capsule root");
				expect(await fs.readFile(path.join(preservedRoot, "unrelated-sentinel.txt"), "utf8")).toBe(
					"unrelated authority\n",
				);
			} finally {
				try {
					await transport.close();
				} finally {
					mkdirSpy.mockRestore();
					spawnSpy.mockRestore();
					if (sentinelRoot) await fs.rm(sentinelRoot, { recursive: true, force: true });
				}
			}
		},
		30_000,
	);

	testOnLinux(
		"retains a preparation-failed capsule until explicit close retries removal",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-preparation-cleanup-project-");
			const source = await tempDir("gjc-plugin-launcher-preparation-cleanup-source-");
			await writeBundle(source, { name: "preparation-cleanup", command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const runtime = await buildPluginMcpConfigs({ cwd });
			const config = runtime.configs["preparation-cleanup"];
			if (!config || config.type === "http" || config.type === "sse" || !config.prepareSpawn) {
				throw new Error("missing stdio preparation");
			}
			const prepareSpawn = config.prepareSpawn;
			const preparationFailure = new Error("synthetic plugin capsule preparation failure");
			const rmFailure = new Error("synthetic plugin capsule rm failure");
			let prepareAttempts = 0;
			let cleanupAttempts = 0;
			let capsuleRoot: string | undefined;
			config.prepareSpawn = async (launch: MCPStdioSpawnLaunch) => {
				prepareAttempts++;
				const registerCleanup = launch.registerCleanup;
				if (!registerCleanup) throw new Error("missing stdio cleanup registrar");
				const prepared = await prepareSpawn({
					...launch,
					registerCleanup: (cleanup: () => Promise<void>) => {
						registerCleanup(async () => {
							cleanupAttempts++;
							if (cleanupAttempts === 1) throw rmFailure;
							await cleanup();
						});
					},
				});
				capsuleRoot = path.dirname(prepared.command);
				tempDirs.push(capsuleRoot);
				throw preparationFailure;
			};

			const transport = new StdioTransport(config);
			let failure: unknown;
			try {
				await transport.connect();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(MCPExpectedFailure);
			const combined = failure instanceof Error ? failure.cause : undefined;
			expect(combined).toBeInstanceOf(AggregateError);
			if (!(combined instanceof AggregateError)) throw new Error("Expected combined capsule cleanup failure");
			expect(combined.errors).toEqual([preparationFailure, rmFailure]);
			expect(prepareAttempts).toBe(1);
			expect(cleanupAttempts).toBe(1);
			const preparedCapsuleRoot = capsuleRoot;
			if (!preparedCapsuleRoot) throw new Error("missing prepared capsule root");
			await expect(fs.stat(preparedCapsuleRoot)).resolves.toMatchObject({});

			await expect(transport.connect()).rejects.toThrow("MCP stdio child teardown is incomplete");
			expect(prepareAttempts).toBe(1);
			expect(cleanupAttempts).toBe(1);

			await transport.close();
			expect(cleanupAttempts).toBe(2);
			await expect(fs.stat(preparedCapsuleRoot)).rejects.toMatchObject({ code: "ENOENT" });
			await transport.close();
			expect(cleanupAttempts).toBe(2);
		},
		30_000,
	);

	testOnLinux(
		"removes authenticated snapshots after forced termination and reconnect",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-cleanup-project-");
			const source = await tempDir("gjc-plugin-launcher-cleanup-source-");
			const markerDir = await tempDir("gjc-plugin-launcher-cleanup-marker-");
			const signalMarker = path.join(markerDir, "sigterm.txt");
			const cwdMarker = path.join(markerDir, "cwd.txt");
			await writeBundle(source, {
				name: "snapshot-cleanup",
				command: "node",
				server: `${mcpServer()}\nwriteFileSync(${JSON.stringify(cwdMarker)}, process.cwd());\nsetInterval(() => {}, 1_000);\nprocess.on("SIGTERM", () => writeFileSync(${JSON.stringify(signalMarker)}, "seen"));`,
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const runtime = await buildPluginMcpConfigs({ cwd });
			const config = runtime.configs["snapshot-cleanup"];
			if (!config || config.type === "http" || config.type === "sse") throw new Error("missing stdio config");
			const prepareSpawn = config.prepareSpawn;
			if (!prepareSpawn) throw new Error("missing stdio preparation");
			let registeredCleanups = 0;
			config.prepareSpawn = (launch: MCPStdioSpawnLaunch) =>
				prepareSpawn({
					...launch,
					registerCleanup: (cleanup: () => Promise<void>) => {
						registeredCleanups++;
						launch.registerCleanup?.(cleanup);
					},
				});
			const manager = new MCPManager(cwd);
			managers.push(manager);
			const provenance = {
				"snapshot-cleanup": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
			} as never;

			for (let attempt = 0; attempt < 2; attempt++) {
				const connected = await manager.connectServers(runtime.configs, provenance);
				expect([...connected.errors.entries()]).toEqual([]);
				expect(registeredCleanups).toBe(attempt + 1);
				const snapshotRoot = await fs.readFile(cwdMarker, "utf8");
				await expect(fs.stat(snapshotRoot)).resolves.toMatchObject({});
				await manager.disconnectAll();
				expect(await fs.readFile(signalMarker, "utf8")).toBe("seen");
				await expect(fs.stat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
				await fs.rm(signalMarker, { force: true });
				await fs.rm(cwdMarker, { force: true });
			}
		},
		30_000,
	);

	testOnLinux(
		"keeps snapshots outside workspace-controlled TMPDIR and removes them on disconnect",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-tmpdir-project-");
			const source = await tempDir("gjc-plugin-launcher-tmpdir-source-");
			const cwdMarker = path.join(await tempDir("gjc-plugin-launcher-tmpdir-marker-"), "cwd.txt");
			await writeBundle(source, {
				name: "snapshot-tmpdir",
				command: "node",
				server: `${mcpServer()}\nwriteFileSync(${JSON.stringify(cwdMarker)}, process.cwd());`,
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const previousTmpdir = process.env.TMPDIR;
			process.env.TMPDIR = cwd;
			try {
				const connected = await connect(cwd, "snapshot-tmpdir");
				expect(connected.errors).toEqual([]);
				const snapshotRoot = await fs.readFile(cwdMarker, "utf8");
				expect(path.relative(cwd, snapshotRoot).startsWith("..")).toBe(true);
				const entry = (await readRegistry("project", cwd)).plugins[0];
				expect(path.relative(entry?.pluginRoot ?? "", snapshotRoot).startsWith("..")).toBe(true);
				await expect(fs.stat(snapshotRoot)).resolves.toMatchObject({});
				await managers.at(-1)?.disconnectAll();
				await expect(fs.stat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				if (previousTmpdir === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = previousTmpdir;
			}
		},
		30_000,
	);

	testOnLinux(
		"passes separators, spaces, quotes, and shell metacharacters only as literal post-entrypoint argv",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-literal-project-");
			const source = await tempDir("gjc-plugin-launcher-literal-source-");
			await writeBundle(source, {
				name: "literal-argv",
				command: "node",
				args: ["mcp/server;literal.mjs", "--", "value with spaces", 'quote="literal"', "semi;colon", "amp&ersand"],
				serverPath: "mcp/server;literal.mjs",
				server: mcpServer(),
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const connected = await connect(cwd, "literal-argv");
			expect(connected.errors).toEqual([]);
			expect(runtimeServerArgs(connected.args)).toEqual([
				"--",
				"value with spaces",
				'quote="literal"',
				"semi;colon",
				"amp&ersand",
			]);
		},
		30_000,
	);

	testOnLinux(
		"does not resolve a bare launcher from attacker-controlled workspace PATH entries",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-path-project-");
			const source = await tempDir("gjc-plugin-launcher-path-source-");
			const marker = path.join(await tempDir("gjc-plugin-launcher-path-marker-"), "ran.txt");
			await writeBundle(source, {
				name: "launcher-path",
				command: "node",
				server: mcpServer(),
			});
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			await fs.writeFile(path.join(cwd, "node"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`, {
				mode: 0o700,
			});
			const runtimeAdaptersUrl = pathToFileURL(
				path.join(import.meta.dir, "../src/extensibility/gjc-plugins/runtime-adapters.ts"),
			).href;
			const runtimeMcpUrl = pathToFileURL(path.join(import.meta.dir, "../src/runtime-mcp/index.ts")).href;
			const probe = `
const { buildPluginMcpConfigs } = await import(${JSON.stringify(runtimeAdaptersUrl)});
const { MCPManager } = await import(${JSON.stringify(runtimeMcpUrl)});
const cwd = process.env.GJC_LAUNCHER_PROBE_CWD;
if (!cwd) throw new Error("missing probe cwd");
const runtime = await buildPluginMcpConfigs({ cwd });
const config = runtime.configs["launcher-path"];
if (!config) throw new Error("missing launcher config");
const manager = new MCPManager(cwd);
const connected = await manager.connectServers({ "launcher-path": config }, {
  "launcher-path": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
});
console.log("LAUNCHER=" + config.command);
console.log("ERRORS=" + connected.errors.size);
await manager.disconnectAll();
`;
			const child = Bun.spawn([process.execPath, "--eval", probe], {
				cwd,
				env: {
					...process.env,
					PATH: [cwd, ".", process.env.PATH].filter(Boolean).join(path.delimiter),
					GJC_LAUNCHER_PROBE_CWD: cwd,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			const launcherCommand = stdout.match(/^LAUNCHER=(.*)$/mu)?.[1] ?? "";
			expect(stdout).toContain("ERRORS=0");
			await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			expect(path.isAbsolute(launcherCommand)).toBe(true);
			expect(path.relative(cwd, launcherCommand).startsWith("..")).toBe(true);
		},
		30_000,
	);

	testOnLinux(
		"ignores an attacker-owned absolute interpreter before it can be replaced",
		async () => {
			if (process.platform === "win32") return;
			const cwd = await tempDir("gjc-plugin-launcher-interpreter-project-");
			const source = await tempDir("gjc-plugin-launcher-interpreter-source-");
			const launcherDir = await tempDir("gjc-plugin-launcher-interpreter-bin-");
			const marker = path.join(await tempDir("gjc-plugin-launcher-interpreter-marker-"), "ran.txt");
			const trustedNode = Bun.which("node");
			if (!trustedNode) throw new Error("node launcher missing");
			const selectedLauncher = path.join(launcherDir, "node");
			const maliciousLauncher = path.join(launcherDir, "malicious-node");
			await fs.copyFile(await fs.realpath(trustedNode), selectedLauncher);
			await fs.chmod(selectedLauncher, 0o700);
			await fs.writeFile(maliciousLauncher, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`, {
				mode: 0o700,
			});
			await writeBundle(source, { name: "interpreter-replacement", command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);

			const previousPath = process.env.PATH;
			const previousNvmDir = process.env.NVM_DIR;
			process.env.PATH = [launcherDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.NVM_DIR = launcherDir;
			try {
				const runtime = await buildPluginMcpConfigs({ cwd });
				const config = runtime.configs["interpreter-replacement"];
				if (config?.type !== "stdio") throw new Error("missing trusted launcher fallback");
				expect(await fs.realpath(config.command)).not.toBe(await fs.realpath(selectedLauncher));
				config.afterSpawnGuardForTest = async () => {
					await fs.rename(maliciousLauncher, selectedLauncher);
				};
				const manager = new MCPManager(cwd);
				managers.push(manager);
				const connected = await manager.connectServers({ "interpreter-replacement": config }, {
					"interpreter-replacement": {
						provider: "gjc-plugins",
						providerName: "GJC plugin bundle",
						level: "project",
					},
				} as never);
				expect([...connected.errors.entries()]).toEqual([]);
				await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousNvmDir === undefined) delete process.env.NVM_DIR;
				else process.env.NVM_DIR = previousNvmDir;
			}
		},
		30_000,
	);

	testOnLinux(
		"executes the canonical launcher target when its PATH symlink is retargeted after the final guard",
		async () => {
			if (process.platform === "win32") return;
			const cwd = await tempDir("gjc-plugin-launcher-link-project-");
			const source = await tempDir("gjc-plugin-launcher-link-source-");
			const launcherDir = await tempDir("gjc-plugin-launcher-link-bin-");
			const marker = path.join(await tempDir("gjc-plugin-launcher-link-marker-"), "ran.txt");
			const trustedNode = Bun.which("node");
			if (!trustedNode) throw new Error("node launcher missing");
			const trustedNodeReal = await fs.realpath(trustedNode);
			const launcherLink = path.join(launcherDir, "node");
			const maliciousLauncher = path.join(launcherDir, "malicious-node");
			await fs.symlink(trustedNodeReal, launcherLink);
			await fs.writeFile(maliciousLauncher, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`, {
				mode: 0o700,
			});
			await writeBundle(source, { name: "launcher-link", command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);

			const runtimeAdaptersUrl = pathToFileURL(
				path.join(import.meta.dir, "../src/extensibility/gjc-plugins/runtime-adapters.ts"),
			).href;
			const runtimeMcpUrl = pathToFileURL(path.join(import.meta.dir, "../src/runtime-mcp/index.ts")).href;
			const probe = `
import * as fs from "node:fs/promises";
const { buildPluginMcpConfigs } = await import(${JSON.stringify(runtimeAdaptersUrl)});
const { MCPManager } = await import(${JSON.stringify(runtimeMcpUrl)});
const cwd = process.env.GJC_LAUNCHER_PROBE_CWD;
const launcherLink = process.env.GJC_LAUNCHER_LINK;
const maliciousLauncher = process.env.GJC_MALICIOUS_LAUNCHER;
const marker = process.env.GJC_LAUNCHER_MARKER;
if (!cwd || !launcherLink || !maliciousLauncher || !marker) throw new Error("missing probe metadata");
const runtime = await buildPluginMcpConfigs({ cwd });
const config = runtime.configs["launcher-link"];
if (!config || config.type !== "stdio") throw new Error("missing launcher config");
config.afterSpawnGuardForTest = async () => {
  const replacement = launcherLink + ".replacement";
  await fs.symlink(maliciousLauncher, replacement);
  await fs.rename(replacement, launcherLink);
};
const manager = new MCPManager(cwd);
const connected = await manager.connectServers({ "launcher-link": config }, {
  "launcher-link": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
});
console.log("LAUNCHER=" + config.command);
console.log("ERRORS=" + connected.errors.size);
await manager.disconnectAll();
console.log("MARKER=" + await fs.readFile(marker, "utf8").catch(() => "missing"));
`;
			const child = Bun.spawn([process.execPath, "--eval", probe], {
				cwd,
				env: {
					...process.env,
					PATH: [launcherDir, process.env.PATH].filter(Boolean).join(path.delimiter),
					GJC_LAUNCHER_PROBE_CWD: cwd,
					GJC_LAUNCHER_LINK: launcherLink,
					GJC_MALICIOUS_LAUNCHER: maliciousLauncher,
					GJC_LAUNCHER_MARKER: marker,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("MARKER=missing");
			expect(stdout).toContain("ERRORS=0");
			expect(stdout).toContain(`LAUNCHER=${trustedNodeReal}`);
			await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		},
		30_000,
	);

	test("rejects path-qualified executable and shebang launcher aliases", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-project-");
		const source = await tempDir("gjc-plugin-launcher-executable-");
		await fs.mkdir(path.join(source, "bin"), { recursive: true });
		await fs.writeFile(path.join(source, "bin/server"), `#!/usr/bin/env bun\n${mcpServer()}`, { mode: 0o600 });
		await writeBundle(source, {
			name: "owned-executable",
			command: "./server",
			args: [],
			cwd: "bin",
		});
		await expect(installGjcBundle({ cwd }, "project", source)).rejects.toMatchObject({ code: "security_policy" });
	});

	test("copies hardlinked source bytes into a distinct installed inode on every host", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-hardlink-portable-project-");
		const source = await tempDir("gjc-plugin-launcher-hardlink-portable-source-");
		const outside = await tempDir("gjc-plugin-launcher-hardlink-portable-outside-");
		const outsideServer = path.join(outside, "server.mjs");
		const authenticatedServer = mcpServer();
		await fs.writeFile(outsideServer, authenticatedServer);
		await fs.mkdir(path.join(source, "mcp"), { recursive: true });
		await fs.link(outsideServer, path.join(source, "mcp/server.mjs"));
		await writeBundle(source, { name: "hardlink-copy-portable", command: "node" });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		const entry = (await readRegistry("project", cwd)).plugins[0];
		const installed = path.join(entry?.pluginRoot ?? "", "mcp/server.mjs");
		expect((await fs.stat(installed)).ino).not.toBe((await fs.stat(outsideServer)).ino);
		await fs.writeFile(outsideServer, "throw new Error('outside replacement');\n");
		expect(await fs.readFile(installed, "utf8")).toBe(authenticatedServer);
	});

	testOnLinux(
		"copies hardlinked source bytes instead of retaining external inode authority",
		async () => {
			const cwd = await tempDir("gjc-plugin-launcher-hardlink-project-");
			const source = await tempDir("gjc-plugin-launcher-hardlink-source-");
			const outside = await tempDir("gjc-plugin-launcher-hardlink-outside-");
			const outsideServer = path.join(outside, "server.mjs");
			await fs.writeFile(outsideServer, mcpServer());
			await fs.mkdir(path.join(source, "mcp"), { recursive: true });
			await fs.link(outsideServer, path.join(source, "mcp/server.mjs"));
			await writeBundle(source, { name: "hardlink-copy", command: "node" });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const entry = (await readRegistry("project", cwd)).plugins[0];
			const installed = path.join(entry?.pluginRoot ?? "", "mcp/server.mjs");
			expect((await fs.stat(installed)).ino).not.toBe((await fs.stat(outsideServer)).ino);
			await fs.writeFile(outsideServer, "throw new Error('outside replacement');\n");
			const connected = await connect(cwd, "hardlink-copy");
			expect(connected.errors).toEqual([]);
		},
		30_000,
	);

	test("blocks outside config/cwd selectors during installation", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-project-");
		const outside = await tempDir("gjc-plugin-launcher-outside-");
		for (const [name, firstArg] of [
			["outside-config", `--config=${path.join(outside, "bunfig.toml")}`],
			["outside-cwd", `--cwd=${outside}`],
		] as const) {
			const source = await tempDir(`gjc-plugin-launcher-${name}-`);
			await writeBundle(source, {
				name,
				command: "bun",
				args: [firstArg, "mcp/server.mjs"],
				server: mcpServer(),
			});
			await expect(installGjcBundle({ cwd }, "project", source)).rejects.toMatchObject({ code: "security_policy" });
		}
	});

	test("fails Bun launch closed before ambient config, dotenv, or auto-install can run", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-project-");
		const source = await tempDir("gjc-plugin-launcher-source-");
		const outside = await tempDir("gjc-plugin-launcher-ambient-");
		const preloadMarker = path.join(outside, "preload-ran.txt");
		const serverReport = path.join(outside, "server-report.json");
		const bunfig = `preload = [${JSON.stringify(path.join(outside, "preload.ts"))}]\n`;
		await writeBundle(source, {
			name: "ambient-isolation",
			command: "bun",
			server: mcpServer(serverReport),
			ownedFiles: {
				"bunfig.toml": bunfig,
				".env": "GJC_PLUGIN_AMBIENT=loaded\n",
				"package.json": '{"dependencies":{"definitely-not-installed":"latest"}}\n',
			},
		});
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		await fs.writeFile(
			path.join(outside, "preload.ts"),
			`await Bun.write(${JSON.stringify(preloadMarker)}, "ran\\n");\n`,
		);

		await expectBunLaunchRefused(cwd, "ambient-isolation");
		await expect(fs.readFile(serverReport, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.readFile(preloadMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);

	test("quarantines extra dotenv, config, package, and executable files added after install", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-extra-project-");
		for (const [name, relativePath, content] of [
			["extra-dotenv", ".env", "TOKEN=ambient\n"],
			["extra-config", "bunfig.toml", "preload = []\n"],
			["extra-package", "package.json", '{"type":"commonjs"}\n'],
			["extra-executable", "mcp/other.mjs", "process.exit(0);\n"],
		] as const) {
			const source = await tempDir(`gjc-plugin-launcher-${name}-`);
			await writeBundle(source, { name, command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
			const entry = (await readRegistry("project", cwd)).plugins.find(plugin => plugin.name === name);
			const absolutePath = path.join(entry?.pluginRoot ?? "", relativePath);
			await fs.mkdir(path.dirname(absolutePath), { recursive: true });
			await fs.writeFile(absolutePath, content);
			const runtime = await buildPluginMcpConfigs({ cwd });
			expect(runtime.configs[name]).toBeUndefined();
			expect(runtime.quarantine).toContainEqual(expect.objectContaining({ plugin: name, code: "security_policy" }));
		}
	});

	test("quarantines an MCP config that no longer matches its compiled registry hash", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-project-");
		const source = await tempDir("gjc-plugin-launcher-source-");
		await writeBundle(source, { name: "config-rebind", command: "bun", server: mcpServer() });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		await buildPluginMcpConfigs({ cwd }); // Persist the canonical v2 migration first.

		const registryPath = registryPathForScope("project", cwd);
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
		registry.plugins[0].surfaces.mcps[0].config.args = ["gajae-plugin.json"];
		await fs.writeFile(registryPath, JSON.stringify(registry));

		const runtime = await buildPluginMcpConfigs({ cwd });
		expect(Object.keys(runtime.configs)).toEqual([]);
		expect(runtime.quarantine).toContainEqual(
			expect.objectContaining({ plugin: "config-rebind", code: "security_policy" }),
		);
	});

	test("quarantines a registry-selected plugin root outside its owning scope", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-project-");
		const source = await tempDir("gjc-plugin-launcher-source-");
		await writeBundle(source, { name: "root-rebind", command: "bun", server: mcpServer() });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		await buildPluginMcpConfigs({ cwd }); // Persist the canonical v2 migration first.

		const registryPath = registryPathForScope("project", cwd);
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
		const outside = await tempDir("gjc-plugin-launcher-outside-root-");
		await fs.cp(registry.plugins[0].pluginRoot, outside, { recursive: true });
		registry.plugins[0].pluginRoot = outside;
		registry.plugins[0].manifestPath = path.join(outside, "gajae-plugin.json");
		await fs.writeFile(registryPath, JSON.stringify(registry));

		const runtime = await buildPluginMcpConfigs({ cwd });
		expect(Object.keys(runtime.configs)).toEqual([]);
		expect(runtime.quarantine).toContainEqual(
			expect.objectContaining({ plugin: "root-rebind", code: "security_policy" }),
		);
	});

	test("quarantines an owned entrypoint omitted from the authenticated copied-file set", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-project-");
		const source = await tempDir("gjc-plugin-launcher-source-");
		await writeBundle(source, { name: "file-rebind", command: "bun", server: mcpServer() });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		await buildPluginMcpConfigs({ cwd }); // Persist the canonical v2 migration first.

		const registryPath = registryPathForScope("project", cwd);
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
		registry.plugins[0].copiedFiles = registry.plugins[0].copiedFiles.filter(
			(file: { relativePath: string }) => file.relativePath !== "mcp/server.mjs",
		);
		await fs.writeFile(registryPath, JSON.stringify(registry));

		const runtime = await buildPluginMcpConfigs({ cwd });
		expect(Object.keys(runtime.configs)).toEqual([]);
		expect(runtime.quarantine).toContainEqual(
			expect.objectContaining({ plugin: "file-rebind", code: "security_policy" }),
		);
	});

	testOnLinux("fails closed when the installed entrypoint changes after config build but before spawn", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-toctou-project-");
		const source = await tempDir("gjc-plugin-launcher-toctou-source-");
		await writeBundle(source, { name: "spawn-toctou", command: "node", server: mcpServer() });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		const runtime = await buildPluginMcpConfigs({ cwd });
		expect(runtime.quarantine).toEqual([]);
		const entry = (await readRegistry("project", cwd)).plugins[0];
		await fs.writeFile(path.join(entry?.pluginRoot ?? "", "mcp/server.mjs"), "process.exit(0);\n");

		const manager = new MCPManager(cwd);
		managers.push(manager);
		const connected = await manager.connectServers(runtime.configs, {
			"spawn-toctou": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
		} as never);
		expect([...connected.errors.keys()]).toEqual(["spawn-toctou"]);
		expect(manager.getConnection("spawn-toctou")).toBeUndefined();
	});

	testOnLinux("executes no replacement bytes changed after the final guard", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-atomic-project-");
		const source = await tempDir("gjc-plugin-launcher-atomic-source-");
		const markerDir = await tempDir("gjc-plugin-launcher-atomic-marker-");
		const marker = path.join(markerDir, "replacement-ran.txt");
		await writeBundle(source, { name: "atomic-toctou", command: "node", server: mcpServer() });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		const runtime = await buildPluginMcpConfigs({ cwd });
		const config = runtime.configs["atomic-toctou"];
		if (!config || config.type === "http" || config.type === "sse") throw new Error("missing stdio config");
		const entry = (await readRegistry("project", cwd)).plugins[0];
		config.afterSpawnGuardForTest = async () => {
			await fs.writeFile(
				path.join(entry?.pluginRoot ?? "", "mcp/server.mjs"),
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n${mcpServer()}`,
			);
		};

		const manager = new MCPManager(cwd);
		managers.push(manager);
		const connected = await manager.connectServers(runtime.configs, {
			"atomic-toctou": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
		} as never);
		expect([...connected.errors.keys()]).toEqual([]);
		expect(manager.getConnection("atomic-toctou")).toBeDefined();
		await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	testOnLinux("executes no helper bytes rebound through the registry after the final guard", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-helper-atomic-project-");
		const source = await tempDir("gjc-plugin-launcher-helper-atomic-source-");
		const marker = path.join(await tempDir("gjc-plugin-launcher-helper-atomic-marker-"), "ran.txt");
		const server = mcpServer().replace(
			'import { writeFileSync } from "node:fs";',
			'import { writeFileSync } from "node:fs";\nimport { helperValue } from "./helper.mjs";\nvoid helperValue;',
		);
		await writeBundle(source, {
			name: "helper-atomic-toctou",
			command: "node",
			server,
			ownedFiles: { "mcp/helper.mjs": 'export const helperValue = "trusted";\n' },
		});
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		const runtime = await buildPluginMcpConfigs({ cwd });
		const config = runtime.configs["helper-atomic-toctou"];
		if (!config || config.type === "http" || config.type === "sse") throw new Error("missing stdio config");
		const entry = (await readRegistry("project", cwd)).plugins[0];
		const replacement = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export const helperValue = "replacement";\n`;
		config.afterSpawnGuardForTest = async () => {
			await fs.writeFile(path.join(entry?.pluginRoot ?? "", "mcp/helper.mjs"), replacement);
			const registryPath = registryPathForScope("project", cwd);
			const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
			const helper = registry.plugins[0].copiedFiles.find(
				(file: { relativePath: string }) => file.relativePath === "mcp/helper.mjs",
			);
			if (!helper) throw new Error("missing helper authority");
			helper.sha256 = createHash("sha256").update(replacement).digest("hex");
			await fs.writeFile(registryPath, JSON.stringify(registry));
		};

		const manager = new MCPManager(cwd);
		managers.push(manager);
		const connected = await manager.connectServers(runtime.configs, {
			"helper-atomic-toctou": {
				provider: "gjc-plugins",
				providerName: "GJC plugin bundle",
				level: "project",
			},
		} as never);
		expect([...connected.errors.keys()]).toEqual([]);
		expect(manager.getConnection("helper-atomic-toctou")).toBeDefined();
		await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	testOnLinux("rehashes the complete copied-file manifest at the final guard", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-helper-project-");
		const source = await tempDir("gjc-plugin-launcher-helper-source-");
		await writeBundle(source, {
			name: "helper-toctou",
			command: "node",
			server: mcpServer(),
			ownedFiles: { "mcp/helper.txt": "authenticated helper\n" },
		});
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		const runtime = await buildPluginMcpConfigs({ cwd });
		const entry = (await readRegistry("project", cwd)).plugins[0];
		await fs.writeFile(path.join(entry?.pluginRoot ?? "", "mcp/helper.txt"), "replacement helper\n");

		const manager = new MCPManager(cwd);
		managers.push(manager);
		const connected = await manager.connectServers(runtime.configs, {
			"helper-toctou": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
		} as never);
		expect([...connected.errors.keys()]).toEqual(["helper-toctou"]);
		expect(manager.getConnection("helper-toctou")).toBeUndefined();
	});

	testOnLinux("fails closed when the launch plan changes after config build", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-plan-project-");
		const source = await tempDir("gjc-plugin-launcher-plan-source-");
		await writeBundle(source, { name: "plan-toctou", command: "node", server: mcpServer() });
		expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		const runtime = await buildPluginMcpConfigs({ cwd });
		expect(runtime.quarantine).toEqual([]);
		const config = runtime.configs["plan-toctou"];
		if (!config || config.type === "http" || config.type === "sse") throw new Error("missing stdio config");
		config.args = [...(config.args ?? []), "unexpected"];

		const manager = new MCPManager(cwd);
		managers.push(manager);
		const connected = await manager.connectServers(runtime.configs, {
			"plan-toctou": { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" },
		} as never);
		expect([...connected.errors.keys()]).toEqual(["plan-toctou"]);
		expect(manager.getConnection("plan-toctou")).toBeUndefined();
	});

	test("rejects same-scope registry replay to another authenticated bundle root", async () => {
		const cwd = await tempDir("gjc-plugin-launcher-replay-project-");
		for (const name of ["replay-a", "replay-b"]) {
			const source = await tempDir(`gjc-plugin-launcher-${name}-`);
			await writeBundle(source, { name, command: "node", server: mcpServer() });
			expect((await installGjcBundle({ cwd }, "project", source)).ok).toBe(true);
		}
		await buildPluginMcpConfigs({ cwd });
		const registryPath = registryPathForScope("project", cwd);
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
		const first = registry.plugins.find((plugin: { name: string }) => plugin.name === "replay-a");
		const second = registry.plugins.find((plugin: { name: string }) => plugin.name === "replay-b");
		first.pluginRoot = second.pluginRoot;
		first.manifestPath = second.manifestPath;
		first.manifestHash = second.manifestHash;
		first.copiedFiles = second.copiedFiles;
		first.surfaces = second.surfaces;
		await fs.writeFile(registryPath, JSON.stringify(registry));

		const runtime = await buildPluginMcpConfigs({ cwd });
		expect(runtime.configs["replay-a"]).toBeUndefined();
		expect(runtime.quarantine).toContainEqual(
			expect.objectContaining({ plugin: "replay-a", code: "security_policy" }),
		);
	});
});
