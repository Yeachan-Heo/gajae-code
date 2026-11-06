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

	it("[P2] retains and dispatches prepared startup input after model selector completion", async () => {
		const stop = new Error("stop interactive input");
		const fallbackMessage = "Saved model not available";
		const initialInput = "test query";
		const callOrder: string[] = [];
		let promptWasCalled = false;

		let sessionModel: any = undefined;
		const session = {
			get model() {
				return sessionModel;
			},
			set model(m: any) {
				sessionModel = m;
			},
			prompt: async (input: string) => {
				if (input === initialInput) {
					callOrder.push("prompt");
					promptWasCalled = true;
				}
			},
		} as unknown as AgentSession;

		const createMode = (): InteractiveMode => {
			let getUserInputCallCount = 0;
			return {
				init: async () => {},
				showNewVersionNotification: () => {},
				renderInitialMessages: () => {},
				showStatus: () => {},
				showError: () => {},
				showWarning: () => {
					callOrder.push("warning");
				},
				showModelSelector: () => {
					callOrder.push("selector");
					// Simulate model selection by setting model
					sessionModel = {} as any;
				},
				getUserInput: async () => {
					getUserInputCallCount++;
					// First call is for deferred input, second call would be for user input
					if (getUserInputCallCount === 1) {
						// Return a dummy input that will be ignored (deferred message takes priority)
						return { text: "user-input" };
					}
					throw stop;
				},
				finishPendingSubmission: () => {},
				checkShutdownRequested: async () => false,
			} as unknown as InteractiveMode;
		};

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
				initialInput,
				undefined,
				createMode,
				undefined,
				undefined,
				undefined,
				{ openModelSelectorWithFallback: fallbackMessage },
			),
		).rejects.toBe(stop);

		// Verify that warning is shown, selector is opened, then prompt is called with initial input
		expect(callOrder).toEqual(["warning", "selector", "prompt"]);
		expect(promptWasCalled).toBe(true);
	});
});
