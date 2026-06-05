import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "../src/capability";
import { clearCache as clearFsCache } from "../src/capability/fs";
import { hookCapability } from "../src/capability/hook";
import { mcpCapability } from "../src/capability/mcp";
import { skillCapability } from "../src/capability/skill";
import { slashCommandCapability } from "../src/capability/slash-command";
import { toolCapability } from "../src/capability/tool";
import "../src/discovery/claude-plugins";
import { clearClaudePluginRootsCache } from "../src/discovery/helpers";
import {
	discoverGjcPluginRoots,
	resolveSubskillActivationForSkillInvocation,
	toActiveSubskillEntry,
} from "../src/extensibility/gjc-plugins";
import { parseManifest } from "../src/extensibility/gjc-plugins/schema";
import { GjcPluginLoadError } from "../src/extensibility/gjc-plugins/types";
import { buildSkillPromptMessage } from "../src/extensibility/skills";
import { serializeManifestProjection } from "../src/gjc-runtime/workflow-manifest";
import { syncSkillActiveState } from "../src/skill-state/active-state";
import { discoverAgents } from "../src/task/discovery";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
let tempHome: string;
let tempCwd: string;
let originalHome: string | undefined;

async function installMixedRootRegistry(): Promise<void> {
	const pluginPath = path.join(tempHome, "plugin-install", "malicious-mixed-root");
	await fs.cp(path.join(fixturesRoot, "malicious-mixed-root"), pluginPath, { recursive: true });
	const pluginsDir = path.join(tempHome, ".gjc", "plugins");
	await fs.mkdir(pluginsDir, { recursive: true });
	await fs.writeFile(
		path.join(pluginsDir, "installed_plugins.json"),
		JSON.stringify({
			version: 2,
			plugins: {
				"malicious-mixed-root@test": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2026-01-01T00:00:00Z",
						lastUpdated: "2026-01-01T00:00:00Z",
					},
				],
			},
		}),
	);
}

async function installProjectSkillFixture(): Promise<void> {
	await fs.mkdir(path.join(tempCwd, ".gjc", "gjc-plugins"), { recursive: true });
	await fs.cp(
		path.join(fixturesRoot, "valid-skill-plugin"),
		path.join(tempCwd, ".gjc", "gjc-plugins", "valid-skill-plugin"),
		{ recursive: true },
	);
}

beforeEach(async () => {
	clearClaudePluginRootsCache();
	clearFsCache();
	originalHome = process.env.HOME;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-home-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-nosurface-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
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
	await fs.rm(tempHome, { recursive: true, force: true });
	await fs.rm(tempCwd, { recursive: true, force: true });
});

describe("GJC plugin roots never surface through legacy claude plugin providers", () => {
	test("gajae-plugin.json root is excluded from all legacy claude-plugin capability categories", async () => {
		await installMixedRootRegistry();

		const [skills, commands, hooks, tools, mcps] = await Promise.all([
			loadCapability(skillCapability.id, { cwd: tempCwd, providers: ["claude-plugins"] }),
			loadCapability(slashCommandCapability.id, { cwd: tempCwd, providers: ["claude-plugins"] }),
			loadCapability(hookCapability.id, { cwd: tempCwd, providers: ["claude-plugins"] }),
			loadCapability(toolCapability.id, { cwd: tempCwd, providers: ["claude-plugins"] }),
			loadCapability(mcpCapability.id, { cwd: tempCwd, providers: ["claude-plugins"] }),
		]);

		expect(skills.items).toHaveLength(0);
		expect(commands.items).toHaveLength(0);
		expect(hooks.items).toHaveLength(0);
		expect(tools.items).toHaveLength(0);
		expect(mcps.items).toHaveLength(0);
		for (const result of [skills, commands, hooks, tools, mcps]) {
			expect(result.warnings.join("\n")).toContain("Skipping gajae-code plugin root");
		}
	});

	test("task agent discovery excludes agents from gajae-plugin.json roots", async () => {
		await installMixedRootRegistry();
		await fs.mkdir(path.join(tempHome, "plugin-install", "malicious-mixed-root", "agents"), { recursive: true });
		await fs.writeFile(
			path.join(tempHome, "plugin-install", "malicious-mixed-root", "agents", "leak.md"),
			[
				"---",
				"name: malicious-gjc-agent",
				"description: should not load from gajae roots",
				"---",
				"Do not load me.",
			].join("\n"),
		);

		const result = await discoverAgents(tempCwd, tempHome);

		expect(result.agents.map(agent => agent.name)).not.toContain("malicious-gjc-agent");
	});

	test("parseManifest rejects agents as a forbidden extension surface", () => {
		try {
			parseManifest(
				{
					kind: "gajae-code-plugin",
					name: "forbidden-agents",
					version: "1.0.0",
					subskills: [],
					tools: [],
					agents: [],
				},
				"/plugin/agents/gajae-plugin.json",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(GjcPluginLoadError);
			expect((error as GjcPluginLoadError).code).toBe("forbidden_surface");
			return;
		}
		throw new Error("Expected forbidden_surface load error");
	});

	test("phase graph manifest projection is byte-identical across plugin discovery, activation, state persist, and injection", async () => {
		await installProjectSkillFixture();
		const before = serializeManifestProjection();
		expect(before).not.toContain("design");

		const roots = await discoverGjcPluginRoots({ cwd: tempCwd });
		expect(roots.some(root => root.endsWith(path.join(".gjc", "gjc-plugins", "valid-skill-plugin")))).toBe(true);
		const activation = await resolveSubskillActivationForSkillInvocation({
			cwd: tempCwd,
			skillName: "ralplan",
			args: "--design --interactive",
		});
		expect(activation.cleanedArgs).toBe("--interactive");
		expect(activation.activation).toBeDefined();
		await syncSkillActiveState({
			cwd: tempCwd,
			skill: "ralplan",
			active: true,
			phase: "planner",
			active_subskills: activation.activeSubskillsToPersist.map(toActiveSubskillEntry),
		});
		const skill = {
			name: "ralplan",
			filePath: "/bundled/ralplan/SKILL.md",
			content: "---\nname: ralplan\ndescription: planning\n---\nRalplan body",
		};
		const built = await buildSkillPromptMessage(skill, activation.cleanedArgs, {
			cwd: tempCwd,
			currentPhase: "planner",
			subskillActivation: activation.activation,
		});
		expect(built.message).toContain("<gjc-subskill");
		const after = serializeManifestProjection();
		expect(after).toBe(before);
	});
});
