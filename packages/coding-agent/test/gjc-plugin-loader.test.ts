import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverGjcPluginRoots,
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
	loadGjcPlugin,
	loadGjcPlugins,
} from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const tempRoots: string[] = [];

async function copyFixtureToProject(fixtureName: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-loader-"));
	tempRoots.push(cwd);
	const pluginsDir = path.join(cwd, ".gjc", "gjc-plugins");
	await fs.mkdir(pluginsDir, { recursive: true });
	await fs.cp(path.join(fixturesRoot, fixtureName), path.join(pluginsDir, fixtureName), { recursive: true });
	return cwd;
}

async function expectLoadError(root: string, code: GjcPluginLoadErrorCode): Promise<void> {
	try {
		await loadGjcPlugin(root);
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("GJC plugin loader", () => {
	test("loads valid skill and agent plugin fixtures", async () => {
		const skill = await loadGjcPlugin(path.join(fixturesRoot, "valid-skill-plugin"));
		expect(skill.name).toBe("valid-skill-plugin");
		expect(skill.bindings).toHaveLength(1);
		expect(skill.bindings[0]).toMatchObject({ parent: "ralplan", phase: "planner", activationArg: "design" });
		expect(skill.bindings[0].toolPaths).toHaveLength(2);
		expect(skill.toolBindings).toHaveLength(2);

		const agent = await loadGjcPlugin(path.join(fixturesRoot, "valid-agent-plugin"));
		expect(agent.bindings[0]).toMatchObject({ parent: "executor", phase: "prompt", activationArg: "domain" });

		const both = await loadGjcPlugins([
			path.join(fixturesRoot, "valid-skill-plugin"),
			path.join(fixturesRoot, "valid-agent-plugin"),
		]);
		expect(both.map(plugin => plugin.name)).toEqual(["valid-skill-plugin", "valid-agent-plugin"]);
	});

	test("rejects invalid fixtures with stable error codes", async () => {
		await expectLoadError(path.join(fixturesRoot, "invalid-parent"), "invalid_parent");
		await expectLoadError(path.join(fixturesRoot, "invalid-phase"), "invalid_phase");
		await expectLoadError(path.join(fixturesRoot, "duplicate-arg"), "duplicate_arg");
		await expectLoadError(path.join(fixturesRoot, "duplicate-parent-phase"), "duplicate_parent_phase");
		await expectLoadError(path.join(fixturesRoot, "invalid-forbidden-surface"), "forbidden_surface");
	});

	test("discovers direct and nested project GJC plugin roots", async () => {
		const directCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-direct-"));
		tempRoots.push(directCwd);
		await fs.cp(path.join(fixturesRoot, "valid-skill-plugin"), path.join(directCwd, ".gjc", "gjc-plugins"), {
			recursive: true,
		});
		const directRoots = await discoverGjcPluginRoots({ cwd: directCwd });
		expect(directRoots).toContain(path.join(directCwd, ".gjc", "gjc-plugins"));

		const nestedCwd = await copyFixtureToProject("valid-agent-plugin");
		const nestedRoots = await discoverGjcPluginRoots({ cwd: nestedCwd });
		expect(nestedRoots).toContain(path.join(nestedCwd, ".gjc", "gjc-plugins", "valid-agent-plugin"));
	});
});
