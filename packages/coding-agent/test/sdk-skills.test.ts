import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { DEFAULT_GJC_DEFINITION_NAMES } from "@gajae-code/coding-agent/defaults/gjc-defaults";
import { clearPluginRootsAndCaches } from "@gajae-code/coding-agent/discovery/helpers";
import { resolveSkillSlashCommands } from "@gajae-code/coding-agent/extensibility/skills";
import type { Skill } from "@gajae-code/coding-agent/sdk";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { safeRmSync } from "../../../scripts/safe-cleanup";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function createIsolatedSkillsSettings(): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
	});
}

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `gjc-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Create skill in .gjc/skills/ for native project-level discovery.
		skillsDir = path.join(tempDir, ".gjc", "skills", "test-skill");
		fs.mkdirSync(skillsDir, { recursive: true });
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-home-"));
		process.env.HOME = tempHomeDir;
		const nativeUserSkillsDir = path.join(tempHomeDir, ".gjc", "agent", "skills");
		fs.mkdirSync(nativeUserSkillsDir, { recursive: true });

		// Create a test skill in the native GJC skills directory
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);

		const externalSkillDir = path.join(tempDir, "external-symlinked-skill");
		fs.mkdirSync(externalSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalSkillDir, "SKILL.md"),
			`---
name: symlinked-skill
description: Skill loaded through a symlink.
---

# Symlinked Skill

Loaded via symbolic link.
`,
		);
		fs.symlinkSync(externalSkillDir, path.join(path.dirname(skillsDir), "symlinked-skill-link"), "dir");
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("loads embedded default GJC workflow skills even when .gjc is absent and arbitrary skill discovery is disabled", async () => {
		safeRmSync(path.join(tempDir, ".gjc"), { recursive: true, force: true });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "skills.enabled": false }),
		});
		const expected = [...DEFAULT_GJC_DEFINITION_NAMES].sort();

		expect(session.skills.map(skill => skill.name).sort()).toEqual(expected);
		expect(session.skills.every(skill => skill.filePath.startsWith("embedded:gjc/skills/"))).toBe(true);
	}, 15_000);

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.skills.length).toBeGreaterThan(0);
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("registers marketplace skills for SDK and slash discovery without loading their bodies", async () => {
		const pluginRoot = path.join(tempHomeDir, "marketplace-cache", "craft-skills");
		const pluginSkillDir = path.join(pluginRoot, "skills", "design");
		fs.mkdirSync(pluginSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginSkillDir, "SKILL.md"),
			"---\nname: design\ndescription: Marketplace design skill.\n---\n\n# Design\n\nPrivate body marker.\n",
		);
		const registryPath = path.join(tempDir, ".gjc", "plugins", "installed_plugins.json");
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(
			registryPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"craft-skills@craft-skills": [
						{ scope: "project", installPath: pluginRoot, version: "0.14.6", enabled: true },
					],
				},
			}),
		);
		clearPluginRootsAndCaches([registryPath]);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: path.join(tempHomeDir, ".gjc", "agent"),
			sessionManager: SessionManager.inMemory(tempDir),
			settings: createIsolatedSkillsSettings(),
		});
		try {
			const marketplaceSkill = session.skills.find(skill => skill.name === "craft-skills:design");
			expect(marketplaceSkill).toBeDefined();
			expect(marketplaceSkill?.content).toBeUndefined();
			expect(marketplaceSkill?.loadContent).toBeFunction();
			expect(resolveSkillSlashCommands(session.skills, new Set()).map(command => command.name)).toContain(
				"skill:craft-skills:design",
			);
			expect(marketplaceSkill?.content).toBeUndefined();
			expect(await marketplaceSkill?.loadContent?.()).toContain("Private body marker.");
		} finally {
			await session.dispose();
			clearPluginRootsAndCaches([registryPath]);
		}
	});

	it("refreshes registered marketplace skills after install and remove lifecycle changes", async () => {
		const pluginRoot = path.join(tempHomeDir, "marketplace-cache", "lifecycle-plugin");
		const pluginSkillDir = path.join(pluginRoot, "skills", "helper");
		fs.mkdirSync(pluginSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginSkillDir, "SKILL.md"),
			"---\nname: helper\ndescription: Lifecycle helper.\n---\n\n# Helper\n",
		);
		const registryPath = path.join(tempDir, ".gjc", "plugins", "installed_plugins.json");
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(registryPath, JSON.stringify({ version: 2, plugins: {} }));
		clearPluginRootsAndCaches([registryPath]);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: path.join(tempHomeDir, ".gjc", "agent"),
			sessionManager: SessionManager.inMemory(tempDir),
			settings: createIsolatedSkillsSettings(),
		});
		try {
			expect(session.skills.some(skill => skill.name === "lifecycle-plugin:helper")).toBe(false);

			fs.writeFileSync(
				registryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"lifecycle-plugin@test-market": [
							{ scope: "project", installPath: pluginRoot, version: "1.0.0", enabled: true },
						],
					},
				}),
			);
			await session.reloadSkills();
			const installedSkill = session.skills.find(skill => skill.name === "lifecycle-plugin:helper");
			expect(installedSkill).toBeDefined();
			expect(await installedSkill?.loadContent?.()).toContain("# Helper");

			fs.writeFileSync(registryPath, JSON.stringify({ version: 2, plugins: {} }));
			await session.reloadSkills();
			expect(session.skills.some(skill => skill.name === "lifecycle-plugin:helper")).toBe(false);
		} finally {
			await session.dispose();
			clearPluginRootsAndCaches([registryPath]);
		}
	});

	it("does not discover a skill symlinked outside its configured scan root", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(false);
	});

	it("should still discover project skills when user skills directory is missing", async () => {
		const userAgentDir = path.join(tempHomeDir, ".gjc", "agent");
		safeRmSync(path.join(userAgentDir, "skills"), { recursive: true, force: true });
		fs.writeFileSync(path.join(userAgentDir, "placeholder.txt"), "placeholder");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});
	it("loads user skills from the session agent-directory profile", async () => {
		const profileDir = path.join(tempDir, "profile-agent");
		const profileSkillDir = path.join(profileDir, "skills", "profile-skill");
		fs.mkdirSync(profileSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(profileSkillDir, "SKILL.md"),
			`---
name: profile-skill
description: Skill installed into an explicit agent-directory profile.
---

# Profile Skill
`,
		);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: profileDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"skills.enabled": true,
				"skills.trustUserSkills": true,
			}),
		});

		try {
			expect(session.skills.some(skill => skill.name === "profile-skill")).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	it("uses an injected Settings agent directory when options.agentDir is omitted", async () => {
		const profileDir = path.join(tempDir, "settings-profile-agent");
		const profileSkillDir = path.join(profileDir, "skills", "settings-profile-skill");
		fs.mkdirSync(profileSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(profileSkillDir, "SKILL.md"),
			"---\nname: settings-profile-skill\ndescription: Skill from injected Settings authority.\n---\n\n# Settings Profile\n",
		);
		const settings = await Settings.loadForScope({ cwd: tempDir, agentDir: profileDir });
		settings.set("skills.enabled", true);
		settings.set("skills.trustUserSkills", true);
		const { session } = await createAgentSession({
			cwd: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings,
		});

		try {
			expect(session.skills.some(skill => skill.name === "settings-profile-skill")).toBe(true);
		} finally {
			await session.dispose();
			await settings.close();
		}
	});

	it("keeps bundled GJC workflow skills even when options.skills is empty", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			skills: [],
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.map(skill => skill.name).sort()).toEqual([...DEFAULT_GJC_DEFINITION_NAMES].sort());
		expect(session.skillWarnings).toEqual([]);
	});

	it("keeps bundled workflow skills authoritative when a disk skill shares their name", async () => {
		const impostorDir = path.join(tempDir, ".gjc", "skills", "ralplan");
		fs.mkdirSync(impostorDir, { recursive: true });
		fs.writeFileSync(
			path.join(impostorDir, "SKILL.md"),
			`---
name: ralplan
description: On-disk impostor that must never replace the bundled workflow.
---

# Impostor

This body must never reach a session.
`,
		);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		const ralplan = session.skills.find(skill => skill.name === "ralplan");
		expect(ralplan).toBeDefined();
		expect(ralplan?.filePath.startsWith("embedded:gjc/skills/ralplan")).toBe(true);
	});

	it("keeps bundled workflow skills authoritative across case variants", async () => {
		const customSkills: Skill[] = [
			{
				name: "Deep-Interview",
				description: "Case-variant impostor that must not replace the bundled workflow.",
				filePath: "/fake/path/SKILL.md",
				baseDir: "/fake/path",
				source: "custom",
			},
			{
				name: "Deep-Interview.",
				description: "Windows path alias that must not replace the bundled workflow.",
				filePath: "/fake/alias/SKILL.md",
				baseDir: "/fake/alias",
				source: "custom",
			},
		];

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			skills: customSkills,
			settings: Settings.isolated({ "skills.enabled": false }),
		});

		const matching = session.skills.filter(skill => skill.name.toLowerCase() === "deep-interview");
		expect(matching).toHaveLength(1);
		expect(matching[0]?.name).toBe("deep-interview");
		expect(matching[0]?.filePath.startsWith("embedded:gjc/skills/deep-interview")).toBe(true);
		expect(session.skills.some(skill => skill.name === "Deep-Interview.")).toBe(false);
	});

	it("preserves the first supplied skill for case-variant non-bundled names", async () => {
		const projectSkill: Skill = {
			name: "Foo",
			description: "Project skill should win by discovery order.",
			filePath: "/project/.gjc/skills/Foo/SKILL.md",
			baseDir: "/project/.gjc/skills/Foo",
			source: "custom:project",
		};
		const userSkill: Skill = {
			name: "foo",
			description: "User skill must not replace the project skill.",
			filePath: "/home/user/.gjc/agent/skills/foo/SKILL.md",
			baseDir: "/home/user/.gjc/agent/skills/foo",
			source: "custom:user",
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			skills: [projectSkill, userSkill],
			settings: Settings.isolated({ "skills.enabled": false }),
		});

		const matching = session.skills.filter(skill => skill.name.toLowerCase() === "foo");
		expect(matching).toHaveLength(1);
		expect(matching[0]?.filePath).toBe(projectSkill.filePath);
	});

	it("should use provided skills plus bundled GJC workflow skills when options.skills is explicitly set", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills).toContainEqual(customSkill);
		for (const name of DEFAULT_GJC_DEFINITION_NAMES) {
			expect(session.skills.some(skill => skill.name === name)).toBe(true);
		}
		expect(session.skillWarnings).toEqual([]);
	});
});
