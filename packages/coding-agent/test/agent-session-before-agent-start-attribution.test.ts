import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { type Context, getBundledModel, type Message } from "@gajae-code/ai";
import { inferCopilotInitiator } from "@gajae-code/ai/providers/github-copilot-headers";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { EventBus } from "../src/utils/event-bus";

describe("AgentSession before_agent_start attribution fallback", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	const injectedText = "before-agent-start injected message";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-before-agent-start-attribution-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	function createSession(
		beforeAgentStartResult: Record<string, unknown> = {
			messages: [
				{
					customType: "before-start",
					content: injectedText,
					display: false,
				},
			],
		},
		capturedContexts?: Context[],
	) {
		const emitBeforeAgentStart = vi.fn().mockResolvedValue(beforeAgentStartResult);
		const extensionRunner = {
			emitBeforeAgentStart,
			emit: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const mockModel = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (streamModel, context, streamOptions) => {
				capturedContexts?.push(structuredClone(context));
				return mockModel.stream(streamModel, context, streamOptions);
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});

		return { emitBeforeAgentStart };
	}

	function findBeforeStartInjection(messages: AgentMessage[]): AgentMessage | undefined {
		return messages.find(message => message.role === "custom" && message.customType === "before-start");
	}

	function findBeforeStartInjectionLlm(messages: Message[]): Message | undefined {
		return messages.find(message => {
			if (message.role === "assistant") return false;
			if (typeof message.content === "string") return message.content === injectedText;
			return message.content.some(block => block.type === "text" && block.text === injectedText);
		});
	}

	function findPromptMessage(
		messages: AgentMessage[],
		text: string,
	): Extract<AgentMessage, { role: "user" | "developer" }> | undefined {
		return messages.find(message => {
			if ((message.role !== "user" && message.role !== "developer") || typeof message.content === "string") {
				return false;
			}
			return message.content.some(block => block.type === "text" && block.text === text);
		}) as Extract<AgentMessage, { role: "user" | "developer" }> | undefined;
	}
	it("defaults before_agent_start message attribution to user for user prompts", async () => {
		const { emitBeforeAgentStart } = createSession();

		await session.prompt("hello from user");

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		const injectedMessage = findBeforeStartInjection(session.messages);
		expect(injectedMessage).toBeDefined();
		if (injectedMessage?.role !== "custom") {
			throw new Error("Expected injected custom message in session state");
		}

		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		const llmInjected = findBeforeStartInjectionLlm(llmMessages);
		expect(llmInjected).toBeDefined();
		if (!llmInjected || llmInjected.role === "assistant") {
			throw new Error("Expected injected message in converted LLM context");
		}
		expect(llmInjected.attribution).toBe("user");
		expect(inferCopilotInitiator(llmMessages)).toBe("user");
	});

	it("submits Function Hook prompt and image transformations to the model", async () => {
		const contexts: Context[] = [];
		createSession({ prompt: "redacted prompt", images: [], systemPrompt: ["redacted system"] }, contexts);

		await session.prompt("secret prompt", {
			images: [{ type: "image", data: "secret-image", mimeType: "image/png" }],
		});

		const submitted = contexts[0];
		expect(submitted?.systemPrompt).toEqual(["redacted system"]);
		const user = submitted ? findPromptMessage(submitted.messages, "redacted prompt") : undefined;
		expect(user?.content).toEqual([{ type: "text", text: "redacted prompt" }]);
	});

	it("submits public Function Hook transformations through a legacy handler", async () => {
		const contexts: Context[] = [];
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const extension = await loadExtensionFromFactory(
			api => {
				api.registerFunctionHook(
					"before_agent_start",
					async invocation => ({
						action: "continue",
						event: {
							...invocation.payload,
							prompt: "public redacted prompt",
							images: undefined,
							systemPrompt: ["function system"],
						},
					}),
					{ capabilities: ["ui.transform"] },
				);
				api.on("before_agent_start", event => ({
					systemPrompt: [...event.systemPrompt, "legacy system"],
				}));
			},
			tempDir.path(),
			eventBus,
			runtime,
			"public-function-hook",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mockModel = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (streamModel, context, streamOptions) => {
				contexts.push(structuredClone(context));
				return mockModel.stream(streamModel, context, streamOptions);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("public secret", {
			images: [{ type: "image", data: "secret-image", mimeType: "image/png" }],
		});

		expect(contexts[0]?.systemPrompt).toEqual(["function system", "legacy system"]);
		const user = contexts[0] ? findPromptMessage(contexts[0].messages, "public redacted prompt") : undefined;
		expect(user?.content).toEqual([{ type: "text", text: "public redacted prompt" }]);
	});

	it("submits transformed custom prompt content", async () => {
		const contexts: Context[] = [];
		createSession({ prompt: "transformed custom", images: [] }, contexts);

		await session.promptCustomMessage({
			customType: "function-hook-test",
			content: "custom secret",
			display: false,
			attribution: "user",
		});

		const submitted = JSON.stringify(contexts);
		expect(submitted).toContain("transformed custom");
		expect(submitted).not.toContain("custom secret");
	});

	it("does not expand file mentions removed by a prompt transformation", async () => {
		const contexts: Context[] = [];
		const mentionedPath = tempDir.join("function-hook-secret.txt");
		await Bun.write(mentionedPath, "FUNCTION_HOOK_FILE_SECRET");
		createSession({ prompt: "safe prompt", images: [] }, contexts);

		await session.prompt(`inspect @${mentionedPath}`);

		const submitted = JSON.stringify(contexts[0]);
		expect(submitted).not.toContain("FUNCTION_HOOK_FILE_SECRET");
		expect(submitted).not.toContain(mentionedPath);
	});

	it("defaults before_agent_start message attribution to agent for synthetic prompts", async () => {
		const { emitBeforeAgentStart } = createSession();

		await session.prompt("internal reminder", { synthetic: true });

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		const injectedMessage = findBeforeStartInjection(session.messages);
		expect(injectedMessage).toBeDefined();
		if (injectedMessage?.role !== "custom") {
			throw new Error("Expected injected custom message in session state");
		}

		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		const llmInjected = findBeforeStartInjectionLlm(llmMessages);
		expect(llmInjected).toBeDefined();
		if (!llmInjected || llmInjected.role === "assistant") {
			throw new Error("Expected injected message in converted LLM context");
		}
		expect(llmInjected.attribution).toBe("agent");
		expect(inferCopilotInitiator(llmMessages)).toBe("agent");
	});

	it("allows user-role prompts to opt into agent attribution", async () => {
		const { emitBeforeAgentStart } = createSession();
		const promptText = "delegated task";

		await session.prompt(promptText, { attribution: "agent" });

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		const promptMessage = findPromptMessage(session.messages, promptText);
		expect(promptMessage).toBeDefined();
		expect(promptMessage?.role).toBe("user");
		if (promptMessage?.role !== "user") {
			throw new Error("Expected delegated prompt to remain a user-role message");
		}
		expect(promptMessage.attribution).toBe("agent");

		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		const llmInjected = findBeforeStartInjectionLlm(llmMessages);
		expect(llmInjected).toBeDefined();
		if (!llmInjected || llmInjected.role === "assistant") {
			throw new Error("Expected injected message in converted LLM context");
		}
		expect(llmInjected.attribution).toBe("agent");
		expect(inferCopilotInitiator(llmMessages)).toBe("agent");
	});
	it("rejects a prompt whose async preflight is cancelled before acceptance", async () => {
		const { emitBeforeAgentStart } = createSession();
		const preflightStarted = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		emitBeforeAgentStart.mockImplementationOnce(async () => {
			preflightStarted.resolve();
			await releasePreflight.promise;
			return undefined;
		});
		let accepted = false;
		const cancelledPrompt = session.sendUserMessage("cancel during preflight", {
			onPreflightAccepted: () => {
				accepted = true;
			},
		});
		await preflightStarted.promise;
		await session.abort();
		releasePreflight.resolve();

		await expect(cancelledPrompt).rejects.toMatchObject({
			code: "busy",
			message: "Prompt preflight was cancelled before execution.",
		});
		expect(accepted).toBe(false);

		let replacementAccepted = false;
		await session.sendUserMessage("replacement prompt", {
			onPreflightAccepted: () => {
				replacementAccepted = true;
			},
		});
		expect(replacementAccepted).toBe(true);
	});
	it("orders an accepted prompt before a later default selection through provider start", async () => {
		const { emitBeforeAgentStart } = createSession();
		const preflightStarted = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		emitBeforeAgentStart.mockImplementationOnce(async () => {
			preflightStarted.resolve();
			await releasePreflight.promise;
			return undefined;
		});
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const apiKeySpy = vi.spyOn(modelRegistry, "getApiKey");

		const prompt = session.prompt("held in preflight");
		await preflightStarted.promise;
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await Promise.resolve();
		await Promise.resolve();

		expect(apiKeySpy.mock.calls.some(([model]) => model === selectionModel)).toBe(false);
		releasePreflight.resolve();
		await prompt;
		await selection;
		expect(apiKeySpy.mock.calls.some(([model]) => model === selectionModel)).toBe(true);
	});

	it("orders an accepted default selection before later prompt preflight", async () => {
		const { emitBeforeAgentStart } = createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
				return "selection-key";
			}
			return "test-key";
		});

		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const prompt = session.prompt("wait behind selection");
		await Promise.resolve();
		await Promise.resolve();

		expect(emitBeforeAgentStart).not.toHaveBeenCalled();
		releaseSelectionValidation.resolve();
		await selection;
		await prompt;
		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
	});

	it("fails awaited same-session selection reentrancy with a stable busy result", async () => {
		const { emitBeforeAgentStart } = createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		let reentrantError: unknown;
		emitBeforeAgentStart.mockImplementationOnce(async () => {
			try {
				await session.setDefaultModelSelection(currentModel, undefined);
			} catch (error) {
				reentrantError = error;
			}
			return undefined;
		});

		await session.prompt("reentrant selection");

		expect(reentrantError).toMatchObject({
			name: "AgentBusyError",
			code: "busy",
			message: "Agent session admission is busy due to same-session reentrancy.",
		});
	});
	it("fails awaited same-session prompt reentrancy before a later selection fence can deadlock it", async () => {
		const { emitBeforeAgentStart } = createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		let reentrantError: unknown;
		emitBeforeAgentStart.mockImplementationOnce(async () => {
			hookStarted.resolve();
			await releaseHook.promise;
			try {
				await session.prompt("reentrant prompt");
			} catch (error) {
				reentrantError = error;
			}
			return undefined;
		});

		const prompt = session.prompt("outer prompt");
		await hookStarted.promise;
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		releaseHook.resolve();
		await prompt;
		await selection;

		expect(reentrantError).toMatchObject({
			name: "AgentBusyError",
			code: "busy",
			message: "Agent session admission is busy due to same-session reentrancy.",
		});
	});
	it("orders a selection accepted during an active prompt before a later queued successor", async () => {
		const { emitBeforeAgentStart } = createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const preflightStarted = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		emitBeforeAgentStart.mockImplementationOnce(async () => {
			preflightStarted.resolve();
			await releasePreflight.promise;
			return undefined;
		});

		const activePrompt = session.prompt("active prompt");
		await preflightStarted.promise;
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		const successor = session.prompt("later successor", { streamingBehavior: "followUp" });
		await Promise.resolve();
		await Promise.resolve();

		expect(session.agent.hasQueuedMessages()).toBe(false);
		releasePreflight.resolve();
		await activePrompt;
		await selection;
		await successor;
		expect(session.model).toBe(selectionModel);
	});
	it("fences SDK prompt, steer, and follow-up ingress behind an earlier selection", async () => {
		const { emitBeforeAgentStart } = createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const preflightStarted = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		emitBeforeAgentStart.mockImplementationOnce(async () => {
			preflightStarted.resolve();
			await releasePreflight.promise;
			return undefined;
		});
		const order: string[] = [];

		const activePrompt = session.prompt("active prompt");
		await preflightStarted.promise;
		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onAfterMutation: () => order.push("selection"),
		});
		const sdkPrompt = session.sendUserMessage("SDK prompt", {
			onPreflightAccepted: () => order.push("prompt"),
		});
		const sdkSteer = session.sendUserMessage("SDK steer", {
			deliverAs: "steer",
			onPreflightAccepted: () => order.push("steer"),
		});
		const sdkFollowUp = session.sendUserMessage("SDK follow-up", {
			deliverAs: "followUp",
			onPreflightAccepted: () => order.push("followUp"),
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(order).toEqual([]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		releasePreflight.resolve();
		await Promise.all([activePrompt, selection, sdkPrompt, sdkSteer, sdkFollowUp]);

		expect(order[0]).toBe("selection");
		expect(order).toEqual(expect.arrayContaining(["selection", "prompt", "steer", "followUp"]));
		expect(session.model).toBe(selectionModel);
	});
	it("promotes an SDK prompt queued at dispatch when no predecessor remains after selection", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const order: string[] = [];
		const promoted = Promise.withResolvers<void>();
		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onAfterMutation: () => order.push("selection"),
		});
		await selectionValidationStarted.promise;
		const sdkPrompt = session.sendUserMessage("queued SDK prompt", {
			queuedAtDispatch: true,
			onPreflightAccepted: () => order.push("accepted"),
			onPreflightAcceptCommit: () => {
				order.push("committed");
			},
			onQueuedPromoted: () => {
				order.push("promoted");
				promoted.resolve();
			},
		});
		releaseSelectionValidation.resolve();

		await selection;
		await sdkPrompt;
		await promoted.promise;
		await session.waitForIdle();

		expect(order).toEqual(["selection", "committed", "promoted"]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.model).toBe(selectionModel);
	});
	it("keeps an explicit SDK follow-up queued across a selection fence", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const accepted = Promise.withResolvers<void>();
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const sdkFollowUp = session.sendUserMessage("queued SDK follow-up", {
			queuedAtDispatch: true,
			deliverAs: "followUp",
			onPreflightAccepted: () => accepted.resolve(),
		});
		releaseSelectionValidation.resolve();

		await selection;
		await sdkFollowUp;
		await accepted.promise;

		expect(session.pendingMessageCounts).toEqual({ steering: 0, followUp: 1, nextTurn: 0 });
		expect(session.model).toBe(selectionModel);
	});
	it("keeps a later queued SDK prompt behind an earlier follow-up", async () => {
		createSession();
		await session.prompt("seed assistant tail");
		await session.waitForIdle();
		const releaseStartupBarrier = Promise.withResolvers<void>();
		session.extendStartupTurnBarrier(releaseStartupBarrier.promise);
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const promoted: string[] = [];
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const first = session.sendUserMessage("first follow-up", {
			queuedAtDispatch: true,
			deliverAs: "followUp",
			onQueuedPromoted: () => promoted.push("follow-up"),
		});
		const second = session.sendUserMessage("later plain prompt", {
			queuedAtDispatch: true,
			onQueuedPromoted: () => promoted.push("plain"),
		});
		releaseSelectionValidation.resolve();

		await Promise.all([selection, first, second]);
		expect(session.pendingMessageCounts).toEqual({ steering: 0, followUp: 2, nextTurn: 0 });
		const queuedFollowUps = session.agent.snapshotFollowUp();
		expect(queuedFollowUps[0]).toMatchObject({
			role: "user",
			content: expect.arrayContaining([{ type: "text", text: "first follow-up" }]),
		});
		expect(queuedFollowUps[1]).toMatchObject({
			role: "user",
			content: expect.arrayContaining([{ type: "text", text: "later plain prompt" }]),
		});
		releaseStartupBarrier.resolve();
		await session.waitForIdle();

		expect(promoted[0]).toBe("follow-up");
	});
	it("reserves an earlier follow-up before classifying a later prompt behind the same fence", async () => {
		createSession();
		await session.prompt("seed assistant tail");
		await session.waitForIdle();
		const releaseStartupBarrier = Promise.withResolvers<void>();
		session.extendStartupTurnBarrier(releaseStartupBarrier.promise);
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const followUpCommitStarted = Promise.withResolvers<void>();
		const releaseFollowUpCommit = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const promoted: string[] = [];
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		// The explicit follow-up parks inside its asynchronous durable acceptance
		// (onPreflightAcceptCommit) before #queueFollowUp records anything.
		const first = session.sendUserMessage("first follow-up", {
			queuedAtDispatch: true,
			deliverAs: "followUp",
			onPreflightAcceptCommit: async () => {
				followUpCommitStarted.resolve();
				await releaseFollowUpCommit.promise;
			},
			onQueuedPromoted: () => promoted.push("follow-up"),
		});
		// Let the selection fence settle so the follow-up dispatch reaches (and
		// parks inside) its durable commit before the later prompt classifies.
		releaseSelectionValidation.resolve();
		await selection;
		await followUpCommitStarted.promise;
		// The later plain prompt classifies while the earlier follow-up is still
		// awaiting its commit: it must observe the reserved follow-up ahead and
		// queue as a follow-up behind it rather than starting a fresh run.
		const second = session.sendUserMessage("later plain prompt", {
			queuedAtDispatch: true,
			onQueuedPromoted: () => promoted.push("plain"),
		});
		releaseFollowUpCommit.resolve();

		await Promise.all([first, second]);
		expect(session.pendingMessageCounts).toEqual({ steering: 0, followUp: 2, nextTurn: 0 });
		const queuedFollowUps = session.agent.snapshotFollowUp();
		expect(queuedFollowUps[0]).toMatchObject({
			role: "user",
			content: expect.arrayContaining([{ type: "text", text: "first follow-up" }]),
		});
		expect(queuedFollowUps[1]).toMatchObject({
			role: "user",
			content: expect.arrayContaining([{ type: "text", text: "later plain prompt" }]),
		});
		releaseStartupBarrier.resolve();
		await session.waitForIdle();

		expect(promoted[0]).toBe("follow-up");
	});
	it("releases a follow-up reservation when terminal abort cancels the selection-fence wait", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		// Park a selection fence so the follow-up dispatch parks inside its
		// selection-fence wait holding an un-enqueued reservation.
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const cancelled = session.sendUserMessage("cancelled follow-up", {
			queuedAtDispatch: true,
			deliverAs: "followUp",
		});
		for (let i = 0; i < 10; i++) await Promise.resolve();
		// Cancel the preflight while the dispatch still waits on the fence: the
		// reservation must not outlive the rejection.
		session.cancelPendingPreflightForTerminalAbort();

		await expect(cancelled).rejects.toMatchObject({
			code: "busy",
			message: "Prompt preflight was cancelled before execution.",
		});
		releaseSelectionValidation.resolve();
		await selection;

		// A later plain queued prompt must classify as fresh (no leaked
		// follow-up reservation ahead of it) and start its own run.
		let promoted = false;
		await session.sendUserMessage("later plain prompt", {
			queuedAtDispatch: true,
			onQueuedPromoted: () => {
				promoted = true;
			},
		});
		await session.waitForIdle();

		expect(promoted).toBe(true);
		expect(session.pendingMessageCounts.followUp).toBe(0);
	});
	it("rejects fresh queued SDK promotion when disposal starts during durable acceptance", async () => {
		createSession();
		const providerPrompt = vi.spyOn(session.agent, "prompt");
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const durableAcceptanceStarted = Promise.withResolvers<void>();
		const releaseDurableAcceptance = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		let promoted = false;
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const sdkPrompt = session.sendUserMessage("queued SDK prompt", {
			queuedAtDispatch: true,
			onPreflightAcceptCommit: async () => {
				durableAcceptanceStarted.resolve();
				await releaseDurableAcceptance.promise;
			},
			onQueuedPromoted: () => {
				promoted = true;
			},
		});
		releaseSelectionValidation.resolve();
		await selection;
		await durableAcceptanceStarted.promise;
		const disposal = session.dispose();
		releaseDurableAcceptance.resolve();

		await expect(sdkPrompt).rejects.toMatchObject({
			code: "busy",
			message: "Prompt preflight was cancelled before execution.",
		});
		await disposal;

		expect(promoted).toBe(false);
		expect(providerPrompt).not.toHaveBeenCalled();
	});
	it("rejects fresh queued SDK promotion when terminal abort cancels durable acceptance", async () => {
		createSession();
		const providerPrompt = vi.spyOn(session.agent, "prompt");
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const durableAcceptanceStarted = Promise.withResolvers<void>();
		const releaseDurableAcceptance = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		let promoted = false;
		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const sdkPrompt = session.sendUserMessage("queued SDK prompt", {
			queuedAtDispatch: true,
			onPreflightAcceptCommit: async () => {
				durableAcceptanceStarted.resolve();
				await releaseDurableAcceptance.promise;
			},
			onQueuedPromoted: () => {
				promoted = true;
			},
		});
		releaseSelectionValidation.resolve();
		await selection;
		await durableAcceptanceStarted.promise;
		session.cancelPendingPreflightForTerminalAbort();
		releaseDurableAcceptance.resolve();

		await expect(sdkPrompt).rejects.toMatchObject({
			code: "busy",
			message: "Prompt preflight was cancelled before execution.",
		});
		expect(promoted).toBe(false);
		expect(providerPrompt).not.toHaveBeenCalled();
	});
	it("does not start a provider when terminal abort races after requester promotion", async () => {
		createSession();
		const providerPrompt = vi.spyOn(session.agent, "prompt");
		let promotions = 0;
		const sdkPrompt = session.sendUserMessage("queued SDK prompt", {
			queuedAtDispatch: true,
			onPreflightAcceptCommit: async () => {},
			onQueuedPromoted: () => {
				promotions += 1;
				session.cancelPendingPreflightForTerminalAbort();
			},
		});

		await expect(sdkPrompt).rejects.toMatchObject({
			code: "busy",
			message: "Prompt preflight was cancelled before execution.",
		});
		expect(promotions).toBe(1);
		expect(providerPrompt).not.toHaveBeenCalled();
	});
	for (const deliverAs of ["steer", "followUp"] as const) {
		it(`rejects SDK ${deliverAs} when terminal abort cancels durable acceptance`, async () => {
			createSession();
			const durableAcceptanceStarted = Promise.withResolvers<void>();
			const releaseDurableAcceptance = Promise.withResolvers<void>();
			let accepted = false;
			const sdkMessage = session.sendUserMessage(`queued SDK ${deliverAs}`, {
				deliverAs,
				onPreflightAcceptCommit: async () => {
					durableAcceptanceStarted.resolve();
					await releaseDurableAcceptance.promise;
				},
				onPreflightAccepted: () => {
					accepted = true;
				},
			});
			await durableAcceptanceStarted.promise;
			session.cancelPendingPreflightForTerminalAbort();
			releaseDurableAcceptance.resolve();

			await expect(sdkMessage).rejects.toMatchObject({
				code: "busy",
				message: "Prompt preflight was cancelled before execution.",
			});
			expect(accepted).toBe(false);
			expect(session.agent.hasQueuedMessages()).toBe(false);
		});
	}
	it("rejects fenced SDK ingress when disposal drains the earlier selection", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		let accepted = false;

		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const sdkFollowUp = session.sendUserMessage("reject during disposal", {
			deliverAs: "followUp",
			onPreflightAccepted: () => {
				accepted = true;
			},
		});
		const disposal = session.dispose();
		releaseSelectionValidation.resolve();

		await selection;
		await expect(sdkFollowUp).rejects.toMatchObject({ name: "AgentBusyError", code: "busy" });
		await disposal;
		expect(accepted).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
	for (const deliverAs of ["steer", "followUp"] as const) {
		it(`rejects SDK ${deliverAs} when disposal starts during durable acceptance`, async () => {
			createSession();
			const currentModel = session.model;
			if (!currentModel) throw new Error("Expected session model");
			const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
			authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
			const selectionValidationStarted = Promise.withResolvers<void>();
			const releaseSelectionValidation = Promise.withResolvers<void>();
			const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
				if (model === selectionModel) {
					selectionValidationStarted.resolve();
					await releaseSelectionValidation.promise;
				}
				return originalGetApiKey(model, ...args);
			});
			const acceptanceStarted = Promise.withResolvers<void>();
			const releaseAcceptance = Promise.withResolvers<void>();
			let accepted = false;

			const selection = session.setDefaultModelSelection(selectionModel, undefined);
			await selectionValidationStarted.promise;
			const sdkMessage = session.sendUserMessage(`reject ${deliverAs} during acceptance`, {
				deliverAs,
				onPreflightAcceptCommit: async () => {
					acceptanceStarted.resolve();
					await releaseAcceptance.promise;
				},
				onPreflightAccepted: () => {
					accepted = true;
				},
			});
			releaseSelectionValidation.resolve();
			await acceptanceStarted.promise;
			const disposal = session.dispose();
			releaseAcceptance.resolve();

			await selection;
			await expect(sdkMessage).rejects.toMatchObject({ name: "AgentBusyError", code: "busy" });
			await disposal;
			expect(accepted).toBe(false);
			expect(session.agent.hasQueuedMessages()).toBe(false);
		});
	}
	it("cancels a queued prompt without starving later admission", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
				return "selection-key";
			}
			return "test-key";
		});

		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		const queuedPrompt = session.prompt("cancel while queued");
		await session.abort();
		releaseSelectionValidation.resolve();
		await selection;
		await expect(queuedPrompt).rejects.toMatchObject({ code: "busy" });

		await session.prompt("successor prompt");
	});
	it("disposal drains an active selection", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-model" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const validationStarted = Promise.withResolvers<void>();
		const releaseValidation = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model === selectionModel) {
				validationStarted.resolve();
				await releaseValidation.promise;
				return "selection-key";
			}
			return "test-key";
		});

		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await validationStarted.promise;
		const queuedPrompt = session.prompt("queued during disposal");
		const disposal = session.dispose();
		const queuedResult = queuedPrompt.then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);
		releaseValidation.resolve();
		await selection;
		const result = await queuedResult;
		expect(result).toMatchObject({ status: "rejected", error: { code: "busy" } });
		await disposal;
		session = undefined as unknown as AgentSession;
	});

	it("disposal drains a selection between validation and mutation admissions", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-between-admissions" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const admissionGapStarted = Promise.withResolvers<void>();
		const releaseAdmissionGap = Promise.withResolvers<void>();

		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onBeforeMutationAdmissionForTests: async () => {
				admissionGapStarted.resolve();
				await releaseAdmissionGap.promise;
			},
		});
		await Promise.race([
			admissionGapStarted.promise,
			Bun.sleep(2_000).then(() => {
				throw new Error("Selection did not reach the inter-admission idle wait");
			}),
		]);
		const disposal = session.dispose();
		let disposalSettled = false;
		void disposal.then(() => {
			disposalSettled = true;
		});
		const queuedPrompt = session.prompt("reject while selection drains");
		const queuedResult = queuedPrompt.then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);
		await Bun.sleep(20);
		expect(disposalSettled).toBe(false);

		releaseAdmissionGap.resolve();
		const selectionResult = await Promise.race([
			selection,
			Bun.sleep(2_000).then(() => {
				throw new Error("Selection did not settle after its idle wait was released");
			}),
		]);
		expect(selectionResult).toMatchObject({
			provider: selectionModel.provider,
			modelId: selectionModel.id,
		});
		expect(await queuedResult).toMatchObject({ status: "rejected", error: { code: "busy" } });
		await Promise.race([
			disposal,
			Bun.sleep(2_000).then(() => {
				throw new Error("Disposal did not settle after the selection completed");
			}),
		]);
		session = undefined as unknown as AgentSession;
	});

	it("disposal drains a mutation admission activated before its closed-fence recheck", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-activated" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const admissionReady = Promise.withResolvers<void>();
		const releaseAdmissionReady = Promise.withResolvers<void>();

		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onAfterMutationAdmissionReadyForTests: async () => {
				admissionReady.resolve();
				await releaseAdmissionReady.promise;
			},
		});
		await admissionReady.promise;
		const disposal = session.dispose();
		let disposalSettled = false;
		void disposal.then(() => {
			disposalSettled = true;
		});
		const queuedPrompt = session.prompt("reject while activated selection drains");
		const queuedPromptResult = queuedPrompt.then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);
		await Bun.sleep(20);
		expect(disposalSettled).toBe(false);

		releaseAdmissionReady.resolve();
		await expect(selection).resolves.toMatchObject({
			provider: selectionModel.provider,
			modelId: selectionModel.id,
		});
		expect(await queuedPromptResult).toMatchObject({ status: "rejected", error: { code: "busy" } });
		await disposal;
		session = undefined as unknown as AgentSession;
	});

	it("disposal rejects a second-phase selection queued behind an active prompt", async () => {
		createSession();
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, provider: "selection-provider", id: "selection-behind-prompt" };
		authStorage?.setRuntimeApiKey(selectionModel.provider, "selection-key");
		const admissionGapStarted = Promise.withResolvers<void>();
		const releaseAdmissionGap = Promise.withResolvers<void>();
		const promptAdmissionStarted = Promise.withResolvers<void>();
		const releasePromptAdmission = Promise.withResolvers<void>();
		const safetyRelease = setTimeout(() => {
			releaseAdmissionGap.resolve();
			releasePromptAdmission.resolve();
		}, 5_000);
		safetyRelease.unref?.();

		try {
			const selection = session.setDefaultModelSelection(selectionModel, undefined, {
				onBeforeMutationAdmissionForTests: async () => {
					admissionGapStarted.resolve();
					await releaseAdmissionGap.promise;
				},
			});
			const selectionResult = selection.then(
				value => ({ status: "fulfilled" as const, value }),
				error => ({ status: "rejected" as const, error }),
			);
			await admissionGapStarted.promise;
			const activePrompt = session.runWithPromptAdmissionForTests(async () => {
				promptAdmissionStarted.resolve();
				await releasePromptAdmission.promise;
			});
			await promptAdmissionStarted.promise;
			releaseAdmissionGap.resolve();
			await Promise.resolve();
			await Promise.resolve();

			const disposal = session.dispose();
			const queuedPrompt = session.prompt("reject behind active prompt disposal");
			const queuedPromptResult = queuedPrompt.then(
				() => ({ status: "fulfilled" as const }),
				error => ({ status: "rejected" as const, error }),
			);
			await Promise.race([
				disposal,
				Bun.sleep(2_000).then(() => {
					throw new Error("Disposal waited for the active prompt admission");
				}),
			]);
			expect(await selectionResult).toMatchObject({ status: "rejected", error: { code: "busy" } });
			expect(await queuedPromptResult).toMatchObject({ status: "rejected", error: { code: "busy" } });
			expect(session.model?.id).toBe(currentModel.id);

			releasePromptAdmission.resolve();
			await activePrompt;
		} finally {
			clearTimeout(safetyRelease);
			releaseAdmissionGap.resolve();
			releasePromptAdmission.resolve();
			session = undefined as unknown as AgentSession;
		}
	});
});
