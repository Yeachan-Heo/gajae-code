import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MarketplaceManager } from "../../../extensibility/plugins/marketplace";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	pluginHandlers,
	pluginInstalledHandler,
	pluginInstallHandler,
	pluginListHandler,
	pluginReadHandler,
	pluginSkillReadHandler,
	pluginUninstallHandler,
} from "../../suites/plugin-handlers";

type HandlerValue = { ok: true; result: unknown } | { ok: false; errorKey: string };

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-suite-"));
const sourceRoot = path.join(tempRoot, "marketplace-source");
const pluginRoot = path.join(sourceRoot, "plugins", "hello-plugin");
const previousAgentDir = process.env.GJC_AGENT_DIR;
const previousCwd = process.cwd();

function resultOf(value: HandlerValue): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

function managerForTempRoot(): MarketplaceManager {
	return new MarketplaceManager({
		marketplacesRegistryPath: path.join(tempRoot, "marketplaces.json"),
		installedRegistryPath: path.join(tempRoot, "plugins", "installed_plugins.json"),
		marketplacesCacheDir: path.join(tempRoot, "plugins", "cache", "marketplaces"),
		pluginsCacheDir: path.join(tempRoot, "plugins", "cache", "plugins"),
	});
}

beforeAll(async () => {
	process.env.GJC_AGENT_DIR = tempRoot;
	mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
	mkdirSync(path.join(sourceRoot, ".claude-plugin"), { recursive: true });
	mkdirSync(path.join(pluginRoot, "skills", "greet"), { recursive: true });
	writeFileSync(
		path.join(sourceRoot, ".claude-plugin", "marketplace.json"),
		JSON.stringify(
			{
				name: "local-marketplace",
				owner: { name: "GJC Test" },
				plugins: [
					{
						name: "hello-plugin",
						source: "./plugins/hello-plugin",
						description: "A real local plugin",
						version: "1.0.0",
						keywords: ["fixture"],
					},
				],
			},
			null,
			2,
		),
	);
	writeFileSync(
		path.join(pluginRoot, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "hello-plugin", description: "Manifest description", version: "1.0.0" }, null, 2),
	);
	writeFileSync(
		path.join(pluginRoot, ".mcp.json"),
		JSON.stringify({ mcpServers: { fixture: { command: "fixture-server" } } }, null, 2),
	);
	writeFileSync(
		path.join(pluginRoot, "skills", "greet", "SKILL.md"),
		"---\nname: greet\ndescription: A real greeting skill\n---\n\nSay hello from the fixture.\n",
	);
	await managerForTempRoot().addMarketplace(sourceRoot);
});

afterAll(() => {
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
	else process.env.GJC_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
});

test("PLUGIN-001 list and installed project the real local marketplace inventory", async () => {
	const listed = await pluginListHandler({ forceRefetch: false });
	const listResult = resultOf(listed) as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["plugin/list"](listResult)).toBe(true);
	expect(listResult).toMatchObject({
		featuredPluginIds: [],
		marketplaces: [
			{
				name: "local-marketplace",
				plugins: [
					{
						id: "hello-plugin@local-marketplace",
						name: "hello-plugin",
						version: "1.0.0",
						installed: false,
						source: { type: "local" },
					},
				],
			},
		],
	});

	const installed = await pluginInstalledHandler({});
	const installedResult = resultOf(installed) as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["plugin/installed"](installedResult)).toBe(true);
	expect(installedResult).toMatchObject({ marketplaces: [], marketplaceLoadErrors: [] });
});

test("PLUGIN-002 read returns the real manifest, MCP metadata, and skill inventory", async () => {
	const read = await pluginReadHandler({ pluginName: "hello-plugin", remoteMarketplaceName: "local-marketplace" });
	const readResult = resultOf(read) as Record<string, any>;
	expect(stableValidators.clientRequestResults["plugin/read"](readResult)).toBe(true);
	expect(readResult.plugin).toMatchObject({
		marketplaceName: "local-marketplace",
		description: "Manifest description",
		mcpServers: ["fixture"],
		skills: [
			{
				name: "greet",
				description: "A real greeting skill",
				enabled: true,
			},
		],
		summary: {
			id: "hello-plugin@local-marketplace",
			name: "hello-plugin",
			version: "1.0.0",
			installed: false,
		},
	});
});

test("PLUGIN-003 local install and uninstall use the real cache and registry seams", async () => {
	const installed = await pluginInstallHandler({
		pluginName: "hello-plugin",
		remoteMarketplaceName: "local-marketplace",
	});
	const installResult = resultOf(installed) as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["plugin/install"](installResult)).toBe(true);
	expect(installResult).toEqual({ appsNeedingAuth: [], authPolicy: "ON_USE" });

	const cachedPlugin = path.join(tempRoot, "plugins", "cache", "plugins", "local-marketplace___hello-plugin___1.0.0");
	expect(existsSync(cachedPlugin)).toBe(true);
	expect(readFileSync(path.join(cachedPlugin, ".claude-plugin", "plugin.json"), "utf8")).toContain(
		"Manifest description",
	);

	const afterInstall = await pluginInstalledHandler({});
	const afterInstallResult = resultOf(afterInstall) as Record<string, any>;
	expect(stableValidators.clientRequestResults["plugin/installed"](afterInstallResult)).toBe(true);
	expect(afterInstallResult.marketplaces[0].plugins[0]).toMatchObject({
		id: "hello-plugin@local-marketplace",
		installed: true,
		localVersion: "1.0.0",
	});

	const listAfterInstall = resultOf(await pluginListHandler({ forceRefetch: false })) as Record<string, any>;
	expect(stableValidators.clientRequestResults["plugin/list"](listAfterInstall)).toBe(true);
	expect(listAfterInstall.marketplaces[0].plugins[0]).toMatchObject({
		id: "hello-plugin@local-marketplace",
		installed: true,
		localVersion: "1.0.0",
	});

	const skill = await pluginSkillReadHandler({
		remoteMarketplaceName: "local-marketplace",
		remotePluginId: "hello-plugin",
		skillName: "greet",
	});
	const skillResult = resultOf(skill) as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["plugin/skill/read"](skillResult)).toBe(true);
	expect(skillResult.contents).toContain("Say hello from the fixture.");

	const uninstalled = await pluginUninstallHandler({ pluginId: "hello-plugin@local-marketplace" });
	const uninstallResult = resultOf(uninstalled) as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["plugin/uninstall"](uninstallResult)).toBe(true);
	expect(uninstallResult).toEqual({});
	expect(existsSync(cachedPlugin)).toBe(false);
	const afterUninstall = resultOf(await pluginInstalledHandler({})) as Record<string, unknown>;
	expect(afterUninstall).toMatchObject({ marketplaces: [], marketplaceLoadErrors: [] });
});

test("PLUGIN-004 unknown ids return the pinned notFound error and malformed params are invalid", async () => {
	expect(await pluginReadHandler({ pluginName: "ghost", remoteMarketplaceName: "local-marketplace" })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
	expect(
		await pluginSkillReadHandler({
			remoteMarketplaceName: "local-marketplace",
			remotePluginId: "ghost",
			skillName: "greet",
		}),
	).toEqual({ ok: false, errorKey: "notFound" });
	expect(await pluginUninstallHandler({ pluginId: "ghost@local-marketplace" })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
	expect(await pluginListHandler({})).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await pluginInstallHandler({ pluginName: 42 })).toEqual({ ok: false, errorKey: "invalidParams" });
});

test("PLUGIN-005 registers only the genuinely backed plugin methods", () => {
	expect(Object.keys(pluginHandlers).sort()).toEqual([
		"plugin/install",
		"plugin/installed",
		"plugin/list",
		"plugin/read",
		"plugin/skill/read",
		"plugin/uninstall",
	]);
	expect(pluginHandlers["plugin/share/list"]).toBeUndefined();
	expect(pluginHandlers["plugin/share/save"]).toBeUndefined();
	expect(pluginHandlers["plugin/share/delete"]).toBeUndefined();
	expect(pluginHandlers["plugin/share/checkout"]).toBeUndefined();
	expect(pluginHandlers["plugin/share/updateTargets"]).toBeUndefined();
});
