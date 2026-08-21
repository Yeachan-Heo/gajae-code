import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		// Distinct context-file trees so the stable-prompt re-root is observable.
		await Bun.write(path.join(cwdA, "AGENTS.md"), "# Project A\nRun commands from project A.\n");
		await Bun.write(path.join(cwdB, "AGENTS.md"), "# Project B\nRun commands from project B.\n");
		// SYSTEM.md is the cwd-scoped prompt-customization file (inside the
		// project config dir); it must follow the move too (stable prompt
		// rebuild reads the live cwd).
		fs.mkdirSync(path.join(cwdA, ".gjc"), { recursive: true });
		fs.mkdirSync(path.join(cwdB, ".gjc"), { recursive: true });
		await Bun.write(path.join(cwdA, ".gjc", "SYSTEM.md"), "You are working in PROJECT-ALPHA.\n");
		await Bun.write(path.join(cwdB, ".gjc", "SYSTEM.md"), "You are working in PROJECT-BETA.\n");

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});

		try {
			const promptBefore = session.systemPrompt.join("\n");
			expect(promptBefore).toContain("Project A");
			expect(promptBefore).not.toContain("Project B");

			await session.moveCwd(cwdB);

			// Stable prompt prefix re-rooted to the new project's context files.
			const promptAfter = session.systemPrompt.join("\n");
			expect(promptAfter).toContain("Project B");
			expect(promptAfter).not.toContain("Project A");

			// The cwd-scoped SYSTEM.md customization and the tree-derived AGENTS.md
			// directory list follow the move as well (live-cwd rebuild).
			expect(promptAfter).toContain("PROJECT-BETA");
			expect(promptAfter).not.toContain("PROJECT-ALPHA");
			expect(promptAfter).toContain("cwd-b");
			expect(promptAfter).not.toContain("cwd-a");

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			await session.dispose();
		}
	});

	it("preserves caller-owned context files and workspace trees after move", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-explicit-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [{ path: path.join(cwdA, "explicit.md"), content: "CALLER-OWNED-CONTEXT" }],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});

		try {
			await session.moveCwd(cwdB);
			const promptAfter = session.systemPrompt.join("\n");
			expect(promptAfter).toContain("CALLER-OWNED-CONTEXT");
		} finally {
			await session.dispose();
		}
	});
});
