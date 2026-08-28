import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { discoverAndLoadCustomTools } from "../src/extensibility/custom-tools/loader";
import {
	installGjcBundle,
	resolveSubskillActivationForSkillInvocation,
	toActiveSubskillEntry,
} from "../src/extensibility/gjc-plugins";
import { loadActiveSubskillTools } from "../src/extensibility/gjc-plugins/tools";
import { syncSkillActiveState } from "../src/skill-state/active-state";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-tools-"));
	tempRoots.push(cwd);
	return cwd;
}

async function writeTool(cwd: string, fileName: string, toolName: string): Promise<string> {
	const toolsDir = path.join(cwd, "tools");
	await fs.mkdir(toolsDir, { recursive: true });
	const toolPath = path.join(toolsDir, fileName);
	await fs.writeFile(
		toolPath,
		`import type { CustomToolFactory } from "@gajae-code/coding-agent/extensibility/custom-tools/types";

const factory: CustomToolFactory = pi => ({
	name: ${JSON.stringify(toolName)},
	label: ${JSON.stringify(toolName)},
	description: "temp fixture tool",
	parameters: pi.zod.object({}),
	async execute() {
		return { content: [{ type: "text", text: ${JSON.stringify(toolName)} }] };
	},
});

export default factory;
`,
	);
	return toolPath;
}

async function writeInstalledPlugin(agentDir: string, pluginName: string, toolName: string): Promise<void> {
	const pluginsDir = path.join(agentDir, "plugins");
	const pluginDir = path.join(pluginsDir, "node_modules", pluginName);
	await fs.mkdir(path.join(pluginDir, "tools"), { recursive: true });
	await fs.writeFile(
		path.join(pluginsDir, "package.json"),
		JSON.stringify({ dependencies: { [pluginName]: "1.0.0" } }),
	);
	await fs.writeFile(
		path.join(pluginDir, "package.json"),
		JSON.stringify({
			version: "1.0.0",
			gjc: { kind: "gajae-code-plugin", name: pluginName, version: "1.0.0", tools: ["tools/index.ts"] },
		}),
	);
	await fs.writeFile(
		path.join(pluginDir, "tools", "index.ts"),
		`import type { CustomToolFactory } from "@gajae-code/coding-agent/extensibility/custom-tools/types";

const factory: CustomToolFactory = pi => ({
	name: ${JSON.stringify(toolName)},
	label: ${JSON.stringify(toolName)},
	description: "profile isolation fixture tool",
	parameters: pi.zod.object({}),
	async execute() {
		return { content: [{ type: "text", text: ${JSON.stringify(toolName)} }] };
	},
});

export default factory;
`,
	);
}

const TEST_SESSION_ID = "gjc-plugin-tools-test";

async function writeActiveSubskill(cwd: string, toolPaths: string[]): Promise<void> {
	await syncSkillActiveState({
		cwd,
		sessionId: TEST_SESSION_ID,
		skill: "ralplan",
		active: true,
		phase: "planner",
		active_subskills: [
			{
				plugin: "temp-plugin",
				subskillName: "design",
				parent: "ralplan",
				bindsTo: "ralplan",
				phase: "planner",
				activationArg: "design",
				filePath: path.join(cwd, "subskills", "design", "SKILL.md"),
				toolPaths,
			},
		],
	});
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("GJC plugin sub-skill tools", () => {
	test("binds capability and plugin discovery to the selected agent profile", async () => {
		const cwd = await makeTempRoot();
		const profileAgentDir = path.join(cwd, "selected-profile");
		const ambientAgentDir = path.join(cwd, "ambient-profile");
		const originalAgentDir = getAgentDir();
		await writeTool(profileAgentDir, "profile-native.ts", "profile_native");
		await writeTool(ambientAgentDir, "ambient-native.ts", "ambient_native");
		await writeInstalledPlugin(profileAgentDir, "profile-plugin", "profile_plugin");
		await writeInstalledPlugin(ambientAgentDir, "ambient-plugin", "ambient_plugin");

		try {
			setAgentDir(ambientAgentDir);
			const settings = Settings.isolated({}, { agentDir: profileAgentDir });
			const loaded = await discoverAndLoadCustomTools([], cwd, [], undefined, profileAgentDir, settings);

			expect(loaded.tools.map(({ tool }) => tool.name)).toEqual(["profile_native", "profile_plugin"]);
			expect(loaded.tools.every(({ resolvedPath }) => !resolvedPath.startsWith(ambientAgentDir))).toBe(true);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});

	test("rechecks the subskill tool digest immediately before import", async () => {
		const cwd = await makeTempRoot();
		const fixture = path.join(import.meta.dir, "fixtures", "gjc-plugins", "valid-skill-plugin");
		const installed = await installGjcBundle({ cwd }, "project", fixture);
		expect(installed.ok).toBe(true);
		const activation = await resolveSubskillActivationForSkillInvocation({
			cwd,
			skillName: "ralplan",
			args: "--design",
		});
		expect(activation.activation).toBeDefined();
		await syncSkillActiveState({
			cwd,
			sessionId: TEST_SESSION_ID,
			skill: "ralplan",
			active: true,
			phase: "planner",
			active_subskills: activation.activeSubskillsToPersist.map(toActiveSubskillEntry),
		});
		const toolPath = path.join(cwd, ".gjc", "gjc-plugins", "valid-skill-plugin", "tools", "domain-note.ts");
		let mutated = false;
		const loaded = await loadActiveSubskillTools({
			cwd,
			sessionId: TEST_SESSION_ID,
			parent: "ralplan",
			phase: "planner",
			beforeImport: async () => {
				if (mutated) return;
				mutated = true;
				await fs.appendFile(toolPath, "\n// changed after initial validation\n");
			},
		});
		expect(loaded).toEqual([]);
	});
	test("rejects a path-only active sub-skill record instead of importing an arbitrary tool", async () => {
		const cwd = await makeTempRoot();
		const toolPath = await writeTool(cwd, "domain-note.ts", "domain_note");
		await writeActiveSubskill(cwd, [toolPath]);

		const loaded = await loadActiveSubskillTools({
			cwd,
			sessionId: TEST_SESSION_ID,
			parent: "ralplan",
			phase: "planner",
		});
		expect(loaded).toEqual([]);
	});

	test("rejects an active sub-skill tool whose name collides with a built-in reserved name", async () => {
		const cwd = await makeTempRoot();
		const toolPath = await writeTool(cwd, "read.ts", "read");
		await writeActiveSubskill(cwd, [toolPath]);

		const loaded = await loadActiveSubskillTools({
			cwd,
			sessionId: TEST_SESSION_ID,
			parent: "ralplan",
			phase: "planner",
			reservedToolNames: ["read"],
		});

		expect(loaded).toEqual([]);
	});

	test("returns no tools when no sub-skill is active for the parent phase", async () => {
		const cwd = await makeTempRoot();
		const toolPath = await writeTool(cwd, "domain-note.ts", "domain_note");
		await writeActiveSubskill(cwd, [toolPath]);

		const loaded = await loadActiveSubskillTools({
			cwd,
			sessionId: TEST_SESSION_ID,
			parent: "team",
			phase: "planner",
		});

		expect(loaded).toEqual([]);
	});
});
