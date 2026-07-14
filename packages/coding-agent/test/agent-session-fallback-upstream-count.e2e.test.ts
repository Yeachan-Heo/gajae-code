import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
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

function successfulStream(model: Model, content = "Recovered"): AssistantMessageEventStream {
	return createMockModel({ responses: [{ content: [content] }] }).stream(model, {
		systemPrompt: [],
		messages: [],
		tools: [],
	});
}

describe("AgentSession managed fallback upstream request counts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@fallback-upstream-count-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
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
	): { primary: Model; fallback: Model } {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
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
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session!.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");
		return { primary, fallback };
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
