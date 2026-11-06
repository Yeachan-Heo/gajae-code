import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	getPluginsDir,
	getPluginsLinksRegistry,
	getPluginsNodeModules,
	setAgentDir,
} from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { getEnabledPlugins } from "../src/extensibility/plugins/loader";
import { PluginManager } from "../src/extensibility/plugins/manager";

let originalAgentDir: string;
let originalHome: string | undefined;
let tempHome: string;
let pluginDir: string;
let secondPluginDir: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	originalHome = process.env.HOME;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-link-home-"));
	pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-link-src-"));
	secondPluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-link-src2-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(path.join(tempHome, ".gjc", "agent"));
	// The plugin store must resolve inside the throwaway home, never the real one.
	expect(getPluginsDir().startsWith(tempHome)).toBe(true);
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await safeRm(tempHome, { recursive: true, force: true });
	await safeRm(pluginDir, { recursive: true, force: true });
	await safeRm(secondPluginDir, { recursive: true, force: true });
});

async function writeLocalPlugin(name: string, version: string): Promise<void> {
	await fs.writeFile(
		path.join(pluginDir, "package.json"),
		JSON.stringify({ name, version, gjc: { tools: "index.ts" } }, null, 2),
	);
	await fs.writeFile(path.join(pluginDir, "index.ts"), "export const tools = {};");
}

describe("plugin link", () => {
	test("registers the link so the loader, list, and links registry agree", async () => {
		await writeLocalPlugin("test-local-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		const linked = await manager.link(pluginDir);
		expect(linked).toMatchObject({ name: "test-local-plugin", version: "1.0.0", enabled: true });

		// Link is registered in gjc-owned registry (not in package.json dependencies)
		// so that later bun install calls won't replace the symlink with a copy.
		const registry = await Bun.file(getPluginsLinksRegistry()).json();
		expect(registry.links["test-local-plugin"]).toMatchObject({
			name: "test-local-plugin",
			version: "1.0.0",
			path: pluginDir,
		});

		const linkPath = path.join(getPluginsNodeModules(), "test-local-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(linkPath)).toBe(pluginDir);

		const enabled = await getEnabledPlugins(cwd);
		expect(enabled.find(plugin => plugin.name === "test-local-plugin")).toMatchObject({
			version: "1.0.0",
			enabled: true,
		});
		expect((await manager.list()).map(plugin => plugin.name)).toContain("test-local-plugin");
	});

	test("a later bun install in the plugin store keeps the link pointing at the source", async () => {
		await writeLocalPlugin("test-local-plugin", "1.0.0");
		await fs.writeFile(
			path.join(secondPluginDir, "package.json"),
			JSON.stringify({ name: "test-second-plugin", version: "2.0.0" }, null, 2),
		);
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);
		await manager.link(pluginDir);

		// Every `gjc plugin install` runs bun in the store, which re-resolves every
		// dependency already listed there. Use a local package so the test stays offline.
		const proc = Bun.spawn(["bun", "add", secondPluginDir], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		expect({ exitCode: await proc.exited, stderr }).toMatchObject({ exitCode: 0 });

		// The entry must stay a symlink to the source directory; a copy would stop
		// tracking edits to the linked plugin. Because the link is in the gjc registry
		// (not in package.json dependencies), `bun add` doesn't touch it.
		const linkPath = path.join(getPluginsNodeModules(), "test-local-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(linkPath)).toBe(await fs.realpath(pluginDir));

		// Link registration is in gjc registry, not in package.json
		const registry = await Bun.file(getPluginsLinksRegistry()).json();
		expect(registry.links["test-local-plugin"]).toBeDefined();

		expect((await getEnabledPlugins(cwd)).map(plugin => plugin.name)).toContain("test-local-plugin");
	});

	test("concurrent link and install don't lose updates (serialized via lock)", async () => {
		// Setup: write two local plugins for linking
		await fs.writeFile(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "link-plugin-a", version: "1.0.0", gjc: { tools: "index.ts" } }, null, 2),
		);
		await fs.writeFile(path.join(pluginDir, "index.ts"), "export const tools = {};");

		await fs.writeFile(
			path.join(secondPluginDir, "package.json"),
			JSON.stringify({ name: "link-plugin-b", version: "2.0.0", gjc: { tools: "index.ts" } }, null, 2),
		);
		await fs.writeFile(path.join(secondPluginDir, "index.ts"), "export const tools = {};");

		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Launch both link operations concurrently
		const [result1, result2] = await Promise.all([manager.link(pluginDir), manager.link(secondPluginDir)]);

		expect(result1).toMatchObject({ name: "link-plugin-a", version: "1.0.0" });
		expect(result2).toMatchObject({ name: "link-plugin-b", version: "2.0.0" });

		// Both links should be registered in the registry
		const registry = await Bun.file(getPluginsLinksRegistry()).json();
		expect(registry.links["link-plugin-a"]).toBeDefined();
		expect(registry.links["link-plugin-b"]).toBeDefined();

		// Both should be discoverable
		const plugins = await getEnabledPlugins(cwd);
		const names = plugins.map(p => p.name);
		expect(names).toContain("link-plugin-a");
		expect(names).toContain("link-plugin-b");
	});

	test("uninstall removes linked plugins from registry and node_modules", async () => {
		await writeLocalPlugin("test-unlink-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Link the plugin
		const linked = await manager.link(pluginDir);
		expect(linked).toMatchObject({ name: "test-unlink-plugin", version: "1.0.0", enabled: true });

		// Verify it's registered
		let registry = await Bun.file(getPluginsLinksRegistry()).json();
		expect(registry.links["test-unlink-plugin"]).toBeDefined();

		const linkPath = path.join(getPluginsNodeModules(), "test-unlink-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

		let plugins = await manager.list();
		expect(plugins.map(p => p.name)).toContain("test-unlink-plugin");

		let enabled = await getEnabledPlugins(cwd);
		expect(enabled.map(p => p.name)).toContain("test-unlink-plugin");

		// Uninstall the plugin
		await manager.uninstall("test-unlink-plugin");

		// Verify it's removed from registry
		registry = await Bun.file(getPluginsLinksRegistry()).json();
		expect(registry.links["test-unlink-plugin"]).toBeUndefined();

		// Verify symlink is removed
		try {
			await fs.lstat(linkPath);
			throw new Error("Expected link to be removed");
		} catch (err) {
			if (!(err instanceof Error && err.message.includes("ENOENT"))) {
				throw err;
			}
		}

		// Verify source directory is untouched
		expect((await fs.lstat(pluginDir)).isDirectory()).toBe(true);

		// Verify plugin no longer appears in list
		plugins = await manager.list();
		expect(plugins.map(p => p.name)).not.toContain("test-unlink-plugin");

		// Verify plugin no longer appears in enabled list
		enabled = await getEnabledPlugins(cwd);
		expect(enabled.map(p => p.name)).not.toContain("test-unlink-plugin");
	});

	test("doctor --fix preserves disabled state for linked plugins", async () => {
		await writeLocalPlugin("doctor-test-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Link the plugin
		await manager.link(pluginDir);

		// Disable the plugin
		const enablmentState = await manager.getEnablementState("doctor-test-plugin", "user");
		if (enablmentState.status !== "ok") {
			throw new Error(`Expected plugin to be installed, got status: ${enablmentState.status}`);
		}
		await manager.setEnabled("doctor-test-plugin", false, "user", enablmentState.baseline);

		// Verify plugin is disabled
		let enabled = await getEnabledPlugins(cwd);
		expect(enabled.map(p => p.name)).not.toContain("doctor-test-plugin");

		// Run doctor --fix
		const checks = await manager.doctor({ fix: true });
		const orphanCheck = checks.find(c => c.name === "orphan:doctor-test-plugin");
		expect(orphanCheck).toBeUndefined();

		// Verify plugin is still disabled after doctor --fix
		enabled = await getEnabledPlugins(cwd);
		expect(enabled.map(p => p.name)).not.toContain("doctor-test-plugin");

		// Verify plugin is still in the registry
		const registry = await Bun.file(getPluginsLinksRegistry()).json();
		expect(registry.links["doctor-test-plugin"]).toBeDefined();

		// Verify plugin is still in the list
		const plugins = await manager.list();
		const plugin = plugins.find(p => p.name === "doctor-test-plugin");
		expect(plugin).toBeDefined();
		expect(plugin?.enabled).toBe(false);
	});

	test("doctor --fix restores missing unscoped linked plugin symlink when node_modules exists", async () => {
		await writeLocalPlugin("unscoped-link-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Link the plugin
		const linked = await manager.link(pluginDir);
		expect(linked).toMatchObject({ name: "unscoped-link-plugin", version: "1.0.0" });

		const linkPath = path.join(getPluginsNodeModules(), "unscoped-link-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

		// Simulate missing symlink by removing it
		await fs.unlink(linkPath);

		// Verify it's missing
		try {
			await fs.lstat(linkPath);
			throw new Error("Expected link to be missing");
		} catch (err) {
			if (!(err instanceof Error && err.message.includes("ENOENT"))) {
				throw err;
			}
		}

		// Run doctor --fix to restore the symlink
		const checks = await manager.doctor({ fix: true });

		// Verify the plugin check passed after fix
		const pluginCheck = checks.find(c => c.name === "plugin:unscoped-link-plugin");
		expect(pluginCheck).toBeDefined();
		expect(pluginCheck?.fixed).toBe(true);

		// Verify symlink is restored
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(linkPath)).toBe(pluginDir);
	});

	test("doctor --fix restores missing scoped linked plugin symlink and creates scope directory", async () => {
		await fs.writeFile(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "@test/scoped-link-plugin", version: "1.0.0", gjc: { tools: "index.ts" } }, null, 2),
		);
		await fs.writeFile(path.join(pluginDir, "index.ts"), "export const tools = {};");

		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Link the scoped plugin
		const linked = await manager.link(pluginDir);
		expect(linked).toMatchObject({ name: "@test/scoped-link-plugin", version: "1.0.0" });

		const linkPath = path.join(getPluginsNodeModules(), "@test", "scoped-link-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

		// Simulate missing symlink and scope directory by removing them
		const scopeDir = path.dirname(linkPath);
		await fs.rm(scopeDir, { recursive: true, force: true });

		// Verify they're missing
		try {
			await fs.lstat(scopeDir);
			throw new Error("Expected scope directory to be missing");
		} catch (err) {
			if (!(err instanceof Error && err.message.includes("ENOENT"))) {
				throw err;
			}
		}

		// Run doctor --fix to restore the symlink and scope directory
		const checks = await manager.doctor({ fix: true });

		// Verify the plugin check passed after fix
		const pluginCheck = checks.find(c => c.name === "plugin:@test/scoped-link-plugin");
		expect(pluginCheck).toBeDefined();
		expect(pluginCheck?.fixed).toBe(true);

		// Verify scope directory and symlink are restored
		expect((await fs.lstat(scopeDir)).isDirectory()).toBe(true);
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(linkPath)).toBe(pluginDir);
	});

	test("concurrent registry writes are serialized and atomic", async () => {
		await fs.writeFile(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "atomic-test-a", version: "1.0.0", gjc: { tools: "index.ts" } }, null, 2),
		);
		await fs.writeFile(path.join(pluginDir, "index.ts"), "export const tools = {};");

		await fs.writeFile(
			path.join(secondPluginDir, "package.json"),
			JSON.stringify({ name: "atomic-test-b", version: "2.0.0", gjc: { tools: "index.ts" } }, null, 2),
		);
		await fs.writeFile(path.join(secondPluginDir, "index.ts"), "export const tools = {};");

		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Launch concurrent link operations
		const [result1, result2] = await Promise.all([manager.link(pluginDir), manager.link(secondPluginDir)]);

		expect(result1).toMatchObject({ name: "atomic-test-a", version: "1.0.0" });
		expect(result2).toMatchObject({ name: "atomic-test-b", version: "2.0.0" });

		// Verify the registry file is valid JSON and contains both entries
		const registryContent = await Bun.file(getPluginsLinksRegistry()).text();
		const registry = JSON.parse(registryContent);
		expect(registry.links["atomic-test-a"]).toBeDefined();
		expect(registry.links["atomic-test-b"]).toBeDefined();

		// Verify registry does not have .tmp files left over
		const registryPath = getPluginsLinksRegistry();
		const tmpPath = `${registryPath}.tmp`;
		try {
			await fs.lstat(tmpPath);
			throw new Error("Expected temp file to be cleaned up");
		} catch (err) {
			if (!(err instanceof Error && err.message.includes("ENOENT"))) {
				throw err;
			}
		}
	});

	test("uninstall completes when a retained transitive directory exists instead of symlink", async () => {
		await writeLocalPlugin("retained-transitive-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Link the plugin
		const linked = await manager.link(pluginDir);
		expect(linked).toMatchObject({ name: "retained-transitive-plugin", version: "1.0.0" });

		const linkPath = path.join(getPluginsNodeModules(), "retained-transitive-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

		// Simulate Bun retaining a real directory instead of the symlink
		// (e.g., because another plugin depends on it)
		await fs.unlink(linkPath);
		await fs.mkdir(linkPath);
		await fs.writeFile(path.join(linkPath, "package.json"), JSON.stringify({ name: "retained-transitive-plugin" }));

		// Uninstall should complete without throwing EISDIR
		await manager.uninstall("retained-transitive-plugin");

		// Directory should remain (retained by Bun)
		const stats = await fs.lstat(linkPath);
		expect(stats.isDirectory()).toBe(true);

		// Registry and runtime config should be updated
		const registry = await Bun.file(getPluginsLinksRegistry()).json();
		expect(registry.links["retained-transitive-plugin"]).toBeUndefined();

		const list = await manager.list();
		expect(list.find(p => p.name === "retained-transitive-plugin")).toBeUndefined();
	});

	test("Windows EPERM fallback preserves registry even if second rename fails", async () => {
		await writeLocalPlugin("test-eperm-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Link the plugin to establish a registry
		await manager.link(pluginDir);
		const registryPath = getPluginsLinksRegistry();
		const tmpPath = `${registryPath}.tmp`;

		// Read the initial registry content
		const initialRegistry = await Bun.file(registryPath).json();
		expect(initialRegistry.links["test-eperm-plugin"]).toBeDefined();

		// Mock fs.rename to fail after the first rename (old -> backup succeeds)
		// but second rename (tmp -> registry path) fails with EPERM-like behavior
		const originalRename = fs.rename;
		vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
			const oldPathStr = typeof oldPath === "string" ? oldPath : oldPath.toString();
			const newPathStr = typeof newPath === "string" ? newPath : newPath.toString();
			if (oldPathStr === tmpPath && newPathStr === registryPath) {
				// Simulate rename failure after unlink (if unlink already happened)
				// In the current buggy code, this would unlink the registry first,
				// then fail on rename, leaving no registry.
				// With the fix, the backup should still exist.
				throw new Error("Simulated EPERM failure on second rename");
			}
			return originalRename(oldPath, newPath);
		});

		// Attempt another link operation which will hit the simulated failure
		await writeLocalPlugin("test-eperm-plugin-2", "1.0.0");
		const secondPluginPath = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-link-src3-"));
		await fs.writeFile(
			path.join(secondPluginPath, "package.json"),
			JSON.stringify({ name: "test-eperm-plugin-2", version: "1.0.0", gjc: { tools: "index.ts" } }, null, 2),
		);
		await fs.writeFile(path.join(secondPluginPath, "index.ts"), "export const tools = {};");

		// This should fail, but the registry should be preserved
		let linkFailed = false;
		try {
			await manager.link(secondPluginPath);
		} catch (err) {
			linkFailed = true;
			expect(err instanceof Error && err.message.includes("Simulated EPERM failure")).toBe(true);
		}
		expect(linkFailed).toBe(true);

		vi.restoreAllMocks();

		// Verify the registry is still valid and contains the original plugin
		const recoveredRegistry = await Bun.file(registryPath).json();
		expect(recoveredRegistry.links["test-eperm-plugin"]).toBeDefined();
		expect(recoveredRegistry.links["test-eperm-plugin"].name).toBe("test-eperm-plugin");

		// Cleanup
		await safeRm(secondPluginPath, { recursive: true, force: true });
	});
});
