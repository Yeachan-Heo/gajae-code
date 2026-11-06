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

		let sessionModel: any;
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

	it("[P2] defers and dispatches positional startup prompts after model selector completion", async () => {
		const stop = new Error("stop interactive input");
		const fallbackMessage = "Saved model not available";
		const initialPrompts = ["first prompt", "second prompt"];
		const callOrder: string[] = [];
		const promptedMessages: string[] = [];

		let sessionModel: any;
		const session = {
			get model() {
				return sessionModel;
			},
			set model(m: any) {
				sessionModel = m;
			},
			prompt: async (input: string) => {
				promptedMessages.push(input);
				callOrder.push(`prompt:${input}`);
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
					if (getUserInputCallCount === 1) {
						// Return dummy input on first call
						return { text: "user-input" };
					}
					throw stop;
				},
				finishPendingSubmission: () => {},
				checkShutdownRequested: async () => false,
				maybeGenerateSessionTitle: () => {},
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
				initialPrompts,
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

		// Verify that warning, selector, and prompts are called in order
		expect(callOrder).toEqual(["warning", "selector", "prompt:first prompt", "prompt:second prompt"]);
		expect(promptedMessages).toEqual(["first prompt", "second prompt"]);
	});

	it("[P2] drains deferred prompts before processing model profile failure", async () => {
		const profileError = new Error("Model profile loading failed");
		const initialPrompts = ["deferred-prompt-1", "deferred-prompt-2"];
		const callOrder: string[] = [];
		const promptedMessages: string[] = [];

		let sessionModel: any = {}; // Model exists initially
		const session = {
			get model() {
				return sessionModel;
			},
			set model(m: any) {
				sessionModel = m;
			},
			prompt: async (input: string) => {
				promptedMessages.push(input);
				callOrder.push(`prompt:${input}`);
			},
		} as unknown as AgentSession;

		const createMode = (): InteractiveMode =>
			({
				init: async () => {},
				showNewVersionNotification: () => {},
				renderInitialMessages: () => {},
				showStatus: () => {},
				showError: (message: string) => {
					callOrder.push(`error:${message}`);
				},
				showWarning: () => {},
				showModelSelector: () => {},
				getUserInput: async () => {
					// Simulate getting user input, but the deferred prompts should have been processed first
					throw new Error("getUserInput should not be called before deferred prompts are drained");
				},
				finishPendingSubmission: () => {},
				checkShutdownRequested: async () => false,
				shutdown: async () => {
					callOrder.push("shutdown");
				},
				stop: () => {
					callOrder.push("stop");
				},
				maybeGenerateSessionTitle: () => {},
			}) as unknown as InteractiveMode;

		// Create a deferred model profile startup that fails
		const startDeferredModelProfiles = async () => {
			throw profileError;
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
				initialPrompts,
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				undefined,
				undefined,
				startDeferredModelProfiles,
			),
		).rejects.toBe(profileError);

		// Verify that deferred prompts were processed before the error was re-thrown
		expect(promptedMessages).toEqual(["deferred-prompt-1", "deferred-prompt-2"]);
		expect(callOrder).toContain("prompt:deferred-prompt-1");
		expect(callOrder).toContain("prompt:deferred-prompt-2");
		expect(callOrder).toContain("shutdown");
		expect(callOrder).toContain("stop");
	});
});

describe("[P2] Fix blockers: recovery commands and model selector completion", () => {
	it("[P2] executes /login and /model commands immediately (not deferred) when model selector is open", async () => {
		const stop = new Error("stop interactive input");
		const fallbackMessage = "Saved model not available";
		const commandInput = "/login";
		const normalMessage = "test message";
		const callOrder: string[] = [];

		let sessionModel: any;
		const session = {
			get model() {
				return sessionModel;
			},
			set model(m: any) {
				sessionModel = m;
			},
			isLocallyHandledSlashCommand: () => false,
			resolvePromptSkillInvocation: () => null,
			prompt: async (input: string) => {
				callOrder.push(`prompt:${input}`);
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
					// Simulate model selection
					sessionModel = {} as any;
				},
				showOAuthSelector: async () => {
					callOrder.push("oauth-selector");
				},
				editor: { setText: () => {} },
				getUserInput: async () => {
					getUserInputCallCount++;
					if (getUserInputCallCount === 1) {
						return { text: "user-input" };
					}
					throw stop;
				},
				finishPendingSubmission: () => {},
				checkShutdownRequested: async () => false,
				maybeGenerateSessionTitle: () => {},
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
				[commandInput, normalMessage], // /login followed by normal message
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

		// Verify that /login is executed immediately (oauth-selector is called)
		// and the normal message is deferred until after model selection
		expect(callOrder).toContain("warning");
		expect(callOrder).toContain("oauth-selector");
		expect(callOrder).toContain("selector");
		expect(callOrder).toContain("prompt:test message");
		// /login should be executed before the normal message is deferred
		const oauthIndex = callOrder.indexOf("oauth-selector");
		const promptIndex = callOrder.indexOf("prompt:test message");
		expect(oauthIndex).toBeLessThan(promptIndex);
	});

	it("[P2] waits for model selection before calling getUserInput when deferred messages exist", async () => {
		const stop = new Error("stop interactive input");
		const fallbackMessage = "Saved model not available";
		const callOrder: string[] = [];
		let getUserInputCalls = 0;

		let sessionModel: any;
		const session = {
			get model() {
				return sessionModel;
			},
			set model(m: any) {
				sessionModel = m;
			},
			isLocallyHandledSlashCommand: () => false,
			resolvePromptSkillInvocation: () => null,
			prompt: async (input: string) => {
				callOrder.push(`prompt:${input}`);
			},
		} as unknown as AgentSession;

		const createMode = (): InteractiveMode => {
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
					callOrder.push("selector-called");
					// Model selection happens asynchronously; simulate it after a short delay
					setTimeout(() => {
						callOrder.push("model-selected");
						sessionModel = {} as any;
					}, 50);
				},
				getUserInput: async () => {
					getUserInputCalls++;
					callOrder.push(`getUserInput:${getUserInputCalls}`);
					// First call should happen AFTER deferred messages are processed
					// which means AFTER model is selected
					if (getUserInputCalls === 1) {
						return { text: "user-input" };
					}
					throw stop;
				},
				finishPendingSubmission: () => {},
				checkShutdownRequested: async () => false,
				maybeGenerateSessionTitle: () => {},
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
				["deferred message"],
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

		// Verify that getUserInput is not called before deferred messages are processed
		// and model is selected
		const warningIndex = callOrder.indexOf("warning");
		const selectorCalledIndex = callOrder.indexOf("selector-called");
		const modelSelectedIndex = callOrder.indexOf("model-selected");
		const promptIndex = callOrder.indexOf("prompt:deferred message");
		const userInputIndex = callOrder.indexOf("getUserInput:1");

		// Ensure proper order: warning -> selector -> model selected -> prompt -> getUserInput
		expect(warningIndex).toBeLessThan(selectorCalledIndex);
		expect(selectorCalledIndex).toBeLessThan(modelSelectedIndex);
		expect(modelSelectedIndex).toBeLessThan(promptIndex);
		expect(promptIndex).toBeLessThan(userInputIndex);
	});
});
