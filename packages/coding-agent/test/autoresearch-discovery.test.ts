import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { createAutoresearchExtension } from "../src/autoresearch/index";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI, RegisteredCommand } from "../src/extensibility/extensions";
import { SessionManager } from "../src/session/session-manager";

const EXPERIMENT_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment", "update_notes"];

function registerAutoresearchForTest(): {
	commands: Map<string, RegisteredCommand>;
	registeredToolNames: string[];
} {
	const commands = new Map<string, RegisteredCommand>();
	const registeredToolNames: string[] = [];

	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		getActiveTools(): string[] {
			return [];
		},
		on(): void {},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void {
			commands.set(name, { name, ...options });
		},
		registerShortcut(): void {},
		registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]): void {
			registeredToolNames.push(tool.name);
		},
		sendMessage(): void {},
		sendUserMessage(): void {},
		setActiveTools: async (): Promise<void> => {},
	} as unknown as ExtensionAPI;

	createAutoresearchExtension(api);

	return { commands, registeredToolNames };
}

describe("autoresearch discovery", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not register autoresearch as a built-in TUI slash command", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-autoresearch-discovery-"));
		tempDirs.push(tempDir);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const registeredCommandNames =
				session.extensionRunner?.getRegisteredCommands().map(command => command.name) ?? [];
			expect(registeredCommandNames).not.toContain("autoresearch");
			expect(session.getAllToolNames()).not.toEqual(expect.arrayContaining(EXPERIMENT_TOOL_NAMES));
		} finally {
			await session.dispose();
		}
	});

	it("keeps the internal autoresearch extension importable for explicit internal use", () => {
		const { commands, registeredToolNames } = registerAutoresearchForTest();

		const command = commands.get("autoresearch");
		expect(command?.name).toBe("autoresearch");
		expect(command?.description).toContain("autoresearch mode");
		expect(registeredToolNames.sort()).toEqual([...EXPERIMENT_TOOL_NAMES].sort());
	});
});
