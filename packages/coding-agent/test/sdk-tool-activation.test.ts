import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import * as z from "zod/v4";

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: z.object({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

async function createMinimalSession(tempDirs: string[], settings: Settings, toolNames?: string[]) {
	const tempDir = path.join(os.tmpdir(), `pi-sdk-goal-tool-${Snowflake.next()}`);
	tempDirs.push(tempDir);
	fs.mkdirSync(tempDir, { recursive: true });
	return createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.inMemory(),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames,
	});
}

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		vi.restoreAllMocks();
	});

	it("registers and activates the goal tool by default", async () => {
		const { session } = await createMinimalSession(tempDirs, Settings.isolated());

		try {
			expect(session.getAllToolNames()).toContain("goal");
			expect(session.getActiveToolNames()).toContain("goal");
			expect(session.systemPrompt.join("\n")).toContain("goal");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the goal tool active with explicit toolNames lists", async () => {
		const { session } = await createMinimalSession(tempDirs, Settings.isolated(), ["read", "bash"]);

		try {
			expect(session.getAllToolNames()).toContain("goal");
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "goal"]));
		} finally {
			await session.dispose();
		}
	});

	it("excludes the goal tool only when goal mode is disabled", async () => {
		const { session } = await createMinimalSession(tempDirs, Settings.isolated({ "goal.enabled": false }));

		try {
			expect(session.getAllToolNames()).not.toContain("goal");
			expect(session.getActiveToolNames()).not.toContain("goal");
		} finally {
			await session.dispose();
		}
	});

	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			expect(session.getActiveToolNames()).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_active_tool", "default_inactive_tool"]),
			);
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("preserves inline and local GJC tools when MCP is not enabled", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"astGrep.enabled": true,
				"astEdit.enabled": true,
				"search.enabled": true,
				"find.enabled": true,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			toolNames: ["read", "write", "edit", "bash", "search", "find", "ast_grep", "ast_edit"],
		});

		try {
			const expectedLocalTools = [
				"read",
				"write",
				"edit",
				"bash",
				"search",
				"find",
				"ast_grep",
				"ast_edit",
				"default_active_tool",
			];
			expect(mcpManager).toBeUndefined();
			expect(session.getAllToolNames()).toEqual(expect.arrayContaining(expectedLocalTools));
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(expectedLocalTools));
			expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
			expect(session.getActiveToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
		} finally {
			await session.dispose();
		}
	});

	it("keeps edit active when vim edit mode is configured", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "edit.mode": "vim" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "edit"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("edit");
			expect(session.getActiveToolNames()).not.toContain("vim");
			expect(session.getAllToolNames()).toContain("edit");
			expect(session.getAllToolNames()).not.toContain("vim");

			await session.setActiveToolsByName(["read", "edit"]);

			expect(session.getActiveToolNames()).toContain("edit");
			expect(session.getActiveToolNames()).not.toContain("vim");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the visible edit tool stable when the active model changes edit modes", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const settings = Settings.isolated();
		vi.spyOn(settings, "getEditVariantForModel").mockImplementation(model =>
			model?.includes("mini") ? "vim" : "hashline",
		);

		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "test-key");

		const baseModel = getBundledModel("openai", "gpt-4o");
		const vimModel = getBundledModel("openai", "gpt-4o-mini");
		if (!baseModel || !vimModel) {
			throw new Error("Expected bundled OpenAI models for edit-mode switching test");
		}

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings,
			authStorage,
			model: baseModel,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "edit"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("edit");
			expect(session.getActiveToolNames()).not.toContain("vim");
			expect(session.getAllToolNames()).toContain("edit");
			expect(session.getAllToolNames()).not.toContain("vim");

			await session.setModel(vimModel);

			expect(session.getActiveToolNames()).toContain("edit");
			expect(session.getActiveToolNames()).not.toContain("vim");
			expect(session.getAllToolNames()).toContain("edit");
			expect(session.getAllToolNames()).not.toContain("vim");
		} finally {
			await session.dispose();
		}
	});
});
