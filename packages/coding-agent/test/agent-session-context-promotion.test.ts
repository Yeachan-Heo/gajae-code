import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Model, ProviderSessionState } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession context promotion", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-context-promotion-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function createOverflowMessage(
		model: Model,
		errorMessage = "context_length_exceeded: Your input exceeds the context window of this model.",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}

	function createUserMessage(content: string) {
		return {
			role: "user" as const,
			content,
			timestamp: Date.now(),
		};
	}

	function createAssistantMessage(model: Model, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for condition");
	}
	async function expectSafetyStopToSkipContextPromotion(typed: boolean): Promise<void> {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": true,
			}),
			modelRegistry,
		});
		const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue();
		const continueSpy = vi.spyOn(agent, "continue").mockResolvedValue();
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const safetyStopMessage: AssistantMessage = {
			...createOverflowMessage(sparkModel, "Refusal: prompt is too long"),
			...(typed ? { errorKind: "provider_safety_stop" as const } : {}),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: safetyStopMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [safetyStopMessage] });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();
		await Bun.sleep(120);
		await session.waitForIdle();

		expect(session.model?.provider).toBe(sparkModel.provider);
		expect(session.model?.id).toBe(sparkModel.id);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
	}

	it("promotes to a larger-context model on overflow and clears codex websocket session state", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("does not promote or continue typed provider safety stops", async () => {
		await expectSafetyStopToSkipContextPromotion(true);
	});
	it("does not promote or continue legacy provider safety stops", async () => {
		await expectSafetyStopToSkipContextPromotion(false);
	});
	it("promotes on 413 payload-too-large overflow errors", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(
			sparkModel,
			"413 Request Entity Too Large: payload too large for model request body",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
	});
	it("clears codex provider session state on manual setModel switch away from codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModel(nonCodexModel);

		expect(session.model?.provider).toBe(nonCodexModel.provider);
		expect(session.model?.id).toBe(nonCodexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state on manual temporary switch into codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: nonCodexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModelTemporary(codexModel);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when branching rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.branch(firstUserId);

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when tree navigation rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.navigateTree(firstUserId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("does not promote when promotion is disabled", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!sparkModel) {
			throw new Error("Expected codex spark model to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await Bun.sleep(30);

		expect(session.model?.provider).toBe(sparkModel.provider);
		expect(session.model?.id).toBe(sparkModel.id);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
	});
});
