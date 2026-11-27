import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";

const first: Model = {
	id: "first",
	name: "First",
	api: "anthropic-messages",
	provider: "test-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};
const second: Model = { ...first, id: "second", name: "Second" };

test("model status follows session task choices without changing settings or default", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-role-status-"));
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
	const available = vi.spyOn(registry, "getAvailable").mockReturnValue([first, second]);
	const settings = Settings.isolated({
		modelRoles: { default: "test-provider/first" },
		"task.agentModelOverrides": { executor: ["test-provider/first:low"] },
	});
	const sessionManager = SessionManager.inMemory(root);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: first, systemPrompt: ["Test"], tools: [] } }),
		sessionManager,
		settings,
		modelRegistry: registry,
	});
	const output: string[] = [];
	const runtime = {
		session,
		sessionManager,
		settings,
		cwd: root,
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	try {
		await executeAcpBuiltinSlashCommand("/model roles", runtime);
		expect(output.pop()).toContain("EXECUTOR (Executor): test-provider/first:low");
		await session.setSessionAgentModelSelection("executor", second);
		await executeAcpBuiltinSlashCommand("/model assignments", runtime);
		const selected = output.pop();
		expect(selected).toContain("EXECUTOR (Executor): test-provider/second");
		expect(selected).toContain("DEFAULT (Default): test-provider/first");
		expect(session.model).toBe(first);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
		await session.setSessionAgentModelSelection("executor", null);
		await executeAcpBuiltinSlashCommand("/model roles", runtime);
		expect(output.pop()).toContain("EXECUTOR (Executor): test-provider/first:low");
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
	} finally {
		await session.dispose();
		available.mockRestore();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});
