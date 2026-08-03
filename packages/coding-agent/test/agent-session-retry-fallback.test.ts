import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model, type ToolCall } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import type { Extension } from "@gajae-code/coding-agent/extensibility/extensions/types";
import {
	AgentSession,
	type AgentSessionEvent,
	DefaultModelSelectionRecoveryError,
} from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { z } from "zod";

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

function typedRateLimitStream(
	model: Model,
	retryAfterMs: number,
	errorMessage = "Provider returned error: rate_limit_error: organization quota reached",
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
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
			errorStatus: 429,
			transportFailure: {
				kind: "transport",
				status: 429,
				headers: { "retry-after-ms": String(retryAfterMs) },
			},
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function typedUsageLimitStream(model: Model, retryAfterMs = 60_000): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
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
			errorMessage:
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			errorStatus: 429,
			transportFailure: { kind: "transport", status: 429, headers: { "retry-after-ms": String(retryAfterMs) } },
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}
function canonicalFirstEventTimeoutStream(
	model: Model,
	content: AssistantMessage["content"] = [],
	transportFailure?: AssistantMessage["transportFailure"],
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content,
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
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
			...(transportFailure === undefined ? {} : { transportFailure }),
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}
function typedServerErrorStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
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
			errorMessage: "Provider server error",
			transportFailure: { kind: "transport", status: 503 },
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function makeExtensionRunner(handlers: string[], cwd: string, sm: SessionManager, mr: ModelRegistry): ExtensionRunner {
	const handlerMap = new Map<string, Array<() => Promise<void>>>();
	for (const h of handlers) handlerMap.set(h, [async () => {}]);
	const extension: Extension = {
		path: "test-extension",
		resolvedPath: "test-extension",
		handlers: handlerMap as Extension["handlers"],
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	return new ExtensionRunner(
		handlerMap.size === 0 ? [] : [extension],
		{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
		cwd,
		sm,
		mr,
	);
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
		authStorage.setRuntimeApiKey("alibaba-token-plan", "alibaba-token-plan-test-key");
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

	it("retries legacy usage-limit text once for a single-model session", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ throw: "usage limit exceeded" }, { content: ["Recovered"] }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("retry legacy usage-limit text");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
	});

	it("rotates a single-model stored credential after a typed quota failure before prompt completion", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");
		authStorage.removeRuntimeApiKey("openai");
		await authStorage.set("openai", [
			{ type: "api_key", key: "account-a-key" },
			{ type: "api_key", key: "account-b-key" },
		]);

		const logicalSessionId = "logical-session";
		const providerAffinitySessionId = "pool-session";
		const requestedKeys: string[] = [];
		let calls = 0;
		const agent = new Agent({
			getApiKey: async provider => {
				const key = await modelRegistry.getApiKeyForProvider(provider, providerAffinitySessionId);
				if (key) requestedKeys.push(key);
				return key;
			},
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				calls++;
				if (calls === 1) return typedRateLimitStream(requestedModel, 60_000);
				return createMockModel({ responses: [{ content: ["Recovered with another account"] }] }).stream(
					requestedModel,
					context,
					options,
				);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId: logicalSessionId,
			providerCacheSessionId: providerAffinitySessionId,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("retry with another stored credential");

		expect(calls).toBe(2);
		expect(requestedKeys).toHaveLength(2);
		expect(new Set(requestedKeys).size).toBe(2);
		expect(session.isRetrying).toBe(false);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({ delayMs: 0 });
		expect(waitSpy).toHaveBeenCalledWith(0, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(getLastAssistantMessage(session)).toMatchObject({ stopReason: "stop" });
	});

	it("rotates a single-model credential through an extension-loaded session (#3491 claim 1)", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");
		authStorage.removeRuntimeApiKey("openai");
		await authStorage.set("openai", [
			{ type: "api_key", key: "account-a-key" },
			{ type: "api_key", key: "account-b-key" },
		]);

		const poolSessionId = "pool-session";
		const requestedKeys: string[] = [];
		let calls = 0;
		const agent = new Agent({
			getApiKey: async provider => {
				const key = await modelRegistry.getApiKeyForProvider(provider, poolSessionId);
				if (key) requestedKeys.push(key);
				return key;
			},
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				calls++;
				if (calls === 1) return typedRateLimitStream(requestedModel, 60_000);
				return createMockModel({ responses: [{ content: ["Recovered"] }] }).stream(
					requestedModel,
					context,
					options,
				);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const extensionRunner = makeExtensionRunner(
			["context"],
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId: "logical-session",
			providerCacheSessionId: poolSessionId,
			extensionRunner,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = trackRetryEvents(session);

		await session.prompt("retry with another stored credential under extensions");

		expect(calls).toBe(2);
		expect(new Set(requestedKeys).size).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(getLastAssistantMessage(session)).toMatchObject({ stopReason: "stop" });
	});

	it("traverses the full credential pool independent of retry.maxRetries (#3491 claim 3)", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");
		authStorage.removeRuntimeApiKey("openai");
		await authStorage.set("openai", [
			{ type: "api_key", key: "acct-1" },
			{ type: "api_key", key: "acct-2" },
			{ type: "api_key", key: "acct-3" },
			{ type: "api_key", key: "acct-4" },
			{ type: "api_key", key: "acct-5" },
			{ type: "api_key", key: "acct-6" },
		]);

		const poolSessionId = "pool-session";
		const requestedKeys: string[] = [];
		let calls = 0;
		const agent = new Agent({
			getApiKey: async provider => {
				const key = await modelRegistry.getApiKeyForProvider(provider, poolSessionId);
				if (key) requestedKeys.push(key);
				return key;
			},
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				calls++;
				if (calls < 6) return typedUsageLimitStream(requestedModel);
				return createMockModel({ responses: [{ content: ["Recovered on 6th credential"] }] }).stream(
					requestedModel,
					context,
					options,
				);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.maxRetries": 2 });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId: "logical-session",
			providerCacheSessionId: poolSessionId,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("exhaust the pool");

		expect(calls).toBe(6);
		expect(new Set(requestedKeys).size).toBe(6);
		expect(getLastAssistantMessage(session)).toMatchObject({ stopReason: "stop" });
	});
	it("recovers a clean canonical timeout through bounded managed fallback", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const requestedModels: string[] = [];
		let primaryCalls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === primary.provider) {
					primaryCalls++;
					return canonicalFirstEventTimeoutStream(requestedModel, [], {
						kind: "transport",
						providerCode: "stream_first_event_timeout",
					});
				}
				return createMockModel({ responses: [{ content: ["Fallback recovered"] }] }).stream(
					requestedModel,
					context,
					options,
				);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 2,
			"retry.maxRetries": 9,
			"retry.baseDelayMs": 1,
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		const switches: Extract<AgentSessionEvent, { type: "model_fallback_switched" }>[] = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") switches.push(event);
		});

		await session.prompt("recover canonical timeout through fallback");
		await session.waitForIdle();

		expect(primaryCalls).toBe(2);
		expect(requestedModels).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(event => event.maxAttempts === 2 && event.unbounded === false)).toBe(true);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(switches).toEqual([
			expect.objectContaining({
				from: `${primary.provider}/${primary.id}`,
				to: `${fallback.provider}/${fallback.id}`,
				reason: "server",
				attemptsUsed: 2,
			}),
		]);
		expect(getLastAssistantMessage(session)).toMatchObject({ stopReason: "stop" });
	});

	it("bounds all-provider canonical timeout exhaustion", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return canonicalFirstEventTimeoutStream(requestedModel, [], {
					kind: "transport",
					providerCode: "stream_first_event_timeout",
				});
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.maxRetries": 9,
			"retry.baseDelayMs": 1,
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		const fallbackNotices: Extract<AgentSessionEvent, { type: "notice" }>[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "fallback") fallbackNotices.push(event);
		});

		await session.prompt("exhaust canonical timeout fallback chain");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({ maxAttempts: 1, unbounded: false });
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: false })]);
		expect(fallbackNotices).toEqual([
			expect.objectContaining({
				level: "error",
				message: expect.stringContaining("Model fallback chain exhausted"),
			}),
		]);
		expect(fallbackNotices[0]?.message).toContain(`${primary.provider}/${primary.id}`);
		expect(fallbackNotices[0]?.message).toContain(`${fallback.provider}/${fallback.id}`);
		expect(getLastAssistantMessage(session).errorMessage).toContain("Model fallback chain exhausted");
	});

	it("does not rotate a managed canonical timeout after partial output", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return canonicalFirstEventTimeoutStream(requestedModel, [{ type: "text", text: "already visible" }]);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		const { retryStartEvents } = trackRetryEvents(session);
		const switches: Extract<AgentSessionEvent, { type: "model_fallback_switched" }>[] = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") switches.push(event);
		});

		await session.prompt("do not rotate after partial timeout output");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(switches).toHaveLength(0);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "error",
			content: [{ type: "text", text: "already visible" }],
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
		});
	});
	it("advances managed fallback after an earlier tool execution and a later clean typed timeout", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const toolCall: ToolCall = { type: "toolCall", id: "prior-tool", name: "counted", arguments: {} };
		let toolRuns = 0;
		let streamCalls = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Records a real prior tool execution",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text", text: "counted" }] };
			},
		};
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [countedTool], messages: [] },
			streamFn: (requestedModel, context, options) => {
				streamCalls++;
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (streamCalls === 1) {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message: AssistantMessage = {
							role: "assistant",
							content: [toolCall],
							api: requestedModel.api,
							provider: requestedModel.provider,
							model: requestedModel.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "toolUse", message });
					});
					return stream;
				}
				if (streamCalls === 2) {
					return canonicalFirstEventTimeoutStream(requestedModel, [], {
						kind: "transport",
						providerCode: "stream_first_event_timeout",
					});
				}
				return createMockModel({ responses: [{ content: ["fallback recovered"] }] }).stream(
					requestedModel,
					context,
					options,
				);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("prior tool history, current clean managed timeout");
		await session.waitForIdle();

		expect(toolRuns).toBe(1);
		expect(requestedModels).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "fallback recovered" }],
		});
	});

	it("returns a valid managed terminal decision for a typed timeout with tool content", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return canonicalFirstEventTimeoutStream(
					requestedModel,
					[{ type: "toolCall", id: "unsafe-tool", name: "unsafe", arguments: {} }],
					{ kind: "transport", providerCode: "stream_first_event_timeout" },
				);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		const { retryStartEvents } = trackRetryEvents(session);
		const switches: Extract<AgentSessionEvent, { type: "model_fallback_switched" }>[] = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") switches.push(event);
		});

		await session.prompt("do not rotate typed timeout with tool content");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(switches).toHaveLength(0);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "error",
			content: [{ type: "toolCall", id: "unsafe-tool", name: "unsafe", arguments: {} }],
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
		});
	});

	it("does not rotate a typed managed timeout when a provider lifecycle handler is registered", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const requestedModels: string[] = [];
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = makeExtensionRunner(["context"], tempDir.path(), sessionManager, modelRegistry);
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			transformContext: (messages, _signal, scope) => extensionRunner.emitContext(messages, scope),
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return canonicalFirstEventTimeoutStream(requestedModel, [], {
					kind: "transport",
					providerCode: "stream_first_event_timeout",
				});
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
		});
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		const { retryStartEvents } = trackRetryEvents(session);
		const switches: Extract<AgentSessionEvent, { type: "model_fallback_switched" }>[] = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") switches.push(event);
		});

		await session.prompt("do not rotate typed timeout with a registered lifecycle handler");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(switches).toHaveLength(0);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "error",
			content: [],
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
		});
	});

	it("keeps wrapped terminal-provider timeouts out of managed fallback", async () => {
		const kimi = getBundledModel("kimi-code", "kimi-k2.5");
		const alibabaResponses = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const alibabaCompletions = getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
		const fallback = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!kimi || !alibabaResponses || !alibabaCompletions || !fallback) {
			throw new Error("Expected bundled terminal-provider and fallback models");
		}
		authStorage.setRuntimeApiKey("kimi-code", "kimi-test-key");
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		for (const model of [kimi, alibabaResponses, alibabaCompletions]) {
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: requestedModel => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return canonicalFirstEventTimeoutStream(
						requestedModel,
						[],
						requestedModel.provider === "alibaba-token-plan" ? { kind: "transport", status: 503 } : undefined,
					);
				},
			});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"fallback.maxAttempts": 2,
				"retry.baseDelayMs": 1,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
			session.setConfiguredModelChain(
				"default",
				[`${model.provider}/${model.id}`, `${fallback.provider}/${fallback.id}`],
				"test",
			);
			const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
			const switches: Extract<AgentSessionEvent, { type: "model_fallback_switched" }>[] = [];
			session.subscribe(event => {
				if (event.type === "model_fallback_switched") switches.push(event);
			});

			await session.prompt("do not replay wrapped terminal-provider timeout");
			await session.waitForIdle();

			expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
			expect(retryStartEvents).toHaveLength(0);
			expect(retryEndEvents).toHaveLength(0);
			expect(switches).toHaveLength(0);
			expect(waitSpy).not.toHaveBeenCalled();
			expect(session.model).toMatchObject({ provider: model.provider, id: model.id });
			expect(getLastAssistantMessage(session)).toMatchObject({
				provider: model.provider,
				api: model.api,
				stopReason: "error",
				errorMessage: "Error: Provider stream timed out while waiting for the first event",
			});
			await session.dispose();
			session = undefined;
			waitSpy.mockClear();
		}
	});

	it("does not replay a Kimi Code first-event timeout through a managed fallback chain", async () => {
		const primary = getBundledModel("kimi-code", "kimi-k2.5");
		const fallback = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary || !fallback) throw new Error("Expected bundled Kimi and Anthropic test models");
		authStorage.setRuntimeApiKey("kimi-code", "kimi-test-key");

		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const stream = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: requestedModel.api,
					provider: requestedModel.provider,
					model: requestedModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: "Provider stream timed out while waiting for the first event",
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 2 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);

		await session.prompt("slow Kimi request");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
		expect(getLastAssistantMessage(session)).toMatchObject({
			provider: "kimi-code",
			stopReason: "error",
			errorMessage: "Provider stream timed out while waiting for the first event",
		});
		expect(session.model).toMatchObject({ provider: primary.provider, id: primary.id });
	});
	it("keeps a managed fallback selection sticky across later user prompts", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ content: ["Fallback recovered"] }, { content: ["Fallback remained active"] }],
		});
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return streamCalls++ === 0
					? typedServerErrorStream(requestedModel)
					: mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);

		await session.prompt("Switch to fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`]);
		expect(session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });

		await session.prompt("Stay on selected fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
		expect(session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });
	});

	it("retains the active fallback after a late default selection failure", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ content: ["Fallback recovered"] }, { content: ["Fallback remained active"] }],
		});
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return streamCalls++ === 0
					? typedServerErrorStream(requestedModel)
					: mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);

		await session.prompt("Switch to fallback");
		await session.waitForIdle();
		expect(session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });

		vi.spyOn(sessionManager, "promoteDefaultModelSelection").mockReturnValue({
			kind: "not_promoted",
			error: new Error("late default selection failure"),
		});
		await expect(session.setDefaultModelSelection(primary, undefined)).rejects.toBeInstanceOf(
			DefaultModelSelectionRecoveryError,
		);
		expect(session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });

		await session.prompt("Remain on fallback after selection failure");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
	});

	it("surfaces an exported Alibaba timeout before managed transport fallback precedence", async () => {
		const primary = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const requestedModels: string[] = [];
		let calls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, _context, _options) => {
				calls++;
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: "Provider stream timed out while waiting for the first event",
						transportFailure: { kind: "transport", status: 503 },
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"fallback.maxAttempts": 1,
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		const switches: Extract<AgentSessionEvent, { type: "model_fallback_switched" }>[] = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") switches.push(event);
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Do not replay the exported Alibaba timeout through managed fallback");
		await session.waitForIdle();

		expect(calls).toBe(1);
		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
		expect(switches).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		expect(waitSpy).not.toHaveBeenCalled();
		expect(session.isRetrying).toBe(false);
		expect(session.isStreaming).toBe(false);
		const final = getLastAssistantMessage(session);
		expect(final).toMatchObject({
			stopReason: "error",
			provider: primary.provider,
			api: primary.api,
			model: primary.id,
			errorMessage: "Provider stream timed out while waiting for the first event",
			transportFailure: { kind: "transport", status: 503 },
		});
		expect(final.errorMessage).not.toContain("Model fallback chain exhausted");
	});

	it("keeps a managed fallback cursor sticky after an exported Alibaba timeout", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const requestedModels: string[] = [];
		let fallbackCalls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === primary.provider) {
					return typedServerErrorStream(requestedModel);
				}
				fallbackCalls++;
				if (fallbackCalls > 1) {
					return createMockModel({ responses: [{ content: ["Fallback recovered on the next turn"] }] }).stream(
						requestedModel,
						context,
						options,
					);
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: "Error: Provider stream timed out while waiting for the first event",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.baseDelayMs": 1,
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Reach the Alibaba fallback once");
		await session.waitForIdle();
		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`]);
		expect(getLastAssistantMessage(session)).toMatchObject({
			provider: fallback.provider,
			stopReason: "error",
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
		});

		await session.prompt("Keep the sticky fallback on the next turn");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
		expect(session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });
		expect(getLastAssistantMessage(session)).toMatchObject({ stopReason: "stop" });
	});

	it("treats legacy usage-limit text without transport facts as terminal for a managed chain", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return createMockModel({ responses: [{ throw: "usage limit exceeded" }] }).stream(
					requestedModel,
					context,
					options,
				);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("do not infer managed usage-limit fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
	});

	it("invalidates an auth-failed managed credential before its next outer attempt", async () => {
		// #3724 added a pin guard that refuses to rotate credentials set via
		// setRuntimeApiKey (—api-key/—credential). The shared beforeEach installs
		// runtime keys for every provider as test plumbing, which silently tripped
		// that guard and blocked invalidation on the auth path. Use a stored
		// credential instead, matching the other rotation tests in this suite.
		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [{ type: "api_key", key: "anthropic-test-key" }]);
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		let calls = 0;
		const invalidation = vi.spyOn(authStorage, "invalidateCredentialMatching");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				calls++;
				if (calls === 2) {
					expect(invalidation).toHaveBeenCalledWith(
						"anthropic",
						"anthropic-test-key",
						expect.objectContaining({ sessionId: expect.any(String) }),
					);
					return createMockModel({ responses: [{ content: ["Recovered"] }] }).stream(
						requestedModel,
						context,
						options,
					);
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: "provider returned error",
						errorStatus: 401,
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Trigger auth fallback");
		await session.waitForIdle();

		expect(calls).toBe(2);
		expect(invalidation).toHaveBeenCalledTimes(1);
	});

	it("uses managed fallback accounting for an idle yield under a configured chain", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const streamOptions: Array<{ fallbackManaged?: boolean; fallbackAttempt?: unknown }> = [];
		const mock = createMockModel({ responses: [{ content: ["Idle yield delivered"] }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				streamOptions.push({
					fallbackManaged: options?.fallbackManaged,
					fallbackAttempt: options?.fallbackAttempt,
				});
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		session.yieldQueue.register<string>("test", {
			build: entries => ({ role: "user", content: entries.join("\n"), timestamp: Date.now() }),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		session.yieldQueue.enqueue("test", "Idle yield");
		await session.waitForIdle();

		expect(streamOptions).toHaveLength(1);
		expect(streamOptions[0]).toMatchObject({
			fallbackManaged: true,
			fallbackAttempt: { attemptId: expect.any(String) },
		});
	});

	it("keeps an idle yield non-managed for a one-entry chain", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");

		const streamOptions: Array<{ fallbackManaged?: boolean; fallbackAttempt?: unknown }> = [];
		const mock = createMockModel({ responses: [{ content: ["Idle yield delivered"] }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				streamOptions.push({
					fallbackManaged: options?.fallbackManaged,
					fallbackAttempt: options?.fallbackAttempt,
				});
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain("default", [`${primary.provider}/${primary.id}`], "test");
		session.yieldQueue.register<string>("test", {
			build: entries => ({ role: "user", content: entries.join("\n"), timestamp: Date.now() }),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		session.yieldQueue.enqueue("test", "Idle yield");
		await session.waitForIdle();

		expect(streamOptions).toEqual([{ fallbackManaged: undefined, fallbackAttempt: undefined }]);
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
