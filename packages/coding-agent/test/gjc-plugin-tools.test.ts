import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

async function writeActiveSubskill(cwd: string, toolPaths: string[]): Promise<void> {
	await syncSkillActiveState({
		cwd,
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
	test("loads an active sub-skill tool unless its name is reserved", async () => {
		const cwd = await makeTempRoot();
		const toolPath = await writeTool(cwd, "domain-note.ts", "domain_note");
		await writeActiveSubskill(cwd, [toolPath]);

		const loaded = await loadActiveSubskillTools({ cwd, parent: "ralplan", phase: "planner" });
		expect(loaded.map(tool => tool.name)).toEqual(["domain_note"]);

		const reserved = await loadActiveSubskillTools({
			cwd,
			parent: "ralplan",
			phase: "planner",
			reservedToolNames: ["domain_note"],
		});
		expect(reserved).toEqual([]);
	});

	test("rejects an active sub-skill tool whose name collides with a built-in reserved name", async () => {
		const cwd = await makeTempRoot();
		const toolPath = await writeTool(cwd, "read.ts", "read");
		await writeActiveSubskill(cwd, [toolPath]);

		const loaded = await loadActiveSubskillTools({
			cwd,
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

		const loaded = await loadActiveSubskillTools({ cwd, parent: "team", phase: "planner" });

		expect(loaded).toEqual([]);
	});
});
