import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const stores: AuthStorage[] = [];
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-controls-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	manager.appendMessage(user("first"));
	manager.appendMessage(user("second"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] }));
	const tool: AgentTool = {
		name: "control_fixture",
		label: "Control fixture",
		description: "Control admission fixture",
		parameters: z.object({}),
		execute,
	};
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.reminders": false,
		"startup.networkPrewarm": false,
	});
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
	});
	const rebuild = vi.fn(async () => ({ systemPrompt: ["Rebuilt"] }));
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		toolRegistry: new Map([[tool.name, tool]]),
		rebuildSystemPrompt: rebuild,
	});
	sessions.push(session);
	await manager.flush();
	return { session, manager, agent: session.agent, file, execute, rebuild };
}

function snapshot(session: AgentSession) {
	return structuredClone({
		model: session.model,
		thinking: session.thinkingLevel,
		agentThinking: session.agent.state.thinkingLevel,
		tier: session.serviceTier,
		tools: session.getActiveToolNames(),
		prompt: session.agent.state.systemPrompt,
		messages: session.agent.state.messages,
		profile: session.getActiveModelProfile(),
		selectionRevision: session.getUserModelSelectionRevision(),
		modelRoles: session.settings.get("modelRoles"),
		defaultThinking: session.settings.get("defaultThinkingLevel"),
		manager: {
			revisions: session.sessionManager.revisionSnapshot(),
			entries: session.sessionManager.getEntries(),
			leaf: session.sessionManager.getLeafId(),
		},
	});
}

describe("shared AgentSession control admission", () => {
	it("retains shared read-only and genuine no-op controls", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local"));
		await f.manager.flush();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		f.session.setServiceTier(f.session.serviceTier);
		f.session.setThinkingLevel(f.session.thinkingLevel);
		expect(f.session.getAvailableThinkingLevels().length).toBeGreaterThan(0);
		expect(await f.session.cycleRoleModels([])).toBeUndefined();
		expect(await f.session.activateDiscoveredTools([])).toEqual([]);
		expect(await f.session.navigateTree(f.manager.getLeafId()!, { summarize: true })).toEqual({ cancelled: false });
		expect(snapshot(f.session)).toEqual(before);
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});

	it("keeps ordinary control mutations working", async () => {
		const f = await fixture();
		f.session.setServiceTier("priority");
		expect(f.agent.serviceTier).toBe("priority");
		await f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		f.session.setConfiguredModelChain("default", ["anthropic/claude-sonnet-4-5"], "test");
		expect(f.session.getConfiguredModelChain("default")).toEqual(["anthropic/claude-sonnet-4-5"]);
		await f.session.setActiveToolsByName([]);
		expect(f.session.getActiveToolNames()).toEqual([]);
		expect(f.agent.state.systemPrompt).toEqual(["Rebuilt"]);
		expect(f.rebuild).toHaveBeenCalledTimes(1);
		expect(f.execute).not.toHaveBeenCalled();
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain("service_tier_change");
	});
});
