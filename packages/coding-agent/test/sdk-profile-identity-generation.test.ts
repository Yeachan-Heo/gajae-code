import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import {
	applyPreparedModelProfileActivation,
	prepareModelProfileActivation,
	publishPreparedModelProfileActivation,
	rollbackPreparedModelProfileActivation,
} from "../src/config/model-profile-activation";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager, SessionManagerTestHooks } from "../src/session/session-manager";

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
const profile: ModelProfileDefinition = {
	name: "roles",
	source: "user",
	requiredProviders: ["test-provider"],
	modelMapping: { executor: "test-provider/first" },
};

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-profile-identity-"));
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
	const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "test-provider/second" } });
	const manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: "identity", timestamp: 1 });
	await manager.ensureOnDisk();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: first, systemPrompt: [], tools: [] } }),
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		providerSessionId: "stable-sdk-id",
	});
	const spies = [
		vi.spyOn(registry, "getAvailable").mockReturnValue([first, second]),
		vi.spyOn(registry, "getAll").mockReturnValue([first, second]),
		vi.spyOn(registry, "getModelProfiles").mockReturnValue(new Map([[profile.name, profile]])),
		vi.spyOn(registry, "getModelProfile").mockReturnValue(profile),
		vi.spyOn(registry, "isKnownProvider").mockReturnValue(true),
		vi.spyOn(registry, "getApiKeyForProvider").mockResolvedValue("key"),
		vi.spyOn(session, "syncEagerDelegation").mockResolvedValue(),
	];
	return {
		root,
		manager,
		session,
		settings,
		registry,
		prepare: (preserveManualOverrides = false) =>
			prepareModelProfileActivation({
				session,
				settings,
				modelRegistry: registry,
				profileName: "roles",
				preserveManualOverrides,
			}),
		async dispose() {
			for (const spy of spies) spy.mockRestore();
			await session.dispose();
			await settings.close();
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function snapshot(session: AgentSession, settings: Settings) {
	return {
		model: session.model,
		thinking: session.thinkingLevel,
		chain: session.getConfiguredModelChainState("default"),
		profile: session.getActiveModelProfile(),
		roles: session.getAgentModelOverrides(),
		privateRoles: session.getSessionAgentModelOverrideState(),
		modelRoles: settings.getOverride("modelRoles"),
		agentRoles: settings.getOverride("task.agentModelOverrides"),
	};
}

describe("prepared profile transcript identity", () => {
	it("rejects direct successor publication and deferred apply, even when manual roles are preserved", async () => {
		const f = await fixture();
		try {
			const prepared = await f.prepare(true);
			const sdkId = f.session.sessionId;
			await f.manager.newSession();
			expect(f.session.sessionId).toBe(sdkId);
			const successor = snapshot(f.session, f.settings);
			expect(() => publishPreparedModelProfileActivation(prepared)).toThrow("identity changed");
			await expect(applyPreparedModelProfileActivation(prepared, { deferRuntimePublication: true })).rejects.toThrow(
				"identity changed",
			);
			await expect(applyPreparedModelProfileActivation(prepared, { persistDefault: true })).rejects.toThrow();
			expect(snapshot(f.session, f.settings)).toEqual(successor);
		} finally {
			await f.dispose();
		}
	});

	it("rejects same-ID copied transcript and A to B to A adoption", async () => {
		const f = await fixture();
		try {
			const original = f.manager.getSessionFile()!;
			const copy = path.join(f.root, "copy.jsonl");
			await fs.copyFile(original, copy);
			const id = f.manager.getSessionId();
			const prepared = await f.prepare();
			const generation = f.manager.getSessionIdentityGeneration();
			await f.manager.setSessionFile(copy);
			expect(f.manager.getSessionId()).toBe(id);
			expect(f.manager.getSessionIdentityGeneration()).toBeGreaterThan(generation);
			const successor = snapshot(f.session, f.settings);
			expect(() => publishPreparedModelProfileActivation(prepared)).toThrow("identity changed");
			expect(snapshot(f.session, f.settings)).toEqual(successor);
			await f.manager.setSessionFile(original);
			expect(f.manager.getSessionId()).toBe(id);
			expect(f.manager.getSessionIdentityGeneration()).toBeGreaterThan(generation + 1);
			await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow("identity changed");
		} finally {
			await f.dispose();
		}
	});

	it("does not roll back predecessor private choices into a successor", async () => {
		const f = await fixture();
		try {
			await f.session.setSessionAgentModelSelection("critic", second);
			const prepared = await f.prepare();
			await applyPreparedModelProfileActivation(prepared);
			await f.manager.newSession();
			await f.session.setSessionAgentModelSelection("planner", first);
			const successor = snapshot(f.session, f.settings);
			await rollbackPreparedModelProfileActivation(prepared);
			expect(snapshot(f.session, f.settings)).toEqual(successor);
			expect(f.session.hasSessionAgentModelOverride("critic")).toBe(false);
			expect(f.session.hasSessionAgentModelOverride("planner")).toBe(true);
		} finally {
			await f.dispose();
		}
	});

	it("fences replacement managers with identical transcript identities and local epochs", async () => {
		const f = await fixture();
		let firstManager: SessionManager | undefined;
		let secondManager: SessionManager | undefined;
		try {
			await f.manager.flush();
			const file = f.manager.getSessionFile()!;
			firstManager = await SessionManager.open(file, f.root);
			secondManager = await SessionManager.open(file, f.root);
			f.session.sessionManager = firstManager;
			const originalIdentity = f.session.getSessionAgentModelOverrideState();
			await f.session.setSessionAgentModelSelection("critic", second);
			const applied = await f.prepare();
			await applyPreparedModelProfileActivation(applied);
			const stale = await f.prepare(true);
			const clear = vi.spyOn(f.registry, "clearCanonicalVariant");
			const restore = vi.spyOn(f.registry, "restoreSessionCanonicalVariant");
			try {
				f.session.sessionManager = secondManager;
				const replacementIdentity = f.session.getSessionAgentModelOverrideState();
				expect(replacementIdentity.manager).not.toBe(originalIdentity.manager);
				expect(replacementIdentity.managerId).toBe(originalIdentity.managerId);
				expect(replacementIdentity.file).toBe(originalIdentity.file);
				expect(replacementIdentity.identityGeneration).toBe(originalIdentity.identityGeneration);
				const successor = snapshot(f.session, f.settings);
				expect(() => publishPreparedModelProfileActivation(stale)).toThrow("identity changed");
				await expect(applyPreparedModelProfileActivation(stale, { deferRuntimePublication: true })).rejects.toThrow(
					"identity changed",
				);
				await expect(applyPreparedModelProfileActivation(stale, { persistDefault: true })).rejects.toThrow();
				await rollbackPreparedModelProfileActivation(applied);
				expect(snapshot(f.session, f.settings)).toEqual(successor);
				expect(f.session.hasSessionAgentModelOverride("critic")).toBe(false);
				expect(clear).not.toHaveBeenCalled();
				expect(restore).not.toHaveBeenCalled();

				f.session.sessionManager = firstManager;
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const credentials = vi.spyOn(f.registry, "getApiKeyForProvider").mockImplementationOnce(async () => {
					entered.resolve();
					await release.promise;
					return "key";
				});
				try {
					const pending = f.prepare(true);
					await entered.promise;
					f.session.sessionManager = secondManager;
					const duringPreparation = snapshot(f.session, f.settings);
					clear.mockClear();
					restore.mockClear();
					release.resolve();
					await expect(pending).rejects.toThrow("identity changed");
					expect(snapshot(f.session, f.settings)).toEqual(duringPreparation);
					expect(clear).not.toHaveBeenCalled();
					expect(restore).not.toHaveBeenCalled();
				} finally {
					release.resolve();
					credentials.mockRestore();
				}
			} finally {
				clear.mockRestore();
				restore.mockRestore();
			}
		} finally {
			f.session.sessionManager = f.manager;
			await firstManager?.close();
			await secondManager?.close();
			await f.dispose();
		}
	});

	it("keeps a preparation valid across same-file refresh and failed adoption", async () => {
		const f = await fixture();
		try {
			const prepared = await f.prepare();
			const original = f.manager.getSessionFile()!;
			const generation = f.manager.getSessionIdentityGeneration();
			await f.manager.setSessionFile(original);
			const copy = path.join(f.root, "failed.jsonl");
			await fs.copyFile(original, copy);
			try {
				SessionManagerTestHooks.beforeManagedSwitchIdentity = () => {
					throw new Error("rejected before adoption");
				};
				await expect(f.manager.setSessionFile(copy)).rejects.toThrow("rejected before adoption");
			} finally {
				SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
			}
			expect(f.manager.getSessionIdentityGeneration()).toBe(generation);
			publishPreparedModelProfileActivation(prepared);
			expect(f.session.getActiveModelProfile()).toBe("roles");
		} finally {
			await f.dispose();
		}
	});
});
