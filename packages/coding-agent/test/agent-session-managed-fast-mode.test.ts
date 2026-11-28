import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
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
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

async function fixture() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-managed-fast-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	manager.appendMessage(user("seed"));
	await manager.ensureOnDisk();
	await manager.flush();
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry: registry,
	});
	sessions.push(session);
	return { session, manager };
}

async function canonical(session: AgentSession, text: string) {
	session.agent.emitExternalEvent({ type: "message_end", message: user(text) });
	await session.awaitSessionSettlement();
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("Timed out waiting for fast control")), 2000);
	try {
		return await Promise.race([pending, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("fast mode in a managed session", () => {
	it("orders a fast control, a thinking control and a canonical message in the transcript", async () => {
		const f = await fixture();
		await canonical(f.session, "before");
		const fast = f.session.setFastMode(true);
		const thinking = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		const after = canonical(f.session, "after");
		await bounded(Promise.all([fast, thinking, after]));
		expect(f.session.serviceTier).toBe("priority");
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(
			f.manager
				.getBranch()
				.slice(-3)
				.map(entry => entry.type),
		).toEqual(["service_tier_change", "thinking_level_change", "message"]);
	});
});
