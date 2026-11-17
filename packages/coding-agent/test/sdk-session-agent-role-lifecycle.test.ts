import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import { activateModelProfile } from "@gajae-code/coding-agent/config/model-profile-activation";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager, SessionManagerTestHooks } from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";
import * as z from "zod/v4";

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

describe("session task-role lifecycle ownership", () => {
	let root: string;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let settings: Settings;
	let sessions: AgentSession[];

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-role-lifecycle-"));
		auth = await AuthStorage.create(path.join(root, "auth.db"));
		registry = new ModelRegistry(auth, path.join(root, "models.yml"));
		vi.spyOn(registry, "getAvailable").mockReturnValue([first, second]);
		settings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			"task.agentModelOverrides": { executor: ["test-provider/first:low"] },
		});
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		vi.restoreAllMocks();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});

	function create(manager = SessionManager.inMemory(root), cancel = false, withMcp = false): AgentSession {
		const mcpTool = {
			name: "mcp__docs_search",
			label: "docs/search",
			description: "Search docs",
			parameters: z.object({}),
			mcpServerName: "docs",
			mcpToolName: "search",
			strict: true,
			async execute() {
				return { content: [{ type: "text", text: "result" }] };
			},
		} as AgentTool;
		const tools = withMcp ? [mcpTool] : [];
		manager.appendThinkingLevelChange(Effort.Low);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: first, systemPrompt: ["Test"], tools } }),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			thinkingLevel: Effort.Low,
			...(withMcp
				? {
						toolRegistry: new Map([[mcpTool.name, mcpTool]]),
						mcpDiscoveryEnabled: true,
						initialMCPToolSelectionIsExplicit: true,
						initialSelectedMCPToolNames: [mcpTool.name],
						initialPersistedMCPToolNames: [mcpTool.name],
						defaultSelectedMCPToolNames: [mcpTool.name],
					}
				: {}),
			...(cancel
				? {
						extensionRunner: {
							hasHandlers: (event: string) => event === "session_before_switch",
							emit: async () => ({ cancel: true }),
						} as never,
					}
				: {}),
		});
		sessions.push(session);
		return session;
	}

	function assertOwned(session: AgentSession): void {
		expect(session.getAgentModelOverrides()).toEqual({
			executor: ["test-provider/first:low"],
			critic: "test-provider/second",
		});
		expect(session.hasSessionAgentModelOverride("critic")).toBe(true);
		expect(session.hasSessionAgentModelOverride("executor")).toBe(false);
		expect(session.resolveRoleModel("critic")?.id).toBe("second");
		expect(session.model).toBe(first);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
	}

	it("retains ownership across cancelled new, switch and fork transitions", async () => {
		const session = create(SessionManager.inMemory(root), true);
		await session.setSessionAgentModelSelection("critic", second);
		const id = session.sessionId;
		expect(await session.newSession()).toBe(false);
		expect(await session.switchSession(path.join(root, "other.jsonl"))).toBe(false);
		expect(await session.fork()).toBe(false);
		expect(session.sessionId).toBe(id);
		assertOwned(session);
		const copy = session.getAgentModelOverrides();
		(copy.executor as string[]).push("test-provider/second");
		copy.critic = "changed";
		assertOwned(session);
	});

	it("keeps choices during same-file reload and MCP-preserving history navigation", async () => {
		const manager = SessionManager.create(root, root);
		const entry = manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "after", timestamp: 2 });
		await manager.ensureOnDisk();
		const session = create(manager, false, true);
		await session.setSessionAgentModelSelection("critic", second);
		const file = session.sessionFile;
		await session.reload();
		expect(session.sessionFile).toBe(file);
		assertOwned(session);
		const result = await session.navigateTree(entry);
		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		assertOwned(session);
	});

	it("retires choices before successor tool and prompt synchronization, including a copied file identity", async () => {
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		await manager.ensureOnDisk();
		const session = create(manager);
		await session.setSessionAgentModelSelection("critic", second);
		const original = session.sessionFile;
		if (!original) throw new Error("Expected persisted session");
		const copied = path.join(root, "copied.jsonl");
		await fs.copyFile(original, copied);
		const sync = session.syncEagerDelegation.bind(session);
		const observations: Array<Record<string, string | readonly string[]>> = [];
		vi.spyOn(session, "syncEagerDelegation").mockImplementation(async () => {
			observations.push(session.getAgentModelOverrides());
			await sync();
		});
		expect(await session.switchSession(copied)).toBe(true);
		expect(session.sessionFile).toBe(copied);
		expect(observations.length).toBeGreaterThan(0);
		for (const map of observations) expect(map).toEqual({ executor: ["test-provider/first:low"] });
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
		expect(session.resolveRoleModel("executor")?.id).toBe("first");
		expect(session.model).toBe(first);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
	});

	it("fences choices when an embedder adopts a copied transcript directly through the manager", async () => {
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		await manager.ensureOnDisk();
		const session = create(manager);
		await session.setSessionAgentModelSelection("critic", second);
		await manager.flush();
		const original = session.sessionFile;
		if (!original) throw new Error("Expected persisted session");
		const copied = path.join(root, "direct-copy.jsonl");
		await fs.copyFile(original, copied);
		const initialGeneration = manager.getSessionIdentityGeneration();
		await manager.setSessionFile(original);
		expect(manager.getSessionIdentityGeneration()).toBe(initialGeneration);
		assertOwned(session);
		await manager.setSessionFile(copied);
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
		await manager.setSessionFile(original);
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
		await manager.setSessionFile(copied);
		expect(session.getAgentModelOverrides()).toEqual({ executor: ["test-provider/first:low"] });
		expect(session.resolveRoleModel("critic")?.id).not.toBe("second");
		await session.setSessionAgentModelSelection("planner", second);
		expect(session.getAgentModelOverrides()).toEqual({
			executor: ["test-provider/first:low"],
			planner: "test-provider/second",
		});
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
	});

	it("keeps the committed identity epoch on failed staged adoption", async () => {
		const manager = SessionManager.create(root, root);
		await manager.ensureOnDisk();
		const session = create(manager);
		await session.setSessionAgentModelSelection("critic", second);
		const original = manager.getSessionFile();
		if (!original) throw new Error("Expected session file");
		const copied = path.join(root, "failed-copy.jsonl");
		await fs.copyFile(original, copied);
		const generation = manager.getSessionIdentityGeneration();
		try {
			SessionManagerTestHooks.beforeManagedSwitchIdentity = () => {
				throw new Error("rejected before adoption");
			};
			await expect(manager.setSessionFile(copied)).rejects.toThrow("rejected before adoption");
		} finally {
			SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
		}
		expect(manager.getSessionIdentityGeneration()).toBe(generation);
		assertOwned(session);
	});

	it("does not rewind a newer identity while a cold rollback is gated", async () => {
		const destination = SessionManager.managedDestination(root, root);
		const source = SessionManager.create(root, destination);
		const target = SessionManager.create(root, destination);
		const newer = SessionManager.create(root, destination);
		let manager: SessionManager | undefined;
		try {
			source.appendMessage({ role: "user", content: "source", timestamp: 1 });
			await source.ensureOnDisk();
			source.appendCustomEntry("node", { payload: "old rollback entry" });
			const keptId = source.appendCustomEntry("node", { payload: "kept rollback entry" });
			source.appendCompaction("rollback summary", undefined, keptId, 1);
			await source.flush();
			target.appendMessage({ role: "user", content: "target", timestamp: 2 });
			await target.ensureOnDisk();
			newer.appendMessage({ role: "user", content: "newer", timestamp: 3 });
			await newer.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			const targetFile = target.getSessionFile();
			const newerFile = newer.getSessionFile();
			if (!sourceFile || !targetFile || !newerFile) throw new Error("Expected persisted sessions");
			await source.close();
			await target.close();
			await newer.close();
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
			manager = await SessionManager.open(
				sourceFile,
				destination,
				new FileSessionStorage(),
				"copy-retain",
				"enabled",
			);
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			const snapshot = await manager.captureRollbackState();
			expect(snapshot.coldRestoreFile).toBe(sourceFile);
			await manager.setSessionFile(targetFile);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			SessionManagerTestHooks.beforeColdRollbackCommit = async () => {
				entered.resolve();
				await release.promise;
			};
			const rollback = manager.restoreRollbackState(snapshot);
			await entered.promise;
			await manager.setSessionFile(newerFile);
			const generation = manager.getSessionIdentityGeneration();
			release.resolve();
			await expect(rollback).rejects.toThrow();
			expect(manager.getSessionFile()).toBe(newerFile);
			expect(manager.getSessionIdentityGeneration()).toBe(generation);
		} finally {
			SessionManagerTestHooks.beforeColdRollbackCommit = undefined;
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			await manager?.close();
			await source.close();
			await target.close();
			await newer.close();
		}
	});

	it("rejects a queued choice after direct in-memory manager replacement with fixed provider identity", async () => {
		const manager = SessionManager.inMemory(root);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: first, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			providerSessionId: "fixed-provider-id",
		});
		sessions.push(session);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const pending = session.setSessionAgentModelSelection("critic", second);
		await entered.promise;
		await manager.newSession();
		release.resolve();
		await expect(pending).rejects.toThrow("Session changed");
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
	});

	it.each([false, true])("preserves cancel-and-submit queue ownership with degraded=%s", async degraded => {
		const manager = SessionManager.inMemory(root);
		let failRefresh = false;
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: first, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			rebuildSystemPrompt: async () => {
				if (failRefresh) throw new Error("refresh failed");
				return { systemPrompt: ["recovered"] };
			},
		});
		sessions.push(session);
		if (degraded) {
			failRefresh = true;
			expect(await session.newSession()).toBe(true);
			failRefresh = false;
		}
		await session.steer("queued steer");
		await session.followUp("queued follow-up");
		const before = session.getQueuedMessages();
		const entry = session.getQueuedMessageEntries()[0];
		if (!entry) throw new Error("Expected queued message");
		session.setCancelAndSubmitAbortOutcomeProviderForTests(async () => ({ kind: "timeout" }));
		expect(await session.cancelAndSubmit(entry.text, { queuedEntryId: entry.id })).toEqual({
			kind: "rolled_back",
			outcome: { kind: "timeout" },
		});
		expect(session.getQueuedMessages()).toEqual(before);
	});

	it("retains idle yields until delegation recovery admits delivery", async () => {
		let failRefresh = true;
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: first, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(root),
			settings,
			modelRegistry: registry,
			rebuildSystemPrompt: async () => {
				if (failRefresh) throw new Error("refresh failed");
				return { systemPrompt: ["recovered"] };
			},
		});
		sessions.push(session);
		expect(await session.newSession()).toBe(true);
		const delivered = Promise.withResolvers<void>();
		const prompt = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			delivered.resolve();
		});
		session.yieldQueue.register<string>("readiness-test", {
			build: entries => ({
				role: "custom",
				customType: "test",
				content: entries.join(","),
				display: false,
				timestamp: 1,
			}),
		});
		session.yieldQueue.enqueue("readiness-test", "preserved");
		await session.yieldQueue.flush("idle");
		expect(session.yieldQueue.has("readiness-test")).toBe(true);
		expect(prompt).not.toHaveBeenCalled();
		failRefresh = false;
		await session.syncEagerDelegation();
		await delivered.promise;
		expect(session.yieldQueue.has("readiness-test")).toBe(false);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("publishes new and fork hooks but blocks turns until delegation recovers", async () => {
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		await manager.ensureOnDisk();
		const events: string[] = [];
		let failRefresh = false;
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: first, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			rebuildSystemPrompt: async () => {
				if (failRefresh) throw new Error("refresh failed");
				return { systemPrompt: ["recovered"] };
			},
			extensionRunner: {
				hasHandlers: () => false,
				emitBeforeAgentStart: async () => undefined,
				emit: async (event: { type: string; reason?: string }) => {
					if (event.type === "session_switch") events.push(event.reason ?? "");
				},
			} as never,
		});
		sessions.push(session);
		auth.setRuntimeApiKey(first.provider, "test-key");
		const notices: string[] = [];
		const notify = vi.spyOn(session, "emitNotice").mockImplementation((_level, message) => {
			notices.push(message);
		});
		let admitted = false;
		let accepted = false;
		failRefresh = true;
		expect(await session.newSession()).toBe(true);
		await expect(
			session.prompt("blocked", {
				onPreflightAccepted: () => {
					accepted = true;
				},
			}),
		).rejects.toThrow("refresh failed");
		expect(accepted).toBe(false);
		await expect(
			session.runWithPromptAdmissionForTests(async () => {
				admitted = true;
			}),
		).rejects.toThrow("refresh failed");
		expect(admitted).toBe(false);
		failRefresh = false;
		await session.runWithPromptAdmissionForTests(async () => {
			admitted = true;
		});
		expect(admitted).toBe(true);
		await expect(
			session.prompt("recovered", {
				onPreflightAcceptCommit: async () => {
					accepted = true;
					throw new Error("acceptance reached");
				},
			}),
		).rejects.toThrow("acceptance reached");
		expect(accepted).toBe(true);
		accepted = false;
		admitted = false;
		manager.appendMessage({ role: "user", content: "fork", timestamp: 2 });
		await manager.ensureOnDisk();
		failRefresh = true;
		expect(await session.fork()).toBe(true);
		await expect(
			session.prompt("blocked after fork", {
				onPreflightAccepted: () => {
					accepted = true;
				},
			}),
		).rejects.toThrow("refresh failed");
		expect(accepted).toBe(false);
		await expect(
			session.runWithPromptAdmissionForTests(async () => {
				admitted = true;
			}),
		).rejects.toThrow("refresh failed");
		expect(admitted).toBe(false);
		failRefresh = false;
		await session.runWithPromptAdmissionForTests(async () => {
			admitted = true;
		});
		expect(admitted).toBe(true);
		expect(events).toEqual(["new", "fork"]);
		expect(notices.length).toBe(2);
		notify.mockRestore();
	});

	function installProfile(): void {
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
	}

	it("preserves session role intent when a profile is refreshed with manual overrides", async () => {
		const session = create();
		installProfile();
		await session.setSessionAgentModelSelection("critic", second);
		await activateModelProfile({
			session,
			modelRegistry: registry,
			settings,
			profileName: "roles",
			preserveManualOverrides: true,
		});
		expect(session.hasSessionAgentModelOverride("critic")).toBe(true);
		expect(session.getAgentModelOverrides().critic).toBe("test-provider/second");
		expect(session.resolveRoleModel("critic")?.id).toBe("second");
		expect(session.model).toBe(first);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
	});

	it("rolls back a failed tool/prompt rebuild without losing the previous role", async () => {
		const session = create();
		await session.setSessionAgentModelSelection("critic", second);
		const sync = session.syncEagerDelegation.bind(session);
		vi.spyOn(session, "syncEagerDelegation")
			.mockRejectedValueOnce(new Error("rebuild failed"))
			.mockImplementation(sync);
		await expect(session.setSessionAgentModelSelection("critic", first)).rejects.toThrow("rebuild failed");
		assertOwned(session);
	});

	it("restores prior role intent when profile publication fails", async () => {
		const session = create();
		installProfile();
		await session.setSessionAgentModelSelection("critic", second);
		const override = settings.override.bind(settings);
		vi.spyOn(settings, "override").mockImplementation((key, value) => {
			if (key === "task.agentModelOverrides") throw new Error("publication failed");
			return override(key, value);
		});
		await expect(
			activateModelProfile({ session, modelRegistry: registry, settings, profileName: "roles" }),
		).rejects.toThrow("publication failed");
		assertOwned(session);
	});

	it("preserves newer role intent when profile preparation fails", async () => {
		const session = create();
		installProfile();
		await session.setSessionAgentModelSelection("critic", second);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(registry, "getApiKeyForProvider").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("credential preparation failed");
		});
		const activation = activateModelProfile({ session, modelRegistry: registry, settings, profileName: "roles" });
		await entered.promise;
		await session.setSessionAgentModelSelection("planner", second);
		release.resolve();
		await expect(activation).rejects.toThrow("credential preparation failed");
		expect(session.hasSessionAgentModelOverride("critic")).toBe(true);
		expect(session.resolveRoleModel("critic")?.id).toBe("second");
		expect(session.hasSessionAgentModelOverride("planner")).toBe(true);
		expect(session.getAgentModelOverrides().planner).toBe("test-provider/second");
		expect(session.resolveRoleModel("planner")?.id).toBe("second");
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
	});

	it("retires choices when an applied profile's optional delegation refresh fails", async () => {
		const session = create();
		installProfile();
		await session.setSessionAgentModelSelection("critic", second);
		vi.spyOn(session, "syncEagerDelegation").mockRejectedValueOnce(new Error("optional refresh failed"));
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "roles" });
		expect(session.getActiveModelProfile()).toBe("roles");
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
		expect(session.getAgentModelOverrides()).toEqual({ executor: "test-provider/first" });
		expect(session.resolveRoleModel("executor")?.id).toBe("first");
		expect(session.model).toBe(first);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: ["test-provider/first:low"] });
	});

	it("rejects an unavailable selection without disturbing existing intent", async () => {
		const session = create();
		await session.setSessionAgentModelSelection("critic", second);
		await expect(session.setSessionAgentModelSelection("critic", { ...first, id: "missing" })).rejects.toThrow(
			"Model unavailable",
		);
		assertOwned(session);
	});

	it("rejects a queued selection after a committed successor", async () => {
		const session = create();
		await session.setSessionAgentModelSelection("critic", second);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const pending = session.setSessionAgentModelSelection("planner", second);
		await entered.promise;
		expect(await session.newSession()).toBe(true);
		release.resolve();
		await expect(pending).rejects.toThrow();
		expect(session.getAgentModelOverrides()).toEqual({ executor: ["test-provider/first:low"] });
		expect(session.hasSessionAgentModelOverride("planner")).toBe(false);
		expect(session.resolveRoleModel("executor")?.id).toBe("first");
		expect(session.model).toBe(first);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("rejects stale selections after disposal and leaves no owned choices", async () => {
		const session = create();
		await session.setSessionAgentModelSelection("critic", second);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const pending = session.setSessionAgentModelSelection("planner", first);
		await entered.promise;
		await session.dispose();
		release.resolve();
		await expect(pending).rejects.toThrow();
		expect(session.getAgentModelOverrides()).toEqual({ executor: ["test-provider/first:low"] });
		expect(session.hasSessionAgentModelOverride("planner")).toBe(false);
		expect(session.hasSessionAgentModelOverride("critic")).toBe(false);
	});
});
