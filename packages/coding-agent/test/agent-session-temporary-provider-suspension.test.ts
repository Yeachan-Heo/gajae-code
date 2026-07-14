import { describe, expect, test, vi } from "bun:test";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import type { Model, ProviderSessionState } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const model = { provider: "test", id: "model", api: "openai-responses", name: "model" } as Model;

function createSession(streamFn?: AgentOptions["streamFn"], models: readonly Model[] = [model]): AgentSession {
	const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] }, streamFn });
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: { getAvailable: () => models, getApiKey: async () => "key" } as never,
	});
}

function state(close: ReturnType<typeof vi.fn>): ProviderSessionState {
	return { close } as ProviderSessionState;
}

describe("temporary provider-session suspension", () => {
	test("restores suspended state, supports LIFO nesting, and ignores stale tokens", () => {
		const session = createSession();
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));
		const outer = session.beginTemporaryProviderSessionScope("plan-mode");
		const outerMap = session.providerSessionState;
		expect(session.agent.providerSessionState).toBe(outerMap);
		expect(originalClose).not.toHaveBeenCalled();
		const outerClose = vi.fn();
		outerMap.set("outer", state(outerClose));
		const inner = session.beginTemporaryProviderSessionScope("profile-preview");
		const innerClose = vi.fn();
		session.providerSessionState.set("inner", state(innerClose));
		expect(session.restoreTemporaryProviderSessionScope(outer)).toBe(false);
		expect(session.restoreTemporaryProviderSessionScope(inner)).toBe(true);
		expect(innerClose).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState).toBe(outerMap);
		expect(session.restoreTemporaryProviderSessionScope(outer)).toBe(true);
		expect(outerClose).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("original")).toBe(true);
		expect(session.agent.providerSessionState).toBe(session.providerSessionState);
		expect(session.restoreTemporaryProviderSessionScope(outer)).toBe(false);
	});

	test("restores an explicit scope after unwinding auto-owned scopes above it", async () => {
		const planModel = { ...model, id: "plan" } as Model;
		const session = createSession(undefined, [model, planModel]);
		const originalMap = session.providerSessionState;
		const originalClose = vi.fn();
		originalMap.set("original", state(originalClose));
		const planScope = session.beginTemporaryProviderSessionScope("plan-mode");
		const planMap = session.providerSessionState;
		const planClose = vi.fn();
		planMap.set("plan", state(planClose));
		await session.setModelTemporary(planModel, undefined, {
			cause: "temporary-operation",
			providerSessionScope: planScope,
		});
		const autoScope = await session.setModelTemporary(model, undefined, {
			cause: "temporary-operation",
			reason: "context-promotion",
		});
		if (!autoScope) throw new Error("Context promotion did not create an auto-owned scope");
		const autoMap = session.providerSessionState;
		const autoClose = vi.fn();
		autoMap.set("auto", state(autoClose));

		expect(session.restoreTemporaryProviderSessionScope(planScope)).toBe(true);
		expect(session.model).toBe(model);
		expect(session.providerSessionState).toBe(originalMap);
		expect(session.agent.providerSessionState).toBe(originalMap);
		expect(autoClose).toHaveBeenCalledTimes(1);
		expect(planClose).toHaveBeenCalledTimes(1);
		expect(originalClose).not.toHaveBeenCalled();
		expect(session.restoreTemporaryProviderSessionScope(autoScope)).toBe(false);
		expect(session.restoreTemporaryProviderSessionScope(planScope)).toBe(false);
	});

	test("restores the pre-plan auto scope after unwinding a promoted scope", async () => {
		const planModel = { ...model, id: "plan" } as Model;
		const session = createSession(undefined, [model, planModel]);
		const originalMap = session.providerSessionState;
		const originalClose = vi.fn();
		originalMap.set("original", state(originalClose));

		const autoScope = await session.setModelTemporary(model, undefined, {
			cause: "temporary-operation",
			reason: "other",
		});
		if (!autoScope) throw new Error("Temporary selection did not create an auto-owned scope");
		const autoMap = session.providerSessionState;
		const autoClose = vi.fn();
		autoMap.set("auto", state(autoClose));

		const planScope = session.beginTemporaryProviderSessionScope("plan-mode");
		const planMap = session.providerSessionState;
		const planClose = vi.fn();
		planMap.set("plan", state(planClose));
		await session.setModelTemporary(planModel, undefined, {
			cause: "temporary-operation",
			providerSessionScope: planScope,
		});
		const promotionScope = await session.setModelTemporary(model, undefined, {
			cause: "temporary-operation",
			reason: "context-promotion",
		});
		if (!promotionScope) throw new Error("Context promotion did not create an auto-owned scope");
		const promotionClose = vi.fn();
		session.providerSessionState.set("promotion", state(promotionClose));

		expect(session.restoreTemporaryProviderSessionScope(planScope)).toBe(true);
		expect(session.providerSessionState).toBe(autoMap);
		expect(promotionClose).toHaveBeenCalledTimes(1);
		expect(planClose).toHaveBeenCalledTimes(1);
		expect(autoClose).not.toHaveBeenCalled();

		await session.setModelTemporary(model, undefined, { cause: "temporary-operation", reason: "other" });
		expect(session.providerSessionState).toBe(originalMap);
		expect(session.agent.providerSessionState).toBe(originalMap);
		expect(autoClose).toHaveBeenCalledTimes(1);
		expect(originalClose).not.toHaveBeenCalled();
		expect(session.restoreTemporaryProviderSessionScope(autoScope)).toBe(false);
		expect(session.restoreTemporaryProviderSessionScope(promotionScope)).toBe(false);
		expect(session.restoreTemporaryProviderSessionScope(planScope)).toBe(false);
	});

	test("new session drains provider state and installs a new shared map", async () => {
		const session = createSession();
		const oldMap = session.providerSessionState;
		const oldClose = vi.fn();
		oldMap.set("old", state(oldClose));

		await session.newSession();

		expect(oldClose).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState).not.toBe(oldMap);
		expect(session.agent.providerSessionState).toBe(session.providerSessionState);
		expect(session.agent.providerSessionState).not.toBe(oldMap);
	});

	test("stale supplied scope after a permanent change cannot mutate the session", async () => {
		const session = createSession();
		const temporaryModel = { ...model, id: "temporary" } as Model;
		const permanentModel = { ...model, id: "permanent" } as Model;
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));
		const staleScope = session.beginTemporaryProviderSessionScope("plan-mode");
		const activeMap = session.providerSessionState;
		const activeClose = vi.fn();
		activeMap.set("active", state(activeClose));

		await session.setModel(permanentModel, "default", { cause: "user-selection" });
		await session.setModelTemporary(temporaryModel, undefined, {
			cause: "temporary-operation",
			providerSessionScope: staleScope,
		});

		expect(originalClose).toHaveBeenCalledTimes(1);
		expect(activeClose).not.toHaveBeenCalled();
		expect(session.model).toBe(permanentModel);
		expect(session.providerSessionState).toBe(activeMap);
		expect(session.agent.providerSessionState).toBe(activeMap);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("test/permanent");
	});

	test("commit closes suspended state and disposal drains each map exactly once", async () => {
		const session = createSession();
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));
		const scope = session.beginTemporaryProviderSessionScope("temporary-cycle");
		const temporaryClose = vi.fn();
		session.providerSessionState.set("temporary", state(temporaryClose));
		expect(session.commitTemporaryProviderSessionScope(scope)).toBe(true);
		expect(originalClose).toHaveBeenCalledTimes(1);
		await session.dispose();
		expect(temporaryClose).toHaveBeenCalledTimes(1);
	});

	test("temporary model changes preserve the suspended map until a permanent change commits it", async () => {
		const session = createSession();
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));

		await session.setModelTemporary(model, undefined, { cause: "temporary-operation", reason: "context-promotion" });
		expect(originalClose).not.toHaveBeenCalled();

		await session.setModel(model, "default", { cause: "user-selection" });
		expect(originalClose).toHaveBeenCalledTimes(1);
	});

	test("auto-created temporary scopes replace each other and restore the original map", async () => {
		const session = createSession();
		const originalMap = session.providerSessionState;
		const originalClose = vi.fn();
		originalMap.set("original", state(originalClose));
		const temporaryModels = ["first", "second", "third"].map(id => ({ ...model, id }) as Model);
		const temporaryMaps: Map<string, ProviderSessionState>[] = [];
		const temporaryCloses: ReturnType<typeof vi.fn>[] = [];
		let activeScope: Awaited<ReturnType<typeof session.setModelTemporary>> | undefined;

		for (const temporaryModel of temporaryModels) {
			activeScope = await session.setModelTemporary(temporaryModel, undefined, {
				cause: "temporary-operation",
				reason: "other",
			});
			expect(activeScope).toBeDefined();
			const temporaryMap = session.providerSessionState;
			const temporaryClose = vi.fn();
			temporaryMap.set(temporaryModel.id, state(temporaryClose));
			temporaryMaps.push(temporaryMap);
			temporaryCloses.push(temporaryClose);
			expect(temporaryCloses.slice(0, -1)).toSatisfy(closes => closes.every(close => close.mock.calls.length === 1));
			expect(temporaryClose).not.toHaveBeenCalled();
		}

		if (!activeScope) throw new Error("Temporary model selection did not create a scope");
		expect(session.restoreTemporaryProviderSessionScope(activeScope)).toBe(true);
		expect(session.providerSessionState).toBe(originalMap);
		expect(session.agent.providerSessionState).toBe(originalMap);
		expect(originalClose).not.toHaveBeenCalled();
		expect(temporaryMaps).toHaveLength(3);
		expect(temporaryCloses).toSatisfy(closes => closes.every(close => close.mock.calls.length === 1));
	});

	test("temporary role cycling back rebinds the original provider-session map", async () => {
		const slowModel = { ...model, id: "slow" } as Model;
		const session = createSession(undefined, [model, slowModel]);
		session.settings.set("modelRoles", { default: "test/model", slow: "test/slow" });
		const originalMap = session.providerSessionState;
		const originalClose = vi.fn();
		originalMap.set("original", state(originalClose));

		await session.cycleRoleModels(["default", "slow"], { temporary: true });
		const temporaryMap = session.providerSessionState;
		const temporaryClose = vi.fn();
		temporaryMap.set("slow", state(temporaryClose));

		await session.cycleRoleModels(["default", "slow"], { temporary: true });

		expect(session.model).toBe(model);
		expect(session.providerSessionState).toBe(originalMap);
		expect(session.agent.providerSessionState).toBe(originalMap);
		expect(temporaryClose).toHaveBeenCalledTimes(1);
		expect(originalClose).not.toHaveBeenCalled();
	});

	test("temporary model picks suspend provider state and replace the runtime fallback chain", async () => {
		const fallbackManaged: Array<boolean | undefined> = [];
		const session = createSession((selected, context, options) => {
			fallbackManaged.push(options?.fallbackManaged);
			return createMockModel({ responses: [{ content: ["ok"] }] }).stream(selected, context, options);
		});
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));
		session.setConfiguredModelChain("default", ["test/model", "test/fallback"], "test");

		await session.setModelTemporary(model, undefined, { cause: "temporary-operation", reason: "other" });
		session.setDefaultFallbackRuntimeModel("test/model");
		await session.prompt("temporary pick");
		await session.waitForIdle();

		expect(originalClose).not.toHaveBeenCalled();
		expect(fallbackManaged).toEqual([undefined]);
		await session.dispose();
	});
});
