import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	MarketplaceManager,
	readInstalledPluginsRegistry,
} from "@gajae-code/coding-agent/extensibility/plugins/marketplace";

// Fixture: the valid-marketplace directory used across all tests.
const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "valid-marketplace");

// ── Test helper ───────────────────────────────────────────────────────────────

interface TestContext {
	manager: MarketplaceManager;
	tmpDir: string;
	/** Incremented each time clearPluginRootsCache is called. */
	clearCount: () => number;
}

const TEST_PLUGIN_ID = "hello-plugin@test-marketplace";

async function overwriteInstalledEntry(
	ctx: TestContext,
	patch: { installPath?: string; version?: string },
): Promise<string> {
	const registryPath = path.join(ctx.tmpDir, "installed_plugins.json");
	const registry = await readInstalledPluginsRegistry(registryPath);
	Object.assign(registry.plugins[TEST_PLUGIN_ID]![0], patch);
	await Bun.write(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
	return registryPath;
}

function createTestContext(): TestContext {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mgr-test-"));

	const dirs = {
		mktRegistry: path.join(tmpDir, "marketplaces.json"),
		instRegistry: path.join(tmpDir, "installed_plugins.json"),
		projectInstRegistry: path.join(tmpDir, "project_installed_plugins.json"),
		mktCache: path.join(tmpDir, "cache", "marketplaces"),
		plugCache: path.join(tmpDir, "cache", "plugins"),
	};

	let count = 0;

	const manager = new MarketplaceManager({
		marketplacesRegistryPath: dirs.mktRegistry,
		installedRegistryPath: dirs.instRegistry,
		projectInstalledRegistryPath: dirs.projectInstRegistry,
		marketplacesCacheDir: dirs.mktCache,
		pluginsCacheDir: dirs.plugCache,
		clearPluginRootsCache: () => {
			count++;
		},
	});

	return { manager, tmpDir, clearCount: () => count };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MarketplaceManager", () => {
	let ctx: TestContext;

	beforeEach(() => {
		ctx = createTestContext();
	});

	afterEach(() => {
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	// ── Marketplace lifecycle ──────────────────────────────────────────────

	it("addMarketplace with local fixture → appears in listMarketplaces", async () => {
		const entry = await ctx.manager.addMarketplace(FIXTURE_DIR);

		expect(entry.name).toBe("test-marketplace");
		expect(entry.sourceType).toBe("local");
		expect(entry.sourceUri).toBe(FIXTURE_DIR);

		const list = await ctx.manager.listMarketplaces();
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("test-marketplace");
	});

	it("addMarketplace with duplicate name → throws", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await expect(ctx.manager.addMarketplace(FIXTURE_DIR)).rejects.toThrow(/already exists/);
	});

	it("removeMarketplace → gone from list and catalog cache removed", async () => {
		const entry = await ctx.manager.addMarketplace(FIXTURE_DIR);

		// Catalog file should exist in cache
		expect(fs.existsSync(entry.catalogPath)).toBe(true);

		await ctx.manager.removeMarketplace("test-marketplace");

		const list = await ctx.manager.listMarketplaces();
		expect(list).toHaveLength(0);

		// Catalog cache dir should be gone
		const catalogDir = path.dirname(entry.catalogPath);
		expect(fs.existsSync(catalogDir)).toBe(false);
	});

	it("updateMarketplace on nonexistent marketplace → throws", async () => {
		await expect(ctx.manager.updateMarketplace("ghost")).rejects.toThrow(/not found/);
	});

	it("updateMarketplace re-fetches and updates updatedAt", async () => {
		const added = await ctx.manager.addMarketplace(FIXTURE_DIR);

		// Small sleep so clock advances
		await Bun.sleep(5);

		const updated = await ctx.manager.updateMarketplace("test-marketplace");
		expect(updated.name).toBe("test-marketplace");
		expect(updated.addedAt).toBe(added.addedAt);
		// updatedAt must be at or after addedAt
		expect(new Date(updated.updatedAt) >= new Date(added.addedAt)).toBe(true);
	});

	// ── Plugin discovery ───────────────────────────────────────────────────

	it("listAvailablePlugins → returns catalog entries", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const plugins = await ctx.manager.listAvailablePlugins();
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("hello-plugin");
	});

	it("listAvailablePlugins(marketplace) → filtered to that marketplace", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const plugins = await ctx.manager.listAvailablePlugins("test-marketplace");
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("hello-plugin");
	});

	it("listAvailablePlugins(unknown) → throws", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await expect(ctx.manager.listAvailablePlugins("no-such")).rejects.toThrow(/not found/);
	});

	// ── Install ────────────────────────────────────────────────────────────

	it("installPlugin → plugin in cache + in registry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		expect(instEntry.scope).toBe("user");
		expect(instEntry.version).toBe("1.0.0");
		expect(fs.existsSync(instEntry.installPath)).toBe(true);

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed).toHaveLength(1);
		expect(installed[0].id).toBe("hello-plugin@test-marketplace");
	});

	it("installPlugin embeds config-only marketplace LSP metadata", async () => {
		const marketplaceDir = path.join(ctx.tmpDir, "config-only-marketplace");
		const pluginDir = path.join(marketplaceDir, "plugins", "csharp-lsp");
		await fs.promises.mkdir(pluginDir, { recursive: true });
		await Bun.write(path.join(pluginDir, "README.md"), "config-only C# LSP plugin\n");
		await fs.promises.mkdir(path.join(marketplaceDir, ".claude-plugin"), { recursive: true });
		await Bun.write(
			path.join(marketplaceDir, ".claude-plugin", "marketplace.json"),
			`${JSON.stringify(
				{
					name: "config-only-marketplace",
					owner: { name: "Test Author" },
					plugins: [
						{
							name: "csharp-lsp",
							source: "./plugins/csharp-lsp",
							version: "1.0.0",
							lspServers: {
								"csharp-ls": {
									command: "csharp-ls",
									extensionToLanguage: { ".cs": "csharp" },
								},
							},
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		await ctx.manager.addMarketplace(marketplaceDir);
		const instEntry = await ctx.manager.installPlugin("csharp-lsp", "config-only-marketplace");

		const lspConfig = await Bun.file(path.join(instEntry.installPath, ".lsp.json")).json();
		expect(lspConfig).toEqual({
			servers: {
				"csharp-ls": {
					command: "csharp-ls",
					extensionToLanguage: { ".cs": "csharp" },
				},
			},
		});
	});

	it("installPlugin with scope:project → stores project scope", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace", {
			scope: "project",
		});
		expect(instEntry.scope).toBe("project");
		expect(instEntry.version).toBe("1.0.0");
		expect(fs.existsSync(instEntry.installPath)).toBe(true);

		// Verify scope was persisted to the registry, not just returned in-memory.
		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed[0].entries[0].scope).toBe("project");
	});

	it("installPlugin already installed → throws without force", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		await expect(ctx.manager.installPlugin("hello-plugin", "test-marketplace")).rejects.toThrow(/already installed/);
	});

	it("installPlugin with force:true → replaces existing", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const first = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		const second = await ctx.manager.installPlugin("hello-plugin", "test-marketplace", {
			force: true,
		});

		expect(second.installPath).toBe(first.installPath);
		expect(fs.existsSync(second.installPath)).toBe(true);

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed).toHaveLength(1);
	});

	it("installPlugin with force:true rejects an external registry path without changing the registry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		const externalDir = path.join(ctx.tmpDir, "outside-cache");
		const sentinelPath = path.join(externalDir, "sentinel.txt");
		await fs.promises.mkdir(externalDir);
		await Bun.write(sentinelPath, "keep");
		const registryPath = await overwriteInstalledEntry(ctx, { installPath: externalDir });
		const registryBefore = await Bun.file(registryPath).text();

		await expect(ctx.manager.installPlugin("hello-plugin", "test-marketplace", { force: true })).rejects.toThrow(
			/recorded install path is not its cache path/,
		);

		expect(await Bun.file(sentinelPath).text()).toBe("keep");
		expect(await Bun.file(registryPath).text()).toBe(registryBefore);
	});

	it("installPlugin rejects a version with Windows-lossy trailing punctuation", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const [marketplace] = await ctx.manager.listMarketplaces();
		const catalog = (await Bun.file(marketplace.catalogPath).json()) as {
			plugins: Array<Record<string, unknown>>;
		};
		catalog.plugins[0] = { ...catalog.plugins[0], version: "1.0.0." };
		await Bun.write(marketplace.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		await expect(ctx.manager.installPlugin("hello-plugin", "test-marketplace")).rejects.toThrow(
			/Invalid cache identity/,
		);
		const registry = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(registry.plugins).toEqual({});
	});

	it("installPlugin with nonexistent marketplace → clear error", async () => {
		await expect(ctx.manager.installPlugin("hello-plugin", "no-such-market")).rejects.toThrow(
			/Marketplace "no-such-market" not found/,
		);
	});

	it("installPlugin with nonexistent plugin in catalog → clear error", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await expect(ctx.manager.installPlugin("ghost-plugin", "test-marketplace")).rejects.toThrow(
			/Plugin "ghost-plugin" not found in marketplace "test-marketplace"/,
		);
	});

	// ── Uninstall ──────────────────────────────────────────────────────────

	it("uninstallPlugin → cache removed + deregistered", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		await ctx.manager.uninstallPlugin("hello-plugin@test-marketplace");

		expect(fs.existsSync(instEntry.installPath)).toBe(false);

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed).toHaveLength(0);
	});

	it("uninstallPlugin nonexistent → throws", async () => {
		await expect(ctx.manager.uninstallPlugin("ghost-plugin@nowhere")).rejects.toThrow(/not installed/);
	});

	it("uninstallPlugin with invalid ID format → throws clear error", async () => {
		await expect(ctx.manager.uninstallPlugin("no-at-sign")).rejects.toThrow(/Invalid plugin ID format/);
	});

	it("uninstallPlugin rejects an external registry path without deleting it or deregistering", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		const externalDir = path.join(ctx.tmpDir, "outside-cache");
		const sentinelPath = path.join(externalDir, "sentinel.txt");
		await fs.promises.mkdir(externalDir);
		await Bun.write(sentinelPath, "keep");
		const registryPath = await overwriteInstalledEntry(ctx, { installPath: externalDir });
		const registryBefore = await Bun.file(registryPath).text();

		await expect(ctx.manager.uninstallPlugin(TEST_PLUGIN_ID)).rejects.toThrow(
			/recorded install path is not its cache path/,
		);

		expect(await Bun.file(sentinelPath).text()).toBe("keep");
		expect(await Bun.file(registryPath).text()).toBe(registryBefore);
	});

	it("uninstallPlugin rejects an aliased cache path", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const entry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		const cacheDir = path.dirname(entry.installPath);
		const aliasedPath = `${cacheDir}${path.sep}..${path.sep}plugins${path.sep}${path.basename(entry.installPath)}`;
		const registryPath = await overwriteInstalledEntry(ctx, { installPath: aliasedPath });
		const registryBefore = await Bun.file(registryPath).text();

		await expect(ctx.manager.uninstallPlugin(TEST_PLUGIN_ID)).rejects.toThrow(
			/recorded install path is not its cache path/,
		);

		expect(fs.existsSync(entry.installPath)).toBe(true);
		expect(await Bun.file(registryPath).text()).toBe(registryBefore);
	});

	it("uninstallPlugin rejects a malformed recorded version", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const entry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		const registryPath = await overwriteInstalledEntry(ctx, { version: "../outside" });
		const registryBefore = await Bun.file(registryPath).text();

		await expect(ctx.manager.uninstallPlugin(TEST_PLUGIN_ID)).rejects.toThrow(/invalid recorded cache identity/);

		expect(fs.existsSync(entry.installPath)).toBe(true);
		expect(await Bun.file(registryPath).text()).toBe(registryBefore);
	});

	it("uninstallPlugin rejects a version with Windows-lossy trailing punctuation", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const entry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		const registryPath = await overwriteInstalledEntry(ctx, {
			installPath: `${entry.installPath}.`,
			version: `${entry.version}.`,
		});
		const registryBefore = await Bun.file(registryPath).text();

		await expect(ctx.manager.uninstallPlugin(TEST_PLUGIN_ID)).rejects.toThrow(/invalid recorded cache identity/);

		expect(fs.existsSync(entry.installPath)).toBe(true);
		expect(await Bun.file(registryPath).text()).toBe(registryBefore);
	});

	it("uninstallPlugin rejects a symbolic-link or junction cache entry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const entry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		const externalDir = path.join(ctx.tmpDir, "outside-cache");
		const sentinelPath = path.join(externalDir, "sentinel.txt");
		await fs.promises.mkdir(externalDir);
		await Bun.write(sentinelPath, "keep");
		fs.rmSync(entry.installPath, { recursive: true, force: true });
		fs.symlinkSync(externalDir, entry.installPath, process.platform === "win32" ? "junction" : "dir");
		const registryPath = path.join(ctx.tmpDir, "installed_plugins.json");
		const registryBefore = await Bun.file(registryPath).text();

		await expect(ctx.manager.uninstallPlugin(TEST_PLUGIN_ID)).rejects.toThrow(/symbolic link or junction/);

		expect(await Bun.file(sentinelPath).text()).toBe("keep");
		expect(await Bun.file(registryPath).text()).toBe(registryBefore);
	});

	// ── setPluginEnabled ───────────────────────────────────────────────────

	it("setPluginEnabled → persisted in registry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		await ctx.manager.setPluginEnabled("hello-plugin@test-marketplace", false);

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed[0].entries[0].enabled).toBe(false);

		await ctx.manager.setPluginEnabled("hello-plugin@test-marketplace", true);
		const updated = await ctx.manager.listInstalledPlugins();
		expect(updated[0].entries[0].enabled).toBe(true);
	});

	it("setPluginEnabled on nonexistent plugin → throws", async () => {
		await expect(ctx.manager.setPluginEnabled("ghost@nowhere", true)).rejects.toThrow(/not installed/);
	});

	// ── version fallback ───────────────────────────────────────────────────

	it("installPlugin falls back to plugin.json version when catalog version is missing", async () => {
		// Write a catalog without a version field on the plugin
		await ctx.manager.addMarketplace(FIXTURE_DIR);

		// Mutate the cached catalog to remove version
		const list = await ctx.manager.listMarketplaces();
		const catalogPath = list[0].catalogPath;
		const content = await Bun.file(catalogPath).text();
		const catalog = JSON.parse(content) as {
			plugins: Array<Record<string, unknown>>;
		};
		catalog.plugins[0] = { ...catalog.plugins[0] };
		delete catalog.plugins[0].version;
		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		// No catalog version, but fixture's .Anthropic model-plugin/plugin.json has version "1.0.0"
		expect(instEntry.version).toBe("1.0.0");
	});
	// ── Scope feature ────────────────────────────────────────────────────────

	it("installPlugin scope:project → writes to project registry, not user registry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		const projectReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "project_installed_plugins.json"));
		expect(projectReg.plugins["hello-plugin@test-marketplace"]).toBeDefined();
		expect(projectReg.plugins["hello-plugin@test-marketplace"]![0].scope).toBe("project");

		// User registry must NOT contain this plugin.
		const userReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(userReg.plugins["hello-plugin@test-marketplace"]).toBeUndefined();
	});

	it("installPlugin scope:project when no projectInstalledRegistryPath → throws", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mgr-noproj-"));
		try {
			const noProjectManager = new MarketplaceManager({
				marketplacesRegistryPath: path.join(tmp, "marketplaces.json"),
				installedRegistryPath: path.join(tmp, "installed_plugins.json"),
				marketplacesCacheDir: path.join(tmp, "cache", "marketplaces"),
				pluginsCacheDir: path.join(tmp, "cache", "plugins"),
			});
			await noProjectManager.addMarketplace(FIXTURE_DIR);
			await expect(
				noProjectManager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" }),
			).rejects.toThrow(/project directory/);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("uninstallPlugin with plugin in both scopes, no scope arg → throws disambiguation error", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await expect(ctx.manager.uninstallPlugin("hello-plugin@test-marketplace")).rejects.toThrow(
			/both user and project scope/,
		);
	});

	it("uninstallPlugin scope:user removes only user entry, keeps project entry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await ctx.manager.uninstallPlugin("hello-plugin@test-marketplace", "user");

		const userReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(userReg.plugins["hello-plugin@test-marketplace"]).toBeUndefined();

		const projectReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "project_installed_plugins.json"));
		expect(projectReg.plugins["hello-plugin@test-marketplace"]).toBeDefined();
		expect(projectReg.plugins["hello-plugin@test-marketplace"]![0].scope).toBe("project");
	});

	it("uninstallPlugin does not delete cache dir when other scope still references it", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const userEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace", {
			scope: "user",
		});
		// Same plugin+version → same cache path for the project-scope install.
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await ctx.manager.uninstallPlugin("hello-plugin@test-marketplace", "user");

		// Cache must still exist — project scope still references it.
		expect(fs.existsSync(userEntry.installPath)).toBe(true);
	});

	it("uninstallPlugin preserves a shared cache referenced by a case-variant version", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const userEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		const uppercasePath = `${userEntry.installPath}-RC`;
		const lowercasePath = `${userEntry.installPath}-rc`;
		fs.renameSync(userEntry.installPath, uppercasePath);
		await overwriteInstalledEntry(ctx, { installPath: uppercasePath, version: "1.0.0-RC" });

		const projectRegistryPath = path.join(ctx.tmpDir, "project_installed_plugins.json");
		await Bun.write(
			projectRegistryPath,
			`${JSON.stringify(
				{
					version: 2,
					plugins: {
						[TEST_PLUGIN_ID]: [
							{ ...userEntry, scope: "project", installPath: lowercasePath, version: "1.0.0-rc" },
						],
					},
				},
				null,
				2,
			)}\n`,
		);

		await ctx.manager.uninstallPlugin(TEST_PLUGIN_ID, "user");

		expect(fs.existsSync(uppercasePath)).toBe(true);
		const userRegistry = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(userRegistry.plugins[TEST_PLUGIN_ID]).toBeUndefined();
		const projectRegistry = await readInstalledPluginsRegistry(projectRegistryPath);
		expect(projectRegistry.plugins[TEST_PLUGIN_ID]).toHaveLength(1);
	});

	it("setPluginEnabled with plugin in both scopes, no scope arg → throws disambiguation error", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await expect(ctx.manager.setPluginEnabled("hello-plugin@test-marketplace", false)).rejects.toThrow(
			/both user and project scope/,
		);
	});

	it("upgradePlugin with plugin in both scopes, no scope arg → throws disambiguation error", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await expect(ctx.manager.upgradePlugin("hello-plugin@test-marketplace")).rejects.toThrow(
			/both user and project scope/,
		);
	});

	it("listInstalledPlugins marks user entry as shadowed when project entry exists for same ID", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		const installed = await ctx.manager.listInstalledPlugins();
		const userSummary = installed.find(p => p.id === "hello-plugin@test-marketplace" && p.scope === "user");
		expect(userSummary).toBeDefined();
		expect(userSummary!.shadowedBy).toBe("project");
	});

	// ── auto-update ──────────────────────────────────────────────────────────

	describe("auto-update", () => {
		// Read catalogPath from the (single) registered marketplace.
		async function getCatalogPath(): Promise<string> {
			const list = await ctx.manager.listMarketplaces();
			return list[0].catalogPath;
		}

		// Overwrite the version field on the first plugin entry in the cached catalog.
		async function bumpCatalogVersion(newVersion: string): Promise<void> {
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<Record<string, unknown>> };
			catalog.plugins[0] = { ...catalog.plugins[0], version: newVersion };
			await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
		}

		// Directly patch updatedAt in the marketplaces registry file.
		function setMarketplaceUpdatedAt(iso: string): void {
			const regPath = path.join(ctx.tmpDir, "marketplaces.json");
			const reg = JSON.parse(fs.readFileSync(regPath, "utf-8")) as {
				version: number;
				marketplaces: Array<{ updatedAt: string }>;
			};
			reg.marketplaces[0].updatedAt = iso;
			fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
		}

		it("checkForUpdates returns outdated plugins", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			await bumpCatalogVersion("2.0.0");

			const updates = await ctx.manager.checkForUpdates();

			expect(updates).toHaveLength(1);
			expect(updates[0]).toEqual({
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
				from: "1.0.0",
				to: "2.0.0",
			});
		});

		it("checkForUpdates returns empty when up to date", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			// Catalog and installed version are both 1.0.0 — nothing to report.

			const updates = await ctx.manager.checkForUpdates();
			expect(updates).toEqual([]);
		});

		it("checkForUpdates skips plugins with no catalog version", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

			// Strip the version field from the cached catalog entry.
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<Record<string, unknown>> };
			delete catalog.plugins[0].version;
			await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

			const updates = await ctx.manager.checkForUpdates();
			expect(updates).toEqual([]);
		});

		it("checkForUpdates handles missing catalog gracefully", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

			// Delete the cached catalog file; checkForUpdates must skip rather than throw.
			const catalogPath = await getCatalogPath();
			fs.unlinkSync(catalogPath);

			const updates = await ctx.manager.checkForUpdates();
			expect(updates).toEqual([]);
		});

		it("upgradePlugin updates the installed version", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			await bumpCatalogVersion("2.0.0");

			const entry = await ctx.manager.upgradePlugin("hello-plugin@test-marketplace");
			expect(entry.version).toBe("2.0.0");

			// Confirm the registry reflects the new version.
			const installed = await ctx.manager.listInstalledPlugins();
			expect(installed).toHaveLength(1);
			expect(installed[0].entries[0].version).toBe("2.0.0");
		});

		it("upgradePlugin rejects an external registry path without changing the registry", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			const externalDir = path.join(ctx.tmpDir, "outside-cache");
			const sentinelPath = path.join(externalDir, "sentinel.txt");
			await fs.promises.mkdir(externalDir);
			await Bun.write(sentinelPath, "keep");
			const registryPath = await overwriteInstalledEntry(ctx, { installPath: externalDir });
			const registryBefore = await Bun.file(registryPath).text();
			await bumpCatalogVersion("2.0.0");

			await expect(ctx.manager.upgradePlugin(TEST_PLUGIN_ID)).rejects.toThrow(
				/recorded install path is not its cache path/,
			);

			expect(await Bun.file(sentinelPath).text()).toBe("keep");
			expect(await Bun.file(registryPath).text()).toBe(registryBefore);
		});

		it("upgradePlugin rejects invalid plugin ID", async () => {
			await expect(ctx.manager.upgradePlugin("no-at-sign")).rejects.toThrow(/Invalid plugin ID/);
		});

		it("upgradePlugin preserves the scope of the existing install", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });
			await bumpCatalogVersion("2.0.0");

			const entry = await ctx.manager.upgradePlugin("hello-plugin@test-marketplace");
			expect(entry.scope).toBe("project");
			expect(entry.version).toBe("2.0.0");
		});

		it("upgradeAllPlugins upgrades outdated plugins and returns results", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

			// Inject a second plugin that has no catalog entry — checkForUpdates will skip it,
			// proving upgradeAllPlugins only acts on genuinely outdated plugins.
			const instRegPath = path.join(ctx.tmpDir, "installed_plugins.json");
			const reg = JSON.parse(fs.readFileSync(instRegPath, "utf-8")) as {
				version: number;
				plugins: Record<string, unknown[]>;
			};
			const now = new Date().toISOString();
			reg.plugins["phantom-plugin@test-marketplace"] = [
				{ scope: "user", installPath: "/nonexistent", version: "1.0.0", installedAt: now, lastUpdated: now },
			];
			fs.writeFileSync(instRegPath, JSON.stringify(reg, null, 2));

			// Only hello-plugin gets a version bump in the catalog.
			await bumpCatalogVersion("2.0.0");

			const results = await ctx.manager.upgradeAllPlugins();

			expect(results).toHaveLength(1);
			expect(results[0]).toEqual({
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
				from: "1.0.0",
				to: "2.0.0",
			});
		});

		it("upgradeAllPlugins returns empty array when all plugins are up to date", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			// No catalog modification — installed and catalog both at 1.0.0.

			const results = await ctx.manager.upgradeAllPlugins();
			expect(results).toEqual([]);
		});

		it("refreshStaleMarketplaces skips fresh marketplaces", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			// updatedAt is just now — not past the 24-hour threshold.
			await bumpCatalogVersion("2.0.0");

			await ctx.manager.refreshStaleMarketplaces();

			// Catalog should remain at 2.0.0 — the marketplace was not re-fetched.
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<{ version?: string }> };
			expect(catalog.plugins[0].version).toBe("2.0.0");
		});

		it("refreshStaleMarketplaces re-fetches stale marketplaces", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			// Tamper with catalog to simulate drift from the real source.
			await bumpCatalogVersion("2.0.0");

			// Force updatedAt to 25 hours ago — past the 24-hour staleness threshold.
			const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
			setMarketplaceUpdatedAt(staleDate);

			await ctx.manager.refreshStaleMarketplaces();

			// updateMarketplace re-fetches from FIXTURE_DIR which has version 1.0.0.
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<{ version?: string }> };
			expect(catalog.plugins[0].version).toBe("1.0.0");
		});

		it("upgradePluginAcrossScopes upgrades in all scopes, returns both entries", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });
			await bumpCatalogVersion("2.0.0");

			const entries = await ctx.manager.upgradePluginAcrossScopes("hello-plugin@test-marketplace");

			expect(entries).toHaveLength(2);
			const scopes = entries.map(e => e.scope).sort();
			expect(scopes).toEqual(["project", "user"]);
			for (const entry of entries) {
				expect(entry.version).toBe("2.0.0");
			}
		});
	});
});
