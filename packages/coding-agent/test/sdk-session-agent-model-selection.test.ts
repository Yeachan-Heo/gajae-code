import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import {
	activateModelProfile,
	prepareModelProfileActivation,
	publishPreparedModelProfileActivation,
} from "@gajae-code/coding-agent/config/model-profile-activation";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

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

describe("session agent model selections", () => {
	let root: string;
	let auth: AuthStorage;
	let settings: Settings;
	let sessions: AgentSession[];
	let registry: ModelRegistry;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-agent-model-"));
		auth = await AuthStorage.create(path.join(root, "auth.db"));
		registry = new ModelRegistry(auth, path.join(root, "models.yml"));
		vi.spyOn(registry, "getAvailable").mockReturnValue([first, second]);
		settings = Settings.isolated({ "task.agentModelOverrides": { executor: ["test-provider/first:low"] } });
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		auth.close();
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	function create(): AgentSession {
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "key",
				initialState: { model: first, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: SessionManager.inMemory(root),
			settings,
			modelRegistry: registry,
			thinkingLevel: Effort.Low,
		});
		sessions.push(session);
		return session;
	}

	it("isolates shared settings, returns detached maps, and clears to current inheritance", async () => {
		const a = create();
		const b = create();
		const global = structuredClone(settings.getGlobal("task.agentModelOverrides"));
		await a.setSessionAgentModelSelection("executor", second);
		expect(a.getAgentModelOverrides().executor).toBe("test-provider/second");
		expect(a.resolveRoleModel("executor")?.id).toBe("second");
		expect(a.resolveRoleModelWithThinking("executor").model?.id).toBe("second");
		expect(b.resolveRoleModel("executor")?.id).toBe("first");
		expect(a.model).toBe(first);
		expect(a.thinkingLevel).toBe(Effort.Low);
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual(global);
		const inherited = b.getAgentModelOverrides();
		(inherited.executor as string[]).push("changed");
		expect(b.getAgentModelOverrides().executor).toEqual(["test-provider/first:low"]);
		settings.override("task.agentModelOverrides", { executor: "test-provider/second:high" });
		await a.setSessionAgentModelSelection("executor", null);
		expect(a.hasSessionAgentModelOverride("executor")).toBe(false);
		expect(a.getAgentModelOverrides().executor).toBe("test-provider/second:high");
	});

	it("rejects unsupported roles and unavailable models without changing selection", async () => {
		const session = create();
		await expect(session.setSessionAgentModelSelection("default" as "executor", first)).rejects.toThrow();
		await expect(session.setSessionAgentModelSelection("planner", { ...first, id: "missing" })).rejects.toThrow();
		expect(session.hasSessionAgentModelOverride("planner")).toBe(false);
	});

	it("retires all choices on explicit same-profile activation and preserves them on failure", async () => {
		const session = create();
		const profile: ModelProfileDefinition = {
			name: "roles",
			source: "user",
			requiredProviders: ["test-provider"],
			modelMapping: { executor: "test-provider/first" },
		};
		vi.spyOn(registry, "getModelProfiles").mockReturnValue(new Map([[profile.name, profile]]));
		vi.spyOn(registry, "getModelProfile").mockReturnValue(profile);
		vi.spyOn(registry, "isKnownProvider").mockReturnValue(true);
		vi.spyOn(registry, "getApiKeyForProvider").mockResolvedValue("key");
		vi.spyOn(registry, "getAll").mockReturnValue([first, second]);
		await session.setSessionAgentModelSelection("critic", second);
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "roles" });
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
		await session.setSessionAgentModelSelection("architect", second);
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "roles" });
		expect(session.hasSessionAgentModelOverride("architect")).toBe(false);
		await session.setSessionAgentModelSelection("critic", second);
		const refreshed = await prepareModelProfileActivation({
			session,
			modelRegistry: registry,
			settings,
			profileName: "roles",
			preserveManualOverrides: true,
		});
		publishPreparedModelProfileActivation(refreshed);
		expect(session.hasSessionAgentModelOverride("critic")).toBe(true);
		const sync = vi.spyOn(session, "syncEagerDelegation").mockRejectedValueOnce(new Error("refresh failed"));
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "roles" });
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
		sync.mockRestore();
		await session.setSessionAgentModelSelection("critic", second);
		const override = settings.override.bind(settings);
		vi.spyOn(settings, "override").mockImplementation((key, value) => {
			if (key === "task.agentModelOverrides") throw new Error("publication failed");
			return override(key, value);
		});
		await expect(
			activateModelProfile({ session, modelRegistry: registry, settings, profileName: "roles" }),
		).rejects.toThrow();
		expect(session.hasSessionAgentModelOverride("critic")).toBe(true);
	});

	it("keeps selections after a cancelled new-session transition", async () => {
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "key",
				initialState: { model: first, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: SessionManager.inMemory(root),
			settings,
			modelRegistry: registry,
			extensionRunner: {
				hasHandlers: (event: string) => event === "session_before_switch",
				emit: async () => ({ cancel: true }),
			} as never,
		});
		sessions.push(session);
		await session.setSessionAgentModelSelection("critic", second);
		expect(await session.newSession()).toBe(false);
		expect(session.hasSessionAgentModelOverride("critic")).toBe(true);
	});

	it("preserves selections on same-session context clearing", async () => {
		const session = create();
		await session.setSessionAgentModelSelection("planner", second);
		await session.clearContext();
		expect(session.hasSessionAgentModelOverride("planner")).toBe(true);
		expect(session.resolveRoleModel("planner")?.id).toBe("second");
	});

	it("does not apply a queued predecessor selection to a successor", async () => {
		const session = create();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const pending = session.setSessionAgentModelSelection("critic", second);
		await entered.promise;
		await session.newSession();
		release.resolve();
		await expect(pending).rejects.toThrow();
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
	});

	it("retires choices when a new session is committed", async () => {
		const session = create();
		await session.setSessionAgentModelSelection("critic", second);
		expect(await session.newSession()).toBe(true);
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
	});
});
