import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@gajae-code/agent-core";
import { type AssistantMessage, Effort, getBundledModel, type Model, writeModelCache } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function trackRetryEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStartEvents.push(event);
		}
		if (event.type === "auto_retry_end") {
			retryEndEvents.push(event);
		}
	});
	return { retryStartEvents, retryEndEvents };
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage {
	const lastMessage = session.messages.at(-1);
	if (lastMessage?.role !== "assistant") {
		throw new Error("Expected final assistant message");
	}
	return lastMessage;
}

function createFallbackAgent(primaryModel: Model, requestedModels: string[]): Agent {
	const mock = createMockModel();
	let primaryAttempts = 0;
	return new Agent({
		getApiKey: provider => `${provider}-test-key`,
		initialState: {
			model: primaryModel,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: (model, context, options) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === primaryModel.provider && model.id === primaryModel.id && primaryAttempts === 0) {
				primaryAttempts += 1;
				mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
			} else {
				mock.push({ content: [`ok:${model.provider}/${model.id}`] });
			}
			return mock.stream(model, context, options);
		},
	});
}

function createCachedLocalModel(
	provider: "ollama" | "lm-studio",
	id: string,
	baseUrl: string,
): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function seedLocalProviderCache(
	tempDir: TempDir,
	authStorage: AuthStorage,
	models: Model<"openai-responses">[],
): ModelRegistry {
	const cacheDbPath = path.join(tempDir.path(), "models.db");
	for (const model of models) {
		writeModelCache(model.provider, Date.now(), [model], true, "", cacheDbPath);
	}
	return new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));
}

describe("AgentSession retry fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		authStorage.setRuntimeApiKey("google", "google-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("advances through a role-keyed fallback chain across retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "service unavailable: 503 overloaded" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on second fallback"] });
				} else {
					throw new Error(`Unexpected model requested during retry fallback test: ${model.provider}/${model.id}`);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Recover from rate limits");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([0, 0]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 2 });
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
	});

	it("explicitly falls back from an unavailable local provider to the first non-local configured fallback", async () => {
		const primaryModel = createCachedLocalModel("ollama", "qwen-local", "http://127.0.0.1:11434/v1");
		const localFallback = createCachedLocalModel("lm-studio", "backup-local", "http://localhost:1234/v1");
		const cloudFallback = getBundledModel("openai", "gpt-4o-mini");
		if (!cloudFallback) {
			throw new Error("Expected bundled OpenAI fallback model to exist");
		}
		modelRegistry = seedLocalProviderCache(tempDir, authStorage, [primaryModel, localFallback]);

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === primaryModel.provider && requestedModel.id === primaryModel.id) {
					mock.push({ throw: "connect ECONNREFUSED 127.0.0.1:11434" });
				} else if (requestedModel.provider === cloudFallback.provider && requestedModel.id === cloudFallback.id) {
					mock.push({ content: ["Recovered on explicit cloud fallback"] });
				} else {
					throw new Error(`Unexpected model requested: ${requestedModel.provider}/${requestedModel.id}`);
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${localFallback.provider}/${localFallback.id}`, `${cloudFallback.provider}/${cloudFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Recover from unavailable local provider");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${cloudFallback.provider}/${cloudFallback.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 1, delayMs: 0 });
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${cloudFallback.provider}/${cloudFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${cloudFallback.provider}/${cloudFallback.id}`,
				role: "default",
			},
		]);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered on explicit cloud fallback" });
	});

	it("does not hammer a failing local provider when no non-local fallback is explicitly configured", async () => {
		const primaryModel = createCachedLocalModel("ollama", "qwen-local", "http://127.0.0.1:11434/v1");
		const localFallback = createCachedLocalModel("lm-studio", "backup-local", "http://localhost:1234/v1");
		modelRegistry = seedLocalProviderCache(tempDir, authStorage, [primaryModel, localFallback]);

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			handler: () => ({ throw: "fetch failed: connect ECONNREFUSED 127.0.0.1:11434" }),
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
			"retry.fallbackChains": {
				default: [`${localFallback.provider}/${localFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Do not retry unavailable local provider without cloud fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		expect(fallbackAppliedEvents).toHaveLength(0);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
	});

	it("uses Google retry hints in quota errors before quota backoff", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const errorMessage =
			"Google API error (429): Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 0.05s.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: errorMessage }, { content: ["Recovered after Google quota retry"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Google token quota");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 50,
			errorMessage,
		});
		expect(waitSpy).toHaveBeenCalledWith(50, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Google quota retry" });
	});

	it("auto-retries preserved OpenAI first-event timeout errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const timeoutMessage = "OpenAI responses stream timed out while waiting for the first event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: timeoutMessage }, { content: ["Recovered after OpenAI timeout"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry preserved OpenAI timeout");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: timeoutMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after OpenAI timeout" });
	});

	it("auto-retries stream stall errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const stallMessage = "Provider stream stalled while waiting for the next event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: stallMessage }, { content: ["Recovered after stream stall"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stream stall");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: stallMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after stream stall" });
	});

	it("auto-retries OpenAI processing-request transient errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const processingError =
			"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 4a4c6b73-a07c-4de0-aaaf-82560f9f626a in your message.";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: processingError }, { content: ["Recovered after OpenAI processing error"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry OpenAI processing-request error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: processingError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after OpenAI processing error",
		});
	});

	it("auto-retries Anthropic stream-envelope failures before message_start", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: received content_block_start before message_start";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: envelopeError }, { content: ["Recovered after Anthropic envelope retry"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_start");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("does not auto-retry Anthropic stream-envelope failures before terminal stop signal", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const envelopeError = "Anthropic stream envelope error: received content_block_delta before terminal stop signal";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel({ handler: () => ({ throw: envelopeError }) });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Do not retry Anthropic envelope failure before terminal stop signal");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(fallbackSucceededEvents).toHaveLength(0);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe(envelopeError);
	});

	it("does not auto-retry generic Request was aborted. errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel({ handler: () => ({ throw: "Request was aborted." }) });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Do not retry generic abort text");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe("Request was aborted.");
	});

	it("suppresses cooled selectors and lazily reverts to the role primary after cooldown expiry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		await session.prompt("Immediate second prompt should stay on fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		now += 240;
		await session.prompt("Third prompt should lazily revert to primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
	});

	it("preserves thinking on bare fallback selectors and does not overwrite user thinking on restore", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}:high`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers bare-selector fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.thinkingLevel).toBeUndefined();

		session.setThinkingLevel(Effort.Low);
		now += 240;
		await session.prompt("Second prompt should restore model but preserve user thinking change");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(session.thinkingLevel).toBeUndefined();
	});

	it("accepts cached Ollama Cloud fallback selectors during startup validation", () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const cachedModel: Model<"ollama-chat"> = {
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		};
		writeModelCache("ollama-cloud", Date.now(), [cachedModel], true, "", path.join(tempDir.path(), "models.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: ["ollama-cloud/deepseek-v4-pro"] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		expect(session.configWarnings).not.toContain(
			"Fallback chain for role 'default' references unknown model: ollama-cloud/deepseek-v4-pro",
		);
	});

	it("normalizes suppression by base selector and clears it on model refresh", async () => {
		const future = Date.now() + 60_000;
		modelRegistry.suppressSelector("openai/gpt-4o:high", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:low")).toBe(true);

		await modelRegistry.refresh("offline");
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(false);
	});
});
