import { afterEach, describe, expect, it, vi } from "bun:test";
import { AgentBusyError, type AgentTelemetryConfig, type Tracer } from "@gajae-code/agent-core";
import { type AssistantMessage, Effort, type Model } from "@gajae-code/ai";
import { Settings } from "../../src/config/settings";
import type { ExtensionActions, LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, ForkContextSeed, PromptOptions } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { runSubprocess, SUBAGENT_WARNING_MISSING_YIELD } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void,
	options?: { model?: Model },
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: options?.model,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			onPrompt({ text, options, promptIndex, emit, state });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	};

	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
}

describe("runSubprocess yield reminders", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	function createForkContextSeed(): ForkContextSeed {
		return {
			messages: [],
			agentMessages: [],
			metadata: {
				sourceSessionId: "parent-session",
				parentMessageCount: 3,
				includedMessages: 1,
				skippedMessages: 2,
				approximateTokens: 64,
				maxMessages: 5,
				maxTokens: 100,
				skippedReasons: {},
			},
		};
	}

	it("waits for session_start extension user messages before prompting the subagent", async () => {
		let extensionSendUserMessage: ExtensionActions["sendUserMessage"] | undefined;
		let messageInFlight = false;
		let sendStarted = false;

		const session = createMockSession(({ emit }) => {
			if (messageInFlight) {
				throw new AgentBusyError();
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-extension-session-start",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const mutableSession = session as unknown as {
			extensionRunner: NonNullable<AgentSession["extensionRunner"]>;
			sendUserMessage: AgentSession["sendUserMessage"];
		};
		mutableSession.sendUserMessage = async () => {
			sendStarted = true;
			messageInFlight = true;
			await Bun.sleep(20);
			messageInFlight = false;
		};
		mutableSession.extensionRunner = {
			initialize: (actions: ExtensionActions) => {
				extensionSendUserMessage = actions.sendUserMessage;
			},
			onError: () => {},
			emit: async (event: { type: string }) => {
				if (event.type === "session_start") {
					extensionSendUserMessage?.("hello from session_start", { deliverAs: "followUp" });
				}
				return undefined;
			},
		} as unknown as NonNullable<AgentSession["extensionRunner"]>;

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-session-start-extension",
		});

		expect(sendStarted).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
	});

	it("skips modelRegistry.refresh when reusing the parent registry", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-skip-refresh",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);
		const modelRegistry = {
			refresh: async () => {},
		} as unknown as import("../../src/config/model-registry").ModelRegistry;
		const refreshSpy = vi.spyOn(modelRegistry, "refresh");

		await runSubprocess({ ...baseOptions, id: "subagent-skip-refresh", modelRegistry });

		expect(refreshSpy).not.toHaveBeenCalled();
		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
	});

	it("renders shared task context in subagent system prompt before now", async () => {
		let userPrompt = "";
		const session = createMockSession(({ text, emit }) => {
			userPrompt = text;
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-context-system",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);

		await runSubprocess({
			...baseOptions,
			id: "subagent-context-system",
			context: "Shared task background",
			task: "Your assignment is below.\nBe thorough and complete fully before yielding.\n\nDo the task.",
		});

		const systemPromptBuilder = createAgentSessionSpy.mock.calls[0]?.[0]?.systemPrompt;
		expect(systemPromptBuilder).toBeFunction();
		if (typeof systemPromptBuilder !== "function") throw new Error("Expected system prompt builder");
		const systemPrompt = systemPromptBuilder(["system", "project", "now"]);

		expect(systemPrompt).toHaveLength(4);
		expect(systemPrompt?.[0]).toBe("system");
		expect(systemPrompt?.[1]).toBe("project");
		expect(systemPrompt?.[2]).toContain("[CONTEXT]\nShared task background\n[/CONTEXT]");
		expect(systemPrompt?.[2]).toContain("[ROLE]\ntest\n[/ROLE]");
		expect(systemPrompt?.[3]).toBe("now");
		expect(userPrompt).not.toContain("[CONTEXT]");
		expect(userPrompt).not.toContain("Shared task background");
	});

	it("does not mention IRC in fork-context notice when IRC is unavailable", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-fork-context-no-irc",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);

		await runSubprocess({
			...baseOptions,
			id: "subagent-fork-context-no-irc",
			forkContextSeed: createForkContextSeed(),
			ircAvailable: false,
		});

		const systemPromptBuilder = createAgentSessionSpy.mock.calls[0]?.[0]?.systemPrompt;
		expect(systemPromptBuilder).toBeFunction();
		if (typeof systemPromptBuilder !== "function") throw new Error("Expected system prompt builder");
		const systemPrompt = systemPromptBuilder(["system", "now"]);

		expect(systemPrompt.join("\n")).toContain("forked snapshot of the parent conversation");
		expect(systemPrompt.join("\n")).not.toContain("IRC");
		expect(systemPrompt.join("\n")).toContain("Rely on the explicit assignment and supplied context");
	});

	it("mentions IRC in fork-context notice when IRC is available", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-fork-context-irc",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);

		await runSubprocess({
			...baseOptions,
			id: "subagent-fork-context-irc",
			forkContextSeed: createForkContextSeed(),
			ircAvailable: true,
		});

		const systemPromptBuilder = createAgentSessionSpy.mock.calls[0]?.[0]?.systemPrompt;
		expect(systemPromptBuilder).toBeFunction();
		if (typeof systemPromptBuilder !== "function") throw new Error("Expected system prompt builder");
		const systemPrompt = systemPromptBuilder(["system", "now"]);

		expect(systemPrompt.join("\n")).toContain("Use IRC for live coordination.");
	});

	it("sends reminder prompt when subagent stops without yield", async () => {
		const prompts: string[] = [];
		const promptOptions: Array<PromptOptions | undefined> = [];
		const session = createMockSession(({ text, options, promptIndex, emit, state }) => {
			prompts.push(text);
			promptOptions.push(options);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("did some work");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { done: true } },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess(baseOptions);
		expect(prompts.length).toBe(2);
		expect(promptOptions).toHaveLength(2);
		expect(promptOptions[0]?.attribution).toBe("agent");
		expect(promptOptions[1]?.attribution).toBe("agent");
		expect(prompts[1]).toContain("Your last turn ended without a tool call");
		expect(result.output).toContain('"done": true');
		expect(result.output.includes("SYSTEM WARNING")).toBe(false);
	});

	it("omits forced yield toolChoice on final retry when named forcing degrades", async () => {
		const promptOptions: Array<PromptOptions | undefined> = [];
		const degradedModel = {
			provider: "anthropic",
			api: "anthropic-messages",
			id: "mock-no-forced",
			name: "Mock no forced",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsForcedToolChoice: false },
		} as Model;
		const session = createMockSession(
			({ options, promptIndex, emit, state }) => {
				promptOptions.push(options);
				const assistant = createAssistantStopMessage(`stopped ${promptIndex}`);
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
			},
			{ model: degradedModel },
		);

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-final-degraded-yield" });

		expect(promptOptions).toHaveLength(4);
		expect(promptOptions[3]?.toolChoice).toBeUndefined();
		expect(result.output).toContain("stopped 4");
	});

	it("keeps null yield warning when subagent submits success without data", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("partial output");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-2",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success" },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-2" });
		expect(result.output).toContain("SYSTEM WARNING: Subagent called yield with null data.");
	});

	it("retries when yield tool returns an error before succeeding", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("attempted yield");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-error",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Output does not match schema" }],
						details: { status: "error", error: "Output does not match schema" },
					},
					isError: true,
				});
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-success",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-err-then-success" });
		expect(prompts).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});
	it("uses provided thinking level when model override has no explicit suffix", async () => {
		vi.clearAllMocks();
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-thinking-fallback",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		const createAgentSessionSpy = mockCreateAgentSession(session);

		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		await runSubprocess({
			...baseOptions,
			id: "subagent-thinking-fallback",
			modelOverride: "openai/gpt-4o",
			thinkingLevel: Effort.High,
			modelRegistry,
		});

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.thinkingLevel).toBe(Effort.High);
	});

	it("prefers explicit modelOverride thinking suffix over provided thinking level, including off", async () => {
		vi.clearAllMocks();
		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		const cases = [
			{ modelOverride: "openai/gpt-4o:low", expectedThinkingLevel: Effort.Low },
			{ modelOverride: "openai/gpt-4o:off", expectedThinkingLevel: "off" },
		] as const;

		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession");

		for (const [index, testCase] of cases.entries()) {
			const session = createMockSession(({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: `tool-thinking-override-${index}`,
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			});

			createAgentSessionSpy.mockResolvedValue(createSessionResult(session));

			await runSubprocess({
				...baseOptions,
				id: `subagent-thinking-override-${index}`,
				modelOverride: testCase.modelOverride,
				thinkingLevel: Effort.High,
				modelRegistry,
			});
		}

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(2);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.thinkingLevel).toBe(cases[0].expectedThinkingLevel);
		expect(createAgentSessionSpy.mock.calls[1]?.[0]?.thinkingLevel).toBe(cases[1].expectedThinkingLevel);
	});
	it("surfaces auth fallback model substitution and annotates session model_change", async () => {
		vi.clearAllMocks();
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-auth-fallback",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const sessionModelChanges: Array<{
			model: string;
			role?: string;
			metadata?: { previousModel?: string; reason?: string; thinkingLevel?: string | null };
		}> = [];
		(
			session as unknown as {
				sessionManager: {
					appendSessionInit: () => void;
					appendModelChange: (
						model: string,
						role?: string,
						metadata?: { previousModel?: string; reason?: string; thinkingLevel?: string | null },
					) => string;
				};
			}
		).sessionManager = {
			appendSessionInit: () => {},
			appendModelChange: (model, role, metadata) => {
				sessionModelChanges.push({ model, role, metadata });
				return "model-change-id";
			},
		};
		const createAgentSessionSpy = mockCreateAgentSession(session);
		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [
				{ provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 272000 },
				{ provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", contextWindow: 400000 },
			],
			getApiKey: async (model: { id: string }) => (model.id === "gpt-5.5" ? "sk-test" : undefined),
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-auth-fallback-warning",
			modelOverride: "openai-codex/gpt-5.3-codex:high",
			parentActiveModelPattern: "openai-codex/gpt-5.5",
			modelRegistry,
		});

		expect(result.modelSubstitutionWarning).toEqual({
			requested: "openai-codex/gpt-5.3-codex",
			effective: "openai-codex/gpt-5.5",
			reason: "auth_unavailable",
		});
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.model?.id).toBe("gpt-5.5");
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.modelSubstitution).toMatchObject({
			reason: "auth_unavailable",
			requestedModel: { provider: "openai-codex", id: "gpt-5.3-codex" },
		});
		expect(sessionModelChanges).toEqual([]);
	});

	it("surfaces server-side assistant model substitution evidence", async () => {
		vi.clearAllMocks();
		const sessionModelChanges: Array<{
			model: string;
			role?: string;
			metadata?: { previousModel?: string; reason?: string; thinkingLevel?: string | null };
		}> = [];
		const session = createMockSession(({ emit, state }) => {
			const assistant: AssistantMessage = {
				...createAssistantStopMessage("done"),
				provider: "openai-codex",
				model: "gpt-5.5",
			};
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-server-substitution",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		(
			session as unknown as {
				sessionManager: {
					appendSessionInit: () => void;
					appendModelChange: (
						model: string,
						role?: string,
						metadata?: { previousModel?: string; reason?: string; thinkingLevel?: string | null },
					) => string;
				};
			}
		).sessionManager = {
			appendSessionInit: () => {},
			appendModelChange: (model, role, metadata) => {
				sessionModelChanges.push({ model, role, metadata });
				return "model-change-id";
			},
		};
		mockCreateAgentSession(session);
		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [
				{ provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 272000 },
			],
			getApiKey: async () => "sk-test",
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-server-substitution-warning",
			modelOverride: "openai-codex/gpt-5.3-codex:high",
			modelRegistry,
		});

		expect(result.modelSubstitutionWarning).toEqual({
			requested: "openai-codex/gpt-5.3-codex",
			effective: "openai-codex/gpt-5.5",
			reason: "assistant_model_mismatch",
		});
		expect(sessionModelChanges).toEqual([
			{
				model: "openai-codex/gpt-5.5",
				role: undefined,
				metadata: {
					previousModel: "openai-codex/gpt-5.3-codex",
					reason: "assistant_model_mismatch",
					thinkingLevel: Effort.High,
				},
			},
		]);
	});
	it("fails after 3 reminders when yield is never called for a structured task", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			const assistant = createAssistantStopMessage(promptIndex === 1 ? "did work" : "still no yield");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-3",
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		expect(prompts).toHaveLength(4);
		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		expect(result.abortReason).toBeUndefined();
	});

	it("surfaces abort reason when yield reports aborted status", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("cannot proceed");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-abort",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Task aborted: blocked by permissions" }],
					details: { status: "aborted", error: "blocked by permissions" },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-aborted-yield" });
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("blocked by permissions");
	});

	it("marks pre-aborted subprocess with a concrete reason", async () => {
		const abortController = new AbortController();
		abortController.abort("caller cancelled task");

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-cancelled-before-start",
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Cancelled before start");
		expect(result.stderr).toBe("Cancelled before start");
	});
	it("uses modelRegistry.authStorage when only options.modelRegistry is provided", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-registry-only",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);
		const fakeAuthStorage = { sentinel: "registry-storage" } as unknown as AuthStorage;
		const modelRegistry = {
			authStorage: fakeAuthStorage,
			refresh: async () => {},
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		await runSubprocess({ ...baseOptions, id: "subagent-registry-only", modelRegistry });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.authStorage).toBe(fakeAuthStorage);
	});

	it("rejects when options.authStorage and options.modelRegistry.authStorage are different instances", async () => {
		// Mismatch fails via runSubprocess's standard catch path (exitCode=1 + stderr), not a thrown promise.
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession");
		const registryStorage = { sentinel: "registry" } as unknown as AuthStorage;
		const otherStorage = { sentinel: "other" } as unknown as AuthStorage;
		const modelRegistry = {
			authStorage: registryStorage,
			refresh: async () => {},
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-mismatch",
			authStorage: otherStorage,
			modelRegistry,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/options\.authStorage.*modelRegistry\.authStorage/);
		expect(createAgentSessionSpy).not.toHaveBeenCalled();
	});
});

describe("runSubprocess telemetry propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "reviewer",
		description: "code review specialist",
		systemPrompt: "you are a reviewer",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-telemetry",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	function buildSession() {
		return createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-telemetry",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
	}

	it("derives subagent telemetry from parent: keeps tracer/hooks, swaps agent identity, clears conversationId", async () => {
		const createAgentSessionSpy = mockCreateAgentSession(buildSession());
		const onSpanStart = () => {};
		const onSpanEnd = () => {};
		const costEstimator = () => undefined;
		const tracer = { startSpan: () => undefined } as unknown as Tracer;
		const parentTelemetry: AgentTelemetryConfig = {
			tracer,
			captureMessageContent: true,
			attributes: { "deployment.id": "prod" },
			agent: { id: "0-Main", name: "main", description: "primary agent" },
			conversationId: "parent-conversation",
			onSpanStart,
			onSpanEnd,
			costEstimator,
		};

		await runSubprocess({ ...baseOptions, id: "subagent-telemetry-derive", parentTelemetry });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		const forwarded = createAgentSessionSpy.mock.calls[0]?.[0]?.telemetry;
		expect(forwarded).toBeDefined();
		if (!forwarded) throw new Error("expected telemetry on createAgentSession call");
		expect(forwarded.tracer).toBe(tracer);
		expect(forwarded.captureMessageContent).toBe(true);
		expect(forwarded.attributes).toEqual({ "deployment.id": "prod" });
		expect(forwarded.onSpanStart).toBe(onSpanStart);
		expect(forwarded.onSpanEnd).toBe(onSpanEnd);
		expect(forwarded.costEstimator).toBe(costEstimator);
		expect(forwarded.agent).toEqual({
			id: "subagent-telemetry-derive",
			name: baseAgent.name,
			description: baseAgent.description,
		});
		// Child loop falls back to its own session id for gen_ai.conversation.id.
		expect(forwarded.conversationId).toBeUndefined();
	});

	it("forwards no telemetry when the parent has none", async () => {
		const createAgentSessionSpy = mockCreateAgentSession(buildSession());

		await runSubprocess({ ...baseOptions, id: "subagent-telemetry-none" });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.telemetry).toBeUndefined();
	});
});
