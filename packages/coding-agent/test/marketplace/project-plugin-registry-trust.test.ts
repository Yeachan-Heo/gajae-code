/**
 * Project plugin registries may name a cache outside the clone.
 * An installPath that resolves inside the directory that owns the registry must not become a root.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "@gajae-code/coding-agent/discovery";
import { loadSkills } from "@gajae-code/coding-agent/extensibility/skills";
import fc from "fast-check";
import { safeRmSync } from "../../../../scripts/safe-cleanup";
import {
	clearClaudePluginRootsCache,
	getPreloadedPluginRoots,
	listClaudePluginRoots,
	preloadPluginRoots,
} from "../../src/discovery/helpers";

const dirs: string[] = [];

function scratch(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function writeRegistry(file: string, installPath: string, id = "bundled@market"): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			plugins: {
				[id]: [
					{
						scope: "project",
						installPath,
						version: "1.0.0",
						installedAt: "2026-01-01T00:00:00.000Z",
						lastUpdated: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		}),
	);
}

function writeSkill(pluginRoot: string, name: string): void {
	const skillDir = path.join(pluginRoot, "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n`,
	);
}

afterEach(() => {
	clearClaudePluginRootsCache();
	for (const dir of dirs.splice(0)) safeRmSync(dir, { recursive: true, force: true });
});

describe("project plugin registry install path", () => {
	test("does not adopt a repository-bundled installPath", async () => {
		const home = scratch("gjc-plug-home-");
		const project = scratch("gjc-plug-repo-");
		fs.mkdirSync(path.join(project, ".gjc"), { recursive: true });
		const bundled = path.join(project, "payload");
		writeSkill(bundled, "repo-skill");
		const registry = path.join(project, ".gjc", "plugins", "installed_plugins.json");
		writeRegistry(registry, path.join(project, "sub", "..", "payload"));

		const { roots, warnings } = await listClaudePluginRoots(home, project);
		expect(roots.some(root => root.id === "bundled@market")).toBe(false);
		expect(warnings.some(warning => warning.includes("inside the project tree"))).toBe(true);

		const loaded = await loadSkills({ cwd: project, home });
		expect(loaded.skills.map(skill => skill.name)).not.toContain("bundled:repo-skill");
	});

	test("still allowed project installPath outside the repository", async () => {
		const home = scratch("gjc-plug-home-");
		const project = scratch("gjc-plug-repo-");
		fs.mkdirSync(path.join(project, ".gjc"), { recursive: true });
		const cache = path.join(home, ".gjc", "plugins", "cache", "plugins", "ok___market___1.0.0");
		writeSkill(cache, "cache-skill");
		const userRoot = path.join(home, "user-plugin");
		writeSkill(userRoot, "user-skill");
		fs.mkdirSync(path.join(home, ".gjc", "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".gjc", "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"ok@market": [
						{
							scope: "user",
							installPath: userRoot,
							version: "0.1.0",
							installedAt: "2026-01-01T00:00:00.000Z",
							lastUpdated: "2026-01-01T00:00:00.000Z",
						},
					],
				},
			}),
		);
		writeRegistry(path.join(project, ".gjc", "plugins", "installed_plugins.json"), cache, "ok@market");

		const { roots } = await listClaudePluginRoots(home, project);
		const matched = roots.filter(root => root.id === "ok@market");
		expect(matched).toHaveLength(1);
		expect(matched[0]?.scope).toBe("project");
		expect(matched[0]?.path).toBe(cache);

		const loaded = await loadSkills({ cwd: project, home });
		expect(loaded.skills.map(skill => skill.name)).toContain("ok:cache-skill");
	});

	test.skipIf(process.platform === "win32")(
		"rejects an outside symlink whose target is inside the repository",
		async () => {
			const home = scratch("gjc-plug-home-");
			const project = scratch("gjc-plug-repo-");
			fs.mkdirSync(path.join(project, ".gjc"), { recursive: true });
			const bundled = path.join(project, "payload");
			writeSkill(bundled, "link-skill");
			const link = path.join(home, "link-plugin");
			fs.symlinkSync(bundled, link, "dir");
			writeRegistry(path.join(project, ".gjc", "plugins", "installed_plugins.json"), link, "linked@market");

			const { roots } = await listClaudePluginRoots(home, project);
			expect(roots.some(root => root.id === "linked@market")).toBe(false);
			const loaded = await loadSkills({ cwd: project, home });
			expect(loaded.skills.map(skill => skill.name)).not.toContain("linked:link-skill");
		},
	);

	test.skipIf(process.platform === "win32")(
		"does not adopt an in-repository root warmed from another anchor",
		async () => {
			const home = scratch("gjc-plug-home-");
			const projectA = scratch("gjc-plug-anchor-a-");
			const projectB = scratch("gjc-plug-anchor-b-");
			const payload = path.join(projectB, "payload");
			writeSkill(payload, "shared-skill");
			const registryB = path.join(projectB, ".gjc", "plugins", "installed_plugins.json");
			writeRegistry(registryB, payload, "bad@market");
			const registryA = path.join(projectA, ".gjc", "plugins", "installed_plugins.json");
			fs.mkdirSync(path.dirname(registryA), { recursive: true });
			fs.symlinkSync(registryB, registryA);

			clearClaudePluginRootsCache();
			const fromA = await listClaudePluginRoots(home, projectA);
			expect(fromA.roots.some(root => root.id === "bad@market")).toBe(true);
			const fromB = await listClaudePluginRoots(home, projectB);
			expect(fromB.roots.some(root => root.id === "bad@market")).toBe(false);
			expect(fromB.warnings.some(warning => warning.includes("inside the project tree"))).toBe(true);
			await preloadPluginRoots(home, projectB);
			expect(getPreloadedPluginRoots().some(root => root.id === "bad@market")).toBe(false);
			const loaded = await loadSkills({ cwd: projectB, home });
			expect(loaded.skills.map(skill => skill.name)).not.toContain("bad:shared-skill");
		},
	);

	test.skipIf(process.platform === "win32")(
		"still allows an outside installPath after another anchor read the same registry",
		async () => {
			const home = scratch("gjc-plug-home-");
			const projectA = scratch("gjc-plug-anchor-a-");
			const projectB = scratch("gjc-plug-anchor-b-");
			const payload = path.join(projectB, "payload");
			writeSkill(payload, "shared-skill");
			const registryB = path.join(projectB, ".gjc", "plugins", "installed_plugins.json");
			writeRegistry(registryB, payload, "bad@market");
			const registryA = path.join(projectA, ".gjc", "plugins", "installed_plugins.json");
			fs.mkdirSync(path.dirname(registryA), { recursive: true });
			fs.symlinkSync(registryB, registryA);

			clearClaudePluginRootsCache();
			await listClaudePluginRoots(home, projectB);
			const fromA = await listClaudePluginRoots(home, projectA);
			expect(fromA.roots.some(root => root.id === "bad@market")).toBe(true);
			expect(fromA.roots.find(root => root.id === "bad@market")?.path).toBe(payload);
			await preloadPluginRoots(home, projectA);
			expect(getPreloadedPluginRoots().some(root => root.id === "bad@market")).toBe(true);
			const loaded = await loadSkills({ cwd: projectA, home });
			expect(loaded.skills.map(skill => skill.name)).toContain("bad:shared-skill");
		},
	);

	test("still allows an installPath outside the selected registry directory", async () => {
		const home = scratch("gjc-plug-home-");
		const repo = scratch("gjc-plug-repo-");
		const sub = path.join(repo, "sub");
		const payload = path.join(repo, "payload");
		writeSkill(payload, "side-skill");
		writeRegistry(path.join(sub, ".gjc", "plugins", "installed_plugins.json"), payload, "side@market");

		const { roots } = await listClaudePluginRoots(home, sub);
		expect(roots.some(root => root.id === "side@market")).toBe(true);
		const loaded = await loadSkills({ cwd: sub, home });
		expect(loaded.skills.map(skill => skill.name)).toContain("side:side-skill");
	});
});

const SEGMENT = /^[a-z0-9_-]{1,8}$/;

describe("projectRegistryInstallPathIsInsideAnchor", () => {
	test("property: project registry anchor containment, seed 461, 64 inputs", async () => {
		const { projectRegistryInstallPathIsInsideAnchor } = await import("../../src/discovery/helpers");
		const anchor = path.join(os.tmpdir(), "gjc-prop-anchor-missing");
		fc.assert(
			fc.property(fc.stringMatching(SEGMENT), segment => {
				const inside = path.join(anchor, segment);
				const prefixed = path.join(`${anchor}-other`, segment);
				const escaped = path.join(anchor, "..", `outside-${segment}`);
				expect(projectRegistryInstallPathIsInsideAnchor(anchor, inside)).toBe(true);
				expect(projectRegistryInstallPathIsInsideAnchor(anchor, `${inside}${path.sep}`)).toBe(true);
				expect(projectRegistryInstallPathIsInsideAnchor(anchor, prefixed)).toBe(false);
				expect(projectRegistryInstallPathIsInsideAnchor(anchor, escaped)).toBe(false);
				expect(projectRegistryInstallPathIsInsideAnchor(anchor, inside)).toBe(
					projectRegistryInstallPathIsInsideAnchor(anchor, inside),
				);
			}),
			{ seed: 461, numRuns: 64 },
		);
		expect(projectRegistryInstallPathIsInsideAnchor(anchor, "")).toBe(true);
		expect(projectRegistryInstallPathIsInsideAnchor("", path.join(anchor, "x"))).toBe(true);
	});

	test("case-sensitive Windows parent does not fold a different-case sibling", async () => {
		const { projectRegistryInstallPathIsInsideAnchor } = await import("../../src/discovery/helpers");
		const anchor = "C:\\work\\Repo";
		const sibling = "C:\\work\\repo\\plugin-cache";
		const parentSensitive = (directory: string) => path.win32.normalize(directory) === "C:\\work";
		expect(
			projectRegistryInstallPathIsInsideAnchor(anchor, sibling, { platform: "win32", sensitivity: parentSensitive }),
		).toBe(false);
		expect(
			projectRegistryInstallPathIsInsideAnchor(anchor, "C:\\work\\Repo\\payload", {
				platform: "win32",
				sensitivity: parentSensitive,
			}),
		).toBe(true);
		expect(
			projectRegistryInstallPathIsInsideAnchor(anchor, sibling, { platform: "win32", sensitivity: () => false }),
		).toBe(true);
		expect(
			projectRegistryInstallPathIsInsideAnchor(anchor, "D:\\work\\Repo\\payload", {
				platform: "win32",
				sensitivity: parentSensitive,
			}),
		).toBe(false);
	});
});
