import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	buildPluginMcpConfigs,
	compileGjcPluginBundle,
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
	installGjcBundle,
} from "../src/extensibility/gjc-plugins";
import { isPluginMcpPublicNetworkBound } from "../src/runtime-mcp/plugin-network-boundary";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

const pluginFileMaxBytes = 16 * 1024 * 1024;

interface DescriptorCloser {
	close(): Promise<void>;
}

function isSymlinkUnavailable(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(error.code)
	);
}

async function canCreateFileSymlink(): Promise<boolean> {
	const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-compiler-symlink-probe-"));
	try {
		const target = path.join(probeDir, "target.ts");
		await fs.writeFile(target, "export default {};\n");
		await fs.symlink(target, path.join(probeDir, "link.ts"), "file");
		return true;
	} catch (error) {
		if (isSymlinkUnavailable(error)) return false;
		throw error;
	} finally {
		await fs.rm(probeDir, { recursive: true, force: true });
	}
}

const symlinkRaceTest = test.skipIf(!(await canCreateFileSymlink()));

async function trackedTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function manifest(name: string, mcps?: unknown[]): Record<string, unknown> {
	return {
		kind: "gajae-code-plugin",
		name,
		version: "1.0.0",
		...(mcps === undefined ? {} : { mcps }),
	};
}

function manifestAtExactSize(name: string, bytes: number): string {
	const json = JSON.stringify(manifest(name));
	const padding = bytes - Buffer.byteLength(json);
	if (padding < 0) throw new Error("Manifest fixture exceeds requested size");
	return `${json}${" ".repeat(padding)}`;
}

async function expectLoadError(attempt: Promise<unknown>, code: GjcPluginLoadErrorCode): Promise<GjcPluginLoadError> {
	try {
		await attempt;
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return error as GjcPluginLoadError;
	}
	throw new Error(`Expected ${code} plugin load error`);
}

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-configs-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

describe("plugin MCP runtime config conversion", () => {
	test("converts a bundled stdio MCP into a root-confined runtime config", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-"));
		tempDirs.push(cwd);
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const { configs, quarantine } = await buildPluginMcpConfigs({ cwd });
		if (process.platform !== "linux") {
			expect(configs).toEqual({});
			expect(quarantine).toEqual([
				expect.objectContaining({
					plugin: "valid-six-surface-bundle",
					surfaceId: "mcp:domain_docs",
					code: "security_policy",
					message: "Authenticated plugin MCP stdio launch capsules are available only on Linux",
				}),
			]);
			return;
		}

		expect(quarantine).toHaveLength(0);
		const docs = configs.domain_docs;
		expect(docs.type).toBe("stdio");
		expect(docs.command).toBe("/proc/self/exe");
		// cwd is confined to the installed plugin root.
		const installedRoot = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle");
		expect(docs.args).toEqual(["mcp/domain-docs.ts"]);
		expect(path.resolve(docs.cwd)).toBe(path.resolve(installedRoot));
		await expect(docs.prepareSpawn?.({ command: docs.command, args: docs.args, cwd: docs.cwd })).rejects.toThrow(
			"Authenticated plugin MCP Bun launch capsules are unavailable",
		);
	});

	test("empty when no plugins installed", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-empty-"));
		tempDirs.push(cwd);
		const { configs } = await buildPluginMcpConfigs({ cwd });
		expect(configs).toEqual({});
	});

	test("binds bundled remote MCP configs to the public-network transport", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-remote-"));
		const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-remote-bundle-"));
		tempDirs.push(cwd, bundle);
		const url = "https://8.8.8.8/mcp";
		await fs.writeFile(
			path.join(bundle, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "remote-mcp-bundle",
				version: "1.0.0",
				mcps: [{ name: "remote_docs", transport: "http", url }],
			}),
		);

		const r = await installGjcBundle({ cwd }, "project", bundle);
		expect(r.ok).toBe(true);
		const { configs, quarantine } = await buildPluginMcpConfigs({ cwd });

		expect(quarantine).toHaveLength(0);
		expect(configs.remote_docs).toMatchObject({ type: "http", url });
		expect(isPluginMcpPublicNetworkBound(configs.remote_docs)).toBe(true);
		expect(isPluginMcpPublicNetworkBound({ ...configs.remote_docs })).toBe(true);
	});
});

describe("plugin compiler read boundary", () => {
	symlinkRaceTest(
		"rejects an escaping symlink retarget between containment validation and descriptor open",
		async () => {
			const bundle = await trackedTempDir("gjc-mcp-compiler-retarget-");
			const outside = await trackedTempDir("gjc-mcp-compiler-outside-");
			const serverPath = path.join(bundle, "mcp", "server.ts");
			const trustedBackup = path.join(bundle, "mcp", "server.trusted.ts");
			const outsideServer = path.join(outside, "server.ts");
			await fs.mkdir(path.dirname(serverPath), { recursive: true });
			await fs.writeFile(serverPath, "export default {};\n");
			await fs.writeFile(outsideServer, "throw new Error('outside');\n");
			await fs.writeFile(
				path.join(bundle, "gajae-plugin.json"),
				JSON.stringify(
					manifest("retargeted-mcp", [
						{
							name: "retargeted",
							transport: "stdio",
							command: "bun",
							args: ["mcp/server.ts"],
							cwd: ".",
						},
					]),
				),
			);

			const openFile = fs.open;
			let retargeted = false;
			let usedNoFollow = false;
			vi.spyOn(fs, "open").mockImplementation((async (file, flags, mode) => {
				if (!retargeted && path.resolve(String(file)) === path.resolve(serverPath)) {
					retargeted = true;
					usedNoFollow =
						process.platform === "win32" ||
						(typeof flags === "number" &&
							typeof nodeFs.constants.O_NOFOLLOW === "number" &&
							(flags & nodeFs.constants.O_NOFOLLOW) !== 0);
					await fs.rename(serverPath, trustedBackup);
					await fs.symlink(outsideServer, serverPath, "file");
				}
				return openFile(file, flags, mode);
			}) as typeof fs.open);

			const error = await expectLoadError(compileGjcPluginBundle(bundle), "security_policy");
			expect(retargeted).toBe(true);
			expect(usedNoFollow).toBe(true);
			expect(error.message).toContain("mcp/server.ts");
		},
	);

	test("preserves security_policy for an oversized declared MCP file", async () => {
		const bundle = await trackedTempDir("gjc-mcp-compiler-oversized-file-");
		const serverPath = path.join(bundle, "mcp", "server.ts");
		await fs.mkdir(path.dirname(serverPath), { recursive: true });
		await fs.writeFile(serverPath, "");
		await fs.truncate(serverPath, pluginFileMaxBytes + 1);
		await fs.writeFile(
			path.join(bundle, "gajae-plugin.json"),
			JSON.stringify(
				manifest("oversized-mcp-file", [
					{
						name: "oversized",
						transport: "stdio",
						command: "bun",
						args: ["mcp/server.ts"],
						cwd: ".",
					},
				]),
			),
		);

		const error = await expectLoadError(compileGjcPluginBundle(bundle), "security_policy");
		expect(error.message).toContain(`${pluginFileMaxBytes} bytes`);
		expect(error.message).toContain("mcp/server.ts");
	});

	test("parses and hashes one bounded manifest snapshot after its retained descriptor closes", async () => {
		const bundle = await trackedTempDir("gjc-mcp-compiler-manifest-snapshot-");
		const manifestPath = path.join(bundle, "gajae-plugin.json");
		const replacementPath = path.join(bundle, "replacement.json");
		const originalBytes = Buffer.from(JSON.stringify(manifest("snapshot-original")));
		await fs.writeFile(manifestPath, originalBytes);
		await fs.writeFile(replacementPath, JSON.stringify(manifest("snapshot-replacement")));

		const openFile = fs.open;
		let manifestOpens = 0;
		let replaced = false;
		vi.spyOn(fs, "open").mockImplementation((async (file, flags, mode) => {
			const handle = await openFile(file, flags, mode);
			if (path.resolve(String(file)) !== path.resolve(manifestPath)) return handle;
			manifestOpens++;
			const closer = handle as unknown as DescriptorCloser;
			const close = closer.close.bind(closer);
			vi.spyOn(closer, "close").mockImplementationOnce(async () => {
				await close();
				if (!replaced) {
					replaced = true;
					await fs.rename(replacementPath, manifestPath);
				}
			});
			return handle;
		}) as typeof fs.open);

		const compiled = await compileGjcPluginBundle(bundle);
		const expectedHash = createHash("sha256").update(originalBytes).digest("hex");
		expect(replaced).toBe(true);
		expect(manifestOpens).toBe(1);
		expect(compiled.name).toBe("snapshot-original");
		expect(compiled.manifestHash).toBe(expectedHash);
		expect(compiled.files[0]).toEqual({
			relativePath: "gajae-plugin.json",
			sha256: expectedHash,
			bytes: originalBytes.byteLength,
		});
		expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toMatchObject({
			name: "snapshot-replacement",
		});
	});

	test("accepts an exact-limit manifest and rejects one byte over with security_policy", async () => {
		const bundle = await trackedTempDir("gjc-mcp-compiler-manifest-limit-");
		const manifestPath = path.join(bundle, "gajae-plugin.json");
		await fs.writeFile(manifestPath, manifestAtExactSize("exact-limit-manifest", pluginFileMaxBytes));

		const compiled = await compileGjcPluginBundle(bundle);
		expect(compiled.files[0]?.bytes).toBe(pluginFileMaxBytes);

		await fs.appendFile(manifestPath, " ");
		const error = await expectLoadError(compileGjcPluginBundle(bundle), "security_policy");
		expect(error.message).toContain(`${pluginFileMaxBytes} bytes`);
		expect(error.message).toContain("gajae-plugin.json");
	});
});
