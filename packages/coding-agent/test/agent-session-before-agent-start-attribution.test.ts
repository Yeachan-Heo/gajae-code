import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { getBundledModel, type Message } from "@gajae-code/ai";
import { inferCopilotInitiator } from "@gajae-code/ai/providers/github-copilot-headers";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

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

	function createSession() {
		const emitBeforeAgentStart = vi.fn().mockResolvedValue({
			messages: [
				{
					customType: "before-start",
					content: injectedText,
					display: false,
				},
			],
		});
		const extensionRunner = {
			emitBeforeAgentStart,
			emit: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
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

	function findPromptMessage(messages: AgentMessage[], text: string): AgentMessage | undefined {
		return messages.find(message => {
			if ((message.role !== "user" && message.role !== "developer") || typeof message.content === "string") {
				return false;
			}
			return message.content.some(block => block.type === "text" && block.text === text);
		});
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
});
