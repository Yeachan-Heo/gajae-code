import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability, loadCapabilityForHome } from "@gajae-code/coding-agent/capability";
import { clearCache as clearFsCache, readFile as readDiscoveryFile } from "@gajae-code/coding-agent/capability/fs";
import {
	clearClaudePluginRootsCache,
	invalidateClaudePluginRoots,
	listClaudePluginRoots,
	parseClaudePluginsRegistry,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "@gajae-code/coding-agent/discovery/helpers";
import { discoverAgents } from "@gajae-code/coding-agent/task/discovery";
import { safeRm } from "../../../../scripts/safe-cleanup";
import "@gajae-code/coding-agent/discovery/claude-plugins";
import type { Skill } from "@gajae-code/coding-agent/capability/skill";
import type { SlashCommand } from "@gajae-code/coding-agent/capability/slash-command";
import type { MCPServer } from "../../src/capability/mcp";

describe("parseClaudePluginsRegistry", () => {
	test("parses valid registry", () => {
		const content = JSON.stringify({
			version: 2,
			plugins: {
				"my-plugin@marketplace": [
					{
						scope: "user",
						installPath: "/path/to/plugin",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		});

		const result = parseClaudePluginsRegistry(content);
		expect(result).not.toBeNull();
		expect(result?.version).toBe(2);
		expect(result?.plugins["my-plugin@marketplace"]).toHaveLength(1);
	});

	test("returns null for invalid JSON", () => {
		expect(parseClaudePluginsRegistry("not json")).toBeNull();
	});

	test("returns null for missing version", () => {
		const content = JSON.stringify({ plugins: {} });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for missing plugins", () => {
		const content = JSON.stringify({ version: 2 });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for null plugins", () => {
		const content = JSON.stringify({ version: 2, plugins: null });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});
});

describe("listClaudePluginRoots", () => {
	let tempDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugins-test-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await safeRm(tempDir, { recursive: true, force: true });
	});

	test("returns empty roots when no registry file exists", async () => {
		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("keeps project plugin registries under .gjc when the user config directory is overridden", async () => {
		const originalConfigDir = process.env.GJC_CONFIG_DIR;
		const project = path.join(tempDir, "project");
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await fs.mkdir(path.join(project, ".gjc", "plugins"), { recursive: true });
		await fs.mkdir(path.join(project, ".profile", "plugins"), { recursive: true });
		process.env.GJC_CONFIG_DIR = ".profile";
		try {
			expect(await resolveActiveProjectRegistryPath(project)).toBe(
				path.join(project, ".gjc", "plugins", "installed_plugins.json"),
			);
			const freshProject = path.join(tempDir, "fresh-project");
			await fs.mkdir(freshProject, { recursive: true });
			expect(await resolveOrDefaultProjectRegistryPath(freshProject)).toBe(
				path.join(freshProject, ".gjc", "plugins", "installed_plugins.json"),
			);
		} finally {
			if (originalConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
			else process.env.GJC_CONFIG_DIR = originalConfigDir;
		}
	});

	test("parses plugin with user scope", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"test-plugin@test-market": [
					{
						scope: "user",
						installPath: "/path/to/test-plugin",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0]).toEqual({
			id: "test-plugin@test-market",
			marketplace: "test-market",
			plugin: "test-plugin",
			version: "1.0.0",
			path: "/path/to/test-plugin",
			scope: "user",
		});
	});

	test("parses plugin with project scope", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"project-plugin@market": [
					{
						scope: "project",
						installPath: "/path/to/project-plugin",
						version: "2.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].scope).toBe("project");
	});

	test("handles multiple entries per plugin ID", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"multi-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/v2",
						version: "2.0.0",
						installedAt: "2025-01-02T00:00:00Z",
						lastUpdated: "2025-01-02T00:00:00Z",
					},
					{
						scope: "project",
						installPath: "/path/to/v1",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		// Should return both entries, not just the first one
		expect(result.roots).toHaveLength(2);
		expect(result.roots[0].version).toBe("2.0.0");
		expect(result.roots[0].scope).toBe("user");
		expect(result.roots[1].version).toBe("1.0.0");
		expect(result.roots[1].scope).toBe("project");
	});

	test("warns on invalid plugin ID format", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"invalid-no-at-symbol": [
					{
						scope: "user",
						installPath: "/path/to/invalid",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("Invalid plugin ID format");
	});

	test.each(["@market", "plugin@"])("rejects incomplete plugin namespace %s", async pluginId => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					[pluginId]: [{ scope: "user", installPath: "/path/to/invalid", version: "1.0.0" }],
				},
			}),
		);

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toEqual([]);
		expect(result.warnings).toEqual([expect.stringContaining("Invalid plugin ID format")]);
	});

	test("warns on entry without installPath", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-path@market": [
					{
						scope: "user",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("has no installPath");
	});

	test("caches results for same home directory", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry: {
			version: number;
			plugins: Record<
				string,
				Array<{ scope: string; installPath: string; version: string; installedAt: string; lastUpdated: string }>
			>;
		} = {
			version: 2,
			plugins: {
				"cached-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/cached",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// First call
		const result1 = await listClaudePluginRoots(tempDir);
		expect(result1.roots).toHaveLength(1);

		// Modify the file
		registry.plugins["new-plugin@market"] = [
			{
				scope: "user",
				installPath: "/path/to/new",
				version: "1.0.0",
				installedAt: "2025-01-01T00:00:00Z",
				lastUpdated: "2025-01-01T00:00:00Z",
			},
		];
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// Second call should return cached result (still 1 plugin)
		const result2 = await listClaudePluginRoots(tempDir);
		expect(result2.roots).toHaveLength(1);

		// Exact registry invalidation must evict both the parsed file and the
		// canonical plugin-root cache entry.
		await invalidateClaudePluginRoots(tempDir);
		const result3 = await listClaudePluginRoots(tempDir);
		expect(result3.roots).toHaveLength(2);
	});

	test("does not reuse ordinary external roots for an isolated load", async () => {
		const profileHome = path.join(tempDir, "profile-home");
		const pluginsDir = path.join(profileHome, ".gjc", "plugins");
		const outsidePlugin = path.join(tempDir, "outside-plugin");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(outsidePlugin, { recursive: true });
		const registry = {
			version: 2,
			plugins: {
				"external-plugin@market": [
					{
						scope: "user",
						installPath: outsidePlugin,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const ordinary = await listClaudePluginRoots(profileHome);
		expect(ordinary.roots.map(root => root.path)).toEqual([outsidePlugin]);

		const isolated = await listClaudePluginRoots(profileHome, undefined, true);
		expect(isolated.roots).toEqual([]);
		expect(isolated.warnings).toEqual([expect.stringContaining("escapes the isolated home")]);
	});

	test("canonicalizes registry reads when a plugin cache symlink is replaced", async () => {
		const profileHome = path.join(tempDir, "profile-home-cache-swap");
		const pluginsLink = path.join(profileHome, ".gjc", "plugins");
		const poisonedRegistryDir = path.join(tempDir, "poisoned-registry");
		const safeRegistryDir = path.join(profileHome, "safe-registry");
		const safePluginPath = path.join(profileHome, "safe-plugin");
		await fs.mkdir(path.dirname(pluginsLink), { recursive: true });
		await fs.mkdir(poisonedRegistryDir, { recursive: true });
		await fs.mkdir(safeRegistryDir, { recursive: true });

		await fs.writeFile(
			path.join(poisonedRegistryDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"poisoned@market": [
						{
							scope: "user",
							installPath: safePluginPath,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.writeFile(
			path.join(safeRegistryDir, "installed_plugins.json"),
			JSON.stringify({ version: 2, plugins: {} }),
		);
		await fs.symlink(poisonedRegistryDir, pluginsLink, "dir");

		const ordinary = await listClaudePluginRoots(profileHome);
		expect(ordinary.roots.map(root => root.id)).toEqual(["poisoned@market"]);

		await fs.rm(pluginsLink, { recursive: true, force: true });
		await fs.symlink(safeRegistryDir, pluginsLink, "dir");

		const isolated = await listClaudePluginRoots(profileHome, undefined, true);
		expect(isolated.roots).toEqual([]);
		expect(isolated.warnings).toEqual([]);
	});

	test("isolated discovery rejects a registry symlink outside the supplied home", async () => {
		const profileHome = path.join(tempDir, "profile-home-registry-escape");
		const pluginsLink = path.join(profileHome, ".gjc", "plugins");
		const outsideRegistryDir = path.join(tempDir, "outside-registry");
		await fs.mkdir(path.dirname(pluginsLink), { recursive: true });
		await fs.mkdir(outsideRegistryDir, { recursive: true });
		await fs.writeFile(
			path.join(outsideRegistryDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"outside-registry@market": [
						{
							scope: "user",
							installPath: path.join(profileHome, "allowed-plugin"),
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.symlink(outsideRegistryDir, pluginsLink, "dir");

		const result = await listClaudePluginRoots(profileHome, undefined, true);
		expect(result.roots).toEqual([]);
		expect(result.warnings).toEqual([expect.stringContaining("outside the isolated home")]);
	});

	test("isolated registry reads do not poison a later ordinary load", async () => {
		const profileHome = path.join(tempDir, "profile-home-isolated-first");
		const pluginsLink = path.join(profileHome, ".gjc", "plugins");
		const safeRegistryDir = path.join(profileHome, "safe-registry");
		const ordinaryRegistryDir = path.join(tempDir, "ordinary-registry");
		await fs.mkdir(path.dirname(pluginsLink), { recursive: true });
		await fs.mkdir(safeRegistryDir, { recursive: true });
		await fs.mkdir(ordinaryRegistryDir, { recursive: true });
		await fs.writeFile(
			path.join(safeRegistryDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"isolated-only@market": [
						{
							scope: "user",
							installPath: path.join(profileHome, "isolated-plugin"),
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.writeFile(
			path.join(ordinaryRegistryDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"ordinary-only@market": [
						{
							scope: "user",
							installPath: path.join(tempDir, "ordinary-plugin"),
							version: "2.0.0",
							installedAt: "2025-01-02T00:00:00Z",
							lastUpdated: "2025-01-02T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.symlink(safeRegistryDir, pluginsLink, "dir");

		const isolated = await listClaudePluginRoots(profileHome, undefined, true);
		expect(isolated.roots.map(root => root.id)).toEqual(["isolated-only@market"]);

		await fs.rm(pluginsLink, { recursive: true, force: true });
		await fs.symlink(ordinaryRegistryDir, pluginsLink, "dir");

		const ordinary = await listClaudePluginRoots(profileHome);
		expect(ordinary.roots.map(root => root.id)).toEqual(["ordinary-only@market"]);
	});

	test("defaults scope to user when not specified", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-scope@market": [
					{
						installPath: "/path/to/no-scope",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].scope).toBe("user");
	});

	test("isolated manifest reads bypass a poisoned same-lexical cache entry", async () => {
		const profileHome = path.join(tempDir, "isolated-manifest-home");
		const project = path.join(profileHome, "project");
		const pluginsDir = path.join(profileHome, ".gjc", "plugins");
		const pluginPath = path.join(profileHome, "plugins", "manifest-cache-swap");
		const safeManifest = path.join(pluginPath, "safe-plugin.json");
		const externalManifest = path.join(tempDir, "external-plugin.json");
		const manifestPath = path.join(pluginPath, ".claude-plugin", "plugin.json");
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.dirname(manifestPath), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "skills", "safe-skill"), { recursive: true });
		await fs.writeFile(safeManifest, JSON.stringify({ skills: "./skills" }));
		await fs.writeFile(externalManifest, JSON.stringify({ skills: "./external-skills" }));
		await fs.writeFile(
			path.join(pluginPath, "skills", "safe-skill", "SKILL.md"),
			"---\nname: safe-skill\ndescription: Safe skill\n---\nSafe\n",
		);
		await fs.symlink(externalManifest, manifestPath, "file");
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"manifest-cache-swap@market": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);

		expect(await readDiscoveryFile(manifestPath)).toContain("external-skills");
		await fs.rm(manifestPath);
		await fs.symlink(safeManifest, manifestPath, "file");

		const result = await loadCapabilityForHome<Skill>("skills", profileHome, {
			cwd: project,
			providers: ["claude-plugins"],
		});
		expect(result.items.map(skill => skill.name)).toEqual(["manifest-cache-swap:safe-skill"]);
		expect(result.items[0]?._source.path).toBe(path.join(pluginPath, "skills", "safe-skill", "SKILL.md"));
	});

	test("isolated plugin MCP reads bypass a poisoned same-lexical cache entry", async () => {
		const profileHome = path.join(tempDir, "isolated-mcp-home");
		const project = path.join(profileHome, "project");
		const pluginsDir = path.join(profileHome, ".gjc", "plugins");
		const pluginPath = path.join(profileHome, "plugins", "mcp-cache-swap");
		const safeMcp = path.join(pluginPath, "safe.mcp.json");
		const externalMcp = path.join(tempDir, "external.mcp.json");
		const mcpPath = path.join(pluginPath, ".mcp.json");
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });
		await fs.writeFile(safeMcp, JSON.stringify({ safe: { command: "safe-command" } }));
		await fs.writeFile(externalMcp, JSON.stringify({ poisoned: { command: "poisoned-command" } }));
		await fs.symlink(externalMcp, mcpPath, "file");
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"mcp-cache-swap@market": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);

		expect(await readDiscoveryFile(mcpPath)).toContain("poisoned-command");
		await fs.rm(mcpPath);
		await fs.symlink(safeMcp, mcpPath, "file");

		const result = await loadCapabilityForHome<MCPServer>("mcps", profileHome, {
			cwd: project,
			providers: ["claude-plugins"],
		});
		expect(result.items.map(server => server.name)).toEqual(["mcp-cache-swap:safe"]);
		expect(result.items[0]?._source.path).toBe(safeMcp);
	});
	test("reads skills directory from plugin manifest skills field", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "skills", "manifest-skill"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "./.claude/skills" }),
		);
		await fs.writeFile(
			path.join(pluginPath, ".claude", "skills", "manifest-skill", "SKILL.md"),
			"---\nname: manifest-skill\ndescription: Manifest skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.length).toBeGreaterThan(0);
		const found = result.all.find(skill => skill.name === "manifest-skills:manifest-skill");

		expect(found).toBeDefined();
		expect(found?.path).toContain(path.join(".claude", "skills", "manifest-skill", "SKILL.md"));
	});

	test("reads slash commands directory from plugin manifest slash-commands field", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ "slash-commands": "./.claude/commands" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "ship.md"), "Ship it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.length).toBeGreaterThan(0);
		const found = result.all.find(command => command.name === "manifest-commands:ship");

		expect(found).toBeDefined();
		expect(found?.path).toContain(path.join(".claude", "commands", "ship.md"));
	});

	test("reads slash commands directory from plugin manifest commands field (standard Claude plugin format)", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-key");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-key@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: "./.claude/commands" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "plan.md"), "Plan it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		const found = result.all.find(command => command.name === "manifest-commands-key:plan");

		expect(found).toBeDefined();
		expect(found?.path).toContain(path.join(".claude", "commands", "plan.md"));
	});

	test("commands field takes precedence over slash-commands field when both are present", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-precedence");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		// commands points to .Anthropic model/commands, slash-commands points to a different dir
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "legacy-commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-precedence@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: "./.claude/commands", "slash-commands": "./legacy-commands" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "ship.md"), "Ship it\n");
		// This file exists only under the legacy dir — should NOT be found
		await fs.writeFile(path.join(pluginPath, "legacy-commands", "old.md"), "Old\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		const found = result.all.find(command => command.name === "manifest-commands-precedence:ship");
		const notFound = result.all.find(command => command.name === "manifest-commands-precedence:old");

		expect(found).toBeDefined();
		expect(notFound).toBeUndefined();
	});
	test("ignores manifest skills directory that resolves outside plugin root", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills-outside");
		const outsideDir = path.join(tempDir, "outside-skills", "outside-skill");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills-outside@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "../../outside-skills" }),
		);
		await fs.writeFile(
			path.join(outsideDir, "SKILL.md"),
			"---\nname: outside-skill\ndescription: Outside skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings[0]).toContain("Ignoring skills path outside plugin root");
		const found = result.all.find(skill => skill.name === "manifest-skills-outside:outside-skill");

		expect(found).toBeUndefined();
	});

	test("ignores manifest slash commands directory that resolves outside plugin root", async () => {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-outside");
		const outsideDir = path.join(tempDir, "outside-commands");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-outside@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ "slash-commands": "../../outside-commands" }),
		);
		await fs.writeFile(path.join(outsideDir, "ship.md"), "Ship it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings[0]).toContain("Ignoring slash-commands path outside plugin root");
		const found = result.all.find(command => command.name === "manifest-commands-outside:ship");

		expect(found).toBeUndefined();
	});

	test("isolated plugin discovery excludes symlinked skill, command, hook, and tool files outside home", async () => {
		const profileHome = path.join(tempDir, "isolated-home");
		const project = path.join(profileHome, "project");
		const pluginPath = path.join(profileHome, "plugins", "manifest-symlinks");
		const outsideRoot = path.join(tempDir, "outside-plugin-content");
		const outsideSkills = path.join(outsideRoot, "skills");
		const outsideCommands = path.join(outsideRoot, "commands");
		const outsideHooks = path.join(outsideRoot, "hooks", "pre");
		const outsideTools = path.join(outsideRoot, "tools");
		await fs.mkdir(path.join(profileHome, ".gjc", "plugins"), { recursive: true });
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(outsideSkills, { recursive: true });
		await fs.mkdir(outsideCommands, { recursive: true });
		await fs.mkdir(outsideHooks, { recursive: true });
		await fs.mkdir(outsideTools, { recursive: true });
		await fs.mkdir(path.join(outsideSkills, "outside-skill"), { recursive: true });
		await fs.writeFile(
			path.join(outsideSkills, "outside-skill", "SKILL.md"),
			"---\nname: outside-skill\ndescription: Outside skill\n---\nBody\n",
		);
		await fs.writeFile(path.join(outsideCommands, "outside.md"), "Outside command\n");
		await fs.writeFile(path.join(outsideHooks, "outside.sh"), "#!/bin/sh\n");
		await fs.writeFile(path.join(outsideTools, "outside.ts"), "export default {};\n");
		await fs.symlink(outsideSkills, path.join(pluginPath, "linked-skills"), "dir");
		await fs.symlink(outsideCommands, path.join(pluginPath, "linked-commands"), "dir");
		await fs.symlink(path.join(outsideRoot, "hooks"), path.join(pluginPath, "hooks"), "dir");
		await fs.symlink(outsideTools, path.join(pluginPath, "tools"), "dir");

		const registry = {
			version: 2,
			plugins: {
				"manifest-symlinks@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(profileHome, ".gjc", "plugins", "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "./linked-skills", commands: "./linked-commands" }),
		);

		const options = { cwd: project, providers: ["claude-plugins"] as string[] };
		const [skills, commands, hooks, tools] = await Promise.all([
			loadCapabilityForHome<Skill>("skills", profileHome, options),
			loadCapabilityForHome<SlashCommand>("slash-commands", profileHome, options),
			loadCapabilityForHome("hooks", profileHome, options),
			loadCapabilityForHome("tools", profileHome, options),
		]);

		expect(skills.items).toEqual([]);
		expect(commands.items).toEqual([]);
		expect(hooks.items).toEqual([]);
		expect(tools.items).toEqual([]);
	});

	test("isolated plugin discovery excludes symlinked leaf files outside home", async () => {
		const profileHome = path.join(tempDir, "isolated-home-leaves");
		const project = path.join(profileHome, "project");
		const pluginPath = path.join(profileHome, "plugins", "leaf-symlinks");
		const outsideRoot = path.join(tempDir, "outside-plugin-leaves");
		const outsideSkill = path.join(outsideRoot, "outside-skill.md");
		const outsideCommand = path.join(outsideRoot, "outside-command.md");
		const outsideHook = path.join(outsideRoot, "outside-hook.sh");
		const outsideTool = path.join(outsideRoot, "outside-tool.ts");
		await fs.mkdir(path.join(profileHome, ".gjc", "plugins"), { recursive: true });
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "skills", "leaf-skill"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "commands"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "hooks", "pre"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "tools"), { recursive: true });
		await fs.mkdir(outsideRoot, { recursive: true });
		await fs.writeFile(outsideSkill, "---\nname: outside-skill\ndescription: Outside skill\n---\nBody\n");
		await fs.writeFile(outsideCommand, "Outside command\n");
		await fs.writeFile(outsideHook, "#!/bin/sh\n");
		await fs.writeFile(outsideTool, "export default {};\n");
		await fs.symlink(outsideSkill, path.join(pluginPath, "skills", "leaf-skill", "SKILL.md"), "file");
		await fs.symlink(outsideCommand, path.join(pluginPath, "commands", "leaf.md"), "file");
		await fs.symlink(outsideHook, path.join(pluginPath, "hooks", "pre", "leaf.sh"), "file");
		await fs.symlink(outsideTool, path.join(pluginPath, "tools", "leaf.ts"), "file");
		await fs.writeFile(
			path.join(profileHome, ".gjc", "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"leaf-symlinks@market": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "./skills", commands: "./commands" }),
		);

		const options = { cwd: project, providers: ["claude-plugins"] as string[] };
		const [skills, commands, hooks, tools] = await Promise.all([
			loadCapabilityForHome<Skill>("skills", profileHome, options),
			loadCapabilityForHome<SlashCommand>("slash-commands", profileHome, options),
			loadCapabilityForHome("hooks", profileHome, options),
			loadCapabilityForHome("tools", profileHome, options),
		]);

		expect(skills.items).toEqual([]);
		expect(commands.items).toEqual([]);
		expect(hooks.items).toEqual([]);
		expect(tools.items).toEqual([]);
	});
});

describe("discoverAgents plugin precedence", () => {
	let tempDir: string;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugins-precedence-test-"));
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		await safeRm(tempDir, { recursive: true, force: true });
	});

	test("prefers project-scoped plugin agent over user-scoped plugin agent", async () => {
		const pluginRegistryDir = path.join(tempDir, ".gjc", "plugins");
		const projectPluginPath = path.join(tempDir, "plugins", "project");
		const userPluginPath = path.join(tempDir, "plugins", "user");
		const agentName = "plugin-precedence-test-agent";

		await fs.mkdir(pluginRegistryDir, { recursive: true });
		await fs.mkdir(path.join(projectPluginPath, "agents"), { recursive: true });
		await fs.mkdir(path.join(userPluginPath, "agents"), { recursive: true });

		const projectAgent = `---\nname: ${agentName}\ndescription: Project plugin version\n---\nProject scope agent`;
		const userAgent = `---\nname: ${agentName}\ndescription: User plugin version\n---\nUser scope agent`;

		await fs.writeFile(path.join(projectPluginPath, "agents", "shared.md"), projectAgent);
		await fs.writeFile(path.join(userPluginPath, "agents", "shared.md"), userAgent);

		const registry = {
			version: 2,
			plugins: {
				"shared-plugin@market": [
					{
						scope: "project",
						installPath: projectPluginPath,
						version: "1.0.1",
						installedAt: "2025-01-02T00:00:00Z",
						lastUpdated: "2025-01-02T00:00:00Z",
					},
					{
						scope: "user",
						installPath: userPluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginRegistryDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await discoverAgents(tempDir, tempDir);
		const found = result.agents.find(agent => agent.name === agentName);

		expect(found).toBeDefined();
		expect(found?.source).toBe("project");
		expect(found?.filePath).toContain(projectPluginPath);
	});
});
