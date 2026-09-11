import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, loadCapabilityForHome } from "../src/capability";
import { clearCache } from "../src/capability/fs";
import { loadSkills } from "../src/extensibility/skills";
import { loadProjectContextFilesResult, loadSystemPromptFiles } from "../src/system-prompt";

const tempRoots: string[] = [];

afterEach(async () => {
	clearCache();
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("native prompt discovery agent directory", () => {
	test.skipIf(process.platform === "win32")(
		"rejects FIFO prompt leaves without blocking",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-fifo-"));
			tempRoots.push(root);
			const cwd = path.join(root, "workspace");
			const agentDir = path.join(root, "profile");
			await fs.mkdir(cwd);
			await fs.mkdir(agentDir);
			const created = Bun.spawnSync(["mkfifo", path.join(agentDir, "SYSTEM.md"), path.join(agentDir, "AGENTS.md")]);
			expect(created.exitCode).toBe(0);
			expect(await loadSystemPromptFiles({ cwd, agentDir })).toBeNull();
			const result = await loadProjectContextFilesResult({ cwd, agentDir });
			expect(result.contextFiles).toEqual([]);
		},
		2_000,
	);
	for (const [capabilityId, filename] of [
		["system-prompt", "SYSTEM.md"],
		["context-files", "AGENTS.md"],
		["rules", "RULES.md"],
	] as const) {
		for (const change of ["replace-agent", "replace-home", "create-absent-agent"]) {
			test(`${filename} retains original explicit-home authority at provider read: ${change}`, async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-authority-"));
				tempRoots.push(root);
				const home = path.join(root, "home");
				const agentDir = path.join(home, "profile");
				await fs.mkdir(home);
				if (change !== "create-absent-agent") {
					await fs.mkdir(agentDir);
					await fs.writeFile(path.join(agentDir, filename), "original authority");
				}
				const native = getCapability(capabilityId)?.providers.find(provider => provider.id === "native");
				if (!native) throw new Error(`Missing native ${capabilityId} provider`);
				const originalLoad = native.load;
				const load = spyOn(native, "load").mockImplementationOnce(async ctx => {
					if (change === "replace-agent") await fs.rename(agentDir, `${agentDir}-original`);
					if (change === "replace-home") await fs.rename(home, `${home}-original`);
					await fs.mkdir(agentDir, { recursive: true });
					await fs.writeFile(path.join(agentDir, filename), "replacement authority");
					return originalLoad(ctx);
				});
				try {
					const result = await loadCapabilityForHome(capabilityId, home, {
						cwd: home,
						agentDir,
						providers: ["native"],
					});
					expect(load).toHaveBeenCalledTimes(1);
					expect(result.items).toEqual([]);
				} finally {
					load.mockRestore();
				}
			});
		}

		for (const alias of ["contained", "escaped", "root", "hardlink"]) {
			test(`${filename} explicit-home ${alias} alias authority`, async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-alias-"));
				tempRoots.push(root);
				const home = path.join(root, "home");
				const physicalAgentDir = path.join(root, "selected-profile");
				await fs.mkdir(home);
				await fs.mkdir(physicalAgentDir);
				const agentDir = alias === "root" ? path.join(home, "profile-alias") : physicalAgentDir;
				if (alias === "root") await fs.symlink(physicalAgentDir, agentDir, "dir");
				const target = path.join(alias === "escaped" ? home : physicalAgentDir, "source.md");
				await fs.writeFile(target, "selected profile content");
				if (alias === "hardlink") await fs.link(target, path.join(agentDir, filename));
				else await fs.symlink(target, path.join(agentDir, filename), "file");
				const result = await loadCapabilityForHome<{ content: string }>(capabilityId, home, {
					cwd: home,
					agentDir,
					providers: ["native"],
				});
				expect(result.items.map(item => item.content.trim())).toEqual(
					alias === "escaped" || alias === "hardlink" ? [] : ["selected profile content"],
				);
			});
		}
	}

	for (const rootAlias of [false, true]) {
		test(`ordinary prompt discovery accepts contained leaves with root alias ${rootAlias}`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-contained-"));
			tempRoots.push(root);
			const cwd = path.join(root, "workspace");
			const physicalAgentDir = path.join(root, "profile");
			const agentDir = rootAlias ? path.join(root, "profile-alias") : physicalAgentDir;
			await fs.mkdir(cwd);
			await fs.mkdir(physicalAgentDir);
			if (rootAlias) await fs.symlink(physicalAgentDir, agentDir, "dir");
			await fs.writeFile(path.join(physicalAgentDir, "source.md"), "contained prompt");
			for (const filename of ["SYSTEM.md", "AGENTS.md"]) {
				await fs.symlink(path.join(physicalAgentDir, "source.md"), path.join(agentDir, filename), "file");
			}
			expect(await loadSystemPromptFiles({ cwd, agentDir })).toBe("contained prompt");
			const result = await loadProjectContextFilesResult({ cwd, agentDir });
			expect(result.contextFiles.map(file => file.content)).toEqual(["contained prompt"]);
		});
	}
	test("uses the selected agent directory for SYSTEM.md and AGENTS.md", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-agent-cwd-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-agent-profile-"));
		tempRoots.push(cwd, agentDir);
		const systemPrompt = "profile system prompt";
		const context = "profile agent instructions";
		await fs.writeFile(path.join(agentDir, "SYSTEM.md"), systemPrompt);
		await fs.writeFile(path.join(agentDir, "AGENTS.md"), context);

		const [resolvedSystemPrompt, resolvedContext] = await Promise.all([
			loadSystemPromptFiles({ cwd, agentDir }),
			loadProjectContextFilesResult({ cwd, agentDir }),
		]);

		expect(resolvedSystemPrompt).toBe(systemPrompt);
		expect(resolvedContext.contextFiles).toEqual([{ path: path.join(agentDir, "AGENTS.md"), content: context }]);
	});

	test("rejects symlinked user prompt leaves outside the selected agent directory", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-symlink-cwd-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-symlink-profile-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-symlink-outside-"));
		tempRoots.push(cwd, agentDir, outside);
		await fs.writeFile(path.join(outside, "SYSTEM.md"), "outside system");
		await fs.writeFile(path.join(outside, "AGENTS.md"), "outside context");
		await fs.symlink(path.join(outside, "SYSTEM.md"), path.join(agentDir, "SYSTEM.md"), "file");
		await fs.symlink(path.join(outside, "AGENTS.md"), path.join(agentDir, "AGENTS.md"), "file");

		const [resolvedSystemPrompt, resolvedContext] = await Promise.all([
			loadSystemPromptFiles({ cwd, agentDir }),
			loadProjectContextFilesResult({ cwd, agentDir }),
		]);

		expect(resolvedSystemPrompt).toBeNull();
		expect(resolvedContext.contextFiles).toEqual([]);
	});

	test("keeps default-profile legacy skill roots with an XDG agent directory", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-agent-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-agent-home-"));
		tempRoots.push(cwd, home);
		const xdgAgentDir = path.join(home, ".local", "share", "gjc", "agent");
		const legacySkillsDir = path.join(home, ".gjc", "skills");
		const writeSkill = async (root: string, name: string): Promise<void> => {
			const skillDir = path.join(root, name);
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
			);
		};
		await writeSkill(path.join(xdgAgentDir, "skills"), "xdg-skill");
		await writeSkill(legacySkillsDir, "legacy-skill");

		const result = await loadSkills({
			cwd,
			home,
			agentDir: xdgAgentDir,
			profileAuthority: "default",
			enabled: true,
			trustProjectSkills: true,
			trustUserSkills: true,
		});

		expect(result.skills.map(skill => skill.name)).toEqual(["legacy-skill", "xdg-skill"]);
	});

	test("does not promote home legacy skills to project scope when home is the repository root", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-home-repo-skill-"));
		const cwd = path.join(home, "workspace");
		const agentDir = path.join(home, "profiles", "review");
		tempRoots.push(home);
		await fs.mkdir(path.join(home, ".git"));
		await fs.mkdir(cwd);
		const writeSkill = async (root: string, name: string): Promise<void> => {
			const skillDir = path.join(root, name);
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
			);
		};
		await writeSkill(path.join(home, ".gjc", "skills"), "legacy-home");
		await writeSkill(path.join(agentDir, "skills"), "profile-only");

		const result = await loadSkills({
			cwd,
			home,
			agentDir,
			profileAuthority: "custom",
			enabled: true,
			trustProjectSkills: true,
			trustUserSkills: true,
		});

		expect(result.skills.map(skill => skill.name)).toEqual(["profile-only"]);
	});
});
