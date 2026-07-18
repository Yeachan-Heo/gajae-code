import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import type { Model, ProviderSessionState } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { InteractiveMode } from "../src/modes/interactive-mode";

const defaultModel = { provider: "test", id: "default", api: "openai-responses", name: "default" } as Model;
const planModel = { provider: "test", id: "plan", api: "openai-responses", name: "plan" } as Model;

function state(close: ReturnType<typeof vi.fn>): ProviderSessionState {
	return { close } as ProviderSessionState;
}

function createHarness() {
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: defaultModel, systemPrompt: [], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ modelRoles: { plan: "test/plan" } }),
		modelRegistry: { getAvailable: () => [defaultModel, planModel], getApiKey: async () => "key" } as never,
	});
	return { session, mode: new InteractiveMode(session, "test") };
}

describe("plan-mode temporary fallback state", () => {
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		initTheme();
		await Settings.init({ inMemory: true });
	});
	beforeEach(() => ({ session, mode } = createHarness()));
	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
	});
	afterAll(() => resetSettingsForTest());

	test("enters and exits without destroying the suspended provider session or configured fallback chain", async () => {
		const originalClose = vi.fn();
		session.providerSessionState.set("default", state(originalClose));
		session.setConfiguredModelChain("default", ["test/default", "test/plan"], "test");

		await mode.planModeController.handleCommand();

		expect(session.model).toBe(planModel);
		expect(session.providerSessionState.has("default")).toBe(false);
		expect(originalClose).not.toHaveBeenCalled();
		expect(session.getConfiguredModelChain("default")).toEqual(["test/default", "test/plan"]);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.planModeController.handleCommand();

		expect(session.model).toBe(defaultModel);
		expect(session.providerSessionState.get("default")?.close).toBe(originalClose);
		expect(session.agent.providerSessionState).toBe(session.providerSessionState);
		expect(originalClose).not.toHaveBeenCalled();
	});

	test("unwinds a context-promotion scope before restoring the plan scope", async () => {
		const originalMap = session.providerSessionState;
		const originalClose = vi.fn();
		originalMap.set("default", state(originalClose));

		await mode.planModeController.handleCommand();
		const planMap = session.providerSessionState;
		const planClose = vi.fn();
		planMap.set("plan", state(planClose));
		await session.setModelTemporary(defaultModel, undefined, {
			cause: "temporary-operation",
			reason: "context-promotion",
		});
		const promotionMap = session.providerSessionState;
		const promotionClose = vi.fn();
		promotionMap.set("promotion", state(promotionClose));

		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.planModeController.handleCommand();

		expect(session.model).toBe(defaultModel);
		expect(session.providerSessionState).toBe(originalMap);
		expect(session.agent.providerSessionState).toBe(originalMap);
		expect(promotionClose).toHaveBeenCalledTimes(1);
		expect(planClose).toHaveBeenCalledTimes(1);
		expect(originalClose).not.toHaveBeenCalled();
	});

	test("applies a deferred plan switch in the temporary scope and restores its original provider state on exit", async () => {
		const originalClose = vi.fn();
		session.providerSessionState.set("default", state(originalClose));
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);

		await mode.planModeController.handleCommand();
		expect(session.model).toBe(defaultModel);
		expect(originalClose).not.toHaveBeenCalled();
		streaming = false;
		await mode.planModeController.flushPendingModelSwitch();
		expect(session.model).toBe(planModel);
		expect(originalClose).not.toHaveBeenCalled();
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.planModeController.handleCommand();

		expect(session.model).toBe(defaultModel);
		expect(session.providerSessionState.get("default")?.close).toBe(originalClose);
		expect(originalClose).not.toHaveBeenCalled();
	});

	test("restores the suspended provider state when entering plan mode fails", async () => {
		const originalClose = vi.fn();
		session.providerSessionState.set("default", state(originalClose));
		vi.spyOn(session, "setModelTemporary").mockRejectedValue(new Error("switch failed"));

		await mode.planModeController.handleCommand();

		expect(session.model).toBe(defaultModel);
		expect(session.providerSessionState.get("default")?.close).toBe(originalClose);
		expect(session.agent.providerSessionState).toBe(session.providerSessionState);
		expect(originalClose).not.toHaveBeenCalled();
	});
});
