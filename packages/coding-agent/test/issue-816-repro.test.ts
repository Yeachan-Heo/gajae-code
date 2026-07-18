import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("issue #816 — plan mode pendingModelSwitch leak", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-816-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: defaultModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("does not switch to the plan-role model after exit when the entry switch was deferred by streaming", async () => {
		const planModel = modelRegistry.find("anthropic", "claude-haiku-4-5");
		if (!planModel) throw new Error("Expected claude-haiku-4-5 in registry");

		// Stream is active throughout entry: #applyPlanModeModel snapshots the
		// previous (default) model and queues a pending switch to the plan model
		// instead of applying it immediately.
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		// Avoid kicking off real session work during plan mode entry.
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);
		vi.spyOn(session, "abort").mockResolvedValue(undefined);

		const setModelSpy = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);

		// Enter plan mode → snapshots default, queues pending switch to plan model.
		await mode.planModeController.handleCommand();
		expect(mode.planModeController.enabled).toBe(true);

		// User confirms exit (e.g., approves plan / pauses plan mode).
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.planModeController.handleCommand();
		expect(mode.planModeController.enabled).toBe(false);

		// Stream ends → event-controller flushes any queued model switch.
		await mode.planModeController.flushPendingModelSwitch();

		// Contract: the deferred plan-role switch must be discarded on exit.
		// Otherwise the next user turn lands on the plan-role model even though
		// the user is no longer in plan mode.
		expect(setModelSpy).not.toHaveBeenCalled();
	});

	it("issue #1588: toggling plan mode off aborts before retiring plan-mode resolve state", async () => {
		await mode.planModeController.handleCommand();
		expect(mode.planModeController.enabled).toBe(true);
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(session.peekStandingResolveHandler()).toBeDefined();

		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		const abortSpy = vi.spyOn(session, "abort").mockImplementation(async () => {
			expect(mode.planModeController.enabled).toBe(true);
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.peekStandingResolveHandler()).toBeDefined();
		});

		await mode.planModeController.handleCommand();

		expect(abortSpy).toHaveBeenCalledWith({ timeoutMs: 5_000 });
		expect(mode.planModeController.enabled).toBe(false);
		expect(mode.planModeController.paused).toBe(true);
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.peekStandingResolveHandler()).toBeUndefined();
	});

	it("issue #1588: cancelled plan-mode exit keeps the in-flight turn and resolve handler intact", async () => {
		await mode.planModeController.handleCommand();
		expect(session.peekStandingResolveHandler()).toBeDefined();

		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(false);
		const abortSpy = vi.spyOn(session, "abort").mockResolvedValue(undefined);

		await mode.planModeController.handleCommand();

		expect(abortSpy).not.toHaveBeenCalled();
		expect(mode.planModeController.enabled).toBe(true);
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(session.peekStandingResolveHandler()).toBeDefined();
	});

	it("does not enter plan mode when plan.enabled is false", async () => {
		session.settings.set("plan.enabled", false);
		const warning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.planModeController.handleCommand();

		expect(mode.planModeController.enabled).toBe(false);
		expect(warning).toHaveBeenCalledWith("Plan mode is disabled. Enable it in settings (plan.enabled).");
	});

	it("allows /plan to pause an active plan mode after plan.enabled is disabled", async () => {
		await mode.planModeController.handleCommand();
		expect(mode.planModeController.enabled).toBe(true);

		session.settings.set("plan.enabled", false);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);

		await mode.planModeController.handleCommand();

		expect(mode.planModeController.enabled).toBe(false);
		expect(mode.planModeController.paused).toBe(true);
	});
});
