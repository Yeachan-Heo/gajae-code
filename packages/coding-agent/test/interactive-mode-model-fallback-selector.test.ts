import { describe, expect, it } from "bun:test";
import { runInteractiveMode, StartupUpdateOrchestrator } from "@gajae-code/coding-agent/main";
import type { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

describe("InteractiveMode model fallback selector startup", () => {
	it("opens model selector when openModelSelectorWithFallback is set", async () => {
		const stop = new Error("stop interactive input");
		const fallbackMessage = "Saved model not available";
		const callOrder: string[] = [];
		const session = {
			model: undefined,
		} as unknown as AgentSession;

		const createMode = (): InteractiveMode =>
			({
				init: async () => {},
				showNewVersionNotification: () => {},
				renderInitialMessages: () => {},
				showStatus: () => {},
				showError: () => {},
				showWarning: (message: string) => {
					expect(message).toBe(fallbackMessage);
					callOrder.push("warning");
				},
				showModelSelector: () => {
					callOrder.push("selector");
					throw stop;
				},
				getUserInput: async () => {
					throw stop;
				},
			}) as unknown as InteractiveMode;

		await expect(
			runInteractiveMode(
				session,
				"test",
				undefined,
				[],
				new StartupUpdateOrchestrator(
					"interactive",
					() => false,
					async () => undefined,
				),
				[],
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				undefined,
				undefined,
				undefined,
				{ openModelSelectorWithFallback: fallbackMessage },
			),
		).rejects.toBe(stop);

		// Verify warning is displayed before selector opens
		expect(callOrder).toEqual(["warning", "selector"]);
	});

	it("does not open model selector when openModelSelectorWithFallback is not set", async () => {
		const stop = new Error("stop interactive input");
		let selectorOpened = false;
		const session = {
			model: undefined,
		} as unknown as AgentSession;

		const createMode = (): InteractiveMode =>
			({
				init: async () => {},
				showNewVersionNotification: () => {},
				renderInitialMessages: () => {},
				showStatus: () => {},
				showError: () => {},
				showModelSelector: () => {
					selectorOpened = true;
				},
				getUserInput: async () => {
					throw stop;
				},
			}) as unknown as InteractiveMode;

		await expect(
			runInteractiveMode(
				session,
				"test",
				undefined,
				[],
				new StartupUpdateOrchestrator(
					"interactive",
					() => false,
					async () => undefined,
				),
				[],
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				undefined,
				undefined,
				undefined,
			),
		).rejects.toBe(stop);

		expect(selectorOpened).toBe(false);
	});
});
