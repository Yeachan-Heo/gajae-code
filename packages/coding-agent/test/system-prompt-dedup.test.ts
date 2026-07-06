import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
	loadSystemPromptFiles,
} from "@gajae-code/coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("SYSTEM.md prompt assembly", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-system-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-system-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("renders SYSTEM.md exactly once when it is used as the custom base prompt", async () => {
		const projectDir = path.join(tempDir, "project");
		const systemDir = path.join(projectDir, ".gjc");
		const systemPrompt = "You are the project SYSTEM prompt.";
		fs.mkdirSync(systemDir, { recursive: true });
		fs.writeFileSync(path.join(systemDir, "SYSTEM.md"), systemPrompt);

		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: projectDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			systemPrompt: [systemPrompt],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const formatted = session.formatSessionAsText();
			const matches = formatted.match(new RegExp(escapeRegExp(systemPrompt), "g")) ?? [];
			expect(matches).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	}, 15_000);

	it("prefers project SYSTEM.md over user SYSTEM.md", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(path.join(projectDir, ".gjc"), { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".gjc", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHomeDir, ".gjc", "agent", "SYSTEM.md"), "User SYSTEM prompt");
		fs.writeFileSync(path.join(projectDir, ".gjc", "SYSTEM.md"), "Project SYSTEM prompt");

		await expect(loadSystemPromptFiles({ cwd: projectDir })).resolves.toBe("Project SYSTEM prompt");
	});
	it("does not load user-home context or prompt files into project context", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".claude"), { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".codex"), { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".config", "opencode"), { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".gemini"), { recursive: true });
		fs.writeFileSync(path.join(tempHomeDir, ".claude", "CLAUDE.md"), "Home Claude instructions");
		fs.writeFileSync(path.join(tempHomeDir, ".claude", "SYSTEM.md"), "Home Claude system prompt");
		fs.writeFileSync(path.join(tempHomeDir, ".codex", "AGENTS.md"), "Home Codex instructions");
		fs.writeFileSync(path.join(tempHomeDir, ".config", "opencode", "AGENTS.md"), "Home opencode instructions");
		fs.writeFileSync(path.join(tempHomeDir, ".gemini", "GEMINI.md"), "Home Gemini instructions");

		await expect(loadSystemPromptFiles({ cwd: projectDir })).resolves.toBeNull();
		await expect(loadProjectContextFiles({ cwd: projectDir })).resolves.toEqual([]);
	});

	it("loads gjc's own user-global AGENTS.md before project context files", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "Project instructions");
		const userAgentsPath = path.join(tempHomeDir, ".gjc", "agent", "AGENTS.md");
		fs.mkdirSync(path.dirname(userAgentsPath), { recursive: true });
		fs.writeFileSync(userAgentsPath, "User-global instructions");

		const files = await loadProjectContextFiles({ cwd: projectDir });
		const paths = files.map(file => file.path);

		expect(paths[0]).toBe(userAgentsPath);
		expect(files[0]?.content).toBe("User-global instructions");
		expect(paths).toContain(path.join(projectDir, "AGENTS.md"));
	});

	it("includes the native user-global file while still excluding foreign user-home files", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(tempHomeDir, ".claude", "CLAUDE.md"), "Home Claude instructions");
		const userAgentsPath = path.join(tempHomeDir, ".gjc", "agent", "AGENTS.md");
		fs.mkdirSync(path.dirname(userAgentsPath), { recursive: true });
		fs.writeFileSync(userAgentsPath, "User-global instructions");

		const files = await loadProjectContextFiles({ cwd: projectDir });

		expect(files.map(file => file.path)).toEqual([userAgentsPath]);
	});

	it("keeps project-level Gemini context files", async () => {
		const projectDir = path.join(tempDir, "project");
		const geminiDir = path.join(projectDir, ".gemini");
		fs.mkdirSync(geminiDir, { recursive: true });
		fs.writeFileSync(path.join(geminiDir, "GEMINI.md"), "Project Gemini instructions");

		await expect(loadProjectContextFiles({ cwd: projectDir })).resolves.toEqual([
			{
				path: path.join(geminiDir, "GEMINI.md"),
				content: "Project Gemini instructions",
				depth: -1,
			},
		]);
	});
	it("drops identical explicit context entries even when file names differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");
		const sharedContent = "Shared context instructions";

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: sharedContent, depth: 2 },
				{ path: nearPath, content: sharedContent, depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});

		const promptText = systemPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];
		expect(matches).toHaveLength(1);
		expect(promptText).not.toContain(`<file path="${farPath}">`);
		expect(promptText).toContain(`<file path="${nearPath}">`);
	});

	it("drops identical discovered context entries and keeps the closest copy", async () => {
		const projectDir = path.join(tempDir, "project");
		const appDir = path.join(projectDir, "packages", "app");
		const sharedContent = "Shared context instructions";

		fs.mkdirSync(appDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), sharedContent);
		fs.writeFileSync(path.join(appDir, "AGENTS.md"), sharedContent);

		const contextFiles = await loadProjectContextFiles({ cwd: appDir });
		const discoveredFiles = contextFiles.filter(file => file.path.startsWith(projectDir));

		expect(discoveredFiles).toHaveLength(1);
		expect(discoveredFiles[0]?.path).toBe(path.join(appDir, "AGENTS.md"));
	});

	it("keeps distinct context entries when their contents differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: "Root context instructions", depth: 2 },
				{ path: nearPath, content: "Near context instructions", depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain("Root context instructions");
		expect(promptText).toContain("Near context instructions");
	});
});
