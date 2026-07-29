import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { type AssistantMessage, getBundledModel, type Model, stream as streamModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

type StreamCall = {
	selector: string;
	fallbackManaged: boolean | undefined;
	fallbackAttempt: unknown;
};

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function rateLimitStream(model: Model): AssistantMessageEventStream {
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
			errorMessage: "rate limit exceeded",
			errorStatus: 429,
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function typedRateLimitStream(
	model: Model,
	retryAfterMs: number,
	errorMessage = "rate limit exceeded",
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & {
			transportFailure: { kind: "transport"; status: number; headers: Record<string, string> };
		} = {
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
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 429, headers: { "retry-after-ms": String(retryAfterMs) } },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function typedOpaqueOverflowStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & {
			transportFailure: { kind: "transport"; status: number; openaiErrorCode: string };
		} = {
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
			errorMessage: "",
			errorStatus: 400,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 400, openaiErrorCode: "context_length_exceeded" },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function alibabaFirstEventTimeoutStream(model: Model, release: Promise<void>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	void release.then(() => {
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
			errorMessage: "Provider stream timed out while waiting for the first event",
			errorStatus: 503,
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}
function successfulStream(model: Model, content = "Recovered"): AssistantMessageEventStream {
	return createMockModel({ responses: [{ content: [content] }] }).stream(model, {
		systemPrompt: [],
		messages: [],
		tools: [],
	});
}

describe("AgentSession fallback upstream request counts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@fallback-upstream-count-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		authStorage.setRuntimeApiKey("alibaba-token-plan", "alibaba-token-plan-test-key");
		modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(
		maxAttempts: number,
		streamFn: AgentOptions["streamFn"],
		modelsOrSettings: { primary: Model; fallback: Model } | Record<string, unknown> = {},
	): { primary: Model; fallback: Model } {
		const models =
			"primary" in modelsOrSettings && "fallback" in modelsOrSettings
				? (modelsOrSettings as { primary: Model; fallback: Model })
				: undefined;
		const settingsOverrides = models ? {} : modelsOrSettings;
		const primary = models?.primary ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = models?.fallback ?? getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": maxAttempts,
			"retry.baseDelayMs": 10,
			...settingsOverrides,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session!.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");
		return { primary, fallback };
	}

	it("does not replay exported Alibaba lazy-stream timeouts for direct or managed-fallback requests", async () => {
		// The first-event timeout message is per-API, not generic: #3046 unified the
		// slow-provider timeout policy but gave each transport its own wording
		// (openai-responses vs openai-completions). Pinning one literal silently
		// asserted the pre-#3046 generic string, so derive it from the model's api.
		const firstEventTimeoutMessage = (api: string): string =>
			api === "openai-responses"
				? "OpenAI responses stream timed out while waiting for the first event"
				: "OpenAI completions stream timed out while waiting for the first event";
		const originalTimeout = Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "5";
		try {
			const responsesModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
			const completionsModel = getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
			const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!responsesModel || !completionsModel || !primary) throw new Error("Expected bundled test models");

			for (const model of [responsesModel, completionsModel]) {
				const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
					(async () =>
						new Response(
							new ReadableStream<Uint8Array>({
								start() {},
							}),
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						)) as unknown as typeof fetch,
				);
				const directAgent = new Agent({
					getApiKey: provider => `${provider}-test-key`,
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn: streamModel,
				});
				const directSettings = Settings.isolated({
					"compaction.enabled": false,
					"retry.baseDelayMs": 1,
					"retry.maxRetries": 10,
				});
				directSettings.setModelRole("default", selector(model));
				session = new AgentSession({
					agent: directAgent,
					sessionManager: SessionManager.inMemory(),
					settings: directSettings,
					modelRegistry,
				});

				await session.prompt(`Direct exported timeout for ${model.api}`);
				await session.waitForIdle();

				expect(fetchSpy).toHaveBeenCalledTimes(1);
				expect(session.messages.at(-1)).toMatchObject({
					role: "assistant",
					provider: model.provider,
					api: model.api,
					stopReason: "error",
					errorMessage: firstEventTimeoutMessage(model.api),
				});
				await session.dispose();
				session = undefined;
				fetchSpy.mockRestore();
			}

			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
				(async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start() {},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					)) as unknown as typeof fetch,
			);
			const fallback = responsesModel;
			const managedAgent = new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) =>
					model.provider === primary.provider ? rateLimitStream(model) : streamModel(model, context, options),
			});
			const managedSettings = Settings.isolated({ "compaction.enabled": false, "fallback.maxAttempts": 1 });
			managedSettings.setModelRole("default", selector(primary));
			session = new AgentSession({
				agent: managedAgent,
				sessionManager: SessionManager.inMemory(),
				settings: managedSettings,
				modelRegistry,
			});
			session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");

			await session.prompt("Reach one exported Alibaba fallback request");
			await session.waitForIdle();

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				provider: fallback.provider,
				stopReason: "error",
				errorMessage: firstEventTimeoutMessage(fallback.api),
			});
		} finally {
			if (originalTimeout === undefined) delete Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
			else Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = originalTimeout;
		}
	});

	function createPlainSession(
		streamFn: AgentOptions["streamFn"],
		settingsOverrides: Record<string, unknown> = {},
	): Model {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 10,
			...settingsOverrides,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain("default", [selector(primary)], "test");
		return primary;
	}

	function seedCompactableHistory(primary: Model): void {
		for (let index = 0; index < 4; index++) {
			const user = {
				role: "user" as const,
				content: `seed request ${index} `.repeat(40),
				timestamp: Date.now() + index * 2,
			};
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `seed response ${index} `.repeat(40) }],
				api: primary.api,
				provider: primary.provider,
				model: primary.id,
				usage: {
					input: 20_000,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20_200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now() + index * 2 + 1,
			};
			session!.agent.appendMessage(user);
			session!.sessionManager.appendMessage(user);
			session!.agent.appendMessage(assistant);
			session!.sessionManager.appendMessage(assistant);
		}
	}

	it("N=1 sends one managed request to each chain entry without a hidden replay", async () => {
		const calls: StreamCall[] = [];
		const { primary, fallback } = createSession(1, (model, _context, options) => {
			calls.push({
				selector: selector(model),
				fallbackManaged: options?.fallbackManaged,
				fallbackAttempt: options?.fallbackAttempt,
			});
			return selector(model) === selector(primary) ? rateLimitStream(model) : successfulStream(model);
		});

		await session!.prompt("Exercise managed fallback");
		await session!.waitForIdle();

		expect(calls.map(call => call.selector)).toEqual([selector(primary), selector(fallback)]);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toMatchObject({ fallbackManaged: true, fallbackAttempt: { attemptId: expect.any(String) } });
		}
	});

	it("keeps an opaque typed overflow budget-neutral before one rate limit advances N=1", async () => {
		const calls: StreamCall[] = [];
		const fallbackSwitches: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> = [];
		const events: AgentSessionEvent[] = [];
		let primaryCalls = 0;
		const { primary, fallback } = createSession(1, (model, context, options) => {
			calls.push({
				selector: selector(model),
				fallbackManaged: options?.fallbackManaged,
				fallbackAttempt: options?.fallbackAttempt,
			});
			if (selector(model) === selector(primary)) {
				primaryCalls += 1;
				return primaryCalls === 1 ? typedOpaqueOverflowStream(model) : typedRateLimitStream(model, 50);
			}
			return createMockModel({ responses: [{ content: ["Recovered after rate limit"] }] }).stream(
				model,
				context,
				options,
			);
		});
		const suppressSpy = vi.spyOn(modelRegistry, "suppressSelector");
		session!.subscribe(event => {
			events.push(event);
			if (event.type === "model_fallback_switched") fallbackSwitches.push(event);
		});

		await session!.prompt("Recover through managed overflow maintenance");
		await session!.waitForIdle();

		expect(calls.map(call => call.selector)).toEqual([selector(primary), selector(primary), selector(fallback)]);
		expect(calls.map(call => call.fallbackManaged)).toEqual([true, true, true]);
		const attemptIds = calls.map(call => (call.fallbackAttempt as { attemptId: string }).attemptId);
		expect(new Set(attemptIds).size).toBe(3);
		expect(suppressSpy).toHaveBeenCalledTimes(1);
		expect(suppressSpy).toHaveBeenCalledWith(selector(primary), expect.any(Number));
		expect(fallbackSwitches).toEqual([
			expect.objectContaining({
				from: selector(primary),
				to: selector(fallback),
				reason: "rate_limit",
				attemptsUsed: 1,
			}),
		]);
		const assistantLifecycle = events.filter(
			event =>
				(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
				"message" in event &&
				event.message.role === "assistant",
		);
		expect(assistantLifecycle.filter(event => event.type === "message_start")).toHaveLength(1);
		expect(assistantLifecycle.filter(event => event.type === "message_end")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end")).toEqual([
			expect.objectContaining({ stopReason: "completed" }),
		]);
		expect(session!.messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(session!.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});

	it("advances typed 429 with hostile overflow prose without running maintenance", async () => {
		const calls: string[] = [];
		const events: AgentSessionEvent[] = [];
		const { primary, fallback } = createSession(1, (model, context, options) => {
			calls.push(selector(model));
			return selector(model) === selector(primary)
				? typedRateLimitStream(model, 50, "context_length_exceeded: context window exceeded")
				: createMockModel({ responses: [{ content: ["Recovered after typed rate limit"] }] }).stream(
						model,
						context,
						options,
					);
		});
		session!.subscribe(event => events.push(event));

		await session!.prompt("Advance despite hostile overflow prose");
		await session!.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(fallback)]);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "model_fallback_switched", reason: "rate_limit", attemptsUsed: 1 }),
		);
	});

	it("terminalizes overflow maintenance when compaction would be a no-op", async () => {
		const calls: string[] = [];
		const events: AgentSessionEvent[] = [];
		let managedOwnerAtTerminalEvent: number | undefined;
		const { primary, fallback } = createSession(
			1,
			model => {
				calls.push(selector(model));
				return typedOpaqueOverflowStream(model);
			},
			{
				"compaction.enabled": true,
				"compaction.keepRecentTokens": 1,
			},
		);
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		session!.subscribe(event => {
			events.push(event);
			if (
				event.type === "auto_compaction_end" &&
				event.skipped &&
				!event.willRetry &&
				event.errorMessage?.includes("nothing eligible to compact")
			) {
				managedOwnerAtTerminalEvent = session!.agent.currentManagedLogicalRunId;
			}
		});

		await session!.prompt("Stop after bounded overflow maintenance");
		await session!.waitForIdle();

		expect(prepareSpy).toHaveBeenCalled();
		expect(calls).toEqual([selector(primary)]);
		expect(calls).not.toContain(selector(fallback));
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "auto_compaction_end",
				action: "context-full",
				aborted: false,
				skipped: true,
				willRetry: false,
				errorMessage: expect.stringContaining("nothing eligible to compact"),
			}),
		);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(managedOwnerAtTerminalEvent).toBeUndefined();
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorStatus: 400,
		});
		expect(
			session!.messages.filter(message => message.role === "assistant" && message.stopReason === "error"),
		).toHaveLength(1);
	});

	it("resumes a successor queued while managed no-op maintenance is starting", async () => {
		const calls: string[] = [];
		const events: AgentSessionEvent[] = [];
		let requestCount = 0;
		let queuedPrompt: Promise<void> | undefined;
		const successorTerminal = Promise.withResolvers<void>();
		const { primary } = createSession(
			1,
			model => {
				calls.push(selector(model));
				requestCount += 1;
				return requestCount === 1
					? typedOpaqueOverflowStream(model)
					: successfulStream(model, "Queued successor completed");
			},
			{
				"compaction.enabled": true,
				"compaction.keepRecentTokens": 1,
			},
		);
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		session!.subscribe(event => {
			events.push(event);
			if (
				event.type === "agent_end" &&
				event.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(
							content => content.type === "text" && content.text === "Queued successor completed",
						),
				)
			) {
				successorTerminal.resolve();
			}
			if (
				!queuedPrompt &&
				event.type === "auto_compaction_start" &&
				event.reason === "overflow" &&
				event.action === "context-full"
			) {
				queuedPrompt = session!.prompt("Run after terminal overflow", {
					skipCompactionCheck: true,
					streamingBehavior: "steer",
				});
			}
		});

		await session!.prompt("Terminal overflow before queued successor");
		expect(queuedPrompt).toBeDefined();
		await queuedPrompt;
		await Promise.race([
			successorTerminal.promise,
			Bun.sleep(1_000).then(() => {
				throw new Error(
					`Queued successor did not reach terminal lifecycle: calls=${JSON.stringify(calls)}, events=${JSON.stringify(
						events.map(event => event.type),
					)}, owner=${String(session!.agent.currentManagedLogicalRunId)}`,
				);
			}),
		]);
		await session!.waitForIdle();

		expect(prepareSpy).toHaveBeenCalled();
		expect(calls).toEqual([selector(primary), selector(primary)]);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Queued successor completed" }],
			stopReason: "stop",
		});
	});

	it("preserves the terminal overflow assistant after plain no-op maintenance", async () => {
		const calls: StreamCall[] = [];
		const events: AgentSessionEvent[] = [];
		const primary = createPlainSession(
			(model, _context, options) => {
				calls.push({
					selector: selector(model),
					fallbackManaged: options?.fallbackManaged,
					fallbackAttempt: options?.fallbackAttempt,
				});
				return typedOpaqueOverflowStream(model);
			},
			{
				"compaction.enabled": true,
				"compaction.keepRecentTokens": 1,
			},
		);
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		session!.subscribe(event => events.push(event));

		await session!.prompt("Preserve the terminal plain overflow");
		await session!.waitForIdle();

		expect(prepareSpy).toHaveBeenCalled();
		expect(calls).toEqual([{ selector: selector(primary), fallbackManaged: undefined, fallbackAttempt: undefined }]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "auto_compaction_end",
				action: "context-full",
				aborted: false,
				skipped: true,
				willRetry: false,
				errorMessage: expect.stringContaining("nothing eligible to compact"),
			}),
		);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorStatus: 400,
		});
		expect(
			session!.sessionManager
				.getBranch()
				.filter(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toHaveLength(1);
	});

	it("settles plain overflow before terminal observers mutate live state", async () => {
		const calls: StreamCall[] = [];
		const primary = createPlainSession(
			(model, _context, options) => {
				calls.push({
					selector: selector(model),
					fallbackManaged: options?.fallbackManaged,
					fallbackAttempt: options?.fallbackAttempt,
				});
				return typedOpaqueOverflowStream(model);
			},
			{
				"compaction.enabled": true,
				"compaction.keepRecentTokens": 1,
			},
		);
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		let resetAtTerminalEvent = false;
		session!.subscribe(event => {
			if (
				event.type === "auto_compaction_end" &&
				event.skipped &&
				!event.willRetry &&
				event.errorMessage?.includes("nothing eligible to compact")
			) {
				resetAtTerminalEvent = true;
				session!.agent.reset();
			}
		});

		await session!.prompt("Clear while observing terminal plain overflow");
		await session!.waitForIdle();

		expect(prepareSpy).toHaveBeenCalled();
		expect(calls).toEqual([{ selector: selector(primary), fallbackManaged: undefined, fallbackAttempt: undefined }]);
		expect(resetAtTerminalEvent).toBeTrue();
		expect(session!.messages).toEqual([]);
		expect(
			session!.sessionManager
				.getBranch()
				.filter(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toHaveLength(1);
	});

	it("preserves successful overflow compaction and retry on the same model", async () => {
		const calls: string[] = [];
		const events: AgentSessionEvent[] = [];
		let primaryCalls = 0;
		const { primary, fallback } = createSession(
			1,
			model => {
				calls.push(selector(model));
				if (selector(model) !== selector(primary)) return successfulStream(model);
				primaryCalls += 1;
				return primaryCalls === 1
					? typedOpaqueOverflowStream(model)
					: successfulStream(model, "Recovered after compaction");
			},
			{
				"compaction.enabled": true,
				"compaction.keepRecentTokens": 1,
			},
		);
		seedCompactableHistory(primary);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "Compacted summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
			preserveData: undefined,
		}));
		session!.subscribe(event => events.push(event));

		await session!.prompt("Recover after real overflow compaction");
		await session!.waitForIdle();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([selector(primary), selector(primary)]);
		expect(calls).not.toContain(selector(fallback));
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "auto_compaction_end",
				action: "context-full",
				aborted: false,
				willRetry: true,
				result: expect.objectContaining({ summary: "Compacted summary" }),
			}),
		);
		expect(events.filter(event => event.type === "agent_end")).toEqual([
			expect.objectContaining({ stopReason: "completed" }),
		]);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Recovered after compaction" }],
		});
		expect(
			session!.messages.filter(message => message.role === "assistant" && message.stopReason === "error"),
		).toHaveLength(0);
	});
	it("preserves a prior fallback charge across overflow maintenance", async () => {
		const calls: string[] = [];
		const fallbackSwitches: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> = [];
		let primaryCalls = 0;
		const { primary, fallback } = createSession(2, (model, context, options) => {
			calls.push(selector(model));
			if (selector(model) === selector(primary)) {
				primaryCalls += 1;
				if (primaryCalls === 2) return typedOpaqueOverflowStream(model);
				return rateLimitStream(model);
			}
			return createMockModel({ responses: [{ content: ["Recovered with preserved budget"] }] }).stream(
				model,
				context,
				options,
			);
		});
		session!.subscribe(event => {
			if (event.type === "model_fallback_switched") fallbackSwitches.push(event);
		});

		await session!.prompt("Keep the first policy charge across overflow");
		await session!.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(primary), selector(primary), selector(fallback)]);
		expect(fallbackSwitches).toEqual([
			expect.objectContaining({
				reason: "rate_limit",
				attemptsUsed: 2,
				from: selector(primary),
				to: selector(fallback),
			}),
		]);
	});
	for (const delivery of ["steer", "followUp"] as const) {
		it(`resets predecessor accounting only when an accepted queued ${delivery} successor starts`, async () => {
			const primary = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
			const fallback = getBundledModel("openai", "gpt-4o-mini");
			if (!primary || !fallback) throw new Error("Expected bundled test models");
			const calls: string[] = [];
			const timeoutStarted = Promise.withResolvers<void>();
			const releaseTimeout = Promise.withResolvers<void>();
			let primaryCalls = 0;
			createSession(
				1,
				(model, _context, _options) => {
					calls.push(selector(model));
					if (selector(model) !== selector(primary)) {
						return successfulStream(model, `Recovered queued ${delivery} successor`);
					}
					primaryCalls += 1;
					if (primaryCalls === 1 || primaryCalls === 3) return typedOpaqueOverflowStream(model);
					if (primaryCalls === 2) {
						timeoutStarted.resolve();
						return alibabaFirstEventTimeoutStream(model, releaseTimeout.promise);
					}
					return typedRateLimitStream(model, 50);
				},
				{ primary, fallback },
			);
			const events: AgentSessionEvent[] = [];
			const successorQueued = Promise.withResolvers<void>();
			let queuedSuccessor = false;
			session!.subscribe(event => {
				events.push(event);
				if (event.type !== "agent_end" || queuedSuccessor) return;
				queuedSuccessor = true;
				queueMicrotask(() => {
					void session![delivery](`Queued ${delivery} successor`).then(
						() => successorQueued.resolve(),
						error => successorQueued.reject(error),
					);
				});
			});

			const predecessor = session!.prompt("Charge overflow before exact Alibaba timeout");
			await timeoutStarted.promise;
			releaseTimeout.resolve();
			await successorQueued.promise;
			await predecessor;
			await session!.waitForIdle();

			expect(calls).toEqual([
				selector(primary),
				selector(primary),
				selector(primary),
				selector(primary),
				selector(fallback),
			]);
			expect(events.filter(event => event.type === "agent_end")).toHaveLength(2);
			expect(session!.messages).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					provider: primary.provider,
					api: primary.api,
					stopReason: "error",
					errorMessage: "Provider stream timed out while waiting for the first event",
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "model_fallback_switched",
					from: selector(primary),
					to: selector(fallback),
					reason: "rate_limit",
					attemptsUsed: 1,
				}),
			);
			expect(session!.agent.hasQueuedMessages()).toBe(false);
			expect(session!.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		});
	}
	it("keeps sticky Alibaba fallback cursor when a queued successor starts after terminal timeout", async () => {
		const primary = getBundledModel("openai", "gpt-4o-mini");
		const fallback = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const calls: string[] = [];
		const timeoutStarted = Promise.withResolvers<void>();
		const releaseTimeout = Promise.withResolvers<void>();
		let fallbackCalls = 0;
		createSession(
			1,
			(model, _context, _options) => {
				calls.push(selector(model));
				if (selector(model) === selector(primary)) {
					return typedRateLimitStream(model, 50);
				}
				fallbackCalls += 1;
				if (fallbackCalls === 1) {
					timeoutStarted.resolve();
					return alibabaFirstEventTimeoutStream(model, releaseTimeout.promise);
				}
				if (fallbackCalls === 2) return typedOpaqueOverflowStream(model);
				if (fallbackCalls === 3) return typedRateLimitStream(model, 50);
				return successfulStream(model, "Recovered sticky Alibaba successor");
			},
			{ primary, fallback },
		);
		const events: AgentSessionEvent[] = [];
		const successorQueued = Promise.withResolvers<void>();
		let queuedSuccessor = false;
		session!.subscribe(event => {
			events.push(event);
			if (event.type !== "agent_end" || queuedSuccessor) return;
			queuedSuccessor = true;
			queueMicrotask(() => {
				void session!.followUp("Queued successor after sticky Alibaba timeout").then(
					() => successorQueued.resolve(),
					error => successorQueued.reject(error),
				);
			});
		});

		const predecessor = session!.prompt("Reach sticky Alibaba then terminalize");
		await timeoutStarted.promise;
		releaseTimeout.resolve();
		await successorQueued.promise;
		await predecessor;
		await session!.waitForIdle();

		// primary rate-limit -> sticky Alibaba timeout (terminal) -> successor overflow -> Alibaba rate-limit -> next fallback or success path
		expect(calls[0]).toBe(selector(primary));
		expect(calls.filter(call => call === selector(fallback)).length).toBeGreaterThanOrEqual(2);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "model_fallback_switched",
				from: selector(primary),
				to: selector(fallback),
			}),
		);
		expect(session!.messages).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				provider: fallback.provider,
				stopReason: "error",
				errorMessage: "Provider stream timed out while waiting for the first event",
			}),
		);
		// Successor continued on sticky Alibaba (second/third fallback calls) rather than resetting to primary.
		expect(calls.slice(1, 3).every(call => call === selector(fallback))).toBe(true);
		expect(session!.agent.hasQueuedMessages()).toBe(false);
	});
	it("N=3 performs exactly three upstream attempts before switching and reports attemptsUsed", async () => {
		const calls: StreamCall[] = [];
		const fallbackSwitches: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> = [];
		const { primary, fallback } = createSession(3, (model, _context, options) => {
			calls.push({
				selector: selector(model),
				fallbackManaged: options?.fallbackManaged,
				fallbackAttempt: options?.fallbackAttempt,
			});
			return selector(model) === selector(primary) ? rateLimitStream(model) : successfulStream(model);
		});
		session!.subscribe(event => {
			if (event.type === "model_fallback_switched") fallbackSwitches.push(event);
		});

		await session!.prompt("Exercise three managed attempts");
		await session!.waitForIdle();

		expect(calls.map(call => call.selector)).toEqual([
			selector(primary),
			selector(primary),
			selector(primary),
			selector(fallback),
		]);
		expect(calls.filter(call => call.selector === selector(primary))).toHaveLength(3);
		expect(calls.filter(call => call.selector === selector(fallback))).toHaveLength(1);
		expect(fallbackSwitches).toHaveLength(1);
		expect(fallbackSwitches).toEqual([
			expect.objectContaining({
				type: "model_fallback_switched",
				eventId: expect.any(String),
				from: selector(primary),
				to: selector(fallback),
				reason: "rate_limit",
				role: "default",
				scope: "session",
				activeIndex: 1,
				chainLength: 2,
				attemptsUsed: 3,
			}),
		]);
	});

	it("suppresses the rate-limited head and returns to it when the cooldown expires", async () => {
		const calls: string[] = [];
		let primaryAttempts = 0;
		const { primary, fallback } = createSession(1, (model, _context, _options) => {
			calls.push(selector(model));
			if (selector(model) === selector(primary) && primaryAttempts++ === 0) {
				return typedRateLimitStream(model, 1);
			}
			return successfulStream(model, "Recovered");
		});
		const suppressSpy = vi.spyOn(modelRegistry, "suppressSelector");

		await session!.prompt("Switch after a rate limit");
		await session!.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(fallback)]);
		expect(suppressSpy).toHaveBeenCalledWith(selector(primary), expect.any(Number));
		expect(modelRegistry.getSelectorSuppressionStatus(selector(fallback))).toBe("none");
		await Bun.sleep(5);

		await session!.prompt("Return after cooldown expiry");
		await session!.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(fallback), selector(primary)]);
		expect(session!.model).toMatchObject({ provider: primary.provider, id: primary.id });
	});

	it("emits one switch when an exhausted chain restarts with an unavailable head", async () => {
		const events: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> = [];
		let headUnavailable = false;
		let streamAttempts = 0;
		const { primary, fallback } = createSession(1, (_model, _context, _options) => {
			streamAttempts += 1;
			return streamAttempts <= 2 ? rateLimitStream(_model) : successfulStream(_model, "Recovered next turn");
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async requested =>
			selector(requested) === selector(primary) && headUnavailable ? undefined : "test-key",
		);
		session!.subscribe(event => {
			if (event.type === "model_fallback_switched") events.push(event);
		});

		await session!.prompt("Exhaust every fallback");
		await session!.waitForIdle();
		expect(events).toHaveLength(1);
		events.length = 0;
		headUnavailable = true;

		await session!.prompt("Start a new turn");
		await session!.waitForIdle();

		expect(events).toEqual([
			expect.objectContaining({
				from: selector(primary),
				to: selector(fallback),
				reason: "new_turn",
			}),
		]);
	});

	it("uses one managed, tokenized upstream request for a scheduled continuation", async () => {
		const calls: StreamCall[] = [];
		const { primary } = createSession(1, (model, _context, options) => {
			calls.push({
				selector: selector(model),
				fallbackManaged: options?.fallbackManaged,
				fallbackAttempt: options?.fallbackAttempt,
			});
			return successfulStream(model, "Scheduled continuation delivered");
		});
		session!.yieldQueue.register<string>("test", {
			build: entries => ({ role: "user", content: entries.join("\n"), timestamp: Date.now() }),
		});

		session!.yieldQueue.enqueue("test", "Continue");
		await session!.waitForIdle();

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			selector: selector(primary),
			fallbackManaged: true,
			fallbackAttempt: { attemptId: expect.any(String) },
		});
	});

	it("propagates managed options and attempt tokens to the controlled pi-native stream boundary", async () => {
		const calls: StreamCall[] = [];
		const { primary } = createSession(1, (model, _context, options) => {
			calls.push({
				selector: selector(model),
				fallbackManaged: options?.fallbackManaged,
				fallbackAttempt: options?.fallbackAttempt,
			});
			return successfulStream(model, "Pi-native boundary delivered");
		});

		await session!.prompt("Exercise pi-native stream boundary");
		await session!.waitForIdle();

		// The coding-agent suite owns this boundary assertion. Real gateway upstream
		// request counts are exercised by packages/ai/test/auth-gateway-pi-native.test.ts.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			selector: selector(primary),
			fallbackManaged: true,
			fallbackAttempt: { attemptId: expect.any(String) },
		});
	});

	it("resets the active entry budget after accepted tool rounds", async () => {
		const calls: string[] = [];
		const { primary, fallback } = createSession(3, (model, context, options) => {
			calls.push(selector(model));
			if (calls.length <= 2) {
				return createMockModel({
					responses: [{ content: [{ type: "toolCall", name: "read", arguments: { round: calls.length } }] }],
				}).stream(model, context, options);
			}
			return selector(model) === selector(primary)
				? rateLimitStream(model)
				: successfulStream(model, "Recovered after tools");
		});
		session!.agent.state.tools = [
			{
				name: "read",
				description: "Read a fixture",
				parameters: { type: "object", properties: { round: { type: "number" } } },
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			},
		] as never;

		await session!.prompt("Use two tools before the provider fails");
		await session!.waitForIdle();

		expect(calls).toEqual([
			selector(primary),
			selector(primary),
			selector(primary),
			selector(primary),
			selector(primary),
			selector(fallback),
		]);
	});

	it("keeps a one-entry chain non-managed and token-free", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");
		const calls: StreamCall[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, _context, options) => {
				calls.push({
					selector: selector(model),
					fallbackManaged: options?.fallbackManaged,
					fallbackAttempt: options?.fallbackAttempt,
				});
				return successfulStream(model, "Legacy path delivered");
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session!.setConfiguredModelChain("default", [selector(primary)], "test");

		await session!.prompt("Exercise legacy path");
		await session!.waitForIdle();

		expect(calls).toEqual([{ selector: selector(primary), fallbackManaged: undefined, fallbackAttempt: undefined }]);
	});
});
