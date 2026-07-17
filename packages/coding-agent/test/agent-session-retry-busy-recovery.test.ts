import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type ToolCall } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

/**
 * Regression: a retryable provider error schedules an auto-retry `continue()`
 * outside the agent_end callback chain. If that scheduled continue cannot start
 * — it throws (e.g. AgentBusyError from a concurrent turn, or "Cannot continue
 * ...") — the agent_end that normally resolves the internal retry promise never
 * arrives. Before the fix, #waitForPostPromptRecovery awaited that promise
 * forever, the owning prompt's in-flight counter was never released, and the
 * session reported `isStreaming === true` permanently. Every subsequent
 * `prompt()` then threw `AgentBusyError`, producing the reported infinite loop.
 */
describe("AgentSession auto-retry busy recovery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-busy-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	it("does not wedge the session busy when the scheduled retry continue throws", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ content: ["recovered on the next prompt"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		// Inject the failure: the first scheduled retry continue cannot start
		// (mirrors the AgentBusyError race / "Cannot continue ..." edge cases).
		const origContinue = agent.continue.bind(agent);
		let continueFailed = false;
		(agent as unknown as { continue: () => Promise<void> }).continue = async () => {
			if (!continueFailed) {
				continueFailed = true;
				throw new AgentBusyError();
			}
			return origContinue();
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		// The owning prompt must settle instead of hanging on the dead retry promise.
		await session.prompt("first message");
		await session.waitForIdle();

		expect(continueFailed).toBe(true);
		expect(session.isStreaming).toBe(false);
		expect(session.isRetrying).toBe(false);
		// The aborted retry is reported as a failure so the UI can clean up.
		expect(retryEndEvents.at(-1)).toMatchObject({ success: false });

		// The actual user-visible symptom: subsequent prompts must work, not throw
		// AgentBusyError forever.
		await session.prompt("second message");
		expect(session.isStreaming).toBe(false);
	});

	it("recovers a later retryable error normally after a prior retry was abandoned", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		// turn 1 (first prompt): retryable error -> scheduled retry continue throws -> abandoned.
		// turn 2 (second prompt): retryable error -> scheduled retry continue runs -> recovers.
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ throw: "overloaded_error: provider returned error retry-after-ms=5" },
				{ content: ["recovered via auto-retry on the second turn"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		// Only the FIRST scheduled continue fails; later auto-retry continues run normally.
		const origContinue = agent.continue.bind(agent);
		let failures = 0;
		(agent as unknown as { continue: () => Promise<void> }).continue = async () => {
			if (failures === 0) {
				failures += 1;
				throw new AgentBusyError();
			}
			return origContinue();
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("first message");
		await session.waitForIdle();
		expect(session.isStreaming).toBe(false);
		expect(session.isRetrying).toBe(false);

		// A fresh prompt whose first turn errors retryably must auto-retry and recover,
		// proving the abandoned retry did not poison the retry machinery.
		await session.prompt("second message");
		await session.waitForIdle();
		expect(session.isStreaming).toBe(false);
		expect(session.isRetrying).toBe(false);
		const last = session.agent.state.messages.at(-1) as AssistantMessage | undefined;
		expect(last?.role).toBe("assistant");
		expect(last?.stopReason).toBe("stop");
	});

	it("survives a consumer that re-prompts repeatedly after a failed retry continuation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ content: ["ok-2"] },
				{ content: ["ok-3"] },
				{ content: ["ok-4"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const origContinue = agent.continue.bind(agent);
		let continueFailed = false;
		(agent as unknown as { continue: () => Promise<void> }).continue = async () => {
			if (!continueFailed) {
				continueFailed = true;
				throw new AgentBusyError();
			}
			return origContinue();
		};
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const busyErrors: string[] = [];
		const tryPrompt = async (text: string) => {
			await session!.prompt(text).catch((err: Error) => {
				if (err instanceof AgentBusyError) busyErrors.push(err.message);
			});
			await session!.waitForIdle();
		};

		await tryPrompt("first message");
		// Simulate the reported looping consumer: fire several sequential prompts.
		for (let i = 0; i < 3; i++) {
			await tryPrompt(`follow-up ${i}`);
		}

		expect(continueFailed).toBe(true);
		expect(busyErrors).toEqual([]);
		expect(session.isStreaming).toBe(false);
	});

	it("does not wedge when an auto-retry recovers on a turn ending with a successful yield", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		// First turn errors retryably -> auto-retry schedules a continuation.
		const mock = createMockModel({
			responses: [{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" }],
			handler: { content: ["second prompt ok"] },
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		// The scheduled retry continuation recovers on a turn that ends by calling the
		// `yield` tool successfully. We drive that turn via emitExternalEvent (the same
		// technique the handoff suite uses) because the agent loop has no real yield tool
		// here. The agent_end handler early-returns at #assistantEndedWithSuccessfulYield,
		// so the retry must be settled at message_end, not at the agent_end tail.
		const yieldCall: ToolCall = { type: "toolCall", id: "call_yield_done", name: "yield", arguments: {} };
		const yieldAssistant: AssistantMessage = {
			role: "assistant",
			content: [yieldCall],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const origContinue = agent.continue.bind(agent);
		let recovered = false;
		(agent as unknown as { continue: () => Promise<void> }).continue = async () => {
			if (!recovered) {
				recovered = true;
				(agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = false;
				agent.emitExternalEvent({ type: "message_end", message: yieldAssistant });
				agent.emitExternalEvent({
					type: "tool_execution_end",
					toolCallId: yieldCall.id,
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { done: true } },
					},
					isError: false,
				});
				agent.emitExternalEvent({ type: "agent_end", messages: [yieldAssistant] });
				return;
			}
			return origContinue();
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("first message");
		await session.waitForIdle();

		expect(recovered).toBe(true);
		expect(session.isStreaming).toBe(false);
		expect(session.isRetrying).toBe(false);
		// Retry success is surfaced exactly once (resolved at message_end, idempotent at agent_end).
		expect(retryEndEvents.filter(event => event.success === true)).toHaveLength(1);

		await session.prompt("second message");
		expect(session.isStreaming).toBe(false);
	});
});
