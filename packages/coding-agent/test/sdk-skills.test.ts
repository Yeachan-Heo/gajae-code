import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { DEFAULT_GJC_DEFINITION_NAMES } from "@gajae-code/coding-agent/defaults/gjc-defaults";
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

	it("should discover skills when skill directory is a symlink", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(true);
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
