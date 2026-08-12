import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@gajae-code/coding-agent/capability";
import { clearCache as clearFsCache } from "@gajae-code/coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import { clearClaudePluginRootsCache } from "@gajae-code/coding-agent/discovery/helpers";
import "@gajae-code/coding-agent/discovery/claude-plugins";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
import { MarketplaceManager } from "@gajae-code/coding-agent/extensibility/plugins/marketplace";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "valid-marketplace");

describe("isolated marketplace plugin lifecycle", () => {
	const homes: string[] = [];

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
	});

	it("install → enable → discover → disable → upgrade → uninstall against a clean home", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-lifecycle-"));
		homes.push(home);
		const pluginsDir = path.join(home, ".gjc", "plugins");
		const manager = new MarketplaceManager({
			marketplacesRegistryPath: path.join(home, "marketplaces.json"),
			installedRegistryPath: path.join(pluginsDir, "installed_plugins.json"),
			marketplacesCacheDir: path.join(pluginsDir, "cache", "marketplaces"),
			pluginsCacheDir: path.join(pluginsDir, "cache", "plugins"),
			clearPluginRootsCache: clearClaudePluginRootsCache,
		});

		await manager.addMarketplace(FIXTURE_DIR);
		const installed = await manager.installPlugin("hello-plugin", "test-marketplace");
		expect(installed.trustGrant).toBe("gjc-marketplace-rule-authority.v1");
		expect(installed.treeDigest?.hex).toHaveLength(64);
		expect(installed.installPath).toContain("test-marketplace___hello-plugin___");

		await fs.mkdir(path.join(installed.installPath, "rules"), { recursive: true });
		await fs.writeFile(
			path.join(installed.installPath, "rules", "hello.md"),
			'---\ndescription: hello\nglobs:\n  - "**/*.rs"\n---\nHello\n',
		);
		const upgraded = await manager.installPlugin("hello-plugin", "test-marketplace", { force: true });
		expect(upgraded.trustGrant).toBe("gjc-marketplace-rule-authority.v1");

		await manager.setPluginEnabled("hello-plugin@test-marketplace", true);
		clearClaudePluginRootsCache();
		clearFsCache();
		const cap = getCapability(ruleCapability.id);
		const provider = cap?.providers.find(p => p.id === "claude-plugins");
		if (!provider) throw new Error("claude-plugins rules provider missing");
		const ctx: LoadContext = { cwd: home, home, repoRoot: home };
		const enabled = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
		expect(enabled.items.some(rule => rule.name === "hello")).toBe(false);

		await manager.setPluginEnabled("hello-plugin@test-marketplace", false);
		clearClaudePluginRootsCache();
		clearFsCache();
		const disabled = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
		expect(disabled.items).toHaveLength(0);

		await manager.upgradePlugin("hello-plugin@test-marketplace");
		await manager.uninstallPlugin("hello-plugin@test-marketplace");
		const remaining = await manager.listInstalledPlugins();
		expect(remaining).toHaveLength(0);
	});
});
