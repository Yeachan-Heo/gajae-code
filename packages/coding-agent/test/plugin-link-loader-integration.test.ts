import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getPluginsNodeModules, getPluginsPackageJson } from "@gajae-code/utils";
import { PluginManager } from "../src/extensibility/plugins/manager";
import { getEnabledPlugins } from "../src/extensibility/plugins/loader";

const tempDirs: string[] = [];

async function mkTemp(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-link-test-"));
	tempDirs.push(root);
	return root;
}

function setPaths(tempRoot: string): void {
	process.env.GJC_CODING_AGENT_DIR = tempRoot;
	process.env.GJC_AGENT_DIR = tempRoot;
}

afterEach(async () => {
	for (const dir of tempDirs) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {}
	}
	tempDirs.length = 0;
	delete process.env.GJC_CODING_AGENT_DIR;
	delete process.env.GJC_AGENT_DIR;
});

describe("Plugin link loader integration", () => {
	test("linked plugin should be discoverable by loader after link", async () => {
		const tempRoot = await mkTemp();
		setPaths(tempRoot);

		// Create a temporary plugin package
		const pluginDir = await mkTemp();
		await fs.writeFile(
			path.join(pluginDir, "package.json"),
			JSON.stringify(
				{
					name: "test-local-plugin",
					version: "1.0.0",
					gjc: {
						tools: ["index.ts"],
					},
				},
				null,
				2,
			),
		);
		await fs.writeFile(path.join(pluginDir, "index.ts"), "export const tools = {};");

		// Link the plugin
		const manager = new PluginManager(tempRoot);
		const linkResult = await manager.link(pluginDir);

		expect(linkResult.name).toBe("test-local-plugin");
		expect(linkResult.version).toBe("1.0.0");
		expect(linkResult.enabled).toBe(true);

		// Check that package.json was updated
		const pkgJsonPath = getPluginsPackageJson();
		const pkg = await Bun.file(pkgJsonPath).json();
		expect(pkg.dependencies).toHaveProperty("test-local-plugin");

		// Check that the plugin can be discovered by the loader
		const enabledPlugins = await getEnabledPlugins(tempRoot);
		expect(enabledPlugins.length).toBeGreaterThanOrEqual(1);
		const foundPlugin = enabledPlugins.find(p => p.name === "test-local-plugin");
		expect(foundPlugin).toBeDefined();
		expect(foundPlugin?.version).toBe("1.0.0");
		expect(foundPlugin?.enabled).toBe(true);

		// Check that manager.list() includes the plugin
		const listedPlugins = await manager.list();
		expect(listedPlugins.length).toBeGreaterThanOrEqual(1);
		const listedPlugin = listedPlugins.find(p => p.name === "test-local-plugin");
		expect(listedPlugin).toBeDefined();
	});

	test("linked plugin symlink is created in node_modules", async () => {
		const tempRoot = await mkTemp();
		setPaths(tempRoot);

		// Create a temporary plugin package
		const pluginDir = await mkTemp();
		await fs.writeFile(
			path.join(pluginDir, "package.json"),
			JSON.stringify(
				{
					name: "test-local-plugin-3",
					version: "3.0.0",
					gjc: {
						tools: ["index.ts"],
					},
				},
				null,
				2,
			),
		);
		await fs.writeFile(path.join(pluginDir, "index.ts"), "export const tools = {};");

		// Link the plugin
		const manager = new PluginManager(tempRoot);
		await manager.link(pluginDir);

		// Check that symlink exists in node_modules
		const nodeModulesPath = getPluginsNodeModules();
		const linkPath = path.join(nodeModulesPath, "test-local-plugin-3");
		const stats = await fs.lstat(linkPath);
		expect(stats.isSymbolicLink()).toBe(true);

		// Check that the symlink points to the plugin directory
		const targetPath = await fs.readlink(linkPath);
		expect(targetPath).toBe(pluginDir);
	});
});
