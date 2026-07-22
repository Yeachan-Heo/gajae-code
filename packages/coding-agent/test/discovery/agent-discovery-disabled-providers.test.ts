/**
 * Regression test for #1075:
 * discoverAgents() must skip GJC plugin roots when the plugin provider is disabled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "../../src/capability";
import { clearCache as clearFsCache } from "../../src/capability/fs";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { clearClaudePluginRootsCache } from "../../src/discovery/helpers";
import { discoverAgents } from "../../src/task/discovery";

const PLUGIN_AGENT_MD = [
	"---",
	"name: simplifier",
	"description: A code simplifier agent from a GJC plugin",
	"---",
	"Simplify code.",
].join("\n");

describe("discoverAgents — claude-plugins disabled provider", () => {
	let tempHome: string;
	let settings: Settings;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-disco-home-"));

		// Build a fake GJC plugin install with an agents/ subdirectory.
		const pluginInstallPath = path.join(tempHome, "plugin-cache", "code-simplifier");
		const agentsDir = path.join(pluginInstallPath, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "simplifier.md"), PLUGIN_AGENT_MD);

		// Register the plugin in the GJC registry so listAnthropic modelPluginRoots picks it up.
		const gjcPluginsDir = path.join(tempHome, ".gjc", "plugins");
		fs.mkdirSync(gjcPluginsDir, { recursive: true });
		fs.writeFileSync(
			path.join(gjcPluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"code-simplifier@claude-plugins-official": [
						{
							installPath: pluginInstallPath,
							version: "1.0.0",
							scope: "user",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);

		settings = await Settings.init({ inMemory: true, cwd: tempHome });
		enableProvider("claude-plugins", settings);
		clearFsCache();
		clearClaudePluginRootsCache();
	});

	afterEach(() => {
		fs.rmSync(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
		clearFsCache();
		clearClaudePluginRootsCache();
	});

	test("includes plugin agents when claude-plugins is enabled", async () => {
		const { agents } = await discoverAgents(tempHome, tempHome, settings);
		expect(agents.map(a => a.name)).toContain("simplifier");
	});

	test("excludes plugin agents when claude-plugins is disabled", async () => {
		disableProvider("claude-plugins", settings);
		clearClaudePluginRootsCache();
		const { agents } = await discoverAgents(tempHome, tempHome, settings);
		expect(agents.map(a => a.name)).not.toContain("simplifier");
	});
});
