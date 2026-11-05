import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	getPluginsDir,
	getPluginsNodeModules,
	getPluginsPackageJson,
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
		JSON.stringify({ name, version, gjc: { tools: ["index.ts"] } }, null, 2),
	);
	await fs.writeFile(path.join(pluginDir, "index.ts"), "export const tools = {};");
}

describe("plugin link", () => {
	test("registers the link so the loader, list, and package manifest agree", async () => {
		await writeLocalPlugin("test-local-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		const linked = await manager.link(pluginDir);
		expect(linked).toMatchObject({ name: "test-local-plugin", version: "1.0.0", enabled: true });

		const pkg = await Bun.file(getPluginsPackageJson()).json();
		// A file: spec keeps later `bun install` runs in the plugin store resolving the
		// local directory instead of fetching the name from the registry.
		expect(pkg.dependencies["test-local-plugin"]).toBe(`file:${pluginDir}`);

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

	test("linked plugin survives bun install of another plugin", async () => {
		await writeLocalPlugin("test-local-plugin", "1.0.0");
		const cwd = await fs.mkdtemp(path.join(tempHome, "cwd-"));
		const manager = new PluginManager(cwd);

		// Link the first plugin
		const linked = await manager.link(pluginDir);
		expect(linked.name).toBe("test-local-plugin");

		// Verify it's in package.json with file: spec
		let pkg = await Bun.file(getPluginsPackageJson()).json();
		expect(pkg.dependencies["test-local-plugin"]).toBe(`file:${pluginDir}`);

		// Verify the link is discoverable
		let listed = await manager.list();
		expect(listed.map(p => p.name)).toContain("test-local-plugin");

		// Try to install a second plugin - this should not break the link
		// We do a dry-run to avoid needing a published package
		const installed = await manager.install("lodash@4.17.21", { dryRun: true });
		expect(installed.name).toBe("lodash");

		// Verify the linked plugin is still there
		pkg = await Bun.file(getPluginsPackageJson()).json();
		expect(pkg.dependencies["test-local-plugin"]).toBe(`file:${pluginDir}`);

		listed = await manager.list();
		expect(listed.map(p => p.name)).toContain("test-local-plugin");

		const enabled = await getEnabledPlugins(cwd);
		expect(enabled.find(plugin => plugin.name === "test-local-plugin")).toMatchObject({
			version: "1.0.0",
			enabled: true,
		});
	});
});
