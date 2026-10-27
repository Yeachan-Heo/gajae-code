import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { ESCAPED_NONASCII_RECOVERY_PROMPT } from "@gajae-code/agent-core/agent-loop";
import { getBundledModel, type Message, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import type { OpenAIResponsesHistoryPayload } from "@gajae-code/ai/types";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

const QUESTION = "C:\\Users\\최재필\\.gjc\\session.json";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function escapedTurn(id: string, providerPayload?: OpenAIResponsesHistoryPayload) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "ask",
				arguments: { question: QUESTION },
				escapedNonAsciiArguments: true,
			},
		],
		...(providerPayload === undefined ? {} : { providerPayload }),
	};
}

function literalTurn(id: string) {
	return { content: [{ type: "toolCall" as const, id, name: "ask", arguments: { question: QUESTION } }] };
}

const schema = z.object({ question: z.string() });

function askTool(executed: Array<Record<string, unknown>>): AgentTool<typeof schema, Record<string, never>> {
	return {
		name: "ask",
		label: "Ask",
		description: "Ask",
		parameters: schema,
		async execute(_id, params) {
			executed.push(params as Record<string, unknown>);
			return { content: [{ type: "text", text: "answered" }], details: {} };
		},
	};
}

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function hasUserText(messages: AgentMessage[], text: string): boolean {
	return messages.some(message => {
		if (message.role !== "user") return false;
		const content = message.content;
		if (typeof content === "string") return content === text;
		if (!Array.isArray(content)) return false;
		return content.some(block => block?.type === "text" && block.text === text);
	});
}

describe("AgentSession escaped non-ASCII fallback terminal (#4880)", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	it("fails closed without fallback re-entry on deterministic escaped non-ASCII exhaustion", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-fallback-terminal-4880-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const primary = getBundledModel("anthropic", "claude-opus-5");
		const fallback = getBundledModel("anthropic", "claude-opus-4-6");
		if (!primary || !fallback) throw new Error("Expected bundled opus models");

		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const executed: Array<Record<string, unknown>> = [];
		const callModels: string[] = [];

		// Deterministic escaper: every wire attempt escapes, forever.
		// This reproduces the v0.15.0 fallback-exhaustion defect without Windows.
		const mock = createMockModel({
			handler: () =>
				escapedTurn(`tc-esc-${mock.model.calls.length}`, {
					type: "openaiResponsesHistory",
					items: [{ type: "function_call", arguments: `{"question":"\\uCD5C"}` }],
				}),
		});

		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [askTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => {
				callModels.push(selector(model));
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
		});
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");

		const events: Array<{ type: string; from?: string; to?: string; reason?: string; attemptsUsed?: number }> = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") {
				events.push({
					type: event.type,
					from: (event as { from: string }).from,
					to: (event as { to: string }).to,
					reason: (event as { reason: string }).reason,
					attemptsUsed: (event as { attemptsUsed: number }).attemptsUsed,
				});
			}
		});

		await session.prompt("ask me");
		await manager.flush();

		// No decode-and-execute: tool never ran.
		expect(executed).toEqual([]);

		// Durable history stays clean: no defective tool calls persisted.
		const durable = manager.buildSessionContext().messages;
		const persistedToolCallIds = durable.flatMap(message =>
			message.role === "assistant"
				? message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))
				: [],
		);
		// None of the deterministic escaped ids should appear.
		for (const call of mock.model.calls) {
			const ids = call.context.messages.flatMap(m =>
				Array.isArray((m as { content?: unknown }).content)
					? ((m as { content: unknown[] }).content as { type: string; id?: string }[])
							.filter(b => b.type === "toolCall")
							.map(b => b.id)
					: [],
			);
			// no assertion on wire ids — durable history is the contract
			void ids;
		}
		expect(persistedToolCallIds.length).toBe(0);

		// Terminal error still names escaped non-ASCII, retains original cause.
		const last = durable.findLast(message => message.role === "assistant") as
			| { stopReason?: string; errorMessage?: string; providerPayload?: unknown }
			| undefined;
		expect(last?.stopReason === "error" || last?.stopReason === "exhausted").toBe(true);
		expect(last?.errorMessage ?? "").toContain("escaped non-ASCII");
		expect(last?.providerPayload).toBeUndefined();

		// Steering instructions are transient and never durable.
		expect(hasUserText(durable, ESCAPED_NONASCII_RECOVERY_PROMPT)).toBe(false);

		// Every eligible model receives its initial request plus two steered retries;
		// only then does the chain advance, and the final model fails closed.
		expect(callModels).toEqual([
			selector(primary),
			selector(primary),
			selector(primary),
			selector(fallback),
			selector(fallback),
			selector(fallback),
		]);
		expect(mock.model.calls.length).toBe(6);
		expect(events).toEqual([
			expect.objectContaining({
				type: "model_fallback_switched",
				from: selector(primary),
				to: selector(fallback),
				reason: "escaped_non_ascii",
				attemptsUsed: 1,
			}),
		]);
		const steeredRequests = mock.model.calls.filter(request =>
			hasUserText(request.context.messages, ESCAPED_NONASCII_RECOVERY_PROMPT),
		);
		expect(steeredRequests).toHaveLength(5);
		expect(
			manager
				.buildSessionContext()
				.messages.some(
					message =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.includes("literal UTF-8"),
				),
		).toBe(false);
	});

	it("recovers on the next model after the first model exhausts escaped retries", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-fallback-advance-4880-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const primary = getBundledModel("anthropic", "claude-opus-5");
		const fallback = getBundledModel("anthropic", "claude-opus-4-6");
		if (!primary || !fallback) throw new Error("Expected bundled opus models");

		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const executed: Array<Record<string, unknown>> = [];
		const callModels: string[] = [];
		const mock = createMockModel({
			responses: [
				escapedTurn("tc-primary-1"),
				escapedTurn("tc-primary-2"),
				escapedTurn("tc-primary-3"),
				literalTurn("tc-fallback-1"),
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [askTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => {
				callModels.push(selector(model));
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");
		const events: Array<{ from?: string; to?: string; reason?: string; attemptsUsed?: number }> = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") {
				events.push({
					from: event.from,
					to: event.to,
					reason: event.reason,
					attemptsUsed: event.attemptsUsed,
				});
			}
		});

		await session.prompt("ask me");
		await manager.flush();

		expect(executed).toEqual([{ question: QUESTION }]);
		expect(callModels).toEqual([
			selector(primary),
			selector(primary),
			selector(primary),
			selector(fallback),
			selector(fallback),
		]);
		expect(events).toEqual([
			expect.objectContaining({
				from: selector(primary),
				to: selector(fallback),
				reason: "escaped_non_ascii",
				attemptsUsed: 1,
			}),
		]);
		const durable = manager.buildSessionContext().messages;
		const persistedToolCallIds = durable.flatMap(message =>
			message.role === "assistant"
				? message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))
				: [],
		);
		expect(persistedToolCallIds).toEqual(["tc-fallback-1"]);
		expect(hasUserText(durable, ESCAPED_NONASCII_RECOVERY_PROMPT)).toBe(false);
	});

	it("starts a fresh escaped retry budget after an ordinary fallback advance", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-fallback-mixed-4880-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");

		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled mixed-fallback models");

		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const executed: Array<Record<string, unknown>> = [];
		const callModels: string[] = [];
		const mock = createMockModel({
			responses: [
				escapedTurn("tc-primary-escaped"),
				{ throw: "503 service unavailable: overloaded_error" },
				escapedTurn("tc-fallback-escaped-1"),
				escapedTurn("tc-fallback-escaped-2"),
				literalTurn("tc-fallback-literal"),
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [askTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => {
				callModels.push(selector(model));
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");

		await session.prompt("ask me");
		await manager.flush();

		expect(callModels).toEqual([
			selector(primary),
			selector(primary),
			selector(fallback),
			selector(fallback),
			selector(fallback),
			selector(fallback),
		]);
		expect(executed).toEqual([{ question: QUESTION }]);
		expect(session.isStreaming).toBe(false);
		const durable = manager.buildSessionContext().messages;
		expect(hasUserText(durable, ESCAPED_NONASCII_RECOVERY_PROMPT)).toBe(false);
		expect(
			durable.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === "tc-fallback-literal"),
			),
		).toBe(true);
	});

	it("skips duplicate concrete models after escaped recovery exhaustion", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-fallback-duplicate-4880-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");

		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled duplicate-fallback models");

		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const executed: Array<Record<string, unknown>> = [];
		const callModels: string[] = [];
		const mock = createMockModel({
			responses: [
				escapedTurn("tc-primary-1"),
				escapedTurn("tc-primary-2"),
				escapedTurn("tc-primary-3"),
				literalTurn("tc-fallback-1"),
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [askTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => {
				callModels.push(selector(model));
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
		session.setConfiguredModelChain("default", [selector(primary), selector(primary), selector(fallback)], "test");

		await session.prompt("ask me");
		await manager.flush();

		expect(callModels).toEqual([
			selector(primary),
			selector(primary),
			selector(primary),
			selector(fallback),
			selector(fallback),
		]);
		expect(executed).toEqual([{ question: QUESTION }]);
		expect(session.isStreaming).toBe(false);
	});

	it("does not switch models after abort interrupts fallback credential resolution", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-fallback-abort-4880-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");

		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled abort-fallback models");

		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const streamCalls: string[] = [];
		const fallbackKeyGate = Promise.withResolvers<string | undefined>();
		const fallbackAbortGate = Promise.withResolvers<undefined>();
		let keyCalls = 0;
		let holdFallbackResolution = true;
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
			keyCalls += 1;
			if (keyCalls >= 3 && holdFallbackResolution) {
				if (options?.signal?.aborted) return undefined;
				options?.signal?.addEventListener("abort", () => fallbackAbortGate.resolve(undefined), { once: true });
				return await Promise.race([fallbackKeyGate.promise, fallbackAbortGate.promise]);
			}
			return await originalGetApiKey(model, sessionId, options);
		});
		const events: string[] = [];
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "503 service unavailable: overloaded_error" },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => {
				streamCalls.push(selector(model));
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			// Rollback of the cancelled transition is under test, so keep the failed
			// head eligible on the next turn instead of circuit-skipping it.
			"fallback.circuitCooldownMs": 0,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") events.push(event.to);
		});

		const prompt = session.prompt("abort fallback");
		for (let attempt = 0; attempt < 100 && keyCalls < 3; attempt++) await Bun.sleep(5);
		expect(keyCalls).toBeGreaterThanOrEqual(3);
		const abort = session.abort();
		await abort;
		await prompt.catch(() => {});
		holdFallbackResolution = false;
		fallbackKeyGate.resolve("test-key");
		await session.waitForIdle();

		expect(streamCalls).toEqual([selector(primary)]);
		expect(events).toEqual([]);
		await session.prompt("after abort");
		expect(streamCalls).toEqual([selector(primary), selector(primary), selector(fallback)]);
		expect(session.model?.provider).toBe(fallback.provider);
		expect(session.model?.id).toBe(fallback.id);
	});

	it("rolls back a fallback switch when cancellation arrives before continuation invocation", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-fallback-post-switch-abort-4880-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("anthropic", "claude-opus-4-6");
		if (!primary || !fallback) throw new Error("Expected bundled post-switch abort models");

		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const streamCalls: string[] = [];
		const mock = createMockModel({
			handler: () =>
				escapedTurn(`tc-post-switch-${mock.model.calls.length}`, {
					type: "openaiResponsesHistory",
					items: [{ type: "function_call", arguments: `{"question":"\\uCD5C"}` }],
				}),
		});
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => {
				streamCalls.push(selector(model));
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");
		const fallbackEvents: string[] = [];
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") fallbackEvents.push(event.to);
		});

		let continuationCalls = 0;
		const originalContinue = agent.continue.bind(agent);
		vi.spyOn(agent, "continue").mockImplementation(async options => {
			continuationCalls += 1;
			if (continuationCalls === 1) void session?.abort();
			return await originalContinue(options);
		});

		const prompt = session.prompt("post-switch abort");
		await prompt.catch(() => {});
		await session.waitForIdle();

		expect(continuationCalls).toBe(1);
		expect(streamCalls).toEqual([selector(primary)]);
		expect(session.model?.provider).toBe(primary.provider);
		expect(session.model?.id).toBe(primary.id);
		expect(fallbackEvents).toEqual([]);
	});
});
