import { describe, expect, test } from "bun:test";
import { GoalModeController } from "../../../src/modes/controllers/goal-mode-controller";
import { ModeGate } from "../../../src/modes/controllers/mode-gate";
import type { AgentSession } from "../../../src/session/agent-session";
import type { SessionManager } from "../../../src/session/session-manager";

describe("GoalModeController", () => {
	test("refuses commands while plan mode is active", async () => {
		const gate = new ModeGate();
		const warnings: string[] = [];
		const session = {
			settings: { get: () => true },
		} as unknown as AgentSession;
		const controller = new GoalModeController({
			session,
			sessionManager: {} as SessionManager,
			modeGate: gate,
			planModeActive: true,
			inputCallback: undefined,
			hasPendingSubmission: false,
			hasPendingImages: false,
			editorText: "",
			startPendingSubmission: () => {
				throw new Error("goal creation must not submit while plan mode owns the gate");
			},
			showStatus: () => {},
			showWarning: message => warnings.push(message),
			showError: () => {},
			showHookConfirm: async () => false,
			showHookSelector: async () => undefined,
			showHookEditor: async () => undefined,
			updateGoalModeStatus: () => {},
		});

		await controller.handleCommand("Ship the release");

		expect(warnings).toEqual(["Exit plan mode first."]);
		expect(controller.enabled).toBe(false);
	});
});
